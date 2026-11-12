import { describe, expect, it, vi } from "vitest";
import { ProjectId, ThreadId, type ExpertDefinition } from "@synara/contracts";
import { Effect, Option } from "effect";

import { readHubExpertCatalog } from "./hubExpertCatalog";
import { resolveHubExpertCandidates } from "./hubExpertDispatch";
import { suiteContentDigest } from "../suites/suiteIdentity";

type Input = Parameters<typeof readHubExpertCatalog>[0];
const hubId = ProjectId.makeUnsafe("hub-catalog");
const coordinatorId = ThreadId.makeUnsafe("hub-coordinator");

function setup(
  options: {
    kind?: string;
    configured?: boolean;
    coordinatorProjectId?: string;
    expertIds?: readonly string[];
    sourceProjectId?: string;
  } = {},
) {
  const expert: ExpertDefinition = {
    id: "research-expert",
    name: "研究专家",
    description: "研究与资料整理",
    useCases: "文献研究",
    persona: "Research",
    outputRequirements: "Cite sources",
    skills: [],
    references: [],
    connections: [],
    revision: 1,
    archived: false,
    updatedAt: "2026-10-19T00:00:00.000Z",
  };
  const prepareSnapshot = vi.fn(async () => {
    throw new Error("catalogue must not bind");
  });
  const listModels = vi.fn(() =>
    Effect.succeed({
      source: "test",
      models: [{ slug: "current-model", name: "Current model" }],
    }),
  );
  const list = vi.fn(async () => [expert]);
  const read = vi.fn(async (_expertId: string): Promise<ExpertDefinition | null> => expert);
  const preview = vi.fn(async (_input: unknown) => ({ status: "available", issues: [] }));
  const assertTarget = vi.fn(() => Effect.void);
  const input: Input = {
    assertTarget,
    projectId: hubId,
    snapshotQuery: {
      getProjectShellById: (id: string) =>
        Effect.succeed(
          Option.some({
            id,
            kind: options.kind ?? "group",
            workspaceRoot: id === hubId ? "/work/hub" : `/work/${id}`,
          }),
        ),
      getThreadShellById: () =>
        Effect.succeed(
          Option.some({
            id: coordinatorId,
            projectId: options.coordinatorProjectId ?? hubId,
            modelSelection: { provider: "codex", model: "current-model" },
          }),
        ),
    } as unknown as Input["snapshotQuery"],
    loadConfig: () =>
      Effect.succeed(
        options.configured === false
          ? null
          : {
              coordinatorThreadId: coordinatorId,
              expertIds: options.expertIds ?? [expert.id],
              ...(options.sourceProjectId
                ? { sourceProjectId: ProjectId.makeUnsafe(options.sourceProjectId) }
                : {}),
            },
      ),
    dependencies: {
      expertStore: {
        list,
        read,
        preview,
        prepareSnapshot,
        readSnapshot: async () => {
          throw new Error("catalogue must not read snapshots");
        },
      } as unknown as Input["dependencies"]["expertStore"],
      providerDiscovery: { listModels } as unknown as Input["dependencies"]["providerDiscovery"],
      loadProviderAvailabilities: Effect.succeed(
        new Map([["codex", { enabled: true, available: true, authStatus: "authenticated" }]]),
      ),
    },
  };
  return { input, expert, list, read, listModels, prepareSnapshot, preview, assertTarget };
}

