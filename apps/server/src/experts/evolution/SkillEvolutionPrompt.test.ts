import { MessageId, ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import {
  buildSkillEvolutionDiscoveryPrompt,
  buildSkillEvolutionPrompt,
  parseSkillEvolutionDiscoveryResult,
  type EvolutionSourceMessage,
} from "./SkillEvolutionPrompt";

const messages: readonly EvolutionSourceMessage[] = [
  {
    threadId: ThreadId.makeUnsafe("thread-prompt-test"),
    messageId: MessageId.makeUnsafe("message-prompt-test"),
    role: "assistant",
    text: "Verified evidence: preserve the decision log before retrying.",
  },
];
const catalogSkillId = `skl_${"a".repeat(32)}`;

describe("SkillEvolutionPrompt stages", () => {
  it("builds discovery from source messages and bound catalog metadata only", () => {
    const prompt = buildSkillEvolutionDiscoveryPrompt({
      expert: { name: "Research Expert", description: "Collects verified procedures." },
      focus: "Retry safety",
      messages,
      catalog: [
        {
          skillId: catalogSkillId,
          name: "Recovery Workflow",
          description: "Verified recovery procedures.",
          tags: ["recovery"],
        },
      ],
    });

    expect(prompt).toContain("Verified evidence: preserve the decision log before retrying.");
    expect(prompt).toContain(catalogSkillId);
    expect(prompt).toContain("Do not call tools, execute scripts, create memory, read Skill files");
    expect(prompt).toContain("Never invent or alter catalog IDs");
    expect(prompt).not.toContain('"files"');
    expect(prompt).not.toContain('"allowEvolution"');
    expect(prompt).not.toContain('"ownerId"');
  });

  it("accepts normal discovery outcomes and rejects file, ownership, and permission fields", () => {
    expect(
      parseSkillEvolutionDiscoveryResult(
        JSON.stringify({ action: "no_change", reason: "No reusable method was found." }),
      ),
    ).toMatchObject({ action: "no_change" });
    expect(
      parseSkillEvolutionDiscoveryResult(
        JSON.stringify({ action: "insufficient_evidence", reason: "Need a verified outcome." }),
      ),
    ).toMatchObject({ action: "insufficient_evidence" });
    const validOpportunity = {
      name: "Decision log recovery",
      reason: "The source gives a reusable recovery procedure.",
      outcomes: ["Preserve evidence before retrying."],
      evidence: [
        {
          threadId: messages[0]!.threadId,
          messageId: messages[0]!.messageId,
          quote: "Verified evidence: preserve the decision log before retrying.",
        },
      ],
      targetSkillId: catalogSkillId,
    };
    expect(
      parseSkillEvolutionDiscoveryResult(
        JSON.stringify({ action: "opportunities", opportunities: [validOpportunity] }),
      ),
    ).toMatchObject({ action: "opportunities" });

    for (const forbidden of [
      { files: [{ path: "SKILL.md", text: "write this" }] },
      { ownerId: "forged-owner" },
      { scope: { kind: "shared" } },
      { allowEvolution: true },
    ]) {
      expect(() =>
        parseSkillEvolutionDiscoveryResult(
          JSON.stringify({
            action: "opportunities",
            opportunities: [{ ...validOpportunity, ...forbidden }],
          }),
        ),
      ).toThrow();
    }
  });

  it("passes only the selected opportunity and user feedback into generation", () => {
    const prompt = buildSkillEvolutionPrompt({
      expert: { name: "Research Expert", description: "Collects verified procedures." },
      opportunity: {
        name: "Decision log recovery",
        reason: "Preserve evidence before retrying.",
        outcomes: ["Keep the decision log intact."],
        evidence: [
          {
            threadId: messages[0]!.threadId,
            messageId: messages[0]!.messageId,
            quote: "Verified evidence: preserve the decision log before retrying.",
          },
        ],
      },
      feedback: "Keep the source quote and add the recovery check.",
      messages,
      target: {
        name: "Recovery Workflow",
        entryPath: "SKILL.md",
        files: [{ path: "SKILL.md", text: "Current verified workflow." }],
      },
    });

    expect(prompt).toContain("Decision log recovery");
    expect(prompt).toContain("Keep the source quote and add the recovery check.");
    expect(prompt).toContain("Verified evidence: preserve the decision log before retrying.");
    expect(prompt).toContain("Current verified workflow.");
    expect(prompt).toContain("without expanding its scope");
  });
});
