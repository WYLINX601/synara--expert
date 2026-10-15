import { Schema } from "effect";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";

/** MCP connection IDs share the durable expert-connection filename contract. */
export const McpConnectionId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/u),
);

const McpSourcePath = TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)).check(
  Schema.isPattern(/^[^\0]+$/u),
);

const McpDiscoveryCodexSourceSchema = Schema.Struct({
  kind: Schema.Literal("codex"),
  path: Schema.optional(McpSourcePath),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const McpDiscoveryCcSwitchSourceSchema = Schema.Struct({
  kind: Schema.Literal("cc-switch"),
  path: Schema.optional(McpSourcePath),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const McpDiscoveryJsonSourceSchema = Schema.Struct({
  kind: Schema.Literal("json"),
  path: McpSourcePath,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export const McpDiscoverySourceSchema = Schema.Union([
  McpDiscoveryCodexSourceSchema,
  McpDiscoveryCcSwitchSourceSchema,
  McpDiscoveryJsonSourceSchema,
]);
export type McpDiscoverySource = typeof McpDiscoverySourceSchema.Type;

export const McpDiscoveryRequestSchema = Schema.Struct({
  sources: Schema.optional(Schema.Array(McpDiscoverySourceSchema).check(Schema.isMaxLength(16))),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type McpDiscoveryRequest = typeof McpDiscoveryRequestSchema.Type;

/** A reference to a source entry, never the values stored in that entry. */
export const McpConfigSourceReferenceSchema = Schema.Struct({
  kind: Schema.Literals(["codex", "cc-switch", "json"]),
  path: McpSourcePath,
  entryId: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type McpConfigSourceReference = typeof McpConfigSourceReferenceSchema.Type;

const McpDiscoveryCandidateSchema = Schema.Struct({
  candidateId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  sourceKind: Schema.Literals(["codex", "cc-switch", "json"]),
  sourcePath: McpSourcePath,
  sourceEntryId: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
  sources: Schema.optional(
    Schema.Array(McpConfigSourceReferenceSchema).check(Schema.isMaxLength(1_000)),
  ),
  suggestedId: McpConnectionId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  protocol: Schema.Literals(["stdio", "http", "unknown"]),
  summary: Schema.String.check(Schema.isMaxLength(2_000)),
  sourceEnabled: Schema.optional(Schema.Boolean),
  status: Schema.Literals(["ready", "exists", "conflict", "needs-config", "unsupported"]),
  issues: Schema.Array(Schema.String.check(Schema.isMaxLength(2_000))),
  existingId: Schema.optional(McpConnectionId),
  existingRevision: Schema.optional(PositiveInt),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type McpDiscoveryCandidate = typeof McpDiscoveryCandidateSchema.Type;

const McpDiscoverySourceStatusSchema = Schema.Struct({
  kind: Schema.Literals(["codex", "cc-switch", "json"]),
  path: McpSourcePath,
  status: Schema.Literals(["ready", "missing", "error"]),
  message: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
}).annotate({ parseOptions: { onExcessProperty: "error" } });

export const McpDiscoveryResultSchema = Schema.Struct({
  scanId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  sources: Schema.Array(McpDiscoverySourceStatusSchema),
  candidates: Schema.Array(McpDiscoveryCandidateSchema),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type McpDiscoveryResult = typeof McpDiscoveryResultSchema.Type;

const McpImportItemSchema = Schema.Struct({
  candidateId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  targetId: McpConnectionId,
  mode: Schema.Literals(["create", "update"]),
  expectedRevision: Schema.optional(PositiveInt),
}).annotate({ parseOptions: { onExcessProperty: "error" } });

export const McpImportRequestSchema = Schema.Struct({
  scanId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  items: Schema.Array(McpImportItemSchema).check(Schema.isMaxLength(1_000)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type McpImportRequest = typeof McpImportRequestSchema.Type;

const McpImportItemResultSchema = Schema.Struct({
  candidateId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  targetId: McpConnectionId,
  status: Schema.Literals(["imported", "skipped", "failed"]),
  revision: Schema.optional(PositiveInt),
  message: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
}).annotate({ parseOptions: { onExcessProperty: "error" } });

export const McpImportResultSchema = Schema.Struct({
  scanId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  items: Schema.Array(McpImportItemResultSchema),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type McpImportResult = typeof McpImportResultSchema.Type;

export const McpConnectionStateSchema = Schema.Struct({
  id: McpConnectionId,
  status: Schema.Literals(["active", "disabled", "retired"]),
  revision: PositiveInt,
  updatedAt: IsoDateTime,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type McpConnectionState = typeof McpConnectionStateSchema.Type;

export const McpConnectionSetStateInputSchema = Schema.Struct({
  id: McpConnectionId,
  status: Schema.Literals(["active", "disabled", "retired"]),
  expectedRevision: PositiveInt,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type McpConnectionSetStateInput = typeof McpConnectionSetStateInputSchema.Type;

const ExpertMcpBindingServerSchema = Schema.Struct({
  id: McpConnectionId,
  configRevision: Schema.optional(PositiveInt),
  required: Schema.Boolean,
  tools: Schema.Array(TrimmedNonEmptyString),
}).annotate({ parseOptions: { onExcessProperty: "error" } });

export const ExpertMcpBindingSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  source: Schema.Literals(["snapshot", "legacy-current"]),
  createdAt: IsoDateTime,
  servers: Schema.Array(ExpertMcpBindingServerSchema),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExpertMcpBinding = typeof ExpertMcpBindingSchema.Type;

export const ExpertConnectionReferencesInputSchema = Schema.Struct({
  id: McpConnectionId,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExpertConnectionReferencesInput = typeof ExpertConnectionReferencesInputSchema.Type;

const ExpertConnectionReferenceSchema = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  revision: PositiveInt,
  enabled: Schema.Boolean,
  required: Schema.Boolean,
  tools: Schema.Array(TrimmedNonEmptyString),
}).annotate({ parseOptions: { onExcessProperty: "error" } });

const ExpertSnapshotConnectionReferenceSchema = Schema.Struct({
  snapshotId: TrimmedNonEmptyString,
  expertId: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  configRevision: Schema.optional(PositiveInt),
  required: Schema.Boolean,
  legacy: Schema.Boolean,
}).annotate({ parseOptions: { onExcessProperty: "error" } });

const ExpertConnectionTaskReferenceSchema = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  snapshotId: TrimmedNonEmptyString,
  configRevision: Schema.optional(PositiveInt),
  required: Schema.Boolean,
}).annotate({ parseOptions: { onExcessProperty: "error" } });

export const ExpertConnectionReferencesResultSchema = Schema.Struct({
  experts: Schema.Array(ExpertConnectionReferenceSchema),
  snapshots: Schema.Array(ExpertSnapshotConnectionReferenceSchema),
  tasks: Schema.Array(ExpertConnectionTaskReferenceSchema),
  activeSessionCount: NonNegativeInt,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExpertConnectionReferencesResult = typeof ExpertConnectionReferencesResultSchema.Type;
