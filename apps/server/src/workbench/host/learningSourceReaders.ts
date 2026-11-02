import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ProjectReadFileInput,
  type ProjectReadFileResult,
} from "@synara/contracts";

import { resolveAttachmentRelativePath } from "../../attachmentPaths.ts";
import type { ManagedAttachmentPrincipal } from "../../managedAttachmentPrincipal.ts";
import type { ManagedAttachmentBlob } from "../../persistence/Services/ManagedAttachments.ts";
import { resolveRealPathWithinRoot } from "../../workspace/realPathContainment.ts";
import {
  isSafeLearningSourceRelativePath,
  LEARNING_SOURCE_DOCUMENT_BYTE_LIMIT,
  LEARNING_SOURCE_QUOTE_CHARACTER_LIMIT,
  LEARNING_SOURCE_TOTAL_BYTE_LIMIT,
  LEARNING_SOURCE_TOTAL_CHARACTER_LIMIT,
  scrubLearningSourceText,
  type LearningSourceAcceptedRuntimeEvent,
  type LearningSourceAttachmentExcerpt,
  type LearningSourceAttachmentRead,
  type LearningSourceAttachmentReadRequest,
  type LearningSourceDocumentReadEvidence,
  type LearningSourceDocumentRead,
  type LearningSourceDocumentReadRequest,
} from "../../experts/evolution/LearningSources.ts";
import type { PersistedProviderRuntimeEvent } from "../../persistence/Services/ProviderRuntimeEvents.ts";

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;

function truncateUtf8Prefix(text: string, maxBytes: number): string | undefined {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.byteLength <= maxBytes) return text;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(encoded.subarray(0, maxBytes), {
      stream: true,
    });
  } catch {
    return undefined;
  }
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function normalizeHash(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (SHA256_PATTERN.test(value)) return value;
  if (/^[a-f0-9]{64}$/u.test(value)) return `sha256:${value}`;
  return undefined;
}

/** Adapt the existing workspace reader without adding another filesystem/path implementation. */
export function workspaceLearningDocumentReader(
  readFile: (input: ProjectReadFileInput) => Promise<ProjectReadFileResult>,
) {
  return async (
    input: LearningSourceDocumentReadRequest,
  ): Promise<LearningSourceDocumentRead | undefined> => {
    if (!isSafeLearningSourceRelativePath(input.relativePath) || !pathIsAbsolute(input.rootPath)) {
      return undefined;
    }
    const maxBytes = Math.min(input.maxBytes, LEARNING_SOURCE_DOCUMENT_BYTE_LIMIT);
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return undefined;
    const result = await readFile({
      cwd: input.rootPath,
      relativePath: input.relativePath,
      maxBytes,
    });
    // The WFS resolves real paths within cwd and rejects non-regular files. Requiring an exact
    // path match also blocks its ordinary unique-suffix fallback for provenance selections.
    if (result.relativePath !== input.relativePath) return undefined;
    const contents =
      result.truncated && Buffer.byteLength(result.contents, "utf8") > maxBytes
        ? truncateUtf8Prefix(result.contents, maxBytes)
        : result.contents;
    if (contents === undefined) return undefined;
    const byteLength = Buffer.byteLength(contents, "utf8");
    if (byteLength > maxBytes) return undefined;
    return {
      relativePath: result.relativePath,
      rootIndex: input.rootIndex,
      text: contents,
      byteLength,
      truncated: result.truncated,
      regularFile: true,
      symlink: result.symlink ?? false,
    };
  };
}

