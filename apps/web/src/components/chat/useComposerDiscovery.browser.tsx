import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ExpertBinding,
  ExpertPreview,
  ExpertSnapshot,
  ProviderComposerCapabilities,
  ProviderInstanceId,
  ProviderSkillDescriptor,
} from "@synara/contracts";
import { ThreadId } from "@synara/contracts";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

const harness = vi.hoisted(() => {
  const provider = {
    getComposerCapabilities: vi.fn(),
    listCommands: vi.fn(),
    listSkills: vi.fn(),
    listPlugins: vi.fn(),
  };
  return {
    provider,
    nativeApi: { provider },
    readExpertSnapshot: vi.fn(),
  };
});

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => harness.nativeApi,
  readNativeApi: () => harness.nativeApi,
}));
vi.mock("~/workbench/host/expertClient", () => ({
  ensureExpertClient: () => ({ readExpertSnapshot: harness.readExpertSnapshot }),
}));

import { useComposerDiscovery } from "./useComposerDiscovery";

const CAPABILITIES: ProviderComposerCapabilities = {
  provider: "codex",
  supportsSkillMentions: true,
  supportsSkillDiscovery: true,
  supportsNativeSlashCommandDiscovery: true,
  supportsPluginMentions: false,
  supportsPluginDiscovery: false,
  supportsRuntimeModelList: false,
  supportsThreadCompaction: false,
  supportsThreadImport: false,
};

type DiscoveryInput = Parameters<typeof useComposerDiscovery>[0];

function skill(name: string, path: string, enabled = true): ProviderSkillDescriptor {
  return { name, path, enabled };
}

function snapshot(
  snapshotId: string,
  skills: Array<{ name: string; path: string }>,
): ExpertSnapshot {
  return {
    snapshotId,
    expertId: "expert-old",
    displayName: "Old Research Expert",
    revision: 4,
    description: "Pinned snapshot contents",
    useCases: "",
    persona: "",
    outputRequirements: "",
    skills,
    skillsRoot: `/snapshots/${snapshotId}/skills`,
    references: [],
    connections: [],
    createdAt: "2026-10-01T00:00:00.000Z",
  };
}

function binding(snapshotId: string): ExpertBinding {
  return {
    expertId: "expert-current-template",
    snapshotId,
    displayName: "Current Template Name",
    revision: 99,
  };
}

function expertPreview(skills: Array<{ name: string; path: string }>): ExpertPreview {
  return {
    definition: {
      id: "draft-expert",
      name: "Draft Expert",
      description: "Draft preview fixture",
      useCases: "",
      persona: "",
      outputRequirements: "",
      skills,
      references: [],
      connections: [],
      revision: 5,
      archived: false,
      updatedAt: "2026-10-01T00:00:00.000Z",
    },
    status: "available",
    issues: [],
  };
}

function baseInput(overrides: Partial<DiscoveryInput> = {}): DiscoveryInput {
  return {
    threadId: ThreadId.makeUnsafe("discovery-thread"),
    selectedProvider: "codex",
    selectedProviderInstanceId: "codex" as ProviderInstanceId,
    composerTrigger: { kind: "skill", query: "", rangeStart: 0, rangeEnd: 0 },
    composerCommandPicker: null,
    providerModelDiscoveryCwd: "/workspace/project",
    providerOptionsForDispatch: undefined,
    gitCwd: null,
    piAgentDir: "",
    ompAgentDir: "",
    ...overrides,
  };
}

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function mount(input: DiscoveryInput) {
  return renderHook((props?: DiscoveryInput) => useComposerDiscovery(props ?? input), {
    initialProps: input,
    wrapper: wrapper(),
  });
}

