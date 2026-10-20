import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  EXPERT_PROVIDER_KINDS,
  ExpertAppliedRuntimeRecord,
  ExpertPreviewInput,
  ExpertSaveInput,
  ExpertSnapshot,
} from "./expert";

function definition(connections: unknown[]) {
  return {
    name: "Contract test",
    description: "",
    useCases: "",
    persona: "",
    outputRequirements: "",
    skills: [],
    references: [],
    connections,
  };
}

describe("Expert connection tool modes", () => {
  it("accepts all mode with an empty legacy tools list", () => {
    const decoded = Schema.decodeUnknownSync(ExpertSaveInput)(
      definition([{ id: "mcp", required: false, tools: [], toolMode: "all" }]),
    );

    expect(decoded.connections).toEqual([
      { id: "mcp", required: false, tools: [], toolMode: "all" },
    ]);
  });

  it("keeps a missing mode absent so callers can apply the legacy selected default", () => {
    const decoded = Schema.decodeUnknownSync(ExpertSaveInput)(
      definition([{ id: "mcp", required: false, tools: ["search"] }]),
    );

    expect(decoded.connections).toEqual([{ id: "mcp", required: false, tools: ["search"] }]);
  });
});

describe("Expert skill package selections", () => {
  it("keeps package selections optional for legacy definitions", () => {
    expect(
      Schema.decodeUnknownSync(ExpertSaveInput)(definition([])).skillSelections,
    ).toBeUndefined();
  });

  it("accepts pinned package selections and hydrated snapshot entries", () => {
    const selection = {
      packageId: `pkg_${"a".repeat(64)}`,
      entryPath: "writer/SKILL.md",
      activation: "startup" as const,
    };
    const decoded = Schema.decodeUnknownSync(ExpertSaveInput)({
      ...definition([]),
      skillSelections: [selection],
    });
    expect(decoded.skillSelections).toEqual([selection]);

    const snapshot = Schema.decodeUnknownSync(ExpertSnapshot)({
      snapshotId: `exp_${"b".repeat(64)}`,
      schemaVersion: 2,
      expertId: "writer",
      displayName: "Writer",
      revision: 1,
      description: "",
      useCases: "",
      persona: "",
      outputRequirements: "",
      skills: [
        { name: "Writer", path: "/state/experts/skill-packages/pkg/content/writer/SKILL.md" },
      ],
      skillSelections: [selection],
      skillEntries: [
        {
          ...selection,
          name: "Writer",
          description: "Writes useful documents.",
          path: "/state/experts/skill-packages/pkg/content/writer/SKILL.md",
        },
      ],
      skillsRoot: "skills",
      references: [],
      connections: [],
      createdAt: "2026-10-20T00:00:00.000Z",
    });
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.skillEntries?.[0]).toMatchObject({ ...selection, name: "Writer" });
  });

  it("rejects malformed package IDs and entry paths", () => {
    expect(() =>
      Schema.decodeUnknownSync(ExpertSaveInput)({
        ...definition([]),
        skillSelections: [
          { packageId: "pkg_latest", entryPath: "../SKILL.md", activation: "startup" },
        ],
      }),
    ).toThrow();
  });

  it("allows runtime records to carry optional skill catalog application evidence", () => {
    const base = {
      threadId: "thread-1",
      snapshotId: `exp_${"b".repeat(64)}`,
      provider: "codex" as const,
      lifecycleGeneration: "generation-1",
      appliedAt: "2026-10-20T00:00:00.000Z",
    };
    expect(Schema.decodeUnknownSync(ExpertAppliedRuntimeRecord)(base).skillApplication).toBe(
      undefined,
    );
    expect(
      Schema.decodeUnknownSync(ExpertAppliedRuntimeRecord)({
        ...base,
        skillApplication: {
          mode: "catalog",
          snapshotId: base.snapshotId,
          packageIds: [`pkg_${"a".repeat(64)}`],
          catalogHash: "c".repeat(64),
          instructionsHash: "d".repeat(64),
          startupEntryIds: ["writer/SKILL.md"],
          lifecycleGeneration: base.lifecycleGeneration,
        },
      }).skillApplication?.mode,
    ).toBe("catalog");
  });
});

describe("Expert provider compatibility", () => {
  it.each(EXPERT_PROVIDER_KINDS)(
    "accepts %s preferences and instance-scoped preview",
    (provider) => {
      expect(
        Schema.decodeUnknownSync(ExpertSaveInput)({
          ...definition([]),
          preferredProvider: provider,
        }).preferredProvider,
      ).toBe(provider);
      expect(
        Schema.decodeUnknownSync(ExpertPreviewInput)({
          expertId: "reviewer",
          provider,
          providerInstanceId: `${provider}-work`,
          cwd: "/workspace",
        }),
      ).toMatchObject({ provider, providerInstanceId: `${provider}-work` });
    },
  );
  it("does not enable unrelated providers through Expert contracts", () => {
    expect(() =>
      Schema.decodeUnknownSync(ExpertPreviewInput)({ expertId: "reviewer", provider: "opencode" }),
    ).toThrow();
  });
});
