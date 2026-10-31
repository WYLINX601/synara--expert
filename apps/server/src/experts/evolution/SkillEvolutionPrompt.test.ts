import { MessageId, ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import {
  buildSkillEvolutionDiscoveryPrompt,
  buildSkillEvolutionPrompt,
  parseSkillEvolutionDiscoveryResult,
  validateEvolutionEvidence,
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
    expect(prompt).toContain(
      "Do not call tools, execute scripts, read environment Memory or Skill files",
    );
    expect(prompt).toContain("Never invent or alter catalog IDs");
    expect(prompt).not.toContain('"files"');
    expect(prompt).not.toContain('"allowEvolution"');
    expect(prompt).not.toContain('"ownerId"');
  });

  it("offers bounded automatic Memory choices with the right categories and exclusions", () => {
    const prompt = buildSkillEvolutionDiscoveryPrompt({
      automatic: true,
      expert: { name: "Research Expert", description: "Collects verified procedures." },
      messages,
      catalog: [],
      memoryCatalog: [
        {
          memoryId: "memory-response-style",
          revision: 2,
          kind: "rule",
          key: "response.style",
          content: "Lead with the verified conclusion.",
          truncated: true,
        },
      ],
    });

    expect(prompt).toContain('"memoryId":"memory-response-style"');
    expect(prompt).toContain('"truncated":true');
    expect(prompt).toContain("Stable output preferences are rule");
    expect(prompt).toContain("supported project facts are fact");
    expect(prompt).toContain("supported environment configuration is environment");
    expect(prompt).toContain("One-off requests and task state are not Memory");
    expect(prompt).toContain("credentials, unresolved attempts, or session diaries");
    expect(prompt).not.toContain('kind:"rule|fact|environment"');
  });

  it("requires automatic Memory citations to quote selected evidence exactly", () => {
    const exact = {
      threadId: messages[0]!.threadId,
      messageId: messages[0]!.messageId,
      quote: "preserve the decision log before retrying",
    };
    expect(() => validateEvolutionEvidence([exact], messages)).not.toThrow();
    expect(() =>
      validateEvolutionEvidence(
        [{ ...exact, quote: "preserve the decision log after retrying" }],
        messages,
      ),
    ).toThrow(/证据/u);
    expect(() =>
      validateEvolutionEvidence(
        [{ ...exact, messageId: "message-other" as typeof exact.messageId }],
        messages,
      ),
    ).toThrow(/证据/u);
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
