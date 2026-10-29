import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationMessage,
  type OrchestrationThread,
  type SkillEvolutionRun,
} from "@synara/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExpertStore, expertResourceFiles } from "../ExpertStore";
import { createSkillLibraryStore, readSkillLibraryDefinitions } from "../SkillLibraryStore";
import { createSkillPackageStore } from "../SkillPackageStore";
import type { SkillEvolutionRepositoryShape } from "./SkillEvolutionRepository";
import { createSkillEvolutionService, type SkillEvolutionHost } from "./SkillEvolutionService";

const roots: string[] = [];
const services: Array<ReturnType<typeof createSkillEvolutionService>> = [];
const libraries: Array<ReturnType<typeof createSkillLibraryStore>> = [];
const ownerId = "skill-evolution-owner";
const createdAt = "2026-10-29T00:00:00.000Z";
const modelSelection = {
  provider: "pi",
  instanceId: "pi",
  model: "openai/gpt-5.5",
} as const;
const entry = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: ${name} workflow\n---\n${body}\n`;
const clone = <T>(value: T): T =>
  value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);

async function unlock(entryPath: string): Promise<void> {
  const stat = await fs.lstat(entryPath).catch(() => undefined);
  if (!stat || stat.isSymbolicLink()) return;
  await fs.chmod(entryPath, stat.isDirectory() ? 0o700 : 0o600).catch(() => undefined);
  if (stat.isDirectory())
    for (const child of await fs.readdir(entryPath)) await unlock(path.join(entryPath, child));
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const service of services.splice(0)) await service.dispose();
  for (const library of libraries.splice(0)) await library.dispose();
  for (const root of roots.splice(0)) {
    await expertResourceFiles.removeStaging(root);
    await unlock(root);
    await fs.rm(root, { recursive: true, force: true });
  }
});

function makeRepository(): {
  readonly repository: SkillEvolutionRepositoryShape;
  readonly rows: Map<
    string,
    { requestId: string; expertId: string; taskThreadId: string; record: string; updatedAt: string }
  >;
  readonly events: Map<string, import("@synara/contracts").SkillEvolutionEvent>;
} {
  const rows = new Map<
    string,
    {
      requestId: string;
      expertId: string;
      taskThreadId: string;
      record: string;
      updatedAt: string;
    }
  >();
  const events = new Map<string, import("@synara/contracts").SkillEvolutionEvent>();
  const repository: SkillEvolutionRepositoryShape = {
    read: (requestId) => Effect.succeed(clone(rows.get(requestId))),
    list: (expertId) =>
      Effect.succeed(
        [...rows.values()]
          .filter((row) => expertId === undefined || row.expertId === expertId)
          .map(clone),
      ),
    write: (row) =>
      Effect.sync(() => {
        rows.set(row.requestId, clone(row));
      }),
    appendEvent: (event) =>
      Effect.sync(() => {
        events.set(event.eventId, clone(event));
      }),
    events: () => Effect.succeed([...events.values()].map(clone)),
    execution: () => Effect.succeed(undefined),
  };
  return { repository, rows, events };
}

function message(
  id: string,
  role: "user" | "assistant",
  text: string,
  turnId: string | null,
  options: { streaming?: boolean } = {},
): OrchestrationMessage {
  return {
    id: MessageId.makeUnsafe(id),
    role,
    text,
    turnId: turnId === null ? null : TurnId.makeUnsafe(turnId),
    streaming: options.streaming ?? false,
    createdAt,
    updatedAt: createdAt,
  } as OrchestrationMessage;
}

function sourceThread(input: {
  id: string;
  expertId: string;
  turns: Array<{
    turnId: string;
    pendingMessageId: string;
    state?: string;
    completedAt?: string | null;
  }>;
  messages: OrchestrationMessage[];
}): OrchestrationThread {
  const binding = {
    expertId: input.expertId,
    revision: 1,
    snapshotId: `snapshot-${input.expertId}`,
  };
  return {
    id: ThreadId.makeUnsafe(input.id),
    projectId: "project-skill-evolution" as OrchestrationThread["projectId"],
    expertBinding: binding,
    title: input.id,
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    messages: input.messages,
    session: { activeTurnId: null, lastError: null },
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
  } as unknown as OrchestrationThread;
}

class FakeHost implements SkillEvolutionHost {
  readonly threads = new Map<string, OrchestrationThread>();
  readonly turns = new Map<
    string,
    Array<{
      turnId: ReturnType<typeof TurnId.makeUnsafe> | null;
      state: string;
      completedAt: string | null;
      pendingMessageId: ReturnType<typeof MessageId.makeUnsafe>;
    }>
  >();
  readonly dispatches: OrchestrationCommand[] = [];
  #nextTurn = 1;

  addSource(
    thread: OrchestrationThread,
    turns: Array<{
      turnId: string;
      pendingMessageId: string;
      state?: string;
      completedAt?: string | null;
    }>,
  ) {
    this.threads.set(thread.id, thread);
    this.turns.set(
      thread.id,
      turns.map((turn) => ({
        turnId: TurnId.makeUnsafe(turn.turnId),
        pendingMessageId: MessageId.makeUnsafe(turn.pendingMessageId),
        state: turn.state ?? "completed",
        completedAt: turn.completedAt === undefined ? createdAt : turn.completedAt,
      })),
    );
  }

  async readThreads() {
    return [...this.threads.values()].map((thread) => ({
      id: thread.id,
      expertBinding: thread.expertBinding,
      archivedAt: thread.archivedAt,
    }));
  }

  async readThread(id: ThreadId) {
    const thread = this.threads.get(id);
    return thread ? clone(thread) : undefined;
  }

  async readTurns(id: ThreadId) {
    return clone(this.turns.get(id) ?? []);
  }

  markLatestTurnPending(threadId: string) {
    const turns = this.turns.get(threadId)!;
    const latest = turns.at(-1)!;
    turns[turns.length - 1] = { ...latest, turnId: null, state: "pending", completedAt: null };
  }

  markNativeStartupFailure(threadId: string, lastError: string) {
    this.markLatestTurnPending(threadId);
    const thread = this.threads.get(threadId)!;
    this.threads.set(threadId, {
      ...thread,
      session: {
        ...thread.session,
        activeTurnId: null,
        status: "error",
        lastError,
      },
    } as OrchestrationThread);
  }

  async dispatch(command: OrchestrationCommand) {
    this.dispatches.push(clone(command));
    if (command.type === "thread.create") {
      if (!this.threads.has(command.threadId)) {
        this.threads.set(command.threadId, {
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
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
          archivedAt: null,
        } as unknown as OrchestrationThread);
        this.turns.set(command.threadId, []);
      }
      return { accepted: true };
    }
    if (command.type === "thread.turn.start") {
      const thread = this.threads.get(command.threadId);
      if (!thread) throw new Error("fake host has no task thread");
      const turnId = TurnId.makeUnsafe(`fake-turn-${this.#nextTurn++}`);
      this.turns.get(command.threadId)!.push({
        turnId,
        state: "running",
        completedAt: null,
        pendingMessageId: command.message.messageId,
      });
      this.threads.set(command.threadId, {
        ...thread,
        messages: [
          ...thread.messages,
          message(command.message.messageId, "user", command.message.text, turnId),
        ],
      } as OrchestrationThread);
      return { accepted: true };
    }
    return { accepted: true };
  }

  completeLatest(threadId: string, text: string) {
    const turns = this.turns.get(threadId)!;
    const turn = turns.at(-1)!;
    if (!turn.turnId) throw new Error("cannot complete a native turn without a turn ID");
    turn.state = "completed";
    turn.completedAt = createdAt;
    const thread = this.threads.get(threadId)!;
    this.threads.set(threadId, {
      ...thread,
      messages: [
        ...thread.messages,
        message(`fake-assistant-${turn.turnId}`, "assistant", text, turn.turnId),
      ],
    } as OrchestrationThread);
  }
}

