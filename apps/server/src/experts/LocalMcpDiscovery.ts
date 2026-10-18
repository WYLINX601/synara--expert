import { createHash, randomUUID } from "node:crypto";
import { basename, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { Schema } from "effect";
import {
  McpDiscoveryRequestSchema,
  McpImportRequestSchema,
  type ExpertConnectionConfig,
  type ExpertConnectionTransport,
  type McpConfigSourceReference,
  type McpDiscoveryCandidate,
  type McpDiscoveryRequest,
  type McpDiscoveryResult,
  type McpDiscoverySource,
  type McpImportRequest,
  type McpImportResult,
} from "@synara/contracts";

import { ExpertConnectionStoreError, type ExpertConnectionStore } from "./ExpertConnectionStore.ts";
import {
  resolveExpertMcpCredentialValues,
  type ExpertMcpCredentialStore,
  type ExpertMcpCredentialValues,
} from "./ExpertMcpCredentials.ts";
import {
  McpSourceReadError,
  readMcpSourceEntries,
  readMcpSourceEntry,
  resolveMcpSourcePath,
  type McpSourceEntry,
  type ResolvedMcpSource,
} from "./McpConfigSource.ts";

const SCAN_TTL_MS = 10 * 60 * 1_000;
const MAX_CACHED_SCANS = 32;
const MAX_SCAN_SOURCES = 16;
const MAX_SCAN_CANDIDATES = 1_000;
const MAX_IMPORT_ITEMS = 1_000;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const METADATA_FIELDS = new Set([
  "description",
  "disabled",
  "enabled",
  "enabled_codex",
  "icon",
  "id",
  "name",
  "title",
]);
const STDIO_FIELDS = new Set([
  ...METADATA_FIELDS,
  "args",
  "command",
  "cwd",
  "env",
  "env_vars",
  "startup_timeout_sec",
  "tool_timeout_sec",
  "type",
]);
const HTTP_FIELDS = new Set([
  ...METADATA_FIELDS,
  "auth",
  "bearer_token_env_var",
  "env_http_headers",
  "headers",
  "http_headers",
  "oauth",
  "transport",
  "type",
  "url",
]);
const CREDENTIAL_ARGUMENT =
  /^--?(?:access[-_]?token|api[-_]?key|auth|authorization|bearer|client[-_]?secret|cookie|credential|password|passwd|secret|token)(?:$|=)/iu;

type DiscoverySourceStatus = McpDiscoveryResult["sources"][number];
type CandidateStatus = McpDiscoveryCandidate["status"];
type CandidateAnalysis = {
  readonly protocol: McpDiscoveryCandidate["protocol"];
  readonly summary: string;
  readonly name: string;
  readonly status: "ready" | "needs-config" | "unsupported";
  readonly issues: string[];
  readonly transport?: ExpertConnectionTransport;
};
type CachedCandidate = {
  candidate: McpDiscoveryCandidate;
  readonly sources: CachedSource[];
  readonly names: string[];
  readonly sourceEnabledValue?: boolean;
  sourceEnabledConsistent: boolean;
  readonly transport?: ExpertConnectionTransport;
  readonly identityFingerprint?: string;
};
type CachedSource = {
  readonly reference: McpConfigSourceReference;
  readonly digest: string;
};
type CachedScan = {
  readonly createdAt: number;
  readonly candidates: Map<string, CachedCandidate>;
};

export interface LocalMcpDiscovery {
  discover(request: McpDiscoveryRequest): Promise<McpDiscoveryResult>;
  importSelected(request: McpImportRequest): Promise<McpImportResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function safeDecode<T>(schema: Schema.Top, value: unknown, message: string): T {
  try {
    return Schema.decodeUnknownSync(schema as Schema.Decoder<T>)(value) as T;
  } catch {
    throw new Error(message);
  }
}

function publicName(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  if (cleaned.length === 0) return "MCP server";
  return cleaned.slice(0, 200);
}

function safeSourcePath(path: string): string {
  return path.length <= 4_096 ? path : "(path omitted)";
}

function slug(value: string): string {
  const result = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "_")
    .replace(/^[_-]+|[_-]+$/gu, "")
    .slice(0, 45);
  return result.length > 0 ? result : "server";
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  const record = value as Record<string, unknown>;
  return (
    "{" +
    Object.keys(record)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + stableJson(record[key]))
      .join(",") +
    "}"
  );
}

function invalidAnalysis(
  protocol: McpDiscoveryCandidate["protocol"],
  summary: string,
  name: string,
  status: "needs-config" | "unsupported",
  issue: string,
): CandidateAnalysis {
  return { protocol, summary, name, status, issues: [issue] };
}

function safeStdioSummary(command: string): string {
  const leaf = basename(command.replaceAll("\\", "/"));
  if (
    leaf.length === 0 ||
    leaf.length > 128 ||
    /(?:token|secret|password|credential|bearer|api[_-]?key)/iu.test(leaf)
  ) {
    return "stdio";
  }
  return leaf;
}

