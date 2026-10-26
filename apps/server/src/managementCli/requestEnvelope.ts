import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

import { Effect, Schema } from "effect";
import { SkillLibraryRequest, type SkillManagementFlavor } from "@synara/contracts";

import { writeFileStringAtomically } from "../atomicWrite";
import { readPrivateJsonFile } from "../experts/ExpertMcpStorage";
import { supportsPosixPermissions } from "../privatePathPermissions";

const MAX_ENVELOPE_BYTES = 32 * 1024 * 1024;
const LOCK_WAIT_MS = 60_000;
const LOCK_POLL_MS = 25;
const EMPTY_LOCK_STALE_MS = 5_000;

export interface ManagementRequestScope {
  readonly credentialId: string;
  readonly instanceId: string;
  readonly flavor: SkillManagementFlavor;
}

interface RequestEnvelope {
  readonly version: 1;
  readonly requestId: string;
  readonly intentHash: string;
  readonly request: unknown;
  readonly preparedContentHash?: string;
  readonly createdAt: string;
}

export interface ManagementRequestEnvelopeEntry {
  readonly request: unknown;
  readonly preparedContentHash?: string;
}

export class ManagementCliRequestIdConflictError extends Error {
  readonly status = 409;
  readonly code = "conflict";

  constructor(message = "This CLI requestId is already bound to different command content.") {
    super(message);
    this.name = "ManagementCliRequestIdConflictError";
  }
}

export class ManagementCliRequestEnvelopeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ManagementCliRequestEnvelopeError";
  }
}

function envelopeHash(scope: ManagementRequestScope, requestId: string): string {
  return createHash("sha256")
    .update(`${scope.credentialId}\0${scope.instanceId}\0${scope.flavor}\0${requestId}`, "utf8")
    .digest("hex");
}

function paths(baseDir: string, scope: ManagementRequestScope, requestId: string) {
  const hash = envelopeHash(scope, requestId);
  const directory = path.join(baseDir, "management-cli");
  return {
    directory,
    envelope: path.join(directory, `request-${hash}.json`),
    lock: path.join(directory, `.request-${hash}.lock`),
  };
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(directory);
  } catch (cause) {
    throw new ManagementCliRequestEnvelopeError(
      "The local management credential directory is unavailable.",
      { cause },
    );
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (supportsPosixPermissions() && (stat.mode & 0o077) !== 0)
  ) {
    throw new ManagementCliRequestEnvelopeError(
      "The local management credential directory is not private.",
    );
  }
}

async function readEnvelope(filePath: string): Promise<RequestEnvelope | undefined> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(filePath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ManagementCliRequestEnvelopeError("Could not inspect the local request envelope.", {
      cause,
    });
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > MAX_ENVELOPE_BYTES ||
    (supportsPosixPermissions() && (stat.mode & 0o077) !== 0)
  ) {
    throw new ManagementCliRequestEnvelopeError("The local request envelope is unsafe.");
  }
  const value = await readPrivateJsonFile(
    filePath,
    MAX_ENVELOPE_BYTES,
    "The local request envelope is unsafe or unreadable.",
    false,
  );
  if (!value || typeof value !== "object") {
    throw new ManagementCliRequestEnvelopeError("The local request envelope is invalid.");
  }
  const envelope = value as Partial<RequestEnvelope>;
  if (
    envelope.version !== 1 ||
    typeof envelope.requestId !== "string" ||
    typeof envelope.intentHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(envelope.intentHash) ||
    typeof envelope.createdAt !== "string" ||
    (envelope.preparedContentHash !== undefined &&
      (typeof envelope.preparedContentHash !== "string" ||
        !/^[a-f0-9]{64}$/u.test(envelope.preparedContentHash))) ||
    envelope.request === undefined
  ) {
    throw new ManagementCliRequestEnvelopeError("The local request envelope is invalid.");
  }
  try {
    const request = Schema.decodeUnknownSync(SkillLibraryRequest)(envelope.request);
    if (!("requestId" in request) || request.requestId !== envelope.requestId) {
      throw new Error("Request ID does not match the stored envelope.");
    }
    return { ...envelope, request } as RequestEnvelope;
  } catch (cause) {
    throw new ManagementCliRequestEnvelopeError("The local request envelope is invalid.", {
      cause,
    });
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function lockIsStale(lockPath: string): Promise<boolean> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(lockPath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw cause;
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (supportsPosixPermissions() && (stat.mode & 0o077) !== 0)
  ) {
    throw new ManagementCliRequestEnvelopeError("The local request envelope lock is unsafe.");
  }
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(lockPath, "utf8")) as unknown;
  } catch {
    return Date.now() - stat.mtimeMs > EMPTY_LOCK_STALE_MS;
  }
  if (!value || typeof value !== "object") return Date.now() - stat.mtimeMs > EMPTY_LOCK_STALE_MS;
  const owner = value as { pid?: unknown };
  if (typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || owner.pid <= 0) {
    return Date.now() - stat.mtimeMs > EMPTY_LOCK_STALE_MS;
  }
  return !processExists(owner.pid);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withEnvelopeLock<A>(lockPath: string, operation: () => Promise<A>): Promise<A> {
  const startedAt = Date.now();
  while (true) {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(
        lockPath,
        fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_WRONLY |
          (supportsPosixPermissions() ? fsConstants.O_NOFOLLOW : 0),
        0o600,
      );
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      if (await lockIsStale(lockPath)) {
        await fs.unlink(lockPath).catch((unlinkCause: unknown) => {
          if ((unlinkCause as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkCause;
        });
        continue;
      }
      if (Date.now() - startedAt >= LOCK_WAIT_MS) {
        throw new ManagementCliRequestEnvelopeError(
          "Another CLI process is preparing this requestId. Retry after it finishes.",
        );
      }
      await sleep(LOCK_POLL_MS);
      continue;
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      await handle.sync();
      await handle.close();
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      await fs.unlink(lockPath).catch((cause: unknown) => {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
          // A stale-lock cleanup or another process has already removed it.
        }
      });
    }
  }
}

