import { describe, expect, it } from "vitest";
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
});
