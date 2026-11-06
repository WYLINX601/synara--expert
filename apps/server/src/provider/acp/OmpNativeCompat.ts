/**
 * Public-extension bridge for standalone OMP ACP launches.
 *
 * @module OmpNativeCompat
 */
import { randomUUID } from "node:crypto";
import { chmod, lstat, rename, unlink, writeFile } from "node:fs/promises";
import * as nodePath from "node:path";

import { SKILL_EVOLUTION_SYSTEM_PROMPT } from "../skillEvolutionConstraints.ts";

export const OMP_NATIVE_COMPAT_VERSION = "v1" as const;
export const OMP_NATIVE_COMPAT_MARKER_PREFIX =
  `SYNARA_OMP_NATIVE_COMPAT ${OMP_NATIVE_COMPAT_VERSION}` as const;
export const OMP_NATIVE_COMPAT_MAX_EVENT_LINE_BYTES = 64 * 1024;
export const OMP_NATIVE_COMPAT_MAX_PROMPT_BYTES = 1024 * 1024;

const OMP_NATIVE_COMPAT_SYSTEM_PROMPT_FILENAME = "omp-native-evolution-system.md";
const OMP_NATIVE_COMPAT_APPEND_PROMPT_FILENAME = "omp-native-evolution-append.md";
const OMP_NATIVE_COMPAT_CONFIG_FILENAME = "omp-native-evolution-config.yml";
const OMP_NATIVE_COMPAT_PROMPT_FILENAME = "omp-native-evolution-request.json";
const OMP_NATIVE_COMPAT_EXTENSION_PREFIX = "omp-native-compat-";

export type OmpNativeCompatKind = "fixed" | "evolution";

export interface OmpNativeCompatLaunch {
  readonly extensionPath: string;
  /** Exact line prefix used to authenticate extension events for this launch. */
  readonly expectedMarker: string;
  readonly kind: OmpNativeCompatKind;
  readonly sessionDir?: string;
  readonly systemPromptPath?: string;
  readonly appendSystemPromptPath?: string;
  readonly configOverlayPath?: string;
  readonly promptPath?: string;
}

export interface PrepareOmpNativeCompatInput {
  readonly privateTempDirectory: string;
  readonly kind: OmpNativeCompatKind;
  readonly sessionDir?: string;
}

export type OmpNativeCompatFailureReason =
  | "missing-public-api"
  | "invalid-runtime-context"
  | "active-tools-not-empty"
  | "system-prompt-mismatch"
  | "authorized-prompt-unavailable"
  | "submitted-prompt-mismatch"
  | "prompt-changed"
  | "multiple-user-requests"
  | "unauthorized-tool-call"
  | "unsupported-provider-payload"
  | "event-too-large";

export type OmpNativeCompatEvent =
  | { readonly type: "ready"; readonly kind: OmpNativeCompatKind }
  | {
      readonly type: "approval";
      readonly toolCallId: string;
      readonly toolName: string;
    }
  | {
      readonly type: "task";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args: unknown;
      readonly partialResult: Record<string, unknown>;
    }
  | { readonly type: "failure"; readonly reason: OmpNativeCompatFailureReason };

/**
 * Prepare an immutable public extension and, for evolution, its session-local
 * config and prompt files. The caller owns and creates the private directory.
 */
