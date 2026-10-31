import { Schema } from "effect";
import { IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";
import { ProviderExpertSession } from "./provider";

export const SkillAssemblyId = Schema.String.check(Schema.isPattern(/^ska_[a-f0-9]{64}$/u));
export type SkillAssemblyId = typeof SkillAssemblyId.Type;

/** One execution intent may contain several native turns and automatic continuations. */
export const RunSkillAssembly = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  assemblyId: SkillAssemblyId,
  rootRunId: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
  threadId: TrimmedNonEmptyString,
  baseSnapshotId: TrimmedNonEmptyString,
  bindingRevision: PositiveInt,
  createdAt: IsoDateTime,
  hasInitializationEffects: Schema.Boolean,
  phase: Schema.Literals(["prepared", "initializing", "ready", "uncertain"]),
  initializationAttempt: Schema.optional(TrimmedNonEmptyString),
  initializationError: Schema.optional(Schema.String),
  /** Exact predecessor for knowledge inheritance across Worker continuation. */
  knowledgeSourceRunId: Schema.optional(TrimmedNonEmptyString),
  session: ProviderExpertSession,
});
export type RunSkillAssembly = typeof RunSkillAssembly.Type;
