import type {
  ExpertDefinition,
  ExpertConnectionConfig,
  ExpertConnectionSaveInput,
  ExpertConnectionTransport,
  ExpertConnectionReferencesResult,
  McpConfigSourceReference,
} from "@synara/contracts";
import { EXPERT_CONNECTIONS_QUERY_KEY, EXPERTS_QUERY_KEY } from "./expertSettingsQueries";
export { EXPERT_CONNECTIONS_QUERY_KEY, EXPERTS_QUERY_KEY };
export const connectionStateQueryKey = (id: string) =>
  ["server", "expertConnectionState", id] as const;
export const connectionReferencesQueryKey = (id: string) =>
  ["server", "expertConnectionReferences", id] as const;

export interface ConnectionDraft {
  id: string;
  name: string;
  type: "stdio" | "http";
  command: string;
  args: string;
  envFromHost: string;
  url: string;
  headersFromHost: string;
  originalArgs?: ReadonlyArray<string>;
  argsEdited?: boolean;
  originalHeaders?: ReadonlyArray<{ name: string; envVar: string; prefix?: string | undefined }>;
  headersEdited?: boolean;
  cwd?: string;
  startupTimeoutMs?: number;
  toolTimeoutMs?: number;
  importedFrom?: ExpertConnectionConfig["importedFrom"];
  envFromSource?: Extract<ExpertConnectionTransport, { type: "stdio" }>["envFromSource"];
  envFromSecret?: Extract<ExpertConnectionTransport, { type: "stdio" }>["envFromSecret"];
  headersFromSource?: Extract<ExpertConnectionTransport, { type: "http" }>["headersFromSource"];
  headersFromSecret?: Extract<ExpertConnectionTransport, { type: "http" }>["headersFromSecret"];
}

type McpSourceSelection = {
  readonly source: McpConfigSourceReference;
  readonly names: ReadonlyArray<string>;
};

function copySourceReference(
  reference: McpSourceSelection | undefined,
): McpSourceSelection | undefined {
  return reference
    ? { ...reference, source: { ...reference.source }, names: [...reference.names] }
    : undefined;
}

function copySourceReferences(
  references: ExpertConnectionConfig["importedFrom"],
): ExpertConnectionConfig["importedFrom"] {
  return references?.map((reference) => ({ ...reference }));
}

function copyCredentialReference<T extends { credentialId: string; names: ReadonlyArray<string> }>(
  reference: T | undefined,
): T | undefined {
  return reference ? { ...reference, names: [...reference.names] } : undefined;
}

export function draftFromConnection(connection?: ExpertConnectionConfig): ConnectionDraft {
  const transport = connection?.transport;
  return {
    id: connection?.id ?? "",
    name: connection?.name ?? "",
    type: transport?.type ?? "stdio",
    ...(connection?.importedFrom === undefined
      ? {}
      : { importedFrom: copySourceReferences(connection.importedFrom) }),
    command: transport?.type === "stdio" ? transport.command : "",
    args: transport?.type === "stdio" ? transport.args.join("\n") : "",
    ...(transport?.type === "stdio"
      ? { originalArgs: [...transport.args], argsEdited: false }
      : {}),
    ...(transport?.type === "stdio"
      ? {
          ...(transport.cwd === undefined ? {} : { cwd: transport.cwd }),
          ...(transport.startupTimeoutMs === undefined
            ? {}
            : { startupTimeoutMs: transport.startupTimeoutMs }),
          ...(transport.toolTimeoutMs === undefined
            ? {}
            : { toolTimeoutMs: transport.toolTimeoutMs }),
          ...(transport.envFromSource === undefined
            ? {}
            : { envFromSource: copySourceReference(transport.envFromSource) }),
          ...(transport.envFromSecret === undefined
            ? {}
            : { envFromSecret: copyCredentialReference(transport.envFromSecret) }),
        }
      : {}),
    envFromHost:
      transport?.type === "stdio"
        ? transport.envFromHost.map((item) => `${item.name}=${item.envVar}`).join("\n")
        : "",
    url: transport?.type === "http" ? transport.url : "",
    headersFromHost:
      transport?.type === "http"
        ? transport.headersFromHost
            .map((item) => `${item.name}=${item.envVar}${item.prefix ? `|${item.prefix}` : ""}`)
            .join("\n")
        : "",
    ...(transport?.type === "http"
      ? {
          originalHeaders: transport.headersFromHost.map((item) => ({ ...item })),
          headersEdited: false,
          ...(transport.headersFromSource === undefined
            ? {}
            : { headersFromSource: copySourceReference(transport.headersFromSource) }),
          ...(transport.headersFromSecret === undefined
            ? {}
            : { headersFromSecret: copyCredentialReference(transport.headersFromSecret) }),
        }
      : {}),
  };
}