export async function prepareOmpNativeCompat(
  input: PrepareOmpNativeCompatInput,
): Promise<OmpNativeCompatLaunch> {
  if (input.kind !== "fixed" && input.kind !== "evolution") {
    throw new Error("OMP native compatibility requires a supported bridge kind.");
  }

  const privateTempDirectory = input.privateTempDirectory.trim();
  if (!privateTempDirectory) {
    throw new Error("OMP native compatibility requires an owned private directory.");
  }
  const directoryInfo = await lstat(privateTempDirectory).catch(() => undefined);
  if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error("OMP native compatibility requires an existing private directory.");
  }
  const directory = nodePath.resolve(privateTempDirectory);
  const sessionDir = input.sessionDir?.trim();
  if (input.kind === "evolution" && !sessionDir) {
    throw new Error("OMP native evolution requires a private session directory.");
  }
  const nonce = randomUUID().replaceAll("-", "");
  const expectedMarker = `${OMP_NATIVE_COMPAT_MARKER_PREFIX} nonce=${nonce}`;
  const extensionPath = nodePath.join(
    directory,
    `${OMP_NATIVE_COMPAT_EXTENSION_PREFIX}${nonce}.mjs`,
  );

  if (input.kind === "fixed") {
    await writeImmutableFile(extensionPath, buildFixedExtension(expectedMarker));
    return {
      extensionPath,
      expectedMarker,
      kind: input.kind,
      ...(sessionDir ? { sessionDir } : {}),
    };
  }

  const systemPromptPath = nodePath.join(directory, OMP_NATIVE_COMPAT_SYSTEM_PROMPT_FILENAME);
  const appendSystemPromptPath = nodePath.join(directory, OMP_NATIVE_COMPAT_APPEND_PROMPT_FILENAME);
  const configOverlayPath = nodePath.join(directory, OMP_NATIVE_COMPAT_CONFIG_FILENAME);
  const promptPath = nodePath.join(directory, OMP_NATIVE_COMPAT_PROMPT_FILENAME);

  await Promise.all([
    writeImmutableFile(systemPromptPath, SKILL_EVOLUTION_SYSTEM_PROMPT),
    writeImmutableFile(appendSystemPromptPath, ""),
    writeImmutableFile(
      configOverlayPath,
      [
        "autolearn:",
        "  enabled: false",
        "  autoContinue: false",
        "task:",
        "  maxRecursionDepth: 0",
        "advisor:",
        "  enabled: false",
        "",
      ].join("\n"),
    ),
    writeImmutableFile(
      extensionPath,
      buildEvolutionExtension({
        expectedMarker,
        promptPath,
        systemPromptPath,
      }),
    ),
  ]);

  return {
    extensionPath,
    expectedMarker,
    kind: input.kind,
    ...(sessionDir ? { sessionDir } : {}),
    systemPromptPath,
    appendSystemPromptPath,
    configOverlayPath,
    promptPath,
  };
}

/** Atomically replace the private, nonce-bound prompt for one evolution turn. */
export async function writeOmpNativeEvolutionPrompt(
  launch: OmpNativeCompatLaunch,
  text: string,
): Promise<void> {
  if (launch.kind !== "evolution" || !launch.promptPath) {
    throw new Error("OMP native evolution prompt requires an evolution launch.");
  }
  if (typeof text !== "string") {
    throw new Error("OMP native evolution prompt must be text.");
  }
  if (Buffer.byteLength(text, "utf8") > OMP_NATIVE_COMPAT_MAX_PROMPT_BYTES) {
    throw new Error("OMP native evolution prompt exceeds the private request size limit.");
  }

  const nonce = nonceFromMarker(launch.expectedMarker);
  const target = launch.promptPath;
  const temp = `${target}.${randomUUID()}.tmp`;
  const content = JSON.stringify({ version: OMP_NATIVE_COMPAT_VERSION, nonce, text });
  try {
    await writeFile(temp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(temp, 0o600);
    await rename(temp, target);
  } catch (cause) {
    await unlink(temp).catch(() => {});
    throw cause;
  }
}

/** Parse one bounded nonce-authenticated stderr event from the public bridge. */
export function parseOmpNativeCompatEvent(
  line: string,
  launch: Pick<OmpNativeCompatLaunch, "expectedMarker" | "kind">,
): OmpNativeCompatEvent | undefined {
  if (typeof line !== "string") return undefined;
  const normalized = line.replace(/\r?\n$/u, "");
  if (
    Buffer.byteLength(normalized, "utf8") > OMP_NATIVE_COMPAT_MAX_EVENT_LINE_BYTES ||
    normalized.includes("\n") ||
    normalized.includes("\r") ||
    !isExpectedMarker(launch.expectedMarker) ||
    !normalized.startsWith(`${launch.expectedMarker} `)
  ) {
    return undefined;
  }

  const raw = normalized.slice(launch.expectedMarker.length + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") return undefined;

  switch (parsed.type) {
    case "ready":
      return parsed.kind === launch.kind ? { type: "ready", kind: launch.kind } : undefined;
    case "approval":
      return isBoundedString(parsed.toolCallId, 512) && isBoundedString(parsed.toolName, 256)
        ? {
            type: "approval",
            toolCallId: parsed.toolCallId,
            toolName: parsed.toolName,
          }
        : undefined;
    case "task":
      if (
        !isBoundedString(parsed.toolCallId, 512) ||
        !isBoundedString(parsed.toolName, 256) ||
        !isRecord(parsed.partialResult) ||
        !isTaskPartialResult(parsed.partialResult)
      ) {
        return undefined;
      }
      return {
        type: "task",
        toolCallId: parsed.toolCallId,
        toolName: parsed.toolName,
        args: parsed.args,
        partialResult: parsed.partialResult,
      };
    case "failure":
      return isFailureReason(parsed.reason)
        ? { type: "failure", reason: parsed.reason }
        : undefined;
    default:
      return undefined;
  }
}

async function writeImmutableFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: "utf8", mode: 0o400, flag: "wx" });
  await chmod(path, 0o400);
}

