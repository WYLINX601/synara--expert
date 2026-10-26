// FILE: OmpElicitationSupport.test.ts
// Purpose: Verifies OMP askDialog fields map to one canonical Synara question each.
// Layer: Provider ACP tests
// Depends on: OmpElicitationSupport.

import { describe, expect, it } from "vitest";
import type { ProviderUserInputAnswers } from "@synara/contracts";

import type { FormElicitationRequest } from "./AcpElicitationSupport.ts";
import { prepareOmpElicitation } from "./OmpElicitationSupport.ts";

function form(message: string, properties: Record<string, unknown>): FormElicitationRequest {
  return {
    mode: "form",
    sessionId: "session-1",
    message,
    requestedSchema: {
      type: "object",
      properties,
    },
  } as FormElicitationRequest;
}

const choiceProperties = {
  q0: {
    type: "string",
    title: "Which approach should we take?",
    description: "Approach",
    oneOf: [
      { const: "Reuse", title: "Reuse", description: "Keep the existing implementation." },
      { const: "Replace", title: "Replace", description: "Build a new implementation." },
    ],
  },
  q0__other: { type: "string", title: "Other (type your own)" },
  q1: {
    type: "array",
    title: "Which safeguards should apply?",
    description: "Safeguards",
    items: {
      anyOf: [
        { const: "Logging", title: "Logging", description: "Record relevant events." },
        { const: "Retries", title: "Retries", description: "Retry transient failures." },
      ],
    },
  },
  q1__other: { type: "string", title: "Other (type your own)" },
};

const answer = (value: ProviderUserInputAnswers) => value;

