import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sdkDir = resolve(root, "apps/server/node_modules/@earendil-works/pi-coding-agent/dist");
const sdk = await import(pathToFileURL(join(sdkDir, "index.js")).href);
const { AuthStorage } = await import(pathToFileURL(join(sdkDir, "core/auth-storage.js")).href);

const provider = "openai-codex";
const modelId = "gpt-5.6-sol";
const sourceAgentDir = sdk.getAgentDir();
const scratch = await mkdtemp(join(tmpdir(), "synara-pi-p0-lifecycle-"));
const agentDir = join(scratch, "agent");
const cwd = join(scratch, "work");
const configured = sdk.SettingsManager.create(scratch, sourceAgentDir);
const selectedProvider = configured.getDefaultProvider();
const selectedModel = configured.getDefaultModel();
const results = { sdkVersion: sdk.VERSION, provider: selectedProvider, model: selectedModel };
const sessionDir = join(scratch, "sessions");
const skillRoot = join(scratch, "skills");
const skillDir = join(skillRoot, "expert-p0-live");
const modelStorePath = join(scratch, "models-store.json");
const personaMarker = `PERSONA_PASS_${crypto.randomUUID()}`;
const skillMarker = `SKILL_PASS_${crypto.randomUUID()}`;
const resumedToolMarker = `TOOL_RESUMED_${crypto.randomUUID()}`;
const cancelledToolMarker = `TOOL_CANCELLED_${crypto.randomUUID()}`;
const counters = { first: 0, resumed: 0, cancelled: 0 };
const flags = {
  cancelToolReceivedSignal: false,
  cancelToolStoppedBySignal: false,
  cancelToolSettled: false,
  cancelToolTimedOut: false,
};
let cancelToolCleanup;
let session;
let sessionFile;
let activeToolPhase;
let cancelStartListener;
let stage = "setup";

function errorCategory(error) {
  const text = `${error?.name ?? ""} ${error?.code ?? ""} ${error?.status ?? error?.statusCode ?? ""} ${error?.message ?? ""}`;
  if (/timeout|timed out|etimedout/i.test(text)) return "timeout";
  if (/429|rate.?limit|quota|insufficient_quota/i.test(text)) return "quota_or_rate_limit";
  if (/401|403|unauthori[sz]ed|forbidden|credential|auth/i.test(text)) return "auth";
  if (/abort|cancel/i.test(text)) return "cancelled";
  if (/fetch|network|socket|connect|econn|proxy/i.test(text)) return "network";
  return "provider_error";
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function bounded(promise, ms, fallback) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(fallback), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function extractAssistantText(messages) {
  return messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.filter((item) => item.type === "text").map((item) => item.text)
        : [],
    )
    .join("\n");
}

function markersObserved(sessionMessages, toolMarker) {
  const assistantText = extractAssistantText(sessionMessages);
  return {
    persona: assistantText.includes(personaMarker),
    skill: assistantText.includes(skillMarker),
    tool: assistantText.includes(toolMarker),
  };
}

async function makeRuntime(credentialStore) {
  const runtime = await sdk.ModelRuntime.create({
    credentials: credentialStore,
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: modelStorePath,
    allowModelNetwork: false,
  });
  await runtime.refresh({ allowNetwork: false });
  return runtime;
}

async function makeServices(runtime, phase) {
  const settingsManager = sdk.SettingsManager.inMemory({
    defaultProvider: provider,
    defaultModel: modelId,
    defaultThinkingLevel: "minimal",
    enableSkillCommands: true,
  });
  const services = await sdk.createAgentSessionServices({
    cwd,
    agentDir,
    modelRuntime: runtime,
    settingsManager,
    resourceLoaderOptions: {
      appendSystemPrompt: [
        `Isolated P0 test persona: include the exact marker ${personaMarker} in your final response.`,
      ],
      additionalSkillPaths: [skillRoot],
      noExtensions: true,
      noContextFiles: true,
      noPromptTemplates: true,
    },
  });
  const skillLoaded = services.resourceLoader
    .getSkills()
    .skills.some((skill) => skill.name === "expert-p0-live");
  const personaLoaded = services.resourceLoader
    .getAppendSystemPrompt()
    .join("\n")
    .includes(personaMarker);
  results[`${phase}ResourcePreflight`] = { skillLoaded, personaLoaded };
  assert(skillLoaded, `selected skill not loaded for ${phase} session`);
  assert(personaLoaded, `persona not loaded for ${phase} session`);
  return services;
}