function buildFixedExtension(expectedMarker: string): string {
  return `${extensionSharedSource(expectedMarker)}
export function activateOmpNativeCompat(pi, processLike = globalThis.process) {
  requirePublicApi(pi, processLike);
  pi.on("session_start", async (_event, ctx) => {
    if (!isRootAcp(ctx)) return;
    if (typeof ctx.isIdle !== "function") failClosed(processLike, "invalid-runtime-context");
    emit({ type: "ready", kind: "fixed" });
  });
  pi.on("tool_approval_requested", async (event, ctx) => {
    if (!isRootAcp(ctx)) return;
    if (!isBoundedString(event?.toolCallId, 512) || !isBoundedString(event?.toolName, 256)) return;
    emit({ type: "approval", toolCallId: event.toolCallId, toolName: event.toolName });
  });
  pi.on("tool_execution_update", async (event, ctx) => {
    if (!isRootAcp(ctx) || typeof ctx.isIdle !== "function" || !ctx.isIdle()) return;
    const partialResult = event?.partialResult;
    if (!isTaskPartialResult(partialResult)) return;
    if (!isBoundedString(event?.toolCallId, 512) || !isBoundedString(event?.toolName, 256)) return;
    const args = event.args === undefined ? (event.input === undefined ? null : event.input) : event.args;
    if (!emit({ type: "task", toolCallId: event.toolCallId, toolName: event.toolName, args, partialResult })) {
      failClosed(processLike, "event-too-large");
    }
  });
}

export default function ompNativeCompat(pi) {
  return activateOmpNativeCompat(pi);
}
`;
}

