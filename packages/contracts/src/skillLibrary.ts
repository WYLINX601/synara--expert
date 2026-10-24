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
});
export type SkillDefinition = typeof SkillDefinition.Type;

/** Snapshotted discovery policy. Filesystem tools retain their normal authorization. */
export const ExpertSkillPolicy = Schema.Struct({
  version: Schema.Literal(1),
  discovery: Schema.Literal("fixed"),
  nativeSubagents: Schema.Literal("blocked"),
});
export type ExpertSkillPolicy = typeof ExpertSkillPolicy.Type;
export const FIXED_EXPERT_SKILL_POLICY: ExpertSkillPolicy = {
  version: 1,
  discovery: "fixed",
  nativeSubagents: "blocked",
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
  action("list", {}),
  action("read", { skillId: SkillId }),
  action("create", {
    name: TrimmedNonEmptyString,
    body: Schema.String.check(Schema.isMaxLength(16_777_216)),
    tags: Schema.Array(TrimmedNonEmptyString),
  }),
  action("save", {
    ...Revision,
    name: TrimmedNonEmptyString,
    tags: Schema.Array(TrimmedNonEmptyString),
    changes: Schema.Array(SkillFileChange).check(Schema.isMaxLength(5_000)),
  }),
  action("previewImport", {
    requestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
    location: TrimmedNonEmptyString,
    kind: Schema.Literals(["local", "url", "runtime"]),
  }),
  action("import", {
    previewId: TrimmedNonEmptyString,
    choices: Schema.Array(SkillImportChoice).check(Schema.isMaxLength(5_000)),
  }),
  action("previewRefresh", Revision),
  action("refresh", { ...Revision, previewId: TrimmedNonEmptyString }),
  action("cancel", { previewId: TrimmedNonEmptyString }),
  action("readFile", {
    skillId: SkillId,
    path: TrimmedNonEmptyString,
    expectedRevision: Schema.optional(PositiveInt),
  }),
  action("previewDelete", { skillId: SkillId }),
  action("delete", { ...Revision, confirmExpertIds: Schema.Array(TrimmedNonEmptyString) }),
  action("batch", {
    items: Schema.Array(
      Schema.Struct({
        ...Revision,
        operation: Schema.Literals(["delete", "tags", "previewRefresh", "refresh"]),
        previewId: Schema.optional(TrimmedNonEmptyString),
        tags: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
        confirmExpertIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
      }),
    ).check(Schema.isMaxLength(100)),
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
export const SkillLibraryResponse = Schema.Struct({
  skills: Schema.optional(Schema.Array(SkillDefinition)),
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
  results: Schema.optional(
    Schema.Array(
      Schema.Struct({
        skillId: Schema.String,
        success: Schema.Boolean,
        message: Schema.String,
        preview: Schema.optional(SkillLibraryPreview),
      }),
    ),
  ),
});
export type SkillLibraryResponse = typeof SkillLibraryResponse.Type;
