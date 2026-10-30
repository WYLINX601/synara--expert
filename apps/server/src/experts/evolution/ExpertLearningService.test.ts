import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  MessageId,
  ThreadId,
  TurnId,
  type ExpertDefinition,
  type ExpertLearningEvidence,
  type OrchestrationCommand,
  type OrchestrationMessage,
  type OrchestrationThread,
  type SkillEvolutionEvent,
  type SkillEvolutionRun,
} from "@synara/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { createExpertStore, expertResourceFiles } from "../ExpertStore";
import { createSkillLibraryStore } from "../SkillLibraryStore";
import { createSkillPackageStore } from "../SkillPackageStore";
import { createExpertLearningService } from "./ExpertLearningService";
import type {
  ExpertLearningRepositoryShape,
  LearningCycleRow,
  LearningEvidenceRow,
  LearningStateRow,
} from "./ExpertLearningRepository";
import type { SkillEvolutionRepositoryShape } from "./SkillEvolutionRepository";
import { decodeLearningState, frozenLearningEntriesReader } from "./ExpertLearningState";
import { createSkillEvolutionService, type SkillEvolutionHost } from "./SkillEvolutionService";

const owner = { ownerKind: "session", ownerId: "learning-owner" } as const;
const modelSelection = { provider: "pi", instanceId: "pi-local", model: "test-model" } as const;
const timestamp = "2026-10-31T01:00:00.000Z";
const roots: string[] = [];
const learningServices: Array<ReturnType<typeof createExpertLearningService>> = [];
const evolutionServices: Array<ReturnType<typeof createSkillEvolutionService>> = [];
const libraries: Array<ReturnType<typeof createSkillLibraryStore>> = [];

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

class MemoryLearningRepository implements ExpertLearningRepositoryShape {
  readonly states = new Map<string, LearningStateRow>();
  readonly evidence = new Map<string, LearningEvidenceRow>();
  readonly cycles = new Map<string, LearningCycleRow>();
  cycleReadGate?: { cycleId: string; entered: () => void; release: Promise<void> };

  readState = (ownerId: string, expertId: string) =>
    Effect.succeed(clone(this.states.get(`${ownerId}\0${expertId}`)));
  listStates = () => Effect.succeed([...this.states.values()].map(clone));
  writeState = (row: LearningStateRow, expectedRevision: number) =>
    Effect.sync(() => {
      const key = `${row.ownerId}\0${row.expertId}`;
      const current = this.states.get(key);
      if ((current?.revision ?? 0) !== expectedRevision) throw new Error("自学习设置修订冲突。");
      if (row.revision !== expectedRevision + 1) throw new Error("自学习修订号无效。");
      this.states.set(key, clone(row));
    });
  readEvidence = (evidenceId: string) => Effect.succeed(clone(this.evidence.get(evidenceId)));
  listEvidence = (ownerId: string, expertId: string) =>
    Effect.succeed(
      [...this.evidence.values()]
        .filter((row) => row.ownerId === ownerId && row.expertId === expertId)
        .map(clone),
    );
  writeEvidence = (row: LearningEvidenceRow) =>
    Effect.sync(() => {
      this.evidence.set(row.evidenceId, clone(row));
    });
  readCycle = (cycleId: string) =>
    Effect.tryPromise({
      try: async () => {
        const gate = this.cycleReadGate;
        if (gate?.cycleId === cycleId) {
          delete this.cycleReadGate;
          gate.entered();
          await gate.release;
        }
        return clone(this.cycles.get(cycleId));
      },
      catch: (error) => error,
    });
  listCycles = (ownerId?: string, expertId?: string) =>
    Effect.succeed(
      [...this.cycles.values()]
        .filter((row) => ownerId === undefined || row.ownerId === ownerId)
        .filter((row) => expertId === undefined || row.expertId === expertId)
        .map(clone),
    );
  writeCycle = (row: LearningCycleRow) =>
    Effect.sync(() => {
      this.cycles.set(row.cycleId, clone(row));
    });
}

class CoordinatorHost implements SkillEvolutionHost {
  projectIdentity?: { projectId: string; spaceId?: string | null };
  constructor(
    readonly thread?: OrchestrationThread,
    spaceId?: string | null,
  ) {
    if (thread) {
      this.projectIdentity = {
        projectId: String(thread.projectId),
        ...(spaceId !== undefined ? { spaceId } : {}),
      };
    }
  }
  async readThreads() {
    return this.thread
      ? [
          {
            id: this.thread.id,
            expertBinding: this.thread.expertBinding,
            archivedAt: this.thread.archivedAt,
          },
        ]
      : [];
  }
  async readThread(id: ThreadId) {
    return this.thread?.id === id ? clone(this.thread) : undefined;
  }
  async readProjectIdentity(projectId: string) {
    return this.projectIdentity?.projectId === projectId ? clone(this.projectIdentity) : undefined;
  }
  async readTurns() {
    return [];
  }
  async dispatch() {
    return { accepted: true };
  }
}

function sourceThread(input: {
  expertId: string;
  threadId: string;
  projectId?: string;
  snapshotId?: string;
}): OrchestrationThread {
  return {
    id: ThreadId.makeUnsafe(input.threadId),
    projectId: input.projectId ?? "project-learning",
    expertBinding: {
      expertId: input.expertId,
      revision: 1,
      snapshotId: input.snapshotId ?? `snapshot-${input.expertId}`,
    },
    title: "Learning source",
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    messages: [],
    session: { activeTurnId: null, lastError: null },
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
  } as unknown as OrchestrationThread;
}

