import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ClientOrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ThreadId,
  WS_METHODS,
  type ExpertBinding,
  type ExpertDefinition,
  type ModelSelection,
  type OrchestrationThread,
  type OrchestrationThreadDetailSnapshot,
  type ProviderStartOptions,
  type ServerConfig,
} from "@synara/contracts";
import { Schema, type Effect } from "effect";

import { connectOwnerUrl } from "./computer-use-fixtures/packaged-client.ts";
import { startWorkbenchRuntimeMcpFixture } from "./lib/workbench-runtime-mcp-fixture.ts";
import { hasExpectedMcpToolActivity } from "./lib/workbench-runtime-probe-evidence.ts";
import {
  authenticatedOwnerUrl,
  parseRuntimeProbeOptions,
  protectedUserProfilePaths,
  safeTurnErrorEvidence,
  validateProbeInstanceHome,
  validateProbePaths,
  type ParsedRuntimeProbeOptions,
  type RuntimeProbeOptions,
} from "./lib/workbench-runtime-probe-input.ts";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER_TOKEN_ENV = "SYNARA_WORKBENCH_PROBE_OWNER_TOKEN";
const PROVIDER_TURN_TIMEOUT_MS = 180_000;
const RESTART_TIMEOUT_MS = 180_000;
const RPC_POLL_INTERVAL_MS = 500;
const CONNECTION_ID_PREFIX = "wb_probe_";

const CHECK_NAMES = [
  "codex-ordinary-first-turn",
  "codex-expert-first-turn",
  "pi-ordinary-first-turn",
  "pi-expert-first-turn",
  "recovery",
  "cancellation",
  "mcp",
  "session-isolation",
] as const;
type CheckName = (typeof CHECK_NAMES)[number];
type CheckStatus = "passed" | "failed" | "not-run";
type ProbeProvider = "codex" | "pi";
type ThreadKind = "ordinary" | "expert";
type ProbeModelSelections = {
  codex: {
    provider: "codex";
    model: string;
    reasoningEffort: RuntimeProbeOptions["codexReasoningEffort"];
  };
  pi: {
    provider: "pi";
    model: string;
    thinkingLevel: RuntimeProbeOptions["piThinkingLevel"];
  };
};

type CheckRecord = {
  status: CheckStatus;
  reasonCode?: string;
  evidence?: Record<string, string | number | boolean | null>;
};

type ProbeReport = {
  formatVersion: 1;
  sourceSha: string;
  startedAt: string;
  updatedAt: string;
  status: "running" | "awaiting-server-restart" | "complete" | "failed" | "incomplete";
  phase: "setup" | "initial" | "awaiting-server-restart" | "recovery" | "complete";
  failureCode?: string;
  toolchain: {
    nodeVersion: string;
    bunVersion: string;
    piSdkVersion: string;
  };
  modelSelections: ProbeModelSelections;
  initialServerInstanceFingerprint?: string;
  restartedServerInstanceFingerprint?: string;
  instanceHomeConfigVerified?: boolean;
  restartedInstanceHomeConfigVerified?: boolean;
  checks: Record<CheckName, CheckRecord>;
};

type Owner = Awaited<ReturnType<typeof connectOwnerUrl>>;
type RuntimeMcpFixture = Awaited<ReturnType<typeof startWorkbenchRuntimeMcpFixture>>;

type ThreadCase = {
  key: string;
  checkName: CheckName;
  provider: ProbeProvider;
  kind: ThreadKind;
  threadId: ThreadId;
  modelSelection: ModelSelection;
  providerOptions: ProviderStartOptions;
  expertId?: string;
  personaMarker?: string;
  otherPersonaMarker?: string;
  binding?: ExpertBinding;
  toolAlias?: string;
  waitToolAlias?: string;
};

type TurnOutcome = {
  thread: OrchestrationThread;
  userMessageId: string;
  assistantMessageId: string;
  assistantText: string;
  assistantTextSha256: string;
  turnId: string;
};

class ProbeFailure extends Error {
  readonly code: string;
  readonly safeEvidence?: Record<string, string | number | boolean | null>;
  constructor(code: string, safeEvidence?: Record<string, string | number | boolean | null>) {
    super(code);
    this.code = code;
    if (safeEvidence) this.safeEvidence = safeEvidence;
  }
}

function record(report: ProbeReport, name: CheckName, next: CheckRecord): void {
  report.checks[name] = next;
}

function markNotRun(
  report: ProbeReport,
  names: ReadonlyArray<CheckName>,
  reasonCode: string,
): void {
  for (const name of names) record(report, name, { status: "not-run", reasonCode });
}

function failureCode(error: unknown, fallback: string): string {
  return error instanceof ProbeFailure ? error.code : fallback;
}

