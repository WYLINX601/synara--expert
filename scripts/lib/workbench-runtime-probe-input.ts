import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

import { CODEX_REASONING_EFFORT_OPTIONS, PI_THINKING_LEVEL_OPTIONS } from "@synara/contracts";
import { synaraDesktopIdentity } from "@synara/shared/desktopIdentity";
import { assertLoopbackUrl } from "../computer-use-fixtures/packaged-client.ts";

export type RuntimeProbeOptions = {
  sourceSha: string;
  ownerUrl: string;
  codexModel: string;
  codexReasoningEffort: (typeof CODEX_REASONING_EFFORT_OPTIONS)[number];
  piModel: string;
  piThinkingLevel: (typeof PI_THINKING_LEVEL_OPTIONS)[number];
  instanceHome: string;
  outputDir: string;
  codexHome: string;
  piAgentDir: string;
  awaitServerRestart: boolean;
};

export type ParsedRuntimeProbeOptions = Omit<RuntimeProbeOptions, "ownerUrl"> & {
  ownerBaseUrl: string;
};

function required(values: Record<string, string | boolean | undefined>, name: string): string {
  const value = values[name];
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`Missing required option: --${name}.`);
  return value;
}

function requiredChoice<const T extends readonly string[]>(
  values: Record<string, string | boolean | undefined>,
  name: string,
  choices: T,
): T[number] {
  const value = required(values, name);
  if (!choices.includes(value)) throw new Error(`Invalid --${name} value.`);
  return value as T[number];
}

function requiredModel(values: Record<string, string | boolean | undefined>, name: string): string {
  const value = required(values, name);
  if (value.length > 128 || /[\s\p{Cc}\p{Cf}]/u.test(value)) {
    throw new Error(`--${name} must be a compact model identifier with no whitespace or controls.`);
  }
  return value;
}

function validatePiModelReference(value: string): string {
  const separator = value.includes("/") ? "/" : value.includes(":") ? ":" : undefined;
  if (!separator) {
    throw new Error(
      "--pi-model must include an explicit provider/model or provider:model reference.",
    );
  }
  const separatorIndex = value.indexOf(separator);
  if (separatorIndex === 0 || separatorIndex === value.length - 1) {
    throw new Error("--pi-model must use a non-empty provider/model reference.");
  }
  return value;
}

function knownSynaraHomes(userHome: string): string[] {
  const flavors = [
    "production",
    "development",
    "canary",
    "cua",
    "workbench",
    "workbench-preview",
  ] as const;
  return [
    ...flavors.map((flavor) =>
      resolve(userHome, synaraDesktopIdentity(flavor).defaultHomeDirectoryName),
    ),
    resolve(userHome, ".synara-beta"),
  ];
}

export function protectedUserProfilePaths(userHome: string): string[] {
  return [
    ...knownSynaraHomes(userHome),
    resolve(userHome, ".codex"),
    resolve(userHome, ".pi", "agent"),
  ];
}

/** Strict parser intentionally has no token argument; credentials are env-only. */
export function parseRuntimeProbeOptions(argv: ReadonlyArray<string>): ParsedRuntimeProbeOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      "source-sha": { type: "string" },
      "owner-url": { type: "string" },
      "codex-model": { type: "string" },
      "codex-reasoning-effort": { type: "string" },
      "pi-model": { type: "string" },
      "pi-thinking-level": { type: "string" },
      "instance-home": { type: "string" },
      "output-dir": { type: "string" },
      "codex-home": { type: "string" },
      "pi-agent-dir": { type: "string" },
      "await-server-restart": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const sourceSha = required(values, "source-sha");
  if (!/^[0-9a-f]{40}$/iu.test(sourceSha))
    throw new Error("--source-sha must be a full 40-character commit SHA.");
  const ownerBaseUrl = required(values, "owner-url");
  const rawPaths = {
    instanceHome: required(values, "instance-home"),
    outputDir: required(values, "output-dir"),
    codexHome: required(values, "codex-home"),
    piAgentDir: required(values, "pi-agent-dir"),
  };
  if (Object.values(rawPaths).some((path) => !isAbsolute(path)))
    throw new Error("Instance, output, and provider isolation paths must be absolute.");
  const instanceHome = resolve(rawPaths.instanceHome);
  const outputDir = resolve(rawPaths.outputDir);
  const codexHome = resolve(rawPaths.codexHome);
  const piAgentDir = resolve(rawPaths.piAgentDir);
  if (codexHome === piAgentDir)
    throw new Error("Codex home and Pi agent directory must be separate paths.");
  if (typeof values["await-server-restart"] !== "boolean")
    throw new Error("Invalid --await-server-restart value.");
  return {
    sourceSha: sourceSha.toLowerCase(),
    ownerBaseUrl,
    codexModel: requiredModel(values, "codex-model"),
    codexReasoningEffort: requiredChoice(
      values,
      "codex-reasoning-effort",
      CODEX_REASONING_EFFORT_OPTIONS,
    ),
    piModel: validatePiModelReference(requiredModel(values, "pi-model")),
    piThinkingLevel: requiredChoice(values, "pi-thinking-level", PI_THINKING_LEVEL_OPTIONS),
    instanceHome,
    outputDir,
    codexHome,
    piAgentDir,
    awaitServerRestart: values["await-server-restart"],
  };
}

