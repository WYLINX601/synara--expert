import type { ExpertLearningEvidence, ExpertLearningEvidenceItem } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { evaluateEvolutionSignal, EVOLUTION_SIGNAL_THRESHOLD } from "./EvolutionSignalGate";

function evidence(items: ExpertLearningEvidenceItem[]): ExpertLearningEvidence {
  return {
    evidenceId: "evidence-1",
    ownerId: "owner",
    expertId: "expert",
    threadId: "thread",
    turnId: "turn",
    snapshotId: "snapshot",
    projectId: "project",
    modelSelection: { provider: "pi", model: "fixture" },
    items,
    coverage: [],
    updatedAt: "2026-11-20T00:00:00.000Z",
  };
}

const user = (text: string, id = "user"): ExpertLearningEvidenceItem => ({
  id,
  kind: "message",
  role: "user",
  text,
});

describe("evaluateEvolutionSignal", () => {
  it("leaves ordinary completed work below the threshold", () => {
    const signal = evaluateEvolutionSignal(
      evidence([user("Summarize the release notes and list open issues.")]),
    );
    expect(signal).toEqual({ score: 0, reasons: [], thresholdMet: false });
  });

  it("passes a correction without retaining the message body", () => {
    const signal = evaluateEvolutionSignal(
      evidence([user("That's not what I asked. Correct the plan.")]),
    );
    expect(signal).toEqual({
      score: 3,
      reasons: ["user_correction"],
      thresholdMet: true,
    });
    expect(JSON.stringify(signal)).not.toContain("Correct the plan");
    expect(signal.score).toBeGreaterThanOrEqual(EVOLUTION_SIGNAL_THRESHOLD);
  });

  it("passes when the same tool fails and then succeeds", () => {
    const signal = evaluateEvolutionSignal(
      evidence([
        user("Run the tests."),
        { id: "call", kind: "tool_call", text: "Started Shell.", toolCallId: "tool-1" },
        {
          id: "failed",
          kind: "tool_result",
          text: "Shell.\nStatus: failed.\nexit 1",
          toolCallId: "tool-1",
        },
        { id: "retry", kind: "tool_call", text: "Started Shell.", toolCallId: "tool-2" },
        {
          id: "passed",
          kind: "tool_result",
          text: "Shell.\nStatus: completed.\nok",
          toolCallId: "tool-2",
        },
      ]),
    );
    expect(signal).toEqual({
      score: 2,
      reasons: ["tool_failure_then_success"],
      thresholdMet: false,
    });
  });

  it("combines interruption and repeated user input", () => {
    const signal = evaluateEvolutionSignal(
      evidence([
        user("First attempt.", "user-1"),
        user("Second attempt.", "user-2"),
        { id: "abort", kind: "activity", text: "Turn aborted: user interrupt." },
      ]),
    );
    expect(signal.score).toBe(4);
    expect(signal.reasons).toEqual(["multiple_user_messages", "turn_interrupted"]);
    expect(signal.thresholdMet).toBe(true);
  });
});
