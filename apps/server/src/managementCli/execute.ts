import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import type { SkillLibraryRequest, SkillManagementFlavor } from "@synara/contracts";

import type {
  ManagementCliFlagValues,
  ManagementCliNamespace,
  ParsedManagementCliCommand,
} from "./cli";
import {
  ManagementCliUsageError,
  assertSingleContentSource,
  parseCsvFlag,
  parseManagementCliCommand,
} from "./cli";
import { readSkillManagementCredential, removeSkillManagementCredential } from "./credential";
import { SKILL_MANAGEMENT_EXIT_CODES, type SkillManagementExitCode } from "./exitCodes";
import {
  getOrCreateManagementRequestEnvelopeEntry,
  ManagementCliRequestIdConflictError,
  managementCliIntentHash,
} from "./requestEnvelope";
import {
  discoverLocalManagementRuntime,
  executeSkillManagementRequest,
  exchangeSkillManagementPairing,
  revokeCurrentSkillManagementCredential,
  SkillManagementTransportError,
} from "./transport";

type JsonRecord = Record<string, unknown>;

interface CliIo {
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
  readonly stderr?: Pick<NodeJS.WriteStream, "write">;
  readonly readStdin?: () => Promise<Buffer>;
  readonly promptCode?: () => Promise<string>;
}

export interface ManagementCliInput {
  readonly command: ParsedManagementCliCommand;
  readonly baseDir: string;
  readonly io?: CliIo;
}

export interface ManagementCliOutcome {
  readonly exitCode: SkillManagementExitCode;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

function stdout(io?: CliIo): Pick<NodeJS.WriteStream, "write"> {
  return io?.stdout ?? process.stdout;
}

function stderr(io?: CliIo): Pick<NodeJS.WriteStream, "write"> {
  return io?.stderr ?? process.stderr;
}

function readStdin(io?: CliIo): Promise<Buffer> {
  if (io?.readStdin) return io.readStdin();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    process.stdin.once("error", reject);
    process.stdin.once("end", () => resolve(Buffer.concat(chunks)));
    process.stdin.resume();
  });
}

async function promptPairingCode(io?: CliIo): Promise<string> {
  if (io?.promptCode) return io.promptCode();
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await prompt.question("One-time Skill management pairing code: ")).trim();
  } finally {
    prompt.close();
  }
}

function positional(command: ParsedManagementCliCommand, index: number, label: string): string {
  const value = command.positional[index]?.trim();
  if (!value) throw new ManagementCliUsageError(`Missing ${label}.`);
  return value;
}

function assertNoExtraPositionals(command: ParsedManagementCliCommand, used: number): void {
  if (command.positional.length > used) {
    throw new ManagementCliUsageError(
      `Unexpected positional argument: ${command.positional[used]}`,
    );
  }
}

function requireRevision(
  flags: ManagementCliFlagValues,
  context: string,
  current?: unknown,
): number {
  const value = flags.expectedRevision ?? current;
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new ManagementCliUsageError(
      `Use --expected-revision with the current ${context} revision.`,
    );
  }
  return Number(value);
}

function allIds(flags: ManagementCliFlagValues): ReadonlyArray<string> {
  const ids = parseCsvFlag(flags.skillIds, flags.skillId);
  if (!ids.length)
    throw new ManagementCliUsageError("Provide at least one --skill-id or --skill-ids value.");
  return ids;
}

function expertIds(flags: ManagementCliFlagValues): ReadonlyArray<string> {
  return parseCsvFlag(flags.expertIds, flags.expertId);
}

function asRequest(value: unknown): SkillLibraryRequest {
  return value as SkillLibraryRequest;
}

async function request(input: ManagementCliInput, value: unknown): Promise<JsonRecord> {
  const result = await executeSkillManagementRequest({
    baseDir: input.baseDir,
    ...(input.command.flags.instanceId ? { instanceId: input.command.flags.instanceId } : {}),
    ...(input.command.flags.flavor ? { flavor: input.command.flags.flavor } : {}),
    request: asRequest(value),
  });
  return result && typeof result === "object" ? (result as JsonRecord) : { value: result };
}

async function managementRequestScope(input: ManagementCliInput) {
  const runtime = await discoverLocalManagementRuntime({ baseDir: input.baseDir });
  const credential = await readSkillManagementCredential({
    baseDir: input.baseDir,
    ...(input.command.flags.instanceId ? { instanceId: input.command.flags.instanceId } : {}),
    ...(input.command.flags.flavor
      ? { flavor: input.command.flags.flavor as SkillManagementFlavor }
      : {}),
    endpoint: runtime.endpoint,
  });
  return {
    credentialId: credential.credentialId,
    instanceId: credential.instanceId,
    flavor: credential.flavor,
  };
}

