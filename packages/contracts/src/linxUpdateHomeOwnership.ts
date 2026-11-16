import { Schema } from "effect";
import { LinxUpdateAbsolutePath, LinxUpdateAttemptId } from "./linxUpdateInstall";
import { compareLinxUpdateVersions, LinxUpdateSha256 } from "./linxUpdateManifest";

export const LINX_HOME_OWNERSHIP_MAX_BYTES = 64 * 1024;
export const LINX_HOME_OWNERSHIP_NONCE_ENV = "LINX_HOME_OWNERSHIP_NONCE";
export const LinxHomeOwnershipNonce = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));

const INSTALLED_APP_VERSION =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
function parseInstalledVersion(value: string): { core: string; prerelease: string[] } | null {
  if (value.length > 256) return null;
  const match = INSTALLED_APP_VERSION.exec(value);
  if (!match) return null;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => /^[0-9]+$/u.test(part) && part.length > 1 && part.startsWith("0")))
    return null;
  return { core: `${match[1]}.${match[2]}.${match[3]}`, prerelease };
}
/** Installed app identities also cover Preview; the signed update channel stays stable-only. */
export const LinxInstalledAppVersion = Schema.String.check(
  Schema.makeFilter((value: string) => parseInstalledVersion(value) !== null),
);
export function compareLinxInstalledAppVersions(left: string, right: string): number | null {
  const a = parseInstalledVersion(left),
    b = parseInstalledVersion(right);
  if (!a || !b) return null;
  const core = compareLinxUpdateVersions(a.core, b.core)!;
  if (core !== 0) return core;
  if (!a.prerelease.length || !b.prerelease.length)
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const x = a.prerelease[index],
      y = b.prerelease[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const numericX = /^[0-9]+$/u.test(x),
      numericY = /^[0-9]+$/u.test(y);
    if (numericX && numericY && x.length !== y.length) return x.length < y.length ? -1 : 1;
    if (numericX !== numericY) return numericX ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
const Pid = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(2_147_483_647),
);
const Generation = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
export const LinxHomeOwnershipProcess = Schema.Struct({
  pid: Pid,
  startedAt: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
    Schema.makeFilter((value: string) => !/[\r\n]/u.test(value)),
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type LinxHomeOwnershipProcess = typeof LinxHomeOwnershipProcess.Type;
export const LinxHomeOwnershipMember = Schema.Struct({
  id: LinxUpdateAttemptId,
  role: Schema.Literals(["server", "cohort"]),
  process: LinxHomeOwnershipProcess,
  joinedGeneration: Generation,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type LinxHomeOwnershipMember = typeof LinxHomeOwnershipMember.Type;
export const LinxHomeOwnershipRecord = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  guardId: LinxUpdateAttemptId,
  uid: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  homePath: LinxUpdateAbsolutePath,
  userDataPath: LinxUpdateAbsolutePath,
  applicationPath: LinxUpdateAbsolutePath,
  version: LinxInstalledAppVersion,
  generation: Generation,
  updatedAt: Schema.String.check(
    Schema.makeFilter((value: string) => Number.isFinite(Date.parse(value))),
  ),
  owner: Schema.NullOr(LinxHomeOwnershipProcess),
  nonceDigest: Schema.NullOr(LinxUpdateSha256),
  adopted: Schema.Boolean,
  members: Schema.Array(LinxHomeOwnershipMember).check(Schema.isMaxLength(128)),
})
  .check(
    Schema.makeFilter(
      (record) =>
        (record.owner === null) === (record.nonceDigest === null) &&
        (record.owner !== null || record.adopted === false) &&
        new Set(record.members.map((member) => member.id)).size === record.members.length &&
        record.members.every((member) => member.joinedGeneration <= record.generation),
    ),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });
export type LinxHomeOwnershipRecord = typeof LinxHomeOwnershipRecord.Type;
