import {
  ApprovalRequestId,
  ClientOrchestrationCommand,
  COMPUTER_WS_METHODS,
  DEVICE_WS_METHODS,
  EventId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  OrchestrationReadModel,
  ProjectId,
  ServerConfig,
  ServerGetEnvironmentResult,
  ServerSettingsView,
  ThreadId,
  TurnId,
  WS_METHODS,
} from "@synara/contracts";
import { Schema } from "effect";
import { HttpResponse, http, passthrough, ws } from "msw";
import { setupWorker } from "msw/browser";
import {
  createShellSnapshotFromReadModel,
  readEffectRpcClientMessage,
  sendEffectRpcChunk,
  sendEffectRpcExit,
  type EffectRpcWebSocketClient,
} from "../../src/test/effectRpcWebSocketMock";
import type {
  BaselineFixtureController,
  BaselineScene,
  CompanionPhase,
  CompanionStatus,
} from "./baseline.types";

export const PREVIEW_THREAD_ID = "zen-baseline-thread";
const threadId = ThreadId.makeUnsafe(PREVIEW_THREAD_ID);
const projectId = ProjectId.makeUnsafe("zen-baseline-project");
const createdAt = new Date().toISOString();
// Exactly the model used by ChatView.browser.tsx, not a new product catalog.
const modelSelection = { provider: "codex", model: "gpt-5" } as const;
const workspaceRoot = "/preview/collaboration";
type Thread = OrchestrationReadModel["threads"][number];
type Message = Thread["messages"][number];
type Command = typeof ClientOrchestrationCommand.Type;
type Subscriber = { client: EffectRpcWebSocketClient; requestId: string; method: string };

function message(id: string, role: Message["role"], text: string): Message {
  return {
    id: MessageId.makeUnsafe(id),
    role,
    text,
    turnId: null,
    streaming: false,
    source: "native",
    createdAt,
    updatedAt: createdAt,
  };
}

function companionPhase(thread: Thread): CompanionPhase {
  const turn = thread.latestTurn;
  const session = thread.session;
  if (turn?.state === "error" || session?.status === "error" || session?.lastError) return "error";
  if (session?.status === "stopped" || session?.status === "interrupted") return "idle";
  if (thread.hasPendingApprovals) return "approval";
  if (thread.hasPendingUserInput) return "question";
  if (turn?.state === "running" || session?.status === "running" || session?.status === "starting")
    return "running";
  // Interrupting marks the partial assistant message non-streaming too; that
  // is not evidence of completion.
  if (turn?.state === "interrupted") return "idle";
  const lastMessage = thread.messages.at(-1);
  if (
    lastMessage?.role === "assistant" &&
    !lastMessage.streaming &&
    (!turn || (turn.state === "completed" && turn.assistantMessageId === lastMessage.id))
  )
    return "complete";
  return "idle";
}

