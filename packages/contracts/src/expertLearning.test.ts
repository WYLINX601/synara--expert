import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  ExpertLearningEvidence,
  ExpertLearningState,
  LearningSourceReference,
  SkillEvolutionRequest,
  SkillEvolutionResponse,
} from "./index";

const learningState = {
  expertId: "expert-a",
  enabled: true,
  epoch: 2,
  revision: 3,
  harnessKind: "pi",
  updatedAt: "2026-10-31T00:00:00.000Z",
  status: "idle",
  summary: "Ready to learn.",
} as const;

const evidence = {
  evidenceId: "evidence-a",
  ownerId: "owner-a",
  expertId: "expert-a",
  threadId: "thread-a",
  turnId: "turn-a",
  rootRunId: "root-run-a",
  snapshotId: "snapshot-a",
  assemblyId: "assembly-a",
  projectId: "project-a",
  spaceId: "space-a",
  modelSelection: { provider: "pi", instanceId: "pi-local", model: "configured-model" },
  items: [
    {
      id: "event-a",
      kind: "message",
      text: "Use concise evidence.",
      role: "user",
      eventSequence: 4,
    },
    {
      id: "event-b",
      kind: "tool_result",
      text: "verified output",
      toolCallId: "tool-a",
      truncated: false,
    },
  ],
  coverage: ["user_feedback", "verification"],
  completedAt: "2026-10-31T00:00:00.000Z",
  updatedAt: "2026-10-31T00:00:01.000Z",
} as const;

describe("Expert automatic learning contracts", () => {
  it("bounds and decodes public learning state", () => {
    expect(Schema.decodeUnknownSync(ExpertLearningState)(learningState)).toEqual(learningState);
    expect(() =>
      Schema.decodeUnknownSync(ExpertLearningState)({
        ...learningState,
        expertId: "x".repeat(201),
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ExpertLearningState)({ ...learningState, epoch: -1 }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ExpertLearningState)({ ...learningState, status: "running" }),
    ).toThrow();
  });

  it("accepts bounded evidence and rejects oversized or unsupported entries", () => {
    expect(Schema.decodeUnknownSync(ExpertLearningEvidence)(evidence)).toMatchObject({
      evidenceId: "evidence-a",
      items: evidence.items,
    });
    expect(() =>
      Schema.decodeUnknownSync(ExpertLearningEvidence)({
        ...evidence,
        items: Array.from({ length: 129 }, (_, index) => ({
          id: `event-${index}`,
          kind: "activity",
          text: "",
        })),
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ExpertLearningEvidence)({
        ...evidence,
        items: [{ id: "event-a", kind: "message", text: "x".repeat(16_001) }],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ExpertLearningEvidence)({
        ...evidence,
        coverage: Array.from({ length: 33 }, (_, index) => `coverage-${index}`),
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ExpertLearningEvidence)({
        ...evidence,
        items: [{ id: "event-a", kind: "message", text: "x", role: "system" }],
      }),
    ).toThrow();
  });

  it("exposes only bounded harness selection and revision fields for enabling", () => {
    const read = { action: "learningRead", expertId: "expert-a" };
    const set = {
      action: "learningSet",
      expertId: "expert-a",
      requestId: "enable-learning",
      expectedRevision: 0,
      enabled: true,
      harnessKind: "omp",
    };
    expect(Schema.decodeUnknownSync(SkillEvolutionRequest)(read)).toEqual(read);
    expect(Schema.decodeUnknownSync(SkillEvolutionRequest)(set)).toEqual(set);
    expect(() =>
      Schema.decodeUnknownSync(SkillEvolutionRequest)({ ...set, expectedRevision: -1 }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(SkillEvolutionRequest)({
        ...set,
        modelSelection: evidence.modelSelection,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(SkillEvolutionRequest)({ ...set, automatic: true }),
    ).toThrow();
  });

  it("preserves composite Run identities through captured evidence and runtime provenance", () => {
    const rootRunId = `run:${"t".repeat(200)}:${"m".repeat(200)}`;
    expect(
      Schema.decodeUnknownSync(ExpertLearningEvidence)({ ...evidence, rootRunId }).rootRunId,
    ).toBe(rootRunId);
    const ref = {
      kind: "runtime",
      runId: rootRunId,
      eventId: "event-b",
      contentHash: `sha256:${"a".repeat(64)}`,
    };
    expect(Schema.decodeUnknownSync(LearningSourceReference)(ref)).toEqual(ref);
    expect(() =>
      Schema.decodeUnknownSync(ExpertLearningEvidence)({
        ...evidence,
        rootRunId: "x".repeat(2049),
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(LearningSourceReference)({ ...ref, runId: "x".repeat(2049) }),
    ).toThrow();
  });

  it("can return learning state alongside existing evolution response fields", () => {
    expect(
      Schema.decodeUnknownSync(SkillEvolutionResponse)({ learningState }).learningState,
    ).toEqual(learningState);
  });
});