function evidence(input: {
  expertId: string;
  threadId: string;
  projectId?: string;
  spaceId?: string;
  snapshotId?: string;
  epoch?: number;
}): ExpertLearningEvidence & { learningEpoch: number } {
  return {
    evidenceId: "evidence-completed-turn",
    ownerId: owner.ownerId,
    expertId: input.expertId,
    threadId: input.threadId,
    turnId: "turn-learning",
    rootRunId: "root-run-learning",
    snapshotId: input.snapshotId ?? `snapshot-${input.expertId}`,
    projectId: input.projectId ?? "project-learning",
    ...(input.spaceId !== undefined ? { spaceId: input.spaceId } : {}),
    modelSelection,
    items: [
      {
        id: "message-learning",
        kind: "message",
        text: "Use verified evidence and keep a decision log.",
        role: "user",
      },
    ],
    coverage: ["user_feedback"],
    completedAt: timestamp,
    updatedAt: timestamp,
    learningEpoch: input.epoch ?? 1,
  };
}

function cycleRow(input: {
  cycleId: string;
  expertId: string;
  evidenceId: string;
  epoch: number;
  status?: string;
}): LearningCycleRow {
  const record = {
    cycleId: input.cycleId,
    ownerId: owner.ownerId,
    expertId: input.expertId,
    evidenceId: input.evidenceId,
    epoch: input.epoch,
    discoveryId: "discovery-learning",
    processed: [],
    targets: [],
    applied: 0,
    attempt: 0,
    status: input.status ?? "applied",
    updatedAt: timestamp,
  };
  return {
    cycleId: record.cycleId,
    ownerId: record.ownerId,
    expertId: record.expertId,
    record: JSON.stringify(record),
    updatedAt: timestamp,
  };
}

function makeSet(input: {
  expertId: string;
  requestId: string;
  expectedRevision: number;
  enabled: boolean;
  harnessKind?: "omp" | "pi";
}) {
  return { action: "learningSet" as const, ...input };
}

async function serviceFixture(input?: {
  expertId?: string;
  provider?: string;
  thread?: OrchestrationThread;
  spaceId?: string | null;
  evolution?: ReturnType<typeof fakeEvolution>;
}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "expert-learning-service-"));
  roots.push(root);
  const stateDir = path.join(root, "state");
  const repository = new MemoryLearningRepository();
  const expertId = input?.expertId ?? "expert-learning-service";
  const expert = {
    id: expertId,
    name: "Learning Expert",
    archived: false,
    preferredProvider: input?.provider ?? "pi",
    skillBindings: [],
  } as unknown as ExpertDefinition;
  const experts = { read: async (id: string) => (id === expertId ? clone(expert) : undefined) };
  const host = new CoordinatorHost(input?.thread, input?.spaceId);
  const evolution = input?.evolution ?? fakeEvolution();
  const service = createExpertLearningService({
    stateDir,
    repository,
    experts: experts as never,
    evolution: () => evolution as never,
    host: () => host,
    now: () => new Date(timestamp),
    pollMs: 60_000,
  });
  learningServices.push(service);
  return { root, stateDir, repository, expert, expertId, host, evolution, service };
}

function fakeEvolution() {
  const calls: Array<Record<string, unknown>> = [];
  const runs = new Map<string, SkillEvolutionRun>();
  const service = {
    calls,
    runs,
    execute: async (request: Record<string, unknown>) => {
      calls.push(request);
      if (request.action === "read") return { run: runs.get(String(request.requestId)) };
      return {};
    },
    startAutomatic: async (request: Record<string, unknown>, context: Record<string, unknown>) => {
      calls.push({ action: "startAutomatic", request, context });
      const run = {
        requestId: request.requestId,
        expertId: request.expertId,
        status: "queued",
        modelSelection: request.modelSelection,
        proposals: [],
      } as unknown as SkillEvolutionRun;
      runs.set(String(request.requestId), run);
      return { run };
    },
  };
  return service;
}

function putEvidence(
  repository: MemoryLearningRepository,
  item: ExpertLearningEvidence & { learningEpoch: number },
) {
  repository.evidence.set(item.evidenceId, {
    evidenceId: item.evidenceId,
    ownerId: item.ownerId,
    expertId: item.expertId,
    threadId: item.threadId,
    turnId: item.turnId,
    record: JSON.stringify(item),
    updatedAt: item.updatedAt,
  });
}

async function enable(fixture: Awaited<ReturnType<typeof serviceFixture>>) {
  const state = await fixture.service.set(
    owner,
    makeSet({
      expertId: fixture.expertId,
      requestId: "enable-learning",
      expectedRevision: 0,
      enabled: true,
    }),
  );
  await fixture.service.tick();
  return state;
}

async function unlock(entry: string): Promise<void> {
  const stat = await fs.lstat(entry).catch(() => undefined);
  if (!stat || stat.isSymbolicLink()) return;
  await fs.chmod(entry, stat.isDirectory() ? 0o700 : 0o600).catch(() => undefined);
  if (stat.isDirectory())
    for (const child of await fs.readdir(entry)) await unlock(path.join(entry, child));
}