function sceneSnapshot(scene: BaselineScene, sequence: number): OrchestrationReadModel {
  const turnId = TurnId.makeUnsafe(`preview-turn-${sequence}`);
  const requestId = ApprovalRequestId.makeUnsafe(`preview-request-${sequence}`);
  const active = scene === "running" || scene === "question" || scene === "approval";
  const history = [
    message(
      "preview-user-1",
      "user",
      "Help me prepare for our team check-in: compare the options, surface open questions, and agree on a next step.",
    ),
    message(
      "preview-assistant-1",
      "assistant",
      "We can work through the decision together. Start with the outcome, compare the trade-offs, then capture a small next step. I can also help research a question, review an idea, or draft a short update.",
    ),
    message("preview-user-2", "user", "Let’s compare a small pilot with a full rollout."),
    message(
      "preview-assistant-2",
      "assistant",
      "A small pilot reduces risk and gives us feedback sooner. A full rollout reaches everyone immediately but needs more coordination. What would we need to learn before committing?",
    ),
  ];
  const activities: Thread["activities"][number][] = [];
  if (scene === "running") {
    history.push({
      ...message(
        `preview-stream-${sequence}`,
        "assistant",
        "I’m comparing the scope, risks, and questions we should discuss…",
      ),
      turnId,
      streaming: true,
    });
    activities.push({
      id: EventId.makeUnsafe(`preview-tasks-${sequence}`),
      createdAt,
      turnId,
      sequence,
      kind: "turn.tasks.updated",
      summary: "Isolated preview task list",
      tone: "info",
      payload: {
        tasks: [
          { task: "梳理候选方案", status: "completed" },
          { task: "比较约束与风险", status: "inProgress" },
          { task: "整理下一步行动", status: "pending" },
        ],
      },
    });
  }
  if (scene === "question" || scene === "approval") {
    activities.push({
      id: EventId.makeUnsafe(`preview-activity-${sequence}`),
      createdAt,
      turnId,
      kind: scene === "question" ? "user-input.requested" : "approval.requested",
      summary: scene === "question" ? "Choose our next step" : "Review the proposed action",
      tone: scene === "question" ? "info" : "approval",
      sequence,
      payload:
        scene === "question"
          ? {
              requestId,
              questions: [
                {
                  id: "next-step",
                  header: "Next step",
                  question: "What should we explore together?",
                  options: [
                    { label: "Compare options", description: "Map the trade-offs before deciding" },
                    { label: "Plan a pilot", description: "Choose a small, reversible next step" },
                  ],
                },
              ],
            }
          : {
              requestId,
              requestKind: "command",
              detail:
                "Preview only: prepare a local summary of the agreed next steps. Approving this fixture does not execute a command or access files.",
            },
    });
  }
  if (scene === "error") {
    activities.push({
      id: EventId.makeUnsafe(`preview-error-${sequence}`),
      createdAt,
      turnId,
      sequence,
      kind: "runtime.error",
      tone: "error",
      summary: "Simulated provider interruption",
      payload: {
        message:
          "This is a local error fixture. No provider was contacted. You can send another message to continue the simulation.",
        class: "provider_error",
      },
    });
  }
  return Schema.decodeUnknownSync(OrchestrationReadModel)({
    snapshotSequence: sequence,
    spaces: [],
    updatedAt: createdAt,
    projects: [
      {
        id: projectId,
        kind: "project",
        title: "Collaboration",
        workspaceRoot,
        defaultModelSelection: modelSelection,
        scripts: [],
        createdAt,
        updatedAt: createdAt,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: threadId,
        projectId,
        title: "Think it through together",
        modelSelection,
        interactionMode: "default",
        runtimeMode: "approval-required",
        envMode: "local",
        branch: null,
        worktreePath: null,
        latestTurn:
          active || scene === "error"
            ? {
                turnId,
                state: scene === "error" ? "error" : "running",
                requestedAt: createdAt,
                startedAt: createdAt,
                completedAt: scene === "error" ? createdAt : null,
                assistantMessageId: scene === "running" ? history.at(-1)?.id : null,
              }
            : null,
        createdAt,
        updatedAt: createdAt,
        deletedAt: null,
        handoff: null,
        messages: scene === "idle" ? [] : history,
        activities,
        proposedPlans: [],
        checkpoints: [],
        hasPendingApprovals: scene === "approval",
        hasPendingUserInput: scene === "question",
        pendingInteractions:
          scene === "question" || scene === "approval"
            ? [
                {
                  interactionKind: scene === "question" ? "userInput" : "approval",
                  requestId,
                  threadId,
                  turnId,
                  lifecycleGeneration: null,
                  status: "pending",
                  decision: null,
                  responseCommandId: null,
                  responseRequestedAt: null,
                  createdAt,
                  resolvedAt: null,
                },
              ]
            : [],
        session: {
          threadId,
          status: scene === "error" ? "error" : active ? "running" : "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: active ? turnId : null,
          lastError:
            scene === "error"
              ? "Simulated interruption — no provider connection was attempted."
              : null,
          updatedAt: createdAt,
        },
      },
    ],
  });
}

function fail(client: EffectRpcWebSocketClient, requestId: string, detail: string): void {
  // Effect 4's encoded Cause is an array, not the Effect 3 nested Cause tree.
  client.send(
    JSON.stringify({
      _tag: "Exit",
      requestId,
      exit: {
        _tag: "Failure",
        cause: [
          {
            _tag: "Fail",
            error: {
              _tag: "WsRpcError",
              code: "PREVIEW_UNAVAILABLE",
              message: detail,
            },
          },
        ],
      },
    }),
  );
}

