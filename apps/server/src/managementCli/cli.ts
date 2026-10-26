import { Argument, Flag } from "effect/unstable/cli";

export const managementCliArguments = Argument.string("arguments").pipe(Argument.variadic());

/** Shared management flags are declared here so the parser rejects typos consistently. */
export const managementCliFlags = {
  json: Flag.boolean("json").pipe(Flag.withDefault(false)),
  content: Flag.string("content").pipe(Flag.optional),
  contentFile: Flag.string("content-file").pipe(Flag.optional),
  stdin: Flag.boolean("stdin").pipe(Flag.withDefault(false)),
  codeStdin: Flag.boolean("code-stdin").pipe(Flag.withDefault(false)),
  file: Flag.string("file").pipe(Flag.optional),
  url: Flag.string("url").pipe(Flag.optional),
  path: Flag.string("path").pipe(Flag.optional),
  name: Flag.string("name").pipe(Flag.optional),
  description: Flag.string("description").pipe(Flag.optional),
  search: Flag.string("search").pipe(Flag.optional),
  usage: Flag.choice("usage", ["used", "unused"]).pipe(Flag.optional),
  source: Flag.atMost(Flag.string("source"), 20),
  tag: Flag.atMost(Flag.string("tag"), 100),
  expertId: Flag.atMost(Flag.string("expert-id"), 100),
  expertIds: Flag.string("expert-ids").pipe(Flag.optional),
  skillId: Flag.atMost(Flag.string("skill-id"), 5_000),
  skillIds: Flag.string("skill-ids").pipe(Flag.optional),
  createdBy: Flag.string("created-by").pipe(Flag.optional),
  sort: Flag.choice("sort", ["name", "used-by", "created", "updated"]).pipe(Flag.optional),
  direction: Flag.choice("direction", ["asc", "desc"]).pipe(Flag.optional),
  expectedRevision: Flag.integer("expected-revision").pipe(Flag.optional),
  requestId: Flag.string("request-id").pipe(Flag.optional),
  dryRun: Flag.boolean("dry-run").pipe(Flag.withDefault(false)),
  clear: Flag.boolean("clear").pipe(Flag.withDefault(false)),
  yes: Flag.boolean("yes").pipe(Flag.withDefault(false)),
  overwriteLocalEdits: Flag.boolean("overwrite-local-edits").pipe(Flag.withDefault(false)),
  entry: Flag.string("entry").pipe(Flag.optional),
  duplicate: Flag.choice("duplicate", ["skip", "rename", "replace"]).pipe(Flag.optional),
  activation: Flag.choice("activation", ["startup", "on-demand"]).pipe(Flag.optional),
  instanceId: Flag.string("instance-id").pipe(Flag.optional),
  flavor: Flag.choice("flavor", [
    "production",
    "development",
    "canary",
    "cua",
    "beta",
    "workbench",
    "workbench-preview",
  ]).pipe(Flag.optional),
} as const;

export type ManagementCliFlagValues = {
  readonly json: boolean;
  readonly content: string | undefined;
  readonly contentFile: string | undefined;
  readonly stdin: boolean;
  readonly codeStdin: boolean;
  readonly file: string | undefined;
  readonly url: string | undefined;
  readonly path: string | undefined;
  readonly name: string | undefined;
  readonly description: string | undefined;
  readonly search: string | undefined;
  readonly usage: "used" | "unused" | undefined;
  readonly source: ReadonlyArray<string>;
  readonly tag: ReadonlyArray<string>;
  readonly expertId: ReadonlyArray<string>;
  readonly expertIds: string | undefined;
  readonly skillId: ReadonlyArray<string>;
  readonly skillIds: string | undefined;
  readonly createdBy: string | undefined;
  readonly sort: "name" | "used-by" | "created" | "updated" | undefined;
  readonly direction: "asc" | "desc" | undefined;
  readonly expectedRevision: number | undefined;
  readonly requestId: string | undefined;
  readonly dryRun: boolean;
  readonly clear: boolean;
  readonly yes: boolean;
  readonly overwriteLocalEdits: boolean;
  readonly entry: string | undefined;
  readonly duplicate: "skip" | "rename" | "replace" | undefined;
  readonly activation: "startup" | "on-demand" | undefined;
  readonly instanceId: string | undefined;
  readonly flavor: ManagementCliFlagValuesFlavor | undefined;
};