function buildEvolutionExtension(input: {
  readonly expectedMarker: string;
  readonly promptPath: string;
  readonly systemPromptPath: string;
}): string {
  return `${extensionSharedSource(input.expectedMarker)}
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
const promptPath = ${JSON.stringify(input.promptPath)};
const systemPromptPath = ${JSON.stringify(input.systemPromptPath)};
const expectedSystemPrompt = ${JSON.stringify(SKILL_EVOLUTION_SYSTEM_PROMPT)};

export async function activateOmpNativeCompat(pi, processLike = globalThis.process) {
  requirePublicApi(pi, processLike);
  let systemPrompt;
  try {
    systemPrompt = await readFile(systemPromptPath, "utf8");
  } catch {
    failClosed(processLike, "system-prompt-mismatch");
  }
  if (systemPrompt !== expectedSystemPrompt) failClosed(processLike, "system-prompt-mismatch");

  let requestStarted = false;
  let submittedText;
  const decodeAuthorizedPrompt = (bytes) => {
    if (bytes.byteLength > ${OMP_NATIVE_COMPAT_MAX_PROMPT_BYTES} * 6 + 256) {
      failClosed(processLike, "authorized-prompt-unavailable");
    }
    let record;
    try {
      record = JSON.parse(bytes.toString("utf8"));
    } catch {
      failClosed(processLike, "authorized-prompt-unavailable");
    }
    if (!record || typeof record !== "object" || Array.isArray(record) ||
        record.version !== ${JSON.stringify(OMP_NATIVE_COMPAT_VERSION)} ||
        record.nonce !== nonceFromMarker(marker) || typeof record.text !== "string" ||
        Buffer.byteLength(record.text, "utf8") > ${OMP_NATIVE_COMPAT_MAX_PROMPT_BYTES}) {
      failClosed(processLike, "authorized-prompt-unavailable");
    }
    return record.text;
  };
  const readAuthorizedPrompt = async () => {
    let bytes;
    try { bytes = await readFile(promptPath); }
    catch { failClosed(processLike, "authorized-prompt-unavailable"); }
    return decodeAuthorizedPrompt(bytes);
  };
  const readAuthorizedPromptSync = () => {
    let bytes;
    try { bytes = readFileSync(promptPath); }
    catch { failClosed(processLike, "authorized-prompt-unavailable"); }
    return decodeAuthorizedPrompt(bytes);
  };
  const assertConstraints = (ctx, requireFinalPrompt = false) => {
    if (!isRootAcp(ctx) || typeof ctx.getSystemPrompt !== "function") {
      failClosed(processLike, "invalid-runtime-context");
    }
    let activeTools;
    let actualPrompt;
    try {
      activeTools = pi.getActiveTools();
      actualPrompt = ctx.getSystemPrompt();
    } catch {
      failClosed(processLike, "invalid-runtime-context");
    }
    if (!Array.isArray(activeTools) || activeTools.length !== 0) {
      failClosed(processLike, "active-tools-not-empty");
    }
    // OMP adds a native project block even with an explicit --system-prompt.
    // before_agent_start replaces all blocks; context must attest that the
    // replacement actually took effect before any provider request is sent.
    if (!Array.isArray(actualPrompt) || actualPrompt[0] !== systemPrompt ||
        (requireFinalPrompt && actualPrompt.length !== 1)) {
      failClosed(processLike, "system-prompt-mismatch");
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    assertConstraints(ctx);
    emit({ type: "ready", kind: "evolution" });
  });
  pi.on("session_switch", async (_event, ctx) => {
    assertConstraints(ctx);
  });
  pi.on("before_agent_start", async (event, ctx) => {
    assertConstraints(ctx);
    if (requestStarted) failClosed(processLike, "multiple-user-requests");
    const authorizedText = await readAuthorizedPrompt();
    // OMP's BeforeAgentStartEvent.prompt includes its native date/CWD reminder
    // in ACP. Keep it out of model-visible context; the sidecar is authoritative.
    if (typeof event?.prompt !== "string") failClosed(processLike, "submitted-prompt-mismatch");
    requestStarted = true;
    submittedText = authorizedText;
    return { systemPrompt: [systemPrompt] };
  });
  pi.on("context", async (_event, ctx) => {
    assertConstraints(ctx, true);
    if (!requestStarted || typeof submittedText !== "string") {
      failClosed(processLike, "authorized-prompt-unavailable");
    }
    const authorizedText = await readAuthorizedPrompt();
    if (authorizedText !== submittedText) failClosed(processLike, "prompt-changed");
    return {
      messages: [{ role: "user", content: authorizedText, timestamp: Date.now() }],
    };
  });
  pi.on("before_provider_request", (event, ctx) => {
    assertConstraints(ctx, true);
    if (!requestStarted || typeof submittedText !== "string" ||
        readAuthorizedPromptSync() !== submittedText) failClosed(processLike, "prompt-changed");
    // This final hook MUST stay synchronous: OMP continues with the original
    // payload when an async extension handler exceeds its timeout budget.
    // The SDK injects a date/CWD reminder after the context hook. Attest and
    // replace the final provider payload, preserving model/sampling settings.
    const payload = event?.payload;
    const reject = () => failClosed(processLike, "unsupported-provider-payload");
    if (!isRecord(payload) || (payload.tools !== undefined &&
        (!Array.isArray(payload.tools) || payload.tools.length !== 0))) reject();
    const text = (value) => {
      if (typeof value === "string") return value;
      if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0])) return undefined;
      const block = value[0];
      return (block.type === "text" || block.type === "input_text") && typeof block.text === "string"
        ? block.text : undefined;
    };
    const replaceMessages = (messages, externalSystem) => {
      if (!Array.isArray(messages) || messages.length !== (externalSystem ? 1 : 2)) reject();
      const user = messages[messages.length - 1];
      if (!isRecord(user) || user.role !== "user" || text(user.content) === undefined) reject();
      if (!externalSystem) {
        const system = messages[0];
        if (!isRecord(system) || !["system", "developer"].includes(system.role) ||
            text(system.content) !== systemPrompt) reject();
      }
      const content = typeof user.content === "string" ? submittedText :
        [{ ...user.content[0], text: submittedText }];
      return [...messages.slice(0, -1), { ...user, content }];
    };
    if (Array.isArray(payload.messages)) {
      if (payload.input !== undefined || payload.contents !== undefined || payload.instructions !== undefined) reject();
      const externalSystem = payload.system !== undefined;
      if (externalSystem && text(payload.system) !== systemPrompt) reject();
      return { ...payload, messages: replaceMessages(payload.messages, externalSystem) };
    }
    if (payload.input !== undefined) {
      if (payload.contents !== undefined || payload.system !== undefined) reject();
      const externalSystem = payload.instructions !== undefined;
      if (externalSystem && payload.instructions !== systemPrompt) reject();
      if (typeof payload.input === "string") {
        if (!externalSystem) reject();
        return { ...payload, input: submittedText };
      }
      return { ...payload, input: replaceMessages(payload.input, externalSystem) };
    }
    if (Array.isArray(payload.contents)) {
      if (payload.system !== undefined || payload.instructions !== undefined) reject();
      const system = payload.systemInstruction;
      const user = payload.contents[0];
      if (!isRecord(system) || !Array.isArray(system.parts) || system.parts.length !== 1 ||
          system.parts[0]?.text !== systemPrompt || payload.contents.length !== 1 ||
          !isRecord(user) || user.role !== "user" || !Array.isArray(user.parts) ||
          user.parts.length !== 1 || typeof user.parts[0]?.text !== "string") reject();
      return { ...payload, contents: [{ ...user, parts: [{ text: submittedText }] }] };
    }
    return reject();
  });
  pi.on("tool_call", async () => {
    emit({ type: "failure", reason: "unauthorized-tool-call" });
    processLike.exit(1);
    throw new Error("OMP native compatibility invariant failed: unauthorized-tool-call");
    return { block: true, reason: "Tools are disabled in this restricted learning session." };
  });
}

export default function ompNativeCompat(pi) {
  return activateOmpNativeCompat(pi);
}
`;
}

