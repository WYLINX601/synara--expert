import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  MessageId,
  ThreadId,
  TurnId,
  type ExpertSkillBinding,
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

  markLatestTurnInterrupted(threadId: string) {
    const turns = this.turns.get(threadId)!;
    const latest = turns.at(-1)!;
    latest.state = "interrupted";
    latest.completedAt = createdAt;
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
  skillBindings: readonly ExpertSkillBinding[] = [],
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
    expertId?: string;
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
        changes: options.changes,
      },
      {
        actor: ownerId,
        ...(options.expertId ? { createForExpertId: options.expertId } : {}),
      },
    )
  ).skill!;
}

async function bind(
  library: ReturnType<typeof createSkillLibraryStore>,
  expert: Awaited<ReturnType<typeof createExpert>>,
  bindings: readonly ExpertSkillBinding[],
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

function opportunityText(input: {
  name: string;
  threadId: string;
  messageId: string;
  targetSkillId?: string;
  quote?: string;
}) {
  return JSON.stringify({
    action: "opportunities",
    opportunities: [
      {
        name: input.name,
        reason: "The selected work contains a reusable decision procedure.",
        outcomes: ["Record the verified decision process."],
        evidence: [
          {
            threadId: input.threadId,
            messageId: input.messageId,
            quote: input.quote ?? "Verified evidence: keep a decision log.",
          },
        ],
        ...(input.targetSkillId ? { targetSkillId: input.targetSkillId } : {}),
      },
    ],
  });
}

async function completeStage(
  fixtureValue: Awaited<ReturnType<typeof fixture>>,
  run: SkillEvolutionRun,
  response: string,
): Promise<SkillEvolutionRun> {
  const taskThreadId = run.taskThreadId!;
  await fixtureValue.service.dispose();
  fixtureValue.host.completeLatest(taskThreadId, response);
  return (await fixtureValue.service.execute({ action: "read", requestId: run.requestId })).run!;
}

async function startDiscovery(
  fixtureValue: Awaited<ReturnType<typeof fixture>>,
  input: {
    requestId: string;
    expertId: string;
    sources: readonly { threadId: ThreadId; turnId: TurnId }[];
    focus?: string;
  },
): Promise<SkillEvolutionRun> {
  return (
    await fixtureValue.service.execute({
      action: "start",
      requestId: input.requestId,
      expertId: input.expertId,
      sources: input.sources,
      ...(input.focus ? { focus: input.focus } : {}),
      modelSelection,
    })
  ).run!;
}

async function startGeneration(
  fixtureValue: Awaited<ReturnType<typeof fixture>>,
  discovery: SkillEvolutionRun,
  requestId: string,
  feedback?: string,
): Promise<SkillEvolutionRun> {
  return (await fixtureValue.service.execute(generationRequest(discovery, requestId, feedback)))
    .run!;
}

function generationRequest(discovery: SkillEvolutionRun, requestId: string, feedback?: string) {
  const opportunity = discovery.opportunities?.[0];
  if (!opportunity) throw new Error("fixture discovery did not return an opportunity");
  return {
    action: "generate" as const,
    requestId,
    discoveryRequestId: discovery.requestId,
    opportunityId: opportunity.opportunityId,
    expectedDigest: opportunity.digest,
    ...(feedback !== undefined ? { feedback } : {}),
  };
}

async function startAndFinish(
  fixtureValue: Awaited<ReturnType<typeof fixture>>,
  input: {
    requestId: string;
    expertId: string;
    source: { threadId: ThreadId; turnId: TurnId };
    targetSkillId?: string;
    focus?: string;
    response: string;
  },
): Promise<SkillEvolutionRun> {
  const discoveryRequestId = `${input.requestId}-discovery`;
  const started = await startDiscovery(fixtureValue, {
    requestId: discoveryRequestId,
    expertId: input.expertId,
    sources: [input.source],
    ...(input.focus ? { focus: input.focus } : {}),
  });
  const discovery = await completeStage(
    fixtureValue,
    started,
    opportunityText({
      name: `Opportunity ${input.requestId}`,
      threadId: input.source.threadId,
      messageId: fixtureValue.host.threads
        .get(input.source.threadId)!
        .messages.find(
          (message) =>
            message.role === "assistant" &&
            message.turnId === input.source.turnId &&
            !message.streaming,
        )!.id,
      ...(input.targetSkillId ? { targetSkillId: input.targetSkillId } : {}),
    }),
  );
  const generated = await startGeneration(fixtureValue, discovery, input.requestId);
  return completeStage(fixtureValue, generated, input.response);
}

function applyRequest(run: SkillEvolutionRun, operationId: string) {
  const proposal = run.proposals[0]!;
  return {
    action: "apply" as const,
    requestId: run.requestId,
    proposalId: proposal.proposalId,
    expectedDigest: proposal.digest,
    operationId,
  };
}

async function deriveScenario(suffix: string) {
  const state = await fixture();
  const expert = await createExpert(state.experts, `binding-restore-${suffix}`);
  const sourceSkill = await createSkill(state.library, {
    name: `Binding Restore Source ${suffix}`,
  });
  await bind(
    state.library,
    expert,
    [{ skillId: sourceSkill.skillId, enabled: true, allowEvolution: true }],
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
  bindings: readonly ExpertSkillBinding[],
  requestId: string,
) {
  const expert = await state.experts.read(expertId);
  if (!expert) throw new Error("fixture Expert disappeared");
  return bind(state.library, expert, bindings, requestId);
}

describe("SkillEvolutionService deterministic workflows", () => {
  it("advertises the verified native OMP extraction capability", async () => {
    const state = await fixture();
    const capabilities = await state.service.execute({ action: "capabilities" });
    expect(capabilities.capabilities).toContainEqual({
      provider: "omp",
      supported: true,
      reason: "原生 ACP 会话已验证无工具、无环境技能及上下文文件。",
    });
  });

  it.each(["create", "derive"] as const)(
    "resumes a %s adoption after projecting removed metadata and preserves binding settings",
    async (action) => {
      const state = await fixture();
      const base = await createSkill(state.library, {
        name: `Managed ${action} source`,
      });
      const expert = await createExpert(state.experts, `managed-${action}-adoption`, [
        {
          skillId: base.skillId,
          enabled: true,
          ...(action === "derive" ? { allowEvolution: true } : {}),
          selectionScope: "package",
          resourceMode: "run-private",
        },
      ]);
      const source = addStandardSource(state.host, expert.id);
      const run = await startAndFinish(state, {
        requestId: `managed-${action}-run`,
        expertId: expert.id,
        source,
        ...(action === "derive" ? { targetSkillId: base.skillId } : {}),
        response: proposalText({
          name: `Managed ${action} candidate`,
          text: entry(`Managed ${action} candidate`, "Verified workflow improvement."),
          threadId: source.threadId,
          messageId: source.assistantId,
        }),
      });
      const originalBindings = (await state.experts.read(expert.id))!.skillBindings;
      const execute = state.library.execute.bind(state.library);
      let failOnce = true;
      const spy = vi.spyOn(state.library, "execute").mockImplementation((request, context) => {
        if (failOnce && request.action === "bindings" && request.operation === "set") {
          failOnce = false;
          return Promise.reject(new Error("Interrupted before saving current bindings."));
        }
        return execute(request, context);
      });
      const operation = applyRequest(run, `managed-${action}-apply`);
      const partial = await state.service.execute(operation);
      spy.mockRestore();
      expect(partial.run?.proposals[0]?.status, partial.run?.proposals[0]?.error).toBe(
        "saved_unbound",
      );
      expect((await state.experts.read(expert.id))!.skillBindings).toEqual(originalBindings);
      const count = (await state.library.execute({ action: "list" })).items?.length;
      const storedRow = state.repository.rows.get(run.requestId)!;
      const stored = JSON.parse(storedRow.record) as {
        bindings: Array<Record<string, unknown>>;
      };
      stored.bindings[0]!.activation = "startup";
      state.repository.rows.set(run.requestId, { ...storedRow, record: JSON.stringify(stored) });
      await restartService(state);
      const applied = await state.service.execute(operation);
      expect(applied.run?.proposals[0]?.status, applied.run?.proposals[0]?.error).toBe("applied");
      expect((await state.library.execute({ action: "list" })).items?.length).toBe(count);
      const bindings = (await state.experts.read(expert.id))!.skillBindings!;
      expect(bindings).toHaveLength(action === "create" ? 2 : 1);
      expect(
        bindings.some((binding) => binding.skillId === applied.run?.proposals[0]?.resultSkillId),
      ).toBe(true);
      expect(bindings[0]).toMatchObject({
        enabled: true,
        selectionScope: "package",
        resourceMode: "run-private",
      });
      expect(bindings[0]).not.toHaveProperty("activation");
      if (action === "create") {
        const createdBinding = bindings.find(
          (binding) => binding.skillId === applied.run?.proposals[0]?.resultSkillId,
        );
        expect(createdBinding).toMatchObject({ enabled: true });
        expect(createdBinding).not.toHaveProperty("allowEvolution");
      }
      expect(state.repository.events.size).toBe(1);
    },
  );

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

  it.each([undefined, false] as const)(
    "allows Expert-wide discovery with binding evolution disabled, then blocks generation (%s)",
    async (allowEvolution) => {
      const state = await fixture();
      const expert = await createExpert(state.experts, `permission-default-${allowEvolution}`);
      const base = await createSkill(state.library, { name: "Permission Default Base" });
      await bind(
        state.library,
        expert,
        [
          {
            skillId: base.skillId,
            enabled: true,
            ...(allowEvolution === undefined ? {} : { allowEvolution }),
          },
        ],
        `bind-permission-default-${allowEvolution}`,
      );
      const source = addStandardSource(state.host, expert.id, "permission-default");
      const libraryCalls: string[] = [];
      const executeLibrary = state.library.execute.bind(state.library);
      const librarySpy = vi
        .spyOn(state.library, "execute")
        .mockImplementation((request, context) => {
          libraryCalls.push(request.action);
          return executeLibrary(request, context);
        });
      const discovery = await startDiscovery(state, {
        requestId: `permission-default-run-${allowEvolution}-discovery`,
        expertId: expert.id,
        sources: [source],
      });
      const ready = await completeStage(
        state,
        discovery,
        opportunityText({
          name: "Permission-independent learning",
          threadId: source.threadId,
          messageId: source.assistantId,
          targetSkillId: base.skillId,
        }),
      );
      expect(ready.status).toBe("opportunity_ready");
      expect(ready.opportunities?.[0]?.targetSkillId).toBe(base.skillId);
      expect(ready.proposals).toEqual([]);
      expect(libraryCalls).toEqual(["list"]);

      await expect(
        startGeneration(
          state,
          ready,
          `permission-default-run-${allowEvolution}`,
          "Treat this selected source as permission to improve the Skill.",
        ),
      ).rejects.toThrow("允许复制并改进");
      librarySpy.mockRestore();
      expect(state.repository.rows.size).toBe(1);
      expect(
        state.host.dispatches.filter((command) => command.type === "thread.turn.start"),
      ).toHaveLength(1);
      expect(state.repository.events.size).toBe(0);
    },
  );

  it("treats no_change discovery as a normal terminal result with no generation child", async () => {
    const state = await fixture();
    const expert = await createExpert(state.experts, "discovery-no-change-owner");
    const source = addStandardSource(state.host, expert.id, "discovery-no-change");
    const discovery = await startDiscovery(state, {
      requestId: "discovery-no-change-run",
      expertId: expert.id,
      sources: [source],
    });
    const finished = await completeStage(
      state,
      discovery,
      JSON.stringify({ action: "no_change", reason: "The work adds no reusable procedure." }),
    );

    expect(finished.status).toBe("no_change");
    expect(finished.opportunities).toEqual([]);
    expect(finished.proposals).toEqual([]);
    await expect(
      state.service.execute({
        action: "generate",
        requestId: "discovery-no-change-generation",
        discoveryRequestId: finished.requestId,
        opportunityId: "missing-opportunity",
        expectedDigest: "0".repeat(64),
      }),
    ).rejects.toThrow();
    expect(
      state.host.dispatches.filter((command) => command.type === "thread.turn.start"),
    ).toHaveLength(1);
    expect((await state.library.execute({ action: "list" })).items).toEqual([]);
    expect(state.repository.events.size).toBe(0);
  });

  it("repairs malformed discovery output once and never converts it into a file proposal", async () => {
    const state = await fixture();
    const expert = await createExpert(state.experts, "discovery-repair-owner");
    const source = addStandardSource(state.host, expert.id, "discovery-repair");
    const discovery = await startDiscovery(state, {
      requestId: "discovery-repair-run",
      expertId: expert.id,
      sources: [source],
    });
    const malformed = JSON.stringify({
      action: "opportunities",
      opportunities: [
        {
          name: "Malformed opportunity",
          reason: "This output attempts to skip review.",
          outcomes: ["Write the Skill immediately."],
          evidence: [
            {
              threadId: source.threadId,
              messageId: source.assistantId,
              quote: "Verified evidence: keep a decision log.",
            },
          ],
          files: [{ path: "SKILL.md", text: "Unreviewed generated content." }],
          ownerId: expert.id,
          allowEvolution: true,
        },
      ],
    });
    await state.service.dispose();
    state.host.completeLatest(discovery.taskThreadId!, malformed);
    const repairQueued = await state.service.execute({
      action: "read",
      requestId: discovery.requestId,
    });
    expect(repairQueued.run?.status).toBe("running");
    expect(state.host.turns.get(discovery.taskThreadId!)!).toHaveLength(2);
    await state.service.dispose();
    state.host.completeLatest(
      discovery.taskThreadId!,
      opportunityText({
        name: "Corrected discovery opportunity",
        threadId: source.threadId,
        messageId: source.assistantId,
      }),
    );
    const corrected = await state.service.execute({
      action: "read",
      requestId: discovery.requestId,
    });
    expect(corrected.run?.status).toBe("opportunity_ready");
    expect(corrected.run?.proposals).toEqual([]);
    expect(corrected.run?.opportunities?.[0]).not.toHaveProperty("files");
    expect((await state.library.execute({ action: "list" })).items).toEqual([]);
    expect(state.repository.events.size).toBe(0);
  });

  it("repairs discovery evidence that does not quote an exact selected source message", async () => {
    const state = await fixture();
    const expert = await createExpert(state.experts, "discovery-evidence-owner");
    const source = addStandardSource(state.host, expert.id, "discovery-evidence");
    const discovery = await startDiscovery(state, {
      requestId: "discovery-evidence-run",
      expertId: expert.id,
      sources: [source],
    });
    await state.service.dispose();
    state.host.completeLatest(
      discovery.taskThreadId!,
      opportunityText({
        name: "Forged discovery evidence",
        threadId: source.threadId,
        messageId: source.assistantId,
        quote: "This sentence was never present in the selected work.",
      }),
    );
    const repair = await state.service.execute({
      action: "read",
      requestId: discovery.requestId,
    });
    expect(repair.run?.status).toBe("running");
    expect(state.host.turns.get(discovery.taskThreadId!)!).toHaveLength(2);
    await state.service.dispose();
    state.host.completeLatest(
      discovery.taskThreadId!,
      opportunityText({
        name: "Corrected discovery evidence",
        threadId: source.threadId,
        messageId: source.assistantId,
      }),
    );
    const corrected = await state.service.execute({
      action: "read",
      requestId: discovery.requestId,
    });
    expect(corrected.run?.status).toBe("opportunity_ready");
    expect(corrected.run?.opportunities?.[0]?.evidence[0]?.quote).toBe(
      "Verified evidence: keep a decision log.",
    );
  });

  it("resumes an identical generation request without dispatching twice and rejects payload reuse", async () => {
    const state = await fixture();
    const expert = await createExpert(state.experts, "generation-resume-owner");
    const base = await createSkill(state.library, { name: "Generation Resume Skill" });
    await bind(
      state.library,
      expert,
      [{ skillId: base.skillId, enabled: true, allowEvolution: true }],
      "bind-generation-resume-skill",
    );
    const source = addStandardSource(state.host, expert.id, "generation-resume");
    const discoveryStart = await startDiscovery(state, {
      requestId: "generation-resume-discovery",
      expertId: expert.id,
      sources: [source],
    });
    const discovery = await completeStage(
      state,
      discoveryStart,
      opportunityText({
        name: "Generation resume opportunity",
        threadId: source.threadId,
        messageId: source.assistantId,
        targetSkillId: base.skillId,
      }),
    );
    const opportunity = discovery.opportunities![0]!;
    const payload = {
      action: "generate" as const,
      requestId: "generation-resume-child",
      discoveryRequestId: discovery.requestId,
      opportunityId: opportunity.opportunityId,
      expectedDigest: opportunity.digest,
      feedback: "Keep the verified decision log outcome.",
    };
    const first = await state.service.execute(payload);
    const child = first.run!;
    const startsBeforeResume = state.host.dispatches.filter(
      (command) => command.type === "thread.turn.start",
    ).length;
    const resumed = await state.service.execute(payload);

    expect(child).toMatchObject({
      stage: "generation",
      expertId: expert.id,
      discoveryRequestId: discovery.requestId,
      opportunityId: opportunity.opportunityId,
      generationIndex: 1,
      feedback: payload.feedback,
    });
    const storedChild = JSON.parse(state.repository.rows.get(child.requestId)!.record) as {
      ownerId: string;
      opportunityDigest?: string;
      run: SkillEvolutionRun;
    };
    expect(storedChild).toMatchObject({
      ownerId,
      opportunityDigest: opportunity.digest,
      run: { expertId: expert.id, sourceSelections: discovery.sourceSelections },
    });
    expect(resumed.run?.taskThreadId).toBe(child.taskThreadId);
    expect(
      state.host.dispatches.filter((command) => command.type === "thread.turn.start"),
    ).toHaveLength(startsBeforeResume);
    await expect(
      state.service.execute({ ...payload, feedback: "Different payload under the same ID." }),
    ).rejects.toThrow();
    await expect(
      state.service.execute({ ...payload, expectedDigest: "f".repeat(64) }),
    ).rejects.toThrow();

    const createdTask = state.host.dispatches.find(
      (command) => command.type === "thread.create" && command.threadId === child.taskThreadId,
    );
    expect(createdTask).toMatchObject({ type: "thread.create", modelSelection });
    const generationPrompt = state.host.dispatches.find(
      (command) => command.type === "thread.turn.start" && command.threadId === child.taskThreadId,
    );
    expect(
      generationPrompt?.type === "thread.turn.start" ? generationPrompt.message.text : "",
    ).toContain("Keep the verified decision log outcome.");
    expect(
      generationPrompt?.type === "thread.turn.start" ? generationPrompt.message.text : "",
    ).toContain("Verified evidence: keep a decision log.");
  });

  it("allows a new empty-feedback retry after a generation child fails and preserves its old result", async () => {
    const state = await fixture();
    const expert = await createExpert(state.experts, "generation-failed-retry-owner");
    const source = addStandardSource(state.host, expert.id, "generation-failed-retry");
    const discoveryStart = await startDiscovery(state, {
      requestId: "generation-failed-retry-discovery",
      expertId: expert.id,
      sources: [source],
    });
    const discovery = await completeStage(
      state,
      discoveryStart,
      opportunityText({
        name: "Failed retry opportunity",
        threadId: source.threadId,
        messageId: source.assistantId,
      }),
    );
    const parentRecord = clone(state.repository.rows.get(discovery.requestId));
    const feedback = "";
    const originalRequest = generationRequest(discovery, "generation-failed-first", feedback);
    const first = (await state.service.execute(originalRequest)).run!;
    expect(first.generationIndex).toBe(1);
    await expect(
      state.service.execute(generationRequest(discovery, "generation-failed-while-busy", feedback)),
    ).rejects.toThrow();

    const lastError = "Provider failed before producing a completed generation turn.";
    await state.service.dispose();
    state.host.markNativeStartupFailure(first.taskThreadId!, lastError);
    const failed = await state.service.execute({ action: "read", requestId: first.requestId });
    expect(failed.run).toMatchObject({ status: "failed", error: lastError, generationIndex: 1 });
    const failedRecord = clone(state.repository.rows.get(first.requestId));
    const startsBeforeReplay = state.host.dispatches.filter(
      (command) => command.type === "thread.turn.start",
    ).length;
    const replayed = await state.service.execute(originalRequest);
    expect(replayed.run).toMatchObject({
      requestId: first.requestId,
      taskThreadId: first.taskThreadId,
      status: "failed",
      generationIndex: 1,
      feedback,
    });
    expect(state.repository.rows.get(first.requestId)).toEqual(failedRecord);
    expect(
      state.host.dispatches.filter((command) => command.type === "thread.turn.start"),
    ).toHaveLength(startsBeforeReplay);

    const retryRequest = generationRequest(discovery, "generation-failed-retry-new-id", feedback);
    const retry = (await state.service.execute(retryRequest)).run!;
    expect(retry).toMatchObject({
      stage: "generation",
      discoveryRequestId: discovery.requestId,
      opportunityId: discovery.opportunities?.[0]?.opportunityId,
      generationIndex: 2,
      feedback,
      sourceSelections: discovery.sourceSelections,
      modelSelection: discovery.modelSelection,
    });
    expect(retry.taskThreadId).not.toBe(first.taskThreadId);
    expect(state.repository.rows.get(discovery.requestId)).toEqual(parentRecord);
    expect(state.repository.rows.get(first.requestId)).toEqual(failedRecord);
    expect(
      state.host.dispatches.find(
        (command) => command.type === "thread.create" && command.threadId === retry.taskThreadId,
      ),
    ).toMatchObject({ type: "thread.create", modelSelection });
    expect(
      state.host.dispatches.some(
        (command) =>
          command.type === "thread.turn.start" && command.threadId === retry.taskThreadId,
      ),
    ).toBe(true);
    expect((await state.library.execute({ action: "list" })).items).toEqual([]);
    expect(state.repository.events.size).toBe(0);
  });

  it("allows a no-feedback retry after cancellation but blocks cancel_requested children", async () => {
    const state = await fixture();
    const expert = await createExpert(state.experts, "generation-cancel-retry-owner");
    const source = addStandardSource(state.host, expert.id, "generation-cancel-retry");
    const discoveryStart = await startDiscovery(state, {
      requestId: "generation-cancel-retry-discovery",
      expertId: expert.id,
      sources: [source],
    });
    const discovery = await completeStage(
      state,
      discoveryStart,
      opportunityText({
        name: "Cancelled retry opportunity",
        threadId: source.threadId,
        messageId: source.assistantId,
      }),
    );
    const parentRecord = clone(state.repository.rows.get(discovery.requestId));
    const originalRequest = generationRequest(discovery, "generation-cancelled-first");
    const first = (await state.service.execute(originalRequest)).run!;
    expect(first.generationIndex).toBe(1);
    await expect(
      state.service.execute(generationRequest(discovery, "generation-cancelled-while-busy")),
    ).rejects.toThrow();

    const cancelling = await state.service.execute({
      action: "cancel",
      requestId: first.requestId,
    });
    expect(cancelling.run?.status).toBe("cancel_requested");
    await expect(
      state.service.execute(generationRequest(discovery, "generation-cancelled-while-stopping")),
    ).rejects.toThrow();

    await state.service.dispose();
    state.host.markLatestTurnInterrupted(first.taskThreadId!);
    const cancelled = await state.service.execute({ action: "read", requestId: first.requestId });
    expect(cancelled.run?.status).toBe("cancelled");
    const cancelledRecord = clone(state.repository.rows.get(first.requestId));
    const startsBeforeReplay = state.host.dispatches.filter(
      (command) => command.type === "thread.turn.start",
    ).length;
    const replayed = await state.service.execute(originalRequest);
    expect(replayed.run).toMatchObject({
      requestId: first.requestId,
      taskThreadId: first.taskThreadId,
      status: "cancelled",
      generationIndex: 1,
    });
    expect(state.repository.rows.get(first.requestId)).toEqual(cancelledRecord);
    expect(
      state.host.dispatches.filter((command) => command.type === "thread.turn.start"),
    ).toHaveLength(startsBeforeReplay);

    const retry = (
      await state.service.execute(generationRequest(discovery, "generation-cancelled-retry-new-id"))
    ).run!;
    expect(retry).toMatchObject({
      stage: "generation",
      discoveryRequestId: discovery.requestId,
      opportunityId: discovery.opportunities?.[0]?.opportunityId,
      generationIndex: 2,
      sourceSelections: discovery.sourceSelections,
      modelSelection: discovery.modelSelection,
    });
    expect(retry.taskThreadId).not.toBe(first.taskThreadId);
    expect(state.repository.rows.get(discovery.requestId)).toEqual(parentRecord);
    expect(state.repository.rows.get(first.requestId)).toEqual(cancelledRecord);
    expect(
      state.host.dispatches.find(
        (command) => command.type === "thread.create" && command.threadId === retry.taskThreadId,
      ),
    ).toMatchObject({ type: "thread.create", modelSelection });
    expect(
      state.host.dispatches.some(
        (command) =>
          command.type === "thread.turn.start" && command.threadId === retry.taskThreadId,
      ),
    ).toBe(true);
    expect((await state.library.execute({ action: "list" })).items).toEqual([]);
    expect(state.repository.events.size).toBe(0);
  });

  it("increments generationIndex for feedback regeneration and rejects the superseded draft", async () => {
    const state = await fixture();
    const expert = await createExpert(state.experts, "generation-revision-owner");
    const base = await createSkill(state.library, { name: "Generation Revision Skill" });
    await bind(
      state.library,
      expert,
      [{ skillId: base.skillId, enabled: true, allowEvolution: true }],
      "bind-generation-revision-skill",
    );
    const source = addStandardSource(state.host, expert.id, "generation-revision");
    const discoveryStart = await startDiscovery(state, {
      requestId: "generation-revision-discovery",
      expertId: expert.id,
      sources: [source],
    });
    const discovery = await completeStage(
      state,
      discoveryStart,
      opportunityText({
        name: "Generation revision opportunity",
        threadId: source.threadId,
        messageId: source.assistantId,
        targetSkillId: base.skillId,
      }),
    );
    const originalDiscoveryRecord = clone(state.repository.rows.get(discovery.requestId));
    const firstChild = await startGeneration(state, discovery, "generation-revision-one");
    const first = await completeStage(
      state,
      firstChild,
      proposalText({
        name: base.name,
        text: entry(base.name, "First review draft."),
        threadId: source.threadId,
        messageId: source.assistantId,
      }),
    );
    expect(first.generationIndex).toBe(1);

    await expect(
      startGeneration(state, discovery, "generation-revision-without-feedback"),
    ).rejects.toThrow("请提供具体反馈");
    const feedback = "Keep the approval check and include an explicit recovery step.";
    const secondChild = await startGeneration(
      state,
      discovery,
      "generation-revision-two",
      feedback,
    );
    expect(secondChild).toMatchObject({
      stage: "generation",
      discoveryRequestId: discovery.requestId,
      opportunityId: discovery.opportunities?.[0]?.opportunityId,
      generationIndex: 2,
      feedback,
    });
    const secondPrompt = state.host.dispatches.find(
      (command) =>
        command.type === "thread.turn.start" && command.threadId === secondChild.taskThreadId,
    );
    expect(secondPrompt?.type === "thread.turn.start" ? secondPrompt.message.text : "").toContain(
      feedback,
    );
    const second = await completeStage(
      state,
      secondChild,
      proposalText({
        name: base.name,
        text: entry(base.name, "Revised review draft."),
        threadId: source.threadId,
        messageId: source.assistantId,
      }),
    );
    expect(second.status).toBe("proposal_ready");
    expect(state.repository.rows.get(discovery.requestId)).toEqual(originalDiscoveryRecord);
    await expect(
      state.service.execute(applyRequest(first, "apply-superseded-generation-draft")),
    ).rejects.toThrow();
    expect((await state.library.execute({ action: "read", skillId: base.skillId })).skill).toEqual(
      base,
    );
    expect(state.repository.events.size).toBe(0);
  });

  it("still requires feedback to retry a completed no_change generation", async () => {
    const state = await fixture();
    const expert = await createExpert(state.experts, "generation-no-change-retry-owner");
    const source = addStandardSource(state.host, expert.id, "generation-no-change-retry");
    const discoveryStart = await startDiscovery(state, {
      requestId: "generation-no-change-retry-discovery",
      expertId: expert.id,
      sources: [source],
    });
    const discovery = await completeStage(
      state,
      discoveryStart,
      opportunityText({
        name: "No-change retry opportunity",
        threadId: source.threadId,
        messageId: source.assistantId,
      }),
    );
    const firstChild = await startGeneration(state, discovery, "generation-no-change-first");
    const first = await completeStage(
      state,
      firstChild,
      JSON.stringify({ action: "no_change", reason: "The current Skill already covers it." }),
    );
    expect(first.status).toBe("no_change");
    await expect(
      startGeneration(state, discovery, "generation-no-change-without-feedback"),
    ).rejects.toThrow("请提供具体反馈");

    const retry = await startGeneration(
      state,
      discovery,
      "generation-no-change-with-feedback",
      "Consider a narrower outcome that is missing from the current Skill.",
    );
    expect(retry).toMatchObject({ stage: "generation", generationIndex: 2 });
    expect(retry.feedback).toContain("narrower outcome");
    expect((await state.library.execute({ action: "list" })).items).toEqual([]);
    expect(state.repository.events.size).toBe(0);
  });

  it("dismisses an opportunity in place and blocks generation without changing its evidence", async () => {
    const state = await fixture();
    const expert = await createExpert(state.experts, "dismiss-opportunity-owner");
    const source = addStandardSource(state.host, expert.id, "dismiss-opportunity");
    const discoveryStart = await startDiscovery(state, {
      requestId: "dismiss-opportunity-discovery",
      expertId: expert.id,
      sources: [source],
    });
    const discovery = await completeStage(
      state,
      discoveryStart,
      opportunityText({
        name: "Dismissable learning",
        threadId: source.threadId,
        messageId: source.assistantId,
      }),
    );
    const opportunity = discovery.opportunities![0]!;
    const dismissed = await state.service.execute({
      action: "dismissOpportunity",
      requestId: discovery.requestId,
      opportunityId: opportunity.opportunityId,
      expectedDigest: opportunity.digest,
    });
    expect(dismissed.run?.status).toBe("opportunity_ready");
    expect(dismissed.run?.opportunities?.[0]).toEqual({ ...opportunity, status: "dismissed" });
    await expect(
      startGeneration(state, dismissed.run!, "dismissed-opportunity-child"),
    ).rejects.toThrow();
    expect(state.repository.rows.size).toBe(1);
    expect(
      state.host.dispatches.filter((command) => command.type === "thread.turn.start"),
    ).toHaveLength(1);
    expect((await state.library.execute({ action: "list" })).items).toEqual([]);
    expect(state.repository.events.size).toBe(0);
  });

  it("keeps existing generation drafts inert after their parent opportunity is dismissed", async () => {
    const state = await fixture();
    const expert = await createExpert(state.experts, "dismiss-draft-owner");
    const source = addStandardSource(state.host, expert.id, "dismiss-draft");
    const discoveryStart = await startDiscovery(state, {
      requestId: "dismiss-draft-discovery",
      expertId: expert.id,
      sources: [source],
    });
    const discovery = await completeStage(
      state,
      discoveryStart,
      opportunityText({
        name: "Dismissed draft opportunity",
        threadId: source.threadId,
        messageId: source.assistantId,
      }),
    );
    const childStart = await startGeneration(state, discovery, "dismiss-draft-child");
    const child = await completeStage(
      state,
      childStart,
      proposalText({
        name: "Dismissed draft skill",
        text: entry("Dismissed draft skill", "This candidate must remain inert."),
        threadId: source.threadId,
        messageId: source.assistantId,
      }),
    );
    const proposal = child.proposals[0]!;
    const childRecord = clone(state.repository.rows.get(child.requestId));
    const opportunity = discovery.opportunities![0]!;
    await state.service.execute({
      action: "dismissOpportunity",
      requestId: discovery.requestId,
      opportunityId: opportunity.opportunityId,
      expectedDigest: opportunity.digest,
    });

    await expect(
      state.service.execute(applyRequest(child, "dismissed-draft-apply")),
    ).rejects.toThrow();
    await expect(
      state.service.execute({
        action: "reject",
        requestId: child.requestId,
        proposalId: proposal.proposalId,
        expectedDigest: proposal.digest,
      }),
    ).rejects.toThrow();
    await expect(
      state.service.execute({
        action: "edit",
        requestId: child.requestId,
        proposalId: proposal.proposalId,
        expectedDigest: proposal.digest,
        name: proposal.name,
        changes: [
          {
            path: "SKILL.md",
            content: Buffer.from(entry(proposal.name, "Edited after dismissal.")).toString(
              "base64",
            ),
          },
        ],
      }),
    ).rejects.toThrow();

    expect(state.repository.rows.get(child.requestId)).toEqual(childRecord);
    expect((await state.library.execute({ action: "list" })).items).toEqual([]);
    expect(state.repository.events.size).toBe(0);
  });

  it("blocks an adoption when binding permission is revoked after a proposal", async () => {
    const state = await fixture();
    const expert = await createExpert(state.experts, "revoked-proposal-owner");
    const base = await createSkill(state.library, { name: "Revoked Proposal Base" });
    const allowed = { skillId: base.skillId, enabled: true, allowEvolution: true };
    await bind(state.library, expert, [allowed], "bind-revoked-proposal-base");
    const source = addStandardSource(state.host, expert.id, "revoked-proposal");
    const run = await startAndFinish(state, {
      requestId: "revoked-proposal-run",
      expertId: expert.id,
      source,
      targetSkillId: base.skillId,
      response: proposalText({
        name: "Revoked Proposal Copy",
        text: entry("Revoked Proposal Copy", "Candidate must not be adopted after revocation."),
        threadId: source.threadId,
        messageId: source.assistantId,
      }),
    });
    await bind(
      state.library,
      (await state.experts.read(expert.id))!,
      [{ ...allowed, allowEvolution: false }],
      "revoke-after-proposal",
    );

    await expect(
      state.service.execute(applyRequest(run, "revoked-proposal-operation")),
    ).rejects.toThrow("允许复制并改进");
    expect((await state.library.execute({ action: "read", skillId: base.skillId })).skill).toEqual(
      base,
    );
    expect((await state.experts.read(expert.id))?.skillBindings).toEqual([
      { ...allowed, allowEvolution: false },
    ]);
    expect(state.repository.events.size).toBe(0);
  });

  it("does not replay a durable adoption intent after binding permission is revoked", async () => {
    const state = await fixture();
    const expert = await createExpert(state.experts, "revoked-intent-owner");
    const base = await createSkill(state.library, { name: "Revoked Intent Base" });
    const allowed = { skillId: base.skillId, enabled: true, allowEvolution: true };
    await bind(state.library, expert, [allowed], "bind-revoked-intent-base");
    const source = addStandardSource(state.host, expert.id, "revoked-intent");
    const run = await startAndFinish(state, {
      requestId: "revoked-intent-run",
      expertId: expert.id,
      source,
      targetSkillId: base.skillId,
      response: proposalText({
        name: "Revoked Intent Copy",
        text: entry("Revoked Intent Copy", "A durable intent still needs current permission."),
        threadId: source.threadId,
        messageId: source.assistantId,
      }),
    });
    const operation = applyRequest(run, "revoked-intent-operation");
    const executeLibrary = state.library.execute.bind(state.library);
    let interruptBeforeDerive = true;
    const interruption = vi
      .spyOn(state.library, "execute")
      .mockImplementation((request, context) => {
        if (
          interruptBeforeDerive &&
          request.action === "derive" &&
          request.requestId === "evolution:revoked-intent-operation"
        ) {
          interruptBeforeDerive = false;
          return Promise.reject(new Error("Injected crash before private-copy creation."));
        }
        return executeLibrary(request, context);
      });
    const interrupted = await state.service.execute(operation);
    interruption.mockRestore();
    expect(interrupted.run?.proposals[0]?.status).toBe("conflict");
    const durable = JSON.parse(state.repository.rows.get(run.requestId)!.record) as {
      intents: Array<{ operationId: string; result?: unknown }>;
    };
    expect(durable.intents).toHaveLength(1);
    expect(durable.intents[0]).toMatchObject({ operationId: operation.operationId });
    expect(durable.intents[0]).not.toHaveProperty("result");

    await bind(
      state.library,
      (await state.experts.read(expert.id))!,
      [{ ...allowed, allowEvolution: false }],
      "revoke-durable-intent",
    );
    await restartService(state);
    const replayed = await state.service.execute({ action: "read", requestId: run.requestId });

    expect(replayed.run?.proposals[0]?.status).toBe("conflict");
    expect(replayed.run?.proposals[0]?.error).toContain("允许复制并改进");
    expect((await state.library.execute({ action: "list" })).items).toHaveLength(1);
    expect((await state.library.execute({ action: "read", skillId: base.skillId })).skill).toEqual(
      base,
    );
    expect((await state.experts.read(expert.id))?.skillBindings).toEqual([
      { ...allowed, allowEvolution: false },
    ]);
    expect(state.repository.events.size).toBe(0);
  });

  it("repairs a discovery target outside the Expert's bound catalog", async () => {
    const state = await fixture();
    const owner = await createExpert(state.experts, "private-scope-owner");
    const other = await createExpert(state.experts, "private-scope-other");
    const privateSkill = await createSkill(state.library, {
      name: "Owned Private Target",
      expertId: owner.id,
    });
    await bind(
      state.library,
      owner,
      [{ skillId: privateSkill.skillId, enabled: true, allowEvolution: true }],
      "bind-private-scope-owner",
    );
    const source = addStandardSource(state.host, other.id, "private-scope");

    const discovery = await startDiscovery(state, {
      requestId: "private-scope-discovery",
      expertId: other.id,
      sources: [source],
    });
    await state.service.dispose();
    state.host.completeLatest(
      discovery.taskThreadId!,
      opportunityText({
        name: "Foreign private target",
        threadId: source.threadId,
        messageId: source.assistantId,
        targetSkillId: privateSkill.skillId,
      }),
    );
    const repair = await state.service.execute({
      action: "read",
      requestId: discovery.requestId,
    });
    expect(repair.run?.status).toBe("running");
    expect(state.host.turns.get(discovery.taskThreadId!)!).toHaveLength(2);
    await state.service.dispose();
    state.host.completeLatest(
      discovery.taskThreadId!,
      opportunityText({
        name: "Valid new learning",
        threadId: source.threadId,
        messageId: source.assistantId,
      }),
    );
    const ready = await state.service.execute({
      action: "read",
      requestId: discovery.requestId,
    });
    expect(ready.run?.status).toBe("opportunity_ready");
    expect(ready.run?.opportunities?.[0]).not.toHaveProperty("targetSkillId");
    expect(state.repository.events.size).toBe(0);
  });

  it("adopts a shared Skill into an Expert-private copy and updates that copy in place", async () => {
    const state = await fixture();
    const expert = await createExpert(state.experts, "private-adopter");
    const secondExpert = await createExpert(state.experts, "private-adopter-second");
    const base = await createSkill(state.library, {
      name: "Shared Template",
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
    const firstBinding = {
      skillId: base.skillId,
      enabled: true,
      allowEvolution: true,
      selectionScope: "package" as const,
      resourceMode: "run-private" as const,
    };
    const secondBinding = { skillId: base.skillId, enabled: false };
    await bind(state.library, expert, [firstBinding], "bind-private-adopter");
    await bind(state.library, secondExpert, [secondBinding], "bind-private-adopter-second");
    const source = addStandardSource(state.host, expert.id, "shared-adoption");
    const run = await startAndFinish(state, {
      requestId: "shared-adoption-run",
      expertId: expert.id,
      source,
      targetSkillId: base.skillId,
      response: proposalText({
        name: "Private Specialist Copy",
        text: entry("Private Specialist Copy", "Personalized specialist workflow."),
        threadId: source.threadId,
        messageId: source.assistantId,
      }),
    });
    expect(run.proposals[0]?.action).toBe("derive");
    const operation = applyRequest(run, "shared-adoption-operation");
    const result = await state.service.execute(operation);
    const privateCopy = result.skill!;
    expect(privateCopy).toMatchObject({
      revision: 1,
      scope: { kind: "expert", expertId: expert.id },
      derivedFrom: { skillId: base.skillId, revision: base.revision, packageId: base.packageId },
    });
    expect((await state.experts.read(expert.id))?.skillBindings).toEqual([
      { ...firstBinding, skillId: privateCopy.skillId },
    ]);
    expect((await state.experts.read(secondExpert.id))?.skillBindings).toEqual([secondBinding]);
    expect(await state.library.execute({ action: "read", skillId: base.skillId })).toMatchObject({
      skill: base,
    });
    expect(
      (
        await state.library.execute({
          action: "readFile",
          skillId: privateCopy.skillId,
          path: "references/keep.txt",
        })
      ).file?.content,
    ).toBe(Buffer.from("Keep this immutable resource.").toString("base64"));
    expect(
      (
        await state.library.execute({
          action: "readFile",
          skillId: privateCopy.skillId,
          path: "references/change.txt",
        })
      ).file?.content,
    ).toBe(Buffer.from("Old resource.").toString("base64"));
    expect(
      (
        await state.library.execute({
          action: "readFile",
          skillId: privateCopy.skillId,
          path: "bin/payload.bin",
        })
      ).file?.content,
    ).toBe(Buffer.from([0, 255, 2, 128]).toString("base64"));

    const countAfterAdoption = (await state.library.execute({ action: "list" })).items?.length;
    const originalCopyBinding = (await state.experts.read(expert.id))!.skillBindings!;
    const privateSource = addStandardSource(state.host, expert.id, "private-update");
    const privateRun = await startAndFinish(state, {
      requestId: "private-update-run",
      expertId: expert.id,
      source: privateSource,
      targetSkillId: privateCopy.skillId,
      response: proposalText({
        name: privateCopy.name,
        text: entry(privateCopy.name, "Updated private specialist workflow."),
        threadId: privateSource.threadId,
        messageId: privateSource.assistantId,
      }),
    });
    expect(privateRun.proposals[0]?.action).toBe("update");
    const updatedCopy = (
      await state.service.execute(applyRequest(privateRun, "private-update-operation"))
    ).skill!;
    expect(updatedCopy).toMatchObject({
      skillId: privateCopy.skillId,
      revision: privateCopy.revision + 1,
      scope: { kind: "expert", expertId: expert.id },
      derivedFrom: privateCopy.derivedFrom,
    });
    expect((await state.library.execute({ action: "list" })).items?.length).toBe(
      countAfterAdoption,
    );
    expect((await state.experts.read(expert.id))?.skillBindings).toEqual(originalCopyBinding);
    expect((await state.experts.read(secondExpert.id))?.skillBindings).toEqual([secondBinding]);
    expect((await state.library.execute({ action: "read", skillId: base.skillId })).skill).toEqual(
      base,
    );
    expect([...state.repository.events.values()].map((event) => event.kind)).toEqual([
      "derived",
      "updated",
    ]);

    await setBindings(state, expert.id, [firstBinding], "rebind-shared-source");
    const reboundSource = addStandardSource(state.host, expert.id, "rebound-shared-source");
    const reboundRun = await startAndFinish(state, {
      requestId: "rebound-shared-source-run",
      expertId: expert.id,
      source: reboundSource,
      targetSkillId: base.skillId,
      response: proposalText({
        name: updatedCopy.name,
        text: entry(updatedCopy.name, "Updated through the rebound shared source."),
        threadId: reboundSource.threadId,
        messageId: reboundSource.assistantId,
      }),
    });
    expect(reboundRun.proposals[0]?.action).toBe("update");
    const reused = (
      await state.service.execute(applyRequest(reboundRun, "rebound-shared-source-operation"))
    ).skill!;
    expect(reused).toMatchObject({
      skillId: privateCopy.skillId,
      revision: updatedCopy.revision + 1,
      derivedFrom: privateCopy.derivedFrom,
    });
    expect((await state.library.execute({ action: "list" })).items?.length).toBe(
      countAfterAdoption,
    );
    expect((await state.experts.read(expert.id))?.skillBindings).toEqual([
      { ...firstBinding, skillId: privateCopy.skillId },
    ]);
    expect((await state.library.execute({ action: "read", skillId: base.skillId })).skill).toEqual(
      base,
    );

    const currentSecond = (await state.experts.read(secondExpert.id))!;
    const rejected = await state.library.execute(
      {
        action: "bindings",
        operation: "set",
        expertId: secondExpert.id,
        expectedRevision: currentSecond.revision,
        requestId: "try-bind-another-experts-private-skill",
        bindings: [secondBinding, { skillId: privateCopy.skillId, enabled: true }],
      },
      { actor: ownerId },
    );
    expect(rejected.bindingResult?.status).toBe("failed");
    expect((await state.experts.read(secondExpert.id))?.skillBindings).toEqual([secondBinding]);
  });

  it("returns saved_unbound on a binding conflict and retries without creating another Skill", async () => {
    const state = await fixture();
    const expert = await createExpert(state.experts, "retry-derived");
    const base = await createSkill(state.library, {
      name: "Retry Shared Template",
    });
    const originalBinding = {
      skillId: base.skillId,
      enabled: true,
      allowEvolution: true,
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

  it("repairs once after forged evidence, then rejects forged ownership and permission fields", async () => {
    const state = await fixture();
    const expert = await createExpert(state.experts, "forged-output");
    const base = await createSkill(state.library, {
      name: "Forged Output Base",
    });
    await bind(
      state.library,
      expert,
      [{ skillId: base.skillId, enabled: true, allowEvolution: true }],
      "bind-forged-base",
    );
    const source = addStandardSource(state.host, expert.id, "forged");
    const discovery = await startDiscovery(state, {
      requestId: "forged-output-discovery",
      expertId: expert.id,
      sources: [source],
    });
    const ready = await completeStage(
      state,
      discovery,
      opportunityText({
        name: "Forged Output Opportunity",
        threadId: source.threadId,
        messageId: source.assistantId,
        targetSkillId: base.skillId,
      }),
    );
    const generated = await startGeneration(state, ready, "forged-output-run");
    const taskId = generated.taskThreadId!;
    await state.service.dispose();
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
        text: entry(base.name, "Second output includes forbidden ownership metadata."),
        threadId: source.threadId,
        messageId: source.assistantId,
        extra: { allowEvolution: true, scope: { kind: "shared" }, ownerId: expert.id },
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
    });
    await bind(
      state.library,
      expert,
      [{ skillId: base.skillId, enabled: true, allowEvolution: true }],
      "bind-unsafe-path-base",
    );
    const source = addStandardSource(state.host, expert.id, "unsafe-path");
    const discovery = await startDiscovery(state, {
      requestId: "unsafe-path-discovery",
      expertId: expert.id,
      sources: [source],
    });
    const ready = await completeStage(
      state,
      discovery,
      opportunityText({
        name: "Unsafe Path Opportunity",
        threadId: source.threadId,
        messageId: source.assistantId,
        targetSkillId: base.skillId,
      }),
    );
    const generated = await startGeneration(state, ready, "unsafe-path-run");
    const taskId = generated.taskThreadId!;
    await state.service.dispose();
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

  it("restores historical Expert-private content as a new revision instead of rewinding history", async () => {
    const state = await fixture();
    const expert = await createExpert(state.experts, "restore-owner");
    const base = await createSkill(state.library, {
      name: "Restorable Private Skill",
      expertId: expert.id,
    });
    await bind(
      state.library,
      expert,
      [{ skillId: base.skillId, enabled: true, allowEvolution: true }],
      "bind-restorable-base",
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

    const restorePreview = await state.service.execute({
      action: "previewRestore",
      eventId: historical.eventId,
      expertId: expert.id,
    });
    expect(restorePreview.restorePreview?.affectedExpertIds).toEqual([expert.id]);

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
      }),
    ).rejects.toThrow("Skill 已改变，请重新预览恢复差异。");

    const latestRestorePreview = (
      await state.service.execute({
        action: "previewRestore",
        eventId: historical.eventId,
        expertId: expert.id,
      })
    ).restorePreview!;
    expect(latestRestorePreview.skill.revision).toBe(newerSkill.revision);

    const restored = await state.service.execute({
      action: "restore",
      operationId: "restore-to-first-update",
      eventId: historical.eventId,
      expertId: expert.id,
      expectedRevision: newerSkill.revision,
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

  it.each(["derived", "rebound-update"] as const)(
    "restores %s history against the current private binding rather than its source",
    async (kind) => {
      const state = await deriveScenario(`content-${kind}`);
      let historical = state.event;
      let target = state.copy;
      if (kind === "rebound-update") {
        await setBindings(
          state,
          state.expert.id,
          [
            {
              skillId: state.sourceSkill.skillId,
              enabled: true,
              allowEvolution: true,
            },
          ],
          "rebind-for-content-history",
        );
        const source = addStandardSource(state.host, state.expert.id, "content-rebound");
        const run = await startAndFinish(state, {
          requestId: "content-rebound-run",
          expertId: state.expert.id,
          source,
          targetSkillId: state.sourceSkill.skillId,
          response: proposalText({
            name: target.name,
            text: entry(target.name, "Reused private history."),
            threadId: source.threadId,
            messageId: source.assistantId,
          }),
        });
        target = (await state.service.execute(applyRequest(run, "content-rebound-apply"))).skill!;
        historical = [...state.repository.events.values()].at(-1)!;
      }
      const expected = (
        await state.library.execute({
          action: "readFile",
          skillId: target.skillId,
          path: target.entryPath,
        })
      ).file;
      const changed = (
        await state.library.execute(
          {
            action: "save",
            requestId: `change-after-${kind}`,
            skillId: target.skillId,
            expectedRevision: target.revision,
            name: target.name,
            tags: target.tags,
            changes: [
              {
                path: target.entryPath,
                content: Buffer.from(entry(target.name, "Later owner edit.")).toString("base64"),
              },
            ],
          },
          { actor: ownerId },
        )
      ).skill!;
      const bindings = (await state.experts.read(state.expert.id))!.skillBindings;
      const preview = await state.service.execute({
        action: "previewRestore",
        eventId: historical.eventId,
        expertId: state.expert.id,
      });
      expect(preview.restorePreview?.changes).not.toHaveLength(0);
      const request = {
        action: "restore" as const,
        eventId: historical.eventId,
        expertId: state.expert.id,
        operationId: `restore-private-${kind}`,
        expectedRevision: changed.revision,
      };
      const restored = await state.service.execute(request);
      expect(restored.run?.proposals[0]?.status, restored.run?.proposals[0]?.error).toBe("applied");
      expect(restored.skill).toMatchObject({
        skillId: target.skillId,
        revision: changed.revision + 1,
        packageId: historical.packageId,
      });
      expect(
        (
          await state.library.execute({
            action: "readFile",
            skillId: target.skillId,
            path: target.entryPath,
          })
        ).file?.content,
      ).toBe(expected?.content);
      expect(
        (await state.library.execute({ action: "read", skillId: state.sourceSkill.skillId })).skill,
      ).toEqual(state.sourceSkill);
      expect((await state.experts.read(state.expert.id))!.skillBindings).toEqual(bindings);
      const events = state.repository.events.size;
      await restartService(state);
      expect((await state.service.execute(request)).run?.proposals[0]?.status).toBe("applied");
      expect(state.repository.events.size).toBe(events);
      expect(
        (await state.library.execute({ action: "read", skillId: target.skillId })).skill?.revision,
      ).toBe(changed.revision + 1);
    },
  );

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
    });
    const copyBinding = {
      skillId: state.copy.skillId,
      enabled: false,
      allowEvolution: true,
    };
    const sideBinding = {
      skillId: sideSkill.skillId,
      enabled: true,
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

    const changedSideBinding = { ...sideBinding, enabled: false };
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
              { skillId: extraSkill.skillId, enabled: true },
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
      { skillId: state.copy.skillId, enabled: true, allowEvolution: true },
      { skillId: extraSkill.skillId, enabled: true },
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
      bindingRestores?: Array<{
        operationId: string;
        expertRevision: number;
        bindings: Array<Record<string, unknown>>;
        completed?: boolean;
      }>;
    };
    expect(persisted.bindingRestores).toHaveLength(1);
    expect(persisted.bindingRestores?.[0]).toMatchObject({
      operationId: request.operationId,
      expertRevision: preview.expertRevision,
    });
    expect(persisted.bindingRestores?.[0]?.completed).toBeUndefined();
    persisted.bindingRestores![0]!.bindings[0]!.activation = "startup";
    state.repository.rows.set(state.run.requestId, { ...row, record: JSON.stringify(persisted) });

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
    expect(afterRead.bindingRestores?.[0]?.bindings[0]?.activation).toBe("startup");
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

  it("replays an applying intent with unchanged permission without duplicate packages or events", async () => {
    const state = await fixture();
    const expert = await createExpert(state.experts, "applying-restart-owner");
    const base = await createSkill(state.library, {
      name: "Protected Restart Source",
    });
    await bind(
      state.library,
      expert,
      [{ skillId: base.skillId, enabled: true, allowEvolution: true }],
      "bind-applying-restart-source",
    );
    const source = addStandardSource(state.host, expert.id, "applying-restart");
    const run = await startAndFinish(state, {
      requestId: "applying-restart-run",
      expertId: expert.id,
      source,
      targetSkillId: base.skillId,
      response: proposalText({
        name: "Protected Restart Copy",
        text: entry("Protected Restart Copy", "Approved private workflow."),
        threadId: source.threadId,
        messageId: source.assistantId,
      }),
    });
    expect(run.proposals[0]?.action).toBe("derive");
    const apply = applyRequest(run, "applying-restart-operation");
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
        createdAt?: string;
      }>;
      run: SkillEvolutionRun;
    };
    const intent = storedBeforeRestart.intents[0]!;
    expect(storedBeforeRestart.run.proposals[0]?.status).toBe("conflict");
    expect(intent).toMatchObject({
      operationId: apply.operationId,
      digest: run.proposals[0]!.digest,
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
      name: "Event Replay Private Skill",
      expertId: expert.id,
    });
    await bind(
      state.library,
      expert,
      [{ skillId: base.skillId, enabled: true, allowEvolution: true }],
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
    expect(listed.runs?.map((item) => item.requestId)).toEqual([
      `${run.requestId}-discovery`,
      run.requestId,
    ]);
    expect(writes).toBe(0);
    expect(state.repository.rows.get(run.requestId)).toEqual(beforeRow);
    expect(await readSkillLibraryDefinitions(state.stateDir)).toEqual(beforeSkills);
    expect(
      (await createSkillPackageStore(state.stateDir).list()).map((item) => item.packageId).sort(),
    ).toEqual(beforePackages);
    expect(state.repository.events.size).toBe(0);
  });

  it("reports a native session start failure without retrying or changing formal Skill state", async () => {
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
