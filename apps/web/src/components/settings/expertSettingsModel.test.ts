import { describe, expect, it } from "vitest";
import type { ExpertDefinition } from "@synara/contracts";
import {
  expertDraftFromDefinition,
  expertDraftsEqual,
  expertSaveInputForDraft,
  parseExpertReferences,
  validateExpertDraft,
} from "./expertSettingsModel";

const definition = {
  id: "planner",
  name: "规划专家",
  description: "帮助规划",
  useCases: "",
  persona: "先澄清目标",
  outputRequirements: "",
  skills: [],
  references: [],
  connections: [],
  preferredProvider: "codex" as const,
  revision: 7,
  archived: false,
  updatedAt: "2026-10-03T00:00:00.000Z",
};

describe("expertSettingsModel", () => {
  it("keeps persisted identity out of editable drafts and adds an optimistic revision only when saving", () => {
    const draft = { ...expertDraftFromDefinition(definition), name: "  规划专家新名  " };
    expect(draft).not.toHaveProperty("id");
    expect(draft).not.toHaveProperty("expectedRevision");

    const input = expertSaveInputForDraft(draft, definition);
    expect(input).toMatchObject({ id: "planner", expectedRevision: 7, name: "规划专家新名" });
  });

  it("reports name errors as structured client issues and merges equivalent reference paths", () => {
    const issues = validateExpertDraft(expertDraftFromDefinition());
    expect(issues).toContainEqual({
      field: "name",
      code: "required",
      message: "请填写专家名称。",
    });

    expect(
      parseExpertReferences("C:\\workspace\\guide.md\nC:/workspace/guide.md\n./notes.md"),
    ).toEqual({
      references: ["C:\\workspace\\guide.md", "./notes.md"],
      duplicateCount: 1,
    });
    expect(parseExpertReferences("/research/notes/../brief.md\n/research/brief.md")).toEqual({
      references: ["/research/notes/../brief.md"],
      duplicateCount: 1,
    });
  });

  it("compares draft fields without persisted revision metadata", () => {
    const draft = expertDraftFromDefinition(definition);
    expect(expertDraftsEqual(draft, expertDraftFromDefinition(definition))).toBe(true);
    expect(expertDraftsEqual(draft, { ...draft, name: "另一个名称" })).toBe(false);
  });

  it("requires at least one nonblank tool for enabled MCP authorizations", () => {
    const draft = expertDraftFromDefinition(definition);

    expect(
      validateExpertDraft({
        ...draft,
        connections: [{ id: "docs", required: false, enabled: true, tools: [] }],
      }),
    ).toContainEqual({
      field: "connections",
      code: "invalid",
      message: "启用的 MCP 连接至少需要选择一个工具。",
      index: 0,
    });
    expect(
      validateExpertDraft({
        ...draft,
        connections: [{ id: "docs", required: false, tools: ["  "] }],
      }).some((issue) => issue.field === "connections" && issue.code === "invalid"),
    ).toBe(true);
  });

  it("allows disabled MCP authorizations to retain an empty tool allowlist", () => {
    const draft = expertDraftFromDefinition(definition);

    expect(
      validateExpertDraft({
        ...draft,
        connections: [{ id: "docs", required: false, enabled: false, tools: [] }],
      }).filter((issue) => issue.field === "connections"),
    ).toEqual([]);
    expect(
      validateExpertDraft({
        ...draft,
        connections: [{ id: "docs", required: false, enabled: true, tools: [" lookup "] }],
      }).filter((issue) => issue.field === "connections"),
    ).toEqual([]);
  });

  it("allows all-tool authorizations without a saved tool whitelist", () => {
    const draft = expertDraftFromDefinition(definition);

    expect(
      validateExpertDraft({
        ...draft,
        connections: [{ id: "docs", required: false, enabled: true, toolMode: "all", tools: [] }],
      }).filter((issue) => issue.field === "connections"),
    ).toEqual([]);
  });

  it("preserves explicit authorization mode while saving a draft", () => {
    const draft = {
      ...expertDraftFromDefinition(definition),
      connections: [
        { id: "all-tools", required: false, enabled: true, toolMode: "all" as const, tools: [] },
        { id: "selected-tools", required: false, toolMode: "selected" as const, tools: ["search"] },
        { id: "legacy", required: false, tools: ["read"] },
      ],
    };

    expect(expertSaveInputForDraft(draft).connections).toEqual(draft.connections);
    expect(
      expertDraftsEqual(draft, {
        ...draft,
        connections: draft.connections.map((connection) =>
          connection.id === "legacy"
            ? { ...connection, toolMode: "all" as const, tools: [] }
            : connection,
        ),
      }),
    ).toBe(false);
  });

  it("uses an empty current binding list and serializes no legacy Skill configuration", () => {
    const legacy = {
      ...definition,
      skills: [{ name: "old skill", path: "/skills/old/SKILL.md" }],
      skillSelections: [
        {
          packageId: `pkg_${"a".repeat(64)}`,
          entryPath: "skills/old/SKILL.md",
          activation: "startup" as const,
        },
      ],
    };
    const draft = expertDraftFromDefinition(legacy);
    expect(draft.skills).toEqual([]);
    expect(draft.skillBindings).toEqual([]);
    expect(draft).not.toHaveProperty("skillSelections");
    expect(expertSaveInputForDraft(draft, legacy)).toMatchObject({
      skills: [],
      skillBindings: [],
      id: legacy.id,
      expectedRevision: legacy.revision,
    });
    expect(expertSaveInputForDraft(draft, legacy)).not.toHaveProperty("skillSelections");
  });

  it("preserves current binding fields and omits historical activation from new saves", () => {
    const expert = {
      ...definition,
      skillBindings: [
        {
          skillId: `skl_${"a".repeat(32)}`,
          enabled: true,
          allowEvolution: true,
          selectionScope: "package" as const,
          resourceMode: "run-private" as const,
          activation: "startup" as const,
        },
      ],
    } as unknown as ExpertDefinition;
    const draft = expertDraftFromDefinition(expert),
      saved = expertSaveInputForDraft(draft, expert);

    expect(expertDraftFromDefinition(expert).skillBindings).toEqual([
      {
        skillId: `skl_${"a".repeat(32)}`,
        enabled: true,
        allowEvolution: true,
        selectionScope: "package",
        resourceMode: "run-private",
      },
    ]);
    expect(expertDraftsEqual(draft, { ...draft, skillBindings: [] })).toBe(false);
    expect(saved).toMatchObject({
      skills: [],
      skillBindings: [
        {
          skillId: `skl_${"a".repeat(32)}`,
          enabled: true,
          allowEvolution: true,
          selectionScope: "package",
          resourceMode: "run-private",
        },
      ],
      id: expert.id,
      expectedRevision: expert.revision,
    });
    expect(saved.skillBindings?.[0]).not.toHaveProperty("activation");
    expect(saved).not.toHaveProperty("skillSelections");
  });

  it("defaults missing evolution permission to off and preserves it with other binding fields in drafts", () => {
    const skillId = `skl_${"d".repeat(32)}`;
    const withoutPermission = expertDraftFromDefinition({
      ...definition,
      skillBindings: [{ skillId, enabled: true }],
    } as ExpertDefinition);
    expect(withoutPermission.skillBindings?.[0]?.allowEvolution).toBeUndefined();
    expect(withoutPermission.skillBindings?.[0]?.allowEvolution === true).toBe(false);

    const withPermission = {
      ...definition,
      skillBindings: [
        {
          skillId,
          enabled: false,
          allowEvolution: true,
          selectionScope: "package" as const,
          resourceMode: "run-private" as const,
        },
      ],
    } as ExpertDefinition;
    const draft = expertDraftFromDefinition(withPermission);
    const toggledDraft = {
      ...draft,
      skillBindings: draft.skillBindings?.map((binding) => ({
        ...binding,
        allowEvolution: false,
      })),
    };
    expect(expertDraftsEqual(draft, toggledDraft)).toBe(false);
    expect(expertSaveInputForDraft(toggledDraft, withPermission).skillBindings).toEqual([
      {
        skillId,
        enabled: false,
        allowEvolution: false,
        selectionScope: "package",
        resourceMode: "run-private",
      },
    ]);
  });

  it("validates current Skill binding identities without imposing an activation limit", () => {
    const draft = expertDraftFromDefinition(definition),
      skillId = `skl_${"b".repeat(32)}`;
    const duplicateIssues = validateExpertDraft({
      ...draft,
      skillBindings: [
        { skillId, enabled: true },
        { skillId, enabled: false },
      ],
    });
    expect(duplicateIssues).toContainEqual({
      field: "skillBindings",
      code: "invalid",
      message: "技能绑定须唯一，最多100个。",
    });
    expect(
      validateExpertDraft({
        ...draft,
        skillBindings: [
          { skillId, enabled: true },
          { skillId: `skl_${"c".repeat(32)}`, enabled: true },
        ],
      }).filter((issue) => issue.field === "skillBindings"),
    ).toEqual([]);
  });
});