function safeHttpOrigin(rawUrl: string): { origin?: string; valid: boolean; importable: boolean } {
  try {
    const url = new URL(rawUrl);
    const valid = url.protocol === "http:" || url.protocol === "https:";
    return {
      ...(valid ? { origin: url.origin } : {}),
      valid,
      importable:
        valid &&
        url.username.length === 0 &&
        url.password.length === 0 &&
        url.search.length === 0 &&
        url.hash.length === 0,
    };
  } catch {
    return { valid: false, importable: false };
  }
}

type JsonPlaceholderClassification =
  | { readonly kind: "literal" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "host-reference"; readonly envVar: string; readonly prefix?: string };

function classifyJsonPlaceholder(
  value: string,
  sourceKind: McpDiscoveryCandidate["sourceKind"],
  allowPrefix = false,
): JsonPlaceholderClassification {
  // Codex and other source adapters keep their existing literal-value semantics. This parser is
  // deliberately limited to imported JSON configs, whose `${env:...}` references are explicit.
  if (sourceKind !== "json") return { kind: "literal" };

  const match = allowPrefix
    ? /^(.*)\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(value)
    : /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(value);
  if (match) {
    const prefix = allowPrefix ? match[1]! : "";
    const envVar = allowPrefix ? match[2]! : match[1]!;
    if (
      prefix.length === 0 ||
      (allowPrefix && prefix.length <= 64 && /^[A-Za-z][A-Za-z0-9._~-]* ?$/u.test(prefix))
    ) {
      return {
        kind: "host-reference",
        envVar,
        ...(prefix.length === 0 ? {} : { prefix }),
      };
    }
  }

  // Fail closed for unsupported, repeated, suffixed, or malformed interpolation. In particular,
  // none of these strings may fall through to the secret store as a literal credential.
  if (value.includes("${")) return { kind: "unsupported" };
  return { kind: "literal" };
}

function unknownExecutionField(
  config: Record<string, unknown>,
  knownFields: ReadonlySet<string>,
): boolean {
  return Object.keys(config).some((field) => !knownFields.has(field));
}

function validEnvironmentName(value: string): boolean {
  return value.length <= 128 && ENVIRONMENT_NAME.test(value);
}

function validHeaderName(value: string): boolean {
  return value.length <= 256 && HEADER_NAME.test(value);
}

function toTimeoutMs(config: Record<string, unknown>, field: string): number | undefined {
  if (!hasOwn(config, field)) return undefined;
  const seconds = config[field];
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0 || seconds > 300) {
    return -1;
  }
  const milliseconds = Math.round(seconds * 1_000);
  return milliseconds > 0 ? milliseconds : -1;
}