describe("OMP ACP elicitation mapping", () => {
  it("collapses OMP option and companion fields and restores their labels and descriptions", () => {
    const prepared = prepareOmpElicitation(form("Answer 2 questions", choiceProperties));

    expect(prepared.questions).toEqual([
      {
        id: "q0",
        header: "Approach",
        question: "Which approach should we take?",
        options: [
          { label: "Reuse", description: "Keep the existing implementation." },
          { label: "Replace", description: "Build a new implementation." },
        ],
        multiSelect: false,
      },
      {
        id: "q1",
        header: "Safeguards",
        question: "Which safeguards should apply?",
        options: [
          { label: "Logging", description: "Record relevant events." },
          { label: "Retries", description: "Retry transient failures." },
        ],
        multiSelect: true,
        allowCustomAnswerWithOptions: true,
      },
    ]);
  });

  it("encodes a single known selection only under qN", () => {
    const prepared = prepareOmpElicitation(form("Answer 2 questions", choiceProperties));
    expect(prepared.encode(answer({ q0: "Replace", q1: ["Logging"] }))).toEqual({
      action: "accept",
      content: { q0: "Replace", q1: ["Logging"] },
    });
  });

  it("encodes single custom text only under qN__other and normalizes a label match", () => {
    const prepared = prepareOmpElicitation(form("Answer 2 questions", choiceProperties));
    expect(prepared.encode(answer({ q0: "A new approach", q1: ["Logging"] }))).toEqual({
      action: "accept",
      content: { q0__other: "A new approach", q1: ["Logging"] },
    });
    expect(prepared.encode(answer({ q0: "Reuse", q1: ["Logging"] }))).toEqual({
      action: "accept",
      content: { q0: "Reuse", q1: ["Logging"] },
    });
  });

  it("keeps the original OMP option value when trimming its UI label", () => {
    const prepared = prepareOmpElicitation(
      form("Choose a route", {
        q0: {
          type: "string",
          title: "Which route?",
          description: "Route",
          oneOf: [{ const: " Choice ", title: " Choice ", description: " Selected route " }],
        },
        q0__other: { type: "string", title: "Other (type your own)" },
      }),
    );
    expect(prepared.questions[0]?.options).toEqual([
      { label: "Choice", description: "Selected route" },
    ]);
    expect(prepared.encode(answer({ q0: "Choice" }))).toEqual({
      action: "accept",
      content: { q0: " Choice " },
    });
  });

  it("preserves multi-select choices alongside custom text", () => {
    const prepared = prepareOmpElicitation(form("Answer 2 questions", choiceProperties));
    expect(
      prepared.encode(answer({ q0: "Reuse", q1: ["Retries", "A custom safeguard", "Logging"] })),
    ).toEqual({
      action: "accept",
      content: {
        q0: "Reuse",
        q1: ["Retries", "Logging"],
        q1__other: "A custom safeguard",
      },
    });
  });

  it("maps a single freeform-only ask using the request message", () => {
    const prepared = prepareOmpElicitation(
      form("What should we call this environment?", {
        q0__other: { type: "string", title: "Other (type your own)" },
      }),
    );
    expect(prepared.questions).toEqual([
      {
        id: "q0",
        header: "Question 1",
        question: "What should we call this environment?",
        options: [],
        multiSelect: false,
      },
    ]);
    expect(prepared.encode(answer({ q0: "Preview" }))).toEqual({
      action: "accept",
      content: { q0__other: "Preview" },
    });
  });

  it("returns cancellation for an empty answer object", () => {
    const prepared = prepareOmpElicitation(form("Answer 2 questions", choiceProperties));
    expect(prepared.encode(answer({}))).toEqual({ action: "cancel" });
    const generic = prepareOmpElicitation(
      form("Choose a value", { value: { type: "string", title: "Value" } }),
    );
    expect(generic.encode(answer({}))).toEqual({ action: "cancel" });
  });

  it("keeps ordinary ACP forms on the existing generic mapping path", () => {
    const ordinary = form("Choose a value", {
      choice: { type: "string", title: "Choice", enum: ["first", "second"] },
      choice_other: { type: "string", title: "Independent field" },
    });
    const prepared = prepareOmpElicitation(ordinary);
    expect(prepared.questions.map(({ id }) => id)).toEqual(["choice", "choice_other"]);
    expect(prepared.encode(answer({ choice: "first", choice_other: "separate" }))).toEqual({
      action: "accept",
      content: { choice: "first", choice_other: "separate" },
    });
  });

  it("keeps qN-only ACP forms generic and rejects malformed OMP structures", () => {
    expect(() =>
      prepareOmpElicitation(
        form("Answer 1 questions", {
          q0: {
            type: "string",
            title: "Select an approach",
            oneOf: [{ const: "Reuse", title: "Reuse" }],
          },
        }),
      ),
    ).not.toThrow();
    const ordinaryQ0 = prepareOmpElicitation(
      form("Choose an approach", {
        q0: {
          type: "string",
          title: "Approach",
          oneOf: [
            { const: "Reuse", title: "Reuse" },
            { const: "Replace", title: "Replace" },
          ],
        },
      }),
    );
    expect(ordinaryQ0.questions.map(({ id }) => id)).toEqual(["q0"]);
    expect(ordinaryQ0.encode(answer({ q0: "Replace" }))).toEqual({
      action: "accept",
      content: { q0: "Replace" },
    });

    expect(() =>
      prepareOmpElicitation(
        form("Answer 2 questions", {
          q0: {
            type: "string",
            title: "Choose the first approach",
            oneOf: [{ const: "Reuse", title: "Reuse" }],
          },
          q0__other: { type: "string", title: "Other (type your own)" },
          q1: {
            type: "string",
            title: "Choose the second approach",
            oneOf: [{ const: "Replace", title: "Replace" }],
          },
        }),
      ),
    ).toThrow(/Malformed OMP askDialog elicitation: missing q1__other/);

    expect(() =>
      prepareOmpElicitation(
        form("What next?", {
          q0__other: { type: "string", title: "Other" },
        }),
      ),
    ).toThrow(/q0__other must be a string field titled Other \(type your own\)/);

    expect(() =>
      prepareOmpElicitation(
        form("Choose one", {
          q0: {
            type: "string",
            title: "Select an approach",
            oneOf: [
              { const: "Reuse", title: "Reuse", description: "First meaning." },
              { const: " Reuse ", title: " Reuse ", description: "Second meaning." },
            ],
          },
          q0__other: { type: "string", title: "Other (type your own)" },
        }),
      ),
    ).toThrow(/q0 has duplicate option label Reuse/);
  });

  it("rejects multi-question freeform asks whose individual question text is missing", () => {
    expect(() =>
      prepareOmpElicitation(
        form("Answer 2 questions", {
          q0__other: { type: "string", title: "Other (type your own)" },
          q1__other: { type: "string", title: "Other (type your own)" },
        }),
      ),
    ).toThrow(/multi-question freeform asks do not include recoverable question titles/);
  });

  it("rejects unknown keys, invalid single-answer cardinality, and conflicting legacy single answers", () => {
    const prepared = prepareOmpElicitation(form("Answer 2 questions", choiceProperties));
    expect(() => prepared.encode(answer({ missing: "x" }))).toThrow(
      /Unknown OMP elicitation answer key/,
    );
    expect(() => prepared.encode(answer({ q0: ["Reuse", "Replace"], q1: ["Logging"] }))).toThrow(
      /expected one answer/,
    );
    expect(() =>
      prepared.encode(answer({ q0: "Reuse", q1: ["first custom", "second custom"] })),
    ).toThrow(/expected at most one custom answer/);
    expect(() => prepared.encode(answer({ q0: "Replace" }))).toThrow(
      /Incomplete OMP elicitation answers: missing q1/,
    );
    expect(() => prepared.encode(answer({ q0: null, q1: ["Logging"] }))).toThrow(
      /Incomplete OMP elicitation answers: q0 is empty/,
    );
    expect(() => prepared.encode(answer({ q0: " ", q1: ["Logging"] }))).toThrow(
      /Incomplete OMP elicitation answers: q0 is empty/,
    );
    expect(() =>
      prepared.encode(answer({ q0: "Reuse", q0__other: "Conflicting", q1: ["Logging"] })),
    ).toThrow(/Conflicting OMP single-select answers for q0/);
  });
});
