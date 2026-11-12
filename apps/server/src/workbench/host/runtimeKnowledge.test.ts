import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  ProjectId,
  ThreadId,
  type LearningSessionContext,
  type MemoryScope,
  type RunKnowledgeManifest,
  type RunSkillAssemblyV1 as RunSkillAssembly,
} from "@synara/contracts";
import { Effect, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stableJsonStringify } from "@synara/shared/browserAutomationCatalogue";
import type { LearningStateRow } from "../../experts/evolution/ExpertLearningRepository.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { SpaceMemoryServiceShape } from "../../spaceMemory/SpaceMemoryService.ts";
import {
  prepareRuntimeKnowledge,
  renderRuntimeKnowledge,
  verifyRuntimeKnowledge,
} from "./runtimeKnowledge.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const hash = (value: unknown) =>
  `sha256:${createHash("sha256").update(stableJsonStringify(value)).digest("hex")}`;

type ManifestInput = Omit<Partial<RunKnowledgeManifest>, "learningEpoch"> & {
  readonly learningEpoch?: number;
  readonly omitLearningEpoch?: boolean;
};

function manifest(input: ManifestInput = {}): RunKnowledgeManifest {
  const { omitLearningEpoch, ...overrides } = input;
  const base = {
    id: "manifest-source",
    rootRunId: "run-source",
    scope: scope(),
    snapshotId: "snapshot-source",
    skillAssemblyId: "ska_source",
    learningEpoch: 7,
    frozenRuleSequence: 12,
    rules: [
      {
        memoryId: "memory-rule-1",
        revision: 2,
        contentHash: `sha256:${"a".repeat(64)}`,
      },
    ],
    renderVersion: 1 as const,
    text: "- style.concise: Keep conclusions first.\n",
    createdAt: "2026-10-31T00:00:00.000Z",
    ...overrides,
  };
  if (omitLearningEpoch) delete (base as { learningEpoch?: number }).learningEpoch;
  return { ...base, hash: hash(base) };
}

function scope(patch: Partial<MemoryScope> = {}): MemoryScope {
  return {
    ownerId: "owner-1",
    spaceId: "space-1",
    expertId: "expert-1",
    projectId: "project-1",
    ...patch,
  };
}

function stateRow(
  input: {
    expertId?: string;
    enabled?: boolean;
    epoch?: number;
    frozenRuleSequence?: number;
    ruleOverrides?: readonly unknown[];
    ownerId?: string;
  } = {},
): LearningStateRow {
  const state = {
    expertId: input.expertId ?? "expert-1",
    enabled: input.enabled ?? true,
    epoch: input.epoch ?? 3,
    revision: 1,
    updatedAt: "2026-10-31T00:00:00.000Z",
  };
  return {
    ownerId: input.ownerId ?? "owner-1",
    expertId: state.expertId,
    revision: state.revision,
    updatedAt: state.updatedAt,
    record: JSON.stringify({
      ownerKind: "session",
      state,
      ...(input.frozenRuleSequence !== undefined
        ? { frozenRuleSequence: input.frozenRuleSequence }
        : {}),
      ...(input.ruleOverrides !== undefined ? { ruleOverrides: input.ruleOverrides } : {}),
    }),
  };
}

function assembly(rootRunId = "run-new", snapshotId = "snapshot-1"): RunSkillAssembly {
  const assemblyId = `ska_${"1".repeat(64)}`;
  return {
    schemaVersion: 1,
    rootRunId,
    threadId: "thread-1",
    baseSnapshotId: snapshotId,
    assemblyId,
    bindingRevision: 1,
    createdAt: "2026-10-31T00:00:00.000Z",
    hasInitializationEffects: false,
    phase: "prepared",
    session: {
      snapshotId,
      expertId: "expert-1",
      skillRootRunId: rootRunId,
      skillAssemblyId: assemblyId,
      persona: "A fixed Expert persona.",
      skills: [],
      references: [],
    },
  };
}