function analyzeStdio(
  source: ResolvedMcpSource,
  entry: McpSourceEntry,
  config: Record<string, unknown>,
  name: string,
): CandidateAnalysis {
  const summaryCommand = typeof config.command === "string" ? config.command : "";
  const summary = safeStdioSummary(summaryCommand);
  if (unknownExecutionField(config, STDIO_FIELDS)) {
    return invalidAnalysis(
      "stdio",
      summary,
      name,
      "needs-config",
      "Contains settings that require manual review.",
    );
  }
  if (config.type !== undefined && config.type !== "stdio") {
    return invalidAnalysis(
      "stdio",
      summary,
      name,
      "unsupported",
      "Transport type is not supported.",
    );
  }
  if (
    typeof config.command !== "string" ||
    config.command.trim().length === 0 ||
    config.command.includes("\0") ||
    config.command.length > 4_096
  ) {
    return invalidAnalysis(
      "stdio",
      summary,
      name,
      "needs-config",
      "Command configuration needs manual review.",
    );
  }

  const argsValue = config.args ?? [];
  if (
    !Array.isArray(argsValue) ||
    argsValue.length > 256 ||
    argsValue.some((arg) => typeof arg !== "string" || arg.length > 8_192 || arg.includes("\0"))
  ) {
    return invalidAnalysis(
      "stdio",
      summary,
      name,
      "needs-config",
      "Argument configuration needs manual review.",
    );
  }
  const args = argsValue as string[];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (
      CREDENTIAL_ARGUMENT.test(argument) ||
      /(?:^|[\s=])(?:Bearer\s+|(?:api[_-]?key|access[_-]?token|password|secret|token)=)/iu.test(
        argument,
      ) ||
      (CREDENTIAL_ARGUMENT.test(args[index - 1] ?? "") && argument.length > 0)
    ) {
      return invalidAnalysis(
        "stdio",
        summary,
        name,
        "needs-config",
        "Credential arguments need manual review.",
      );
    }
  }

  if (
    config.cwd !== undefined &&
    (typeof config.cwd !== "string" ||
      config.cwd.trim().length === 0 ||
      config.cwd.length > 4_096 ||
      config.cwd.includes("\0"))
  ) {
    return invalidAnalysis(
      "stdio",
      summary,
      name,
      "needs-config",
      "Working directory needs manual review.",
    );
  }

  const startupTimeoutMs = toTimeoutMs(config, "startup_timeout_sec");
  const toolTimeoutMs = toTimeoutMs(config, "tool_timeout_sec");
  if (startupTimeoutMs === -1 || toolTimeoutMs === -1) {
    return invalidAnalysis(
      "stdio",
      summary,
      name,
      "needs-config",
      "Timeout settings need manual review.",
    );
  }

  const envFromHost: Array<{ name: string; envVar: string }> = [];
  const envFromSourceNames: string[] = [];
  const envNames = new Set<string>();
  if (hasOwn(config, "env")) {
    if (!isRecord(config.env)) {
      return invalidAnalysis(
        "stdio",
        summary,
        name,
        "needs-config",
        "Environment settings need manual review.",
      );
    }
    for (const [envName, rawValue] of Object.entries(config.env)) {
      if (
        !validEnvironmentName(envName) ||
        typeof rawValue !== "string" ||
        rawValue.includes("\0")
      ) {
        return invalidAnalysis(
          "stdio",
          summary,
          name,
          "needs-config",
          "Environment settings need manual review.",
        );
      }
      const placeholder = classifyJsonPlaceholder(rawValue, source.kind);
      if (placeholder.kind === "host-reference") {
        if (!validEnvironmentName(placeholder.envVar)) {
          return invalidAnalysis(
            "stdio",
            summary,
            name,
            "needs-config",
            "Environment settings need manual review.",
          );
        }
        envFromHost.push({ name: envName, envVar: placeholder.envVar });
      } else if (placeholder.kind === "unsupported") {
        return invalidAnalysis(
          "stdio",
          summary,
          name,
          "needs-config",
          "Environment placeholders need manual review.",
        );
      } else {
        envFromSourceNames.push(envName);
      }
      envNames.add(envName);
    }
  }

  if (source.kind === "codex" && hasOwn(config, "env_vars")) {
    if (
      !Array.isArray(config.env_vars) ||
      config.env_vars.some((name) => typeof name !== "string" || !validEnvironmentName(name))
    ) {
      return invalidAnalysis(
        "stdio",
        summary,
        name,
        "needs-config",
        "Environment references need manual review.",
      );
    }
    for (const envName of config.env_vars as string[]) {
      if (envNames.has(envName)) {
        return invalidAnalysis(
          "stdio",
          summary,
          name,
          "needs-config",
          "Environment settings use the same name twice.",
        );
      }
      envNames.add(envName);
      envFromHost.push({ name: envName, envVar: envName });
    }
  } else if (hasOwn(config, "env_vars")) {
    return invalidAnalysis(
      "stdio",
      summary,
      name,
      "needs-config",
      "Environment references need manual review.",
    );
  }

  const transport: ExpertConnectionTransport = {
    type: "stdio",
    command: config.command,
    args,
    envFromHost,
    ...(config.cwd === undefined ? {} : { cwd: config.cwd as string }),
    ...(startupTimeoutMs === undefined ? {} : { startupTimeoutMs }),
    ...(toolTimeoutMs === undefined ? {} : { toolTimeoutMs }),
    ...(envFromSourceNames.length === 0
      ? {}
      : {
          envFromSource: {
            source: { kind: source.kind, path: source.path, entryId: entry.entryId },
            names: envFromSourceNames,
          },
        }),
  };
  return { protocol: "stdio", summary, name, status: "ready", issues: [], transport };
}

