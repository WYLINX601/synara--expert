import { Schema } from "effect";

import { IsoDateTime, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";
import { ExpertMcpBindingSchema, McpConfigSourceReferenceSchema, McpConnectionId } from "./mcp";
import { ProviderSkillReference } from "./providerDiscovery";
import { ProviderInstanceId } from "./providerInstance";

export const EXPERT_PROVIDER_KINDS = ["codex", "pi", "claudeAgent", "omp"] as const;
export const ExpertProviderKind = Schema.Literals(EXPERT_PROVIDER_KINDS);
export type ExpertProviderKind = typeof ExpertProviderKind.Type;

const ExpertConnection = Schema.Struct({
  id: TrimmedNonEmptyString,
  required: Schema.Boolean,
  tools: Schema.Array(TrimmedNonEmptyString),
  /** Missing means the legacy explicit whitelist in `tools`. */
  toolMode: Schema.optional(Schema.Literals(["all", "selected"])),
  enabled: Schema.optional(Schema.Boolean),
});
export type ExpertConnection = typeof ExpertConnection.Type;

const EnvironmentVariableName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/u),
).check(Schema.isMaxLength(128));
const ExpertMcpCredentialId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
);
const EnvironmentSecretReference = Schema.Struct({
  credentialId: ExpertMcpCredentialId,
  names: Schema.Array(EnvironmentVariableName).check(Schema.isMaxLength(128)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const HttpHeaderName = Schema.String.check(
  Schema.isPattern(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u),
).check(Schema.isMaxLength(256));
const HeaderSecretReference = Schema.Struct({
  credentialId: ExpertMcpCredentialId,
  names: Schema.Array(HttpHeaderName).check(Schema.isMaxLength(128)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const ExpertConnectionId = McpConnectionId;
const ExpertConnectionStdioTransport = Schema.Struct({
  type: Schema.Literal("stdio"),
  command: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)).check(
    Schema.isPattern(/^[^\0]+$/u),
  ),
  args: Schema.Array(
    Schema.String.check(Schema.isMaxLength(8_192)).check(Schema.isPattern(/^[^\0]*$/u)),
  ).check(Schema.isMaxLength(256)),
  envFromHost: Schema.Array(
    Schema.Struct({
      name: EnvironmentVariableName,
      envVar: EnvironmentVariableName,
    }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  ).check(Schema.isMaxLength(128)),
  cwd: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)).check(Schema.isPattern(/^[^\0]+$/u)),
  ),
  startupTimeoutMs: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(300_000))),
  toolTimeoutMs: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(300_000))),
  envFromSource: Schema.optional(
    Schema.Struct({
      source: McpConfigSourceReferenceSchema,
      names: Schema.Array(EnvironmentVariableName).check(Schema.isMaxLength(128)),
    }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  ),
  envFromSecret: Schema.optional(EnvironmentSecretReference),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const ExpertConnectionHttpTransport = Schema.Struct({
  type: Schema.Literal("http"),
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
  headersFromHost: Schema.Array(
    Schema.Struct({
      name: HttpHeaderName,
      envVar: EnvironmentVariableName,
      prefix: Schema.optional(
        Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9._~-]* ?$/u)).check(
          Schema.isMaxLength(64),
        ),
      ),
    }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  ).check(Schema.isMaxLength(128)),
  headersFromSource: Schema.optional(
    Schema.Struct({
      source: McpConfigSourceReferenceSchema,
      names: Schema.Array(HttpHeaderName).check(Schema.isMaxLength(128)),
    }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  ),
  headersFromSecret: Schema.optional(HeaderSecretReference),
}).annotate({ parseOptions: { onExcessProperty: "error" } });

export const ExpertConnectionTransport = Schema.Union([
  ExpertConnectionStdioTransport,
  ExpertConnectionHttpTransport,
]);
export type ExpertConnectionTransport = typeof ExpertConnectionTransport.Type;