async function mutationRequest(
  input: ManagementCliInput,
  requestId: string,
  intentHash: string,
  buildRequest: () => Promise<unknown>,
  cleanup?: () => Promise<void>,
  options?: {
    readonly preparedContentHash?: () => string | undefined;
    readonly recoverExpiredPreview?: (preparedContentHash?: string) => Promise<void>;
  },
): Promise<JsonRecord> {
  const dryRun = input.command.flags.dryRun;
  let requestValue: unknown;
  let preparedContentHash: string | undefined;
  try {
    if (dryRun) {
      requestValue = await buildRequest();
    } else {
      const envelope = await getOrCreateManagementRequestEnvelopeEntry({
        baseDir: input.baseDir,
        scope: await managementRequestScope(input),
        requestId,
        intentHash,
        buildRequest,
        ...(options?.preparedContentHash
          ? { preparedContentHash: options.preparedContentHash }
          : {}),
      });
      requestValue = envelope.request;
      preparedContentHash = envelope.preparedContentHash;
    }
    try {
      return await request(input, requestValue);
    } catch (cause) {
      if (
        !dryRun &&
        options?.recoverExpiredPreview &&
        cause instanceof SkillManagementTransportError &&
        cause.status === 400 &&
        cause.message === "Skill preview expired or was cancelled; preview again."
      ) {
        await options.recoverExpiredPreview(preparedContentHash);
        return await request(input, requestValue);
      }
      throw cause;
    }
  } finally {
    await cleanup?.().catch(() => undefined);
  }
}

function baseRequestId(flags: ManagementCliFlagValues): string {
  return flags.requestId?.trim() || randomUUID();
}

function requestIdForExpert(requestId: string, expertId: string, multi: boolean): string {
  if (!multi) return requestId;
  const digest = createHash("sha256").update(`${requestId}\0${expertId}`, "utf8").digest("hex");
  return `skill-cli-${digest}`;
}

function requestIdForRefreshedSkill(requestId: string, skillId: string): string {
  const digest = createHash("sha256").update(`${requestId}\0${skillId}`, "utf8").digest("hex");
  return `skill-refresh-cli-${digest}`;
}

function requestIdForRefreshBatch(requestId: string, batchIndex: number): string {
  const digest = createHash("sha256")
    .update(`${requestId}\0refresh-batch\0${batchIndex}`, "utf8")
    .digest("hex");
  return `skill-refresh-batch-cli-${digest}`;
}

function refreshedSkillIds(command: ParsedManagementCliCommand): ReadonlyArray<string> {
  const fromFlags = parseCsvFlag(command.flags.skillIds, command.flags.skillId);
  if (fromFlags.length && command.positional.length) {
    throw new ManagementCliUsageError(
      "Choose positional Skill IDs or --skill-id/--skill-ids for refresh, not both.",
    );
  }
  if (fromFlags.length) {
    assertNoExtraPositionals(command, 0);
    return fromFlags;
  }
  if (!command.positional.length) {
    throw new ManagementCliUsageError(
      "Provide a Skill ID or one or more --skill-id/--skill-ids values to refresh.",
    );
  }
  assertNoExtraPositionals(command, 1);
  return [...new Set(command.positional.map((skillId) => skillId.trim()).filter(Boolean))];
}

async function readFileInput(flags: ManagementCliFlagValues, io?: CliIo): Promise<Buffer> {
  assertSingleContentSource(flags);
  if (flags.content !== undefined) return Buffer.from(flags.content, "utf8");
  if (flags.contentFile !== undefined) return fs.readFile(path.resolve(flags.contentFile));
  return readStdin(io);
}

async function readUtf8Input(flags: ManagementCliFlagValues, io?: CliIo): Promise<string> {
  const bytes = await readFileInput(flags, io);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new ManagementCliUsageError("Content is not valid UTF-8 text.");
  }
  return text;
}

function requiredSkillId(command: ParsedManagementCliCommand): string {
  return positional(command, 0, "Skill ID");
}

function responseField<A>(response: JsonRecord, field: string): A | undefined {
  const value = response[field];
  return value === undefined ? undefined : (value as A);
}

