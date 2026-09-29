import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { ProviderSendTurnInput, ProviderSession, ProviderSessionStartInput } from "./provider";

const decodeProviderSessionStartInput = Schema.decodeUnknownSync(ProviderSessionStartInput);
const decodeProviderSendTurnInput = Schema.decodeUnknownSync(ProviderSendTurnInput);
const decodeProviderSession = Schema.decodeUnknownSync(ProviderSession);

describe("ProviderSession runtime metadata", () => {
  it("accepts trimmed component, version, and lifecycle generation values", () => {
    const parsed = decodeProviderSession({
      provider: "pi",
      status: "ready",
      runtimeMode: "full-access",
      threadId: "thread-runtime-metadata",
      createdAt: "2026-09-28T00:00:00.000Z",
      updatedAt: "2026-09-28T00:00:00.000Z",
      runtimeComponent: " pi-sdk ",
      runtimeVersion: " 0.85.1 ",
      lifecycleGeneration: " generation-1 ",
    });
    expect(parsed.runtimeComponent).toBe("pi-sdk");
    expect(parsed.runtimeVersion).toBe("0.85.1");
    expect(parsed.lifecycleGeneration).toBe("generation-1");
  });

  it("rejects blank runtime metadata", () => {
    expect(() =>
      decodeProviderSession({
        provider: "pi",
        status: "ready",
        runtimeMode: "full-access",
        threadId: "thread-runtime-metadata",
        createdAt: "2026-09-28T00:00:00.000Z",
        updatedAt: "2026-09-28T00:00:00.000Z",
        runtimeVersion: "  ",
      }),
    ).toThrow();
  });
});

describe("ProviderSessionStartInput", () => {
  it("accepts codex-compatible payloads", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "codex",
      cwd: "/tmp/workspace",
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex",
        options: {
          reasoningEffort: "high",
          fastMode: true,
        },
      },
      runtimeMode: "full-access",
      providerOptions: {
        codex: {
          binaryPath: "/usr/local/bin/codex",
          homePath: "/tmp/.codex",
        },
      },
    });
    expect(parsed.runtimeMode).toBe("full-access");
    expect(parsed.modelSelection?.provider).toBe("codex");
    expect(parsed.modelSelection?.model).toBe("gpt-5.3-codex");
    if (parsed.modelSelection?.provider !== "codex") {
      throw new Error("Expected codex modelSelection");
    }
    expect(parsed.modelSelection.options?.reasoningEffort).toBe("high");
    expect(parsed.modelSelection.options?.fastMode).toBe(true);
    expect(parsed.providerOptions?.codex?.binaryPath).toBe("/usr/local/bin/codex");
    expect(parsed.providerOptions?.codex?.homePath).toBe("/tmp/.codex");
  });

  it("accepts explicit per-thread computer control provisioning", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-computer",
      provider: "codex",
      enableComputerControl: true,
      runtimeMode: "full-access",
    });
    expect(parsed.enableComputerControl).toBe(true);
  });

  it("accepts an immutable Expert snapshot resolved for the session", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-expert",
      provider: "pi",
      expertSession: {
        snapshotId: "snapshot-1",
        persona: "Follow the expert's working principles.",
        skillsRoot: "/private/expert-snapshots/snapshot-1/skills",
        skills: [
          {
            name: "reviewer",
            path: "/private/expert-snapshots/snapshot-1/skills/reviewer/SKILL.md",
          },
        ],
        references: ["Design handbook"],
      },
      runtimeMode: "full-access",
    });
    expect(parsed.expertSession?.snapshotId).toBe("snapshot-1");
    expect(parsed.expertSession?.skills[0]?.name).toBe("reviewer");
  });

  it("rejects payloads without runtime mode", () => {
    expect(() =>
      decodeProviderSessionStartInput({
        threadId: "thread-1",
        provider: "codex",
      }),
    ).toThrow();
  });

  it("accepts claude runtime knobs", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "claudeAgent",
      cwd: "/tmp/workspace",
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        options: {
          thinking: true,
          effort: "max",
          fastMode: true,
        },
      },
      providerOptions: {
        claudeAgent: {
          binaryPath: "/usr/local/bin/claude",
          permissionMode: "plan",
          maxThinkingTokens: 12_000,
        },
      },
      runtimeMode: "full-access",
    });
    expect(parsed.provider).toBe("claudeAgent");
    expect(parsed.modelSelection?.provider).toBe("claudeAgent");
    expect(parsed.modelSelection?.model).toBe("claude-sonnet-4-6");
    if (parsed.modelSelection?.provider !== "claudeAgent") {
      throw new Error("Expected claude modelSelection");
    }
    expect(parsed.modelSelection.options?.thinking).toBe(true);
    expect(parsed.modelSelection.options?.effort).toBe("max");
    expect(parsed.modelSelection.options?.fastMode).toBe(true);
    expect(parsed.providerOptions?.claudeAgent?.binaryPath).toBe("/usr/local/bin/claude");
    expect(parsed.providerOptions?.claudeAgent?.permissionMode).toBe("plan");
    expect(parsed.providerOptions?.claudeAgent?.maxThinkingTokens).toBe(12_000);
    expect(parsed.runtimeMode).toBe("full-access");
  });
});

describe("ProviderSendTurnInput", () => {
  it("accepts codex modelSelection", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: "thread-1",
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex",
        options: {
          reasoningEffort: "xhigh",
          fastMode: true,
        },
      },
    });

    expect(parsed.modelSelection?.provider).toBe("codex");
    expect(parsed.modelSelection?.model).toBe("gpt-5.3-codex");
    if (parsed.modelSelection?.provider !== "codex") {
      throw new Error("Expected codex modelSelection");
    }
    expect(parsed.modelSelection.options?.reasoningEffort).toBe("xhigh");
    expect(parsed.modelSelection.options?.fastMode).toBe(true);
  });

  it("accepts claude modelSelection including ultrathink", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: "thread-1",
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        options: {
          effort: "ultrathink",
          fastMode: true,
        },
      },
    });

    expect(parsed.modelSelection?.provider).toBe("claudeAgent");
    if (parsed.modelSelection?.provider !== "claudeAgent") {
      throw new Error("Expected claude modelSelection");
    }
    expect(parsed.modelSelection.options?.effort).toBe("ultrathink");
    expect(parsed.modelSelection.options?.fastMode).toBe(true);
  });

  it("accepts claude modelSelection including xhigh for Opus 4.7", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: "thread-1",
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-7",
        options: {
          effort: "xhigh",
        },
      },
    });

    expect(parsed.modelSelection?.provider).toBe("claudeAgent");
    if (parsed.modelSelection?.provider !== "claudeAgent") {
      throw new Error("Expected claude modelSelection");
    }
    expect(parsed.modelSelection.options?.effort).toBe("xhigh");
  });
});
