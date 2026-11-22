import type { ExpertLearningEvidence, ExpertLearningEvidenceItem } from "@synara/contracts";

/** Minimum zero-token score before an automatic learning cycle may call a model. */
export const EVOLUTION_SIGNAL_THRESHOLD = 3;

export type EvolutionSignalReason =
  | "user_correction"
  | "tool_failure_then_success"
  | "turn_interrupted"
  | "multiple_user_messages";

export interface EvolutionSignal {
  readonly score: number;
  readonly reasons: ReadonlyArray<EvolutionSignalReason>;
  readonly thresholdMet: boolean;
}

/** Bounded correction cues; never persist the matched text, only the reason code. */
const USER_CORRECTION =
  /(不对|错了|不是这样|不是这个|纠正|改成|重新做|重来|别用|不要用|停止用|有问题|刚才的|previous answer|that'?s (wrong|incorrect|not right)|not what i|please (fix|redo|change)|should have|do not use|don't use|instead of|start over|try again)/iu;

function toolOutcome(
  item: ExpertLearningEvidenceItem,
): { readonly tool: string; readonly failed: boolean } | null {
  if (item.kind !== "tool_result") return null;
  const lines = item.text.split(/\r?\n/u);
  const tool = lines[0]?.replace(/\.$/u, "").trim();
  const status = lines
    .find((line) => line.startsWith("Status: "))
    ?.slice("Status: ".length)
    .replace(/\.$/u, "");
  if (!tool || !status) return null;
  return { tool, failed: status === "failed" || status === "declined" };
}

/**
 * Zero-token pre-gate for automatic learning. A low score keeps the evidence
 * for manual extraction but avoids discovery/generation model calls.
 */
export function evaluateEvolutionSignal(evidence: ExpertLearningEvidence): EvolutionSignal {
  let score = 0;
  const reasons = new Set<EvolutionSignalReason>();
  const userMessages = evidence.items.filter(
    (item) => item.kind === "message" && item.role === "user",
  );
  if (userMessages.some((item) => USER_CORRECTION.test(item.text))) {
    score += 3;
    reasons.add("user_correction");
  }
  if (userMessages.length > 1) {
    score += 2;
    reasons.add("multiple_user_messages");
  }
  const failedTools = new Set<string>();
  const repairedTools = new Set<string>();
  for (const item of evidence.items) {
    const outcome = toolOutcome(item);
    if (!outcome) continue;
    if (outcome.failed) {
      failedTools.add(outcome.tool);
    } else if (failedTools.has(outcome.tool) && !repairedTools.has(outcome.tool)) {
      repairedTools.add(outcome.tool);
      score += 2;
      reasons.add("tool_failure_then_success");
    }
  }
  if (
    evidence.items.some(
      (item) =>
        item.kind === "activity" &&
        (item.text.startsWith("Turn aborted:") ||
          /^Turn ended as (?:failed|aborted|cancelled)\b/u.test(item.text) ||
          item.text.startsWith("Runtime error:")),
    )
  ) {
    score += 2;
    reasons.add("turn_interrupted");
  }
  return {
    score,
    reasons: [...reasons].slice(0, 8),
    thresholdMet: score >= EVOLUTION_SIGNAL_THRESHOLD,
  };
}
