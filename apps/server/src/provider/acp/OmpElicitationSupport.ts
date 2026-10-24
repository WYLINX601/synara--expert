// FILE: OmpElicitationSupport.ts
// Purpose: Maps OMP's paired ACP askDialog fields to Synara's provider-neutral questions.
// Layer: Provider ACP protocol mapping
// Exports: OMP elicitation preparation and response encoding.

import type { ProviderUserInputAnswers, UserInputQuestion } from "@synara/contracts";
import type * as Acp from "@agentclientprotocol/sdk";

import {
  elicitationQuestionsFromRequest,
  elicitationResponseFromAnswers,
  type FormElicitationRequest,
} from "./AcpElicitationSupport.ts";

type OmpField = {
  readonly id: string;
  readonly base?: Record<string, unknown>;
  readonly companion: Record<string, unknown>;
};

type OmpOption = {
  readonly value: string;
  readonly label: string;
  readonly description: string;
};

type OmpQuestionField = {
  readonly question: string;
  readonly header: string;
  readonly options: ReadonlyArray<OmpOption>;
  readonly multiSelect: boolean;
};

type OmpPreparedQuestion = OmpQuestionField & {
  readonly id: string;
};

type PreparedElicitation = {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly encode: (answers: ProviderUserInputAnswers) => Acp.CreateElicitationResponse;
};

const QUESTION_ID = /^q(0|[1-9]\d*)$/;
const COMPANION_ID = /^q(0|[1-9]\d*)__other$/;
const OMP_OTHER_TITLE = "Other (type your own)";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function questionIndex(id: string): number | undefined {
  const match = QUESTION_ID.exec(id);
  if (!match) return undefined;
  const index = Number(match[1]);
  return Number.isSafeInteger(index) ? index : undefined;
}

function companionIndex(id: string): number | undefined {
  const match = COMPANION_ID.exec(id);
  if (!match) return undefined;
  const index = Number(match[1]);
  return Number.isSafeInteger(index) ? index : undefined;
}

function hasOmpShape(properties: Record<string, unknown>): boolean {
  return Object.keys(properties).some((id) => companionIndex(id) !== undefined);
}

function malformed(message: string): never {
  throw new Error(`Malformed OMP askDialog elicitation: ${message}`);
}

function readOmpFields(properties: Record<string, unknown>): ReadonlyArray<OmpField> | undefined {
  if (!hasOmpShape(properties)) return undefined;

  const indexed = new Map<
    number,
    { base?: Record<string, unknown>; companion?: Record<string, unknown> }
  >();
  for (const [id, value] of Object.entries(properties)) {
    const index = questionIndex(id) ?? companionIndex(id);
    if (index === undefined) malformed(`unexpected property ${id}`);
    if (!isRecord(value)) malformed(`${id} must be an object`);
    const entry = indexed.get(index) ?? {};
    if (questionIndex(id) !== undefined) {
      if (entry.base !== undefined) malformed(`duplicate question property ${id}`);
      entry.base = value;
    } else {
      if (entry.companion !== undefined) malformed(`duplicate companion property ${id}`);
      entry.companion = value;
    }
    indexed.set(index, entry);
  }

  if (indexed.size === 0) malformed("no question fields were found");
  const indices = [...indexed.keys()].toSorted((left, right) => left - right);
  for (let position = 0; position < indices.length; position += 1) {
    if (indices[position] !== position) malformed("question indexes must be contiguous from q0");
  }

  return indices.map((index) => {
    const entry = indexed.get(index);
    const companionId = `q${index}__other`;
    if (!entry?.companion) malformed(`missing ${companionId}`);
    if (entry.companion.type !== "string" || entry.companion.title !== OMP_OTHER_TITLE) {
      malformed(`${companionId} must be a string field titled ${OMP_OTHER_TITLE}`);
    }
    return {
      id: `q${index}`,
      ...(entry.base ? { base: entry.base } : {}),
      companion: entry.companion,
    };
  });
}