export function sameConnectionDraft(a: ConnectionDraft, b: ConnectionDraft): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.type === b.type &&
    a.command === b.command &&
    a.args === b.args &&
    a.argsEdited === b.argsEdited &&
    a.envFromHost === b.envFromHost &&
    a.url === b.url &&
    a.headersFromHost === b.headersFromHost &&
    a.headersEdited === b.headersEdited &&
    a.cwd === b.cwd &&
    a.startupTimeoutMs === b.startupTimeoutMs &&
    a.toolTimeoutMs === b.toolTimeoutMs &&
    sameSourceReferences(a.importedFrom, b.importedFrom) &&
    sameSourceReference(a.envFromSource, b.envFromSource) &&
    sameSourceReference(a.headersFromSource, b.headersFromSource) &&
    sameCredentialReference(a.envFromSecret, b.envFromSecret) &&
    sameCredentialReference(a.headersFromSecret, b.headersFromSecret)
  );
}

function sameSourceReference(
  a:
    | { readonly source: McpConfigSourceReference; readonly names: ReadonlyArray<string> }
    | undefined,
  b:
    | { readonly source: McpConfigSourceReference; readonly names: ReadonlyArray<string> }
    | undefined,
): boolean {
  return (
    (a === undefined && b === undefined) ||
    (a !== undefined &&
      b !== undefined &&
      a.source.kind === b.source.kind &&
      a.source.path === b.source.path &&
      a.source.entryId === b.source.entryId &&
      a.names.length === b.names.length &&
      a.names.every((name, index) => name === b.names[index]))
  );
}

function sameSourceReferences(
  a: ExpertConnectionConfig["importedFrom"],
  b: ExpertConnectionConfig["importedFrom"],
): boolean {
  return (
    (a === undefined && b === undefined) ||
    (a !== undefined &&
      b !== undefined &&
      a.length === b.length &&
      a.every(
        (source, index) =>
          source.kind === b[index]?.kind &&
          source.path === b[index]?.path &&
          source.entryId === b[index]?.entryId,
      ))
  );
}

function sameCredentialReference(
  a: { readonly credentialId: string; readonly names: ReadonlyArray<string> } | undefined,
  b: { readonly credentialId: string; readonly names: ReadonlyArray<string> } | undefined,
): boolean {
  return (
    (a === undefined && b === undefined) ||
    (a !== undefined &&
      b !== undefined &&
      a.credentialId === b.credentialId &&
      a.names.length === b.names.length &&
      a.names.every((name, index) => name === b.names[index]))
  );
}

function lines(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .filter(Boolean);
}
function mappings(value: string, prefixes = false) {
  const entries = value.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  return entries.map((rawLine) => {
    const line = prefixes ? rawLine.trimStart() : rawLine.trim();
    const divider = prefixes ? line.indexOf("|") : -1;
    if (prefixes && divider >= 0 && line.indexOf("|", divider + 1) >= 0) {
      throw new Error("请求头映射最多只能包含一个前缀分隔符“|”。");
    }
    const pair = divider >= 0 ? line.slice(0, divider).trimEnd() : line;
    const separator = pair.indexOf("=");
    if (separator < 1 || separator === pair.length - 1)
      throw new Error("每行请按“名称=环境变量名”填写。");
    const result = {
      name: pair.slice(0, separator).trim(),
      envVar: pair.slice(separator + 1).trim(),
    };
    const prefix = divider >= 0 ? line.slice(divider + 1) : "";
    return prefixes && prefix ? { ...result, prefix } : result;
  });
}

function hasNameConflict(
  hostNames: ReadonlyArray<string>,
  savedNames: ReadonlyArray<string>,
  normalize: (name: string) => string = (name) => name,
): boolean {
  const saved = new Set(savedNames.map(normalize));
  return hostNames.some((name) => saved.has(normalize(name)));
}

