import { Schema } from "effect";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";

const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const Hash = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/u));
const Quote = Schema.String.check(Schema.isMaxLength(16_000));

/** A UTF-16 range into the exact source text returned by the host. */
export const LearningSourceRange = Schema.Struct({
  startOffset: NonNegativeInt,
  endOffset: NonNegativeInt,
});
export type LearningSourceRange = typeof LearningSourceRange.Type;

/**
 * Model-facing selectors contain only source identities and optional excerpts.
 * Thread, turn, owner, project roots, and attachment principal come from the host.
 */
export const LearningSourceSelection = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("message"),
    messageId: Id,
    quote: Schema.optional(Quote),
    range: Schema.optional(LearningSourceRange),
  }),
  Schema.Struct({
    kind: Schema.Literal("runtime"),
    eventId: Id,
    quote: Schema.optional(Quote),
  }),
  Schema.Struct({
    kind: Schema.Literal("document"),
    relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
    rootIndex: Schema.optional(NonNegativeInt),
    expectedHash: Schema.optional(Hash),
    startOffset: Schema.optional(NonNegativeInt),
    endOffset: Schema.optional(NonNegativeInt),
    quote: Schema.optional(Quote),
  }),
  Schema.Struct({
    kind: Schema.Literal("attachment"),
    attachmentId: Id,
    messageId: Schema.optional(Id),
    expectedHash: Schema.optional(Hash),
    range: Schema.optional(LearningSourceRange),
    quote: Schema.optional(Quote),
  }),
]);
export type LearningSourceSelection = typeof LearningSourceSelection.Type;

export const LEARNING_SOURCE_SELECTION_LIMIT = 5;

export const LearningSourceSelections = Schema.Array(LearningSourceSelection).check(
  Schema.isMaxLength(LEARNING_SOURCE_SELECTION_LIMIT),
);
export type LearningSourceSelections = typeof LearningSourceSelections.Type;