export const ExpertConnectionConfig = Schema.Struct({
  id: ExpertConnectionId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  transport: ExpertConnectionTransport,
  importedFrom: Schema.optional(
    Schema.Array(McpConfigSourceReferenceSchema).check(Schema.isMaxLength(1_000)),
  ),
  revision: PositiveInt,
  updatedAt: IsoDateTime,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExpertConnectionConfig = typeof ExpertConnectionConfig.Type;

export const ExpertConnectionSaveInput = Schema.Struct({
  id: ExpertConnectionId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  transport: ExpertConnectionTransport,
  importedFrom: Schema.optional(
    Schema.Array(McpConfigSourceReferenceSchema).check(Schema.isMaxLength(1_000)),
  ),
  expectedRevision: Schema.optional(PositiveInt),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExpertConnectionSaveInput = typeof ExpertConnectionSaveInput.Type;

export const ExpertConnectionRemoveInput = Schema.Struct({
  id: ExpertConnectionId,
  expectedRevision: PositiveInt,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExpertConnectionRemoveInput = typeof ExpertConnectionRemoveInput.Type;

export const ExpertConnectionTestInput = Schema.Struct({
  id: ExpertConnectionId,
  expectedRevision: Schema.optional(PositiveInt),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExpertConnectionTestInput = typeof ExpertConnectionTestInput.Type;

export const ExpertConnectionTestResult = Schema.Struct({
  tools: Schema.Array(Schema.String),
  revision: PositiveInt,
});
export type ExpertConnectionTestResult = typeof ExpertConnectionTestResult.Type;

export const ExpertDefinition = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: Schema.String,
  useCases: Schema.String,
  persona: Schema.String,
  outputRequirements: Schema.String,
  skills: Schema.Array(ProviderSkillReference),
  references: Schema.Array(TrimmedNonEmptyString),
  connections: Schema.Array(ExpertConnection),
  preferredProvider: Schema.optional(ExpertProviderKind),
  revision: PositiveInt,
  archived: Schema.Boolean,
  updatedAt: IsoDateTime,
});
export type ExpertDefinition = typeof ExpertDefinition.Type;

export const ExpertSaveInput = Schema.Struct({
  id: Schema.optional(TrimmedNonEmptyString),
  expectedRevision: Schema.optional(PositiveInt),
  name: TrimmedNonEmptyString,
  description: Schema.String,
  useCases: Schema.String,
  persona: Schema.String,
  outputRequirements: Schema.String,
  skills: Schema.Array(ProviderSkillReference),
  references: Schema.Array(TrimmedNonEmptyString),
  connections: Schema.Array(ExpertConnection),
  preferredProvider: Schema.optional(ExpertProviderKind),
});
export type ExpertSaveInput = typeof ExpertSaveInput.Type;

export const ExpertReadInput = Schema.Struct({ id: TrimmedNonEmptyString });
export type ExpertReadInput = typeof ExpertReadInput.Type;

export const ExpertArchiveInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  expectedRevision: Schema.optional(PositiveInt),
});
export type ExpertArchiveInput = typeof ExpertArchiveInput.Type;

export const ExpertRestoreInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  expectedRevision: PositiveInt,
});
export type ExpertRestoreInput = typeof ExpertRestoreInput.Type;

export const ExpertDeleteInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  expectedRevision: PositiveInt,
});
export type ExpertDeleteInput = typeof ExpertDeleteInput.Type;

export const ExpertPreviewInput = Schema.Struct({
  expertId: TrimmedNonEmptyString,
  provider: ExpertProviderKind,
  providerInstanceId: Schema.optional(ProviderInstanceId),
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type ExpertPreviewInput = typeof ExpertPreviewInput.Type;

export const ExpertPreview = Schema.Struct({
  definition: ExpertDefinition,
  status: Schema.Literals(["available", "partial", "blocked", "incompatible"]),
  issues: Schema.Array(Schema.String),
});
export type ExpertPreview = typeof ExpertPreview.Type;

export const ExpertSnapshot = Schema.Struct({
  snapshotId: TrimmedNonEmptyString,
  expertId: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  revision: PositiveInt,
  description: Schema.String,
  useCases: Schema.String,
  persona: Schema.String,
  outputRequirements: Schema.String,
  skills: Schema.Array(ProviderSkillReference),
  skillsRoot: TrimmedNonEmptyString,
  references: Schema.Array(TrimmedNonEmptyString),
  connections: Schema.Array(ExpertConnection),
  mcpBinding: Schema.optional(ExpertMcpBindingSchema),
  preferredProvider: Schema.optional(ExpertProviderKind),
  createdAt: IsoDateTime,
});
export type ExpertSnapshot = typeof ExpertSnapshot.Type;

export const ExpertSnapshotReadInput = Schema.Struct({ snapshotId: TrimmedNonEmptyString });
export type ExpertSnapshotReadInput = typeof ExpertSnapshotReadInput.Type;

export const ExpertBinding = Schema.Struct({
  expertId: TrimmedNonEmptyString,
  snapshotId: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  revision: PositiveInt,
});
export type ExpertBinding = typeof ExpertBinding.Type;

/** Latest provider runtime that successfully applied an immutable Expert snapshot. */
export const ExpertAppliedRuntimeRecord = Schema.Struct({
  threadId: ThreadId,
  snapshotId: TrimmedNonEmptyString,
  provider: ExpertProviderKind,
  model: Schema.optional(TrimmedNonEmptyString),
  runtimeComponent: Schema.optional(TrimmedNonEmptyString),
  runtimeVersion: Schema.optional(TrimmedNonEmptyString),
  lifecycleGeneration: TrimmedNonEmptyString,
  appliedAt: IsoDateTime,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExpertAppliedRuntimeRecord = typeof ExpertAppliedRuntimeRecord.Type;

export const ExpertAppliedRuntimeReadInput = Schema.Struct({ threadId: ThreadId }).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type ExpertAppliedRuntimeReadInput = typeof ExpertAppliedRuntimeReadInput.Type;