function fixture(
  options: {
    row?: LearningStateRow | null;
    scope?: MemoryScope;
    manifest?: RunKnowledgeManifest;
  } = {},
) {
  const stateDirPromise = fs.mkdtemp(path.join(os.tmpdir(), "runtime-knowledge-"));
  let currentScope = options.scope ?? scope();
  let row = options.row === null ? undefined : (options.row ?? stateRow());
  const byId = new Map<string, RunKnowledgeManifest>();
  const byRoot = new Map<string, RunKnowledgeManifest>();
  if (options.manifest) {
    byId.set(options.manifest.id, options.manifest);
    byRoot.set(options.manifest.rootRunId, options.manifest);
  }
  const prepareArgs: Array<Record<string, unknown>> = [];
  const findRootRequests: string[] = [];
  const memory = {
    findRunManifest: (requestScope: MemoryScope, rootRunId: string) => {
      findRootRequests.push(rootRunId);
      return Effect.succeed(
        requestScope.ownerId === currentScope.ownerId &&
          requestScope.expertId === currentScope.expertId &&
          requestScope.spaceId === currentScope.spaceId &&
          requestScope.projectId === currentScope.projectId
          ? byRoot.get(rootRunId)
          : undefined,
      );
    },
    readManifest: (requestScope: MemoryScope, manifestId: string) => {
      const found = byId.get(manifestId);
      if (!found) return Effect.fail(new Error("manifest missing"));
      if (
        found.scope.ownerId !== requestScope.ownerId ||
        found.scope.expertId !== requestScope.expertId ||
        found.scope.spaceId !== requestScope.spaceId ||
        found.scope.projectId !== requestScope.projectId
      ) {
        return Effect.fail(new Error("manifest scope mismatch"));
      }
      return Effect.succeed(found);
    },
    prepareRunManifest: (input: Record<string, unknown>) => {
      prepareArgs.push(input);
      const sourceId = input.inheritManifestId as string | undefined;
      const source = sourceId ? byId.get(sourceId) : undefined;
      const created = source
        ? manifest({
            id: `manifest-${input.rootRunId}`,
            rootRunId: input.rootRunId as string,
            scope: input.scope as MemoryScope,
            snapshotId: input.snapshotId as string,
            skillAssemblyId: input.skillAssemblyId as string,
            ...(source.learningEpoch !== undefined
              ? { learningEpoch: source.learningEpoch }
              : { omitLearningEpoch: true }),
            frozenRuleSequence: source.frozenRuleSequence,
            rules: source.rules,
            renderVersion: source.renderVersion,
            text: source.text,
          })
        : manifest({
            id: `manifest-${input.rootRunId}`,
            rootRunId: input.rootRunId as string,
            scope: input.scope as MemoryScope,
            snapshotId: input.snapshotId as string,
            skillAssemblyId: input.skillAssemblyId as string,
            ...(input.learningEpoch !== undefined
              ? { learningEpoch: input.learningEpoch as number }
              : { omitLearningEpoch: true }),
            ...(input.frozenRuleSequence !== undefined
              ? { frozenRuleSequence: input.frozenRuleSequence as number }
              : {}),
            rules:
              "ruleOverrides" in input
                ? (input.ruleOverrides as RunKnowledgeManifest["rules"])
                : [],
            text:
              input.frozenRuleSequence !== undefined
                ? `Frozen rule sequence: ${input.frozenRuleSequence}.\n`
                : "",
          });
      byId.set(created.id, created);
      byRoot.set(created.rootRunId, created);
      return Effect.succeed(created);
    },
  } as unknown as SpaceMemoryServiceShape;
  const projection = {
    getThreadShellById: vi.fn((id: ThreadId) =>
      Effect.succeed(
        Option.some({
          id,
          projectId: ProjectId.makeUnsafe(currentScope.projectId),
          expertBinding: {
            expertId: currentScope.expertId,
            snapshotId: "snapshot-1",
          },
        } as never),
      ),
    ),
    getProjectShellById: vi.fn((id: ProjectId) =>
      Effect.succeed(Option.some({ id, spaceId: currentScope.spaceId } as never)),
    ),
  } as unknown as Pick<ProjectionSnapshotQueryShape, "getThreadShellById" | "getProjectShellById">;
  const learningRepository = {
    listStates: () => Effect.succeed(row ? [row] : []),
  };
  const attachKnowledge = vi.fn(async (rootRunId: string, knowledge: LearningSessionContext) => {
    const candidate = assembly(rootRunId);
    return { ...candidate, session: { ...candidate.session, knowledge } };
  });
  return {
    stateDirPromise,
    memory,
    projection,
    learningRepository,
    prepareArgs,
    findRootRequests,
    attachKnowledge,
    changeScope(next: MemoryScope) {
      currentScope = next;
    },
    changeOwner(ownerId: string) {
      if (row) row = { ...row, ownerId };
    },
    changeState(next: { readonly enabled: boolean; readonly epoch: number }) {
      row = stateRow({ ...next, ...(row ? { ownerId: row.ownerId } : {}) });
    },
    byId,
    byRoot,
  };
}

