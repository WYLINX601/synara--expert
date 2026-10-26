import { Schema } from "effect";
import { IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";
import { SkillEntryPath, SkillPackage, SkillPackageId, SkillPackageResource } from "./skillPackage";

export const SkillId = Schema.String.check(Schema.isPattern(/^skl_[a-f0-9]{32}$/u));
export type SkillId = typeof SkillId.Type;
export const ExpertSkillBinding = Schema.Struct({
  skillId: SkillId,
  enabled: Schema.Boolean,
  activation: Schema.Literals(["startup", "on-demand"]),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExpertSkillBinding = typeof ExpertSkillBinding.Type;

export const SkillSource = Schema.Struct({
  kind: Schema.Literals(["manual", "local", "archive", "url", "runtime"]),
  location: Schema.String,
  resolvedRevision: Schema.optional(Schema.String),
  entryPath: SkillEntryPath,
  packageId: SkillPackageId,
});
export type SkillSource = typeof SkillSource.Type;
export const SkillDefinition = Schema.Struct({
  skillId: SkillId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  description: Schema.String.check(Schema.isMaxLength(16_000)),
  tags: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(100))).check(
    Schema.isMaxLength(100),
  ),
  packageId: SkillPackageId,
  entryPath: SkillEntryPath,
  source: SkillSource,
  locallyModified: Schema.Boolean,
  revision: PositiveInt,
  deleted: Schema.Boolean,
  updatedAt: IsoDateTime,
  /** Missing on historical records. Never infer this from updatedAt. */
  createdAt: Schema.optional(IsoDateTime),
  /** Trusted server actor identifier; "unknown" is reserved for query filters. */
  createdBy: Schema.optional(TrimmedNonEmptyString),
});
export type SkillDefinition = typeof SkillDefinition.Type;

export const SkillLibrarySourceFilter = Schema.Literals([
  "manual",
  "github",
  "skills.sh",
  "clawhub",
  "local",
  "archive",
  "runtime",
]);
export type SkillLibrarySourceFilter = typeof SkillLibrarySourceFilter.Type;
export const SkillLibraryQuery = Schema.Struct({
  search: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  usage: Schema.optional(Schema.Literals(["used", "unused"])),
  sources: Schema.optional(Schema.Array(SkillLibrarySourceFilter).check(Schema.isMaxLength(7))),
  expertIds: Schema.optional(Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(500))),
  /** Use the literal "unknown" to select historical records without attribution. */
  createdBy: Schema.optional(Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(500))),
  tags: Schema.optional(Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(100))),
  sort: Schema.optional(
    Schema.Struct({
      field: Schema.Literals(["name", "usedBy", "created", "updated"]),
      direction: Schema.Literals(["asc", "desc"]),
    }),
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SkillLibraryQuery = typeof SkillLibraryQuery.Type;
export const SkillLibraryItem = Schema.Struct({
  skillId: SkillId,
  createdAt: Schema.optional(IsoDateTime),
  createdBy: Schema.optional(TrimmedNonEmptyString),
  usage: Schema.Struct({
    expertIds: Schema.Array(TrimmedNonEmptyString),
    enabledExpertIds: Schema.Array(TrimmedNonEmptyString),
  }),
});
export type SkillLibraryItem = typeof SkillLibraryItem.Type;

export const SkillLibraryBindingStatus = Schema.Literals([
  "applied",
  "unchanged",
  "conflict",
  "needs_conversion",
  "failed",
]);
export type SkillLibraryBindingStatus = typeof SkillLibraryBindingStatus.Type;
export const SkillLibraryBindingResult = Schema.Struct({
  expertId: TrimmedNonEmptyString,
  status: SkillLibraryBindingStatus,
  oldRevision: Schema.optional(PositiveInt),
  newRevision: Schema.optional(PositiveInt),
  addedSkillIds: Schema.Array(SkillId),
  skippedSkillIds: Schema.Array(SkillId),
  error: Schema.optional(Schema.String),
});
export type SkillLibraryBindingResult = typeof SkillLibraryBindingResult.Type;
export const SkillLibraryBindingState = Schema.Struct({
  expertId: TrimmedNonEmptyString,
  revision: PositiveInt,
  bindings: Schema.Array(ExpertSkillBinding),
  needsConversion: Schema.optional(Schema.Boolean),
  status: Schema.optional(SkillLibraryBindingStatus),
  error: Schema.optional(Schema.String),
  dryRun: Schema.optional(Schema.Boolean),
});
export type SkillLibraryBindingState = typeof SkillLibraryBindingState.Type;
/** Snapshotted discovery policy. Filesystem tools retain their normal authorization. */
export const ExpertSkillPolicy = Schema.Struct({
  version: Schema.Literals([1, 2]),
  discovery: Schema.Literal("fixed"),
  nativeSubagents: Schema.Literals(["blocked", "inherit"]),
});
export type ExpertSkillPolicy = typeof ExpertSkillPolicy.Type;
export const FIXED_EXPERT_SKILL_POLICY: ExpertSkillPolicy = {
  version: 2,
  discovery: "fixed",
  nativeSubagents: "inherit",
};

const Revision = { skillId: SkillId, expectedRevision: PositiveInt };
export const SkillFileChange = Schema.Struct({
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
  /** base64 preserves binary bytes; omitted content deletes a file. */
  content: Schema.optional(Schema.String.check(Schema.isMaxLength(22_369_624))),
  executable: Schema.optional(Schema.Boolean),
});
export const SkillImportChoice = Schema.Struct({
  entryPath: SkillEntryPath,
  duplicate: Schema.Literals(["skip", "rename", "replace"]),
  name: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  replaceSkillId: Schema.optional(SkillId),
  expectedRevision: Schema.optional(PositiveInt),
});
export type SkillImportChoice = typeof SkillImportChoice.Type;
const action = <T extends string, F extends Schema.Struct.Fields>(name: T, fields: F) =>
  Schema.Struct({ action: Schema.Literal(name), ...fields }).annotate({
    parseOptions: { onExcessProperty: "error" },
  });
export const SkillLibraryRequest = Schema.Union([
  action("list", { query: Schema.optional(SkillLibraryQuery) }),
  action("read", { skillId: SkillId }),
  action("create", {
    requestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
    name: TrimmedNonEmptyString,
    body: Schema.String.check(Schema.isMaxLength(16_777_216)),
    tags: Schema.Array(TrimmedNonEmptyString),
    dryRun: Schema.optional(Schema.Boolean),
  }),
  action("save", {
    ...Revision,
    requestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
    name: TrimmedNonEmptyString,
    description: Schema.optional(Schema.String.check(Schema.isMaxLength(20_000))),
    tags: Schema.Array(TrimmedNonEmptyString),
    changes: Schema.Array(SkillFileChange).check(Schema.isMaxLength(5_000)),
    dryRun: Schema.optional(Schema.Boolean),
  }),
  action("previewImport", {
    requestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
    location: TrimmedNonEmptyString,
    kind: Schema.Literals(["local", "url", "runtime"]),
  }),
  action("import", {
    requestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
    previewId: TrimmedNonEmptyString,
    choices: Schema.Array(SkillImportChoice).check(Schema.isMaxLength(5_000)),
    dryRun: Schema.optional(Schema.Boolean),
  }),
  action("previewRefresh", Revision),
  action("refresh", {
    ...Revision,
    requestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
    previewId: TrimmedNonEmptyString,
    dryRun: Schema.optional(Schema.Boolean),
  }),
  action("cancel", { previewId: TrimmedNonEmptyString }),
  action("readFile", {
    skillId: SkillId,
    path: TrimmedNonEmptyString,
    expectedRevision: Schema.optional(PositiveInt),
  }),
  action("previewDelete", { skillId: SkillId }),
  action("delete", {
    ...Revision,
    requestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
    confirmExpertIds: Schema.Array(TrimmedNonEmptyString),
    dryRun: Schema.optional(Schema.Boolean),
  }),
  action("batch", {
    requestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
    items: Schema.Array(
      Schema.Struct({
        ...Revision,
        operation: Schema.Literals([
          "delete",
          "tags",
          "previewRefresh",
          "refresh",
          "updateFromSource",
        ]),
        previewId: Schema.optional(TrimmedNonEmptyString),
        tags: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
        confirmExpertIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
        requestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
        overwriteLocalEdits: Schema.optional(Schema.Boolean),
      }),
    ).check(Schema.isMaxLength(100)),
    dryRun: Schema.optional(Schema.Boolean),
  }),
  action("bindings", {
    operation: Schema.Literal("list"),
    expertId: TrimmedNonEmptyString,
  }),
  action("bindings", {
    operation: Schema.Literals(["add", "set"]),
    expertId: TrimmedNonEmptyString,
    expectedRevision: PositiveInt,
    requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
    bindings: Schema.Array(ExpertSkillBinding).check(Schema.isMaxLength(100)),
    dryRun: Schema.optional(Schema.Boolean),
  }),
  action("bindings", {
    operation: Schema.Literals(["remove", "enable", "disable"]),
    expertId: TrimmedNonEmptyString,
    expectedRevision: PositiveInt,
    requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
    skillIds: Schema.Array(SkillId).check(Schema.isMaxLength(100)),
    dryRun: Schema.optional(Schema.Boolean),
  }),
  action("bindExperts", {
    requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
    skillIds: Schema.Array(SkillId).check(Schema.isMaxLength(100)),
    targets: Schema.Array(
      Schema.Struct({ expertId: TrimmedNonEmptyString, expectedRevision: PositiveInt }),
    ).check(Schema.isMaxLength(500)),
    dryRun: Schema.optional(Schema.Boolean),
  }),
  action("updateFromSource", {
    skillId: SkillId,
    expectedRevision: PositiveInt,
    requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
    overwriteLocalEdits: Schema.optional(Schema.Boolean),
    dryRun: Schema.optional(Schema.Boolean),
  }),
]);
export type SkillLibraryRequest = typeof SkillLibraryRequest.Type;
export const SkillLibraryRpcInput = Schema.Struct({ request: SkillLibraryRequest });
export const SkillLibraryPreview = Schema.Struct({
  previewId: TrimmedNonEmptyString,
  package: SkillPackage,
  expiresAt: IsoDateTime,
  source: SkillSource,
  resourceChanges: Schema.Array(Schema.String),
  overwritesLocalEdits: Schema.Boolean,
  selectedEntryPaths: Schema.optional(Schema.Array(SkillEntryPath)),
});
export type SkillLibraryPreview = typeof SkillLibraryPreview.Type;
export const SkillLibraryUpdateResult = Schema.Struct({
  skillId: SkillId,
  status: Schema.Literals(["updated", "unchanged", "skipped", "conflict", "failed"]),
  revision: Schema.optional(PositiveInt),
  preview: Schema.optional(SkillLibraryPreview),
  error: Schema.optional(Schema.String),
});
export type SkillLibraryUpdateResult = typeof SkillLibraryUpdateResult.Type;
export const SkillLibraryPlan = Schema.Struct({
  operation: TrimmedNonEmptyString,
  status: Schema.Literals(["would_change", "unchanged", "skipped", "conflict", "failed"]),
  skillId: Schema.optional(SkillId),
  entryPath: Schema.optional(SkillEntryPath),
  revision: Schema.optional(PositiveInt),
  packageId: Schema.optional(SkillPackageId),
  expertIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  addedSkillIds: Schema.optional(Schema.Array(SkillId)),
  skippedSkillIds: Schema.optional(Schema.Array(SkillId)),
  message: Schema.optional(Schema.String),
  preview: Schema.optional(SkillLibraryPreview),
});
export type SkillLibraryPlan = typeof SkillLibraryPlan.Type;
export const SkillLibraryBatchResult = Schema.Struct({
  skillId: SkillId,
  success: Schema.Boolean,
  message: Schema.String,
  preview: Schema.optional(SkillLibraryPreview),
  updateResult: Schema.optional(SkillLibraryUpdateResult),
  status: Schema.optional(
    Schema.Literals(["would_change", "unchanged", "skipped", "conflict", "failed"]),
  ),
});
export type SkillLibraryBatchResult = typeof SkillLibraryBatchResult.Type;
export const SkillLibraryResponse = Schema.Struct({
  requestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  skills: Schema.optional(Schema.Array(SkillDefinition)),
  items: Schema.optional(Schema.Array(SkillLibraryItem)),
  skill: Schema.optional(SkillDefinition),
  resources: Schema.optional(Schema.Array(SkillPackageResource)),
  file: Schema.optional(
    Schema.Struct({
      path: Schema.String,
      content: Schema.String,
      text: Schema.optional(Schema.String),
    }),
  ),
  preview: Schema.optional(SkillLibraryPreview),
  expertIds: Schema.optional(Schema.Array(Schema.String)),
  bindingResult: Schema.optional(SkillLibraryBindingState),
  bindingResults: Schema.optional(Schema.Array(SkillLibraryBindingResult)),
  updateResult: Schema.optional(SkillLibraryUpdateResult),
  plan: Schema.optional(SkillLibraryPlan),
  plans: Schema.optional(Schema.Array(SkillLibraryPlan)),
  dryRun: Schema.optional(Schema.Boolean),
  results: Schema.optional(Schema.Array(SkillLibraryBatchResult)),
});
export type SkillLibraryResponse = typeof SkillLibraryResponse.Type;