type ManagementCliFlagValuesFlavor =
  | "production"
  | "development"
  | "canary"
  | "cua"
  | "beta"
  | "workbench"
  | "workbench-preview";

export type ManagementCliNamespace = "skill" | "expert";

export interface ManagementCliFlagParseFailure {
  readonly namespace: ManagementCliNamespace;
  readonly message: string;
}

interface FlagSyntax {
  readonly kind: "boolean" | "string" | "integer" | "choice" | "url";
  readonly choices?: ReadonlyArray<string>;
  readonly maximumOccurrences?: number;
}

const MANAGEMENT_FLAG_SYNTAX: Readonly<Record<string, FlagSyntax>> = {
  json: { kind: "boolean" },
  content: { kind: "string" },
  "content-file": { kind: "string" },
  stdin: { kind: "boolean" },
  "code-stdin": { kind: "boolean" },
  file: { kind: "string" },
  url: { kind: "string" },
  path: { kind: "string" },
  name: { kind: "string" },
  description: { kind: "string" },
  search: { kind: "string" },
  usage: { kind: "choice", choices: ["used", "unused"] },
  source: { kind: "string", maximumOccurrences: 20 },
  tag: { kind: "string", maximumOccurrences: 100 },
  "expert-id": { kind: "string", maximumOccurrences: 100 },
  "expert-ids": { kind: "string" },
  "skill-id": { kind: "string", maximumOccurrences: 5_000 },
  "skill-ids": { kind: "string" },
  "created-by": { kind: "string" },
  sort: { kind: "choice", choices: ["name", "used-by", "created", "updated"] },
  direction: { kind: "choice", choices: ["asc", "desc"] },
  "expected-revision": { kind: "integer" },
  "request-id": { kind: "string" },
  "dry-run": { kind: "boolean" },
  clear: { kind: "boolean" },
  yes: { kind: "boolean" },
  "overwrite-local-edits": { kind: "boolean" },
  entry: { kind: "string" },
  duplicate: { kind: "choice", choices: ["skip", "rename", "replace"] },
  activation: { kind: "choice", choices: ["startup", "on-demand"] },
  "instance-id": { kind: "string" },
  flavor: {
    kind: "choice",
    choices: [
      "production",
      "development",
      "canary",
      "cua",
      "beta",
      "workbench",
      "workbench-preview",
    ],
  },
};

const ROOT_FLAG_SYNTAX: Readonly<Record<string, FlagSyntax>> = {
  mode: { kind: "choice", choices: ["web", "desktop"] },
  port: { kind: "integer" },
  host: { kind: "string" },
  "home-dir": { kind: "string" },
  "dev-url": { kind: "url" },
  "public-url": { kind: "url" },
  "allow-insecure-remote": { kind: "boolean" },
  "no-browser": { kind: "boolean" },
  browser: { kind: "boolean" },
  "auth-token": { kind: "string" },
  token: { kind: "string" },
  "auto-bootstrap-project-from-cwd": { kind: "boolean" },
  "log-provider-events": { kind: "boolean" },
  "log-websocket-events": { kind: "boolean" },
  "log-ws-events": { kind: "boolean" },
  "log-level": {
    kind: "choice",
    choices: ["all", "trace", "debug", "info", "warn", "warning", "error", "fatal", "none"],
  },
};

/**
 * Effect CLI prints parse failures as help and leaves the process successful.
 * Preflight only the `skill` and `expert` namespaces so their syntax failures
 * share the management JSON envelope and stable usage exit code.
 */