export function connectionSaveInput(
  draft: ConnectionDraft,
  revision: number | null,
): ExpertConnectionSaveInput {
  const base = {
    id: draft.id.trim(),
    name: draft.name.trim(),
    ...(draft.importedFrom === undefined
      ? {}
      : { importedFrom: copySourceReferences(draft.importedFrom) }),
    ...(revision === null ? {} : { expectedRevision: revision }),
  };
  if (draft.type === "stdio")
    return {
      ...base,
      transport: {
        type: "stdio",
        command: draft.command.trim(),
        args: draft.argsEdited
          ? draft.args === ""
            ? []
            : draft.args.split(/\r?\n/u)
          : [...(draft.originalArgs ?? lines(draft.args))],
        envFromHost: mappings(draft.envFromHost),
        ...(draft.cwd === undefined ? {} : { cwd: draft.cwd }),
        ...(draft.startupTimeoutMs === undefined
          ? {}
          : { startupTimeoutMs: draft.startupTimeoutMs }),
        ...(draft.toolTimeoutMs === undefined ? {} : { toolTimeoutMs: draft.toolTimeoutMs }),
        ...(draft.envFromSource === undefined
          ? {}
          : { envFromSource: copySourceReference(draft.envFromSource) }),
        ...(draft.envFromSecret === undefined
          ? {}
          : { envFromSecret: copyCredentialReference(draft.envFromSecret) }),
      },
    };
  return {
    ...base,
    transport: {
      type: "http",
      url: draft.url.trim(),
      headersFromHost: draft.headersEdited
        ? mappings(draft.headersFromHost, true)
        : (draft.originalHeaders ?? mappings(draft.headersFromHost, true)),
      ...(draft.headersFromSource === undefined
        ? {}
        : { headersFromSource: copySourceReference(draft.headersFromSource) }),
      ...(draft.headersFromSecret === undefined
        ? {}
        : { headersFromSecret: copyCredentialReference(draft.headersFromSecret) }),
    },
  };
}

export function validateConnectionDraft(draft: ConnectionDraft): string | null {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(draft.id.trim()))
    return "ID 需以小写字母或数字开头，并仅包含小写字母、数字、- 或 _。";
  if (!draft.name.trim()) return "请填写连接名称。";
  if (draft.type === "stdio" && !draft.command.trim()) return "请填写启动命令。";
  if (draft.type === "http") {
    try {
      const url = new URL(draft.url);
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        return "请使用不含凭证、查询参数或片段的 HTTP(S) 地址。";
    } catch {
      return "请填写有效的服务 URL。";
    }
  }
  try {
    const hostMappings = mappings(
      draft.type === "stdio" ? draft.envFromHost : draft.headersFromHost,
      draft.type === "http",
    );
    if (
      draft.type === "stdio" &&
      draft.envFromSecret &&
      hasNameConflict(
        hostMappings.map(({ name }) => name),
        [...(draft.envFromSource?.names ?? []), ...draft.envFromSecret.names],
      )
    ) {
      return "主机映射与已保存变量名称重复。";
    }
    if (
      draft.type === "http" &&
      draft.headersFromSecret &&
      hasNameConflict(
        hostMappings.map(({ name }) => name),
        [...(draft.headersFromSource?.names ?? []), ...draft.headersFromSecret.names],
        (name) => name.toLowerCase(),
      )
    ) {
      return "主机请求头与已保存名称重复。";
    }
  } catch (error) {
    return error instanceof Error ? error.message : "映射格式无效。";
  }
  return null;
}

export function connectionSummary(connection: ExpertConnectionConfig): string {
  if (connection.transport.type === "stdio")
    return `stdio · ${connection.transport.command.split(/[\\/]/u).pop() ?? connection.transport.command}`;
  try {
    return `HTTP · ${new URL(connection.transport.url).host}`;
  } catch {
    return "HTTP";
  }
}

export function authorizedExpertCount(
  connectionId: string,
  experts: ReadonlyArray<Pick<ExpertDefinition, "archived" | "connections">>,
): number {
  return experts.filter(
    (expert) =>
      !expert.archived &&
      expert.connections.some(
        (item) =>
          item.id === connectionId &&
          item.enabled !== false &&
          (item.toolMode === "all" || item.tools.some((tool) => tool.trim())),
      ),
  ).length;
}

export function referenceCount(references: ExpertConnectionReferencesResult): number {
  return (
    references.experts.length +
    references.snapshots.length +
    references.tasks.length +
    references.activeSessionCount
  );
}
export function referencesPreventDeletion(
  references: ExpertConnectionReferencesResult | undefined,
): boolean {
  return !references || referenceCount(references) > 0;
}
export function isConnectionTestStale(
  result: { revision: number } | undefined,
  revision: number,
): boolean {
  return result !== undefined && result.revision !== revision;
}