function savePreferredProvider(
  experts: ReturnType<typeof createExpertStore>,
  expert: ExpertDefinition,
  preferredProvider: "pi" | "omp",
) {
  return experts.save({
    id: expert.id,
    expectedRevision: expert.revision,
    name: expert.name,
    description: expert.description,
    useCases: expert.useCases,
    persona: expert.persona,
    outputRequirements: expert.outputRequirements,
    skills: expert.skills,
    skillBindings: expert.skillBindings ?? [],
    references: expert.references,
    connections: expert.connections,
    preferredProvider,
  });
}

afterEach(async () => {
  for (const service of learningServices.splice(0)) await service.dispose();
  for (const service of evolutionServices.splice(0)) await service.dispose();
  for (const library of libraries.splice(0)) await library.dispose();
  for (const root of roots.splice(0)) {
    await expertResourceFiles.removeStaging(root);
    await unlock(root);
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("ExpertLearningService", () => {
  it("reads missing state as disabled without creating a row", async () => {
    const fixture = await serviceFixture();

    await expect(fixture.service.read(owner, fixture.expertId)).resolves.toMatchObject({
      expertId: fixture.expertId,
      enabled: false,
      epoch: 0,
      revision: 0,
      status: "disabled",
    });
    expect(fixture.repository.states.size).toBe(0);
  });

  it("serializes settings with revision CAS and makes request IDs idempotent", async () => {
    const fixture = await serviceFixture();
    const first = makeSet({
      expertId: fixture.expertId,
      requestId: "enable-same-request",
      expectedRevision: 0,
      enabled: true,
    });

    const initial = await fixture.service.set(owner, first);
    const replay = await fixture.service.set(owner, first);
    expect(replay).toEqual(initial);
    await expect(fixture.service.set(owner, makeSet({ ...first, enabled: false }))).rejects.toThrow(
      /同一设置请求 ID/u,
    );

    const outcomes = await Promise.allSettled([
      fixture.service.set(
        owner,
        makeSet({
          expertId: fixture.expertId,
          requestId: "competing-settings-a",
          expectedRevision: 1,
          enabled: false,
        }),
      ),
      fixture.service.set(
        owner,
        makeSet({
          expertId: fixture.expertId,
          requestId: "competing-settings-b",
          expectedRevision: 1,
          enabled: false,
        }),
      ),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(1);
    await expect(
      fixture.service.set(
        owner,
        makeSet({
          expertId: fixture.expertId,
          requestId: "stale-settings",
          expectedRevision: 1,
          enabled: false,
        }),
      ),
    ).rejects.toThrow(/设置已改变/u);
    expect(fixture.repository.states.size).toBe(1);
  });

  it("enables only the Expert's configured Pi or OMP Harness", async () => {
    const unsupported = await serviceFixture({ provider: "codex" });
    await expect(
      unsupported.service.set(
        owner,
        makeSet({
          expertId: unsupported.expertId,
          requestId: "no-provider-fallback",
          expectedRevision: 0,
          enabled: true,
        }),
      ),
    ).rejects.toThrow(/不会自动切换/u);
    expect(unsupported.repository.states.size).toBe(0);

    const pi = await serviceFixture({ provider: "pi" });
    await expect(
      pi.service.set(
        owner,
        makeSet({
          expertId: pi.expertId,
          requestId: "reject-provider-switch",
          expectedRevision: 0,
          enabled: true,
          harnessKind: "omp",
        }),
      ),
    ).rejects.toThrow(/不会自动切换/u);
    await expect(
      pi.service.set(
        owner,
        makeSet({
          expertId: pi.expertId,
          requestId: "enable-configured-pi",
          expectedRevision: 0,
          enabled: true,
          harnessKind: "pi",
        }),
      ),
    ).resolves.toMatchObject({ enabled: true, harnessKind: "pi" });

    const omp = await serviceFixture({ provider: "omp" });
    await expect(
      omp.service.set(
        owner,
        makeSet({
          expertId: omp.expertId,
          requestId: "enable-configured-omp",
          expectedRevision: 0,
          enabled: true,
          harnessKind: "omp",
        }),
      ),
    ).resolves.toMatchObject({ enabled: true, harnessKind: "omp" });
  });

  it("keeps the active Harness fixed but allows an explicitly saved provider after disable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "expert-learning-provider-change-"));
    roots.push(root);
    const stateDir = path.join(root, "state");
    const repository = new MemoryLearningRepository();
    const experts = createExpertStore(stateDir);
    const expert = await experts.save({
      name: "Provider change learning Expert",
      description: "",
      useCases: "",
      persona: "Expert",
      outputRequirements: "",
      skills: [],
      skillBindings: [],
      references: [],
      connections: [],
      preferredProvider: "pi",
    });
    const service = createExpertLearningService({
      stateDir,
      repository,
      experts,
      evolution: () => fakeEvolution() as never,
      host: () => new CoordinatorHost(),
      now: () => new Date(timestamp),
      pollMs: 60_000,
    });
    learningServices.push(service);

    const enabledPi = await service.set(
      owner,
      makeSet({
        expertId: expert.id,
        requestId: "provider-change-enable-pi",
        expectedRevision: 0,
        enabled: true,
        harnessKind: "pi",
      }),
    );
    expect(enabledPi).toMatchObject({ enabled: true, harnessKind: "pi", epoch: 1 });

    const savedWhileActive = await experts.read(expert.id);
    if (!savedWhileActive) throw new Error("Expert disappeared during provider change test");
    await savePreferredProvider(experts, savedWhileActive, "omp");
    await expect(
      service.set(
        owner,
        makeSet({
          expertId: expert.id,
          requestId: "provider-change-reject-active-implicit-switch",
          expectedRevision: 1,
          enabled: true,
        }),
      ),
    ).rejects.toThrow(/不会自动切换/u);

    const disabled = await service.set(
      owner,
      makeSet({
        expertId: expert.id,
        requestId: "provider-change-disable-pi",
        expectedRevision: 1,
        enabled: false,
      }),
    );
    expect(disabled).toMatchObject({ enabled: false, harnessKind: "pi", epoch: 2 });

    const savedWhileDisabled = await experts.read(expert.id);
    if (!savedWhileDisabled) throw new Error("Expert disappeared while learning was disabled");
    await savePreferredProvider(experts, savedWhileDisabled, "omp");
    await expect(
      service.set(
        owner,
        makeSet({
          expertId: expert.id,
          requestId: "provider-change-enable-omp",
          expectedRevision: 2,
          enabled: true,
          harnessKind: "omp",
        }),
      ),
    ).resolves.toMatchObject({ enabled: true, harnessKind: "omp", epoch: 3 });
  });

  it("keeps a disabled shared Skill pinned across library updates and metadata-only binding edits", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "expert-learning-reconciler-pins-"));
    roots.push(root);
    const stateDir = path.join(root, "state");
    const repository = new MemoryLearningRepository();
    const library = createSkillLibraryStore(stateDir);
    libraries.push(library);
    const experts = createExpertStore(stateDir);
    const oldBody =
      "---\nname: shared-pinned-workflow\ndescription: Shared workflow\n---\nOriginal pinned instructions.\n";
    const skill = (
      await library.execute({
        action: "create",
        requestId: "create-shared-pinned-workflow",
        name: "Shared pinned workflow",
        body: oldBody,
        tags: [],
      })
    ).skill!;
    const initialBinding = { skillId: skill.skillId, enabled: true };
    const expert = await experts.save({
      name: "Frozen shared source Expert",
      description: "",
      useCases: "",
      persona: "Expert",
      outputRequirements: "",
      skills: [],
      skillBindings: [initialBinding],
      references: [],
      connections: [],
      preferredProvider: "pi",
    });
    const service = createExpertLearningService({
      stateDir,
      repository,
      experts,
      evolution: () => fakeEvolution() as never,
      host: () => new CoordinatorHost(),
      now: () => new Date(timestamp),
      pollMs: 60_000,
    });
    learningServices.push(service);

    await service.set(
      owner,
      makeSet({
        expertId: expert.id,
        requestId: "pin-test-enable",
        expectedRevision: 0,
        enabled: true,
        harnessKind: "pi",
      }),
    );
    await service.set(
      owner,
      makeSet({
        expertId: expert.id,
        requestId: "pin-test-disable",
        expectedRevision: 1,
        enabled: false,
      }),
    );
    await service.start();

    const firstRow = repository.states.get(`${owner.ownerId}\0${expert.id}`)!;
    const firstRecord = decodeLearningState(firstRow);
    const firstFrozen = firstRecord.frozenBindings?.[0]?.entries[0];
    expect(firstFrozen?.packageId).toBe(skill.packageId);
    expect(firstFrozen?.path).toBeTruthy();

    const newBody = oldBody.replace(
      "Original pinned instructions.",
      "Updated shared instructions.",
    );
    const updatedSkill = (
      await library.execute({
        action: "save",
        skillId: skill.skillId,
        expectedRevision: skill.revision,
        name: skill.name,
        tags: skill.tags,
        changes: [{ path: skill.entryPath, content: Buffer.from(newBody).toString("base64") }],
      })
    ).skill!;
    expect(updatedSkill.packageId).not.toBe(skill.packageId);

    const currentExpert = await experts.read(expert.id);
    if (!currentExpert) throw new Error("Expert disappeared after shared Skill update");
    const afterSourceUpdate = await frozenLearningEntriesReader(repository)(
      expert.id,
      currentExpert.skillBindings ?? [],
    );
    expect(afterSourceUpdate?.[0]?.packageId).toBe(skill.packageId);
    await expect(fs.readFile(afterSourceUpdate![0]!.path, "utf8")).resolves.toContain(
      "Original pinned instructions.",
    );
    await expect(fs.readFile(afterSourceUpdate![0]!.path, "utf8")).resolves.not.toContain(
      "Updated shared instructions.",
    );

    const bindingUpdate = await library.execute({
      action: "bindings",
      operation: "set",
      expertId: expert.id,
      expectedRevision: currentExpert.revision,
      requestId: "pin-test-delivery-metadata-only",
      bindings: [
        {
          ...initialBinding,
          allowEvolution: true,
          resourceMode: "run-private",
        },
      ],
    });
    expect(bindingUpdate.bindingResult?.status).toBe("applied");

    const editedExpert = await experts.read(expert.id);
    if (!editedExpert) throw new Error("Expert disappeared after binding metadata update");
    const afterMetadataEdit = await frozenLearningEntriesReader(repository)(
      expert.id,
      editedExpert.skillBindings ?? [],
    );
    const recordAfterMetadataEdit = decodeLearningState(
      repository.states.get(`${owner.ownerId}\0${expert.id}`)!,
    );
    expect(recordAfterMetadataEdit.frozenBindings?.[0]?.binding).toMatchObject({
      skillId: skill.skillId,
      allowEvolution: true,
      resourceMode: "run-private",
    });
    expect(afterMetadataEdit?.[0]).toMatchObject({
      packageId: skill.packageId,
      resourceMode: "run-private",
    });
    await expect(fs.readFile(afterMetadataEdit![0]!.path, "utf8")).resolves.toContain(
      "Original pinned instructions.",
    );
  });

  it("rejects authorization that crosses close and re-enable while an async check is pending", async () => {
    const expertId = "expert-authorize-race";
    const thread = sourceThread({ expertId, threadId: "thread-authorize-race" });
    const fixture = await serviceFixture({ expertId, thread });
    const source = evidence({ expertId: fixture.expertId, threadId: String(thread.id), epoch: 1 });
    await enable(fixture);
    putEvidence(fixture.repository, source);
    const cycle = cycleRow({
      cycleId: "cycle-authorize-race",
      expertId: fixture.expertId,
      evidenceId: source.evidenceId,
      epoch: 1,
      status: "discovery",
    });
    fixture.repository.cycles.set(cycle.cycleId, cycle);
    const entered = deferred();
    const release = deferred();
    fixture.repository.cycleReadGate = {
      cycleId: cycle.cycleId,
      entered: entered.resolve,
      release: release.promise,
    };
    const request = {
      requestId: "discovery-learning",
      expertId: fixture.expertId,
      learningEpoch: 1,
      cycleId: cycle.cycleId,
      modelSelection,
    } as unknown as SkillEvolutionRun;
    const pending = fixture.service.authorize(owner, request);
    await entered.promise;

    const disabled = await fixture.service.set(
      owner,
      makeSet({
        expertId: fixture.expertId,
        requestId: "close-racing-cycle",
        expectedRevision: 1,
        enabled: false,
      }),
    );
    expect(disabled.epoch).toBe(2);
    const reenabled = await fixture.service.set(
      owner,
      makeSet({
        expertId: fixture.expertId,
        requestId: "re-enable-new-epoch",
        expectedRevision: 2,
        enabled: true,
      }),
    );
    expect(reenabled.epoch).toBe(3);

    release.resolve();
    await expect(pending).rejects.toThrow(/授权在检查期间已改变|周期已结束/u);
  });

  it("rejects late authorization after the source Project moves to another Space", async () => {
    const expertId = "expert-project-space-authorize";
    const thread = sourceThread({ expertId, threadId: "thread-project-space-authorize" });
    const fixture = await serviceFixture({ expertId, thread, spaceId: "space-a" });
    const source = evidence({
      expertId,
      threadId: String(thread.id),
      spaceId: "space-a",
      epoch: 1,
    });
    await enable(fixture);
    putEvidence(fixture.repository, source);
    const cycle = cycleRow({
      cycleId: "cycle-project-space-authorize",
      expertId,
      evidenceId: source.evidenceId,
      epoch: 1,
      status: "discovery",
    });
    fixture.repository.cycles.set(cycle.cycleId, cycle);
    const entered = deferred();
    const release = deferred();
    fixture.repository.cycleReadGate = {
      cycleId: cycle.cycleId,
      entered: entered.resolve,
      release: release.promise,
    };
    const request = {
      requestId: "discovery-learning",
      expertId,
      learningEpoch: 1,
      cycleId: cycle.cycleId,
      modelSelection,
    } as unknown as SkillEvolutionRun;

    const pending = fixture.service.authorize(owner, request);
    await entered.promise;
    fixture.host.projectIdentity = { projectId: "project-learning", spaceId: "space-b" };
    release.resolve();

    await expect(pending).rejects.toThrow(/Project\/Space.*改变/u);
  });

  it.each(["failed", "cancelled", "applied", "no_change"])(
    "rejects formal mutation replay for a terminal %s cycle",
    async (status) => {
      const expertId = "expert-terminal-cycle";
      const thread = sourceThread({ expertId, threadId: "thread-terminal-cycle" });
      const fixture = await serviceFixture({ expertId, thread });
      await enable(fixture);
      const source = evidence({ expertId, threadId: String(thread.id) });
      putEvidence(fixture.repository, source);
      const cycle = cycleRow({
        cycleId: "terminal-cycle",
        expertId,
        evidenceId: source.evidenceId,
        epoch: 1,
        status,
      });
      fixture.repository.cycles.set(cycle.cycleId, cycle);
      await expect(
        fixture.service.authorize(owner, {
          requestId: "discovery-learning",
          expertId,
          learningEpoch: 1,
          cycleId: cycle.cycleId,
          modelSelection,
        } as SkillEvolutionRun),
      ).rejects.toThrow(/周期已结束/u);
    },
  );

  it("deduplicates completed evidence to one cycle and one native discovery request", async () => {
    const expertId = "expert-learning-dedup";
    const thread = sourceThread({ expertId, threadId: "thread-learning-dedup" });
    const evolution = fakeEvolution();
    const fixture = await serviceFixture({ expertId, thread, evolution });
    await enable(fixture);
    const item = evidence({ expertId: fixture.expertId, threadId: "thread-learning-dedup" });
    putEvidence(fixture.repository, item);
    putEvidence(fixture.repository, item);

    await fixture.service.tick(); // registers the deterministic cycle
    await fixture.service.tick(); // starts the native discovery request
    await fixture.service.tick();
    await fixture.service.tick();

    expect(fixture.repository.cycles.size).toBe(1);
    expect(evolution.calls.filter((call) => call.action === "startAutomatic")).toHaveLength(1);
    expect(evolution.calls.filter((call) => call.action === "startAutomatic")[0]).toMatchObject({
      context: { cycleId: expect.any(String), epoch: 1, evidence: { evidenceId: item.evidenceId } },
    });
  });

  it.each(["snapshot", "project"] as const)(
    "rejects a source whose frozen thread %s no longer matches the evidence",
    async (changedField) => {
      const expertId = "expert-learning-source-identity";
      const thread = sourceThread({
        expertId,
        threadId: "thread-learning-source-identity",
        ...(changedField === "snapshot"
          ? { snapshotId: "snapshot-changed" }
          : { projectId: "project-changed" }),
      });
      const evolution = fakeEvolution();
      const fixture = await serviceFixture({ expertId, thread, evolution });
      await enable(fixture);
      const item = evidence({ expertId, threadId: "thread-learning-source-identity" });
      putEvidence(fixture.repository, item);

      await fixture.service.tick();
      await fixture.service.tick();

      expect(evolution.calls.filter((call) => call.action === "startAutomatic")).toHaveLength(0);
      expect(JSON.parse(fixture.repository.cycles.values().next().value!.record)).toMatchObject({
        status: "failed",
        error: expect.stringContaining(
          changedField === "project" ? "Project/Space" : "来源归属已改变",
        ),
      });
    },
  );

  it.each([
    { name: "Space A to B", evidenceSpace: "space-a", currentSpace: "space-b" },
    { name: "unassigned to Space B", evidenceSpace: undefined, currentSpace: "space-b" },
  ])(
    "rejects queued evidence after its Project moves from $name before dispatch",
    async (change) => {
      const expertId = "expert-project-space-queued";
      const thread = sourceThread({ expertId, threadId: "thread-project-space-queued" });
      const fixture = await serviceFixture({
        expertId,
        thread,
        ...(change.evidenceSpace !== undefined ? { spaceId: change.evidenceSpace } : {}),
      });
      await enable(fixture);
      const item = evidence({
        expertId,
        threadId: String(thread.id),
        ...(change.evidenceSpace !== undefined ? { spaceId: change.evidenceSpace } : {}),
      });
      putEvidence(fixture.repository, item);

      await fixture.service.tick();
      expect(JSON.parse(fixture.repository.cycles.values().next().value!.record)).toMatchObject({
        status: "queued",
      });
      fixture.host.projectIdentity = {
        projectId: "project-learning",
        spaceId: change.currentSpace,
      };
      await fixture.service.tick();

      expect(
        fixture.evolution.calls.filter((call) => call.action === "startAutomatic"),
      ).toHaveLength(0);
      expect(JSON.parse(fixture.repository.cycles.values().next().value!.record)).toMatchObject({
        status: "failed",
        error: expect.stringContaining("Project/Space"),
      });
    },
  );

  it("ends no_change discovery without scheduling generation or applying a Skill", async () => {
    const expertId = "expert-learning-no-change";
    const thread = sourceThread({ expertId, threadId: "thread-learning-no-change" });
    const evolution = fakeEvolution();
    const fixture = await serviceFixture({ expertId, thread, evolution });
    await enable(fixture);
    const item = evidence({ expertId, threadId: "thread-learning-no-change" });
    putEvidence(fixture.repository, item);
    await fixture.service.tick();
    await fixture.service.tick();
    const discoveryId = String(
      (
        evolution.calls.find((call) => call.action === "startAutomatic")?.request as Record<
          string,
          unknown
        >
      )?.requestId,
    );
    evolution.runs.set(discoveryId, {
      requestId: discoveryId,
      expertId,
      status: "no_change",
      modelSelection,
      proposals: [],
    } as unknown as SkillEvolutionRun);

    await fixture.service.tick();

    expect(fixture.repository.cycles.size).toBe(1);
    expect(JSON.parse(fixture.repository.cycles.values().next().value!.record).status).toBe(
      "no_change",
    );
    expect(
      evolution.calls.filter((call) => ["generate", "apply"].includes(String(call.action))),
    ).toEqual([]);
  });
});

function evolutionRepository() {
  const rows = new Map<
    string,
    { requestId: string; expertId: string; taskThreadId: string; record: string; updatedAt: string }
  >();
  const events = new Map<string, SkillEvolutionEvent>();
  const repository: SkillEvolutionRepositoryShape = {
    read: (id) => Effect.succeed(clone(rows.get(id))),
    list: (expertId) =>
      Effect.succeed(
        [...rows.values()].filter((row) => !expertId || row.expertId === expertId).map(clone),
      ),
    write: (row) => Effect.sync(() => rows.set(row.requestId, clone(row))),
    appendEvent: (event) =>
      Effect.sync(() => {
        events.set(event.eventId, event);
      }),
    events: () => Effect.succeed([...events.values()]),
    execution: () => Effect.succeed(undefined),
  };
  return { repository, events };
}

function evolutionMessage(
  id: string,
  role: "user" | "assistant",
  text: string,
  turnId: string | null,
): OrchestrationMessage {
  return {
    id: MessageId.makeUnsafe(id),
    role,
    text,
    turnId: turnId === null ? null : TurnId.makeUnsafe(turnId),
    streaming: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  } as OrchestrationMessage;
}

class EvolutionHost implements SkillEvolutionHost {
  readonly threads = new Map<string, OrchestrationThread>();
  readonly turns = new Map<
    string,
    Array<{
      turnId: TurnId | null;
      state: string;
      completedAt: string | null;
      pendingMessageId: MessageId;
    }>
  >();
  readonly dispatches: OrchestrationCommand[] = [];
  #turn = 0;

  addSource(thread: OrchestrationThread, turnId: string, userId: string, assistantId: string) {
    this.threads.set(String(thread.id), thread);
    this.turns.set(String(thread.id), [
      {
        turnId: TurnId.makeUnsafe(turnId),
        state: "completed",
        completedAt: timestamp,
        pendingMessageId: MessageId.makeUnsafe(userId),
      },
    ]);
  }
  async readThreads() {
    return [...this.threads.values()].map((thread) => ({
      id: thread.id,
      expertBinding: thread.expertBinding,
      archivedAt: thread.archivedAt,
    }));
  }
  async readThread(id: ThreadId) {
    const thread = this.threads.get(String(id));
    return thread ? clone(thread) : undefined;
  }
  async readTurns(id: ThreadId) {
    return clone(this.turns.get(String(id)) ?? []);
  }
  async dispatch(command: OrchestrationCommand) {
    this.dispatches.push(clone(command));
    if (command.type === "thread.create") {
      if (!this.threads.has(String(command.threadId))) {
        this.threads.set(String(command.threadId), {
          id: command.threadId,
          projectId: command.projectId,
          expertBinding: null,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          latestTurn: null,
          messages: [],
          session: { activeTurnId: null, lastError: null },
          createdAt: timestamp,
          updatedAt: timestamp,
          archivedAt: null,
        } as unknown as OrchestrationThread);
        this.turns.set(String(command.threadId), []);
      }
      return { accepted: true };
    }
    if (command.type === "thread.turn.start") {
      const thread = this.threads.get(String(command.threadId));
      if (!thread) throw new Error("missing native task thread");
      const turnId = TurnId.makeUnsafe(`native-turn-${++this.#turn}`);
      this.turns.get(String(command.threadId))!.push({
        turnId,
        state: "running",
        completedAt: null,
        pendingMessageId: command.message.messageId,
      });
      this.threads.set(String(command.threadId), {
        ...thread,
        messages: [
          ...thread.messages,
          evolutionMessage(
            String(command.message.messageId),
            "user",
            command.message.text,
            String(turnId),
          ),
        ],
      } as OrchestrationThread);
    }
    return { accepted: true };
  }
  complete(threadId: string, text: string) {
    const turns = this.turns.get(threadId)!;
    const turn = turns.at(-1)!;
    turn.state = "completed";
    turn.completedAt = timestamp;
    const thread = this.threads.get(threadId)!;
    this.threads.set(threadId, {
      ...thread,
      messages: [
        ...thread.messages,
        evolutionMessage(`assistant-${threadId}`, "assistant", text, String(turn.turnId)),
      ],
    } as OrchestrationThread);
  }
}

function opportunityText(threadId: string, messageId: string) {
  return JSON.stringify({
    action: "opportunities",
    opportunities: [
      {
        name: "Reusable decision log",
        reason: "The current task contains a repeatable procedure.",
        outcomes: ["Keep verified evidence before decisions."],
        evidence: [{ threadId, messageId, quote: "Verified evidence: keep a decision log." }],
      },
    ],
  });
}

function proposalText(threadId: string, messageId: string) {
  return JSON.stringify({
    action: "proposals",
    proposals: [
      {
        name: "Decision log workflow",
        summary: "Use verified evidence for each decision.",
        evidence: [{ threadId, messageId, quote: "Verified evidence: keep a decision log." }],
        files: [
          {
            path: "SKILL.md",
            text: "---\nname: decision-log\ndescription: Keep decisions evidence based\n---\nRecord source evidence before deciding.\n",
          },
        ],
      },
    ],
  });
}

async function automaticFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "expert-learning-adoption-"));
  roots.push(root);
  const stateDir = path.join(root, "state");
  const ownerId = "automatic-adoption-owner";
  const expertId = "automatic-adoption-expert";
  const experts = createExpertStore(stateDir);
  const library = createSkillLibraryStore(stateDir);
  libraries.push(library);
  const savedExpert = await experts.save({
    id: expertId,
    name: "Automatic adoption Expert",
    description: "Test",
    useCases: "Test",
    persona: "Use evidence.",
    outputRequirements: "State sources.",
    skills: [],
    skillBindings: [],
    references: [],
    connections: [],
    preferredProvider: "pi",
  });
  const host = new EvolutionHost();
  const sourceThreadId = "thread-automatic-adoption-source";
  const sourceTurnId = "turn-automatic-adoption-source";
  const sourceUserId = "user-automatic-adoption-source";
  const sourceAssistantId = "assistant-automatic-adoption-source";
  const source = sourceThread({ expertId, threadId: sourceThreadId });
  host.threads.set(sourceThreadId, {
    ...source,
    messages: [
      evolutionMessage(sourceUserId, "user", "Please improve this procedure.", null),
      evolutionMessage(
        sourceAssistantId,
        "assistant",
        "Verified evidence: keep a decision log.",
        sourceTurnId,
      ),
    ],
  } as OrchestrationThread);
  host.turns.set(sourceThreadId, [
    {
      turnId: TurnId.makeUnsafe(sourceTurnId),
      state: "completed",
      completedAt: timestamp,
      pendingMessageId: MessageId.makeUnsafe(sourceUserId),
    },
  ]);
  const { repository, events } = evolutionRepository();
  const service = createSkillEvolutionService({
    stateDir,
    ownerId,
    repository,
    experts,
    library,
    packages: createSkillPackageStore(stateDir),
    host,
    now: () => new Date(timestamp),
    authorizeAutomatic: async () => undefined,
  });
  evolutionServices.push(service);
  const sourceEvidence = {
    evidenceId: "evidence-automatic-adoption",
    ownerId,
    expertId,
    threadId: sourceThreadId,
    turnId: sourceTurnId,
    rootRunId: "root-run-automatic-adoption",
    snapshotId: `snapshot-${expertId}`,
    projectId: "project-learning",
    modelSelection,
    items: [
      {
        id: sourceUserId,
        kind: "message" as const,
        role: "user" as const,
        text: "Please improve this procedure.",
      },
      {
        id: sourceAssistantId,
        kind: "message" as const,
        role: "assistant" as const,
        text: "Verified evidence: keep a decision log.",
      },
    ],
    coverage: ["user_feedback"],
    completedAt: timestamp,
    updatedAt: timestamp,
    learningEpoch: 1,
  } as ExpertLearningEvidence & { learningEpoch: number };
  return {
    root,
    stateDir,
    ownerId,
    expertId,
    experts,
    library,
    host,
    repository,
    events,
    service,
    savedExpert,
    sourceThreadId,
    sourceAssistantId,
    sourceEvidence,
  };
}

