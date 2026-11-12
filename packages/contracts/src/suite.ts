import { Schema } from "effect";

import {
  IsoDateTime,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import { ExpertConnection, ExpertSnapshot } from "./expert";
import { ExpertMcpBindingSchema } from "./mcp";
import { ExpertSkillSelection, ResolvedExpertSkillEntry, SkillResourceMode } from "./skillPackage";

export const SuiteContentHash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export type SuiteContentHash = typeof SuiteContentHash.Type;
export const SuiteRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
export const SuiteName = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
export const SuiteDescription = Schema.String.check(Schema.isMaxLength(16_000));
export const SuitePath = TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)).check(
  Schema.isPattern(/^[^\p{Cc}]+$/u),
);
export const SuiteRelativePath = SuitePath.check(
  Schema.isPattern(
    /^(?![\/])(?![A-Za-z]:)(?!.*\\)(?!(?:.*\/)?\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\/$)[^/]+(?:\/[^/]+)*$/u,
  ),
);
export const SuiteId = Schema.String.check(
  Schema.isPattern(/^suite_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
);
export type SuiteId = typeof SuiteId.Type;
export const SuiteRef = Schema.Struct({ suiteId: SuiteId, revision: PositiveInt }).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type SuiteRef = typeof SuiteRef.Type;

export const SuiteAction = Schema.Literals([
  "preview",
  "commit",
  "hub-save",
  "dispatch",
  "run",
  "tool-call",
]);
export type SuiteAction = typeof SuiteAction.Type;
export const SuiteIssueCode = Schema.Literals([
  "source_unreadable",
  "source_auth_required",
  "source_not_found",
  "unsupported_format",
  "invalid_manifest",
  "unsafe_path",
  "content_changed",
  "preview_expired",
  "revision_conflict",
  "commit_pending",
  "commit_failed",
  "suite_missing",
  "resource_missing",
  "resource_corrupt",
  "dependency_conflict",
  "identity_unavailable",
  "permission_denied",
  "provider_unavailable",
  "tool_unreachable",
  "unsupported_capability",
  "probe_timeout",
  "probe_error",
  "execution_unknown",
  "result_conflict",
]);
export type SuiteIssueCode = typeof SuiteIssueCode.Type;
export const SuiteIssue = Schema.Struct({
  code: SuiteIssueCode,
  category: Schema.Literals(["security", "execution", "dependency", "unknown", "source"]),
  subject: Schema.Struct({
    kind: Schema.Literals(["suite", "expert", "resource", "connection", "execution"]),
    id: SuitePath,
    path: Schema.NullOr(SuitePath),
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  action: SuiteAction,
  effect: Schema.Literals(["deny-action", "limit-capability", "observe"]),
  message: Schema.String.check(Schema.isMaxLength(2_000)),
  evidenceRef: Schema.NullOr(SuitePath),
  checkedAt: IsoDateTime,
  recovery: Schema.Literals([
    "retry",
    "authorize",
    "repair-source",
    "choose-alternative",
    "reconcile",
  ]),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SuiteIssue = typeof SuiteIssue.Type;

export const SuiteFilePurpose = Schema.Literals([
  "instructions",
  "reference",
  "template",
  "workflow",
]);
export type SuiteFilePurpose = typeof SuiteFilePurpose.Type;
export const SuiteResourceRef = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("skill"),
    sourceId: SuitePath,
    selection: ExpertSkillSelection,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    kind: Schema.Literal("managed-skill"),
    sourceId: SuitePath,
    managedSkillId: SuitePath,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    kind: Schema.Literal("files"),
    sourceId: SuitePath,
    resourceId: SuitePath,
    purpose: SuiteFilePurpose,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    kind: Schema.Literal("connection"),
    sourceId: SuitePath,
    connection: ExpertConnection,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
]);
export type SuiteResourceRef = typeof SuiteResourceRef.Type;
export const SuiteResourceUse = Schema.Struct({
  key: SuiteName,
  ref: SuiteResourceRef,
  purpose: SuiteDescription,
  audience: Schema.Union([
    Schema.Literal("shared"),
    Schema.Literal("coordinator"),
    Schema.Struct({ expertKey: SuiteName }).annotate({
      parseOptions: { onExcessProperty: "error" },
    }),
  ]),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SuiteResourceUse = typeof SuiteResourceUse.Type;
export const SuiteSource = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("github"),
    sourceId: SuitePath,
    repository: SuitePath,
    subdirectory: Schema.String.check(Schema.isMaxLength(4_096)),
    requestedRef: SuitePath,
    resolvedCommit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
    contentHash: SuiteContentHash,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    kind: Schema.Literal("local-folder"),
    sourceId: SuitePath,
    contentHash: SuiteContentHash,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
]);
export type SuiteSource = typeof SuiteSource.Type;
export const SuiteDefaults = Schema.Struct({
  language: Schema.optional(SuiteName),
  outputDirectory: Schema.optional(SuitePath),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SuiteDefaults = typeof SuiteDefaults.Type;
export const SuiteComposition = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  ref: SuiteRef,
  name: SuiteName,
  description: SuiteDescription,
  source: SuiteSource,
  adapterId: SuiteName,
  adapterVersion: PositiveInt,
  members: Schema.Array(
    Schema.Struct({
      key: SuiteName,
      expertId: SuitePath,
      roleSourcePath: Schema.NullOr(SuiteRelativePath),
    }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  )
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(5_000)),
  resources: Schema.Array(SuiteResourceUse).check(Schema.isMaxLength(5_000)),
  defaults: SuiteDefaults,
  compositionHash: SuiteContentHash,
  createdAt: IsoDateTime,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SuiteComposition = typeof SuiteComposition.Type;

/** Supported projection; importers retain raw files and diagnose unknown manifest fields. */
export const SuiteManifestV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  name: SuiteName,
  description: SuiteDescription,
  experts: Schema.Array(
    Schema.Union([
      Schema.Struct({
        key: SuiteName,
        kind: Schema.Literal("definition"),
        name: SuiteName,
        personaPath: SuiteRelativePath,
        description: SuiteDescription,
        resourceKeys: Schema.optional(Schema.Array(SuiteName).check(Schema.isMaxLength(5_000))),
      }).annotate({ parseOptions: { onExcessProperty: "error" } }),
      Schema.Struct({
        key: SuiteName,
        kind: Schema.Literal("reference"),
        expertId: SuitePath,
      }).annotate({ parseOptions: { onExcessProperty: "error" } }),
    ]),
  )
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(5_000)),
  resources: Schema.optional(
    Schema.Array(
      Schema.Union([
        Schema.Struct({
          key: SuiteName,
          kind: Schema.Literal("skill"),
          packageRoot: Schema.Union([Schema.Literal("."), SuiteRelativePath]),
          entryPath: SuiteRelativePath,
        }).annotate({ parseOptions: { onExcessProperty: "error" } }),
        Schema.Struct({
          key: SuiteName,
          kind: Schema.Literal("files"),
          root: Schema.Union([Schema.Literal("."), SuiteRelativePath]),
          purpose: SuiteFilePurpose,
        }).annotate({ parseOptions: { onExcessProperty: "error" } }),
        Schema.Struct({
          key: SuiteName,
          kind: Schema.Literal("connection"),
          connectionId: SuitePath,
          tools: Schema.Union([
            Schema.Struct({ mode: Schema.Literal("all") }).annotate({
              parseOptions: { onExcessProperty: "error" },
            }),
            Schema.Struct({
              mode: Schema.Literal("selected"),
              names: Schema.Array(SuiteName).check(Schema.isMaxLength(5_000)),
            }).annotate({ parseOptions: { onExcessProperty: "error" } }),
          ]),
        }).annotate({ parseOptions: { onExcessProperty: "error" } }),
        Schema.Struct({
          key: SuiteName,
          kind: Schema.Literal("resource-reference"),
          resourceRef: SuiteResourceRef,
        }).annotate({ parseOptions: { onExcessProperty: "error" } }),
      ]),
    ).check(Schema.isMaxLength(5_000)),
  ),
  sharedResourceKeys: Schema.optional(Schema.Array(SuiteName).check(Schema.isMaxLength(5_000))),
  coordinatorResourceKeys: Schema.optional(
    Schema.Array(SuiteName).check(Schema.isMaxLength(5_000)),
  ),
  defaults: Schema.optional(SuiteDefaults),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SuiteManifestV1 = typeof SuiteManifestV1.Type;

export const SuitePreviewInput = Schema.Struct({
  requestId: SuiteRequestId,
  source: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("github"), url: SuitePath }).annotate({
      parseOptions: { onExcessProperty: "error" },
    }),
    Schema.Struct({ kind: Schema.Literal("local-folder"), path: SuitePath }).annotate({
      parseOptions: { onExcessProperty: "error" },
    }),
  ]),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SuitePreviewInput = typeof SuitePreviewInput.Type;
export const SuitePreview = Schema.Struct({
  requestId: SuiteRequestId,
  previewId: SuiteRequestId,
  expiresAt: IsoDateTime,
  source: SuiteSource,
  contentHash: SuiteContentHash,
  adapterId: SuiteName,
  adapterVersion: PositiveInt,
  name: SuiteName,
  description: SuiteDescription,
  members: Schema.Array(
    Schema.Struct({ key: SuiteName, name: SuiteName, description: SuiteDescription }),
  ).check(Schema.isMaxLength(5_000)),
  resourceKeys: Schema.Array(SuiteName).check(Schema.isMaxLength(5_000)),
  issues: Schema.Array(SuiteIssue).check(Schema.isMaxLength(200)),
});
export type SuitePreview = typeof SuitePreview.Type;
export const SuiteImportRequest = Schema.Struct({
  operationId: SuiteRequestId,
  previewId: SuiteRequestId,
  contentHash: SuiteContentHash,
  mode: Schema.Literals(["reuse-or-create", "independent-new-content"]),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SuiteImportRequest = typeof SuiteImportRequest.Type;
export const SuiteImportReceipt = Schema.Union([
  Schema.Struct({
    operationId: SuiteRequestId,
    requestHash: SuiteContentHash,
    state: Schema.Literal("pending"),
  }),
  Schema.Struct({
    operationId: SuiteRequestId,
    requestHash: SuiteContentHash,
    state: Schema.Literal("committed"),
    suite: SuiteRef,
    reused: Schema.Boolean,
  }),
  Schema.Struct({
    operationId: SuiteRequestId,
    requestHash: SuiteContentHash,
    state: Schema.Literal("failed"),
    issue: SuiteIssue,
  }),
]);
export type SuiteImportReceipt = typeof SuiteImportReceipt.Type;
export const SuiteCancelPreviewInput = Schema.Struct({ previewId: SuiteRequestId }).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type SuiteCancelPreviewInput = typeof SuiteCancelPreviewInput.Type;
export const SuiteImportReceiptInput = Schema.Struct({ operationId: SuiteRequestId }).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type SuiteImportReceiptInput = typeof SuiteImportReceiptInput.Type;
export const SuiteSummary = Schema.Struct({
  ref: SuiteRef,
  name: SuiteName,
  description: SuiteDescription,
});
export type SuiteSummary = typeof SuiteSummary.Type;

export const ExecutionPurpose = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("direct-expert"), expertSnapshotId: SuitePath }),
  Schema.Struct({
    kind: Schema.Literal("hub-coordinator"),
    hubId: SuitePath,
    hubConfigRevision: PositiveInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("hub-worker"),
    hubId: SuitePath,
    workId: SuitePath,
    hubConfigRevision: PositiveInt,
    expertSnapshotId: SuitePath,
  }),
  Schema.Struct({
    kind: Schema.Literal("native-delegate"),
    parentThreadId: ThreadId,
    parentRootRunId: SuitePath,
    delegationId: SuitePath,
    attemptId: SuitePath,
    expertSnapshotId: SuitePath,
  }),
]);
export type ExecutionPurpose = typeof ExecutionPurpose.Type;
export const CapabilityBinding = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  bindingId: SuitePath,
  bindingHash: SuiteContentHash,
  suite: Schema.NullOr(SuiteRef),
  purpose: ExecutionPurpose,
  projectId: ProjectId,
  connections: ExpertSnapshot.fields.connections,
  mcpBinding: Schema.NullOr(ExpertMcpBindingSchema),
  createdAt: IsoDateTime,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type CapabilityBinding = typeof CapabilityBinding.Type;