function importPreviewContentHash(preview: JsonRecord): string {
  const packageInfo = responseField<JsonRecord>(preview, "package");
  if (!packageInfo) throw new Error("Import preview returned no package summary.");
  const entries = responseField<ReadonlyArray<JsonRecord>>(packageInfo, "entries") ?? [];
  const resources = responseField<ReadonlyArray<JsonRecord>>(packageInfo, "resources") ?? [];
  const source = responseField<JsonRecord>(preview, "source") ?? {};
  const canonical = {
    package: {
      schemaVersion: packageInfo.schemaVersion,
      rootName: packageInfo.rootName,
      fileCount: packageInfo.fileCount,
      totalBytes: packageInfo.totalBytes,
      entries: [...entries]
        .map((entry) => ({
          entryPath: entry.entryPath,
          name: entry.name,
          description: entry.description,
          issues: Array.isArray(entry.issues) ? [...entry.issues].sort() : [],
          disableModelInvocation: entry.disableModelInvocation,
          userInvocable: entry.userInvocable,
          incompatibleReason: entry.incompatibleReason,
        }))
        .sort((left, right) => String(left.entryPath).localeCompare(String(right.entryPath))),
      resources: [...resources]
        .map((resource) => ({
          path: resource.path,
          kind: resource.kind,
          size: resource.size,
          sha256: resource.sha256,
          executable: resource.executable,
        }))
        .sort((left, right) => String(left.path).localeCompare(String(right.path))),
    },
    source: {
      kind: source.kind,
      location: source.location,
      resolvedRevision: source.resolvedRevision,
      entryPath: source.entryPath,
    },
    selectedEntryPaths: [
      ...(responseField<ReadonlyArray<string>>(preview, "selectedEntryPaths") ?? []),
    ].sort(),
    resourceChanges: [
      ...(responseField<ReadonlyArray<string>>(preview, "resourceChanges") ?? []),
    ].sort(),
    overwritesLocalEdits: preview.overwritesLocalEdits,
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

async function readSkill(input: ManagementCliInput, skillId: string): Promise<JsonRecord> {
  const result = await request(input, { action: "read", skillId });
  const skill = responseField<JsonRecord>(result, "skill");
  if (!skill) throw new Error("Skill library returned no Skill definition.");
  return { ...result, skill };
}

function queryFromFlags(flags: ManagementCliFlagValues): JsonRecord | undefined {
  const sources = parseCsvFlag(undefined, flags.source);
  const expertIdsFilter = expertIds(flags);
  const tags = parseCsvFlag(undefined, flags.tag);
  const query: JsonRecord = {};
  if (flags.search !== undefined) query.search = flags.search;
  if (flags.usage !== undefined) query.usage = flags.usage;
  if (sources.length) query.sources = sources;
  if (expertIdsFilter.length) query.expertIds = expertIdsFilter;
  if (tags.length) query.tags = tags;
  if (flags.sort !== undefined || flags.direction !== undefined) {
    query.sort = {
      field: flags.sort === "used-by" ? "usedBy" : (flags.sort ?? "updated"),
      direction: flags.direction ?? "desc",
    };
  }
  return Object.keys(query).length ? query : undefined;
}

function resultExitCode(result: unknown): SkillManagementExitCode {
  const outcomes: Array<"success" | "conflict" | "failure"> = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const record = value as JsonRecord;
    if (typeof record.status === "string") {
      if (["applied", "would_change", "unchanged", "updated", "skipped"].includes(record.status)) {
        outcomes.push("success");
      } else if (record.status === "conflict") {
        outcomes.push("conflict");
      } else if (record.status === "failed") {
        outcomes.push("failure");
      }
      return;
    } else if (record.success === true) {
      outcomes.push("success");
      return;
    } else if (record.success === false) {
      outcomes.push("failure");
      return;
    }
    for (const child of Object.values(record)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object") visit(child);
    }
  };
  visit(result);
  const hasSuccess = outcomes.includes("success");
  const hasConflict = outcomes.includes("conflict");
  const hasFailure = outcomes.includes("failure");
  if ((hasSuccess && (hasConflict || hasFailure)) || (hasConflict && hasFailure)) {
    return SKILL_MANAGEMENT_EXIT_CODES.partial;
  }
  if (hasConflict) return SKILL_MANAGEMENT_EXIT_CODES.conflict;
  if (hasFailure) return SKILL_MANAGEMENT_EXIT_CODES.runtime;
  return SKILL_MANAGEMENT_EXIT_CODES.success;
}

function formatSuccess(input: {
  readonly command: ParsedManagementCliCommand;
  readonly result: unknown;
  readonly requestId?: string | undefined;
}) {
  return {
    version: 1,
    command: `${input.command.operation.area} ${input.command.operation.action}`,
    ...(input.requestId ? { requestId: input.requestId } : {}),
    result: input.result,
  };
}

function printSuccess(input: {
  readonly command: ParsedManagementCliCommand;
  readonly result: unknown;
  readonly requestId?: string | undefined;
  readonly io?: CliIo | undefined;
}): SkillManagementExitCode {
  const exitCode = resultExitCode(input.result);
  stdout(input.io).write(
    `${JSON.stringify(
      {
        ...formatSuccess(input),
        ok: exitCode === SKILL_MANAGEMENT_EXIT_CODES.success,
        ...(exitCode === SKILL_MANAGEMENT_EXIT_CODES.partial ? { partial: true } : {}),
        ...(exitCode === SKILL_MANAGEMENT_EXIT_CODES.success ? {} : { exitCode }),
      },
      null,
      2,
    )}\n`,
  );
  return exitCode;
}

function printRawBytes(bytes: Uint8Array, io?: CliIo): SkillManagementExitCode {
  stdout(io).write(bytes);
  return SKILL_MANAGEMENT_EXIT_CODES.success;
}

function decodeError(error: unknown): {
  readonly exitCode: SkillManagementExitCode;
  readonly code: string;
  readonly message: string;
} {
  if (error instanceof ManagementCliRequestIdConflictError) {
    return {
      exitCode: SKILL_MANAGEMENT_EXIT_CODES.conflict,
      code: "conflict",
      message: error.message,
    };
  }
  if (error instanceof ManagementCliUsageError) {
    return {
      exitCode: SKILL_MANAGEMENT_EXIT_CODES.usage,
      code: "usage_error",
      message: error.message,
    };
  }
  if (error instanceof SkillManagementTransportError) {
    if (error.status === 401 || error.status === 403) {
      return {
        exitCode: SKILL_MANAGEMENT_EXIT_CODES.unauthorized,
        code: "unauthorized",
        message: error.message,
      };
    }
    if (error.status === 409 || error.code === "conflict") {
      return {
        exitCode: SKILL_MANAGEMENT_EXIT_CODES.conflict,
        code: "conflict",
        message: error.message,
      };
    }
    if (error.status === 400) {
      return {
        exitCode: SKILL_MANAGEMENT_EXIT_CODES.usage,
        code: "invalid_request",
        message: error.message,
      };
    }
  }
  if (
    error instanceof Error &&
    /expected-revision|Unknown option|missing .*skill|provide content/iu.test(error.message)
  ) {
    return {
      exitCode: SKILL_MANAGEMENT_EXIT_CODES.usage,
      code: "usage_error",
      message: error.message,
    };
  }
  return {
    exitCode: SKILL_MANAGEMENT_EXIT_CODES.runtime,
    code: "runtime_error",
    message: error instanceof Error ? error.message : "Skill management command failed.",
  };
}

async function skillCommand(input: ManagementCliInput): Promise<ManagementCliOutcome> {
  const { command, baseDir, io } = input;
  const flags = command.flags;
  const action = command.operation.action;
  switch (action) {
    case "auth-pair": {
      assertNoExtraPositionals(command, 0);
      if (!flags.instanceId || !flags.flavor) {
        throw new ManagementCliUsageError(
          "Pairing requires --instance-id and --flavor from Synara Settings.",
        );
      }
      const code = flags.codeStdin
        ? (await readStdin(io)).toString("utf8").trim()
        : await promptPairingCode(io);
      if (!code) throw new ManagementCliUsageError("The one-time pairing code is empty.");
      const paired = await exchangeSkillManagementPairing({
        baseDir,
        code,
        expectedInstanceId: flags.instanceId,
        expectedFlavor: flags.flavor as SkillManagementFlavor,
      });
      const result = {
        paired: true,
        credentialId: paired.credential.credentialId,
        instanceId: paired.credential.instanceId,
        flavor: paired.credential.flavor,
        createdAt: paired.credential.createdAt,
        expiresAt: paired.credential.expiresAt,
        capabilities: paired.credential.capabilities,
        storedAt: paired.filePath,
      };
      return { exitCode: printSuccess({ command, result, io }), result };
    }
    case "auth-list": {
      assertNoExtraPositionals(command, 0);
      const runtime = await discoverLocalManagementRuntime({ baseDir });
      const credential = await readSkillManagementCredential({
        baseDir,
        ...(flags.instanceId ? { instanceId: flags.instanceId } : {}),
        ...(flags.flavor ? { flavor: flags.flavor as SkillManagementFlavor } : {}),
        endpoint: runtime.endpoint,
      });
      const result = {
        credentialId: credential.credentialId,
        instanceId: credential.instanceId,
        flavor: credential.flavor,
        createdAt: credential.createdAt,
        expiresAt: credential.expiresAt,
        capabilities: credential.capabilities,
        endpoint: credential.endpoint,
      };
      return { exitCode: printSuccess({ command, result, io }), result };
    }
    case "auth-revoke": {
      assertNoExtraPositionals(command, 0);
      const result = await revokeCurrentSkillManagementCredential({
        baseDir,
        ...(flags.instanceId ? { instanceId: flags.instanceId } : {}),
        ...(flags.flavor ? { flavor: flags.flavor as SkillManagementFlavor } : {}),
      });
      if (result.revoked) {
        const runtime = await discoverLocalManagementRuntime({ baseDir });
        const credential = await readSkillManagementCredential({
          baseDir,
          ...(flags.instanceId ? { instanceId: flags.instanceId } : {}),
          ...(flags.flavor ? { flavor: flags.flavor as SkillManagementFlavor } : {}),
          endpoint: runtime.endpoint,
        });
        await removeSkillManagementCredential({
          baseDir,
          instanceId: credential.instanceId,
          flavor: credential.flavor,
        });
      }
      return { exitCode: printSuccess({ command, result, io }), result };
    }
    case "list": {
      assertNoExtraPositionals(command, 0);
      const query = queryFromFlags(flags);
      const result = await request(input, { action: "list", ...(query ? { query } : {}) });
      return { exitCode: printSuccess({ command, result, io }), result };
    }
    case "get": {
      const skillId = requiredSkillId(command);
      assertNoExtraPositionals(command, 1);
      const result = await readSkill(input, skillId);
      const skill = responseField<JsonRecord>(result, "skill")!;
      const file = await request(input, {
        action: "readFile",
        skillId,
        path: String(skill.entryPath),
      });
      const entryFile = responseField<JsonRecord>(file, "file");
      const enriched = { ...result, entryFile };
      return { exitCode: printSuccess({ command, result: enriched, io }), result: enriched };
    }
    case "create": {
      assertNoExtraPositionals(command, 0);
      if (!flags.name?.trim())
        throw new ManagementCliUsageError("Provide --name for the new Skill.");
      const body = await readUtf8Input(flags, io);
      const requestId = baseRequestId(flags);
      const result = await mutationRequest(
        input,
        requestId,
        managementCliIntentHash({ command, content: Buffer.from(body, "utf8") }),
        async () => ({
          action: "create",
          name: flags.name,
          body,
          tags: parseCsvFlag(undefined, flags.tag),
          dryRun: flags.dryRun,
          requestId,
        }),
      );
      return { exitCode: printSuccess({ command, result, requestId, io }), result };
    }
    case "update": {
      const skillId = requiredSkillId(command);
      assertNoExtraPositionals(command, 1);
      const body = await readUtf8Input(flags, io);
      const requestId = baseRequestId(flags);
      const result = await mutationRequest(
        input,
        requestId,
        managementCliIntentHash({ command, content: Buffer.from(body, "utf8") }),
        async () => {
          const existing = await readSkill(input, skillId);
          const skill = responseField<JsonRecord>(existing, "skill")!;
          return {
            action: "save",
            skillId,
            expectedRevision: requireRevision(flags, "Skill", skill.revision),
            name: flags.name ?? String(skill.name),
            tags: flags.tag.length ? parseCsvFlag(undefined, flags.tag) : skill.tags,
            changes: [{ path: String(skill.entryPath), content: bodyToBase64(body) }],
            dryRun: flags.dryRun,
            requestId,
          };
        },
      );
      return { exitCode: printSuccess({ command, result, requestId, io }), result };
    }
    case "delete": {
      const skillId = requiredSkillId(command);
      assertNoExtraPositionals(command, 1);
      const requestId = baseRequestId(flags);
      const result = await mutationRequest(
        input,
        requestId,
        managementCliIntentHash({ command }),
        async () => {
          const preview = await request(input, { action: "previewDelete", skillId });
          const affectedExpertIds =
            responseField<ReadonlyArray<string>>(preview, "expertIds") ?? [];
          const current = await readSkill(input, skillId);
          const currentSkill = responseField<JsonRecord>(current, "skill")!;
          if (!flags.dryRun && !flags.yes) {
            throw new ManagementCliUsageError(
              `Deletion affects ${affectedExpertIds.length} Expert(s). Review them, then repeat with --yes.`,
            );
          }
          return {
            action: "delete",
            skillId,
            expectedRevision: requireRevision(flags, "Skill", currentSkill.revision),
            confirmExpertIds: affectedExpertIds,
            dryRun: flags.dryRun,
            requestId,
          };
        },
      );
      return { exitCode: printSuccess({ command, result, requestId, io }), result };
    }
    case "import": {
      assertNoExtraPositionals(command, 0);
      const supplied =
        Number(flags.url !== undefined) +
        Number(flags.path !== undefined) +
        Number(flags.file !== undefined);
      if (supplied !== 1)
        throw new ManagementCliUsageError(
          "Choose exactly one of --url, --path, or --file for import.",
        );
      const location = flags.url ?? flags.path ?? flags.file!;
      const kind = flags.url !== undefined ? "url" : "local";
      const requestId = baseRequestId(flags);
      let previewId: string | undefined;
      let previewContentHash: string | undefined;
      const result = await mutationRequest(
        input,
        requestId,
        managementCliIntentHash({ command }),
        async () => {
          const preview = await request(input, {
            action: "previewImport",
            location,
            kind,
            requestId,
          });
          const previewInfo = responseField<JsonRecord>(preview, "preview");
          if (!previewInfo) throw new Error("Import preview returned no preview object.");
          previewId = String(previewInfo.previewId);
          previewContentHash = importPreviewContentHash(previewInfo);
          const packageInfo = previewInfo.package as JsonRecord | undefined;
          const entryPaths =
            responseField<ReadonlyArray<string>>(previewInfo, "selectedEntryPaths") ??
            responseField<ReadonlyArray<JsonRecord>>(packageInfo ?? {}, "entries")?.map((entry) =>
              String(entry.entryPath),
            ) ??
            [];
          const selected = flags.entry
            ? entryPaths.filter((entryPath) => entryPath === flags.entry)
            : entryPaths;
          if (!selected.length)
            throw new ManagementCliUsageError(
              "No import entries matched; use --entry with an entry path from the preview.",
            );
          if (flags.entry && selected.length !== 1)
            throw new ManagementCliUsageError("--entry must identify one entry in the preview.");
          const duplicate = flags.duplicate ?? "skip";
          const replaceSkillId = duplicate === "replace" ? flags.skillId[0] : undefined;
          if (duplicate === "replace" && !replaceSkillId) {
            throw new ManagementCliUsageError(
              "Use one --skill-id with --duplicate replace to name the Skill being replaced.",
            );
          }
          if (duplicate === "replace" && selected.length !== 1) {
            throw new ManagementCliUsageError(
              "--duplicate replace requires exactly one selected import entry.",
            );
          }
          return {
            action: "import",
            previewId,
            choices: selected.map((entryPath) => ({
              entryPath,
              duplicate,
              ...(replaceSkillId ? { replaceSkillId } : {}),
              ...(replaceSkillId
                ? { expectedRevision: requireRevision(flags, "replacement Skill") }
                : {}),
            })),
            dryRun: flags.dryRun,
            requestId,
          };
        },
        async () => {
          if (previewId) {
            await request(input, { action: "cancel", previewId }).catch(() => undefined);
          }
        },
        {
          preparedContentHash: () => previewContentHash,
          recoverExpiredPreview: async (storedContentHash) => {
            if (!storedContentHash) {
              throw new ManagementCliRequestIdConflictError(
                "This saved import request has no source fingerprint; use a new requestId to preview and import again.",
              );
            }
            const preview = await request(input, {
              action: "previewImport",
              location,
              kind,
              requestId,
            });
            const previewInfo = responseField<JsonRecord>(preview, "preview");
            if (!previewInfo) throw new Error("Import preview returned no preview object.");
            previewId = String(previewInfo.previewId);
            if (importPreviewContentHash(previewInfo) !== storedContentHash) {
              throw new ManagementCliRequestIdConflictError(
                "The import source changed since this requestId was prepared; use a new requestId to review the new content.",
              );
            }
          },
        },
      );
      return { exitCode: printSuccess({ command, result, requestId, io }), result };
    }
    case "refresh": {
      const skillIds = refreshedSkillIds(command);
      if (skillIds.length > 1 && flags.expectedRevision !== undefined) {
        throw new ManagementCliUsageError(
          "--expected-revision applies to one Skill. Omit it to read each Skill revision before refreshing multiple Skills.",
        );
      }
      const requestId = baseRequestId(flags);
      const intentHash = managementCliIntentHash({ command });
      let result: JsonRecord;
      if (skillIds.length === 1) {
        const skillId = skillIds[0]!;
        result = await mutationRequest(input, requestId, intentHash, async () => {
          const current = await readSkill(input, skillId);
          const skill = responseField<JsonRecord>(current, "skill")!;
          return {
            action: "updateFromSource",
            skillId,
            expectedRevision: requireRevision(flags, "Skill", skill.revision),
            requestId,
            overwriteLocalEdits: flags.overwriteLocalEdits,
            dryRun: flags.dryRun,
          };
        });
      } else {
        const batchResults: unknown[] = [];
        const batchCount = Math.ceil(skillIds.length / 100);
        for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
          const batchSkillIds = skillIds.slice(batchIndex * 100, (batchIndex + 1) * 100);
          const batchRequestId =
            batchCount === 1 ? requestId : requestIdForRefreshBatch(requestId, batchIndex);
          const batchResult = await mutationRequest(input, batchRequestId, intentHash, async () => {
            const items: Array<{
              readonly operation: "updateFromSource";
              readonly skillId: string;
              readonly expectedRevision: number;
              readonly requestId: string;
              readonly overwriteLocalEdits?: true;
            }> = [];
            for (const skillId of batchSkillIds) {
              const current = await readSkill(input, skillId);
              const skill = responseField<JsonRecord>(current, "skill")!;
              items.push({
                operation: "updateFromSource",
                skillId,
                expectedRevision: requireRevision(flags, "Skill", skill.revision),
                requestId: requestIdForRefreshedSkill(requestId, skillId),
                ...(flags.overwriteLocalEdits ? { overwriteLocalEdits: true } : {}),
              });
            }
            return {
              action: "batch",
              requestId: batchRequestId,
              items,
              dryRun: flags.dryRun,
            };
          });
          batchResults.push(
            ...(responseField<ReadonlyArray<unknown>>(batchResult, "results") ?? []),
          );
        }
        result = { results: batchResults };
      }
      return { exitCode: printSuccess({ command, result, requestId, io }), result };
    }
    case "files-list": {
      const skillId = requiredSkillId(command);
      assertNoExtraPositionals(command, 1);
      const result = await request(input, { action: "read", skillId });
      return { exitCode: printSuccess({ command, result, io }), result };
    }
    case "files-read": {
      const skillId = positional(command, 0, "Skill ID");
      const filePath = flags.path ?? positional(command, 1, "file path");
      assertNoExtraPositionals(command, flags.path ? 1 : 2);
      const result = await request(input, {
        action: "readFile",
        skillId,
        path: filePath,
        ...(flags.expectedRevision ? { expectedRevision: flags.expectedRevision } : {}),
      });
      const file = responseField<JsonRecord>(result, "file");
      if (!file || typeof file.content !== "string")
        throw new Error("Skill file read returned no content.");
      if (!flags.json)
        return { exitCode: printRawBytes(Buffer.from(file.content, "base64"), io), result };
      return { exitCode: printSuccess({ command, result, io }), result };
    }
    case "files-write":
    case "files-delete": {
      const skillId = positional(command, 0, "Skill ID");
      const filePath = flags.path ?? positional(command, 1, "file path");
      assertNoExtraPositionals(command, flags.path ? 1 : 2);
      const content = action === "files-write" ? await readFileInput(flags, io) : undefined;
      const requestId = baseRequestId(flags);
      const result = await mutationRequest(
        input,
        requestId,
        managementCliIntentHash({ command, ...(content ? { content } : {}) }),
        async () => {
          const existing = await readSkill(input, skillId);
          const skill = responseField<JsonRecord>(existing, "skill")!;
          const changes =
            action === "files-delete"
              ? [{ path: filePath }]
              : [{ path: filePath, content: content!.toString("base64") }];
          return {
            action: "save",
            skillId,
            expectedRevision: requireRevision(flags, "Skill", skill.revision),
            name: String(skill.name),
            tags: skill.tags,
            changes,
            dryRun: flags.dryRun,
            requestId,
          };
        },
      );
      return { exitCode: printSuccess({ command, result, requestId, io }), result };
    }
    case "tags-set": {
      const skillId = requiredSkillId(command);
      assertNoExtraPositionals(command, 1);
      const existing = await readSkill(input, skillId);
      const skill = responseField<JsonRecord>(existing, "skill")!;
      if (!flags.tag.length && !flags.clear) {
        throw new ManagementCliUsageError("Provide --tag values or --clear to remove all tags.");
      }
      const tags = flags.clear ? [] : parseCsvFlag(undefined, flags.tag);
      const requestId = baseRequestId(flags);
      const result = await mutationRequest(
        input,
        requestId,
        managementCliIntentHash({ command }),
        async () => {
          const existing = await readSkill(input, skillId);
          const skill = responseField<JsonRecord>(existing, "skill")!;
          return {
            action: "save",
            skillId,
            expectedRevision: requireRevision(flags, "Skill", skill.revision),
            name: String(skill.name),
            tags,
            changes: [],
            dryRun: flags.dryRun,
            requestId,
          };
        },
      );
      return { exitCode: printSuccess({ command, result, requestId, io }), result };
    }
    default:
      throw new ManagementCliUsageError(`Unsupported Skill command: ${action}`);
  }
}