function analyzeHttp(
  source: ResolvedMcpSource,
  entry: McpSourceEntry,
  config: Record<string, unknown>,
  name: string,
): CandidateAnalysis {
  const rawUrl = typeof config.url === "string" ? config.url : "";
  const parsedUrl = safeHttpOrigin(rawUrl);
  const summary = parsedUrl.origin ?? "HTTP";
  if (hasOwn(config, "oauth") || hasOwn(config, "auth")) {
    return invalidAnalysis(
      "http",
      summary,
      name,
      "unsupported",
      "Authentication flow is not supported.",
    );
  }
  if (
    source.kind !== "codex" &&
    (hasOwn(config, "env_http_headers") || hasOwn(config, "bearer_token_env_var"))
  ) {
    return invalidAnalysis(
      "http",
      summary,
      name,
      "needs-config",
      "Header references need manual review.",
    );
  }
  const hasHeaders = hasOwn(config, "headers");
  const hasCodexHeaders = hasOwn(config, "http_headers");
  if (hasHeaders && hasCodexHeaders) {
    return invalidAnalysis(
      "http",
      summary,
      name,
      "needs-config",
      "Header settings are ambiguous and need manual review.",
    );
  }
  if ((source.kind === "codex" && hasHeaders) || (source.kind !== "codex" && hasCodexHeaders)) {
    return invalidAnalysis(
      "http",
      summary,
      name,
      "needs-config",
      "Header settings use an unsupported source field.",
    );
  }
  const literalHeaders = source.kind === "codex" ? config.http_headers : config.headers;
  const hasLiteralHeaders = source.kind === "codex" ? hasCodexHeaders : hasHeaders;

  if (unknownExecutionField(config, HTTP_FIELDS)) {
    return invalidAnalysis(
      "http",
      summary,
      name,
      "needs-config",
      "Contains settings that require manual review.",
    );
  }
  if (config.type !== undefined && config.type !== "http" && config.type !== "streamable-http") {
    return invalidAnalysis(
      "http",
      summary,
      name,
      "unsupported",
      "HTTP transport type is not supported.",
    );
  }
  if (config.transport !== undefined && config.transport !== "streamable-http") {
    return invalidAnalysis(
      "http",
      summary,
      name,
      "unsupported",
      "HTTP transport type is not supported.",
    );
  }
  if (!parsedUrl.valid || rawUrl.length === 0) {
    return invalidAnalysis(
      "http",
      summary,
      name,
      "needs-config",
      "URL configuration needs manual review.",
    );
  }
  if (!parsedUrl.importable) {
    return invalidAnalysis(
      "http",
      summary,
      name,
      "needs-config",
      "URL credentials or query settings need manual review.",
    );
  }

  const headersFromHost: Array<{ name: string; envVar: string; prefix?: string }> = [];
  const headersFromSourceNames: string[] = [];
  const headerNames = new Set<string>();
  const addHeaderName = (headerName: string): boolean => {
    const key = headerName.toLowerCase();
    if (!validHeaderName(headerName) || headerNames.has(key)) return false;
    headerNames.add(key);
    return true;
  };

  if (hasLiteralHeaders) {
    if (!isRecord(literalHeaders)) {
      return invalidAnalysis(
        "http",
        summary,
        name,
        "needs-config",
        "Header settings need manual review.",
      );
    }
    for (const [headerName, rawValue] of Object.entries(literalHeaders)) {
      if (
        !addHeaderName(headerName) ||
        typeof rawValue !== "string" ||
        rawValue.includes("\0") ||
        /[\r\n]/u.test(rawValue)
      ) {
        return invalidAnalysis(
          "http",
          summary,
          name,
          "needs-config",
          "Header settings need manual review.",
        );
      }
      const placeholder = classifyJsonPlaceholder(rawValue, source.kind, true);
      if (placeholder.kind === "host-reference") {
        if (!validEnvironmentName(placeholder.envVar)) {
          return invalidAnalysis(
            "http",
            summary,
            name,
            "needs-config",
            "Header placeholders need manual review.",
          );
        }
        headersFromHost.push({
          name: headerName,
          envVar: placeholder.envVar,
          ...(placeholder.prefix === undefined ? {} : { prefix: placeholder.prefix }),
        });
      } else if (placeholder.kind === "unsupported") {
        return invalidAnalysis(
          "http",
          summary,
          name,
          "needs-config",
          "Header placeholders need manual review.",
        );
      } else {
        headersFromSourceNames.push(headerName);
      }
    }
  }

  if (hasOwn(config, "env_http_headers")) {
    if (!isRecord(config.env_http_headers)) {
      return invalidAnalysis(
        "http",
        summary,
        name,
        "needs-config",
        "Header references need manual review.",
      );
    }
    for (const [headerName, rawEnvName] of Object.entries(config.env_http_headers)) {
      if (
        !addHeaderName(headerName) ||
        typeof rawEnvName !== "string" ||
        !validEnvironmentName(rawEnvName)
      ) {
        return invalidAnalysis(
          "http",
          summary,
          name,
          "needs-config",
          "Header references need manual review.",
        );
      }
      headersFromHost.push({ name: headerName, envVar: rawEnvName });
    }
  }

  if (hasOwn(config, "bearer_token_env_var")) {
    const rawEnvName = config.bearer_token_env_var;
    if (
      !addHeaderName("Authorization") ||
      typeof rawEnvName !== "string" ||
      !validEnvironmentName(rawEnvName)
    ) {
      return invalidAnalysis(
        "http",
        summary,
        name,
        "needs-config",
        "Bearer token references need manual review.",
      );
    }
    headersFromHost.push({ name: "Authorization", envVar: rawEnvName, prefix: "Bearer " });
  }

  const transport: ExpertConnectionTransport = {
    type: "http",
    url: rawUrl,
    headersFromHost,
    ...(headersFromSourceNames.length === 0
      ? {}
      : {
          headersFromSource: {
            source: { kind: source.kind, path: source.path, entryId: entry.entryId },
            names: headersFromSourceNames,
          },
        }),
  };
  return { protocol: "http", summary, name, status: "ready", issues: [], transport };
}