describe("Hub Expert catalogue read capability", () => {
  it("checks the source project used by default dispatch, and lets an explicit target override it", async () => {
    const h = setup({ sourceProjectId: "source-repo" });
    const defaultResult = await Effect.runPromise(readHubExpertCatalog(h.input));
    expect(defaultResult[0]?.targetProjectId).toBe("source-repo");
    expect(h.preview).toHaveBeenLastCalledWith(
      expect.objectContaining({ cwd: "/work/source-repo" }),
    );
    const explicit = ProjectId.makeUnsafe("linked-repo");
    await Effect.runPromise(readHubExpertCatalog({ ...h.input, targetProjectId: explicit }));
    expect(h.preview).toHaveBeenLastCalledWith(
      expect.objectContaining({ cwd: "/work/linked-repo" }),
    );
    expect(h.assertTarget).toHaveBeenLastCalledWith({
      callerThreadId: coordinatorId,
      targetProjectId: explicit,
    });
  });

  it("refuses an unauthorized target before reading experts", async () => {
    const h = setup();
    await expect(
      Effect.runPromise(
        readHubExpertCatalog({
          ...h.input,
          assertTarget: () => Effect.fail(new Error("Target is not linked")),
        }),
      ),
    ).rejects.toThrow("not linked");
    expect(h.read).not.toHaveBeenCalled();
  });

  it("returns an empty roster without global discovery or provider preflight", async () => {
    const h = setup({ expertIds: [] });
    expect(await Effect.runPromise(readHubExpertCatalog(h.input))).toEqual([]);
    expect(h.list).not.toHaveBeenCalled();
    expect(h.read).not.toHaveBeenCalled();
    expect(h.listModels).not.toHaveBeenCalled();
  });
  it("keeps a deleted selected identity unavailable without discovering substitutes", async () => {
    const h = setup();
    h.read.mockResolvedValue(null);
    const result = await Effect.runPromise(readHubExpertCatalog(h.input));
    expect(result).toEqual([
      {
        targetProjectId: hubId,
        expertId: h.expert.id,
        displayName: "Unavailable Expert",
        description: "",
        useCases: "",
        preferredProvider: null,
        origin: "roster",
        issues: [
          expect.objectContaining({
            code: "identity_unavailable",
            action: "dispatch",
            effect: "deny-action",
          }),
        ],
        available: false,
      },
    ]);
    expect(h.list).not.toHaveBeenCalled();
    expect(h.listModels).not.toHaveBeenCalled();
  });

  it("uses the coordinator's actual model and performs no binding", async () => {
    const h = setup();
    const result = await Effect.runPromise(readHubExpertCatalog(h.input));
    expect(result).toEqual([
      {
        targetProjectId: hubId,
        expertId: h.expert.id,
        displayName: h.expert.name,
        description: h.expert.description,
        useCases: h.expert.useCases,
        preferredProvider: null,
        origin: "roster",
        issues: [],
        available: true,
      },
    ]);
    expect(h.listModels).toHaveBeenCalled();
    expect(h.list).not.toHaveBeenCalled();
    expect(h.read).toHaveBeenCalledExactlyOnceWith(h.expert.id);
    expect(h.prepareSnapshot).not.toHaveBeenCalled();
  });

  it.each(["project", "chat"])("rejects %s before loading expert data", async (kind) => {
    const h = setup({ kind });
    await expect(Effect.runPromise(readHubExpertCatalog(h.input))).rejects.toThrow("existing Hub");
    expect(h.list).not.toHaveBeenCalled();
  });

  it("rejects unfinished Hub setup", async () => {
    const h = setup({ configured: false });
    await expect(Effect.runPromise(readHubExpertCatalog(h.input))).rejects.toThrow(
      "Finish Hub setup",
    );
    expect(h.list).not.toHaveBeenCalled();
  });

  it("rejects a coordinator belonging to another Hub", async () => {
    const h = setup({ coordinatorProjectId: "other-hub" });
    await expect(Effect.runPromise(readHubExpertCatalog(h.input))).rejects.toThrow("unavailable");
    expect(h.list).not.toHaveBeenCalled();
  });

  it("reports archived and unavailable configurations without silently changing target", async () => {
    const h = setup();
    h.read.mockResolvedValue({ ...h.expert, archived: true });
    const archived = await Effect.runPromise(readHubExpertCatalog(h.input));
    expect(archived[0]?.available).toBe(false);
    expect(h.listModels).not.toHaveBeenCalled();
    h.read.mockResolvedValue(h.expert);
    const unavailable = await Effect.runPromise(
      readHubExpertCatalog({
        ...h.input,
        dependencies: {
          ...h.input.dependencies,
          loadProviderAvailabilities: Effect.succeed(
            new Map([
              ["codex", { enabled: false, available: false, authStatus: "unauthenticated" }],
            ]),
          ),
        },
      }),
    );
    expect(unavailable[0]?.available).toBe(false);
    expect(h.prepareSnapshot).not.toHaveBeenCalled();
  });

  it("checks a saved OMP model rather than demanding a static provider default", async () => {
    const h = setup();
    const model = "openai-codex/gpt-6.1-sol";
    h.read.mockResolvedValue({
      ...h.expert,
      preferredProvider: "omp",
      defaultModelSelection: { provider: "omp", model, instanceId: "omp" },
    });
    h.listModels.mockReturnValue(
      Effect.succeed({
        source: "test",
        models: [{ slug: model, name: "GPT-6.1 Sol" }],
      }),
    );
    const configured = await Effect.runPromise(readHubExpertCatalog(h.input));
    expect(configured[0]?.available).toBe(true);
    h.listModels.mockReturnValue(
      Effect.succeed({
        source: "test",
        models: [{ slug: "different-model", name: "Different" }],
      }),
    );
    const missing = await Effect.runPromise(readHubExpertCatalog(h.input));
    expect(missing[0]?.available).toBe(false);
    expect(h.prepareSnapshot).not.toHaveBeenCalled();
  });

  it("resolves Suite members instead of the retained roster and isolates member failures", async () => {
    const h = setup();
    const ref = { suiteId: "suite_00000000-0000-0000-0000-000000000001", revision: 1 };
    const content = {
      schemaVersion: 1 as const,
      ref,
      name: "Research Suite",
      description: "",
      source: {
        kind: "local-folder" as const,
        sourceId: "/fixture/suite",
        contentHash: "a".repeat(64),
      },
      adapterId: "fixture",
      adapterVersion: 1,
      members: [
        { key: "research", expertId: h.expert.id, roleSourcePath: null },
        { key: "missing", expertId: "missing-expert", roleSourcePath: null },
      ],
      resources: [],
      defaults: {},
    };
    h.read.mockImplementation(async (id: string) => (id === h.expert.id ? h.expert : null));
    const result = await Effect.runPromise(
      resolveHubExpertCandidates({
        config: { revision: 4, suite: ref, expertIds: ["old-roster"] },
        expertStore: h.input.dependencies.expertStore,
        suiteStore: {
          read: () =>
            Effect.succeed({
              ...content,
              compositionHash: suiteContentDigest(content),
              createdAt: "2026-11-11T00:00:00.000Z",
            }),
        },
      }),
    );
    expect(result.configRevision).toBe(4);
    expect(result.suite).toEqual(ref);
    expect(result.candidates.map((candidate) => candidate.expertId)).toEqual([
      "missing-expert",
      h.expert.id,
    ]);
    expect(result.candidates.every((candidate) => candidate.origin === "suite")).toBe(true);
    expect(result.candidates[0]?.issues?.[0]?.code).toBe("identity_unavailable");
    expect(result.candidates[1]?.issues).toEqual([]);
    expect(result.candidates[1]?.available).toBe(true);
    expect(h.read).not.toHaveBeenCalledWith("old-roster");
    expect(h.list).not.toHaveBeenCalled();
  });

  it("fails missing Suite dependencies explicitly without falling back to the roster", async () => {
    const h = setup();
    const config = {
      revision: 1,
      expertIds: [h.expert.id],
      suite: { suiteId: "suite_00000000-0000-0000-0000-000000000001", revision: 1 },
    };
    await expect(
      Effect.runPromise(
        resolveHubExpertCandidates({
          config,
          expertStore: h.input.dependencies.expertStore,
        }),
      ),
    ).rejects.toThrow("Suite membership resolution is unavailable");
    await expect(
      Effect.runPromise(
        resolveHubExpertCandidates({
          config,
          expertStore: h.input.dependencies.expertStore,
          suiteStore: { read: () => Effect.succeed(null) },
        }),
      ),
    ).rejects.toThrow("Selected Suite revision does not exist");
    expect(h.read).not.toHaveBeenCalled();
    expect(h.list).not.toHaveBeenCalled();
  });
});
