import { Schema } from "effect";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";
import { SkillDefinition, SkillFileChange } from "./skillLibrary";
import { SkillEntryPath, SkillPackageResource } from "./skillPackage";
import { SpaceMemoryKind, MemoryScope } from "./spaceMemory";
import { LearningSourceSelection } from "./learningSources";

const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const Hash = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/u));

/** Captured by the host when a native runtime receives its gateway lease. */
export const LearningSessionContext = Schema.Struct({
  manifestId: Id,
  rootRunId: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
  snapshotId: Id,
  scope: MemoryScope,
  knowledgeHash: Hash,
  learningEpoch: Schema.optional(NonNegativeInt),
});
export type LearningSessionContext = typeof LearningSessionContext.Type;

export const LearningMemoryDraft = Schema.Struct({
  memoryId: Schema.optional(Id),
  expectedRevision: Schema.optional(NonNegativeInt),
  kind: SpaceMemoryKind,
  key: Id,
  content: TrimmedNonEmptyString.check(Schema.isMaxLength(4_000)),
  /** Can narrow a new rule to the current Project; never widens existing scope. */
  projectOnly: Schema.optional(Schema.Boolean),
  validUntil: Schema.optional(IsoDateTime),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type LearningMemoryDraft = typeof LearningMemoryDraft.Type;

export const LearningSkillDraft = Schema.Struct({
  assetKind: Schema.Literal("skill"),
  targetSkillId: Schema.optional(Id),
  expectedSkillRevision: Schema.optional(NonNegativeInt),
  expectedExpertRevision: NonNegativeInt,
  basePackageId: Schema.optional(Id),
  name: Id,
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(8_000))),
  changes: Schema.Array(SkillFileChange).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });

export const LearningCommitInput = Schema.Struct({
  requestId: Id,
  sources: Schema.Array(LearningSourceSelection).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(5),
  ),
  change: Schema.Union([
    Schema.Struct({ assetKind: Schema.Literal("memory"), ...LearningMemoryDraft.fields }),
    LearningSkillDraft,
  ]),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type LearningCommitInput = typeof LearningCommitInput.Type;

export const LearningReadInput = Schema.Struct({
  mode: Schema.optional(Schema.Literals(["runtime", "edit"])),
  memoryId: Schema.optional(Id),
  skillId: Schema.optional(Id),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type LearningReadInput = typeof LearningReadInput.Type;

/** Explicit edit data, never a replacement for the Run's pinned native Skill catalog. */
export const LearningSkillEditBaseline = Schema.Struct({
  usage: Schema.Literal("edit-baseline"),
  expertRevision: NonNegativeInt,
  skill: SkillDefinition,
  resources: Schema.Array(SkillPackageResource).check(Schema.isMaxLength(100)),
  file: Schema.Struct({
    path: SkillEntryPath,
    content: Schema.String.check(Schema.isMaxLength(1_333_336)),
    text: Schema.String.check(Schema.isMaxLength(128_000)),
  }),
  coverage: Schema.Array(Id).check(Schema.isMaxLength(5)),
});
export type LearningSkillEditBaseline = typeof LearningSkillEditBaseline.Type;

export const LearningRevertInput = Schema.Struct({
  requestId: Id,
  changeId: Id,
  expectedRevision: Schema.optional(NonNegativeInt),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type LearningRevertInput = typeof LearningRevertInput.Type;