function newService(input: {
  stateDir: string;
  experts: ReturnType<typeof createExpertStore>;
  library: ReturnType<typeof createSkillLibraryStore>;
  repository: ReturnType<typeof makeRepository>;
  host: FakeHost;
}) {
  let tick = 0;
  const service = createSkillEvolutionService({
    stateDir: input.stateDir,
    ownerId,
    repository: input.repository.repository,
    experts: input.experts,
    library: input.library,
    packages: createSkillPackageStore(input.stateDir),
    host: input.host,
    now: () => new Date(Date.UTC(2026, 9, 29, 0, 0, tick++)),
    pollMs: 60_000,
  });
  services.push(service);
  return service;
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-skill-evolution-"));
  roots.push(root);
  const stateDir = path.join(root, "state");
  const experts = createExpertStore(stateDir);
  const library = createSkillLibraryStore(stateDir);
  libraries.push(library);
  const repository = makeRepository();
  const host = new FakeHost();
  const service = newService({ stateDir, experts, library, repository, host });
  return { root, stateDir, experts, library, repository, host, service };
}

async function restartService(state: Awaited<ReturnType<typeof fixture>>) {
  await state.service.dispose();
  state.service = newService(state);
  return state.service;
}

async function createExpert(
  experts: ReturnType<typeof createExpertStore>,
  id: string,
  skillBindings: Array<{
    skillId: string;
    enabled: boolean;
    activation: "startup" | "on-demand";
  }> = [],
) {
  return experts.save({
    id,
    name: `Expert ${id}`,
    description: "Test Expert",
    useCases: "Test use case",
    persona: "Follow verified procedures.",
    outputRequirements: "Return evidence.",
    skills: [],
    skillBindings,
    references: [],
    connections: [],
  });
}

async function createSkill(
  library: ReturnType<typeof createSkillLibraryStore>,
  options: {
    name: string;
    policy?: "protected" | "shared" | "independent";
    scope?: { kind: "shared" } | { kind: "expert"; expertId: string };
    body?: string;
    changes?: Array<{ path: string; content: string; executable?: boolean }>;
  },
) {
  return (
    await library.execute(
      {
        action: "create",
        requestId: `create-${options.name}`,
        name: options.name,
        body: options.body ?? entry(options.name, "Original workflow."),
        tags: [],
        evolutionPolicy: options.policy,
        scope: options.scope,
        changes: options.changes,
      },
      { actor: ownerId },
    )
  ).skill!;
}

async function bind(
  library: ReturnType<typeof createSkillLibraryStore>,
  expert: Awaited<ReturnType<typeof createExpert>>,
  bindings: Array<{ skillId: string; enabled: boolean; activation: "startup" | "on-demand" }>,
  requestId: string,
) {
  const response = await library.execute(
    {
      action: "bindings",
      operation: "set",
      expertId: expert.id,
      expectedRevision: expert.revision,
      requestId,
      bindings,
    },
    { actor: ownerId },
  );
  if (
    !response.bindingResult ||
    !["applied", "unchanged"].includes(response.bindingResult.status ?? "")
  )
    throw new Error(response.bindingResult?.error ?? "fake fixture binding failed");
  return response.bindingResult.bindings;
}

function addStandardSource(host: FakeHost, expertId: string, suffix = "source") {
  const threadId = `thread-${expertId}-${suffix}`;
  const turnId = `turn-${expertId}-${suffix}`;
  const userId = `user-${expertId}-${suffix}`;
  const assistantId = `assistant-${expertId}-${suffix}`;
  host.addSource(
    sourceThread({
      id: threadId,
      expertId,
      turns: [{ turnId, pendingMessageId: userId }],
      messages: [
        message(userId, "user", "Please improve the procedure.", null),
        message(assistantId, "assistant", "Verified evidence: keep a decision log.", turnId),
      ],
    }),
    [{ turnId, pendingMessageId: userId }],
  );
  return {
    threadId: ThreadId.makeUnsafe(threadId),
    turnId: TurnId.makeUnsafe(turnId),
    assistantId,
  };
}

function proposalText(input: {
  name: string;
  text: string;
  threadId: string;
  messageId: string;
  quote?: string;
  extra?: Record<string, unknown>;
  path?: string;
}) {
  return JSON.stringify({
    action: "proposals",
    proposals: [
      {
        name: input.name,
        summary: "Record the verified decision process.",
        evidence: [
          {
            threadId: input.threadId,
            messageId: input.messageId,
            quote: input.quote ?? "Verified evidence: keep a decision log.",
          },
        ],
        files: [{ path: input.path ?? "SKILL.md", text: input.text }],
        ...input.extra,
      },
    ],
  });
}

async function startAndFinish(
  fixtureValue: Awaited<ReturnType<typeof fixture>>,
  input: {
    requestId: string;
    expertId: string;
    source: { threadId: ThreadId; turnId: TurnId };
    targetSkillId?: string;
    protectedAction?: "update" | "derive";
    focus?: string;
    response: string;
  },
): Promise<SkillEvolutionRun> {
  const started = await fixtureValue.service.execute({
    action: "start",
    requestId: input.requestId,
    expertId: input.expertId,
    sources: [input.source],
    ...(input.targetSkillId ? { targetSkillId: input.targetSkillId } : {}),
    ...(input.protectedAction ? { protectedAction: input.protectedAction } : {}),
    ...(input.focus ? { focus: input.focus } : {}),
    modelSelection,
  });
  const taskThreadId = started.run!.taskThreadId!;
  await fixtureValue.service.dispose();
  fixtureValue.host.completeLatest(taskThreadId, input.response);
  return (await fixtureValue.service.execute({ action: "read", requestId: input.requestId })).run!;
}

function applyRequest(run: SkillEvolutionRun, operationId: string, approveProtected?: boolean) {
  const proposal = run.proposals[0]!;
  return {
    action: "apply" as const,
    requestId: run.requestId,
    proposalId: proposal.proposalId,
    expectedDigest: proposal.digest,
    operationId,
    ...(approveProtected !== undefined ? { approveProtected } : {}),
  };
}

async function deriveScenario(suffix: string) {
  const state = await fixture();
  const expert = await createExpert(state.experts, `binding-restore-${suffix}`);
  const sourceSkill = await createSkill(state.library, {
    name: `Binding Restore Source ${suffix}`,
    policy: "independent",
    scope: { kind: "shared" },
  });
  await bind(
    state.library,
    expert,
    [{ skillId: sourceSkill.skillId, enabled: true, activation: "startup" }],
    `bind-restore-source-${suffix}`,
  );
  const source = addStandardSource(state.host, expert.id, `binding-restore-${suffix}`);
  const run = await startAndFinish(state, {
    requestId: `binding-restore-run-${suffix}`,
    expertId: expert.id,
    source,
    targetSkillId: sourceSkill.skillId,
    response: proposalText({
      name: `Binding Restore Copy ${suffix}`,
      text: entry(`Binding Restore Copy ${suffix}`, "Expert-specific derivative."),
      threadId: source.threadId,
      messageId: source.assistantId,
    }),
  });
  const applied = await state.service.execute(
    applyRequest(run, `binding-restore-derive-${suffix}`),
  );
  const copy = applied.skill!;
  const event = [...state.repository.events.values()].find((item) => item.kind === "derived");
  if (!event) throw new Error("derive scenario did not append its source event");
  return { ...state, expert, sourceSkill, copy, event, run };
}

async function setBindings(
  state: Awaited<ReturnType<typeof fixture>>,
  expertId: string,
  bindings: Array<{ skillId: string; enabled: boolean; activation: "startup" | "on-demand" }>,
  requestId: string,
) {
  const expert = await state.experts.read(expertId);
  if (!expert) throw new Error("fixture Expert disappeared");
  return bind(state.library, expert, bindings, requestId);
}