function pathIsAbsolute(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

/**
 * Bounded default managed-blob reader. The caller closes over the current session principal
 * and wraps `ManagedAttachmentRepository.findClaimedById` with its Effect runtime.
 */
export function managedLearningAttachmentReader(input: {
  readonly attachmentsDir: string;
  readonly principal: ManagedAttachmentPrincipal;
  readonly findClaimedById: (attachmentId: string) => Promise<ManagedAttachmentBlob | undefined>;
}) {
  return async (
    request: LearningSourceAttachmentReadRequest,
  ): Promise<LearningSourceAttachmentRead | undefined> => {
    if (
      !Number.isSafeInteger(request.maxBytes) ||
      request.maxBytes < 0 ||
      (!request.metadataOnly && request.maxBytes === 0)
    ) {
      return undefined;
    }
    const blob = await input.findClaimedById(request.attachmentId);
    if (
      !blob ||
      blob.state !== "claimed" ||
      blob.ownerThreadId !== request.threadId ||
      blob.claimMessageId !== request.messageId ||
      blob.ownerKind !== input.principal.ownerKind ||
      blob.ownerId !== input.principal.ownerId ||
      (blob.kind !== "file" && blob.kind !== "image") ||
      blob.sizeBytes === null ||
      !Number.isSafeInteger(blob.sizeBytes) ||
      blob.sizeBytes <= 0 ||
      blob.sizeBytes >
        (blob.kind === "image"
          ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
          : PROVIDER_SEND_TURN_MAX_FILE_BYTES)
    ) {
      return undefined;
    }
    const contentHash = normalizeHash(blob.sha256 ?? undefined);
    if (!contentHash) return undefined;

    if (request.metadataOnly) {
      return {
        ownership: "verified-claimed",
        threadId: request.threadId,
        messageId: request.messageId,
        attachmentId: request.attachmentId,
        mimeType: blob.mimeType,
        byteLength: 0,
        totalBytes: blob.sizeBytes,
        truncated: true,
        contentHash,
        hashIsComplete: true,
      };
    }

    const storagePath = resolveAttachmentRelativePath({
      attachmentsDir: input.attachmentsDir,
      relativePath: blob.relativePath,
    });
    if (!storagePath) return undefined;
    const realPath = await resolveRealPathWithinRoot(input.attachmentsDir, storagePath).catch(
      () => null,
    );
    if (!realPath) return undefined;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      const linkStat = await fs.lstat(storagePath);
      if (linkStat.isSymbolicLink() || !linkStat.isFile()) return undefined;
      const noFollow = fsConstants.O_NOFOLLOW ?? 0;
      handle = await fs.open(realPath, fsConstants.O_RDONLY | noFollow);
      const fileStat = await handle.stat();
      if (!fileStat.isFile() || fileStat.size !== blob.sizeBytes) return undefined;
      const readLength = Math.min(
        request.maxBytes,
        LEARNING_SOURCE_TOTAL_BYTE_LIMIT,
        fileStat.size,
      );
      const buffer = Buffer.alloc(readLength);
      const { bytesRead } =
        readLength > 0 ? await handle.read(buffer, 0, readLength, 0) : { bytesRead: 0 };
      const bytes = buffer.subarray(0, bytesRead);
      if (bytes.byteLength !== readLength) return undefined;
      const fullRead = bytes.byteLength === blob.sizeBytes;
      const hash = sha256(bytes);
      if (fullRead && hash !== contentHash) return undefined;
      return {
        ownership: "verified-claimed",
        threadId: request.threadId,
        messageId: request.messageId,
        attachmentId: request.attachmentId,
        mimeType: blob.mimeType,
        byteLength: bytes.byteLength,
        totalBytes: blob.sizeBytes,
        truncated: !fullRead,
        bytes,
        contentHash: fullRead ? contentHash : hash,
        hashIsComplete: fullRead,
      };
    } catch {
      return undefined;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  };
}

export interface AcceptedLearningSourceContext {
  readonly rootRunId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly roots: ReadonlyArray<string>;
  readonly attachments: ReadonlyArray<{
    readonly attachmentId: string;
    readonly messageId: string;
    readonly absolutePath: string;
  }>;
}

interface NativeReadResult {
  readonly path: string;
  readonly text: string;
  readonly truncated: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function textFromContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const blocks = value.flatMap((block) => {
    const record = asRecord(block);
    if (!record) return [];
    if (record.type === "text" && typeof record.text === "string") return [record.text];
    // ACP ToolCallContent wraps text in `{ type: "content", content: { type: "text" } }`.
    if (record.type === "content") {
      const content = asRecord(record.content);
      if (content?.type === "text" && typeof content.text === "string") return [content.text];
    }
    return [];
  });
  return blocks.length > 0 ? blocks.join("\n") : undefined;
}

function outputIsTruncated(value: unknown): boolean {
  const record = asRecord(value);
  const details = asRecord(record?.details);
  return record?.truncated === true || details?.truncated === true;
}

function likelyEncodedBinary(text: string): boolean {
  const compact = text.trim().replace(/\s+/gu, "");
  return (
    /^data:[^,;]+;base64,/iu.test(compact) ||
    (compact.length >= 128 && /^[A-Za-z0-9+/]+={0,2}$/u.test(compact))
  );
}

function piReadResult(data: Record<string, unknown>): NativeReadResult | undefined {
  if (data.toolName !== "read" || data.kind !== "read" || data.isError === true) return undefined;
  const args = asRecord(data.args);
  if (!isNonEmptyString(args?.path)) return undefined;
  const result = data.result;
  const resultRecord = asRecord(result);
  const text = textFromContent(typeof result === "string" ? result : resultRecord?.content);
  if (!text?.trim() || likelyEncodedBinary(text)) return undefined;
  return {
    path: args.path,
    text,
    truncated: outputIsTruncated(result) || outputIsTruncated(data.rawOutput),
  };
}

function readAcpPath(data: Record<string, unknown>): string | undefined {
  const rawInput = asRecord(data.rawInput);
  if (isNonEmptyString(rawInput?.path)) return rawInput.path;
  const locations = data.locations;
  if (!Array.isArray(locations) || locations.length !== 1) return undefined;
  const location = asRecord(locations[0]);
  return isNonEmptyString(location?.path) ? location.path : undefined;
}

function ompReadResult(data: Record<string, unknown>): NativeReadResult | undefined {
  if (data.kind !== "read") return undefined;
  const rawInput = asRecord(data.rawInput);
  const nativeToolName = rawInput?._toolName ?? rawInput?.toolName ?? rawInput?.tool_name;
  if (nativeToolName !== undefined && nativeToolName !== "read" && nativeToolName !== "read_file") {
    return undefined;
  }
  const path = readAcpPath(data);
  const rawOutput = asRecord(data.rawOutput);
  const outputContent = rawOutput?.content ?? data.content;
  const text = textFromContent(outputContent);
  if (!path || !text?.trim() || likelyEncodedBinary(text)) return undefined;
  return {
    path,
    text,
    truncated: outputIsTruncated(rawOutput),
  };
}

function acceptedReadResult(row: PersistedProviderRuntimeEvent): NativeReadResult | undefined {
  const event = row.event;
  if (event.type !== "item.completed" || event.payload.status !== "completed") return undefined;
  const data = asRecord(event.payload.data);
  if (!data || data.isError === true) return undefined;
  if (event.provider === "pi") return piReadResult(data);
  if (event.provider === "omp") return ompReadResult(data);
  return undefined;
}

function pathApi(value: string): typeof path | typeof path.win32 | undefined {
  if (path.isAbsolute(value)) return path;
  if (path.win32.isAbsolute(value)) return path.win32;
  return undefined;
}

function safeRelativePath(value: string): string | undefined {
  const normalized = value.replaceAll("\\", "/");
  return isSafeLearningSourceRelativePath(normalized) ? normalized : undefined;
}

function rootRelativePath(
  filePath: string,
  roots: ReadonlyArray<string>,
): LearningSourceDocumentReadEvidence | undefined {
  const filePathApi = pathApi(filePath);
  if (!filePathApi) {
    if (roots.length !== 1) return undefined;
    const relativePath = safeRelativePath(filePath);
    return relativePath ? { relativePath, rootIndex: 0 } : undefined;
  }

  const matches = roots.flatMap((root, rootIndex) => {
    if (pathApi(root) !== filePathApi) return [];
    const normalizedRoot = filePathApi.resolve(root);
    const relative = filePathApi.relative(normalizedRoot, filePathApi.resolve(filePath));
    if (!relative || relative === ".." || relative.startsWith(`..${filePathApi.sep}`)) return [];
    const relativePath = safeRelativePath(relative);
    return relativePath ? [{ rootIndex, relativePath, rootLength: normalizedRoot.length }] : [];
  });
  if (matches.length === 0) return undefined;
  const longestRootLength = Math.max(...matches.map((match) => match.rootLength));
  const bestMatches = matches.filter((match) => match.rootLength === longestRootLength);
  if (bestMatches.length !== 1) return undefined;
  const { rootIndex, relativePath } = bestMatches[0]!;
  return { relativePath, rootIndex };
}

function normalizedAbsolutePath(value: string): string | undefined {
  const api = pathApi(value);
  return api ? api.resolve(value) : undefined;
}

function boundedExcerpt(
  text: string,
  alreadyTruncated: boolean,
): { readonly text: string; readonly truncated: boolean } {
  const safeText = scrubLearningSourceText(text);
  const maxLength = Math.min(
    LEARNING_SOURCE_QUOTE_CHARACTER_LIMIT,
    LEARNING_SOURCE_TOTAL_CHARACTER_LIMIT,
  );
  if (safeText.length <= maxLength) return { text: safeText, truncated: alreadyTruncated };
  let end = maxLength;
  const last = safeText.charCodeAt(end - 1);
  const next = safeText.charCodeAt(end);
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  return { text: safeText.slice(0, end), truncated: true };
}

/**
 * Attach current accepted provider rows to the host-owned Run identity and expose read proofs
 * only when a completed native read tool returned actual text for a path in a trusted root or
 * at one exact current managed-attachment path.
 */
export function toAcceptedLearningSourceRows(
  rows: ReadonlyArray<PersistedProviderRuntimeEvent>,
  context: AcceptedLearningSourceContext,
): ReadonlyArray<LearningSourceAcceptedRuntimeEvent> {
  if (!context.rootRunId.trim() || !context.threadId.trim() || !context.turnId.trim()) return [];
  let remainingExcerptCharacters = LEARNING_SOURCE_TOTAL_CHARACTER_LIMIT;

  return rows.flatMap((row) => {
    const event = row.event;
    if (
      !Number.isSafeInteger(row.sequence) ||
      row.sequence < 0 ||
      event.threadId !== context.threadId ||
      event.turnId !== context.turnId
    ) {
      return [];
    }

    const read = acceptedReadResult(row);
    const documentsRead: LearningSourceDocumentReadEvidence[] = [];
    const attachmentExcerpts: LearningSourceAttachmentExcerpt[] = [];
    if (read) {
      const absolutePath = normalizedAbsolutePath(read.path);
      const attachmentMatches = absolutePath
        ? context.attachments.filter(
            (attachment) =>
              normalizedAbsolutePath(attachment.absolutePath) === absolutePath &&
              attachment.attachmentId.trim().length > 0 &&
              attachment.messageId.trim().length > 0,
          )
        : [];
      if (attachmentMatches.length === 1 && remainingExcerptCharacters > 0) {
        const attachment = attachmentMatches[0]!;
        const excerpt = boundedExcerpt(read.text, read.truncated);
        if (excerpt.text.trim()) {
          attachmentExcerpts.push({
            attachmentId: attachment.attachmentId,
            messageId: attachment.messageId,
            text: excerpt.text,
            ...(excerpt.truncated ? { truncated: true } : {}),
          });
          remainingExcerptCharacters -= excerpt.text.length;
        }
      } else if (attachmentMatches.length === 0) {
        const proof = rootRelativePath(read.path, context.roots);
        if (proof) documentsRead.push(proof);
      }
    }

    return [
      {
        accepted: true,
        runId: context.rootRunId,
        sequence: row.sequence,
        event,
        ...(documentsRead.length > 0 ? { documentsRead } : {}),
        ...(attachmentExcerpts.length > 0 ? { attachmentExcerpts } : {}),
      },
    ];
  });
}