function bodyToBase64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

async function expertSkillsCommand(input: ManagementCliInput): Promise<ManagementCliOutcome> {
  const { command, io } = input;
  const flags = command.flags;
  const action = command.operation.action;
  if (flags.allowEvolution !== undefined && action !== "add" && action !== "set")
    throw new ManagementCliUsageError("--allow-evolution applies to `expert skills add|set`.");
  const requestedExperts = expertIds(flags);
  const positionalExpertId = command.positional[0];
  const selectedExperts = requestedExperts.length
    ? requestedExperts
    : positionalExpertId
      ? [positionalExpertId]
      : [];
  if (!selectedExperts.length)
    throw new ManagementCliUsageError("Provide an Expert ID or --expert-ids.");
  assertNoExtraPositionals(command, requestedExperts.length ? 0 : positionalExpertId ? 1 : 0);
  if (action !== "list" && selectedExperts.length > 1 && flags.expectedRevision !== undefined) {
    throw new ManagementCliUsageError(
      "--expected-revision applies to one Expert. Omit it to read each selected Expert revision before writing.",
    );
  }
  if (
    action === "set" &&
    flags.clear &&
    (flags.skillId.length > 0 || flags.skillIds !== undefined)
  ) {
    throw new ManagementCliUsageError(
      "Use either --clear or Skill IDs with `expert skills set`, not both.",
    );
  }
  const skillIds = action === "list" || (action === "set" && flags.clear) ? [] : allIds(flags);
  const requestId = action === "list" ? undefined : baseRequestId(flags);
  const dryRun = flags.dryRun;
  const intentHash = managementCliIntentHash({ command });

  if (
    action === "add" &&
    selectedExperts.length > 1 &&
    flags.allowEvolution === undefined &&
    (flags.selectionScope === undefined || flags.selectionScope === "entry") &&
    (flags.resourceMode === undefined || flags.resourceMode === "shared-readonly")
  ) {
    const result = await mutationRequest(input, requestId!, intentHash, async () => {
      const targets: Array<{ expertId: string; expectedRevision: number }> = [];
      for (const expertId of selectedExperts) {
        const stateResponse = await request(input, {
          action: "bindings",
          operation: "list",
          expertId,
        });
        const state =
          responseField<JsonRecord>(stateResponse, "bindingResult") ??
          responseField<JsonRecord>(stateResponse, "bindings");
        if (!state || typeof state.revision !== "number") {
          throw new Error(`Could not read current binding revision for Expert ${expertId}.`);
        }
        targets.push({
          expertId,
          expectedRevision: Number(state.revision),
        });
      }
      return {
        action: "bindExperts",
        requestId,
        skillIds,
        targets,
        dryRun,
      };
    });
    return { exitCode: printSuccess({ command, result, requestId, io }), result };
  }

  const results: Array<{
    expertId: string;
    status: "applied" | "would_change" | "conflict" | "failed";
    result?: JsonRecord;
    error?: { code: string; message: string };
  }> = [];
  let singleResult: JsonRecord | undefined;
  for (const expertId of selectedExperts) {
    try {
      if (action === "list") {
        const result = await request(input, { action: "bindings", operation: "list", expertId });
        if (selectedExperts.length === 1) singleResult = result;
        else results.push({ expertId, status: "applied", result });
        continue;
      }
      const expertRequestId = requestIdForExpert(
        requestId ?? randomUUID(),
        expertId,
        selectedExperts.length > 1,
      );
      const result = await mutationRequest(input, expertRequestId, intentHash, async () => {
        const currentResponse = await request(input, {
          action: "bindings",
          operation: "list",
          expertId,
        });
        const current =
          responseField<JsonRecord>(currentResponse, "bindingResult") ??
          responseField<JsonRecord>(currentResponse, "bindings");
        if (!current || typeof current.revision !== "number") {
          throw new Error(`Could not read current binding revision for Expert ${expertId}.`);
        }
        const expectedRevision = flags.expectedRevision ?? Number(current.revision);
        if (action === "add" || action === "set") {
          const currentBindings =
              action === "set" && Array.isArray(current.bindings)
                ? (current.bindings as JsonRecord[])
                : [],
            currentById = new Map(
              currentBindings
                .filter((binding) => typeof binding.skillId === "string")
                .map((binding) => [String(binding.skillId), binding]),
            );
          return {
            action: "bindings",
            operation: action,
            expertId,
            expectedRevision,
            requestId: expertRequestId,
            bindings: skillIds.map((skillId) => {
              const existing = currentById.get(skillId),
                allowEvolution =
                  flags.allowEvolution === undefined
                    ? typeof existing?.allowEvolution === "boolean"
                      ? existing.allowEvolution
                      : undefined
                    : flags.allowEvolution === "true",
                selectionScope =
                  flags.selectionScope ??
                  (existing?.selectionScope === "package" ? "package" : "entry"),
                resourceMode =
                  flags.resourceMode ??
                  (existing?.resourceMode === "run-private" ? "run-private" : "shared-readonly");
              return {
                skillId,
                enabled: true,
                ...(allowEvolution !== undefined ? { allowEvolution } : {}),
                selectionScope,
                resourceMode,
              };
            }),
            dryRun,
          };
        }
        return {
          action: "bindings",
          operation: action,
          expertId,
          expectedRevision,
          requestId: expertRequestId,
          skillIds,
          dryRun,
        };
      });
      if (selectedExperts.length === 1) {
        singleResult = result;
        continue;
      }
      const resultCode = resultExitCode(result);
      results.push({
        expertId,
        status:
          resultCode === SKILL_MANAGEMENT_EXIT_CODES.conflict
            ? "conflict"
            : resultCode === SKILL_MANAGEMENT_EXIT_CODES.success
              ? dryRun
                ? "would_change"
                : "applied"
              : "failed",
        result,
      });
    } catch (cause) {
      if (selectedExperts.length === 1) throw cause;
      const decoded = decodeError(cause);
      results.push({
        expertId,
        status: decoded.exitCode === SKILL_MANAGEMENT_EXIT_CODES.conflict ? "conflict" : "failed",
        error: { code: decoded.code, message: decoded.message },
      });
    }
  }
  const combined = selectedExperts.length === 1 ? singleResult! : { results };
  return { exitCode: printSuccess({ command, result: combined, requestId, io }), result: combined };
}