async function startAutomaticDiscovery(
  fixture: Awaited<ReturnType<typeof automaticFixture>>,
  requestId: string,
) {
  const response = await fixture.service.startAutomatic(
    {
      action: "start",
      requestId,
      expertId: fixture.expertId,
      sources: [
        {
          threadId: ThreadId.makeUnsafe(fixture.sourceThreadId),
          turnId: TurnId.makeUnsafe("turn-automatic-adoption-source"),
        },
      ],
      modelSelection,
    },
    {
      cycleId: `cycle-${requestId}`,
      epoch: 1,
      evidence: fixture.sourceEvidence,
    },
  );
  if (!response.run) throw new Error("automatic discovery did not start");
  return response.run;
}

describe("automatic adoption follow-up permission", () => {
  it("grants follow-up evolution permission to an automatically created Expert Skill", async () => {
    const fixture = await automaticFixture();
    const discovery = await startAutomaticDiscovery(fixture, "automatic-adoption-discovery");
    fixture.host.complete(
      discovery.taskThreadId!,
      opportunityText(fixture.sourceThreadId, fixture.sourceAssistantId),
    );
    const ready = (
      await fixture.service.execute({ action: "read", requestId: discovery.requestId })
    ).run!;
    const opportunity = ready.opportunities![0]!;
    const generation = (
      await fixture.service.execute({
        action: "generate",
        requestId: "automatic-adoption-generation",
        discoveryRequestId: discovery.requestId,
        opportunityId: opportunity.opportunityId,
        expectedDigest: opportunity.digest,
      })
    ).run!;
    fixture.host.complete(
      generation.taskThreadId!,
      proposalText(fixture.sourceThreadId, fixture.sourceAssistantId),
    );
    const proposalReady = (
      await fixture.service.execute({ action: "read", requestId: generation.requestId })
    ).run!;
    const proposal = proposalReady.proposals[0]!;
    const applied = await fixture.service.execute({
      action: "apply",
      requestId: generation.requestId,
      proposalId: proposal.proposalId,
      expectedDigest: proposal.digest,
      operationId: "automatic-adoption-operation",
    });

    expect(applied.run?.proposals[0]?.status).toBe("applied");
    expect(applied.skill).toBeDefined();
    expect((await fixture.experts.read(fixture.expertId))?.skillBindings).toEqual([
      { skillId: applied.skill!.skillId, enabled: true, allowEvolution: true },
    ]);
    expect(fixture.savedExpert.revision).toBe(1);
    expect(fixture.events.size).toBe(1);
  });

  it("records automatic no_change without publishing or binding a Skill", async () => {
    const fixture = await automaticFixture();
    const before = await fixture.experts.read(fixture.expertId);
    const discovery = await startAutomaticDiscovery(fixture, "automatic-no-change-discovery");
    fixture.host.complete(
      discovery.taskThreadId!,
      JSON.stringify({ action: "no_change", reason: "The current procedure is already covered." }),
    );

    const finished = (
      await fixture.service.execute({
        action: "read",
        requestId: discovery.requestId,
      })
    ).run!;

    expect(finished.status).toBe("no_change");
    expect(finished.opportunities).toEqual([]);
    expect(finished.proposals).toEqual([]);
    expect((await fixture.library.execute({ action: "list" })).items).toEqual([]);
    expect((await fixture.experts.read(fixture.expertId))?.revision).toBe(before?.revision);
    expect(fixture.events.size).toBe(0);
    expect(
      fixture.host.dispatches.filter((command) => command.type === "thread.turn.start"),
    ).toHaveLength(1);
  });
});