function safeFailureEvidence(
  error: unknown,
): Record<string, string | number | boolean | null> | undefined {
  return error instanceof ProbeFailure ? error.safeEvidence : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function instanceFingerprint(value: string): string {
  return sha256(value).slice(0, 16);
}

function runVersionCommand(command: string, args: ReadonlyArray<string>): string {
  try {
    const output = execFileSync(command, [...args], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
    if (output.length === 0 || output.length > 80) throw new Error("version-output-invalid");
    return output;
  } catch {
    throw new ProbeFailure(`${command}-version-unavailable`);
  }
}

async function installedPiSdkVersion(): Promise<string> {
  try {
    const packagePath = join(
      REPOSITORY_ROOT,
      "apps/server/node_modules/@earendil-works/pi-coding-agent/package.json",
    );
    const raw: unknown = JSON.parse(await readFile(packagePath, "utf8"));
    if (
      typeof raw !== "object" ||
      raw === null ||
      !("version" in raw) ||
      typeof raw.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(raw.version)
    ) {
      throw new Error("pi-sdk-version-invalid");
    }
    return raw.version;
  } catch {
    throw new ProbeFailure("installed-pi-sdk-version-unavailable");
  }
}

function assertSourceCheckout(expectedSha: string): string {
  try {
    const actualSha = execFileSync("git", ["-C", REPOSITORY_ROOT, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
    const status = execFileSync(
      "git",
      ["-C", REPOSITORY_ROOT, "status", "--porcelain=v1", "--untracked-files=all"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
      },
    );
    if (!/^[0-9a-f]{40}$/iu.test(actualSha) || actualSha.toLowerCase() !== expectedSha)
      throw new ProbeFailure("source-sha-mismatch");
    if (status.length > 0) throw new ProbeFailure("source-checkout-not-clean");
    return actualSha.toLowerCase();
  } catch (error) {
    if (error instanceof ProbeFailure) throw error;
    throw new ProbeFailure("source-checkout-unavailable");
  }
}

async function canonicalIfPresent(path: string): Promise<string> {
  return canonicalPathForComparison(resolve(path));
}

async function canonicalPathForComparison(rawPath: string): Promise<string> {
  if (!isAbsolute(rawPath)) throw new ProbeFailure("server-config-path-not-absolute");
  let cursor = resolve(rawPath);
  const suffix: string[] = [];
  for (;;) {
    try {
      return join(await realpath(cursor), ...suffix);
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) throw new ProbeFailure("server-config-path-cannot-be-resolved");
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

async function assertOwnerInstanceHome(owner: Owner, instanceHome: string): Promise<void> {
  const config = await owner.run(
    owner.api[WS_METHODS.serverGetConfig]({}) as Effect.Effect<ServerConfig, unknown>,
  );
  const [expectedWorktrees, expectedKeybindings, actualWorktrees, actualKeybindings] =
    await Promise.all([
      canonicalPathForComparison(join(instanceHome, "worktrees")),
      canonicalPathForComparison(join(instanceHome, "userdata", "keybindings.json")),
      canonicalPathForComparison(config.worktreesDir),
      canonicalPathForComparison(config.keybindingsConfigPath),
    ]);
  if (expectedWorktrees !== actualWorktrees || expectedKeybindings !== actualKeybindings)
    throw new ProbeFailure("owner-instance-home-mismatch");
}

async function prepareOutputDirectory(
  options: Pick<
    ParsedRuntimeProbeOptions,
    "instanceHome" | "outputDir" | "codexHome" | "piAgentDir"
  >,
): Promise<{
  readonly outputDir: string;
  readonly workspaceRoot: string;
}> {
  const repositoryRoot = await realpath(REPOSITORY_ROOT).catch(() => REPOSITORY_ROOT);
  const userHome = await canonicalIfPresent(homedir());
  const instanceHome = await canonicalIfPresent(options.instanceHome);
  const codexHome = await canonicalIfPresent(options.codexHome);
  const piAgentDir = await canonicalIfPresent(options.piAgentDir);
  const configuredHome = process.env.SYNARA_HOME?.trim();
  const resolvedConfiguredHome = configuredHome
    ? await canonicalIfPresent(
        configuredHome.startsWith("~/")
          ? resolve(userHome, configuredHome.slice(2))
          : configuredHome,
      )
    : undefined;
  const protectedUserProfiles = await Promise.all(
    protectedUserProfilePaths(userHome).map(canonicalIfPresent),
  );
  if (resolvedConfiguredHome) protectedUserProfiles.push(resolvedConfiguredHome);
  validateProbeInstanceHome(instanceHome, userHome, resolvedConfiguredHome, protectedUserProfiles);
  try {
    if (!(await stat(instanceHome)).isDirectory()) throw new Error("not-directory");
  } catch {
    throw new ProbeFailure("instance-home-must-exist-as-isolated-directory");
  }
  validateProbePaths({
    instanceHome,
    outputDir: options.outputDir,
    codexHome,
    piAgentDir,
    repositoryRoot,
    userHome,
    protectedUserProfiles,
  });
  const outputParent = await realpath(dirname(options.outputDir)).catch(() => {
    throw new ProbeFailure("output-parent-missing");
  });
  const outputDir = resolve(outputParent, basename(options.outputDir));
  validateProbePaths({
    instanceHome,
    outputDir,
    codexHome,
    piAgentDir,
    repositoryRoot,
    userHome,
    protectedUserProfiles,
  });
  try {
    await mkdir(outputDir, { mode: 0o700 });
    await chmod(outputDir, 0o700);
  } catch {
    throw new ProbeFailure("output-directory-must-be-new");
  }
  const actualOutputDir = await realpath(outputDir).catch(() => {
    throw new ProbeFailure("output-directory-unavailable");
  });
  validateProbePaths({
    instanceHome,
    outputDir: actualOutputDir,
    codexHome,
    piAgentDir,
    repositoryRoot,
    userHome,
    protectedUserProfiles,
  });
  const workspaceRoot = join(actualOutputDir, "workspace");
  await mkdir(workspaceRoot, { mode: 0o700 }).catch(() => {
    throw new ProbeFailure("scratch-workspace-create-failed");
  });
  return { outputDir: actualOutputDir, workspaceRoot };
}

async function writeReport(outputDir: string, report: ProbeReport): Promise<void> {
  report.updatedAt = new Date().toISOString();
  const temporaryPath = join(outputDir, `.report-${randomUUID()}.tmp`);
  const reportPath = join(outputDir, "report.json");
  try {
    await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporaryPath, reportPath);
    await chmod(reportPath, 0o600);
  } catch {
    throw new ProbeFailure("report-write-failed");
  }
}

function makeModelSelection(
  provider: ProbeProvider,
  selections: ProbeModelSelections,
): ModelSelection {
  return provider === "codex"
    ? {
        provider: "codex",
        model: selections.codex.model,
        options: { reasoningEffort: selections.codex.reasoningEffort },
      }
    : {
        provider: "pi",
        model: selections.pi.model,
        options: { thinkingLevel: selections.pi.thinkingLevel },
      };
}

function makeProviderOptions(provider: ProbeProvider, codexHome: string, piAgentDir: string) {
  return provider === "codex"
    ? { codex: { homePath: codexHome } }
    : { pi: { agentDir: piAgentDir } };
}

function toolAlias(connectionId: string, tool: "echo" | "wait"): string {
  return `expert_${connectionId}_workbench_probe_${tool}`;
}

function personaDefinition(input: {
  id: string;
  name: string;
  marker: string;
  provider: ProbeProvider;
  connectionId: string;
}): Parameters<Owner["api"][typeof WS_METHODS.serverSaveExpert]>[0] {
  return {
    id: input.id,
    name: input.name,
    description: "A temporary persona used only for isolated runtime verification.",
    useCases: "Respond to a short runtime verification prompt and use the isolated MCP fixture.",
    persona: [
      `You are the ${input.name} verification persona.`,
      `Include the exact unique marker ${input.marker} in each final answer.`,
      "Never claim that a tool succeeded unless its returned result supports that claim.",
    ].join(" "),
    outputRequirements: `Include ${input.marker} in the final response.`,
    skills: [],
    references: [],
    connections: [
      {
        id: input.connectionId,
        required: true,
        tools: ["workbench_probe_echo", "workbench_probe_wait"],
      },
    ],
    preferredProvider: input.provider,
  };
}

function snapshotThread(
  owner: Owner,
  threadId: ThreadId,
): Promise<OrchestrationThreadDetailSnapshot | null> {
  return owner.run(owner.api[ORCHESTRATION_WS_METHODS.getThreadDetailSnapshot]({ threadId }));
}

async function waitForThread(
  owner: Owner,
  threadId: ThreadId,
  predicate: (thread: OrchestrationThread) => boolean,
  timeoutMs = 30_000,
): Promise<OrchestrationThreadDetailSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await snapshotThread(owner, threadId).catch(() => null);
    if (snapshot && predicate(snapshot.thread)) return snapshot;
    await sleep(RPC_POLL_INTERVAL_MS);
  }
  throw new ProbeFailure("thread-snapshot-not-ready");
}

async function dispatch(owner: Owner, rawCommand: unknown): Promise<void> {
  const command = Schema.decodeUnknownSync(ClientOrchestrationCommand)(rawCommand);
  await owner.run(owner.api[ORCHESTRATION_WS_METHODS.dispatchCommand](command));
}

async function createThread(
  owner: Owner,
  input: {
    projectId: ProjectId;
    threadId: ThreadId;
    title: string;
    modelSelection: ModelSelection;
    expertId?: string;
  },
): Promise<OrchestrationThreadDetailSnapshot> {
  await dispatch(owner, {
    type: "thread.create",
    commandId: randomUUID(),
    threadId: input.threadId,
    projectId: input.projectId,
    ...(input.expertId ? { expertId: input.expertId } : {}),
    title: input.title,
    modelSelection: input.modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    envMode: "local",
    branch: null,
    worktreePath: null,
    workingDirectory: null,
    createdAt: new Date().toISOString(),
  });
  return waitForThread(
    owner,
    input.threadId,
    (thread) => input.expertId === undefined || thread.expertBinding !== null,
  );
}

async function createProject(owner: Owner, workspaceRoot: string): Promise<ProjectId> {
  const projectId = ProjectId.makeUnsafe(randomUUID());
  await dispatch(owner, {
    type: "project.create",
    commandId: randomUUID(),
    projectId,
    title: "Workbench runtime probe",
    workspaceRoot,
    createWorkspaceRootIfMissing: false,
    createdAt: new Date().toISOString(),
  });
  return projectId;
}

async function saveExpert(
  owner: Owner,
  input: Parameters<Owner["api"][typeof WS_METHODS.serverSaveExpert]>[0],
): Promise<ExpertDefinition> {
  return owner.run(owner.api[WS_METHODS.serverSaveExpert](input));
}

function connectionTransport(
  url: string,
): Omit<Parameters<Owner["api"][typeof WS_METHODS.serverSaveExpertConnection]>[0], "id"> {
  return {
    name: "Workbench runtime probe fixture",
    transport: { type: "http", url, headersFromHost: [] },
  };
}

async function createTurn(
  owner: Owner,
  input: {
    threadId: ThreadId;
    provider: ProbeProvider;
    modelSelection: ModelSelection;
    providerOptions: ProviderStartOptions;
    prompt: string;
  },
): Promise<{ userMessageId: string; turnId: string; thread: OrchestrationThread }> {
  const before = await waitForThread(owner, input.threadId, () => true);
  const previousTurnId = before.thread.latestTurn?.turnId ?? null;
  const userMessageId = randomUUID();
  await dispatch(owner, {
    type: "thread.turn.start",
    commandId: randomUUID(),
    threadId: input.threadId,
    message: { messageId: userMessageId, role: "user", text: input.prompt, attachments: [] },
    modelSelection: input.modelSelection,
    providerOptions: input.providerOptions,
    runtimeMode: "approval-required",
    interactionMode: "default",
    createdAt: new Date().toISOString(),
  });
  const started = await waitForThread(
    owner,
    input.threadId,
    (thread) =>
      thread.messages.some((message) => message.id === userMessageId) &&
      thread.latestTurn !== null &&
      thread.latestTurn.turnId !== previousTurnId,
    PROVIDER_TURN_TIMEOUT_MS,
  );
  const latestTurn = started.thread.latestTurn;
  if (!latestTurn) throw new ProbeFailure("turn-not-created");
  return { userMessageId, turnId: latestTurn.turnId, thread: started.thread };
}

async function waitForTerminalTurn(
  owner: Owner,
  threadId: ThreadId,
  userMessageId: string,
  turnId: string,
  timeoutMs = PROVIDER_TURN_TIMEOUT_MS,
): Promise<OrchestrationThread> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await snapshotThread(owner, threadId).catch(() => null);
    const thread = snapshot?.thread;
    const turn = thread?.latestTurn;
    if (thread && turn?.turnId === turnId && thread.messages.some((m) => m.id === userMessageId)) {
      if (turn.state === "completed") return thread;
      if (turn.state === "interrupted") throw new ProbeFailure("turn-interrupted-unexpectedly");
      if (turn.state === "error") throw turnErrorFailure(thread, turnId, "turn-error");
    }
    await sleep(RPC_POLL_INTERVAL_MS);
  }
  await interruptBestEffort(owner, threadId, turnId);
  throw new ProbeFailure("provider-turn-timeout");
}

async function runSuccessfulTurn(
  owner: Owner,
  input: {
    thread: ThreadCase;
    prompt: string;
  },
): Promise<TurnOutcome> {
  const started = await createTurn(owner, {
    threadId: input.thread.threadId,
    provider: input.thread.provider,
    modelSelection: input.thread.modelSelection,
    providerOptions: input.thread.providerOptions,
    prompt: input.prompt,
  });
  const completedThread = await waitForTerminalTurn(
    owner,
    input.thread.threadId,
    started.userMessageId,
    started.turnId,
  );
  const turn = completedThread.latestTurn;
  if (!turn || turn.state !== "completed" || !turn.assistantMessageId)
    throw new ProbeFailure("assistant-turn-not-completed");
  const assistant = completedThread.messages.find(
    (message) => message.id === turn.assistantMessageId,
  );
  if (!assistant || assistant.role !== "assistant" || assistant.streaming || !assistant.text.trim())
    throw new ProbeFailure("persisted-assistant-message-missing");
  return {
    thread: completedThread,
    userMessageId: started.userMessageId,
    assistantMessageId: assistant.id,
    assistantText: assistant.text,
    assistantTextSha256: sha256(assistant.text),
    turnId: turn.turnId,
  };
}

function assertCorrectSession(outcome: TurnOutcome, provider: ProbeProvider): void {
  if (outcome.thread.session?.providerName !== provider)
    throw new ProbeFailure("provider-session-name-mismatch");
}

function assertSelectedModel(
  thread: OrchestrationThread,
  provider: ProbeProvider,
  expected: ModelSelection,
): { model: string; effort: string } {
  const selected = thread.modelSelection;
  if (provider === "codex") {
    const expectedEffort =
      expected.provider === "codex" ? expected.options?.reasoningEffort : undefined;
    if (
      expected.provider !== "codex" ||
      typeof expectedEffort !== "string" ||
      selected.provider !== "codex" ||
      selected.model !== expected.model ||
      selected.options?.reasoningEffort !== expectedEffort
    ) {
      throw new ProbeFailure("codex-model-or-effort-mismatch");
    }
    return { model: selected.model, effort: expectedEffort };
  }
  const expectedEffort = expected.provider === "pi" ? expected.options?.thinkingLevel : undefined;
  if (
    expected.provider !== "pi" ||
    typeof expectedEffort !== "string" ||
    selected.provider !== "pi" ||
    selected.model !== expected.model ||
    selected.options?.thinkingLevel !== expectedEffort
  ) {
    throw new ProbeFailure("pi-model-or-effort-mismatch");
  }
  return { model: selected.model, effort: expectedEffort };
}

function turnErrorFailure(thread: OrchestrationThread, turnId: string, code: string): ProbeFailure {
  const diagnostic = safeTurnErrorEvidence(thread.activities, turnId);
  return new ProbeFailure(code, {
    providerErrorCategory: diagnostic.providerErrorCategory,
    originalMessageSha256: diagnostic.originalMessageSha256,
    providerHttpStatus: diagnostic.providerHttpStatus,
  });
}

function assertExpertBinding(thread: OrchestrationThread, expected: ExpertBinding): void {
  const actual = thread.expertBinding;
  if (
    !actual ||
    actual.expertId !== expected.expertId ||
    actual.snapshotId !== expected.snapshotId ||
    actual.displayName !== expected.displayName ||
    actual.revision !== expected.revision
  ) {
    throw new ProbeFailure("expert-binding-mismatch");
  }
}

function assertOrdinaryBinding(thread: OrchestrationThread): void {
  if (thread.expertBinding !== null) throw new ProbeFailure("ordinary-thread-has-expert-binding");
}

function expertPrompt(tool: string, value: string): string {
  return [
    `Use the configured MCP tool named ${tool} exactly once with the JSON input ${JSON.stringify({ value })}.`,
    "After the tool returns, quote its fixture-generated marker exactly.",
    "Do not guess or invent a marker if the tool does not return one.",
  ].join(" ");
}

function cancellationPrompt(tool: string): string {
  return [
    `Call the configured MCP tool named ${tool} exactly once.`,
    "It intentionally remains pending; do not call any other tool or try to work around it.",
  ].join(" ");
}

async function interruptBestEffort(
  owner: Owner,
  threadId: ThreadId,
  turnId: string,
): Promise<void> {
  try {
    await dispatch(owner, {
      type: "thread.turn.interrupt",
      commandId: randomUUID(),
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });
  } catch {
    // Cleanup is deliberately best-effort and never changes proof status to pass.
  }
}

async function waitForTurnState(
  owner: Owner,
  threadId: ThreadId,
  turnId: string,
  expected: "running" | "interrupted",
  timeoutMs: number,
): Promise<OrchestrationThread> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await snapshotThread(owner, threadId).catch(() => null);
    const thread = snapshot?.thread;
    if (thread?.latestTurn?.turnId === turnId) {
      if (thread.latestTurn.state === expected) return thread;
      if (thread.latestTurn.state === "error")
        throw turnErrorFailure(thread, turnId, `turn-error-before-${expected}`);
      if (thread.latestTurn.state === "completed")
        throw new ProbeFailure(`turn-completed-before-${expected}`);
    }
    await sleep(RPC_POLL_INTERVAL_MS);
  }
  throw new ProbeFailure(`turn-${expected}-timeout`);
}