function makeTool() {
  return sdk.defineTool({
    name: "expert_p0_live",
    label: "Expert P0 lifecycle probe",
    description: "Return a one-time isolated P0 verification marker.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async (_id, _params, signal) => {
      const phase = activeToolPhase;
      counters[phase] += 1;
      if (phase !== "cancelled") {
        const marker =
          phase === "first" ? `TOOL_FIRST_${personaMarker.slice(-10)}` : resumedToolMarker;
        return { content: [{ type: "text", text: marker }] };
      }

      cancelStartListener?.();
      flags.cancelToolReceivedSignal = signal !== undefined;
      return new Promise((resolveTool) => {
        let settled = false;
        const settle = (stoppedBySignal) => {
          if (settled) return;
          settled = true;
          flags.cancelToolSettled = true;
          flags.cancelToolStoppedBySignal = stoppedBySignal;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolveTool({
            content: [
              {
                type: "text",
                text: stoppedBySignal ? "cancelled" : cancelledToolMarker,
              },
            ],
            ...(stoppedBySignal ? { isError: true } : {}),
          });
        };
        const onAbort = () => settle(true);
        const timer = setTimeout(() => {
          flags.cancelToolTimedOut = true;
          settle(false);
        }, 40_000);
        cancelToolCleanup = () => settle(false);
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  });
}

async function createSession(runtime, sessionManager, phase) {
  const services = await makeServices(runtime, phase);
  activeToolPhase = phase;
  const tool = makeTool();
  const model = runtime.getModel(provider, modelId);
  if (!model) throw new Error("configured model missing from Pi runtime");
  const created = await sdk.createAgentSessionFromServices({
    services,
    sessionManager,
    model,
    thinkingLevel: "minimal",
    tools: [tool.name],
    customTools: [tool],
  });
  assert(
    created.session.systemPrompt.includes(personaMarker),
    `persona not loaded for ${phase} session`,
  );
  assert(
    created.session.getActiveToolNames().includes(tool.name),
    `custom tool not active for ${phase} session`,
  );
  return created.session;
}

async function runTurn(targetSession, phase, timeoutMs = 40_000) {
  const marker = phase === "first" ? `TOOL_FIRST_${personaMarker.slice(-10)}` : resumedToolMarker;
  const start = targetSession.messages.length;
  const prompt =
    "/skill:expert-p0-live Invoke the expert_p0_live tool exactly once, then return the token it provides.";
  let timer;
  const outcome = await Promise.race([
    targetSession.prompt(prompt).then(
      () => ({ kind: "completed" }),
      (error) => ({ kind: "error", error }),
    ),
    new Promise((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout({ kind: "timeout" }), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (outcome.kind === "timeout") {
    await Promise.race([targetSession.abort(), delay(5_000)]);
    return {
      completed: false,
      errorCategory: "timeout",
      markers: { persona: false, skill: false, tool: false },
    };
  }
  if (outcome.kind === "error") {
    return {
      completed: false,
      errorCategory: errorCategory(outcome.error),
      markers: { persona: false, skill: false, tool: false },
    };
  }
  return {
    completed: true,
    errorCategory: null,
    markers: markersObserved(targetSession.messages.slice(start), marker),
  };
}

async function runCancellation(targetSession) {
  let toolStartedResolve;
  const toolStarted = new Promise((resolveStarted) => (toolStartedResolve = resolveStarted));
  activeToolPhase = "cancelled";
  cancelStartListener = toolStartedResolve;

  const promptPromise = targetSession
    .prompt(
      `/skill:expert-p0-live Invoke the expert_p0_live tool exactly once now. The tool will be cancelled; do not retry it.`,
    )
    .then(
      () => ({ kind: "completed" }),
      (error) => ({ kind: "error", error }),
    );
  const started = await bounded(
    toolStarted.then(() => true),
    35_000,
    false,
  );
  if (!started) {
    await bounded(targetSession.abort(), 5_000, undefined);
    const settled = await bounded(promptPromise, 5_000, { kind: "timeout" });
    return {
      toolStarted: false,
      promptCompleted: settled.kind === "completed",
      errorCategory:
        settled.kind === "error"
          ? errorCategory(settled.error)
          : settled.kind === "timeout"
            ? "timeout"
            : null,
    };
  }

  const abortWait = await bounded(
    targetSession.abort().then(() => "idle"),
    8_000,
    "timeout",
  );
  if (!flags.cancelToolSettled) cancelToolCleanup?.();
  const promptResult = await bounded(promptPromise, 5_000, { kind: "timeout" });
  const assistant = targetSession.messages.filter((message) => message.role === "assistant").at(-1);
  return {
    toolStarted: true,
    promptCompleted: promptResult.kind === "completed",
    errorCategory:
      promptResult.kind === "error"
        ? errorCategory(promptResult.error)
        : promptResult.kind === "timeout"
          ? "timeout"
          : null,
    abortWait,
    sessionIdle: targetSession.isIdle,
    assistantTerminalAborted: assistant?.stopReason === "aborted",
  };
}

try {
  if (selectedProvider !== provider || selectedModel !== modelId) {
    results.status = "skipped_unexpected_default";
    results.inferenceCompleted = false;
  } else {
    stage = "prepare_isolated_resources";
    await Promise.all([
      mkdir(agentDir, { recursive: true }),
      mkdir(cwd, { recursive: true }),
      mkdir(sessionDir, { recursive: true }),
    ]);
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---\nname: expert-p0-live\ndescription: Isolated P0 skill marker check\n---\nInclude the exact marker ${skillMarker} in your final response and call the expert_p0_live tool exactly once.\n`,
    );

    stage = "read_selected_credential";
    const credential = sdk.readStoredCredential(provider, join(sourceAgentDir, "auth.json"));
    if (!credential) throw new Error("selected provider has no stored credential");
    const initialCredentials = AuthStorage.inMemory({ [provider]: credential });
    stage = "create_runtime";
    let runtime = await makeRuntime(initialCredentials);
    results.authConfiguredAfterLocalRefresh = runtime.hasConfiguredAuth(provider);
    results.authSourceAfterLocalRefresh = runtime.getProviderAuthStatus(provider).source ?? null;
    if (!results.authConfiguredAfterLocalRefresh)
      throw new Error("selected provider auth unavailable");
    results.inferenceModelAvailable = Boolean(runtime.getModel(provider, modelId));

    stage = "create_initial_session_manager";
    const sessionManager = sdk.SessionManager.create(cwd, sessionDir);
    stage = "create_initial_session_services";
    session = await createSession(runtime, sessionManager, "first");
    stage = "initial_real_turn";
    results.firstTurn = await runTurn(session, "first");
    sessionFile = session.sessionFile;
    results.sessionPersisted = Boolean(sessionFile && sessionFile.startsWith(sessionDir));
    session.dispose();
    session = undefined;

    if (!results.firstTurn.completed || !sessionFile) {
      results.status = "first_turn_failed";
    } else {
      stage = "rebuild_runtime";
      const resumedCredentials = AuthStorage.inMemory({ [provider]: credential });
      runtime = await makeRuntime(resumedCredentials);
      stage = "reopen_persisted_session";
      const resumedManager = sdk.SessionManager.open(sessionFile, sessionDir, cwd);
      results.sessionReconstructed = resumedManager.getEntries().length > 0;
      stage = "rebuild_session_services";
      session = await createSession(runtime, resumedManager, "resumed");
      stage = "resumed_real_turn";
      results.resumedTurn = await runTurn(session, "resumed");

      if (results.resumedTurn.completed) {
        stage = "active_tool_cancellation";
        const beforeCancel = session.messages.length;
        const cancellation = await runCancellation(session);
        results.cancellation = {
          ...cancellation,
          toolExecutions: counters.cancelled,
          toolReceivedAbortSignal: flags.cancelToolReceivedSignal,
          waitingToolStoppedBySignal: flags.cancelToolStoppedBySignal,
          waitingToolSettled: flags.cancelToolSettled,
          waitingToolTimedOut: flags.cancelToolTimedOut,
          messagesAddedDuringCancellation: session.messages.length - beforeCancel,
        };
      } else {
        results.cancellation = { skipped: "resume_turn_failed" };
      }
      results.status = "completed";
    }
    results.toolExecutions = {
      first: counters.first,
      resumed: counters.resumed,
      cancelled: counters.cancelled,
    };
  }
} catch (error) {
  results.status = "error";
  results.errorStage = stage;
  results.errorCategory = errorCategory(error);
} finally {
  session?.dispose();
  cancelToolCleanup?.();
  await rm(scratch, { recursive: true, force: true });
}

const validTurn = (turn) =>
  turn?.completed === true &&
  turn.markers?.persona === true &&
  turn.markers?.skill === true &&
  turn.markers?.tool === true;
const cancellation = results.cancellation;
const overallPass =
  results.status === "completed" &&
  results.firstResourcePreflight?.skillLoaded === true &&
  results.firstResourcePreflight?.personaLoaded === true &&
  validTurn(results.firstTurn) &&
  results.sessionPersisted === true &&
  results.sessionReconstructed === true &&
  results.resumedResourcePreflight?.skillLoaded === true &&
  results.resumedResourcePreflight?.personaLoaded === true &&
  validTurn(results.resumedTurn) &&
  results.toolExecutions?.first === 1 &&
  results.toolExecutions?.resumed === 1 &&
  cancellation?.toolStarted === true &&
  cancellation?.promptCompleted === true &&
  cancellation?.errorCategory === null &&
  cancellation?.abortWait === "idle" &&
  cancellation?.sessionIdle === true &&
  cancellation?.toolExecutions === 1 &&
  cancellation?.toolReceivedAbortSignal === true &&
  cancellation?.waitingToolStoppedBySignal === true &&
  cancellation?.waitingToolSettled === true &&
  cancellation?.waitingToolTimedOut === false;
results.overallPass = overallPass;
console.log(JSON.stringify(results));
if (!overallPass) process.exitCode = 1;