export function parseManagementCliFlagFailure(
  args: ReadonlyArray<string>,
): ManagementCliFlagParseFailure | undefined {
  if (args.some((token) => token === "--help" || token === "-h" || token === "--version"))
    return undefined;

  let namespaceIndex = -1;
  let namespace: ManagementCliNamespace | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith("-") || token === "-") {
      if (token === "skill" || token === "expert") {
        namespaceIndex = index;
        namespace = token;
      }
      break;
    }
    const [name, inlineValue] = optionParts(token);
    if (
      name !== undefined &&
      ROOT_FLAG_SYNTAX[name]?.kind !== undefined &&
      inlineValue === undefined
    ) {
      if (ROOT_FLAG_SYNTAX[name]!.kind !== "boolean") index += 1;
    }
  }
  if (namespace === undefined || namespaceIndex < 0) return undefined;

  const occurrences = new Map<string, number>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--") break;
    if (!token.startsWith("-") || token === "-") continue;
    const [name, inlineValue] = optionParts(token);
    if (!name) continue;
    if (name === "help" || name === "version" || name === "completions") {
      if (name === "completions" && inlineValue === undefined) index += 1;
      continue;
    }
    const isBeforeNamespace = index < namespaceIndex;
    const syntax = isBeforeNamespace
      ? ROOT_FLAG_SYNTAX[name]
      : (MANAGEMENT_FLAG_SYNTAX[name] ?? ROOT_FLAG_SYNTAX[name]);
    if (!syntax) {
      return {
        namespace,
        message: `Unrecognized flag: --${name} in command synara ${namespace}`,
      };
    }
    if (syntax.maximumOccurrences) {
      const count = (occurrences.get(name) ?? 0) + 1;
      occurrences.set(name, count);
      if (count > syntax.maximumOccurrences) {
        return {
          namespace,
          message: `Flag --${name} may be provided at most ${syntax.maximumOccurrences} times.`,
        };
      }
    }
    if (syntax.kind === "boolean") {
      if (inlineValue !== undefined) {
        return { namespace, message: `Flag --${name} does not take a value.` };
      }
      continue;
    }
    let value = inlineValue;
    if (value === undefined) {
      const next = args[index + 1];
      if (next === undefined || (next.startsWith("--") && next !== "--")) {
        return { namespace, message: `Missing value for flag --${name}.` };
      }
      value = next;
      index += 1;
    }
    if (syntax.kind === "integer" && !/^[+-]?\d+$/u.test(value)) {
      return {
        namespace,
        message: `Invalid value for flag --${name}: ${JSON.stringify(value)}. Expected: integer.`,
      };
    }
    if (syntax.kind === "integer" && name === "port") {
      const port = Number(value);
      if (port < 1 || port > 65_535) {
        return {
          namespace,
          message: `Invalid value for flag --port: ${JSON.stringify(value)}. Expected: integer between 1 and 65535.`,
        };
      }
    }
    if (syntax.kind === "url") {
      try {
        new URL(value);
      } catch {
        return {
          namespace,
          message: `Invalid value for flag --${name}: ${JSON.stringify(value)}. Expected: absolute URL.`,
        };
      }
    }
    if (syntax.kind === "choice" && !syntax.choices?.includes(value)) {
      return {
        namespace,
        message: `Invalid value for flag --${name}: ${JSON.stringify(value)}. Expected one of: ${syntax.choices?.join(", ") ?? ""}.`,
      };
    }
  }
  return undefined;
}

function optionParts(token: string): [name: string | undefined, inlineValue: string | undefined] {
  if (!token.startsWith("--")) {
    return token.startsWith("-")
      ? [token === "-h" ? "help" : token.slice(1), undefined]
      : [undefined, undefined];
  }
  const body = token.slice(2);
  const separator = body.indexOf("=");
  return separator < 0 ? [body, undefined] : [body.slice(0, separator), body.slice(separator + 1)];
}