/**
 * Local-only transport for the unmodified app. There is no inference, disk access,
 * terminal, upload, native automation, voice recording, or persistent server data.
 * Scene changes replace synthetic history; sends only stream a fixed local reply.
 * Start this before importing the router (which lazily creates its RPC clients).
 */
export async function initializeBaselineFixture(): Promise<BaselineFixtureController> {
  // This app is served on its dedicated preview origin, never the production origin.
  localStorage.clear();
  sessionStorage.clear();
  // Deliberate fixture loading boundary: this helper imports production UI modules,
  // whose persisted stores must not initialize until preview storage is reset.
  const {
    acknowledgeStartupAnnouncementsForTest,
    createBrowserTestServerConfig,
    createBrowserTestServerSettings,
  } = await import("../../src/test/browserHarness");
  const baseConfig = createBrowserTestServerConfig(createdAt);
  const config = Schema.decodeUnknownSync(ServerConfig)({
    ...baseConfig,
    cwd: workspaceRoot,
    worktreesDir: "/preview/worktrees",
    keybindingsConfigPath: "/preview/keybindings.json",
    providers: baseConfig.providers.map((provider) => ({
      ...provider,
      voiceTranscriptionAvailable: false,
    })),
  });
  const settings = Schema.decodeUnknownSync(ServerSettingsView)({
    ...createBrowserTestServerSettings(createdAt),
    enableProviderUpdateChecks: false,
  });
  const environment = Schema.decodeUnknownSync(ServerGetEnvironmentResult)({
    environmentId: "zen-baseline",
    label: "Isolated local preview",
    platform: { os: "unknown", arch: "other" },
    serverVersion: "local-preview",
    capabilities: { repositoryIdentity: false },
  });
  acknowledgeStartupAnnouncementsForTest(config);
  let snapshot = sceneSnapshot("idle", 1);
  let disposed = false;
  let timer: number | undefined;
  const subscribers = new Set<Subscriber>();
  const clients = new Set<EffectRpcWebSocketClient & { close: () => void }>();
  const statusListeners = new Set<(status: CompanionStatus) => void>();
  const currentStatus = (): CompanionStatus => ({
    phase: companionPhase(snapshot.threads[0]!),
    threadId: snapshot.threads[0]!.id,
    threadTitle: snapshot.threads[0]!.title,
    revision: snapshot.snapshotSequence,
  });
  let status = currentStatus();
  const publishStatus = () => {
    status = currentStatus();
    for (const listener of statusListeners) listener(status);
  };
  const cancelTimer = () => {
    window.clearTimeout(timer);
    timer = undefined;
  };
  const detail = () => ({
    snapshotSequence: snapshot.snapshotSequence,
    thread: snapshot.threads[0]!,
  });
  const push = () => {
    publishStatus();
    for (const sub of subscribers) {
      if (sub.method === ORCHESTRATION_WS_METHODS.subscribeShell) {
        sendEffectRpcChunk(sub.client, sub.requestId, {
          kind: "snapshot",
          snapshot: createShellSnapshotFromReadModel(snapshot),
        });
      } else if (sub.method === ORCHESTRATION_WS_METHODS.subscribeThread) {
        sendEffectRpcChunk(sub.client, sub.requestId, { kind: "snapshot", snapshot: detail() });
      }
    }
  };
  const updateThread = (update: (thread: Thread) => Thread) => {
    const now = new Date().toISOString();
    snapshot = Schema.decodeUnknownSync(OrchestrationReadModel)({
      ...snapshot,
      snapshotSequence: snapshot.snapshotSequence + 1,
      updatedAt: now,
      threads: [{ ...update(snapshot.threads[0]!), updatedAt: now }],
    });
    push();
  };
  const settle = (state: "completed" | "interrupted") => {
    cancelTimer();
    const now = new Date().toISOString();
    updateThread((thread) => ({
      ...thread,
      messages: thread.messages.map((entry) =>
        entry.streaming ? { ...entry, streaming: false, updatedAt: now } : entry,
      ),
      latestTurn: thread.latestTurn ? { ...thread.latestTurn, state, completedAt: now } : null,
      session: thread.session
        ? {
            ...thread.session,
            status: "ready",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          }
        : null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      ...(state === "interrupted" ? { pendingInteractions: [] } : {}),
    }));
  };
  const startReply = (
    text: string,
    userMessage?: Message,
    command?: Extract<Command, { type: "thread.turn.start" }>,
  ) => {
    cancelTimer();
    const now = new Date().toISOString();
    const turnId = TurnId.makeUnsafe(`preview-send-${snapshot.snapshotSequence + 1}`);
    const assistantId = MessageId.makeUnsafe(`preview-reply-${snapshot.snapshotSequence + 1}`);
    updateThread((thread) => ({
      ...thread,
      runtimeMode: command?.runtimeMode ?? thread.runtimeMode,
      interactionMode: command?.interactionMode ?? thread.interactionMode,
      modelSelection: command?.modelSelection ?? thread.modelSelection,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      pendingInteractions: thread.pendingInteractions?.filter(
        (entry) => entry.status === "confirmed",
      ),
      latestTurn: {
        turnId,
        state: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        assistantMessageId: assistantId,
      },
      latestUserMessageAt: userMessage ? now : thread.latestUserMessageAt,
      messages: [
        ...thread.messages,
        ...(userMessage ? [{ ...userMessage, turnId }] : []),
        {
          ...message(assistantId, "assistant", ""),
          turnId,
          createdAt: now,
          updatedAt: now,
          streaming: true,
        },
      ],
      session: {
        threadId,
        status: "running",
        providerName: "codex",
        runtimeMode: command?.runtimeMode ?? thread.runtimeMode,
        activeTurnId: turnId,
        lastError: null,
        updatedAt: now,
      },
    }));
    let cursor = 0;
    const tick = () => {
      if (disposed) return;
      cursor = Math.min(text.length, cursor + 24);
      updateThread((thread) => ({
        ...thread,
        messages: thread.messages.map((entry) =>
          entry.id === assistantId
            ? { ...entry, text: text.slice(0, cursor), updatedAt: new Date().toISOString() }
            : entry,
        ),
      }));
      if (cursor === text.length) settle("completed");
      else timer = window.setTimeout(tick, 130);
    };
    timer = window.setTimeout(tick, 300);
  };
  const dispatch = (payload: unknown) => {
    const command = Schema.decodeUnknownSync(ClientOrchestrationCommand)(payload);
    if (!("threadId" in command) || command.threadId !== threadId)
      throw new Error("Only the synthetic preview thread can be changed.");
    switch (command.type) {
      case "thread.turn.start": {
        if (
          command.message.attachments.length ||
          command.enableComputerControl ||
          command.reviewTarget
        ) {
          throw new Error(
            "Attachments, computer control, and repository review are unavailable in this local preview.",
          );
        }
        if (
          command.modelSelection &&
          (command.modelSelection.provider !== "codex" || command.modelSelection.model !== "gpt-5")
        ) {
          throw new Error(
            "Only the existing codex/gpt-5 fixture is available; no model is contacted.",
          );
        }
        startReply(
          "Local preview response: let’s clarify the outcome, compare the trade-offs, and choose one small next step together. This text is simulated; nothing was sent to a provider or written to your files.",
          {
            ...message(command.message.messageId, "user", command.message.text),
            createdAt: command.createdAt,
            updatedAt: command.createdAt,
          },
          command,
        );
        break;
      }
      case "thread.turn.interrupt":
        settle("interrupted");
        break;
      case "thread.approval.respond":
      case "thread.user-input.respond": {
        const pending = snapshot.threads[0]!.pendingInteractions?.find(
          (entry) => entry.requestId === command.requestId && entry.status === "pending",
        );
        const kind = command.type === "thread.approval.respond" ? "approval" : "userInput";
        if (!pending || pending.interactionKind !== kind)
          throw new Error("This preview request is no longer pending.");
        updateThread((thread) => ({
          ...thread,
          pendingInteractions: thread.pendingInteractions?.map((entry) =>
            entry.requestId === command.requestId
              ? {
                  ...entry,
                  status: "confirmed",
                  decision: command.type === "thread.approval.respond" ? command.decision : null,
                  responseCommandId: command.commandId,
                  responseRequestedAt: command.createdAt,
                  resolvedAt: command.createdAt,
                }
              : entry,
          ),
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          activities: [
            ...thread.activities,
            {
              id: EventId.makeUnsafe(`preview-resolved-${snapshot.snapshotSequence + 1}`),
              createdAt: command.createdAt,
              turnId: pending.turnId,
              sequence: snapshot.snapshotSequence + 1,
              kind:
                command.type === "thread.approval.respond"
                  ? "approval.resolved"
                  : "user-input.resolved",
              tone: "info",
              summary:
                command.type === "thread.approval.respond"
                  ? `本地演示审批结果：${command.decision}`
                  : "本地演示：已提交答案",
              payload: {
                requestId: command.requestId,
                ...(command.type === "thread.approval.respond"
                  ? { decision: command.decision }
                  : { answers: command.answers }),
              },
            },
          ],
        }));
        if (command.type === "thread.approval.respond" && command.decision === "cancel") {
          settle("interrupted");
          break;
        }
        const response =
          command.type === "thread.approval.respond"
            ? `Local preview: your decision (${command.decision}) was recorded in this synthetic thread. No command was executed.`
            : `Local preview: your answer was recorded (${JSON.stringify(command.answers).slice(0, 240)}). We can use that direction for our next step. No provider was contacted.`;
        startReply(response);
        break;
      }
      case "thread.runtime-mode.set":
        updateThread((thread) => ({
          ...thread,
          runtimeMode: command.runtimeMode,
          session: thread.session ? { ...thread.session, runtimeMode: command.runtimeMode } : null,
        }));
        break;
      case "thread.interaction-mode.set":
        updateThread((thread) => ({ ...thread, interactionMode: command.interactionMode }));
        break;
      case "thread.meta.update": {
        const allowed: Record<string, true> = {
          type: true,
          commandId: true,
          threadId: true,
          title: true,
          modelSelection: true,
          isPinned: true,
        };
        if (Object.keys(command).some((key) => !Object.hasOwn(allowed, key)))
          throw new Error(
            "Only title, fixture model, and pin changes are supported in the preview.",
          );
        if (
          command.modelSelection &&
          (command.modelSelection.provider !== "codex" || command.modelSelection.model !== "gpt-5")
        )
          throw new Error("Only the existing codex/gpt-5 model fixture is available.");
        updateThread((thread) => ({
          ...thread,
          ...(command.title === undefined ? {} : { title: command.title }),
          ...(command.modelSelection === undefined
            ? {}
            : { modelSelection: command.modelSelection }),
          ...(command.isPinned === undefined ? {} : { isPinned: command.isPinned }),
        }));
        break;
      }
      default:
        throw new Error(
          `Preview mutation unavailable: ${command.type}. No operation was performed.`,
        );
    }
    return { sequence: snapshot.snapshotSequence };
  };

  const resolveRead = (method: string, body: Record<string, unknown>): unknown => {
    switch (method) {
      case ORCHESTRATION_WS_METHODS.dispatchCommand:
        return dispatch(body);
      // This fixture publishes complete snapshots, not a durable event journal.
      case ORCHESTRATION_WS_METHODS.replayEvents:
        return [];
      case ORCHESTRATION_WS_METHODS.getSnapshot:
        return snapshot;
      case ORCHESTRATION_WS_METHODS.getShellSnapshot:
        return createShellSnapshotFromReadModel(snapshot);
      case ORCHESTRATION_WS_METHODS.getThreadDetailSnapshot:
        return body.threadId === threadId ? detail() : null;
      case WS_METHODS.serverGetConfig:
        return config;
      case WS_METHODS.serverGetSettings:
        return settings;
      case WS_METHODS.serverGetEnvironment:
        return environment;
      case WS_METHODS.serverListExperts:
      case WS_METHODS.serverListSkillPackages:
      case WS_METHODS.serverListSkillPackageSources:
      case WS_METHODS.serverListMcpConnectors:
        return [];
      case WS_METHODS.providerListModels:
        return {
          models: body.provider === "codex" ? [{ slug: "gpt-5", name: "GPT-5" }] : [],
          source: "local-preview",
          cached: false,
        };
      case WS_METHODS.providerGetComposerCapabilities:
        return {
          provider: body.provider,
          supportsSkillMentions: false,
          supportsSkillDiscovery: false,
          supportsNativeSlashCommandDiscovery: false,
          supportsPluginMentions: false,
          supportsPluginDiscovery: false,
          supportsRuntimeModelList: true,
          supportsThreadCompaction: false,
          supportsThreadImport: false,
        };
      case WS_METHODS.providerListSkills:
      case WS_METHODS.providerListSkillsCatalog:
        return { skills: [] };
      case WS_METHODS.providerListCommands:
        return { commands: [] };
      case WS_METHODS.providerListAgents:
        return { agents: [] };
      case WS_METHODS.projectsListDevServers:
        return { servers: [] };
      case WS_METHODS.projectsSearchEntries:
        return { entries: [], truncated: false };
      case WS_METHODS.automationList:
        return { definitions: [], runs: [] };
      case WS_METHODS.todoList:
        return { todos: [] };
      case WS_METHODS.githubInboxList:
        return {
          viewer: null,
          items: [],
          errors: [],
          repositoryBatches: [],
          rateLimit: null,
          reviewRequestedCount: 0,
          reviewRequestedCountIncomplete: false,
        };
      case WS_METHODS.gitListBranches:
        return { isRepo: false, hasOriginRemote: false, branches: [] };
      case WS_METHODS.gitStatus:
        return {
          branch: null,
          hasWorkingTreeChanges: false,
          workingTree: { files: [], insertions: 0, deletions: 0 },
          hasUpstream: false,
          upstreamBranch: null,
          aheadCount: 0,
          behindCount: 0,
          pr: null,
        };
      case WS_METHODS.contextGetProject:
        return {
          dataInstanceId: "zen-baseline",
          projectId,
          title: "Collaboration",
          workspaceRoot,
          spaceId: null,
          projectGoal: "",
          projectInstructions: "",
          revision: 0,
          inherited: null,
          migration: null,
        };
      case WS_METHODS.projectAgentGetOverview:
        return {
          projectId,
          configured: false,
          config: null,
          linkedProjectIds: [],
          goal: null,
          digest: null,
          blockers: [],
          recentOutcomes: [],
          coordinatorStatus: "unconfigured",
          workers: [],
        };
      case WS_METHODS.projectAgentListSummaries:
        return { summaries: [] };
      case WS_METHODS.projectAgentListTasks:
        return { tasks: [], nextCursor: null };
      case WS_METHODS.projectAgentListActivity:
        return { activity: [], nextCursor: null };
      case WS_METHODS.projectAgentListDocuments:
        return { documents: [] };
      case WS_METHODS.projectAgentListThreadIndex:
        return { threads: [] };
      default:
        throw new Error(
          `Preview RPC unavailable: ${method}. No server, provider, or native operation was contacted.`,
        );
    }
  };
  const quietStreams: Record<string, true> = {
    [WS_METHODS.subscribeTerminalEvents]: true,
    [WS_METHODS.subscribeOrchestrationDomainEvents]: true,
    [WS_METHODS.subscribeProjectDevServerEvents]: true,
    [WS_METHODS.subscribeAutomationEvents]: true,
    [WS_METHODS.subscribeTodoEvents]: true,
    [WS_METHODS.subscribeProjectAgentEvents]: true,
    [DEVICE_WS_METHODS.subscribeEvents]: true,
    [COMPUTER_WS_METHODS.subscribeEvents]: true,
  };
  const worker = setupWorker(
    // Deliberately intercept EVERY socket; never call server.connect(). This also
    // prevents a Vite HMR socket opened after bootstrap from reaching any server.
    ws.link(/.*/).addEventListener("connection", ({ client }) => {
      clients.add(client);
      client.addEventListener("close", () => {
        clients.delete(client);
        for (const sub of subscribers) if (sub.client === client) subscribers.delete(sub);
      });
      client.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        try {
          const frame = JSON.parse(event.data) as { _tag?: string; requestId?: string };
          if (frame._tag === "Interrupt") {
            for (const sub of subscribers)
              if (sub.client === client && sub.requestId === frame.requestId)
                subscribers.delete(sub);
          }
        } catch {
          /* The shared parser rejects non-RPC frames below. */
        }
        const parsed = readEffectRpcClientMessage(client, event.data);
        if (parsed.kind !== "request") return;
        const { id, tag, payload } = parsed.request;
        if (disposed) {
          fail(client, id, "The local preview has been disposed.");
          return;
        }
        const body =
          payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
        if (tag === ORCHESTRATION_WS_METHODS.unsubscribeThread) {
          for (const sub of subscribers) {
            if (sub.client === client && sub.method === ORCHESTRATION_WS_METHODS.subscribeThread)
              subscribers.delete(sub);
          }
          sendEffectRpcExit(client, id, null);
          return;
        }
        try {
          let initial: unknown;
          switch (tag) {
            case WS_METHODS.subscribeServerLifecycle:
              initial = {
                type: "welcome",
                payload: {
                  cwd: workspaceRoot,
                  projectName: "Collaboration",
                  bootstrapProjectId: projectId,
                  bootstrapThreadId: threadId,
                },
              };
              break;
            case WS_METHODS.subscribeServerConfig:
              initial = { type: "snapshot", config };
              break;
            case WS_METHODS.subscribeServerSettings:
              initial = { settings };
              break;
            case WS_METHODS.subscribeServerProviderStatuses:
              initial = { providers: config.providers };
              break;
            case WS_METHODS.subscribeServerKeepAwake:
              initial = {
                keepAwake: { available: false, mode: "off", active: false, error: null },
              };
              break;
            case ORCHESTRATION_WS_METHODS.subscribeShell:
              initial = { kind: "snapshot", snapshot: createShellSnapshotFromReadModel(snapshot) };
              break;
            case ORCHESTRATION_WS_METHODS.subscribeThread:
              if (body.threadId !== threadId)
                throw new Error("Only the synthetic preview thread is available.");
              initial = { kind: "snapshot", snapshot: detail() };
              break;
            default:
              if (Object.hasOwn(quietStreams, tag)) {
                subscribers.add({ client, requestId: id, method: tag });
                return;
              }
              sendEffectRpcExit(client, id, resolveRead(tag, body));
              return;
          }
          subscribers.add({ client, requestId: id, method: tag });
          sendEffectRpcChunk(client, id, initial);
        } catch (error) {
          fail(
            client,
            id,
            error instanceof Error ? error.message : "Local preview operation failed.",
          );
        }
      });
    }),
    http.all("*", ({ request }) => {
      const url = new URL(request.url);
      // Vite module/static fetches are allowed; API/binary requests and all remote
      // origins fail closed, including image/favicon requests that might leak URLs.
      if (
        url.origin !== location.origin ||
        !["GET", "HEAD"].includes(request.method) ||
        /^\/(?:api|attachments|uploads|rpc|ws|auth)(?:\/|$)/.test(url.pathname)
      ) {
        return HttpResponse.json(
          { error: "Unavailable in the isolated local preview." },
          { status: 403 },
        );
      }
      return passthrough();
    }),
  );
  await worker.start({
    serviceWorker: { url: "/mockServiceWorker.js" },
    onUnhandledRequest: "error",
    quiet: true,
  });
  return {
    setScene(scene) {
      if (disposed) return;
      cancelTimer();
      snapshot = sceneSnapshot(scene, snapshot.snapshotSequence + 1);
      push();
    },
    subscribeStatus(listener) {
      if (disposed) return () => {};
      statusListeners.add(listener);
      listener(status);
      return () => {
        statusListeners.delete(listener);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelTimer();
      subscribers.clear();
      statusListeners.clear();
      for (const client of clients) client.close();
      clients.clear();
      // Keep interception installed until this iframe goes away: stopping MSW
      // while production clients reconnect would permit real network traffic.
    },
  };
}