export type SafeTurnErrorEvidence = {
  readonly providerErrorCategory: "model-unsupported" | "provider-error" | "unknown";
  readonly originalMessageSha256: string | null;
  readonly providerHttpStatus: number | null;
};

type ActivityLike = {
  readonly kind: string;
  readonly payload: unknown;
  readonly turnId: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorEnvelopeDetails(value: unknown): {
  readonly message?: string;
  readonly status?: number;
} {
  const envelope = asRecord(value);
  if (!envelope) return {};
  const error = asRecord(envelope.error);
  const message =
    (typeof envelope.providerMessage === "string" && envelope.providerMessage) ||
    (typeof error?.message === "string" && error.message) ||
    (typeof envelope.message === "string" && envelope.message) ||
    undefined;
  const candidateStatus =
    typeof envelope.httpStatus === "number"
      ? envelope.httpStatus
      : typeof envelope.status === "number"
        ? envelope.status
        : typeof error?.status === "number"
          ? error.status
          : undefined;
  const status =
    candidateStatus !== undefined &&
    Number.isInteger(candidateStatus) &&
    candidateStatus >= 100 &&
    candidateStatus <= 599
      ? candidateStatus
      : undefined;
  return { ...(message ? { message } : {}), ...(status !== undefined ? { status } : {}) };
}

function safeErrorParts(messageValue: unknown): {
  readonly sourceText?: string;
  readonly providerMessage?: string;
  readonly status?: number;
} {
  let sourceText: string | undefined;
  let providerMessage: string | undefined;
  let status: number | undefined;
  const wrapper = asRecord(messageValue);
  if (typeof messageValue === "string") sourceText = messageValue;
  if (wrapper) {
    if (typeof wrapper.text === "string") sourceText = wrapper.text;
    const structured = errorEnvelopeDetails(wrapper.parsed);
    providerMessage = structured.message;
    status = structured.status;
  }
  if (sourceText) {
    try {
      const fromText = errorEnvelopeDetails(JSON.parse(sourceText) as unknown);
      providerMessage ??= fromText.message;
      status ??= fromText.status;
    } catch {
      // Plain provider error messages are still hashed and classified conservatively.
    }
  }
  if (!providerMessage && typeof messageValue === "string") providerMessage = messageValue;
  return {
    ...(sourceText ? { sourceText } : {}),
    ...(providerMessage ? { providerMessage } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

/** Reports a safe classification and digest for the matching turn's runtime error, never its body. */
export function safeTurnErrorEvidence(
  activities: ReadonlyArray<ActivityLike>,
  turnId: string,
): SafeTurnErrorEvidence {
  const activity = activities
    .toReversed()
    .find((candidate) => candidate.kind === "runtime.error" && candidate.turnId === turnId);
  const payload = activity ? asRecord(activity.payload) : undefined;
  const parts = safeErrorParts(payload?.message);
  const message = parts.providerMessage ?? parts.sourceText;
  const modelUnsupported =
    parts.status === 400 &&
    typeof message === "string" &&
    /(?:["'`][^"'`\s][^"'`]{0,127}["'`]\s+model\s+is\s+not\s+supported\b|\bmodel\s+["'`][^"'`\s][^"'`]{0,127}["'`]\s+is\s+not\s+supported\b)/iu.test(
      message,
    );
  const providerErrorCategory = !message
    ? "unknown"
    : modelUnsupported
      ? "model-unsupported"
      : "provider-error";
  const hashedText = parts.sourceText ?? parts.providerMessage;
  return {
    providerErrorCategory,
    originalMessageSha256: hashedText
      ? createHash("sha256").update(hashedText).digest("hex")
      : null,
    providerHttpStatus: parts.status ?? null,
  };
}

export function authenticatedOwnerUrl(rawBaseUrl: string, token: string | undefined): string {
  if (typeof token !== "string" || !/^[\x21-\x7e]+$/u.test(token))
    throw new Error("SYNARA_WORKBENCH_PROBE_OWNER_TOKEN must contain a printable token.");
  const url = assertLoopbackUrl(rawBaseUrl, "ws:");
  if (!url.port || url.search || url.hash || (url.pathname !== "" && url.pathname !== "/"))
    throw new Error("--owner-url must be a loopback ws URL with a port and no path or query.");
  url.pathname = "/";
  url.searchParams.set("token", token);
  return url.toString();
}

export function validateProbeInstanceHome(
  instanceHome: string,
  userHome: string,
  configuredHome?: string,
  protectedUserProfiles: ReadonlyArray<string> = [],
): void {
  const knownHomes = knownSynaraHomes(userHome);
  const actual = resolve(instanceHome);
  if (knownHomes.some((home) => contains(home, actual) || contains(actual, home)))
    throw new Error("Instance home must not use a current user Synara or Workbench profile.");
  if (configuredHome && (contains(configuredHome, actual) || contains(actual, configuredHome)))
    throw new Error("Instance home must not match the configured user Synara home.");
  if (protectedUserProfiles.some((home) => contains(home, actual) || contains(actual, home))) {
    throw new Error("Instance home overlaps a current user app or provider profile.");
  }
}

function contains(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

/** Lexical isolation checks run before any output or product state is created. */
export function validateProbePaths(input: {
  instanceHome: string;
  outputDir: string;
  codexHome: string;
  piAgentDir: string;
  repositoryRoot: string;
  userHome: string;
  protectedUserProfiles?: ReadonlyArray<string>;
}): void {
  const paths = [input.instanceHome, input.outputDir, input.codexHome, input.piAgentDir];
  if (paths.some((path) => !isAbsolute(path)))
    throw new Error("Instance, output, and provider isolation paths must be absolute.");
  const instanceHome = resolve(input.instanceHome);
  const outputDir = resolve(input.outputDir);
  const codexHome = resolve(input.codexHome);
  const piAgentDir = resolve(input.piAgentDir);
  if (contains(input.repositoryRoot, instanceHome))
    throw new Error("Instance home must be outside the source checkout.");
  if (contains(input.repositoryRoot, outputDir))
    throw new Error("Probe output must be outside the source checkout.");
  if (contains(input.repositoryRoot, codexHome) || contains(input.repositoryRoot, piAgentDir))
    throw new Error("Provider isolation paths must be outside the source checkout.");
  if (
    contains(outputDir, codexHome) ||
    contains(codexHome, outputDir) ||
    contains(outputDir, piAgentDir) ||
    contains(piAgentDir, outputDir) ||
    contains(codexHome, piAgentDir) ||
    contains(piAgentDir, codexHome) ||
    contains(instanceHome, outputDir) ||
    contains(outputDir, instanceHome) ||
    contains(instanceHome, codexHome) ||
    contains(codexHome, instanceHome) ||
    contains(instanceHome, piAgentDir) ||
    contains(piAgentDir, instanceHome)
  ) {
    throw new Error("Instance, probe output, and provider isolation paths must not overlap.");
  }
  const knownProviderHomes = [
    resolve(input.userHome, ".codex"),
    resolve(input.userHome, ".pi", "agent"),
  ];
  if (
    knownProviderHomes.some(
      (home) =>
        contains(home, codexHome) ||
        contains(codexHome, home) ||
        contains(home, piAgentDir) ||
        contains(piAgentDir, home),
    )
  ) {
    throw new Error("Provider isolation paths must not use the default user profile directories.");
  }
  if (
    [...knownProviderHomes, ...knownSynaraHomes(input.userHome)].some(
      (home) => contains(home, outputDir) || contains(outputDir, home),
    )
  ) {
    throw new Error("Probe output must not use a current user Synara or provider profile.");
  }
  if (
    input.protectedUserProfiles?.some((home) =>
      [instanceHome, outputDir, codexHome, piAgentDir].some(
        (path) => contains(home, path) || contains(path, home),
      ),
    )
  ) {
    throw new Error("Probe paths overlap a current user app or provider profile.");
  }
}