async function runCancellation(
  owner: Owner,
  fixture: RuntimeMcpFixture,
  thread: ThreadCase,
): Promise<Record<string, string | number | boolean | null>> {
  if (!thread.waitToolAlias) throw new ProbeFailure("expert-wait-tool-missing");
  fixture.resetWait();
  const started = await createTurn(owner, {
    threadId: thread.threadId,
    provider: thread.provider,
    modelSelection: thread.modelSelection,
    providerOptions: thread.providerOptions,
    prompt: cancellationPrompt(thread.waitToolAlias),
  });
  try {
    await fixture.waitForWaitStart(PROVIDER_TURN_TIMEOUT_MS);
    await waitForTurnState(owner, thread.threadId, started.turnId, "running", 15_000);
    await interruptBestEffort(owner, thread.threadId, started.turnId);
    const interruptedThread = await waitForTurnState(
      owner,
      thread.threadId,
      started.turnId,
      "interrupted",
      30_000,
    );
    if (interruptedThread.session?.providerName !== thread.provider)
      throw new ProbeFailure("provider-session-name-mismatch");
    assertSelectedModel(interruptedThread, thread.provider, thread.modelSelection);
    if (
      !hasExpectedMcpToolActivity(
        interruptedThread.activities,
        thread.waitToolAlias,
        thread.provider,
        started.turnId,
      )
    )
      throw new ProbeFailure("product-mcp-wait-tool-activity-missing");
    await fixture.waitForWaitAbort(30_000);
    const stats = fixture.stats();
    if (stats.cancelledWaits < 1 || stats.activeWaits !== 0)
      throw new ProbeFailure("mcp-abort-signal-not-observed");
    return {
      provider: thread.provider,
      interrupted: true,
      toolActivityObserved: true,
      waitCalls: stats.waitCalls,
      cancelledWaits: stats.cancelledWaits,
      activeWaits: stats.activeWaits,
    };
  } catch (error) {
    await interruptBestEffort(owner, thread.threadId, started.turnId);
    throw error instanceof ProbeFailure
      ? error
      : new ProbeFailure("mcp-wait-start-or-abort-missing");
  }
}

