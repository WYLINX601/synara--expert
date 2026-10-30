import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  SkillEvolutionDiscoveryResult,
  SkillEvolutionRequest,
  SkillEvolutionRun,
} from "./skillEvolution";

const skillId = `skl_${"a".repeat(32)}`;
const digest = "b".repeat(64);
const opportunity = {
  name: "Risk-based regression checks",
  reason: "The selected review identified a missing check.",
  outcomes: ["Choose checks from the changed runtime boundaries."],
  evidence: [{ threadId: "source-thread", messageId: "source-message", quote: "missing check" }],
};

describe("Expert experience discovery contracts", () => {
  it("starts from Expert work without an upfront Skill target", () => {
    const start = {
      action: "start",
      requestId: "discover",
      expertId: "expert-a",
      sources: [{ threadId: "source-thread", turnId: "source-turn" }],
      modelSelection: { provider: "pi", model: "selected-model" },
    };
    expect(Schema.decodeUnknownSync(SkillEvolutionRequest)(start)).toMatchObject({
      action: "start",
      expertId: "expert-a",
    });
    expect(() =>
      Schema.decodeUnknownSync(SkillEvolutionRequest)({ ...start, targetSkillId: skillId }),
    ).toThrow();
  });

  it.each([undefined, skillId])(
    "accepts an evidenced opportunity with target %s",
    (targetSkillId) => {
      const candidate = {
        ...opportunity,
        ...(targetSkillId ? { targetSkillId } : {}),
      };
      expect(
        Schema.decodeUnknownSync(SkillEvolutionDiscoveryResult)({
          action: "opportunities",
          opportunities: [candidate],
        }),
      ).toEqual({ action: "opportunities", opportunities: [candidate] });
    },
  );

  it.each([
    { files: [{ path: "SKILL.md", text: "Premature file" }] },
    { allowEvolution: true },
    { action: "derive" },
    { scope: { kind: "expert", expertId: "another-expert" } },
  ])("rejects file output and authority in discovery: %j", (forged) => {
    expect(() =>
      Schema.decodeUnknownSync(SkillEvolutionDiscoveryResult)({
        action: "opportunities",
        opportunities: [{ ...opportunity, ...forged }],
      }),
    ).toThrow();
  });

  it.each([{ reason: "" }, { outcomes: [] }, { outcomes: [""] }, { evidence: [] }])(
    "requires meaningful reasons, outcomes and evidence: %j",
    (invalid) => {
      expect(() =>
        Schema.decodeUnknownSync(SkillEvolutionDiscoveryResult)({
          action: "opportunities",
          opportunities: [{ ...opportunity, ...invalid }],
        }),
      ).toThrow();
    },
  );

  it("generates from an exact opportunity and feedback without a model override", () => {
    const generate = {
      action: "generate",
      requestId: "generation",
      discoveryRequestId: "discover",
      opportunityId: "opportunity-a",
      expectedDigest: digest,
      feedback: "Keep it portable.",
    };
    expect(Schema.decodeUnknownSync(SkillEvolutionRequest)(generate)).toEqual(generate);
    expect(() =>
      Schema.decodeUnknownSync(SkillEvolutionRequest)({
        ...generate,
        modelSelection: { provider: "pi", model: "different-model" },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(SkillEvolutionRequest)({ ...generate, expectedDigest: "wrong" }),
    ).toThrow();
  });

  it("dismisses an exact opportunity without exposing a Skill write", () => {
    const dismiss = {
      action: "dismissOpportunity",
      requestId: "discover",
      opportunityId: "opportunity-a",
      expectedDigest: digest,
    };
    expect(Schema.decodeUnknownSync(SkillEvolutionRequest)(dismiss)).toEqual(dismiss);
    expect(() =>
      Schema.decodeUnknownSync(SkillEvolutionRequest)({ ...dismiss, changes: [] }),
    ).toThrow();
  });

  it("reads historical file-generation records without rewriting them into discovery", () => {
    const historical = {
      requestId: "historical",
      expertId: "expert-a",
      createdAt: "2026-10-29T00:00:00.000Z",
      updatedAt: "2026-10-29T00:00:00.000Z",
      modelSelection: { provider: "pi", model: "selected-model" },
      sourceCount: 1,
      status: "proposal_ready",
      proposals: [],
    };
    expect(Schema.decodeUnknownSync(SkillEvolutionRun)(historical)).not.toHaveProperty("stage");
  });

  it("accepts learning provenance on automatic evolution runs", () => {
    const run = {
      requestId: "automatic-run",
      expertId: "expert-a",
      origin: "automatic",
      cycleId: "cycle-a",
      learningEpoch: 2,
      createdAt: "2026-10-31T00:00:00.000Z",
      updatedAt: "2026-10-31T00:00:00.000Z",
      modelSelection: { provider: "pi", model: "configured-model" },
      sourceCount: 1,
      status: "queued",
      proposals: [],
    };
    expect(Schema.decodeUnknownSync(SkillEvolutionRun)(run)).toMatchObject({
      origin: "automatic",
      cycleId: "cycle-a",
      learningEpoch: 2,
    });
    expect(() =>
      Schema.decodeUnknownSync(SkillEvolutionRun)({ ...run, learningEpoch: -1 }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(SkillEvolutionRun)({ ...run, origin: "system" }),
    ).toThrow();
  });
});
