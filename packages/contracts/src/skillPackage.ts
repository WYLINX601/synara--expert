import { Schema } from "effect";

import { IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";

export const SkillPackageId = Schema.String.check(Schema.isPattern(/^pkg_[a-f0-9]{64}$/u));
export type SkillPackageId = typeof SkillPackageId.Type;
export const SkillSourceId = Schema.String.check(Schema.isPattern(/^src_[a-f0-9]{64}$/u));
export type SkillSourceId = typeof SkillSourceId.Type;

/** Portable package-relative path; never a local absolute path or a provider projection. */
export const SkillEntryPath = Schema.String.check(Schema.isMaxLength(4_096)).check(
  Schema.isPattern(
    /^(?![\\/])(?!.*\\)(?!.*[\p{Cc}:])(?!(?:.*\/)?\.{1,2}(?:\/|$))(?!.*\/\/)(?:[^/]+\/)*SKILL\.md$/u,
  ),
);
export type SkillEntryPath = typeof SkillEntryPath.Type;

export const SkillEntry = Schema.Struct({
  entryPath: SkillEntryPath,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  description: Schema.String.check(Schema.isMaxLength(16_000)),
  /** Metadata warnings, not a claim that a provider has applied this skill. */
  issues: Schema.Array(Schema.String),
  disableModelInvocation: Schema.optional(Schema.Boolean),
  userInvocable: Schema.optional(Schema.Boolean),
  incompatibleReason: Schema.optional(Schema.String),
});
export type SkillEntry = typeof SkillEntry.Type;

export const ExpertSkillSelection = Schema.Struct({
  packageId: SkillPackageId,
  entryPath: SkillEntryPath,
  activation: Schema.Literals(["startup", "on-demand"]),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExpertSkillSelection = typeof ExpertSkillSelection.Type;

export const SkillPackageResource = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: Schema.Literals(["file", "directory"]),
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  executable: Schema.optional(Schema.Boolean),
});
export type SkillPackageResource = typeof SkillPackageResource.Type;

export const SkillPackage = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  packageId: SkillPackageId,
  rootName: TrimmedNonEmptyString,
  resources: Schema.Array(SkillPackageResource).check(Schema.isMaxLength(5_000)),
  entries: Schema.Array(SkillEntry).check(Schema.isMaxLength(5_000)),
  fileCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  totalBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SkillPackage = typeof SkillPackage.Type;

export const SkillPackagePreviewInput = Schema.Struct({
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SkillPackagePreviewInput = typeof SkillPackagePreviewInput.Type;

export const SkillPackagePreview = Schema.Struct({
  previewId: TrimmedNonEmptyString,
  sourcePath: TrimmedNonEmptyString,
  realRoot: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
  package: SkillPackage,
  issues: Schema.Array(Schema.String),
});
export type SkillPackagePreview = typeof SkillPackagePreview.Type;

export const SkillPackageUpdatePreviewInput = Schema.Struct({
  sourceId: SkillSourceId,
  expectedRevision: PositiveInt,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SkillPackageUpdatePreviewInput = typeof SkillPackageUpdatePreviewInput.Type;

export const SkillPackageUpdatePreview = Schema.Struct({
  ...SkillPackagePreview.fields,
  sourceId: SkillSourceId,
  sourceRevision: PositiveInt,
  previousPackageId: SkillPackageId,
  addedEntries: Schema.Array(SkillEntryPath),
  removedEntries: Schema.Array(SkillEntryPath),
  changedEntries: Schema.Array(SkillEntryPath),
  /** Includes shared modules/scripts; an unchanged SKILL.md may still depend on changed resources. */
  resourceChanges: Schema.Array(
    Schema.Struct({
      path: TrimmedNonEmptyString,
      change: Schema.Literals(["added", "removed", "changed"]),
    }),
  ),
});
export type SkillPackageUpdatePreview = typeof SkillPackageUpdatePreview.Type;

export const SkillPackageImportInput = Schema.Struct({
  previewId: TrimmedNonEmptyString,
  idempotencyKey: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SkillPackageImportInput = typeof SkillPackageImportInput.Type;

export const SkillPackageRemoveInput = Schema.Struct({
  packageId: SkillPackageId,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SkillPackageRemoveInput = typeof SkillPackageRemoveInput.Type;

export const SkillPackageReadInput = Schema.Struct({
  packageId: SkillPackageId,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SkillPackageReadInput = typeof SkillPackageReadInput.Type;

export const SkillPackageRemovalPreview = Schema.Struct({
  packageId: SkillPackageId,
  references: Schema.Array(TrimmedNonEmptyString),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SkillPackageRemovalPreview = typeof SkillPackageRemovalPreview.Type;

/** Mutable local-source pointer, deliberately excluded from the package content hash. */
export const SkillPackageSource = Schema.Struct({
  sourceId: SkillSourceId,
  sourcePath: TrimmedNonEmptyString,
  realRoot: TrimmedNonEmptyString,
  packageId: SkillPackageId,
  revision: PositiveInt,
  importedAt: IsoDateTime,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SkillPackageSource = typeof SkillPackageSource.Type;

export const SkillPackageImportResult = Schema.Struct({
  package: SkillPackage,
  source: SkillPackageSource,
  reused: Schema.Boolean,
});
export type SkillPackageImportResult = typeof SkillPackageImportResult.Type;

export const ResolvedExpertSkillEntry = Schema.Struct({
  ...ExpertSkillSelection.fields,
  name: TrimmedNonEmptyString,
  description: Schema.String,
  path: TrimmedNonEmptyString,
  sha256: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))),
  disableModelInvocation: Schema.optional(Schema.Boolean),
  userInvocable: Schema.optional(Schema.Boolean),
});
export type ResolvedExpertSkillEntry = typeof ResolvedExpertSkillEntry.Type;

/** Evidence of catalog submission, not evidence that a model executed a skill. */
export const ExpertSkillApplication = Schema.Struct({
  mode: Schema.Literal("catalog"),
  snapshotId: TrimmedNonEmptyString,
  packageIds: Schema.Array(SkillPackageId),
  catalogHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  instructionsHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  startupEntryIds: Schema.Array(TrimmedNonEmptyString),
  lifecycleGeneration: TrimmedNonEmptyString,
  enforcement: Schema.optional(Schema.Literal("native-fixed")),
  activeEntries: Schema.optional(
    Schema.Array(
      Schema.Struct({
        path: TrimmedNonEmptyString,
        sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
      }),
    ),
  ),
  nativeSubagents: Schema.optional(Schema.Literal("blocked")),
});
export type ExpertSkillApplication = typeof ExpertSkillApplication.Type;