function parseOptions(value: unknown, propertyId: string): ReadonlyArray<OmpOption> {
  if (!Array.isArray(value) || value.length === 0) malformed(`${propertyId} has no OMP options`);
  const seenLabels = new Set<string>();
  return value.map((item, index) => {
    if (!isRecord(item)) malformed(`${propertyId} option ${index + 1} must be an object`);
    const value = typeof item.const === "string" ? item.const : undefined;
    const label = nonEmptyString(value);
    const title = typeof item.title === "string" ? item.title : undefined;
    const description =
      item.description === undefined ? undefined : nonEmptyString(item.description);
    if (!label || value === undefined || !title || title !== value) {
      malformed(`${propertyId} option ${index + 1} must have matching const and title labels`);
    }
    if (seenLabels.has(label)) malformed(`${propertyId} has duplicate option label ${label}`);
    seenLabels.add(label);
    if (item.description !== undefined && !description) {
      malformed(`${propertyId} option ${index + 1} has an invalid description`);
    }
    return { value, label, description: description ?? label };
  });
}

function parseQuestionField(field: OmpField): OmpQuestionField {
  if (!field.base) {
    return {
      question: "",
      header: `Question ${(questionIndex(field.id) ?? 0) + 1}`,
      options: [],
      multiSelect: false,
    };
  }

  const question = nonEmptyString(field.base.title);
  if (!question) malformed(`${field.id} must have a non-empty question title`);
  const header =
    field.base.description === undefined ? undefined : nonEmptyString(field.base.description);
  if (field.base.description !== undefined && !header) {
    malformed(`${field.id} has an invalid header description`);
  }

  if (field.base.type === "string") {
    if (!Array.isArray(field.base.oneOf)) malformed(`${field.id} must use oneOf options`);
    return {
      question,
      header: header ?? `Question ${(questionIndex(field.id) ?? 0) + 1}`,
      options: parseOptions(field.base.oneOf, field.id),
      multiSelect: false,
    };
  }

  if (field.base.type === "array" && isRecord(field.base.items)) {
    if (!Array.isArray(field.base.items.anyOf))
      malformed(`${field.id} must use items.anyOf options`);
    return {
      question,
      header: header ?? `Question ${(questionIndex(field.id) ?? 0) + 1}`,
      options: parseOptions(field.base.items.anyOf, field.id),
      multiSelect: true,
    };
  }

  malformed(`${field.id} must be a string oneOf or array items.anyOf field`);
}

function validateAnswerStrings(
  answer: string | ReadonlyArray<string>,
  id: string,
): ReadonlyArray<string> {
  const values = typeof answer === "string" ? [answer] : answer;
  if (values.some((value) => typeof value !== "string")) {
    throw new Error(`Invalid OMP elicitation answer for ${id}: expected strings`);
  }
  return values;
}

function hasKnownSingleAnswer(question: OmpPreparedQuestion, answer: unknown): boolean {
  const knownLabels = new Set(question.options.map((option) => option.label));
  if (typeof answer === "string") return knownLabels.has(answer.trim());
  return (
    Array.isArray(answer) &&
    answer.some((value) => typeof value === "string" && knownLabels.has(value.trim()))
  );
}

function hasNonEmptyAnswer(answer: unknown): boolean {
  if (typeof answer === "string") return answer.trim().length > 0;
  return (
    Array.isArray(answer) &&
    answer.some((value) => typeof value === "string" && value.trim().length > 0)
  );
}

function prepareOmpQuestions(
  request: FormElicitationRequest,
  fields: ReadonlyArray<OmpField>,
): ReadonlyArray<OmpPreparedQuestion> {
  const parsed = fields.map((field) => ({ ...field, ...parseQuestionField(field) }));
  const missingText = parsed.filter((field) => field.question.length === 0);
  if (missingText.length > 0) {
    if (parsed.length > 1) {
      malformed("multi-question freeform asks do not include recoverable question titles");
    }
    const fallbackQuestion = nonEmptyString(request.message);
    if (!fallbackQuestion) malformed("single freeform ask has no question title or message");
    return parsed.map(({ base: _base, companion: _companion, ...field }) => ({
      ...field,
      question: field.question || fallbackQuestion,
    }));
  }
  return parsed.map(({ base: _base, companion: _companion, ...field }) => field);
}

