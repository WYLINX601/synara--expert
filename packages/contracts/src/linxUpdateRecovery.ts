import { Schema } from "effect";

import { LinxUpdateAbsolutePath, LinxUpdateAttemptId } from "./linxUpdateInstall";
import { LinxUpdateSha256 } from "./linxUpdateManifest";
import { LinxInstalledAppVersion } from "./linxUpdateHomeOwnership";

export const LINX_UPDATE_RECOVERY_MANIFEST_FILE_NAME = "linx-recovery.json";
export const LINX_UPDATE_RECOVERY_MAX_ENTRIES = 200_000;
export const LINX_UPDATE_RECOVERY_MANIFEST_MAX_BYTES = 64 * 1024 * 1024;
const RelativePath = Schema.String.check(
  Schema.isMaxLength(4_096),
  Schema.makeFilter(
    (value: string) =>
      value === "" ||
      (!value.startsWith("/") &&
        !value.includes("\\") &&
        !value.includes("\0") &&
        !value.split("/").some((part) => part === "" || part === "." || part === "..")),
  ),
);
const Entry = Schema.Struct({
  root: Schema.Literals(["home", "userData", "managedReferences"]),
  path: RelativePath,
  kind: Schema.Literals(["directory", "file", "symlink"]),
  mode: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(0o777),
  ),
  size: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  sha256: Schema.NullOr(LinxUpdateSha256),
  linkTarget: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4_096))),
})
  .check(
    Schema.makeFilter((entry) =>
      entry.kind === "file"
        ? entry.sha256 !== null && entry.linkTarget === null && entry.path !== ""
        : entry.kind === "symlink"
          ? entry.sha256 === null &&
            entry.linkTarget !== null &&
            entry.path !== "" &&
            entry.size === 0
          : entry.sha256 === null && entry.linkTarget === null && entry.size === 0,
    ),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });
export type LinxUpdateRecoveryEntry = typeof Entry.Type;
const GitObjectId = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u));
const RegistrationName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(255),
  Schema.makeFilter((value: string) => value !== "." && value !== ".." && !/[\\/\0]/u.test(value)),
);
const ManagedRef = Schema.Struct({
  name: Schema.String.check(
    Schema.isMaxLength(1_024),
    Schema.isPattern(
      /^refs\/[A-Za-z0-9._-]+\/checkpoints\/[A-Za-z0-9_-]+\/(?:turn|message-start|turn-start|turn-live|revert-rescue)\/[A-Za-z0-9_-]+$/u,
    ),
  ),
  oid: GitObjectId,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export const LinxManagedRepositoryRecovery = Schema.Struct({
  id: LinxUpdateSha256,
  commonPath: LinxUpdateAbsolutePath,
  device: Schema.String.check(Schema.isPattern(/^[0-9]+$/u)),
  inode: Schema.String.check(Schema.isPattern(/^[0-9]+$/u)),
  configSha256: LinxUpdateSha256,
  objectFormat: Schema.Literals(["sha1", "sha256"]),
  retainedHeads: Schema.Array(GitObjectId).check(Schema.isMaxLength(65_536)),
  sharedIndexes: Schema.Array(
    Schema.String.check(Schema.isPattern(/^sharedindex\.(?:[a-f0-9]{40}|[a-f0-9]{64})$/u)),
  ).check(Schema.isMaxLength(1_024)),
  worktrees: Schema.Array(
    Schema.Struct({
      path: RelativePath.check(
        Schema.makeFilter((value: string) => value.startsWith("worktrees/")),
      ),
      registrationName: RegistrationName,
      head: GitObjectId,
      refs: Schema.Array(ManagedRef).check(Schema.isMaxLength(16_384)),
    })
      .check(
        Schema.makeFilter(
          (worktree) =>
            new Set(worktree.refs.map((reference) => reference.name)).size === worktree.refs.length,
        ),
      )
      .annotate({ parseOptions: { onExcessProperty: "error" } }),
  ).check(Schema.isMaxLength(1_024)),
})
  .check(
    Schema.makeFilter(
      (repository) =>
        new Set(repository.retainedHeads).size === repository.retainedHeads.length &&
        new Set(repository.sharedIndexes).size === repository.sharedIndexes.length &&
        new Set(repository.worktrees.map((worktree) => worktree.path)).size ===
          repository.worktrees.length &&
        new Set(repository.worktrees.map((worktree) => worktree.registrationName)).size ===
          repository.worktrees.length &&
        repository.retainedHeads.every(
          (oid) => oid.length === (repository.objectFormat === "sha1" ? 40 : 64),
        ) &&
        repository.worktrees.every(
          (worktree) =>
            worktree.head.length === (repository.objectFormat === "sha1" ? 40 : 64) &&
            worktree.refs.every(
              (reference) =>
                reference.oid.length === (repository.objectFormat === "sha1" ? 40 : 64),
            ),
        ),
    ),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });
export type LinxManagedRepositoryRecovery = typeof LinxManagedRepositoryRecovery.Type;
export const LinxUpdateRecoveryManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  attemptId: LinxUpdateAttemptId,
  sourceVersion: LinxInstalledAppVersion,
  createdAt: Schema.String.check(
    Schema.makeFilter((value: string) => Number.isFinite(Date.parse(value))),
  ),
  homePath: LinxUpdateAbsolutePath,
  userDataPath: LinxUpdateAbsolutePath,
  userDataFormat: Schema.Literals(["offline-profile", "portable-app-storage"]),
  managedRepositories: Schema.Array(LinxManagedRepositoryRecovery).check(Schema.isMaxLength(4_096)),
  entries: Schema.Array(Entry).check(Schema.isMaxLength(LINX_UPDATE_RECOVERY_MAX_ENTRIES)),
})
  .check(
    Schema.makeFilter(
      (manifest) =>
        manifest.homePath !== manifest.userDataPath &&
        new Set(manifest.managedRepositories.map((repository) => repository.id)).size ===
          manifest.managedRepositories.length &&
        new Set(manifest.managedRepositories.map((repository) => repository.commonPath)).size ===
          manifest.managedRepositories.length &&
        new Set(manifest.entries.map((entry) => `${entry.root}:${entry.path}`)).size ===
          manifest.entries.length,
    ),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });
export type LinxUpdateRecoveryManifest = typeof LinxUpdateRecoveryManifest.Type;