describe("useComposerDiscovery Expert snapshot Skills", () => {
  beforeEach(() => {
    harness.provider.getComposerCapabilities.mockReset().mockResolvedValue(CAPABILITIES);
    harness.provider.listCommands.mockReset().mockResolvedValue({
      commands: [{ name: "review", description: "Review the current changes" }],
      source: "fixture",
    });
    harness.provider.listSkills.mockReset().mockResolvedValue({
      skills: [skill("Harness Skill", "/harness/skills/harness")],
      source: "fixture",
      cached: false,
    });
    harness.provider.listPlugins.mockReset().mockResolvedValue({
      marketplaces: [],
      marketplaceLoadErrors: [],
      remoteSyncError: null,
      featuredPluginIds: [],
      source: "empty",
      cached: false,
    });
    harness.readExpertSnapshot
      .mockReset()
      .mockImplementation(async ({ snapshotId }: { snapshotId: string }) =>
        snapshot(snapshotId, []),
      );
  });

  it("uses V2 entry identities and hides entries that disallow explicit invocation", async () => {
    const packageId = `pkg_${"a".repeat(64)}`;
    const entries = [
      {
        packageId,
        entryPath: "workflow/SKILL.md",
        activation: "on-demand" as const,
        name: "explicit-only",
        description: "Workflow",
        path: "/fixed/workflow/SKILL.md",
        disableModelInvocation: true,
      },
      {
        packageId,
        entryPath: "private/SKILL.md",
        activation: "on-demand" as const,
        name: "private",
        description: "Internal",
        path: "/fixed/private/SKILL.md",
        userInvocable: false,
      },
    ];
    harness.readExpertSnapshot.mockResolvedValue({
      ...snapshot("accepted-v2", []),
      schemaVersion: 2,
      skillEntries: entries,
    });
    const hook = await mount(baseInput({ expertBinding: binding("accepted-v2") }));
    try {
      await vi.waitFor(() => expect(hook.result.current.providerSkills).toHaveLength(1));
      expect(hook.result.current.providerSkills[0]).toMatchObject({
        name: "explicit-only",
        path: `synara-expert-skill:${packageId}#workflow/SKILL.md`,
        expert: { snapshotId: "accepted-v2", packageId, entryPath: "workflow/SKILL.md" },
      });
      expect(harness.provider.listSkills).not.toHaveBeenCalled();
    } finally {
      await hook.unmount();
    }
  });

  it("uses the authoritative Run catalog for schema-3 tasks and carries managed identity", async () => {
    const packageId = `pkg_${"a".repeat(64)}`;
    const skillId = `skl_${"b".repeat(32)}`;
    harness.readExpertSnapshot.mockResolvedValue({
      ...snapshot("accepted-current", []),
      schemaVersion: 3,
    });
    harness.provider.listSkills.mockResolvedValue({
      skills: [
        {
          name: "latest-managed",
          path: "/verified/new/SKILL.md",
          enabled: true,
          expert: { snapshotId: "accepted-current", packageId, entryPath: "SKILL.md", skillId },
        },
      ],
      source: "expert.fixed-snapshot",
      cached: false,
    });
    const hook = await mount(baseInput({ expertBinding: binding("accepted-current") }));
    try {
      await vi.waitFor(() =>
        expect(hook.result.current.providerSkills[0]?.name).toBe("latest-managed"),
      );
      expect(hook.result.current.providerSkills[0]?.expert?.skillId).toBe(skillId);
      expect(harness.provider.listSkills).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: "discovery-thread" }),
      );
      expect(harness.provider.listCommands).not.toHaveBeenCalled();
    } finally {
      await hook.unmount();
    }
  });

  it("carries draft V2 entry identity until an accepted snapshot replaces it", async () => {
    const packageId = `pkg_${"b".repeat(64)}`;
    const entry = {
      packageId,
      entryPath: "workflow/SKILL.md",
      activation: "on-demand" as const,
      name: "draft-workflow",
      description: "Workflow",
      path: "/fixed/workflow/SKILL.md",
    };
    const preview = { ...expertPreview([]), skillEntries: [entry] };
    const input = baseInput({ draftExpert: { preview, isFetching: false, isError: false } });
    const hook = await mount(input);
    try {
      await vi.waitFor(() => expect(hook.result.current.providerSkills).toHaveLength(1));
      expect(hook.result.current.providerSkills[0]?.expert).toEqual({
        snapshotId: "pending",
        packageId,
        entryPath: entry.entryPath,
      });
      harness.readExpertSnapshot.mockResolvedValue({
        ...snapshot("accepted-v2", []),
        schemaVersion: 2,
        skillEntries: [entry],
      });
      await hook.rerender({ ...input, expertBinding: binding("accepted-v2") });
      await vi.waitFor(() =>
        expect(hook.result.current.providerSkills[0]?.expert?.snapshotId).toBe("accepted-v2"),
      );
    } finally {
      await hook.unmount();
    }
  });

  it("uses the bound snapshot without native command or plugin discovery", async () => {
    const threadId = ThreadId.makeUnsafe("expert-old-thread");
    harness.readExpertSnapshot.mockResolvedValue(
      snapshot("snapshot-old", [{ name: "Pinned Skill", path: "/snapshots/old/pinned" }]),
    );
    const hook = await mount(
      baseInput({
        threadId,
        expertBinding: binding("snapshot-old"),
        composerTrigger: { kind: "slash-command", query: "", rangeStart: 0, rangeEnd: 0 },
      }),
    );
    try {
      await vi.waitFor(() => {
        expect(hook.result.current.providerSkills).toHaveLength(1);
        expect(hook.result.current.providerNativeCommands).toHaveLength(0);
      });
      expect(hook.result.current.providerSkills[0]).toMatchObject({
        name: "Pinned Skill",
        path: "/snapshots/old/pinned",
        enabled: true,
        scope: "expert",
      });
      expect(harness.readExpertSnapshot).toHaveBeenCalledWith({ snapshotId: "snapshot-old" });
      expect(harness.provider.listSkills).not.toHaveBeenCalled();
      expect(harness.provider.listCommands).not.toHaveBeenCalled();
      expect(harness.provider.listPlugins).not.toHaveBeenCalled();
      expect(hook.result.current.isNativeCommandDiscoveryPending).toBe(false);
    } finally {
      await hook.unmount();
    }
  });

  it("clears cached native commands and plugins when a draft Expert is selected, and restores ordinary discovery", async () => {
    harness.provider.getComposerCapabilities.mockResolvedValue({
      ...CAPABILITIES,
      supportsPluginDiscovery: true,
      supportsPluginMentions: true,
    });
    harness.provider.listPlugins.mockResolvedValue({
      marketplaces: [
        {
          name: "native",
          path: "/plugins",
          plugins: [
            {
              id: "ambient-plugin",
              name: "ambient-plugin",
              enabled: true,
              installPolicy: "AVAILABLE",
              authPolicy: "ON_INSTALL",
            },
          ],
        },
      ],
      marketplaceLoadErrors: [],
      remoteSyncError: null,
      featuredPluginIds: [],
      source: "fixture",
      cached: false,
    });
    const input = baseInput({
        composerTrigger: { kind: "slash-command", query: "", rangeStart: 0, rangeEnd: 0 },
      }),
      hook = await mount(input);
    try {
      await vi.waitFor(() => {
        expect(hook.result.current.providerNativeCommands).toHaveLength(1);
        expect(hook.result.current.providerPlugins).toHaveLength(1);
      });
      const commandCalls = harness.provider.listCommands.mock.calls.length,
        pluginCalls = harness.provider.listPlugins.mock.calls.length;
      await hook.rerender({
        ...input,
        draftExpert: { preview: expertPreview([]), isFetching: false, isError: false },
      });
      expect(hook.result.current.providerNativeCommands).toEqual([]);
      expect(hook.result.current.providerPlugins).toEqual([]);
      expect(hook.result.current.providerArtifacts).toBeUndefined();
      expect(hook.result.current.isNativeCommandDiscoveryPending).toBe(false);
      expect(harness.provider.listCommands).toHaveBeenCalledTimes(commandCalls);
      expect(harness.provider.listPlugins).toHaveBeenCalledTimes(pluginCalls);
      await hook.rerender(input);
      await vi.waitFor(() => expect(hook.result.current.providerNativeCommands).toHaveLength(1));
      expect(hook.result.current.providerPlugins).toHaveLength(1);
    } finally {
      await hook.unmount();
    }
  });
  it("keeps all provider Skills for an ordinary unbound thread", async () => {
    harness.provider.listSkills.mockResolvedValue({
      skills: [
        skill("Enabled Harness Skill", "/harness/enabled", true),
        skill("Disabled Harness Skill", "/harness/disabled", false),
      ],
      source: "fixture",
      cached: false,
    });
    const hook = await mount(baseInput());
    try {
      await vi.waitFor(() => expect(hook.result.current.providerSkills).toHaveLength(2));
      expect(hook.result.current.providerSkills.map(({ name }) => name)).toEqual([
        "Enabled Harness Skill",
        "Disabled Harness Skill",
      ]);
      expect(harness.provider.listSkills).toHaveBeenCalledOnce();
      expect(harness.readExpertSnapshot).not.toHaveBeenCalled();
    } finally {
      await hook.unmount();
    }
  });

  it("does not fall back to provider Skills when the bound snapshot is empty", async () => {
    harness.readExpertSnapshot.mockResolvedValue(snapshot("snapshot-empty", []));
    const hook = await mount(baseInput({ expertBinding: binding("snapshot-empty") }));
    try {
      await vi.waitFor(() => expect(harness.readExpertSnapshot).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(hook.result.current.isComposerMenuLoading).toBe(false));
      expect(hook.result.current.providerSkills).toEqual([]);
      expect(harness.provider.listSkills).not.toHaveBeenCalled();
    } finally {
      await hook.unmount();
    }
  });

  it("returns a visible discovery error without falling back when the snapshot read fails", async () => {
    harness.readExpertSnapshot.mockRejectedValue(new Error("snapshot unavailable"));
    const hook = await mount(baseInput({ expertBinding: binding("snapshot-failed") }));
    try {
      await vi.waitFor(() => expect(hook.result.current.composerDiscoveryError).not.toBeNull());
      expect(hook.result.current.composerDiscoveryError).toBe(
        "无法读取此对话绑定的专家技能，请重试。",
      );
      expect(hook.result.current.providerSkills).toEqual([]);
      expect(harness.provider.listSkills).not.toHaveBeenCalled();
    } finally {
      await hook.unmount();
    }
  });

  it("uses loaded draft Expert preview Skills without querying Harness Skills", async () => {
    const hook = await mount(
      baseInput({
        draftExpert: {
          preview: expertPreview([
            { name: "Draft Skill", path: "/experts/draft/skills/draft" },
            { name: "Second Draft Skill", path: "/experts/draft/skills/second" },
          ]),
          isFetching: false,
          isError: false,
        },
      }),
    );
    try {
      await vi.waitFor(() => expect(hook.result.current.providerSkills).toHaveLength(2));
      expect(hook.result.current.providerSkills).toEqual([
        expect.objectContaining({
          name: "Draft Skill",
          path: "/experts/draft/skills/draft",
          enabled: true,
          scope: "expert",
        }),
        expect.objectContaining({
          name: "Second Draft Skill",
          path: "/experts/draft/skills/second",
          enabled: true,
          scope: "expert",
        }),
      ]);
      expect(harness.provider.listSkills).not.toHaveBeenCalled();
      expect(harness.readExpertSnapshot).not.toHaveBeenCalled();
    } finally {
      await hook.unmount();
    }
  });

  it("fails closed while a draft Expert preview is pending", async () => {
    const hook = await mount(
      baseInput({
        draftExpert: { preview: undefined, isFetching: true, isError: false },
      }),
    );
    try {
      await vi.waitFor(() => expect(hook.result.current.isComposerMenuLoading).toBe(true));
      expect(hook.result.current.providerSkills).toEqual([]);
      expect(harness.provider.listSkills).not.toHaveBeenCalled();
    } finally {
      await hook.unmount();
    }
  });

  it("shows a draft preview error without falling back to Harness Skills", async () => {
    const hook = await mount(
      baseInput({
        draftExpert: {
          preview: expertPreview([{ name: "Stale Draft Skill", path: "/experts/stale/skill" }]),
          isFetching: false,
          isError: true,
        },
      }),
    );
    try {
      await vi.waitFor(() => expect(hook.result.current.composerDiscoveryError).not.toBeNull());
      expect(hook.result.current.composerDiscoveryError).toBe("无法读取所选专家的技能，请重试。");
      expect(hook.result.current.providerSkills).toEqual([]);
      expect(harness.provider.listSkills).not.toHaveBeenCalled();
    } finally {
      await hook.unmount();
    }
  });

  it("does not fall back to Harness Skills when the draft preview has no Skills", async () => {
    const hook = await mount(
      baseInput({
        draftExpert: {
          preview: expertPreview([]),
          isFetching: false,
          isError: false,
        },
      }),
    );
    try {
      await vi.waitFor(() => expect(hook.result.current.isComposerMenuLoading).toBe(false));
      expect(hook.result.current.providerSkills).toEqual([]);
      expect(harness.provider.listSkills).not.toHaveBeenCalled();
    } finally {
      await hook.unmount();
    }
  });

  it("prefers an accepted snapshot over the draft Expert preview", async () => {
    harness.readExpertSnapshot.mockResolvedValue(
      snapshot("snapshot-accepted", [
        { name: "Accepted Snapshot Skill", path: "/snapshots/accepted/skill" },
      ]),
    );
    const hook = await mount(
      baseInput({
        expertBinding: binding("snapshot-accepted"),
        draftExpert: {
          preview: expertPreview([
            { name: "Unaccepted Draft Skill", path: "/experts/draft/unaccepted" },
          ]),
          isFetching: false,
          isError: false,
        },
      }),
    );
    try {
      await vi.waitFor(() => expect(hook.result.current.providerSkills).toHaveLength(1));
      expect(hook.result.current.providerSkills[0]).toMatchObject({
        name: "Accepted Snapshot Skill",
        path: "/snapshots/accepted/skill",
        enabled: true,
        scope: "expert",
      });
      expect(harness.provider.listSkills).not.toHaveBeenCalled();
      expect(harness.readExpertSnapshot).toHaveBeenCalledWith({
        snapshotId: "snapshot-accepted",
      });
    } finally {
      await hook.unmount();
    }
  });

  it("does not leak a delayed previous thread snapshot after switching threads", async () => {
    let resolveOldSnapshot!: (value: ExpertSnapshot) => void;
    harness.readExpertSnapshot.mockImplementation(({ snapshotId }: { snapshotId: string }) =>
      snapshotId === "snapshot-first"
        ? new Promise<ExpertSnapshot>((resolve) => {
            resolveOldSnapshot = resolve;
          })
        : Promise.resolve(
            snapshot(snapshotId, [{ name: "Second Thread Skill", path: "/second/skill" }]),
          ),
    );
    const firstInput = baseInput({
      threadId: ThreadId.makeUnsafe("expert-first-thread"),
      expertBinding: binding("snapshot-first"),
    });
    const hook = await mount(firstInput);
    try {
      await vi.waitFor(() => expect(resolveOldSnapshot).toBeDefined());
      await hook.rerender(
        baseInput({
          threadId: ThreadId.makeUnsafe("expert-second-thread"),
          expertBinding: binding("snapshot-second"),
        }),
      );
      await vi.waitFor(() =>
        expect(hook.result.current.providerSkills.map(({ name }) => name)).toEqual([
          "Second Thread Skill",
        ]),
      );

      resolveOldSnapshot(
        snapshot("snapshot-first", [{ name: "First Thread Skill", path: "/first/skill" }]),
      );
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      expect(hook.result.current.providerSkills.map(({ name }) => name)).toEqual([
        "Second Thread Skill",
      ]);
      expect(harness.provider.listSkills).not.toHaveBeenCalled();
    } finally {
      await hook.unmount();
    }
  });
});
