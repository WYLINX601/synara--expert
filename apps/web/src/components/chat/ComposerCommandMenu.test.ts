import { describe, expect, it } from "vitest";
import { groupCommandItems, type ComposerCommandItem } from "./ComposerCommandMenu";

describe("groupCommandItems", () => {
  it("groups mention suggestions as plugins, chats, local, then subagents", () => {
    const items: ComposerCommandItem[] = [
      {
        id: "agent:codex:mini",
        type: "agent",
        provider: "codex",
        alias: "mini",
        color: "violet",
        label: "@mini",
        description: "GPT-5.4 Mini",
      },
      {
        id: "path:file:/workspace/AGENTS.md",
        type: "path",
        path: "/workspace/AGENTS.md",
        pathKind: "file",
        label: "AGENTS.md",
        description: "/workspace",
      },
      {
        id: "plugin:github",
        type: "plugin",
        plugin: {
          id: "plugin/github",
          name: "GitHub",
          source: {
            type: "local",
            path: "/test/plugins/github",
          },
          interface: {
            displayName: "GitHub",
            shortDescription: "Triage PRs and CI",
          },
          installed: true,
          enabled: true,
          installPolicy: "AVAILABLE",
          authPolicy: "ON_USE",
        },
        mention: {
          name: "GitHub",
          path: "plugin://GitHub@codex",
        },
        label: "GitHub",
        description: "Triage PRs and CI",
      },
      {
        id: "local-root",
        type: "local-root",
        label: "@local",
        description: "Browse folders on this computer",
      },
      {
        id: "thread:thread-1",
        type: "thread",
        threadId: "thread-1",
        provider: "codex",
        mention: { name: "Release prep", path: "thread://thread-1" },
        label: "Release prep",
        description: "Synara",
      },
    ];

    expect(groupCommandItems(items, "mention", true)).toEqual([
      {
        id: "plugins",
        label: "Plugins",
        items: [items[2]],
      },
      {
        id: "chats",
        label: "Chats",
        items: [items[4]],
      },
      {
        id: "local",
        label: "Local",
        items: [items[1], items[3]],
      },
      {
        id: "subagents",
        label: "Subagents",
        items: [items[0]],
      },
    ]);
  });
});

describe("Hub deliverable groups", () => {
  it("keeps every key deliverable under one heading while preserving source order", () => {
    const items: Extract<ComposerCommandItem, { type: "hub-deliverable" }>[] = [
      {
        id: "artifact:one",
        type: "hub-deliverable",
        label: "brief.md",
        mention: { name: "brief.md", path: "synara://hub/a/deliverables/one/brief.md?revision=2" },
        expertDisplayName: "Design snapshot",
        description: "",
        disabled: false,
      },
      {
        id: "artifact:two",
        type: "hub-deliverable",
        label: "brief.md",
        mention: { name: "brief.md", path: "synara://hub/a/deliverables/two/brief.md?revision=4" },
        expertDisplayName: "Research snapshot",
        description: "",
        disabled: true,
      },
    ];

    expect(groupCommandItems(items, "mention", true)).toEqual([
      { id: "deliverables", label: "关键产物", items },
    ]);
    expect(items.map((item) => item.mention.path)).toEqual([
      "synara://hub/a/deliverables/one/brief.md?revision=2",
      "synara://hub/a/deliverables/two/brief.md?revision=4",
    ]);
    expect(items[1]?.disabled).toBe(true);
  });
});

describe("groupCommandItems connectors", () => {
  it("puts connectors in their own first group", () => {
    const items: ComposerCommandItem[] = [
      {
        id: "path:file:/workspace/AGENTS.md",
        type: "path",
        path: "/workspace/AGENTS.md",
        pathKind: "file",
        label: "AGENTS.md",
        description: "/workspace",
      },
      {
        id: "connector:mcp_conn_1",
        type: "connector",
        connectorName: "Supabase",
        mention: { name: "Supabase", path: "connector://supabase_connector" },
        label: "Supabase",
        description: "mcp.supabase.com",
      },
    ];

    expect(
      groupCommandItems(items, "mention", false).map((group) => [
        group.label,
        group.items.map((item) => item.id),
      ]),
    ).toEqual([
      ["Connectors", ["connector:mcp_conn_1"]],
      ["Local", ["path:file:/workspace/AGENTS.md"]],
    ]);
  });
});
