import { Schema } from "effect";

import { IsoDateTime, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";
import { ProviderSkillReference } from "./providerDiscovery";

const ExpertConnection = Schema.Struct({
  id: TrimmedNonEmptyString,
  required: Schema.Boolean,
  tools: Schema.Array(TrimmedNonEmptyString),
});
export type ExpertConnection = typeof ExpertConnection.Type;

const EnvironmentVariableName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/u),
).check(Schema.isMaxLength(128));
const ExpertConnectionId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/u),
);
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
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const ExpertConnectionHttpTransport = Schema.Struct({
  type: Schema.Literal("http"),
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
  headersFromHost: Schema.Array(
    Schema.Struct({
      name: Schema.String.check(Schema.isPattern(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u)).check(
        Schema.isMaxLength(256),
      ),
      envVar: EnvironmentVariableName,
      prefix: Schema.optional(
        Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9._~-]* ?$/u)).check(
          Schema.isMaxLength(64),
        ),
      ),
    }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  ).check(Schema.isMaxLength(128)),
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
  revision: PositiveInt,
  updatedAt: IsoDateTime,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExpertConnectionConfig = typeof ExpertConnectionConfig.Type;

export const ExpertConnectionSaveInput = Schema.Struct({
  id: ExpertConnectionId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  transport: ExpertConnectionTransport,
  expectedRevision: Schema.optional(PositiveInt),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExpertConnectionSaveInput = typeof ExpertConnectionSaveInput.Type;

export const ExpertConnectionRemoveInput = Schema.Struct({
  id: ExpertConnectionId,
  expectedRevision: PositiveInt,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExpertConnectionRemoveInput = typeof ExpertConnectionRemoveInput.Type;

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
  preferredProvider: Schema.optional(Schema.Literals(["codex", "pi"])),
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
  preferredProvider: Schema.optional(Schema.Literals(["codex", "pi"])),
});
export type ExpertSaveInput = typeof ExpertSaveInput.Type;

export const ExpertReadInput = Schema.Struct({ id: TrimmedNonEmptyString });
export type ExpertReadInput = typeof ExpertReadInput.Type;

export const ExpertArchiveInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  expectedRevision: Schema.optional(PositiveInt),
});
export type ExpertArchiveInput = typeof ExpertArchiveInput.Type;

export const ExpertPreviewInput = Schema.Struct({
  expertId: TrimmedNonEmptyString,
  provider: Schema.Literals(["codex", "pi"]),
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
  preferredProvider: Schema.optional(Schema.Literals(["codex", "pi"])),
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
  provider: Schema.Literals(["codex", "pi"]),
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