export type ManagementCliOperation =
  | {
      readonly area: "skill";
      readonly action: "list" | "get" | "create" | "update" | "delete" | "import" | "refresh";
    }
  | {
      readonly area: "skill";
      readonly action: "files-list" | "files-read" | "files-write" | "files-delete";
    }
  | { readonly area: "skill"; readonly action: "tags-set" }
  | { readonly area: "skill"; readonly action: "auth-pair" | "auth-list" | "auth-revoke" }
  | {
      readonly area: "expert-skills";
      readonly action: "list" | "add" | "set" | "remove" | "enable" | "disable";
    };

export class ManagementCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagementCliUsageError";
  }
}

export interface ParsedManagementCliCommand {
  readonly operation: ManagementCliOperation;
  readonly positional: ReadonlyArray<string>;
  readonly flags: ManagementCliFlagValues;
}

function parsePath(
  namespace: ManagementCliNamespace,
  args: ReadonlyArray<string>,
): {
  readonly operation: ManagementCliOperation;
  readonly positional: ReadonlyArray<string>;
} {
  const [first, second, ...rest] = args;
  if (namespace === "skill") {
    if (first === "files" && second && ["list", "read", "write", "delete"].includes(second)) {
      return {
        operation: {
          area: "skill",
          action: `files-${second}` as "files-list" | "files-read" | "files-write" | "files-delete",
        },
        positional: rest,
      };
    }
    if (first === "tags" && second === "set") {
      return { operation: { area: "skill", action: "tags-set" }, positional: rest };
    }
    if (first === "auth" && ["pair", "list", "revoke"].includes(second ?? "")) {
      return {
        operation: {
          area: "skill",
          action: `auth-${second}` as "auth-pair" | "auth-list" | "auth-revoke",
        },
        positional: rest,
      };
    }
    if (
      first &&
      ["list", "get", "create", "update", "delete", "import", "refresh"].includes(first)
    ) {
      return {
        operation: {
          area: "skill",
          action: first as "list" | "get" | "create" | "update" | "delete" | "import" | "refresh",
        },
        positional: args.slice(1),
      };
    }
  }
  if (
    namespace === "expert" &&
    first === "skills" &&
    second &&
    ["list", "add", "set", "remove", "enable", "disable"].includes(second)
  ) {
    return {
      operation: {
        area: "expert-skills",
        action: second as "list" | "add" | "set" | "remove" | "enable" | "disable",
      },
      positional: rest,
    };
  }
  throw new ManagementCliUsageError(
    namespace === "skill"
      ? "Expected `skill list|get|create|update|delete|import|refresh`, `skill files ...`, `skill tags set`, or `skill auth ...`."
      : "Expected `expert skills list|add|set|remove|enable|disable`.",
  );
}

export function parseManagementCliCommand(input: {
  readonly namespace: ManagementCliNamespace;
  readonly args: ReadonlyArray<string>;
  readonly flags: ManagementCliFlagValues;
}): ParsedManagementCliCommand {
  const parsedPath = parsePath(input.namespace, input.args);
  return { ...parsedPath, flags: input.flags };
}

export function parseCsvFlag(
  value: string | undefined,
  repeated: ReadonlyArray<string> = [],
): ReadonlyArray<string> {
  const values = [...repeated, ...(value === undefined ? [] : value.split(","))]
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(values)];
}

export function assertSingleContentSource(
  flags: Pick<ManagementCliFlagValues, "content" | "contentFile" | "stdin">,
): void {
  const count =
    Number(flags.content !== undefined) +
    Number(flags.contentFile !== undefined) +
    Number(flags.stdin);
  if (count > 1) {
    throw new ManagementCliUsageError("Choose only one of --content, --content-file, or --stdin.");
  }
  if (count === 0) {
    throw new ManagementCliUsageError(
      "Provide content with --content, --content-file, or --stdin.",
    );
  }
}
