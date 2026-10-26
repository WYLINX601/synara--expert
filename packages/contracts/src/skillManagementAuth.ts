import { Schema } from "effect";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas";
import { SkillLibraryRequest } from "./skillLibrary";

export const SkillManagementCapability = Schema.Literals([
  "skill.manage",
  "expert.skillBindings.manage",
]);
export type SkillManagementCapability = typeof SkillManagementCapability.Type;

export const SkillManagementFlavor = Schema.Literals([
  "production",
  "development",
  "canary",
  "cua",
  "beta",
  "workbench",
  "workbench-preview",
]);
export type SkillManagementFlavor = typeof SkillManagementFlavor.Type;

/** The browser may reveal management controls only when the connected socket is local owner. */
export const SkillManagementAccess = Schema.Struct({
  canManage: Schema.Boolean,
  instanceId: Schema.optional(TrimmedNonEmptyString),
  flavor: Schema.optional(SkillManagementFlavor),
  endpoint: Schema.optional(TrimmedNonEmptyString),
  homeDir: Schema.optional(TrimmedNonEmptyString),
});
export type SkillManagementAccess = typeof SkillManagementAccess.Type;

export const SkillManagementPairingResult = Schema.Struct({
  code: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
  instanceId: TrimmedNonEmptyString,
  flavor: SkillManagementFlavor,
  endpoint: TrimmedNonEmptyString,
  homeDir: TrimmedNonEmptyString,
});
export type SkillManagementPairingResult = typeof SkillManagementPairingResult.Type;

export const SkillManagementPairingExchangeInput = Schema.Struct({
  code: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  expectedInstanceId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  expectedFlavor: SkillManagementFlavor,
});
export type SkillManagementPairingExchangeInput = typeof SkillManagementPairingExchangeInput.Type;

export const SkillManagementCredentialResult = Schema.Struct({
  credentialId: TrimmedNonEmptyString,
  credential: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  instanceId: TrimmedNonEmptyString,
  flavor: SkillManagementFlavor,
  capabilities: Schema.Array(SkillManagementCapability),
});
export type SkillManagementCredentialResult = typeof SkillManagementCredentialResult.Type;

export const SkillManagementCredentialSummary = Schema.Struct({
  credentialId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  revokedAt: Schema.NullOr(IsoDateTime),
  capabilities: Schema.Array(SkillManagementCapability),
});
export type SkillManagementCredentialSummary = typeof SkillManagementCredentialSummary.Type;

export const SkillManagementCredentialRevokeInput = Schema.Struct({
  credentialId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type SkillManagementCredentialRevokeInput = typeof SkillManagementCredentialRevokeInput.Type;

export const SkillManagementCommandInput = Schema.Struct({
  request: SkillLibraryRequest,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SkillManagementCommandInput = typeof SkillManagementCommandInput.Type;

export const SkillManagementAuthError = Schema.Struct({
  error: TrimmedNonEmptyString,
  code: Schema.Literals([
    "invalid_pairing",
    "management_unauthorized",
    "management_expired",
    "management_revoked",
    "instance_mismatch",
    "flavor_mismatch",
    "loopback_required",
    "owner_required",
    "invalid_request",
  ]),
});
export type SkillManagementAuthError = typeof SkillManagementAuthError.Type;