function encodeOmpAnswers(
  questions: ReadonlyArray<OmpPreparedQuestion>,
  answers: ProviderUserInputAnswers,
): Acp.CreateElicitationResponse {
  if (!isRecord(answers)) throw new Error("Invalid OMP elicitation answers: expected an object");
  if (Object.keys(answers).length === 0) return { action: "cancel" };

  const byId = new Map(questions.map((question) => [question.id, question] as const));
  for (const [id, answer] of Object.entries(answers)) {
    if (byId.has(id)) continue;
    const index = companionIndex(id);
    const question = index === undefined ? undefined : byId.get(`q${index}`);
    const canonicalAnswer = question ? answers[question.id] : undefined;
    if (
      question &&
      !question.multiSelect &&
      hasKnownSingleAnswer(question, canonicalAnswer) &&
      hasNonEmptyAnswer(answer)
    ) {
      throw new Error(
        `Conflicting OMP single-select answers for ${question.id}: submit either the canonical answer or its custom answer, not both`,
      );
    }
    throw new Error(`Unknown OMP elicitation answer key: ${id}`);
  }

  for (const question of questions) {
    if (!Object.hasOwn(answers, question.id)) {
      throw new Error(`Incomplete OMP elicitation answers: missing ${question.id}`);
    }
    const answer = answers[question.id];
    if (answer === null || answer === undefined) {
      throw new Error(`Incomplete OMP elicitation answers: ${question.id} is empty`);
    }
  }

  const content: Record<string, Acp.ElicitationContentValue> = {};
  for (const question of questions) {
    const answer = answers[question.id];
    if (answer === null || answer === undefined) {
      throw new Error(`Incomplete OMP elicitation answers: ${question.id} is empty`);
    }

    const values = validateAnswerStrings(answer, question.id);
    if (!question.multiSelect && values.length > 1) {
      throw new Error(`Invalid OMP elicitation answer for ${question.id}: expected one answer`);
    }

    const known: Array<OmpOption> = [];
    const custom: Array<string> = [];
    for (const rawValue of values) {
      const value = rawValue.trim();
      if (!value) continue;
      const option = question.options.find((candidate) => candidate.label === value);
      if (option) {
        if (!known.some((candidate) => candidate.label === option.label)) known.push(option);
      } else {
        custom.push(value);
      }
    }

    if (known.length === 0 && custom.length === 0) {
      throw new Error(`Incomplete OMP elicitation answers: ${question.id} is empty`);
    }

    if (question.multiSelect) {
      if (custom.length > 1) {
        throw new Error(
          `Invalid OMP elicitation answer for ${question.id}: expected at most one custom answer`,
        );
      }
      if (answer !== null && Array.isArray(answer)) {
        content[question.id] = known.map((option) => option.value);
      } else if (known.length > 0) {
        content[question.id] = known.map((option) => option.value);
      }
      if (custom.length > 0) content[`${question.id}__other`] = custom.join("\n");
    } else if (known[0] !== undefined) {
      content[question.id] = known[0].value;
    } else if (custom[0] !== undefined) {
      content[`${question.id}__other`] = custom[0];
    }
  }
  return { action: "accept", content };
}

/** Prepare OMP's paired askDialog fields without changing ordinary ACP form behavior. */
export function prepareOmpElicitation(request: FormElicitationRequest): PreparedElicitation {
  const rawProperties = request.requestedSchema.properties ?? {};
  const properties = rawProperties as Record<string, unknown>;
  const fields = readOmpFields(properties);
  if (!fields) {
    return {
      questions: elicitationQuestionsFromRequest(request),
      encode: (answers) => {
        if (!isRecord(answers))
          throw new Error("Invalid OMP elicitation answers: expected an object");
        return Object.keys(answers).length === 0
          ? { action: "cancel" }
          : elicitationResponseFromAnswers(request, answers);
      },
    };
  }

  const preparedQuestions = prepareOmpQuestions(request, fields);
  const questions: ReadonlyArray<UserInputQuestion> = preparedQuestions.map((question) => ({
    id: question.id,
    header: question.header,
    question: question.question,
    options: question.options.map(({ label, description }) => ({ label, description })),
    multiSelect: question.multiSelect,
    ...(question.multiSelect ? { allowCustomAnswerWithOptions: true } : {}),
  }));
  return {
    questions,
    encode: (answers) => encodeOmpAnswers(preparedQuestions, answers),
  };
}