async function captureCheck(
  report: ProbeReport,
  outputDir: string,
  name: CheckName,
  operation: () => Promise<Record<string, string | number | boolean | null>>,
  fallbackCode: string,
): Promise<boolean> {
  try {
    const evidence = await operation();
    record(report, name, { status: "passed", evidence });
    await writeReport(outputDir, report);
    return true;
  } catch (error) {
    const safeEvidence = safeFailureEvidence(error);
    record(report, name, {
      status: "failed",
      reasonCode: failureCode(error, fallbackCode),
      ...(safeEvidence ? { evidence: safeEvidence } : {}),
    });
    await writeReport(outputDir, report);
    return false;
  }
}

function allPassed(report: ProbeReport, names: ReadonlyArray<CheckName>): boolean {
  return names.every((name) => report.checks[name].status === "passed");
}

function reportSummary(report: ProbeReport): Record<string, unknown> {
  return {
    sourceSha: report.sourceSha,
    status: report.status,
    phase: report.phase,
    checks: Object.fromEntries(CHECK_NAMES.map((name) => [name, report.checks[name].status])),
  };
}

async function makeThreadCases(input: {
  owner: Owner;
  projectId: ProjectId;
  connectionId: string;
  codexHome: string;
  piAgentDir: string;
  modelSelections: ProbeModelSelections;
  expertDefinitions: Record<ProbeProvider, ExpertDefinition>;
  personaMarkers: Record<ProbeProvider, string>;
}): Promise<Record<string, ThreadCase>> {
  const cases: Record<string, ThreadCase> = {};
  for (const provider of ["codex", "pi"] as const) {
    for (const kind of ["ordinary", "expert"] as const) {
      const key = `${provider}-${kind}`;
      const checkName = `${provider}-${kind}-first-turn` as CheckName;
      const threadId = ThreadId.makeUnsafe(randomUUID());
      const modelSelection = makeModelSelection(provider, input.modelSelections);
      const caseRecord: ThreadCase = {
        key,
        checkName,
        provider,
        kind,
        threadId,
        modelSelection,
        providerOptions: makeProviderOptions(provider, input.codexHome, input.piAgentDir),
        ...(kind === "expert"
          ? {
              expertId: input.expertDefinitions[provider].id,
              personaMarker: input.personaMarkers[provider],
              otherPersonaMarker: input.personaMarkers[provider === "codex" ? "pi" : "codex"],
              toolAlias: toolAlias(input.connectionId, "echo"),
              waitToolAlias: toolAlias(input.connectionId, "wait"),
            }
          : {}),
      };
      const created = await createThread(input.owner, {
        projectId: input.projectId,
        threadId,
        title: `Workbench runtime ${provider} ${kind}`,
        modelSelection,
        ...(caseRecord.expertId ? { expertId: caseRecord.expertId } : {}),
      });
      if (kind === "ordinary") {
        if (created.thread.expertBinding !== null)
          throw new ProbeFailure("ordinary-thread-binding-created-unexpectedly");
      } else {
        const definition = input.expertDefinitions[provider];
        const binding = created.thread.expertBinding;
        if (
          !binding ||
          binding.expertId !== definition.id ||
          binding.revision !== definition.revision
        )
          throw new ProbeFailure("expert-thread-binding-not-prepared");
        caseRecord.binding = binding;
      }
      cases[key] = caseRecord;
    }
  }
  return cases;
}