function extensionSharedSource(expectedMarker: string): string {
  return `const marker = ${JSON.stringify(expectedMarker)};
const MAX_EVENT_BYTES = ${OMP_NATIVE_COMPAT_MAX_EVENT_LINE_BYTES};
let bridgeProcess;
function isBoundedString(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isTaskPartialResult(value) {
  const asyncTask = value?.details?.async;
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    asyncTask?.type === "task" && isBoundedString(asyncTask.jobId, 512) && isBoundedString(asyncTask.state, 128);
}
function isRootAcp(ctx) {
  // OMP exposes ACP sessions as "rpc" in the public ExtensionContext.
  return ctx?.agent?.kind === "main" && ctx?.mode === "rpc";
}
function nonceFromMarker(value) {
  const match = /^SYNARA_OMP_NATIVE_COMPAT v1 nonce=([a-f0-9]{32})$/u.exec(value);
  if (!match) throw new Error("Invalid OMP native compatibility marker.");
  return match[1];
}
function emit(event) {
  let json;
  try { json = JSON.stringify(event); } catch { return false; }
  const line = marker + " " + json;
  if (Buffer.byteLength(line, "utf8") > MAX_EVENT_BYTES) return false;
  bridgeProcess.stderr.write(line + "\\n");
  return true;
}
function requirePublicApi(pi, processLike) {
  bridgeProcess = processLike;
  if (typeof pi?.on !== "function" || typeof pi?.getActiveTools !== "function") {
    failClosed(processLike, "missing-public-api");
  }
  nonceFromMarker(marker);
}
function failClosed(processLike, reason) {
  emit({ type: "failure", reason });
  processLike.exit(1);
  throw new Error("OMP native compatibility invariant failed: " + reason);
}
`;
}

function nonceFromMarker(marker: string): string {
  if (!isExpectedMarker(marker)) {
    throw new Error("OMP native compatibility marker is malformed.");
  }
  return marker.slice(`${OMP_NATIVE_COMPAT_MARKER_PREFIX} nonce=`.length);
}

function isExpectedMarker(marker: string): boolean {
  return new RegExp(
    `^${escapeRegExp(OMP_NATIVE_COMPAT_MARKER_PREFIX)} nonce=[a-f0-9]{32}$`,
    "u",
  ).test(marker);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isFailureReason(value: unknown): value is OmpNativeCompatFailureReason {
  return (
    value === "missing-public-api" ||
    value === "invalid-runtime-context" ||
    value === "active-tools-not-empty" ||
    value === "system-prompt-mismatch" ||
    value === "authorized-prompt-unavailable" ||
    value === "submitted-prompt-mismatch" ||
    value === "prompt-changed" ||
    value === "multiple-user-requests" ||
    value === "unauthorized-tool-call" ||
    value === "unsupported-provider-payload" ||
    value === "event-too-large"
  );
}

function isTaskPartialResult(value: Record<string, unknown>): boolean {
  const details = value.details;
  if (!isRecord(details)) return false;
  const asyncTask = details.async;
  if (!isRecord(asyncTask)) return false;
  return (
    asyncTask.type === "task" &&
    isBoundedString(asyncTask.jobId, 512) &&
    isBoundedString(asyncTask.state, 128)
  );
}