export const ResolvedSuiteResource = Schema.Struct({
  key: SuiteName,
  ref: SuiteResourceRef,
  revision: SuitePath,
  packageId: Schema.NullOr(SuitePath),
  entryPath: Schema.NullOr(SuitePath),
  contentHash: SuiteContentHash,
  mode: SkillResourceMode,
  ownerRootRunId: SuitePath,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ResolvedSuiteResource = typeof ResolvedSuiteResource.Type;
export const EffectiveSuiteConfig = Schema.Struct({
  language: Schema.NullOr(SuiteName),
  outputDirectory: Schema.NullOr(SuitePath),
  provenance: Schema.Array(
    Schema.Struct({
      field: Schema.Literals(["language", "outputDirectory"]),
      layer: Schema.Literals(["suite", "expert", "hub", "project", "personal", "invocation"]),
      sourceId: SuitePath,
      value: SuitePath,
    }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  ).check(Schema.isMaxLength(5_000)),
  issues: Schema.Array(SuiteIssue).check(Schema.isMaxLength(200)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type EffectiveSuiteConfig = typeof EffectiveSuiteConfig.Type;
export const SuiteAssemblyId = Schema.String.check(Schema.isPattern(/^sca_[a-f0-9]{64}$/u));
export const SuiteRunAssemblyV2 = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  assemblyId: SuiteAssemblyId,
  threadId: ThreadId,
  rootRunId: SuitePath,
  bindingId: SuitePath,
  bindingHash: SuiteContentHash,
  baseSnapshotId: Schema.NullOr(SuitePath),
  effectiveConfig: EffectiveSuiteConfig,
  resources: Schema.Array(ResolvedSuiteResource).check(Schema.isMaxLength(5_000)),
  skillEntries: Schema.Array(ResolvedExpertSkillEntry).check(Schema.isMaxLength(5_000)),
  phase: Schema.Literals(["prepared", "initializing", "ready", "uncertain"]),
  hasInitializationEffects: Schema.Boolean,
  initializationAttempt: Schema.optional(SuitePath),
  initializationError: Schema.optional(SuiteDescription),
  knowledgeSourceRunId: Schema.optional(SuitePath),
  createdAt: IsoDateTime,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SuiteRunAssemblyV2 = typeof SuiteRunAssemblyV2.Type;
export const SuiteRunConfigurationInput = Schema.Struct({
  threadId: ThreadId,
  rootRunId: SuitePath,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SuiteRunConfigurationInput = typeof SuiteRunConfigurationInput.Type;
export const SuiteRunConfiguration = Schema.Union([
  Schema.Struct({ state: Schema.Literal("not-prepared") }),
  Schema.Struct({
    state: Schema.Literal("prepared"),
    suite: Schema.NullOr(SuiteRef),
    assemblyId: SuitePath,
    effectiveConfig: EffectiveSuiteConfig,
  }),
]);
export type SuiteRunConfiguration = typeof SuiteRunConfiguration.Type;
export const ExpertDraftSelection = Schema.Struct({
  expertId: SuitePath,
  suite: Schema.NullOr(SuiteRef),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExpertDraftSelection = typeof ExpertDraftSelection.Type;