export async function executeManagementCli(
  input: ManagementCliInput,
): Promise<ManagementCliOutcome> {
  try {
    const outcome =
      input.command.operation.area === "expert-skills"
        ? await expertSkillsCommand(input)
        : await skillCommand(input);
    process.exitCode = outcome.exitCode;
    return outcome;
  } catch (cause) {
    const decoded = decodeError(cause);
    stderr(input.io).write(
      `${JSON.stringify({
        version: 1,
        ok: false,
        command: `${input.command.operation.area} ${input.command.operation.action}`,
        error: { code: decoded.code, message: decoded.message, exitCode: decoded.exitCode },
      })}\n`,
    );
    process.exitCode = decoded.exitCode;
    return { exitCode: decoded.exitCode, error: { code: decoded.code, message: decoded.message } };
  }
}

export async function executeManagementCliArgs(input: {
  readonly namespace: ManagementCliNamespace;
  readonly args: ReadonlyArray<string>;
  readonly flags: ManagementCliFlagValues;
  readonly baseDir: string;
  readonly io?: CliIo;
}): Promise<ManagementCliOutcome> {
  try {
    const command = parseManagementCliCommand({
      namespace: input.namespace,
      args: input.args,
      flags: input.flags,
    });
    return await executeManagementCli({
      command,
      baseDir: input.baseDir,
      ...(input.io ? { io: input.io } : {}),
    });
  } catch (cause) {
    const decoded = decodeError(cause);
    const failure = {
      version: 1,
      ok: false,
      command: input.namespace,
      error: { code: decoded.code, message: decoded.message, exitCode: decoded.exitCode },
    };
    stderr(input.io).write(`${JSON.stringify(failure)}\n`);
    process.exitCode = decoded.exitCode;
    return { exitCode: decoded.exitCode, error: { code: decoded.code, message: decoded.message } };
  }
}