async function createExpertDefinitions(
  owner: Owner,
  input: {
    connectionId: string;
    markers: Record<ProbeProvider, string>;
  },
): Promise<Record<ProbeProvider, ExpertDefinition>> {
  const experts = {} as Record<ProbeProvider, ExpertDefinition>;
  for (const provider of ["codex", "pi"] as const) {
    const id = `wb-probe-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const saved = await saveExpert(
      owner,
      personaDefinition({
        id,
        name: `Workbench ${provider} runtime probe`,
        marker: input.markers[provider],
        provider,
        connectionId: input.connectionId,
      }),
    );
    if (
      saved.preferredProvider !== provider ||
      saved.connections.length !== 1 ||
      saved.connections[0]?.id !== input.connectionId ||
      saved.connections[0].tools.length !== 2 ||
      !saved.connections[0].tools.includes("workbench_probe_echo") ||
      !saved.connections[0].tools.includes("workbench_probe_wait")
    ) {
      throw new ProbeFailure("expert-definition-or-tool-allowlist-mismatch");
    }
    experts[provider] = saved;
  }
  return experts;
}

function assertAssistantMarker(
  outcome: TurnOutcome,
  input: {
    ownMarker: string;
    otherMarker: string;
  },
): void {
  if (!outcome.assistantText.includes(input.ownMarker))
    throw new ProbeFailure("expert-persona-marker-missing");
  if (outcome.assistantText.includes(input.otherMarker))
    throw new ProbeFailure("other-persona-marker-leaked");
}

function assertNoExpertMarkers(outcome: TurnOutcome, markers: Record<ProbeProvider, string>): void {
  if (Object.values(markers).some((marker) => outcome.assistantText.includes(marker)))
    throw new ProbeFailure("expert-persona-marker-leaked-into-ordinary-thread");
}

function assertMcpEcho(
  outcome: TurnOutcome,
  fixture: RuntimeMcpFixture,
  input: { expectedAlias: string; provider: ProbeProvider; callsBefore: number },
): number {
  const delta = fixture.stats().echoCalls - input.callsBefore;
  if (delta < 1) throw new ProbeFailure("mcp-echo-handler-not-called");
  if (
    !hasExpectedMcpToolActivity(
      outcome.thread.activities,
      input.expectedAlias,
      input.provider,
      outcome.turnId,
    )
  )
    throw new ProbeFailure("product-mcp-tool-activity-missing");
  if (!outcome.assistantText.includes(fixture.echoMarker))
    throw new ProbeFailure("fixture-echo-marker-missing-from-assistant");
  return delta;
}

async function readSnapshotById(owner: Owner, snapshotId: string) {
  return owner.run(owner.api[WS_METHODS.serverReadExpertSnapshot]({ snapshotId }));
}

async function verifyRestartRecovery(input: {
  owner: Owner;
  fixture: RuntimeMcpFixture;
  cases: Record<string, ThreadCase>;
  outcomes: Record<string, TurnOutcome | undefined>;
  markers: Record<ProbeProvider, string>;
  restartFingerprint: string;
}): Promise<{
  recoveryEvidence: Record<string, string | number | boolean | null>;
  echoDeltas: Record<ProbeProvider, number>;
}> {
  const resumedModels = {} as Record<ProbeProvider, { model: string; effort: string | null }>;
  for (const provider of ["codex", "pi"] as const) {
    for (const kind of ["ordinary", "expert"] as const) {
      const key = `${provider}-${kind}`;
      const threadCase = input.cases[key];
      const original = input.outcomes[key];
      if (!threadCase || !original) throw new ProbeFailure("original-thread-evidence-missing");
      const snapshot = await waitForThread(input.owner, threadCase.threadId, (thread) =>
        thread.messages.some(
          (message) =>
            message.id === original.assistantMessageId &&
            message.role === "assistant" &&
            !message.streaming &&
            sha256(message.text) === original.assistantTextSha256,
        ),
      );
      const latestAssistant = snapshot.thread.messages.find(
        (message) => message.id === original.assistantMessageId,
      );
      if (!latestAssistant || !latestAssistant.text.trim())
        throw new ProbeFailure("persisted-assistant-message-lost-after-restart");
      if (kind === "ordinary") {
        assertOrdinaryBinding(snapshot.thread);
      } else {
        if (!threadCase.binding) throw new ProbeFailure("original-expert-binding-missing");
        assertExpertBinding(snapshot.thread, threadCase.binding);
        const persistedSnapshot = await readSnapshotById(
          input.owner,
          threadCase.binding.snapshotId,
        );
        if (
          persistedSnapshot.expertId !== threadCase.expertId ||
          persistedSnapshot.revision !== threadCase.binding.revision ||
          !persistedSnapshot.persona.includes(input.markers[provider]) ||
          persistedSnapshot.persona.includes(input.markers[provider === "codex" ? "pi" : "codex"])
        ) {
          throw new ProbeFailure("immutable-expert-snapshot-changed-after-restart");
        }
      }
    }
  }

  const echoDeltas = {} as Record<ProbeProvider, number>;
  for (const provider of ["codex", "pi"] as const) {
    const threadCase = input.cases[`${provider}-expert`];
    if (
      !threadCase?.binding ||
      !threadCase.toolAlias ||
      !threadCase.personaMarker ||
      !threadCase.otherPersonaMarker
    )
      throw new ProbeFailure("expert-recovery-case-incomplete");
    const callsBefore = input.fixture.stats().echoCalls;
    const outcome = await runSuccessfulTurn(input.owner, {
      thread: threadCase,
      prompt: expertPrompt(threadCase.toolAlias, `resume-${randomUUID()}`),
    });
    assertCorrectSession(outcome, provider);
    resumedModels[provider] = assertSelectedModel(
      outcome.thread,
      provider,
      threadCase.modelSelection,
    );
    assertExpertBinding(outcome.thread, threadCase.binding);
    assertAssistantMarker(outcome, {
      ownMarker: threadCase.personaMarker,
      otherMarker: threadCase.otherPersonaMarker,
    });
    const delta = assertMcpEcho(outcome, input.fixture, {
      expectedAlias: threadCase.toolAlias,
      provider,
      callsBefore,
    });
    echoDeltas[provider] = delta;
  }
  return {
    recoveryEvidence: {
      serverInstanceChanged: true,
      serverInstanceFingerprint: input.restartFingerprint,
      originalThreadsRead: 4,
      immutableBindingsRead: 2,
      expertContinuations: 2,
      codexModel: resumedModels.codex.model,
      codexEffort: resumedModels.codex.effort,
      piModel: resumedModels.pi.model,
      piEffort: resumedModels.pi.effort,
    },
    echoDeltas,
  };
}

async function connectAfterRestart(ownerUrl: string, initialInstanceId: string): Promise<Owner> {
  const deadline = Date.now() + RESTART_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const owner = await connectOwnerUrl(ownerUrl);
      if (owner.serverInstanceId !== initialInstanceId) return owner;
      await owner.close().catch(() => undefined);
    } catch {
      // The externally controlled server may be stopping or starting.
    }
    await sleep(1_000);
  }
  throw new ProbeFailure("server-instance-did-not-change-before-deadline");
}

function freshReport(
  sourceSha: string,
  toolchain: ProbeReport["toolchain"],
  options: Pick<
    ParsedRuntimeProbeOptions,
    "codexModel" | "codexReasoningEffort" | "piModel" | "piThinkingLevel"
  >,
): ProbeReport {
  const now = new Date().toISOString();
  const checks = Object.fromEntries(
    CHECK_NAMES.map((name) => [name, { status: "not-run", reasonCode: "not-run" }]),
  ) as Record<CheckName, CheckRecord>;
  return {
    formatVersion: 1,
    sourceSha,
    startedAt: now,
    updatedAt: now,
    status: "running",
    phase: "setup",
    toolchain,
    modelSelections: {
      codex: {
        provider: "codex",
        model: options.codexModel,
        reasoningEffort: options.codexReasoningEffort,
      },
      pi: {
        provider: "pi",
        model: options.piModel,
        thinkingLevel: options.piThinkingLevel,
      },
    },
    checks,
  };
}

async function main(): Promise<void> {
  let options: ReturnType<typeof parseRuntimeProbeOptions>;
  try {
    options = parseRuntimeProbeOptions(process.argv.slice(2));
  } catch {
    process.stderr.write("workbench-runtime-probe: invalid arguments\n");
    process.exitCode = 2;
    return;
  }

  let ownerUrl: string;
  try {
    ownerUrl = authenticatedOwnerUrl(options.ownerBaseUrl, process.env[OWNER_TOKEN_ENV]);
  } catch {
    process.stderr.write("workbench-runtime-probe: owner credentials or endpoint invalid\n");
    process.exitCode = 2;
    return;
  }
  delete process.env[OWNER_TOKEN_ENV];

  let output: { outputDir: string; workspaceRoot: string } | undefined;
  let report: ProbeReport | undefined;
  let owner: Owner | undefined;
  let fixture: RuntimeMcpFixture | undefined;
  let initialServerInstanceId: string | undefined;
  let cases: Record<string, ThreadCase> = {};
  const outcomes: Record<string, TurnOutcome | undefined> = {};
  const echoInitialDeltas: Record<ProbeProvider, number> = { codex: 0, pi: 0 };
  const markers = {
    codex: `WB_PERSONA_CODEX_${randomUUID().replaceAll("-", "").toUpperCase()}`,
    pi: `WB_PERSONA_PI_${randomUUID().replaceAll("-", "").toUpperCase()}`,
  };
  try {
    const currentSourceSha = assertSourceCheckout(options.sourceSha);
    const nodeVersion = runVersionCommand("node", ["--version"]);
    const bunVersion = runVersionCommand("bun", ["--version"]);
    const runningBunVersion = process.versions.bun;
    if (!runningBunVersion || runningBunVersion !== bunVersion)
      throw new ProbeFailure("probe-must-run-with-matching-bun");
    const piSdkVersion = await installedPiSdkVersion();
    output = await prepareOutputDirectory({
      instanceHome: options.instanceHome,
      outputDir: options.outputDir,
      codexHome: options.codexHome,
      piAgentDir: options.piAgentDir,
    });
    report = freshReport(currentSourceSha, { nodeVersion, bunVersion, piSdkVersion }, options);
    await writeReport(output.outputDir, report);

    fixture = await startWorkbenchRuntimeMcpFixture();
    owner = await connectOwnerUrl(ownerUrl);
    initialServerInstanceId = owner.serverInstanceId;
    report.initialServerInstanceFingerprint = instanceFingerprint(initialServerInstanceId);
    report.phase = "initial";
    await writeReport(output.outputDir, report);

    // The only product read before any project/expert write. An accidental
    // connection to a user's existing app must stop here.
    await assertOwnerInstanceHome(owner, options.instanceHome);
    report.instanceHomeConfigVerified = true;
    await writeReport(output.outputDir, report);

    const projectId = await createProject(owner, output.workspaceRoot);
    const connectionId = `${CONNECTION_ID_PREFIX}${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const connectionInput = connectionTransport(fixture.url);
    await owner.run(
      owner.api[WS_METHODS.serverSaveExpertConnection]({
        ...connectionInput,
        id: connectionId,
      }),
    );
    const expertDefinitions = await createExpertDefinitions(owner, { connectionId, markers });
    cases = await makeThreadCases({
      owner,
      projectId,
      connectionId,
      codexHome: options.codexHome,
      piAgentDir: options.piAgentDir,
      modelSelections: report.modelSelections,
      expertDefinitions,
      personaMarkers: markers,
    });

    let providerExecutionBlocked = false;
    let blockedBy = "provider-turn-failed";
    for (const provider of ["codex", "pi"] as const) {
      const ordinary = cases[`${provider}-ordinary`];
      const expert = cases[`${provider}-expert`];
      if (!ordinary || !expert) throw new ProbeFailure("thread-cases-incomplete");
      for (const threadCase of [ordinary, expert]) {
        if (providerExecutionBlocked) {
          record(report, threadCase.checkName, {
            status: "not-run",
            reasonCode: "provider-calls-stopped-after-earlier-failure",
          });
          await writeReport(output.outputDir, report);
          continue;
        }
        await captureCheck(
          report,
          output.outputDir,
          threadCase.checkName,
          async () => {
            const isExpert = threadCase.kind === "expert";
            const echoCallsBefore = isExpert ? fixture!.stats().echoCalls : undefined;
            const prompt = isExpert
              ? expertPrompt(threadCase.toolAlias!, `initial-${randomUUID()}`)
              : "Say hello in one short sentence.";
            const outcome = await runSuccessfulTurn(owner!, { thread: threadCase, prompt });
            outcomes[threadCase.key] = outcome;
            assertCorrectSession(outcome, provider);
            const modelEvidence = assertSelectedModel(
              outcome.thread,
              provider,
              threadCase.modelSelection,
            );
            if (isExpert) {
              if (
                !threadCase.binding ||
                !threadCase.personaMarker ||
                !threadCase.otherPersonaMarker
              )
                throw new ProbeFailure("expert-first-turn-case-incomplete");
              assertExpertBinding(outcome.thread, threadCase.binding);
              assertAssistantMarker(outcome, {
                ownMarker: threadCase.personaMarker,
                otherMarker: threadCase.otherPersonaMarker,
              });
              const userMessage = outcome.thread.messages.find(
                (message) => message.id === outcome.userMessageId,
              );
              if (!userMessage || userMessage.text.includes(threadCase.personaMarker))
                throw new ProbeFailure("expert-marker-was-injected-in-user-prompt");
              if (echoCallsBefore === undefined)
                throw new ProbeFailure("initial-mcp-call-baseline-missing");
              echoInitialDeltas[provider] = assertMcpEcho(outcome, fixture!, {
                expectedAlias: threadCase.toolAlias!,
                provider,
                callsBefore: echoCallsBefore,
              });
            } else {
              assertOrdinaryBinding(outcome.thread);
              assertNoExpertMarkers(outcome, markers);
            }
            return {
              provider,
              kind: threadCase.kind,
              latestTurn: "completed",
              providerName: outcome.thread.session?.providerName ?? null,
              ...modelEvidence,
              assistantMessagePersisted: true,
              assistantTextSha256: outcome.assistantTextSha256,
            };
          },
          `${threadCase.key}-first-turn-failed`,
        );
        if (report.checks[threadCase.checkName].status !== "passed") {
          providerExecutionBlocked = true;
          blockedBy = report.checks[threadCase.checkName].reasonCode ?? "provider-turn-failed";
        }
      }
    }

    if (providerExecutionBlocked) {
      markNotRun(
        report,
        ["mcp", "cancellation", "session-isolation", "recovery"],
        "provider-calls-stopped-after-earlier-failure",
      );
      report.status = "failed";
      report.phase = "complete";
      report.failureCode = blockedBy;
      await writeReport(output.outputDir, report);
      process.stdout.write(`${JSON.stringify(reportSummary(report))}\n`);
      process.exitCode = 1;
      return;
    }

    const mcpPassed = await captureCheck(
      report,
      output.outputDir,
      "mcp",
      async () => {
        const deltas = {} as Record<ProbeProvider, number>;
        for (const provider of ["codex", "pi"] as const) {
          const outcome = outcomes[`${provider}-expert`];
          if (!outcome || echoInitialDeltas[provider] < 1)
            throw new ProbeFailure(`${provider}-expert-first-turn-missing-for-mcp`);
          deltas[provider] = echoInitialDeltas[provider];
        }
        return {
          initialCodexEchoCalls: deltas.codex,
          initialPiEchoCalls: deltas.pi,
          fixtureEchoCalls: fixture!.stats().echoCalls,
        };
      },
      "initial-mcp-round-trip-failed",
    );

    if (!mcpPassed) {
      markNotRun(report, ["cancellation", "recovery"], "provider-calls-stopped-after-mcp-failure");
      report.status = "failed";
      report.phase = "complete";
      await writeReport(output.outputDir, report);
      process.stdout.write(`${JSON.stringify(reportSummary(report))}\n`);
      process.exitCode = 1;
      return;
    }

    await captureCheck(
      report,
      output.outputDir,
      "cancellation",
      async () => {
        const codexCase = cases["codex-expert"];
        const piCase = cases["pi-expert"];
        if (!codexCase || !piCase) throw new ProbeFailure("expert-cancellation-threads-missing");
        const codex = await runCancellation(owner!, fixture!, codexCase);
        const pi = await runCancellation(owner!, fixture!, piCase);
        return {
          codexInterrupted: codex.interrupted === true,
          codexCancelledWaits: codex.cancelledWaits ?? 0,
          codexActiveWaits: codex.activeWaits ?? -1,
          piInterrupted: pi.interrupted === true,
          piCancelledWaits: pi.cancelledWaits ?? 0,
          piActiveWaits: pi.activeWaits ?? -1,
        };
      },
      "provider-cancellation-failed",
    );

    await captureCheck(
      report,
      output.outputDir,
      "session-isolation",
      async () => {
        const sessionThreadIds: string[] = [];
        for (const provider of ["codex", "pi"] as const) {
          const ordinary = outcomes[`${provider}-ordinary`];
          const expert = outcomes[`${provider}-expert`];
          const ordinaryCase = cases[`${provider}-ordinary`];
          const expertCase = cases[`${provider}-expert`];
          if (!ordinary || !expert || !ordinaryCase || !expertCase)
            throw new ProbeFailure(`${provider}-session-evidence-missing`);
          assertOrdinaryBinding(ordinary.thread);
          if (!expertCase.binding) throw new ProbeFailure("expert-session-binding-missing");
          assertExpertBinding(expert.thread, expertCase.binding);
          assertNoExpertMarkers(ordinary, markers);
          assertAssistantMarker(expert, {
            ownMarker: expertCase.personaMarker!,
            otherMarker: expertCase.otherPersonaMarker!,
          });
          for (const outcome of [ordinary, expert]) {
            const sessionThreadId = outcome.thread.session?.threadId;
            if (!sessionThreadId || sessionThreadId !== outcome.thread.id)
              throw new ProbeFailure("product-session-thread-identity-mismatch");
            sessionThreadIds.push(sessionThreadId);
          }
        }
        const definitions = await Promise.all([
          readSnapshotById(owner!, cases["codex-expert"]!.binding!.snapshotId),
          readSnapshotById(owner!, cases["pi-expert"]!.binding!.snapshotId),
        ]);
        if (
          !definitions[0].persona.includes(markers.codex) ||
          !definitions[1].persona.includes(markers.pi) ||
          definitions[0].persona.includes(markers.pi) ||
          definitions[1].persona.includes(markers.codex)
        ) {
          throw new ProbeFailure("expert-snapshot-persona-cross-leak");
        }
        const uniqueSessionThreadIds = new Set(sessionThreadIds);
        if (sessionThreadIds.length !== 4 || uniqueSessionThreadIds.size !== 4)
          throw new ProbeFailure("product-session-thread-identities-not-distinct");
        return {
          ordinaryThreads: 2,
          immutableExpertThreads: 2,
          productSessionThreadCount: sessionThreadIds.length,
          distinctProductSessionThreadCount: uniqueSessionThreadIds.size,
          productSessionThreadIdHashes: sessionThreadIds.map(sha256).join(","),
          personaMarkersCrossed: false,
        };
      },
      "session-isolation-check-failed",
    );

    report.phase = "initial";
    if (
      !allPassed(report, [
        "codex-ordinary-first-turn",
        "codex-expert-first-turn",
        "pi-ordinary-first-turn",
        "pi-expert-first-turn",
        "cancellation",
        "mcp",
        "session-isolation",
      ])
    ) {
      report.status = "failed";
      await writeReport(output.outputDir, report);
      process.stdout.write(`${JSON.stringify(reportSummary(report))}\n`);
      process.exitCode = 1;
      return;
    }

    if (!options.awaitServerRestart) {
      record(report, "recovery", { status: "not-run", reasonCode: "restart-not-requested" });
      report.status = "incomplete";
      report.phase = "complete";
      await writeReport(output.outputDir, report);
      process.stdout.write(`${JSON.stringify(reportSummary(report))}\n`);
      process.exitCode = 2;
      return;
    }

    report.status = "awaiting-server-restart";
    report.phase = "awaiting-server-restart";
    await writeReport(output.outputDir, report);
    await owner.close();
    owner = undefined;
    process.stdout.write("ready-for-owned-server-restart\n");

    report.phase = "recovery";
    try {
      owner = await connectAfterRestart(ownerUrl, initialServerInstanceId!);
      report.restartedServerInstanceFingerprint = instanceFingerprint(owner.serverInstanceId);
      await assertOwnerInstanceHome(owner, options.instanceHome);
      report.restartedInstanceHomeConfigVerified = true;
      await writeReport(output.outputDir, report);
      const recovery = await verifyRestartRecovery({
        owner,
        fixture,
        cases,
        outcomes,
        markers,
        restartFingerprint: report.restartedServerInstanceFingerprint,
      });
      record(report, "recovery", { status: "passed", evidence: recovery.recoveryEvidence });
      record(report, "mcp", {
        status: "passed",
        evidence: {
          initialCodexEchoCalls: echoInitialDeltas.codex,
          initialPiEchoCalls: echoInitialDeltas.pi,
          resumedCodexEchoCalls: recovery.echoDeltas.codex,
          resumedPiEchoCalls: recovery.echoDeltas.pi,
          fixtureEchoCalls: fixture.stats().echoCalls,
        },
      });
    } catch (error) {
      const safeEvidence = safeFailureEvidence(error);
      record(report, "recovery", {
        status: "failed",
        reasonCode: failureCode(error, "restart-recovery-failed"),
        ...(safeEvidence ? { evidence: safeEvidence } : {}),
      });
      record(report, "mcp", {
        status: "failed",
        reasonCode: failureCode(error, "post-restart-mcp-round-trip-failed"),
      });
    }
    report.status = allPassed(report, CHECK_NAMES) ? "complete" : "failed";
    report.phase = "complete";
    await writeReport(output.outputDir, report);
    process.stdout.write(`${JSON.stringify(reportSummary(report))}\n`);
    if (report.status !== "complete") process.exitCode = 1;
  } catch (error) {
    if (report && output) {
      report.status = "failed";
      report.phase = report.phase === "setup" ? "setup" : report.phase;
      report.failureCode = failureCode(error, "probe-stage-failed");
      await writeReport(output.outputDir, report).catch(() => undefined);
      process.stdout.write(`${JSON.stringify(reportSummary(report))}\n`);
    } else {
      process.stderr.write("workbench-runtime-probe: preflight failed\n");
    }
    process.exitCode = 1;
  } finally {
    await owner?.close().catch(() => undefined);
    await fixture?.close().catch(() => undefined);
  }
}

void main();
