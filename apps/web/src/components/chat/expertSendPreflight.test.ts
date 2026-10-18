import type { ExpertPreview, ExpertPreviewInput, ProviderKind } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";
import { expertSendBlockReason } from "./expertSendPreflight";

const availablePreview: ExpertPreview = {
  definition: {
    id: "planner",
    name: "规划专家",
    description: "帮助规划任务",
    useCases: "方案梳理",
    persona: "先澄清目标",
    outputRequirements: "给出步骤和依据",
    skills: [],
    references: [],
    connections: [],
    preferredProvider: "codex",
    revision: 7,
    archived: false,
    updatedAt: "2026-10-03T00:00:00.000Z",
  },
  status: "available",
  issues: [],
};

describe("expertSendBlockReason", () => {
  it("preflights all supported providers with the selected instance and cwd", async () => {
    for (const provider of ["codex", "pi", "claudeAgent", "omp"] as const) {
      const previewExpert = vi.fn(async (_input: ExpertPreviewInput) => availablePreview);

      await expect(
        expertSendBlockReason(
          previewExpert,
          "planner",
          provider as ProviderKind,
          "provider-work" as never,
          "/workspace/project",
        ),
      ).resolves.toBeNull();
      expect(previewExpert).toHaveBeenCalledWith({
        expertId: "planner",
        provider,
        providerInstanceId: "provider-work",
        cwd: "/workspace/project",
      });
    }
  });

  it("blocks unsupported providers before making a preview request", async () => {
    const previewExpert = vi.fn(async (_input: ExpertPreviewInput) => availablePreview);

    await expect(expertSendBlockReason(previewExpert, "planner", "cursor")).resolves.toContain(
      "当前 Provider 不支持所选专家",
    );
    expect(previewExpert).not.toHaveBeenCalled();
  });

  it("keeps provider preview issues as the send block reason", async () => {
    const previewExpert = vi.fn(async (_input: ExpertPreviewInput) => ({
      ...availablePreview,
      status: "blocked" as const,
      issues: ["缺少运行环境"],
    }));

    await expect(expertSendBlockReason(previewExpert, "planner", "claudeAgent")).resolves.toBe(
      "所选专家当前无法使用：缺少运行环境",
    );
  });
});