/** Persist one exact write request before sending it, so a retry reuses the same CAS payload. */
export async function getOrCreateManagementRequestEnvelopeEntry(input: {
  readonly baseDir: string;
  readonly scope: ManagementRequestScope;
  readonly requestId: string;
  readonly intentHash: string;
  readonly buildRequest: () => Promise<unknown>;
  readonly preparedContentHash?: () => string | undefined;
}): Promise<ManagementRequestEnvelopeEntry> {
  const target = paths(input.baseDir, input.scope, input.requestId);
  await assertPrivateDirectory(target.directory);
  return withEnvelopeLock(target.lock, async () => {
    const existing = await readEnvelope(target.envelope);
    if (existing) {
      if (existing.requestId !== input.requestId || existing.intentHash !== input.intentHash) {
        throw new ManagementCliRequestIdConflictError();
      }
      return {
        request: existing.request,
        ...(existing.preparedContentHash
          ? { preparedContentHash: existing.preparedContentHash }
          : {}),
      };
    }
    const request = Schema.decodeUnknownSync(SkillLibraryRequest)(await input.buildRequest());
    const preparedContentHash = input.preparedContentHash?.();
    const envelope: RequestEnvelope = {
      version: 1,
      requestId: input.requestId,
      intentHash: input.intentHash,
      request,
      ...(preparedContentHash ? { preparedContentHash } : {}),
      createdAt: new Date().toISOString(),
    };
    const serialized = `${JSON.stringify(envelope)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_ENVELOPE_BYTES) {
      throw new ManagementCliRequestEnvelopeError("The request envelope exceeds its size limit.");
    }
    await Effect.runPromise(
      writeFileStringAtomically({ filePath: target.envelope, contents: serialized, mode: 0o600 }),
    );
    return {
      request,
      ...(envelope.preparedContentHash
        ? { preparedContentHash: envelope.preparedContentHash }
        : {}),
    };
  });
}

export async function getOrCreateManagementRequestEnvelope(input: {
  readonly baseDir: string;
  readonly scope: ManagementRequestScope;
  readonly requestId: string;
  readonly intentHash: string;
  readonly buildRequest: () => Promise<unknown>;
}): Promise<unknown> {
  return (await getOrCreateManagementRequestEnvelopeEntry(input)).request;
}

export function managementCliIntentHash(input: {
  readonly command: {
    readonly operation: unknown;
    readonly positional: ReadonlyArray<string>;
    readonly flags: object;
  };
  readonly content?: Uint8Array;
}): string {
  const {
    requestId: _requestId,
    dryRun: _dryRun,
    json: _json,
    ...flags
  } = input.command.flags as Record<string, unknown>;
  return createHash("sha256")
    .update(
      JSON.stringify({
        operation: input.command.operation,
        positional: input.command.positional,
        flags,
        contentHash: input.content
          ? createHash("sha256").update(input.content).digest("hex")
          : undefined,
      }),
      "utf8",
    )
    .digest("hex");
}