function analyzeEntry(source: ResolvedMcpSource, entry: McpSourceEntry): CandidateAnalysis {
  const name = publicName(entry.name);
  if (entry.malformed || !isRecord(entry.config)) {
    return invalidAnalysis(
      "unknown",
      "Unsupported MCP config",
      name,
      "needs-config",
      "Configuration needs manual review.",
    );
  }

  const config = entry.config;
  const hasCommand = hasOwn(config, "command");
  const hasUrl = hasOwn(config, "url");
  if (hasCommand && hasUrl) {
    return invalidAnalysis(
      "unknown",
      "Unsupported MCP config",
      name,
      "needs-config",
      "Transport settings need manual review.",
    );
  }

  const declaredType = config.type;
  if (declaredType === "sse" || declaredType === "websocket" || declaredType === "ws") {
    return invalidAnalysis(
      "unknown",
      "Unsupported MCP config",
      name,
      "unsupported",
      "Transport type is not supported.",
    );
  }
  if (
    declaredType !== undefined &&
    declaredType !== "stdio" &&
    declaredType !== "http" &&
    declaredType !== "streamable-http"
  ) {
    return invalidAnalysis(
      "unknown",
      "Unsupported MCP config",
      name,
      "unsupported",
      "Transport type is not supported.",
    );
  }

  if (hasCommand || declaredType === "stdio") {
    return analyzeStdio(source, entry, config, name);
  }
  if (hasUrl || declaredType === "http" || declaredType === "streamable-http") {
    return analyzeHttp(source, entry, config, name);
  }
  return invalidAnalysis(
    "unknown",
    "Unsupported MCP config",
    name,
    "unsupported",
    "Transport type is not supported.",
  );
}

function safeStatusPath(source: McpDiscoverySource, homeDir: string): string {
  try {
    return safeSourcePath(resolveMcpSourcePath(source, homeDir).path);
  } catch {
    return source.path ?? "(not specified)";
  }
}

function sourceFailureStatus(
  source: McpDiscoverySource,
  homeDir: string,
  code: McpSourceReadError["code"] | "invalid-request",
): DiscoverySourceStatus {
  const messages: Record<typeof code, string> = {
    missing: "Source file is not available.",
    invalid: "Source format or size is not supported.",
    unavailable: "Source could not be read.",
    "invalid-request": "Choose an absolute source path.",
  };
  return {
    kind: source.kind,
    path: safeStatusPath(source, homeDir),
    status: code === "missing" ? "missing" : "error",
    message: messages[code],
  };
}

function sourceStatus(source: ResolvedMcpSource): DiscoverySourceStatus {
  return { kind: source.kind, path: safeSourcePath(source.path), status: "ready" };
}

function suggestedId(name: string, source: ResolvedMcpSource, entryId: string): string {
  const digest = createHash("sha256")
    .update(source.kind + "\0" + source.path + "\0" + entryId, "utf8")
    .digest("hex")
    .slice(0, 8);
  return "mcp_" + slug(name) + "_" + digest;
}

function sourceReference(
  source: ResolvedMcpSource,
  entry: McpSourceEntry,
): McpConfigSourceReference {
  return { kind: source.kind, path: source.path, entryId: entry.entryId };
}

function effectiveIdentityFingerprint(
  transport: ExpertConnectionTransport,
  values: ExpertMcpCredentialValues,
): string {
  const identity =
    transport.type === "stdio"
      ? {
          type: transport.type,
          command: transport.command,
          args: transport.args,
          ...(transport.cwd === undefined ? {} : { cwd: transport.cwd }),
          ...(transport.startupTimeoutMs === undefined
            ? {}
            : { startupTimeoutMs: transport.startupTimeoutMs }),
          ...(transport.toolTimeoutMs === undefined
            ? {}
            : { toolTimeoutMs: transport.toolTimeoutMs }),
          env: values.env,
        }
      : {
          type: transport.type,
          url: transport.url,
          headers: Object.fromEntries(
            Object.entries(values.headers).map(([name, value]) => [name.toLowerCase(), value]),
          ),
        };
  return createHash("sha256").update(stableJson(identity), "utf8").digest("hex");
}

function hasExternalCredentialReferences(transport: ExpertConnectionTransport): boolean {
  return transport.type === "stdio"
    ? transport.envFromHost.length > 0 || transport.envFromSource !== undefined
    : transport.headersFromHost.length > 0 || transport.headersFromSource !== undefined;
}

async function connectionIdentityIndex(
  connections: ReadonlyArray<ExpertConnectionConfig>,
  credentials: ExpertMcpCredentialStore,
): Promise<Map<string, ExpertConnectionConfig[]>> {
  const result = new Map<string, ExpertConnectionConfig[]>();
  for (const connection of connections) {
    try {
      const values = await resolveExpertMcpCredentialValues(connection.transport, credentials);
      const fingerprint = effectiveIdentityFingerprint(connection.transport, values);
      const matching = result.get(fingerprint) ?? [];
      matching.push(connection);
      result.set(fingerprint, matching);
    } catch {
      // An existing connection with unavailable references cannot be proven equivalent.
    }
  }
  return result;
}