describe("runtime Run knowledge binding", () => {
  it("uses the latest rules and learning epoch for a newly enabled Run", async () => {
    const f = fixture({ row: stateRow({ enabled: true, epoch: 4 }) });
    const stateDir = await f.stateDirPromise;
    roots.push(stateDir);
    const input = assembly();
    const attached = await Effect.runPromise(
      prepareRuntimeKnowledge({
        stateDir,
        threadId: input.threadId,
        provider: "omp",
        assembly: input,
        allowCreate: true,
        memory: f.memory,
        learningRepository: f.learningRepository,
        projection: f.projection,
        attachKnowledge: f.attachKnowledge,
      }),
    );
    expect(f.prepareArgs).toHaveLength(1);
    expect(f.prepareArgs[0]).toMatchObject({
      rootRunId: input.rootRunId,
      snapshotId: input.baseSnapshotId,
      skillAssemblyId: input.assemblyId,
      learningEpoch: 4,
    });
    expect(f.prepareArgs[0]).not.toHaveProperty("frozenRuleSequence");
    expect(attached.session.knowledge?.rootRunId).toBe(input.rootRunId);
    expect(f.attachKnowledge).toHaveBeenCalledTimes(1);
  });

  it("creates a read-only Run at the shutoff cutoff with its frozen rule overrides", async () => {
    const overrides = [
      { memoryId: "manual-rule", revision: 2, contentHash: `sha256:${"b".repeat(64)}` },
    ];
    const f = fixture({
      row: stateRow({ enabled: false, epoch: 5, frozenRuleSequence: 0, ruleOverrides: overrides }),
    });
    const stateDir = await f.stateDirPromise;
    roots.push(stateDir);
    const input = assembly();
    const attached = await Effect.runPromise(
      prepareRuntimeKnowledge({
        stateDir,
        threadId: input.threadId,
        provider: "pi",
        assembly: input,
        allowCreate: true,
        memory: f.memory,
        learningRepository: f.learningRepository,
        projection: f.projection,
        attachKnowledge: f.attachKnowledge,
      }),
    );
    expect(f.prepareArgs[0]).toMatchObject({
      frozenRuleSequence: 0,
      ruleOverrides: overrides,
    });
    expect(f.prepareArgs[0]).not.toHaveProperty("learningEpoch");
    const created = f.byRoot.get(input.rootRunId)!;
    expect(created).toMatchObject({ frozenRuleSequence: 0, rules: overrides });
    expect(created).not.toHaveProperty("learningEpoch");
    expect(attached.session.knowledge).not.toHaveProperty("learningEpoch");
    const rendered = renderRuntimeKnowledge(created);
    expect(rendered).toContain("Frozen rule sequence: 0.");
    expect(rendered).toContain("manual-rule@2");
    expect(rendered).toContain("Self-learning writes are disabled for this Run.");
    expect(rendered).toContain("You may read pinned rules and current facts");
    expect(rendered).not.toContain(
      "Self-learning is enabled for this Run's captured authorization.",
    );
    expect(rendered).not.toContain("synara_learning_commit");
  });

  it("leaves a legacy recovery without a reference or predecessor unchanged", async () => {
    const f = fixture();
    const stateDir = await f.stateDirPromise;
    roots.push(stateDir);
    const input = assembly();
    const result = await Effect.runPromise(
      prepareRuntimeKnowledge({
        stateDir,
        threadId: input.threadId,
        provider: "omp",
        assembly: input,
        allowCreate: false,
        memory: f.memory,
        learningRepository: f.learningRepository,
        projection: f.projection,
        attachKnowledge: f.attachKnowledge,
      }),
    );
    expect(result).toBe(input);
    expect(f.prepareArgs).toHaveLength(0);
    expect(f.attachKnowledge).not.toHaveBeenCalled();
    expect(f.findRootRequests).toEqual([input.rootRunId]);
    expect(f.projection.getThreadShellById).toHaveBeenCalledTimes(1);
  });

  it("reattaches an exact manifest committed before an unbound recovery crash", async () => {
    const input = assembly();
    const alreadyWritten = manifest({
      id: "manifest-crash-before-attachment",
      rootRunId: input.rootRunId,
      snapshotId: input.baseSnapshotId,
      skillAssemblyId: input.assemblyId,
      learningEpoch: 7,
    });
    const f = fixture({
      manifest: alreadyWritten,
      row: stateRow({ enabled: true, epoch: 9 }),
    });
    const stateDir = await f.stateDirPromise;
    roots.push(stateDir);

    const recovered = await Effect.runPromise(
      prepareRuntimeKnowledge({
        stateDir,
        threadId: input.threadId,
        provider: "omp",
        assembly: input,
        allowCreate: false,
        memory: f.memory,
        learningRepository: f.learningRepository,
        projection: f.projection,
        attachKnowledge: f.attachKnowledge,
      }),
    );

    expect(f.findRootRequests).toEqual([input.rootRunId]);
    expect(f.prepareArgs).toHaveLength(0);
    expect(f.attachKnowledge).toHaveBeenCalledTimes(1);
    expect(recovered.session.knowledge).toMatchObject({
      manifestId: alreadyWritten.id,
      rootRunId: input.rootRunId,
      snapshotId: input.baseSnapshotId,
      knowledgeHash: alreadyWritten.hash,
      learningEpoch: 7,
    });
    expect(recovered.session.knowledge?.learningEpoch).not.toBe(9);
  });

  it("leaves a never-enabled Expert's new Run unbound instead of reviving a stored grant", async () => {
    const input = assembly();
    const oldManifest = manifest({
      id: "manifest-stale-never-enabled",
      rootRunId: input.rootRunId,
      snapshotId: input.baseSnapshotId,
      skillAssemblyId: input.assemblyId,
      learningEpoch: 3,
    });
    const f = fixture({ row: null, manifest: oldManifest });
    const stateDir = await f.stateDirPromise;
    roots.push(stateDir);

    const result = await Effect.runPromise(
      prepareRuntimeKnowledge({
        stateDir,
        threadId: input.threadId,
        provider: "omp",
        assembly: input,
        allowCreate: true,
        memory: f.memory,
        learningRepository: f.learningRepository,
        projection: f.projection,
        attachKnowledge: f.attachKnowledge,
      }),
    );

    expect(result).toBe(input);
    expect(result.session.knowledge).toBeUndefined();
    expect(f.prepareArgs).toHaveLength(0);
    expect(f.findRootRequests).toEqual([]);
    expect(f.byRoot.get(input.rootRunId)).toEqual(oldManifest);
    expect(f.attachKnowledge).not.toHaveBeenCalled();
  });

  it("still requires an owner for existing and inherited knowledge references", async () => {
    const previousAssembly = assembly("run-source", "snapshot-1");
    const source = manifest({
      rootRunId: previousAssembly.rootRunId,
      snapshotId: previousAssembly.baseSnapshotId,
      skillAssemblyId: previousAssembly.assemblyId,
    });
    const f = fixture({ row: null, manifest: source });
    const stateDir = await f.stateDirPromise;
    roots.push(stateDir);
    const context: LearningSessionContext = {
      manifestId: source.id,
      rootRunId: source.rootRunId,
      snapshotId: source.snapshotId,
      scope: source.scope,
      knowledgeHash: source.hash,
      learningEpoch: source.learningEpoch,
    };
    const existingKnowledge = {
      ...previousAssembly,
      session: { ...previousAssembly.session, knowledge: context },
    };
    const inherited = {
      ...assembly("run-child", "snapshot-1"),
      knowledgeSourceRunId: source.rootRunId,
    };

    await expect(
      Effect.runPromise(
        prepareRuntimeKnowledge({
          stateDir,
          threadId: existingKnowledge.threadId,
          provider: "omp",
          assembly: existingKnowledge,
          allowCreate: true,
          memory: f.memory,
          learningRepository: f.learningRepository,
          projection: f.projection,
          attachKnowledge: f.attachKnowledge,
        }),
      ),
    ).rejects.toThrow(/no authoritative learning owner/u);
    await expect(
      Effect.runPromise(
        prepareRuntimeKnowledge({
          stateDir,
          threadId: inherited.threadId,
          provider: "omp",
          assembly: inherited,
          allowCreate: false,
          memory: f.memory,
          learningRepository: f.learningRepository,
          projection: f.projection,
          attachKnowledge: f.attachKnowledge,
        }),
      ),
    ).rejects.toThrow(/no authoritative learning owner/u);
    expect(f.attachKnowledge).not.toHaveBeenCalled();
  });

  it("never revives an old continuation grant while learning is closed or reopened", async () => {
    const source = manifest({ snapshotId: "snapshot-1" });
    const f = fixture({
      manifest: source,
      row: stateRow({ enabled: false, epoch: 8, frozenRuleSequence: 0 }),
    });
    const stateDir = await f.stateDirPromise;
    roots.push(stateDir);
    const closedBase = assembly("run-child-closed", "snapshot-1");
    const closedInput: RunSkillAssembly = {
      ...closedBase,
      knowledgeSourceRunId: source.rootRunId,
    };
    const closedRun = await Effect.runPromise(
      prepareRuntimeKnowledge({
        stateDir,
        threadId: closedInput.threadId,
        provider: "omp",
        assembly: closedInput,
        allowCreate: false,
        memory: f.memory,
        learningRepository: f.learningRepository,
        projection: f.projection,
        attachKnowledge: f.attachKnowledge,
      }),
    );
    expect(f.prepareArgs[0]).toMatchObject({
      inheritManifestId: source.id,
      rootRunId: "run-child-closed",
    });
    const closedManifest = f.byRoot.get("run-child-closed")!;
    expect(closedManifest).toMatchObject({
      rootRunId: "run-child-closed",
      snapshotId: "snapshot-1",
      learningEpoch: source.learningEpoch,
      frozenRuleSequence: source.frozenRuleSequence,
      rules: source.rules,
      text: source.text,
    });
    expect(closedRun.session.knowledge?.learningEpoch).toBe(source.learningEpoch);
    const closedRendered = renderRuntimeKnowledge(closedManifest);
    expect(closedRendered).toContain("This Run carries learning epoch 7.");
    expect(closedRendered).toContain("confirm that exact epoch is still active");

    // Reopening advances the owner's epoch, but this old work still inherits
    // its original manifest instead of receiving the new write capability.
    f.changeState({ enabled: true, epoch: 9 });
    const reopenedBase = assembly("run-child-reopened", "snapshot-1");
    const reopenedInput: RunSkillAssembly = {
      ...reopenedBase,
      knowledgeSourceRunId: source.rootRunId,
    };
    const reopenedRun = await Effect.runPromise(
      prepareRuntimeKnowledge({
        stateDir,
        threadId: reopenedInput.threadId,
        provider: "omp",
        assembly: reopenedInput,
        allowCreate: false,
        memory: f.memory,
        learningRepository: f.learningRepository,
        projection: f.projection,
        attachKnowledge: f.attachKnowledge,
      }),
    );
    const reopenedManifest = f.byRoot.get("run-child-reopened")!;
    expect(reopenedManifest.learningEpoch).toBe(source.learningEpoch);
    expect(reopenedManifest.learningEpoch).not.toBe(9);
    expect(reopenedRun.session.knowledge?.learningEpoch).toBe(source.learningEpoch);
  });

  it("reuses an already-written Run manifest without silently changing its grant", async () => {
    const input = assembly();
    const alreadyWritten = manifest({
      id: "manifest-already-written",
      rootRunId: input.rootRunId,
      snapshotId: input.baseSnapshotId,
      skillAssemblyId: input.assemblyId,
      learningEpoch: 5,
    });
    const f = fixture({
      manifest: alreadyWritten,
      row: stateRow({ enabled: false, epoch: 6, frozenRuleSequence: 0 }),
    });
    const stateDir = await f.stateDirPromise;
    roots.push(stateDir);
    const reused = await Effect.runPromise(
      prepareRuntimeKnowledge({
        stateDir,
        threadId: input.threadId,
        provider: "omp",
        assembly: input,
        allowCreate: true,
        memory: f.memory,
        learningRepository: f.learningRepository,
        projection: f.projection,
        attachKnowledge: f.attachKnowledge,
      }),
    );
    expect(f.prepareArgs).toHaveLength(0);
    expect(f.byRoot.get(input.rootRunId)).toEqual(alreadyWritten);
    expect(reused.session.knowledge?.learningEpoch).toBe(5);
  });

  it("rejects changed scope, owner, and manifest hash bindings", async () => {
    const original = manifest({ snapshotId: "snapshot-1" });
    const f = fixture({ manifest: original });
    const context: LearningSessionContext = {
      manifestId: original.id,
      rootRunId: original.rootRunId,
      snapshotId: original.snapshotId,
      scope: original.scope,
      knowledgeHash: original.hash,
      learningEpoch: original.learningEpoch,
    };
    const session = {
      snapshotId: original.snapshotId,
      expertId: original.scope.expertId,
      skillRootRunId: original.rootRunId,
      skillAssemblyId: original.skillAssemblyId,
      knowledge: context,
      persona: "Fixed",
      skills: [],
      references: [],
    };
    const input = {
      threadId: "thread-1",
      expertSession: session,
      memory: f.memory,
      learningRepository: f.learningRepository,
      projection: f.projection,
    };
    await expect(Effect.runPromise(verifyRuntimeKnowledge(input))).resolves.toMatchObject({
      id: original.id,
    });

    f.changeScope(scope({ projectId: "project-changed" }));
    await expect(Effect.runPromise(verifyRuntimeKnowledge(input))).rejects.toThrow(/scope/u);

    f.changeOwner("owner-changed");
    await expect(Effect.runPromise(verifyRuntimeKnowledge(input))).rejects.toThrow(/scope/u);

    f.changeScope(scope());
    f.changeOwner("owner-1");
    const wrongHash = {
      ...session,
      knowledge: { ...context, knowledgeHash: `sha256:${"f".repeat(64)}` },
    };
    await expect(
      Effect.runPromise(verifyRuntimeKnowledge({ ...input, expertSession: wrongHash })),
    ).rejects.toThrow(/manifest identity/u);

    f.byId.set(original.id, { ...original, text: "tampered manifest body" });
    await expect(Effect.runPromise(verifyRuntimeKnowledge(input))).rejects.toThrow(
      /manifest identity/u,
    );
  });

  it("pins the native target's own knowledge under a different parent Expert and rechecks host lifecycle proof", async () => {
    const f = fixture();
    const stateDir = await f.stateDirPromise;
    roots.push(stateDir);
    vi.mocked(f.projection.getThreadShellById).mockImplementation((id) =>
      Effect.succeed(
        Option.some({
          id,
          projectId: ProjectId.makeUnsafe("project-1"),
          expertBinding: { expertId: "parent-expert", snapshotId: "parent-snapshot" },
        } as never),
      ),
    );
    const input = assembly("native-attempt");
    let phase = "prepared";
    const targetBinding = {
      expertId: "expert-1",
      snapshotId: "snapshot-1",
      projectId: "project-1",
      attemptId: input.rootRunId,
      assemblyId: input.assemblyId,
      verify: vi.fn(async () => phase === "prepared" || phase === "starting"),
    };
    const attached = await Effect.runPromise(
      prepareRuntimeKnowledge({
        stateDir,
        threadId: input.threadId,
        provider: "omp",
        assembly: input,
        allowCreate: true,
        memory: f.memory,
        learningRepository: f.learningRepository,
        projection: f.projection,
        attachKnowledge: f.attachKnowledge,
        targetBinding,
      }),
    );
    expect(attached.session.knowledge).toMatchObject({
      rootRunId: "native-attempt",
      scope: scope(),
    });
    expect(f.findRootRequests).toEqual(["native-attempt"]);
    expect(f.prepareArgs[0]).not.toHaveProperty("inheritManifestId");
    expect(targetBinding.verify).toHaveBeenCalled();
    phase = "running";
    const runningProof = { ...targetBinding, verify: vi.fn(async () => phase === "running") };
    const verified = await Effect.runPromise(
      verifyRuntimeKnowledge({
        threadId: input.threadId,
        expertSession: attached.session,
        memory: f.memory,
        learningRepository: f.learningRepository,
        projection: f.projection,
        targetBinding: runningProof,
      }),
    );
    expect(verified?.rootRunId).toBe("native-attempt");
    phase = "unknown";
    await expect(
      Effect.runPromise(
        verifyRuntimeKnowledge({
          threadId: input.threadId,
          expertSession: attached.session,
          memory: f.memory,
          learningRepository: f.learningRepository,
          projection: f.projection,
          targetBinding: runningProof,
        }),
      ),
    ).rejects.toThrow();
    // Removing the host-only proof must not turn the parent thread into the target.
    await expect(
      Effect.runPromise(
        verifyRuntimeKnowledge({
          threadId: input.threadId,
          expertSession: attached.session,
          memory: f.memory,
          learningRepository: f.learningRepository,
          projection: f.projection,
        }),
      ),
    ).rejects.toThrow();
  });

  it.each(["project", "snapshot", "root", "assembly", "proof", "inherit"])(
    "rejects native %s forgery before preparing or attaching knowledge",
    async (forgery) => {
      const f = fixture();
      const stateDir = await f.stateDirPromise;
      roots.push(stateDir);
      const input = assembly("native-attempt");
      const targetBinding = {
        expertId: "expert-1",
        snapshotId: forgery === "snapshot" ? "forged-snapshot" : "snapshot-1",
        projectId: forgery === "project" ? "foreign-project" : "project-1",
        attemptId: forgery === "root" ? "parent-root" : input.rootRunId,
        assemblyId: forgery === "assembly" ? "other-assembly" : input.assemblyId,
        verify: async () => forgery !== "proof",
      };
      await expect(
        Effect.runPromise(
          prepareRuntimeKnowledge({
            stateDir,
            threadId: input.threadId,
            provider: "omp",
            assembly:
              forgery === "inherit" ? { ...input, knowledgeSourceRunId: "parent-root" } : input,
            allowCreate: true,
            memory: f.memory,
            learningRepository: f.learningRepository,
            projection: f.projection,
            attachKnowledge: f.attachKnowledge,
            targetBinding,
          }),
        ),
      ).rejects.toThrow();
      expect(f.prepareArgs).toEqual([]);
      expect(f.attachKnowledge).not.toHaveBeenCalled();
    },
  );

  it("revalidates native binding even without learning ownership or a manifest", async () => {
    const f = fixture({ row: null });
    const stateDir = await f.stateDirPromise;
    roots.push(stateDir);
    const input = assembly("native-attempt");
    const targetBinding = {
      expertId: "expert-1",
      snapshotId: "snapshot-1",
      projectId: "project-1",
      attemptId: input.rootRunId,
      assemblyId: input.assemblyId,
      verify: async () => false,
    };
    await expect(
      Effect.runPromise(
        prepareRuntimeKnowledge({
          stateDir,
          threadId: input.threadId,
          provider: "omp",
          assembly: input,
          allowCreate: true,
          memory: f.memory,
          learningRepository: f.learningRepository,
          projection: f.projection,
          attachKnowledge: f.attachKnowledge,
          targetBinding,
        }),
      ),
    ).rejects.toThrow();
    await expect(
      Effect.runPromise(
        verifyRuntimeKnowledge({
          threadId: input.threadId,
          expertSession: input.session,
          memory: f.memory,
          learningRepository: f.learningRepository,
          projection: f.projection,
          targetBinding,
        }),
      ),
    ).rejects.toThrow();
  });

  it("keeps concurrent native roles' owner scopes and immutable proof identities separate", async () => {
    const targets = ["expert-1", "expert-2"].map((expertId, index) => {
      const f = fixture({ scope: scope({ expertId }), row: stateRow({ expertId }) });
      const base = assembly(`attempt-${index}`);
      const input = { ...base, session: { ...base.session, expertId } };
      vi.mocked(f.projection.getThreadShellById).mockImplementation((id) =>
        Effect.succeed(
          Option.some({
            id,
            projectId: ProjectId.makeUnsafe("project-1"),
            expertBinding: null,
          } as never),
        ),
      );
      const targetBinding = {
        expertId,
        snapshotId: "snapshot-1",
        projectId: "project-1",
        attemptId: input.rootRunId,
        assemblyId: input.assemblyId,
        verify: async () => true,
      };
      return { f, input, targetBinding };
    });
    const prepared = await Promise.all(
      targets.map(async ({ f, input, targetBinding }) => {
        const stateDir = await f.stateDirPromise;
        roots.push(stateDir);
        const effect = prepareRuntimeKnowledge({
          stateDir,
          threadId: input.threadId,
          provider: "omp",
          assembly: input,
          allowCreate: true,
          memory: f.memory,
          learningRepository: f.learningRepository,
          projection: f.projection,
          attachKnowledge: async (_rootRunId, knowledge) => ({
            ...input,
            session: { ...input.session, knowledge },
          }),
          targetBinding,
        });
        // The effect captures the host identity, not a mutable caller-owned object.
        targetBinding.expertId = "mutated-after-capture";
        return Effect.runPromise(effect);
      }),
    );
    expect(prepared.map((item) => item.session.knowledge?.scope.expertId)).toEqual([
      "expert-1",
      "expert-2",
    ]);
    expect(prepared.map((item) => item.session.knowledge?.rootRunId)).toEqual([
      "attempt-0",
      "attempt-1",
    ]);
    const first = targets[0]!;
    await expect(
      Effect.runPromise(
        verifyRuntimeKnowledge({
          threadId: first.input.threadId,
          expertSession: prepared[0]!.session,
          memory: first.f.memory,
          learningRepository: first.f.learningRepository,
          projection: first.f.projection,
          targetBinding: { ...targets[1]!.targetBinding, expertId: "expert-2" },
        }),
      ),
    ).rejects.toThrow();
    first.f.changeScope(scope({ spaceId: "other-space" }));
    await expect(
      Effect.runPromise(
        verifyRuntimeKnowledge({
          threadId: first.input.threadId,
          expertSession: prepared[0]!.session,
          memory: first.f.memory,
          learningRepository: first.f.learningRepository,
          projection: first.f.projection,
          targetBinding: { ...first.targetBinding, expertId: "expert-1" },
        }),
      ),
    ).rejects.toThrow();
  });

  it("renders native pinned rules without claiming unavailable learning actions", () => {
    const rendered = renderRuntimeKnowledge(manifest(), { learningActionsAvailable: false });
    expect(rendered).toContain("Keep conclusions first.");
    expect(rendered).toContain("no learning-action authority");
    expect(rendered).not.toContain("synara_learning_commit");
    expect(rendered).not.toContain("synara_learning_read");
  });

  it("renders only pinned rules and an index, with facts kept out of the manifest text", () => {
    const pinned = manifest();
    const rendered = renderRuntimeKnowledge(pinned);
    expect(rendered).toContain("Keep conclusions first.");
    expect(rendered).toContain("memory-rule-1@2");
    expect(rendered).toContain("Facts and environment notes are not included");
    expect(rendered).toContain("This Run carries learning epoch 7.");
    expect(rendered).toContain("confirm that exact epoch is still active");
    expect(rendered).not.toContain("private fact body");
    const { hash: _hash, ...manifestBody } = pinned;
    expect(hash(manifestBody)).toBe(pinned.hash);
  });
});
