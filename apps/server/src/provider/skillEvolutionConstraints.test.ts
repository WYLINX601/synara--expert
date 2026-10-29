import { describe, expect, it } from "vitest";
import { ThreadId, type ProviderSessionStartInput } from "@synara/contracts";
import { providerSessionStartInputForSkillEvolution } from "./skillEvolutionConstraints.ts";

describe("providerSessionStartInputForSkillEvolution", () => {
  it("clears persisted context and inherited authorization for a marked session", () => {
    const input: ProviderSessionStartInput = {
      threadId: ThreadId.makeUnsafe("skill-evolution-provider-test"),
      executionPurpose: "skill-evolution",
      runtimeMode: "full-access",
      resumeCursor: { resume: "old-provider-session" },
      forkSourceResumeCursor: { resume: "fork-source-session" },
      additionalDirectories: ["/outside/selected-workspace"],
      expertSession: {
        snapshotId: "expert-must-not-inherit",
        persona: "Must not inherit.",
        skills: [],
        references: [],
      },
      expertRuntimeNotices: ["Do not inherit."],
      contextSession: {
        snapshotId: "context-must-not-inherit",
        snapshotHash: "context-hash",
        text: "Must not inherit.",
        hasContent: true,
      },
      enableComputerControl: true,
      autoApproveSynaraTools: true,
    };

    expect(providerSessionStartInputForSkillEvolution(input)).toMatchObject({
      executionPurpose: "skill-evolution",
      runtimeMode: "full-access",
      resumeCursor: undefined,
      forkSourceResumeCursor: undefined,
      additionalDirectories: undefined,
      expertSession: undefined,
      expertRuntimeNotices: undefined,
      contextSession: undefined,
      enableComputerControl: false,
      autoApproveSynaraTools: false,
    });
  });

  it("leaves ordinary sessions untouched", () => {
    const input: ProviderSessionStartInput = {
      threadId: ThreadId.makeUnsafe("ordinary-provider-test"),
      runtimeMode: "full-access",
      resumeCursor: { resume: "ordinary-session" },
      enableComputerControl: true,
    };

    expect(providerSessionStartInputForSkillEvolution(input)).toBe(input);
  });
});