function materializedTransport(
  transport: ExpertConnectionTransport,
  values: ExpertMcpCredentialValues,
  credentialId?: string,
): ExpertConnectionTransport {
  if (transport.type === "stdio") {
    const names = Object.keys(values.env).sort();
    return {
      type: "stdio",
      command: transport.command,
      args: [...transport.args],
      envFromHost: [],
      ...(transport.cwd === undefined ? {} : { cwd: transport.cwd }),
      ...(transport.startupTimeoutMs === undefined
        ? {}
        : { startupTimeoutMs: transport.startupTimeoutMs }),
      ...(transport.toolTimeoutMs === undefined ? {} : { toolTimeoutMs: transport.toolTimeoutMs }),
      ...(credentialId && names.length > 0 ? { envFromSecret: { credentialId, names } } : {}),
    };
  }
  const names = Object.keys(values.headers).sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase()),
  );
  return {
    type: "http",
    url: transport.url,
    headersFromHost: [],
    ...(credentialId && names.length > 0 ? { headersFromSecret: { credentialId, names } } : {}),
  };
}

async function revalidateCandidate(input: {
  readonly cached: CachedCandidate;
  readonly credentials: ExpertMcpCredentialStore;
}): Promise<
  | {
      readonly ok: true;
      readonly analysis: CandidateAnalysis;
      readonly values: ExpertMcpCredentialValues;
    }
  | { readonly ok: false; readonly message: string }
> {
  if (!input.cached.transport || !input.cached.identityFingerprint) {
    return { ok: false, message: "Source entry needs manual configuration." };
  }

  let firstAnalysis: CandidateAnalysis | undefined;
  let firstValues: ExpertMcpCredentialValues | undefined;
  for (const cachedSource of input.cached.sources) {
    let entry: McpSourceEntry;
    try {
      entry = await readMcpSourceEntry(cachedSource.reference);
    } catch {
      return {
        ok: false,
        message: "Source entry is no longer available; scan again before importing.",
      };
    }
    if (entry.digest !== cachedSource.digest) {
      return { ok: false, message: "Source entry changed after discovery." };
    }

    const analysis = analyzeEntry(
      { kind: cachedSource.reference.kind, path: cachedSource.reference.path },
      entry,
    );
    if (analysis.status !== "ready" || !analysis.transport) {
      return { ok: false, message: "Source entry needs manual configuration." };
    }
    let values: ExpertMcpCredentialValues;
    try {
      values = await resolveExpertMcpCredentialValues(analysis.transport);
    } catch {
      return {
        ok: false,
        message: "Credential values changed or are unavailable; scan again before importing.",
      };
    }
    if (
      effectiveIdentityFingerprint(analysis.transport, values) !== input.cached.identityFingerprint
    ) {
      return { ok: false, message: "Credential values changed after discovery." };
    }
    firstAnalysis ??= analysis;
    firstValues ??= values;
  }

  if (!firstAnalysis || !firstValues) {
    return { ok: false, message: "Source entry needs manual configuration." };
  }
  return { ok: true, analysis: firstAnalysis, values: firstValues };
}

async function readStateIfPresent(
  connections: ExpertConnectionStore,
  id: string,
): Promise<Awaited<ReturnType<ExpertConnectionStore["readState"]>> | null> {
  try {
    return await connections.readState(id);
  } catch (error) {
    if (error instanceof ExpertConnectionStoreError && error.code === "not_found") return null;
    throw error;
  }
}

function isExpired(scan: CachedScan, now: number): boolean {
  return now - scan.createdAt > SCAN_TTL_MS;
}

function pruneScans(scans: Map<string, CachedScan>, now: number): void {
  for (const [id, scan] of scans) {
    if (isExpired(scan, now)) scans.delete(id);
  }
  while (scans.size >= MAX_CACHED_SCANS) {
    const oldestId = scans.keys().next().value as string | undefined;
    if (oldestId === undefined) break;
    scans.delete(oldestId);
  }
}

function itemFailure(
  candidateId: string,
  targetId: string,
  message: string,
): McpImportResult["items"][number] {
  return { candidateId, targetId, status: "failed", message };
}

