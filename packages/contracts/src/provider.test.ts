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
});

describe("ProviderSendTurnInput", () => {
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
});
