import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderSteerSubagentInput,
} from "./provider";

const decodeProviderSessionStartInput = Schema.decodeUnknownSync(ProviderSessionStartInput);
const decodeProviderSendTurnInput = Schema.decodeUnknownSync(ProviderSendTurnInput);
const decodeProviderSteerSubagentInput = Schema.decodeUnknownSync(ProviderSteerSubagentInput);
const decodeProviderSession = Schema.decodeUnknownSync(ProviderSession);

const ambientContext = {
  schemaVersion: 1,
  id: "snapshot-provider-test",
  capturedAt: "2026-10-09T00:00:00.000Z",
  items: [
    {
      observation: {
        schemaVersion: 1,
        id: "observation-provider-test",
        targetKey: "target-provider-test",
        capturedAt: "2026-10-09T00:00:00.000Z",
        method: "selection event",
        confidence: "exact",
        type: "selection.text",
        value: { text: "Selected text" },
      },
      provenance: [
        {
          sourceId: "source-provider-test",
          observationId: "observation-provider-test",
          capturedAt: "2026-10-09T00:00:00.000Z",
          method: "selection event",
          confidence: "exact",
        },
      ],
      ambiguous: false,
    },
  ],
};

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
      input: "Review this",
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

  it("allows non-empty ambient context as sendable input but rejects an empty snapshot alone", () => {
    const base = {
      schemaVersion: 1 as const,
      id: "snapshot-empty",
      capturedAt: ambientContext.capturedAt,
      items: [],
    };
    expect(() =>
      decodeProviderSendTurnInput({
        threadId: "thread-ambient-context-only",
        attachments: [],
        ambientContext: base,
      }),
    ).toThrow();
    expect(() =>
      decodeProviderSteerSubagentInput({
        threadId: "thread-ambient-subagent-empty",
        providerThreadId: "tool-1",
        attachments: [],
        ambientContext: base,
      }),
    ).toThrow();

    expect(
      decodeProviderSendTurnInput({
        threadId: "thread-ambient-context-only",
        attachments: [],
        ambientContext,
      }).ambientContext,
    ).toEqual(ambientContext);
    expect(
      decodeProviderSteerSubagentInput({
        threadId: "thread-ambient-subagent-only",
        providerThreadId: "tool-1",
        attachments: [],
        ambientContext,
      }).ambientContext,
    ).toEqual(ambientContext);
  });
});