export function createLocalMcpDiscovery(input: {
  readonly connections: ExpertConnectionStore;
  readonly credentials: ExpertMcpCredentialStore;
  readonly homeDir?: string;
}): LocalMcpDiscovery {
  const homeDir = input.homeDir ?? homedir();
  if (!isAbsolute(homeDir)) throw new Error("MCP discovery home directory must be absolute.");
  const scans = new Map<string, CachedScan>();

  const discover = async (rawRequest: McpDiscoveryRequest): Promise<McpDiscoveryResult> => {
    const request = safeDecode<McpDiscoveryRequest>(
      McpDiscoveryRequestSchema,
      rawRequest,
      "MCP discovery request is invalid.",
    );
    const sources = request.sources ?? [{ kind: "codex" }, { kind: "cc-switch" }];
    if (sources.length > MAX_SCAN_SOURCES) throw new Error("MCP discovery request is too large.");

    const connections = await input.connections.list();
    const candidates: McpDiscoveryCandidate[] = [];
    const cacheCandidates = new Map<string, CachedCandidate>();
    const groups: CachedCandidate[] = [];
    const groupsByIdentity = new Map<string, CachedCandidate>();
    const statuses: DiscoverySourceStatus[] = [];
    const now = Date.now();
    let scannedEntries = 0;

    for (const requestedSource of sources) {
      if (scannedEntries >= MAX_SCAN_CANDIDATES) {
        statuses.push(sourceFailureStatus(requestedSource, homeDir, "invalid"));
        continue;
      }

      let source: ResolvedMcpSource;
      try {
        source = resolveMcpSourcePath(requestedSource, homeDir);
      } catch {
        statuses.push(sourceFailureStatus(requestedSource, homeDir, "invalid-request"));
        continue;
      }

      try {
        const entries = await readMcpSourceEntries(source);
        const remaining = MAX_SCAN_CANDIDATES - scannedEntries;
        const truncated = entries.length > remaining;
        statuses.push(
          truncated
            ? {
                ...sourceStatus(source),
                status: "error",
                message: "Candidate limit reached; source results were truncated.",
              }
            : sourceStatus(source),
        );
        for (const entry of entries.slice(0, remaining)) {
          if (scannedEntries >= MAX_SCAN_CANDIDATES) break;
          scannedEntries += 1;
          const analysis = analyzeEntry(source, entry);
          const id = suggestedId(analysis.name, source, entry.entryId);
          let status: CandidateStatus = analysis.status;
          let issues = analysis.issues;
          let identityFingerprint: string | undefined;
          if (analysis.status === "ready" && analysis.transport) {
            try {
              const values = await resolveExpertMcpCredentialValues(analysis.transport);
              identityFingerprint = effectiveIdentityFingerprint(analysis.transport, values);
            } catch {
              status = "needs-config";
              issues = ["Environment or header values could not be resolved."];
            }
          }

          const reference = sourceReference(source, entry);
          const matchingGroup = identityFingerprint
            ? groupsByIdentity.get(identityFingerprint)
            : undefined;
          if (matchingGroup) {
            matchingGroup.sources.push({ reference, digest: entry.digest });
            matchingGroup.names.push(analysis.name);
            if (matchingGroup.sourceEnabledValue !== entry.sourceEnabled) {
              matchingGroup.sourceEnabledConsistent = false;
            }
            if (!matchingGroup.sourceEnabledConsistent) {
              const { sourceEnabled, ...candidateWithoutSourceEnabled } = matchingGroup.candidate;
              void sourceEnabled;
              matchingGroup.candidate = {
                ...candidateWithoutSourceEnabled,
                sources: [...(matchingGroup.candidate.sources ?? []), reference],
              };
            } else {
              matchingGroup.candidate = {
                ...matchingGroup.candidate,
                sources: [...(matchingGroup.candidate.sources ?? []), reference],
              };
            }
            continue;
          }

          const candidateId = randomUUID();
          const candidate: McpDiscoveryCandidate = {
            candidateId,
            sourceKind: source.kind,
            sourcePath: safeSourcePath(source.path),
            sourceEntryId: entry.entryId,
            sources: [reference],
            suggestedId: id,
            name: analysis.name,
            protocol: analysis.protocol,
            summary: analysis.summary,
            ...(entry.sourceEnabled === undefined ? {} : { sourceEnabled: entry.sourceEnabled }),
            status,
            issues,
          };
          const cached: CachedCandidate = {
            candidate,
            sources: [{ reference, digest: entry.digest }],
            names: [analysis.name],
            ...(entry.sourceEnabled === undefined
              ? {}
              : { sourceEnabledValue: entry.sourceEnabled }),
            sourceEnabledConsistent: true,
            ...(identityFingerprint === undefined ? {} : { identityFingerprint }),
            ...(status === "ready" && analysis.transport ? { transport: analysis.transport } : {}),
          };
          groups.push(cached);
          if (identityFingerprint !== undefined) {
            groupsByIdentity.set(identityFingerprint, cached);
          }
        }
      } catch (error) {
        if (!(error instanceof McpSourceReadError)) throw new Error("MCP discovery failed.");
        statuses.push(sourceFailureStatus(requestedSource, homeDir, error.code));
      }
    }

    const existingByIdentity = await connectionIdentityIndex(connections, input.credentials);
    for (const cached of groups) {
      const base = cached.candidate;
      if (cached.identityFingerprint && cached.transport) {
        const equivalent = existingByIdentity.get(cached.identityFingerprint) ?? [];
        const independent = equivalent.find(
          (existing) => !hasExternalCredentialReferences(existing.transport),
        );
        const existing = independent ?? equivalent[0];
        let status: CandidateStatus = base.status;
        let existingId: string | undefined;
        let existingRevision: number | undefined;
        if (existing) {
          status = independent ? "exists" : "conflict";
          existingId = existing.id;
          existingRevision = existing.revision;
        } else {
          const bySuggestedId = connections.find(
            (connection) =>
              connection.id === base.suggestedId || connection.id === base.sourceEntryId,
          );
          const byName = connections.find((connection) => cached.names.includes(connection.name));
          if (bySuggestedId || byName) {
            status = "conflict";
            const collision = bySuggestedId ?? byName!;
            existingId = collision.id;
            existingRevision = collision.revision;
          } else {
            const tombstone = await readStateIfPresent(input.connections, base.suggestedId);
            if (tombstone?.status === "retired") {
              status = "conflict";
              existingId = base.suggestedId;
              existingRevision = tombstone.revision;
            }
          }
        }
        cached.candidate = {
          ...base,
          status,
          ...(status === "conflict"
            ? { issues: ["An existing connection needs review before import."] }
            : {}),
          ...(existingId === undefined ? {} : { existingId }),
          ...(existingRevision === undefined ? {} : { existingRevision }),
        };
      }
      candidates.push(cached.candidate);
      cacheCandidates.set(cached.candidate.candidateId, cached);
    }

    const scanId = randomUUID();
    pruneScans(scans, now);
    scans.set(scanId, { createdAt: now, candidates: cacheCandidates });
    return { scanId, sources: statuses, candidates };
  };

  const importSelected = async (rawRequest: McpImportRequest): Promise<McpImportResult> => {
    const request = safeDecode<McpImportRequest>(
      McpImportRequestSchema,
      rawRequest,
      "MCP import request is invalid.",
    );
    if (request.items.length > MAX_IMPORT_ITEMS) {
      throw new Error("MCP import request is too large.");
    }

    const scan = scans.get(request.scanId);
    const now = Date.now();
    if (!scan || isExpired(scan, now)) {
      if (scan) scans.delete(request.scanId);
      return {
        scanId: request.scanId,
        items: request.items.map((item) =>
          itemFailure(
            item.candidateId,
            item.targetId,
            "Discovery results expired. Scan again before importing.",
          ),
        ),
      };
    }

    const targetCounts = new Map<string, number>();
    const candidateCounts = new Map<string, number>();
    for (const item of request.items) {
      targetCounts.set(item.targetId, (targetCounts.get(item.targetId) ?? 0) + 1);
      candidateCounts.set(item.candidateId, (candidateCounts.get(item.candidateId) ?? 0) + 1);
    }

    const results: Array<McpImportResult["items"][number]> = [];
    for (const item of request.items) {
      if (
        (targetCounts.get(item.targetId) ?? 0) > 1 ||
        (candidateCounts.get(item.candidateId) ?? 0) > 1
      ) {
        results.push(itemFailure(item.candidateId, item.targetId, "Duplicate import selection."));
        continue;
      }

      const cached = scan.candidates.get(item.candidateId);
      if (!cached) {
        results.push(
          itemFailure(item.candidateId, item.targetId, "Discovery candidate is unavailable."),
        );
        continue;
      }

      if (item.mode === "update" && item.expectedRevision === undefined) {
        results.push(
          itemFailure(
            item.candidateId,
            item.targetId,
            "Updating a connection requires its current revision.",
          ),
        );
        continue;
      }
      if (item.mode === "create" && item.expectedRevision !== undefined) {
        results.push(
          itemFailure(
            item.candidateId,
            item.targetId,
            "Create requests cannot include an expected revision.",
          ),
        );
        continue;
      }

      try {
        const revalidated = await revalidateCandidate({
          cached,
          credentials: input.credentials,
        });
        if (!revalidated.ok) {
          results.push(itemFailure(item.candidateId, item.targetId, revalidated.message));
          continue;
        }
        const { analysis, values } = revalidated;
        if (!analysis.transport) {
          results.push(
            itemFailure(
              item.candidateId,
              item.targetId,
              "Source entry needs manual configuration.",
            ),
          );
          continue;
        }

        const current = await input.connections.read(item.targetId);
        if (item.mode === "create" && current) {
          results.push(
            itemFailure(item.candidateId, item.targetId, "Connection ID is already in use."),
          );
          continue;
        }
        if (item.mode === "update" && !current) {
          results.push(
            itemFailure(item.candidateId, item.targetId, "Connection to update was not found."),
          );
          continue;
        }
        const currentState = await readStateIfPresent(input.connections, item.targetId);
        if (currentState?.status === "retired") {
          results.push(
            itemFailure(
              item.candidateId,
              item.targetId,
              "Retired connection IDs cannot be reused.",
            ),
          );
          continue;
        }
        if (item.mode === "update" && current?.revision !== item.expectedRevision) {
          results.push(
            itemFailure(
              item.candidateId,
              item.targetId,
              "Connection revision changed; reload before importing.",
            ),
          );
          continue;
        }

        const hasCredentialValues =
          Object.keys(values.env).length > 0 || Object.keys(values.headers).length > 0;
        const credentialId = hasCredentialValues
          ? await input.credentials.create(values)
          : undefined;
        const saveInput = {
          id: item.targetId,
          name: analysis.name,
          transport: materializedTransport(analysis.transport, values, credentialId),
          importedFrom: cached.sources.map(({ reference }) => reference),
          ...(item.mode === "update" ? { expectedRevision: item.expectedRevision } : {}),
        };
        const saved = await input.connections.save(saveInput);
        results.push({
          candidateId: item.candidateId,
          targetId: item.targetId,
          status: "imported",
          revision: saved.revision,
        });
      } catch {
        results.push(itemFailure(item.candidateId, item.targetId, "Import failed."));
      }
    }
    return { scanId: request.scanId, items: results };
  };

  return { discover, importSelected };
}