describe("SkillEvolutionService deterministic workflows", () => {
  it("selects only exact completed-turn messages owned by the requested Expert", async () => {
    const state = await fixture();
    const expert = await createExpert(state.experts, "evidence-owner");
    const source = addStandardSource(state.host, expert.id, "selected");
    const thread = state.host.threads.get(source.threadId)!;
    const earlierTurn = "turn-earlier";
    const streaming = "assistant-streaming";
    state.host.threads.set(source.threadId, {
      ...thread,
      messages: [
        message("user-evidence-owner-selected", "user", "Please improve the procedure.", null),
        message(
          "assistant-earlier",
          "assistant",
          "Earlier turn must not enter evidence.",
          earlierTurn,
        ),
        message(
          source.assistantId,
          "assistant",
          "Verified evidence: keep a decision log.",
          source.turnId,
        ),
        message(streaming, "assistant", "Streaming text must not enter evidence.", source.turnId, {
          streaming: true,
        }),
      ],
    } as OrchestrationThread);
    state.host.turns.get(source.threadId)!.unshift({
      turnId: TurnId.makeUnsafe(earlierTurn),
      pendingMessageId: MessageId.makeUnsafe("earlier-user"),
      state: "completed",
      completedAt: createdAt,
    });
    const otherExpert = await createExpert(state.experts, "evidence-other");
    addStandardSource(state.host, otherExpert.id, "private");

    const sources = (await state.service.execute({ action: "sources", expertId: expert.id }))
      .sources!;
    expect(sources.map((item) => `${item.threadId}:${item.turnId}`).sort()).toEqual(
      [`${source.threadId}:${source.turnId}`, `${source.threadId}:turn-earlier`].sort(),
    );
    expect(sources.find((item) => item.turnId === source.turnId)?.messageCount).toBe(2);
    const run = await startAndFinish(state, {
      requestId: "evidence-filter-run",
      expertId: expert.id,
      source,
      response: JSON.stringify({ action: "no_change", reason: "No new procedure." }),
    });
    expect(run.status).toBe("no_change");
    const dispatchedText = state.host.dispatches
      .filter((command) => command.type === "thread.turn.start")
      .map((command) => (command.type === "thread.turn.start" ? command.message.text : ""))
      .join("\n");
    expect(dispatchedText).toContain("Verified evidence: keep a decision log.");
    expect(dispatchedText).not.toContain("Earlier turn must not enter evidence.");
    expect(dispatchedText).not.toContain("Streaming text must not enter evidence.");
    expect(dispatchedText).not.toContain("evidence-other");
  });

  it("rejects a source selected from another Expert before persisting or dispatching", async () => {
    const state = await fixture();
    const first = await createExpert(state.experts, "source-first");
    const second = await createExpert(state.experts, "source-second");
    const foreign = addStandardSource(state.host, second.id, "foreign");
    await expect(
      state.service.execute({
        action: "start",
        requestId: "foreign-source-run",
        expertId: first.id,
        sources: [foreign],
        modelSelection,
      }),
    ).rejects.toThrow("所选来源不属于当前专家");
    expect(state.repository.rows.size).toBe(0);
    expect(state.host.dispatches).toEqual([]);
  });

  it("keeps a protected proposal unapplied until the owner explicitly approves it", async () => {
    const state = await fixture();
    const expert = await createExpert(state.experts, "protected-owner");
    const base = await createSkill(state.library, { name: "Protected Base" });
    const originalBindings = await bind(
      state.library,
      expert,
      [{ skillId: base.skillId, enabled: true, activation: "startup" }],
      "bind-protected-base",
    );
    const source = addStandardSource(state.host, expert.id, "protected");
    const run = await startAndFinish(state, {
      requestId: "protected-run",
      expertId: expert.id,
      source,
      targetSkillId: base.skillId,
      protectedAction: "update",
      response: proposalText({
        name: base.name,
        text: entry(base.name, "Updated but awaiting explicit approval."),
        threadId: source.threadId,
        messageId: source.assistantId,
      }),
    });
    expect(run.status).toBe("proposal_ready");
    await expect(state.service.execute(applyRequest(run, "protected-op"))).rejects.toThrow(
      "明确认可",
    );
    expect(await state.library.execute({ action: "read", skillId: base.skillId })).toMatchObject({
      skill: base,
    });
    expect((await state.experts.read(expert.id))?.skillBindings).toEqual(originalBindings);
    expect(state.repository.events.size).toBe(0);
  });

  it("updates a shared Skill in place under its original identity", async () => {
    const state = await fixture();
    const expert = await createExpert(state.experts, "shared-updater");
    const secondExpert = await createExpert(state.experts, "shared-affected-then-unbound");
    const uninvolvedExpert = await createExpert(state.experts, "shared-uninvolved");
    const base = await createSkill(state.library, {
      name: "Shared Update",
      policy: "shared",
      scope: { kind: "shared" },
    });
    await bind(
      state.library,
      expert,
      [{ skillId: base.skillId, enabled: true, activation: "on-demand" }],
      "bind-shared-update",
    );
    await bind(
      state.library,
      secondExpert,
      [{ skillId: base.skillId, enabled: false, activation: "startup" }],
      "bind-shared-update-second-expert",
    );
    const source = addStandardSource(state.host, expert.id, "shared-update");
    const run = await startAndFinish(state, {
      requestId: "shared-update-run",
      expertId: expert.id,
      source,
      targetSkillId: base.skillId,
      response: proposalText({
        name: base.name,
        text: entry(base.name, "Updated shared workflow."),
        threadId: source.threadId,
        messageId: source.assistantId,
      }),
    });
    const applied = await state.service.execute(applyRequest(run, "shared-update-op"));
    const updateEvent = [...state.repository.events.values()][0]!;
    expect(applied.skill).toMatchObject({
      skillId: base.skillId,
      revision: base.revision + 1,
      evolutionPolicy: "shared",
      scope: { kind: "shared" },
    });
    expect(state.repository.events.size).toBe(1);
    expect(updateEvent).toMatchObject({
      kind: "updated",
      expertId: expert.id,
      affectedExpertIds: expect.arrayContaining([expert.id, secondExpert.id]),
    });

    await bind(
      state.library,
      (await state.experts.read(secondExpert.id))!,
      [],
      "unbind-shared-update-second-expert",
    );
    expect((await state.experts.read(secondExpert.id))?.skillBindings).toEqual([]);

    const secondGraph = await state.service.execute({
      action: "graph",
      expertId: secondExpert.id,
    });
    expect(secondGraph.graph?.nodes).toContainEqual(
      expect.objectContaining({ skillId: base.skillId }),
    );
    expect(secondGraph.graph?.events).toContainEqual(updateEvent);
    expect(secondGraph.graph?.events[0]?.expertId).toBe(expert.id);

    const uninvolvedGraph = await state.service.execute({
      action: "graph",
      expertId: uninvolvedExpert.id,
    });
    expect(uninvolvedGraph.graph?.nodes).toEqual([]);
    expect(uninvolvedGraph.graph?.events).toEqual([]);
  });

  it("conflicts a shared update when a new Expert binds after the affected set was frozen", async () => {
    const state = await fixture();
    const expert = await createExpert(state.experts, "a-shared-proposer");
    const lateBinder = await createExpert(state.experts, "z-shared-late-binder");
    const base = await createSkill(state.library, {
      name: "Shared Frozen Audience",
      policy: "shared",
      scope: { kind: "shared" },
    });
    await bind(
      state.library,
      expert,
      [{ skillId: base.skillId, enabled: true, activation: "on-demand" }],
      "bind-shared-frozen-audience-proposer",
    );
    const source = addStandardSource(state.host, expert.id, "shared-frozen-audience");
    const run = await startAndFinish(state, {
      requestId: "shared-frozen-audience-run",
      expertId: expert.id,
      source,
      targetSkillId: base.skillId,
      response: proposalText({
        name: base.name,
        text: entry(base.name, "Candidate frozen for the original audience."),
        threadId: source.threadId,
        messageId: source.assistantId,
      }),
    });
    const proposal = run.proposals[0]!;
    expect(proposal.affectedExpertIds).toEqual([expert.id]);

    await bind(
      state.library,
      lateBinder,
      [{ skillId: base.skillId, enabled: false, activation: "startup" }],
      "bind-shared-frozen-audience-late-binder",
    );
    const result = await state.service.execute(applyRequest(run, "shared-frozen-audience-op"));

    expect(result.run?.proposals[0]?.status).toBe("conflict");
    expect(result.run?.proposals[0]?.error).toContain("共享使用方已改变");
    expect(result.skill).toBeUndefined();
    expect((await state.library.execute({ action: "read", skillId: base.skillId })).skill).toEqual(
      base,
    );
    expect(state.repository.events.size).toBe(0);
  });

  it("derives independent shared Skills once, keeps both binding modes, and leaves the shared source unchanged", async () => {
    const state = await fixture();
    const first = await createExpert(state.experts, "independent-first");
    const second = await createExpert(state.experts, "independent-second");
    const base = await createSkill(state.library, {
      name: "Independent Shared Template",
      policy: "independent",
      scope: { kind: "shared" },
      body: entry("Independent Shared Template", "Original template workflow."),
      changes: [
        {
          path: "references/keep.txt",
          content: Buffer.from("Keep this immutable resource.").toString("base64"),
        },
        { path: "references/change.txt", content: Buffer.from("Old resource.").toString("base64") },
        { path: "bin/payload.bin", content: Buffer.from([0, 255, 2, 128]).toString("base64") },
      ],
    });
    const firstBinding = { skillId: base.skillId, enabled: true, activation: "startup" as const };
    const secondBinding = {
      skillId: base.skillId,
      enabled: false,
      activation: "on-demand" as const,
    };
    await bind(state.library, first, [firstBinding], "bind-independent-first");
    await bind(state.library, second, [secondBinding], "bind-independent-second");
    const source = addStandardSource(state.host, first.id, "independent");
    const run = await startAndFinish(state, {
      requestId: "independent-run",
      expertId: first.id,
      source,
      targetSkillId: base.skillId,
      response: proposalText({
        name: "Independent Personal Copy",
        text: entry("Independent Personal Copy", "Personalized specialist workflow."),
        threadId: source.threadId,
        messageId: source.assistantId,
      }),
    });
    expect(run.proposals[0]?.action).toBe("derive");
    const operation = applyRequest(run, "independent-operation");
    const result = await state.service.execute(operation);
    const privateSkill = result.skill!;
    expect(privateSkill).toMatchObject({
      revision: 1,
      evolutionPolicy: "independent",
      scope: { kind: "expert", expertId: first.id },
      derivedFrom: { skillId: base.skillId, revision: base.revision, packageId: base.packageId },
    });
    expect((await state.experts.read(first.id))?.skillBindings).toEqual([
      { ...firstBinding, skillId: privateSkill.skillId },
    ]);
    expect((await state.experts.read(second.id))?.skillBindings).toEqual([secondBinding]);
    expect(await state.library.execute({ action: "read", skillId: base.skillId })).toMatchObject({
      skill: base,
    });
    expect(
      (
        await state.library.execute({
          action: "readFile",
          skillId: privateSkill.skillId,
          path: "references/keep.txt",
        })
      ).file?.content,
    ).toBe(Buffer.from("Keep this immutable resource.").toString("base64"));
    expect(
      (
        await state.library.execute({
          action: "readFile",
          skillId: privateSkill.skillId,
          path: "references/change.txt",
        })
      ).file?.content,
    ).toBe(Buffer.from("Old resource.").toString("base64"));
    expect(
      (
        await state.library.execute({
          action: "readFile",
          skillId: privateSkill.skillId,
          path: "bin/payload.bin",
        })
      ).file?.content,
    ).toBe(Buffer.from([0, 255, 2, 128]).toString("base64"));

    const countAfterDerive = (await state.library.execute({ action: "list" })).items?.length;
    const eventsAfterDerive = state.repository.events.size;
    const replay = await state.service.execute(operation);
    expect(replay.run?.proposals[0]?.status).toBe("applied");
    expect((await state.library.execute({ action: "list" })).items?.length).toBe(countAfterDerive);
    expect(state.repository.events.size).toBe(eventsAfterDerive);

    const currentSecond = (await state.experts.read(second.id))!;
    const rejected = await state.library.execute(
      {
        action: "bindings",
        operation: "set",
        expertId: second.id,
        expectedRevision: currentSecond.revision,
        requestId: "try-bind-private-skill",
        bindings: [
          secondBinding,
          { skillId: privateSkill.skillId, enabled: true, activation: "on-demand" },
        ],
      },
      { actor: ownerId },
    );
    expect(rejected.bindingResult?.status).toBe("failed");
    expect((await state.experts.read(second.id))?.skillBindings).toEqual([secondBinding]);
  });

  it("returns saved_unbound on a binding conflict and retries without creating another Skill", async () => {
    const state = await fixture();
    const expert = await createExpert(state.experts, "retry-derived");
    const base = await createSkill(state.library, {
      name: "Retry Shared Template",
      policy: "independent",
      scope: { kind: "shared" },
    });
    const originalBinding = {
      skillId: base.skillId,
      enabled: true,
      activation: "startup" as const,
    };
    await bind(state.library, expert, [originalBinding], "bind-retry-source");
    const source = addStandardSource(state.host, expert.id, "retry-derive");
    const run = await startAndFinish(state, {
      requestId: "retry-derive-run",
      expertId: expert.id,
      source,
      targetSkillId: base.skillId,
      response: proposalText({
        name: "Retry Derived Copy",
        text: entry("Retry Derived Copy", "Personal workflow."),
        threadId: source.threadId,
        messageId: source.assistantId,
      }),
    });
    const operation = applyRequest(run, "retry-derived-operation");
    await restartService(state);
    const competingSource = addStandardSource(state.host, expert.id, "retry-derive-competing");
    const competingRun = await startAndFinish(state, {
      requestId: "retry-derive-competing-run",
      expertId: expert.id,
      source: competingSource,
      targetSkillId: base.skillId,
      response: proposalText({
        name: "Competing Derived Copy",
        text: entry("Competing Derived Copy", "A separate candidate for the same source."),
        threadId: competingSource.threadId,
        messageId: competingSource.assistantId,
      }),
    });
    const execute = state.library.execute.bind(state.library);
    let conflictOnce = true;
    const spy = vi.spyOn(state.library, "execute").mockImplementation((request, context) => {
      if (
        conflictOnce &&
        request.action === "bindings" &&
        "requestId" in request &&
        request.requestId === "evolution-bind:retry-derived-operation"
      ) {
        conflictOnce = false;
        return Promise.resolve({
          bindingResult: {
            expertId: expert.id,
            status: "conflict",
            bindings: [originalBinding],
            revision: expert.revision,
            addedSkillIds: [],
            skippedSkillIds: [],
            error: "Injected revision conflict.",
          },
        });
      }
      return execute(request, context);
    });
    const partial = await state.service.execute(operation);
    spy.mockRestore();
    expect(partial.run?.proposals[0]?.status).toBe("saved_unbound");
    expect(state.repository.events.size).toBe(0);
    expect((await state.experts.read(expert.id))?.skillBindings).toEqual([originalBinding]);
    const countAfterSave = (await state.library.execute({ action: "list" })).items?.length;
    const savedSkillId = partial.run?.proposals[0]?.resultSkillId;
    expect(savedSkillId).toBeTruthy();
    const savedCopy = (await state.library.execute({ action: "read", skillId: savedSkillId! }))
      .skill;

    const competing = await state.service.execute(
      applyRequest(competingRun, "retry-derived-competing-operation"),
    );
    expect(competing.run?.proposals[0]?.status).toBe("conflict");
    expect(competing.run?.proposals[0]?.error).toContain(savedSkillId);
    expect((await state.library.execute({ action: "list" })).items?.length).toBe(countAfterSave);
    expect((await state.library.execute({ action: "read", skillId: savedSkillId! })).skill).toEqual(
      savedCopy,
    );
    expect((await state.experts.read(expert.id))?.skillBindings).toEqual([originalBinding]);
    expect(state.repository.events.size).toBe(0);

    const retried = await state.service.execute(operation);
    expect(retried.run?.proposals[0]?.status).toBe("applied");
    expect((await state.library.execute({ action: "list" })).items?.length).toBe(countAfterSave);
    expect(state.repository.events.size).toBe(1);
    const derivedId = retried.run?.proposals[0]?.resultSkillId;
    expect((await state.experts.read(expert.id))?.skillBindings).toEqual([
      { ...originalBinding, skillId: derivedId },
    ]);
  });

  it("records no_change without publishing a Skill, changing bindings, or appending an event", async () => {
    const state = await fixture();
    const expert = await createExpert(state.experts, "no-change-owner");
    const source = addStandardSource(state.host, expert.id, "no-change");
    const beforeExpert = await state.experts.read(expert.id);
    const run = await startAndFinish(state, {
      requestId: "no-change-run",
      expertId: expert.id,
      source,
      response: JSON.stringify({ action: "no_change", reason: "Already covered." }),
    });
    expect(run.status).toBe("no_change");
    expect((await state.library.execute({ action: "list" })).items).toEqual([]);
    expect((await state.experts.read(expert.id))?.revision).toBe(beforeExpert?.revision);
    expect(state.repository.events.size).toBe(0);
  });

  it("repairs once after forged evidence, then rejects forged permission fields", async () => {
    const state = await fixture();
    const expert = await createExpert(state.experts, "forged-output");
    const base = await createSkill(state.library, {
      name: "Forged Output Base",
      policy: "shared",
      scope: { kind: "shared" },
    });
    await bind(
      state.library,
      expert,
      [{ skillId: base.skillId, enabled: true, activation: "on-demand" }],
      "bind-forged-base",
    );
    const source = addStandardSource(state.host, expert.id, "forged");
    const started = await state.service.execute({
      action: "start",
      requestId: "forged-output-run",
      expertId: expert.id,
      sources: [source],
      targetSkillId: base.skillId,
      modelSelection,
    });
    await state.service.dispose();
    const taskId = started.run!.taskThreadId!;
    state.host.completeLatest(
      taskId,
      proposalText({
        name: base.name,
        text: entry(base.name, "Forged quote must not pass."),
        threadId: source.threadId,
        messageId: source.assistantId,
        quote: "A fabricated source quote.",
      }),
    );
    const repairQueued = await state.service.execute({
      action: "read",
      requestId: "forged-output-run",
    });
    await state.service.dispose();
    expect(repairQueued.run?.status).toBe("running");
    const turns = state.host.turns.get(taskId)!;
    expect(turns).toHaveLength(2);
    expect(turns[1]?.pendingMessageId).not.toBe(turns[0]?.pendingMessageId);
    expect(turns[1]?.pendingMessageId).toMatch(/^skill-evolution:repair-message:/u);
    state.host.completeLatest(
      taskId,
      proposalText({
        name: base.name,
        text: entry(base.name, "Second output includes forbidden policy metadata."),
        threadId: source.threadId,
        messageId: source.assistantId,
        extra: { evolutionPolicy: "shared", scope: { kind: "shared" }, ownerId: expert.id },
      }),
    );
    const failed = await state.service.execute({ action: "read", requestId: "forged-output-run" });
    expect(failed.run?.status).toBe("failed");
    expect(failed.run?.proposals).toEqual([]);
    expect((await state.library.execute({ action: "read", skillId: base.skillId })).skill).toEqual(
      base,
    );
    expect(state.repository.events.size).toBe(0);
  });

  it("repairs an unsafe candidate path and does not publish the rejected file", async () => {
    const state = await fixture();
    const expert = await createExpert(state.experts, "forged-path");
    const base = await createSkill(state.library, {
      name: "Unsafe Path Base",
      policy: "shared",
      scope: { kind: "shared" },
    });
    await bind(
      state.library,
      expert,
      [{ skillId: base.skillId, enabled: true, activation: "on-demand" }],
      "bind-unsafe-path-base",
    );
    const source = addStandardSource(state.host, expert.id, "unsafe-path");
    const started = await state.service.execute({
      action: "start",
      requestId: "unsafe-path-run",
      expertId: expert.id,
      sources: [source],
      targetSkillId: base.skillId,
      modelSelection,
    });
    await state.service.dispose();
    const taskId = started.run!.taskThreadId!;
    state.host.completeLatest(
      taskId,
      proposalText({
        name: base.name,
        text: "owned",
        path: "../escape.txt",
        threadId: source.threadId,
        messageId: source.assistantId,
      }),
    );
    await state.service.execute({ action: "read", requestId: "unsafe-path-run" });
    await state.service.dispose();
    expect(state.host.turns.get(taskId)).toHaveLength(2);
    state.host.completeLatest(
      taskId,
      proposalText({
        name: base.name,
        text: entry(base.name, "A safe corrected path."),
        threadId: source.threadId,
        messageId: source.assistantId,
      }),
    );
    const corrected = await state.service.execute({ action: "read", requestId: "unsafe-path-run" });
    expect(corrected.run?.status).toBe("proposal_ready");
    expect(corrected.run?.proposals[0]?.changes.map((change) => change.path)).toEqual(["SKILL.md"]);
    expect((await state.library.execute({ action: "read", skillId: base.skillId })).skill).toEqual(
      base,
    );
  });

  it("restores historical package content as a new revision instead of rewinding history", async () => {
    const state = await fixture();
    const expert = await createExpert(state.experts, "restore-owner");
    const secondExpert = await createExpert(state.experts, "restore-second-expert");
    const base = await createSkill(state.library, {
      name: "Restorable Shared Skill",
      policy: "shared",
      scope: { kind: "shared" },
    });
    await bind(
      state.library,
      expert,
      [{ skillId: base.skillId, enabled: true, activation: "on-demand" }],
      "bind-restorable-base",
    );
    await bind(
      state.library,
      secondExpert,
      [{ skillId: base.skillId, enabled: true, activation: "startup" }],
      "bind-restorable-base-second-expert",
    );
    const source = addStandardSource(state.host, expert.id, "restore");

    const firstRun = await startAndFinish(state, {
      requestId: "restore-update-one",
      expertId: expert.id,
      source,
      targetSkillId: base.skillId,
      focus: "first update",
      response: proposalText({
        name: base.name,
        text: entry(base.name, "Historical accepted procedure."),
        threadId: source.threadId,
        messageId: source.assistantId,
      }),
    });
    await state.service.execute(applyRequest(firstRun, "restore-update-one-op"));
    const historical = [...state.repository.events.values()][0]!;

    const secondRun = await startAndFinish(state, {
      requestId: "restore-update-two",
      expertId: expert.id,
      source,
      targetSkillId: base.skillId,
      focus: "second update",
      response: proposalText({
        name: base.name,
        text: entry(base.name, "Later procedure to be rolled back."),
        threadId: source.threadId,
        messageId: source.assistantId,
      }),
    });
    await state.service.execute(applyRequest(secondRun, "restore-update-two-op"));
    const beforeRestore = (await state.library.execute({ action: "read", skillId: base.skillId }))
      .skill!;
    expect(beforeRestore.revision).toBe(3);

    await bind(
      state.library,
      (await state.experts.read(secondExpert.id))!,
      [],
      "unbind-restorable-base-second-expert",
    );
    const restorePreview = await state.service.execute({
      action: "previewRestore",
      eventId: historical.eventId,
      expertId: expert.id,
    });
    expect(restorePreview.restorePreview?.affectedExpertIds).toEqual([expert.id]);
    const restoreInput = {
      eventId: historical.eventId,
      expertId: expert.id,
      expectedRevision: beforeRestore.revision,
    };
    await expect(
      state.service.execute({
        action: "restore",
        ...restoreInput,
        operationId: "restore-to-first-update-missing-audience",
      }),
    ).rejects.toThrow("共享使用方已改变，请重新预览恢复影响");
    await expect(
      state.service.execute({
        action: "restore",
        ...restoreInput,
        operationId: "restore-to-first-update-stale-audience",
        expectedAffectedExpertIds: [expert.id, secondExpert.id],
      }),
    ).rejects.toThrow("共享使用方已改变，请重新预览恢复影响");

    const previewRevision = restorePreview.restorePreview!.skill.revision;
    expect(previewRevision).toBe(beforeRestore.revision);
    const newerSkill = (
      await state.library.execute({
        action: "save",
        skillId: base.skillId,
        expectedRevision: previewRevision,
        requestId: "save-after-restore-preview",
        name: base.name,
        tags: base.tags,
        changes: [
          {
            path: "SKILL.md",
            content: Buffer.from(
              entry(base.name, "Concurrent edit after restore preview."),
            ).toString("base64"),
          },
        ],
      })
    ).skill!;
    expect(newerSkill.revision).toBe(previewRevision + 1);
    await expect(
      state.service.execute({
        action: "restore",
        eventId: historical.eventId,
        expertId: expert.id,
        operationId: "restore-to-first-update-stale-revision",
        expectedRevision: previewRevision,
        expectedAffectedExpertIds: restorePreview.restorePreview!.affectedExpertIds,
      }),
    ).rejects.toThrow("Skill 已改变，请重新预览恢复差异。");

    const latestRestorePreview = (
      await state.service.execute({
        action: "previewRestore",
        eventId: historical.eventId,
        expertId: expert.id,
      })
    ).restorePreview!;

    const restored = await state.service.execute({
      action: "restore",
      operationId: "restore-to-first-update",
      eventId: historical.eventId,
      expertId: expert.id,
      expectedRevision: newerSkill.revision,
      expectedAffectedExpertIds: latestRestorePreview.affectedExpertIds,
    });
    expect(restored.skill).toMatchObject({
      skillId: base.skillId,
      revision: newerSkill.revision + 1,
    });
    const file = await state.library.execute({
      action: "readFile",
      skillId: base.skillId,
      path: "SKILL.md",
    });
    expect(Buffer.from(file.file!.content, "base64").toString("utf8")).toContain(
      "Historical accepted procedure.",
    );
    expect(Buffer.from(file.file!.content, "base64").toString("utf8")).not.toContain(
      "Later procedure to be rolled back.",
    );
    expect([...state.repository.events.values()].at(-1)?.kind).toBe("restored");
    expect([...state.repository.events.values()].at(-1)?.revision).toBe(newerSkill.revision + 1);
    expect([...state.repository.events.values()].at(-1)?.affectedExpertIds).toEqual([expert.id]);
  });

  it("repairs malformed model output once and matches completion to the repair turn, not the old turn", async () => {
    const state = await fixture();
    const expert = await createExpert(state.experts, "repair-owner");
    const source = addStandardSource(state.host, expert.id, "repair");
    const started = await state.service.execute({
      action: "start",
      requestId: "repair-run",
      expertId: expert.id,
      sources: [source],
      modelSelection,
    });
    await state.service.dispose();
    const taskId = started.run!.taskThreadId!;
    state.host.completeLatest(taskId, "{not valid JSON");
    const repairQueued = await state.service.execute({ action: "read", requestId: "repair-run" });
    await state.service.dispose();
    expect(repairQueued.run?.status).toBe("running");
    const turns = state.host.turns.get(taskId)!;
    expect(turns).toHaveLength(2);
    const oldTurnId = turns[0]!.turnId;
    const repairTurnId = turns[1]!.turnId;
    expect(repairQueued.run?.taskTurnId).toBe(repairTurnId);
    expect(turns[1]?.pendingMessageId).toMatch(/^skill-evolution:repair-message:/u);

    state.host.completeLatest(
      taskId,
      JSON.stringify({ action: "no_change", reason: "Repair returned a valid result." }),
    );
    const finished = await state.service.execute({ action: "read", requestId: "repair-run" });
    expect(finished.run?.status).toBe("no_change");
    expect(finished.run?.taskTurnId).toBe(repairTurnId);
    expect(finished.run?.taskTurnId).not.toBe(oldTurnId);
    expect(
      state.host.dispatches.filter((command) => command.type === "thread.turn.start"),
    ).toHaveLength(2);
  });

  it("previews source-binding restoration exactly, rejects stale digests, then restores once without deleting the copy", async () => {
    const state = await deriveScenario("preview-success");
    const sideSkill = await createSkill(state.library, {
      name: "Binding Restore Side Skill",
      policy: "shared",
      scope: { kind: "shared" },
    });
    const copyBinding = {
      skillId: state.copy.skillId,
      enabled: false,
      activation: "on-demand" as const,
    };
    const sideBinding = {
      skillId: sideSkill.skillId,
      enabled: true,
      activation: "startup" as const,
    };
    await setBindings(state, state.expert.id, [copyBinding, sideBinding], "binding-preview-seed");

    const originalPreview = await state.service.execute({
      action: "previewBindingRestore",
      eventId: state.event.eventId,
      expertId: state.expert.id,
    });
    const original = originalPreview.bindingRestorePreview!;
    expect(original.before).toEqual([copyBinding, sideBinding]);
    expect(original.after).toEqual([
      { ...copyBinding, skillId: state.sourceSkill.skillId },
      sideBinding,
    ]);
    expect(original.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(original.expertRevision).toBe((await state.experts.read(state.expert.id))?.revision);

    const changedSideBinding = { ...sideBinding, enabled: false, activation: "on-demand" as const };
    await setBindings(
      state,
      state.expert.id,
      [copyBinding, changedSideBinding],
      "binding-preview-change-after-preview",
    );
    await expect(
      state.service.execute({
        action: "restoreBinding",
        eventId: state.event.eventId,
        expertId: state.expert.id,
        operationId: "binding-restore-success",
        expectedDigest: original.digest,
      }),
    ).rejects.toThrow("绑定或 Skill 已改变");
    expect(state.repository.events.size).toBe(1);
    expect((await state.experts.read(state.expert.id))?.skillBindings).toEqual([
      copyBinding,
      changedSideBinding,
    ]);

    const latest = (
      await state.service.execute({
        action: "previewBindingRestore",
        eventId: state.event.eventId,
        expertId: state.expert.id,
      })
    ).bindingRestorePreview!;
    expect(latest.before).toEqual([copyBinding, changedSideBinding]);
    expect(latest.after).toEqual([
      { ...copyBinding, skillId: state.sourceSkill.skillId },
      changedSideBinding,
    ]);
    const request = {
      action: "restoreBinding" as const,
      eventId: state.event.eventId,
      expertId: state.expert.id,
      operationId: "binding-restore-success",
      expectedDigest: latest.digest,
    };
    const executeLibrary = state.library.execute.bind(state.library);
    let interruptOnce = true;
    const interruption = vi
      .spyOn(state.library, "execute")
      .mockImplementation((libraryRequest, context) => {
        if (
          interruptOnce &&
          libraryRequest.action === "bindings" &&
          "requestId" in libraryRequest &&
          libraryRequest.requestId === "evolution-restore-binding:binding-restore-success"
        ) {
          interruptOnce = false;
          return Promise.reject(new Error("Injected interruption after durable restore intent."));
        }
        return executeLibrary(libraryRequest, context);
      });
    await expect(state.service.execute(request)).rejects.toThrow("durable restore intent");
    interruption.mockRestore();
    expect(state.repository.events.size).toBe(1);
    const resumed = await state.service.execute({ action: "read", requestId: state.run.requestId });
    expect(resumed.run?.proposals[0]?.status).toBe("applied");
    const restored = {
      skill: (await state.library.execute({ action: "read", skillId: state.sourceSkill.skillId }))
        .skill,
    };
    expect(restored.skill?.skillId).toBe(state.sourceSkill.skillId);
    expect((await state.experts.read(state.expert.id))?.skillBindings).toEqual(latest.after);
    expect(
      (await state.library.execute({ action: "read", skillId: state.copy.skillId })).skill,
    ).toEqual(state.copy);
    expect(state.repository.events.size).toBe(2);
    expect([...state.repository.events.values()].at(-1)).toMatchObject({
      kind: "binding_restored",
      skillId: state.sourceSkill.skillId,
      previousSkillId: state.copy.skillId,
      policy: "independent",
      scope: { kind: "shared" },
    });

    const replay = await state.service.execute(request);
    expect(replay.run?.proposals[0]?.status).toBe("applied");
    expect(state.repository.events.size).toBe(2);
    expect((await state.experts.read(state.expert.id))?.skillBindings).toEqual(latest.after);
    expect(
      (await state.library.execute({ action: "read", skillId: state.copy.skillId })).skill,
    ).toEqual(state.copy);
  });

  it("persists a binding-restore intent across a real Expert revision conflict without rebasing over another binding", async () => {
    const state = await deriveScenario("cas-conflict");
    const extraSkill = await createSkill(state.library, {
      name: "Concurrent User Binding",
      policy: "shared",
      scope: { kind: "shared" },
    });
    const preview = (
      await state.service.execute({
        action: "previewBindingRestore",
        eventId: state.event.eventId,
        expertId: state.expert.id,
      })
    ).bindingRestorePreview!;
    const request = {
      action: "restoreBinding" as const,
      eventId: state.event.eventId,
      expertId: state.expert.id,
      operationId: "binding-restore-cas-conflict",
      expectedDigest: preview.digest,
    };
    const execute = state.library.execute.bind(state.library);
    let introducedConflict = false;
    const spy = vi
      .spyOn(state.library, "execute")
      .mockImplementation(async (libraryRequest, context) => {
        if (
          !introducedConflict &&
          libraryRequest.action === "bindings" &&
          "requestId" in libraryRequest &&
          libraryRequest.requestId === "evolution-restore-binding:binding-restore-cas-conflict"
        ) {
          introducedConflict = true;
          const current = await state.experts.read(state.expert.id);
          if (!current) throw new Error("fixture Expert disappeared during CAS injection");
          await state.experts.save({
            id: current.id,
            expectedRevision: current.revision,
            name: current.name,
            description: current.description,
            useCases: current.useCases,
            persona: current.persona,
            outputRequirements: current.outputRequirements,
            skills: current.skills,
            skillBindings: [
              ...(current.skillBindings ?? []),
              { skillId: extraSkill.skillId, enabled: true, activation: "on-demand" },
            ],
            references: current.references,
            connections: current.connections,
            ...(current.preferredProvider ? { preferredProvider: current.preferredProvider } : {}),
          });
        }
        return execute(libraryRequest, context);
      });
    await expect(state.service.execute(request)).rejects.toThrow(/revision changed|冲突|reload/iu);
    spy.mockRestore();

    const current = (await state.experts.read(state.expert.id))!;
    expect(introducedConflict).toBe(true);
    expect(current.skillBindings).toEqual([
      { skillId: state.copy.skillId, enabled: true, activation: "startup" },
      { skillId: extraSkill.skillId, enabled: true, activation: "on-demand" },
    ]);
    expect(
      current.skillBindings?.some((binding) => binding.skillId === state.sourceSkill.skillId),
    ).toBe(false);
    expect(
      (await state.library.execute({ action: "read", skillId: state.copy.skillId })).skill,
    ).toEqual(state.copy);
    expect(state.repository.events.size).toBe(1);

    const row = state.repository.rows.get(state.run.requestId)!;
    const persisted = JSON.parse(row.record) as {
      bindingRestores?: Array<{ operationId: string; expertRevision: number; completed?: boolean }>;
    };
    expect(persisted.bindingRestores).toHaveLength(1);
    expect(persisted.bindingRestores?.[0]).toMatchObject({
      operationId: request.operationId,
      expertRevision: preview.expertRevision,
    });
    expect(persisted.bindingRestores?.[0]?.completed).toBeUndefined();

    const visible = await state.service.execute({ action: "read", requestId: state.run.requestId });
    expect(visible.run?.proposals[0]?.status).toBe("applied");
    const listed = await state.service.execute({ action: "list", expertId: state.expert.id });
    expect(listed.runs?.map((run) => run.requestId)).toContain(state.run.requestId);
    expect(state.repository.events.size).toBe(1);
    expect((await state.experts.read(state.expert.id))?.skillBindings).toEqual(
      current.skillBindings,
    );
    const afterRead = JSON.parse(
      state.repository.rows.get(state.run.requestId)!.record,
    ) as typeof persisted;
    expect(afterRead.bindingRestores?.[0]?.expertRevision).toBe(preview.expertRevision);
    expect(afterRead.bindingRestores?.[0]?.completed).toBeUndefined();
  });

  it("keeps deleted derived Skills in the historical evolution graph", async () => {
    const state = await deriveScenario("deleted-graph");
    await state.library.execute(
      {
        action: "delete",
        skillId: state.copy.skillId,
        expectedRevision: state.copy.revision,
        requestId: "delete-derived-for-history-graph",
        confirmExpertIds: [state.expert.id],
      },
      { actor: ownerId },
    );
    expect(
      (await readSkillLibraryDefinitions(state.stateDir)).find(
        (skill) => skill.skillId === state.copy.skillId,
      ),
    ).toMatchObject({ deleted: true });

    const result = await state.service.execute({ action: "graph", expertId: state.expert.id });
    const node = result.graph?.nodes.find((item) => item.skillId === state.copy.skillId);
    expect(node).toMatchObject({
      skillId: state.copy.skillId,
      derivedFromSkillId: state.sourceSkill.skillId,
      deleted: true,
    });
    expect(result.graph?.events.some((item) => item.eventId === state.event.eventId)).toBe(true);
  });

  it("restarts from an applying protected intent and completes the same derivation without duplicate packages or events", async () => {
    const state = await fixture();
    const expert = await createExpert(state.experts, "applying-restart-owner");
    const base = await createSkill(state.library, {
      name: "Protected Restart Source",
      policy: "protected",
      scope: { kind: "shared" },
    });
    await bind(
      state.library,
      expert,
      [{ skillId: base.skillId, enabled: true, activation: "startup" }],
      "bind-applying-restart-source",
    );
    const source = addStandardSource(state.host, expert.id, "applying-restart");
    const run = await startAndFinish(state, {
      requestId: "applying-restart-run",
      expertId: expert.id,
      source,
      targetSkillId: base.skillId,
      protectedAction: "derive",
      response: proposalText({
        name: "Protected Restart Copy",
        text: entry("Protected Restart Copy", "Approved private workflow."),
        threadId: source.threadId,
        messageId: source.assistantId,
      }),
    });
    expect(run.proposals[0]?.action).toBe("derive");
    const apply = applyRequest(run, "applying-restart-operation", true);
    const packages = createSkillPackageStore(state.stateDir);
    const packagesBefore = (await packages.list()).map((item) => item.packageId).sort();
    const executeLibrary = state.library.execute.bind(state.library);
    let crashBeforeSave = true;
    const crash = vi.spyOn(state.library, "execute").mockImplementation((request, context) => {
      if (
        crashBeforeSave &&
        request.action === "derive" &&
        request.requestId === "evolution:applying-restart-operation"
      ) {
        crashBeforeSave = false;
        return Promise.reject(new Error("Injected process crash before derived package save."));
      }
      return executeLibrary(request, context);
    });
    const interrupted = await state.service.execute(apply);
    crash.mockRestore();
    expect(interrupted.run?.proposals[0]?.status).toBe("conflict");
    const storedBeforeRestart = JSON.parse(state.repository.rows.get(run.requestId)!.record) as {
      intents: Array<{
        operationId: string;
        digest: string;
        approvedProtected?: boolean;
        createdAt?: string;
      }>;
      run: SkillEvolutionRun;
    };
    const intent = storedBeforeRestart.intents[0]!;
    expect(storedBeforeRestart.run.proposals[0]?.status).toBe("conflict");
    expect(intent).toMatchObject({
      operationId: apply.operationId,
      digest: run.proposals[0]!.digest,
      approvedProtected: true,
    });
    expect(intent.createdAt).toBeTruthy();
    expect((await state.library.execute({ action: "list" })).skills).toHaveLength(1);

    await restartService(state);
    const resumed = await state.service.execute({ action: "read", requestId: run.requestId });
    expect(resumed.run?.proposals[0]?.status).toBe("applied");
    const derivedId = resumed.run?.proposals[0]?.resultSkillId;
    expect(derivedId).toBeTruthy();
    const derived = (await state.library.execute({ action: "read", skillId: derivedId! })).skill!;
    expect(derived).toMatchObject({
      scope: { kind: "expert", expertId: expert.id },
      derivedFrom: { skillId: base.skillId, revision: base.revision, packageId: base.packageId },
    });
    expect((await state.library.execute({ action: "list" })).skills).toHaveLength(2);
    expect((await packages.list()).map((item) => item.packageId).sort()).toEqual(
      [...packagesBefore, derived.packageId].sort(),
    );
    expect(state.repository.events.size).toBe(1);
    expect([...state.repository.events.values()][0]).toMatchObject({
      operationId: apply.operationId,
      kind: "derived",
    });
    const appliedRecord = JSON.parse(state.repository.rows.get(run.requestId)!.record) as {
      intents: Array<{ operationId: string; createdAt?: string; appliedAt?: string }>;
    };
    const appliedIntent = appliedRecord.intents.find(
      (item) => item.operationId === apply.operationId,
    )!;
    expect(appliedIntent.createdAt).toBe(intent.createdAt);
    expect(appliedIntent.appliedAt).toBeTruthy();
    expect([...state.repository.events.values()][0]?.createdAt).toBe(appliedIntent.appliedAt);

    const afterFirstReplay = (await packages.list()).map((item) => item.packageId).sort();
    await state.service.execute({ action: "list", expertId: expert.id });
    await state.service.execute({ action: "read", requestId: run.requestId });
    expect((await state.library.execute({ action: "list" })).skills).toHaveLength(2);
    expect((await packages.list()).map((item) => item.packageId).sort()).toEqual(afterFirstReplay);
    expect(state.repository.events.size).toBe(1);
  });

  it("recovers an event append failure after an update without saving a second Skill revision", async () => {
    const state = await fixture();
    const expert = await createExpert(state.experts, "event-replay-owner");
    const base = await createSkill(state.library, {
      name: "Event Replay Shared Skill",
      policy: "shared",
      scope: { kind: "shared" },
    });
    await bind(
      state.library,
      expert,
      [{ skillId: base.skillId, enabled: true, activation: "on-demand" }],
      "bind-event-replay-base",
    );
    const source = addStandardSource(state.host, expert.id, "event-replay");
    const run = await startAndFinish(state, {
      requestId: "event-replay-run",
      expertId: expert.id,
      source,
      targetSkillId: base.skillId,
      response: proposalText({
        name: base.name,
        text: entry(base.name, "Updated before the history append failed."),
        threadId: source.threadId,
        messageId: source.assistantId,
      }),
    });
    const apply = applyRequest(run, "event-replay-operation");
    const packages = createSkillPackageStore(state.stateDir);
    const packagesBefore = (await packages.list()).map((item) => item.packageId).sort();
    const originalAppend = state.repository.repository.appendEvent;
    let failAppendOnce = true;
    const appendFailure = vi
      .spyOn(state.repository.repository, "appendEvent")
      .mockImplementation((event) => {
        if (failAppendOnce) {
          failAppendOnce = false;
          return Effect.fail(new Error("Injected crash after Skill save before event append."));
        }
        return originalAppend(event);
      });
    const interrupted = await state.service.execute(apply);
    appendFailure.mockRestore();
    expect(interrupted.run?.proposals[0]?.status).toBe("conflict");
    const savedOnce = (await state.library.execute({ action: "read", skillId: base.skillId }))
      .skill!;
    expect(savedOnce.revision).toBe(base.revision + 1);
    expect(state.repository.events.size).toBe(0);
    const packagesAfterSave = (await packages.list()).map((item) => item.packageId).sort();
    expect(packagesAfterSave).toHaveLength(packagesBefore.length + 1);

    await restartService(state);
    const resumed = await state.service.execute({ action: "read", requestId: run.requestId });
    expect(resumed.run?.proposals[0]?.status).toBe("applied");
    expect(
      (await state.library.execute({ action: "read", skillId: base.skillId })).skill,
    ).toMatchObject({
      skillId: base.skillId,
      revision: base.revision + 1,
      packageId: savedOnce.packageId,
    });
    expect((await packages.list()).map((item) => item.packageId).sort()).toEqual(packagesAfterSave);
    expect(state.repository.events.size).toBe(1);
    expect([...state.repository.events.values()][0]?.createdAt).toBeTruthy();

    await state.service.execute({ action: "read", requestId: run.requestId });
    await state.service.execute({ action: "list", expertId: expert.id });
    expect(
      (await state.library.execute({ action: "read", skillId: base.skillId })).skill?.revision,
    ).toBe(base.revision + 1);
    expect((await packages.list()).map((item) => item.packageId).sort()).toEqual(packagesAfterSave);
    expect(state.repository.events.size).toBe(1);
  });

  it("keeps proposal reads available after Expert archival without writing run, Skill, or event state", async () => {
    const state = await fixture();
    const expert = await createExpert(state.experts, "archived-read-owner");
    const source = addStandardSource(state.host, expert.id, "archived-read");
    const run = await startAndFinish(state, {
      requestId: "archived-read-run",
      expertId: expert.id,
      source,
      response: proposalText({
        name: "Archived Expert Candidate",
        text: entry("Archived Expert Candidate", "Candidate remains reviewable."),
        threadId: source.threadId,
        messageId: source.assistantId,
      }),
    });
    expect(run.status).toBe("proposal_ready");
    const beforeRow = clone(state.repository.rows.get(run.requestId)!);
    const beforeSkills = clone(await readSkillLibraryDefinitions(state.stateDir));
    const beforePackages = (await createSkillPackageStore(state.stateDir).list())
      .map((item) => item.packageId)
      .sort();
    await state.experts.archive(expert.id, expert.revision);
    const originalWrite = state.repository.repository.write;
    let writes = 0;
    const writeSpy = vi.spyOn(state.repository.repository, "write").mockImplementation((row) => {
      writes += 1;
      return originalWrite(row);
    });

    const read = await state.service.execute({ action: "read", requestId: run.requestId });
    const listed = await state.service.execute({ action: "list", expertId: expert.id });
    writeSpy.mockRestore();
    expect(read.run?.status).toBe("proposal_ready");
    expect(listed.runs?.map((item) => item.requestId)).toEqual([run.requestId]);
    expect(writes).toBe(0);
    expect(state.repository.rows.get(run.requestId)).toEqual(beforeRow);
    expect(await readSkillLibraryDefinitions(state.stateDir)).toEqual(beforeSkills);
    expect(
      (await createSkillPackageStore(state.stateDir).list()).map((item) => item.packageId).sort(),
    ).toEqual(beforePackages);
    expect(state.repository.events.size).toBe(0);
  });

  it("reports native startup rejection as failed without retrying or changing formal Skill state", async () => {
    const state = await fixture();
    const expert = await createExpert(state.experts, "native-startup-failure-owner");
    const source = addStandardSource(state.host, expert.id, "native-startup-failure");
    const started = await state.service.execute({
      action: "start",
      requestId: "native-startup-failure-run",
      expertId: expert.id,
      sources: [source],
      modelSelection,
    });
    await state.service.dispose();
    const taskThreadId = started.run!.taskThreadId!;
    const lastError = "Provider rejected startup before creating a native turn.";
    state.host.markNativeStartupFailure(taskThreadId, lastError);
    const startDispatchesBeforeRead = state.host.dispatches.filter(
      (command) => command.type === "thread.turn.start",
    );
    const pendingTurn = state.host.turns.get(taskThreadId)!.at(-1)!;
    const lastStart = startDispatchesBeforeRead.at(-1);
    expect(lastStart?.type).toBe("thread.turn.start");
    if (lastStart?.type !== "thread.turn.start") throw new Error("missing model dispatch");
    expect(pendingTurn).toMatchObject({
      turnId: null,
      state: "pending",
    });
    expect(pendingTurn.pendingMessageId).toBe(lastStart.message.messageId);
    expect((await state.host.readThread(taskThreadId))?.session).toMatchObject({
      status: "error",
      activeTurnId: null,
      lastError,
    });

    const failed = await state.service.execute({
      action: "read",
      requestId: started.run!.requestId,
    });

    expect(failed.run?.status).toBe("failed");
    expect(failed.run?.error).toBe(lastError);
    expect(
      state.host.dispatches.filter((command) => command.type === "thread.turn.start"),
    ).toHaveLength(startDispatchesBeforeRead.length);
    expect(await readSkillLibraryDefinitions(state.stateDir)).toEqual([]);
    expect(await createSkillPackageStore(state.stateDir).list()).toEqual([]);
    expect(state.repository.events.size).toBe(0);
  });

  it("keeps an ordinary native pending turn queued without resending the model task", async () => {
    const state = await fixture();
    const expert = await createExpert(state.experts, "native-pending-owner");
    const source = addStandardSource(state.host, expert.id, "native-pending");
    const started = await state.service.execute({
      action: "start",
      requestId: "native-pending-run",
      expertId: expert.id,
      sources: [source],
      modelSelection,
    });
    await state.service.dispose();
    const taskThreadId = started.run!.taskThreadId!;
    state.host.markLatestTurnPending(taskThreadId);
    expect(state.host.turns.get(taskThreadId)!.at(-1)).toMatchObject({
      turnId: null,
      state: "pending",
    });
    const startDispatchesBeforeRead = state.host.dispatches.filter(
      (command) => command.type === "thread.turn.start",
    );

    const pending = await state.service.execute({
      action: "read",
      requestId: started.run!.requestId,
    });

    expect(pending.run?.status).toBe("queued");
    expect(
      state.host.dispatches.filter((command) => command.type === "thread.turn.start"),
    ).toHaveLength(startDispatchesBeforeRead.length);
    expect(await readSkillLibraryDefinitions(state.stateDir)).toEqual([]);
    expect(state.repository.events.size).toBe(0);
  });
});
