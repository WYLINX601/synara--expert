import { createHash } from "node:crypto";
import path from "node:path";

import {
  LearningSourceSelection,
  type ExpertLearningEvidenceItem,
  type LearningSourceReference,
  type LearningSourceSelection as LearningSourceSelectionType,
  type MemoryScope,
  type OrchestrationMessage,
  type OrchestrationThread,
  type ProviderRuntimeEvent,
  TurnId,
} from "@synara/contracts";
import { Schema } from "effect";

import {
  learningEvidenceDeltaFromRuntimeEvent,
  learningEvidenceMessagesForTurn,
} from "./LearningEvidence.ts";
import { redactSensitiveProcessArgs } from "../../processArgumentRedaction.ts";
import { isSensitiveKey, redactSensitiveJsonFields } from "../../sensitiveKeys.ts";

export const LEARNING_SOURCE_REFERENCE_LIMIT = 5;
export const LEARNING_SOURCE_TOTAL_CHARACTER_LIMIT = 128_000;
export const LEARNING_SOURCE_TOTAL_BYTE_LIMIT = 2 * 1024 * 1024;
export const LEARNING_SOURCE_QUOTE_CHARACTER_LIMIT = 16_000;
export const LEARNING_SOURCE_RUNTIME_EVENT_LIMIT = 128;
export const LEARNING_SOURCE_DOCUMENT_BYTE_LIMIT = 1_000_000;

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const TEXT_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "application/markdown",
]);

export interface LearningSourceFreezeContext {
  /** All identity and applicability fields are supplied by the host. */
  readonly scope: MemoryScope;
  readonly threadId: string;
  readonly turnId: string;
  readonly currentUserMessageId: string;
}

export interface LearningSourceDocumentRoot {
  /** Canonical project root obtained from the host's current project record. */
  readonly canonicalPath: string;
}

export interface LearningSourceProject {
  readonly projectId: string;
  readonly roots: ReadonlyArray<LearningSourceDocumentRoot>;
}

export interface LearningSourceDocumentReadRequest {
  readonly threadId: string;
  readonly projectId: string;
  readonly rootIndex: number;
  readonly rootPath: string;
  readonly relativePath: string;
  /** Enforced by the reader before it opens or reads the source. */
  readonly maxBytes: number;
}

export interface LearningSourceDocumentRead {
  readonly relativePath: string;
  readonly rootIndex: number;
  readonly text: string;
  readonly byteLength: number;
  readonly truncated: boolean;
  /** The host reader confirms this is a regular file. */
  readonly regularFile: boolean;
  /** Host readers can report this so symbolic links can be refused. */
  readonly symlink?: boolean;
}

export interface LearningSourceDocumentReadEvidence {
  readonly relativePath: string;
  readonly rootIndex?: number;
}

export interface LearningSourceAttachmentExcerpt {
  readonly attachmentId: string;
  readonly messageId: string;
  readonly text: string;
  readonly truncated?: boolean;
}

/**
 * This row is returned only from the injected persisted accepted-event reader.
 * The host maps run identity and any document/attachment read proofs while it still
 * has access to its durable event stores; neither is supplied by the model.
 */
export interface LearningSourceAcceptedRuntimeEvent {
  readonly accepted: true;
  readonly runId: string;
  readonly sequence: number;
  readonly event: ProviderRuntimeEvent;
  readonly documentsRead?: ReadonlyArray<LearningSourceDocumentReadEvidence>;
  readonly attachmentExcerpts?: ReadonlyArray<LearningSourceAttachmentExcerpt>;
}

export interface LearningSourceRuntimeReadRequest {
  readonly threadId: string;
  readonly turnId: string;
  readonly eventIds?: ReadonlyArray<string>;
  /** Host-side filters for accepted read proofs; no filesystem scan is requested. */
  readonly documentPaths?: ReadonlyArray<{
    readonly relativePath: string;
    readonly rootIndex?: number;
  }>;
  readonly attachmentIds?: ReadonlyArray<string>;
  readonly maxEvents: number;
  readonly maxBytes: number;
}

export interface LearningSourceAttachmentReadRequest {
  readonly threadId: string;
  readonly messageId: string;
  readonly attachmentId: string;
  /** The managed-attachment reader must enforce this before opening the blob. */
  readonly maxBytes: number;
  /** PDF/image requests use metadata-only ownership verification; no binary read is allowed. */
  readonly metadataOnly: boolean;
}

export interface LearningSourceAttachmentRead {
  /** Must mean the host verified current-principal ownership and claimed message identity. */
  readonly ownership: "verified-claimed";
  readonly threadId: string;
  readonly messageId: string;
  readonly attachmentId: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly totalBytes: number;
  readonly truncated: boolean;
  /** Actual file bytes, bounded by request.maxBytes. The freezer only decodes text MIME types. */
  readonly bytes?: Uint8Array;
  /** A directly managed markdown-text representation, when the attachment reader has one. */
  readonly textMarkdown?: string;
  /** SHA-256 for the full verified blob; may be absent for a prefix read. */
  readonly contentHash?: string;
  readonly hashIsComplete?: boolean;
}

export interface LearningSourceFreezerHost {
  readonly readThread: (threadId: string) => Promise<OrchestrationThread | undefined>;
  readonly readCurrentProject: (input: {
    readonly threadId: string;
    readonly projectId: string;
  }) => Promise<LearningSourceProject | undefined>;
  readonly readRuntimeEvents: (
    input: LearningSourceRuntimeReadRequest,
  ) => Promise<ReadonlyArray<LearningSourceAcceptedRuntimeEvent>>;
  /**
   * Must use the current managed-attachment principal and existing claim/path helpers.
   * It must cap bytes before reading and return `ownership: "verified-claimed"` only when
   * the attachment belongs to the requested thread and accepted user message.
   */
  readonly readAttachment: (
    input: LearningSourceAttachmentReadRequest,
  ) => Promise<LearningSourceAttachmentRead | undefined>;
  /**
   * Optional safe project-reader capability supplied by the host.
   */
  readonly readDocument?: (
    input: LearningSourceDocumentReadRequest,
  ) => Promise<LearningSourceDocumentRead | undefined>;
}

export interface LearningSourceFrozenText {
  readonly ref: LearningSourceReference;
  readonly text: string;
  readonly name?: string;
}

export interface LearningSourceFreezeResult {
  readonly refs: ReadonlyArray<LearningSourceReference>;
  readonly texts: ReadonlyArray<LearningSourceFrozenText>;
  /** Stable reason codes; unavailable sources are omitted rather than treated as read. */
  readonly coverage: ReadonlyArray<string>;
}

interface ReadSource {
  readonly identity: string;
  readonly text: string;
  readonly contentHash: string;
  readonly truncated: boolean;
  readonly redacted: boolean;
  readonly name?: string;
  readonly range?: { readonly startOffset: number; readonly endOffset: number };
  readonly includeQuote: boolean;
  readonly quoteIsExact: boolean;
  readonly makeReference: (input: {
    readonly quote?: string;
    readonly range?: { readonly startOffset: number; readonly endOffset: number };
    readonly truncated: boolean;
  }) => LearningSourceReference;
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isSha256(value: string | undefined): value is string {
  return value !== undefined && SHA256_PATTERN.test(value);
}

function normalizeHash(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (SHA256_PATTERN.test(value)) return value;
  if (/^[a-f0-9]{64}$/u.test(value)) return `sha256:${value}`;
  return undefined;
}

function boundedUtf16(text: string, maxLength: number): { text: string; truncated: boolean } {
  if (text.length <= maxLength) return { text, truncated: false };
  let end = maxLength;
  if (end > 0) {
    const last = text.charCodeAt(end - 1);
    const next = text.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  }
  return { text: text.slice(0, end), truncated: true };
}

function deepRedactJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepRedactJson);
  if (value === null || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = isSensitiveKey(key) ? redactSensitiveJsonFields(key, item) : deepRedactJson(item);
  }
  return output;
}

/** Scrub prose and structured snippets before returning any frozen text. */
export function scrubLearningSourceText(text: string): string {
  let scrubbed = text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object") {
      scrubbed = JSON.stringify(deepRedactJson(parsed));
    }
  } catch {
    // Ordinary prose is scrubbed below.
  }
  return redactSensitiveProcessArgs(scrubbed)
    .replace(
      /\b(api[_ -]?key|access[_ -]?token|auth(?:orization)?|password|passwd|secret|token|cookie)\b\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/giu,
      (_match, key: string) => `${key}=[redacted]`,
    )
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/giu, "$1[redacted]");
}

function hasValidRange(range: { readonly startOffset: number; readonly endOffset: number }) {
  return (
    Number.isSafeInteger(range.startOffset) &&
    Number.isSafeInteger(range.endOffset) &&
    range.startOffset >= 0 &&
    range.endOffset > range.startOffset
  );
}

export function isSafeLearningSourceRelativePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /^[a-z]:/iu.test(value)
  ) {
    return false;
  }
  const segments = value.replaceAll("\\", "/").split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function exactUniqueQuote(source: string, quote: string): number | undefined {
  if (quote.length === 0 || quote.length > LEARNING_SOURCE_QUOTE_CHARACTER_LIMIT) return undefined;
  const first = source.indexOf(quote);
  if (first < 0 || source.indexOf(quote, first + 1) >= 0) return undefined;
  return first;
}

function selectSlice(
  source: string,
  input: {
    readonly quote?: string;
    readonly range?: { readonly startOffset: number; readonly endOffset: number };
  },
):
  | {
      readonly text: string;
      readonly range?: { readonly startOffset: number; readonly endOffset: number };
    }
  | undefined {
  let range = input.range;
  if (range && !hasValidRange(range)) return undefined;
  if (range && range.endOffset > source.length) return undefined;
  if (input.quote !== undefined) {
    const found = exactUniqueQuote(source, input.quote);
    if (found === undefined) return undefined;
    const quoteRange = { startOffset: found, endOffset: found + input.quote.length };
    if (
      range &&
      (quoteRange.startOffset < range.startOffset || quoteRange.endOffset > range.endOffset)
    ) {
      return undefined;
    }
    range = quoteRange;
  }
  if (!range) return { text: source };
  if (range.endOffset > source.length) return undefined;
  // Do not allow a selected range to split a UTF-16 surrogate pair.
  const startsOnLowSurrogate =
    range.startOffset > 0 &&
    source.charCodeAt(range.startOffset) >= 0xdc00 &&
    source.charCodeAt(range.startOffset) <= 0xdfff;
  const endsAfterHighSurrogate =
    range.endOffset > 0 &&
    source.charCodeAt(range.endOffset - 1) >= 0xd800 &&
    source.charCodeAt(range.endOffset - 1) <= 0xdbff;
  if (startsOnLowSurrogate || endsAfterHighSurrogate) return undefined;
  return { text: source.slice(range.startOffset, range.endOffset), range };
}

function eventIsForContext(
  row: LearningSourceAcceptedRuntimeEvent,
  context: LearningSourceFreezeContext,
): boolean {
  return (
    row.accepted === true &&
    typeof row.runId === "string" &&
    row.runId.length > 0 &&
    Number.isSafeInteger(row.sequence) &&
    row.sequence >= 0 &&
    row.event.threadId === context.threadId &&
    row.event.turnId === context.turnId
  );
}

function runtimeLearningEvidence(row: LearningSourceAcceptedRuntimeEvent) {
  try {
    const delta = learningEvidenceDeltaFromRuntimeEvent({
      sequence: row.sequence,
      event: row.event,
    });
    if (delta.items.length === 0) return undefined;
    return {
      text: delta.items.map((item: ExpertLearningEvidenceItem) => item.text).join("\n"),
      items: delta.items,
      truncated:
        delta.items.some((item) => item.truncated === true) ||
        delta.coverage.some((label) => label.includes("truncated")),
      redacted: delta.coverage.some((label) => label.includes("redact")),
    };
  } catch {
    return undefined;
  }
}

function runtimeReadProofsMatch(
  row: LearningSourceAcceptedRuntimeEvent,
  relativePath: string,
  rootIndex: number,
): boolean {
  return (row.documentsRead ?? []).some(
    (proof) =>
      proof.relativePath === relativePath &&
      (proof.rootIndex === undefined || proof.rootIndex === rootIndex),
  );
}

function isPathTokenCharacter(value: string | undefined): boolean {
  return value !== undefined && /^[\p{L}\p{N}\p{M}_~%+\-\\/]$/u.test(value);
}

function previousCodePoint(text: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  const last = text.charCodeAt(index - 1);
  if (last >= 0xdc00 && last <= 0xdfff && index > 1) {
    const first = text.charCodeAt(index - 2);
    if (first >= 0xd800 && first <= 0xdbff) return text.slice(index - 2, index);
  }
  return text.slice(index - 1, index);
}

function nextCodePoint(text: string, index: number): string | undefined {
  if (index >= text.length) return undefined;
  const first = text.charCodeAt(index);
  if (first >= 0xd800 && first <= 0xdbff && index + 1 < text.length) {
    const last = text.charCodeAt(index + 1);
    if (last >= 0xdc00 && last <= 0xdfff) return text.slice(index, index + 2);
  }
  return text.slice(index, index + 1);
}

function hasBoundedPathMention(text: string, candidate: string): boolean {
  if (!candidate) return false;
  let start = text.indexOf(candidate);
  while (start >= 0) {
    const end = start + candidate.length;
    const before = previousCodePoint(text, start);
    const after = nextCodePoint(text, end);
    const afterExtensionDot =
      after === "." && isPathTokenCharacter(nextCodePoint(text, end + after.length));
    if (
      !isPathTokenCharacter(before) &&
      before !== "." &&
      !isPathTokenCharacter(after) &&
      !afterExtensionDot
    ) {
      return true;
    }
    start = text.indexOf(candidate, start + 1);
  }
  return false;
}

function absolutePathCandidates(rootPath: string, relativePath: string): ReadonlyArray<string> {
  const pathApi = path.posix.isAbsolute(rootPath)
    ? path.posix
    : path.win32.isAbsolute(rootPath)
      ? path.win32
      : undefined;
  if (!pathApi) return [];
  const absolutePath = pathApi.resolve(rootPath, ...relativePath.replaceAll("\\", "/").split("/"));
  return [absolutePath, absolutePath.replaceAll("/", "\\"), absolutePath.replaceAll("\\", "/")];
}

function isMentionedByCurrentUser(text: string, relativePath: string, rootPath: string): boolean {
  const relativeWithForwardSlashes = relativePath.replaceAll("\\", "/");
  const relativeWithBackslashes = relativeWithForwardSlashes.replaceAll("/", "\\");
  const candidates = new Set([
    relativeWithForwardSlashes,
    relativeWithBackslashes,
    `./${relativeWithForwardSlashes}`,
    `.\\${relativeWithBackslashes}`,
    ...absolutePathCandidates(rootPath, relativeWithForwardSlashes),
  ]);
  return [...candidates].some((candidate) => hasBoundedPathMention(text, candidate));
}

function selectedAttachment(message: OrchestrationMessage, attachmentId: string) {
  return (message.attachments ?? []).find((attachment) => attachment.id === attachmentId);
}

function actualByteLength(bytes: Uint8Array): number {
  return bytes.byteLength;
}

function decodeUtf8Source(bytes: Uint8Array, truncated: boolean): string {
  // Streaming decode omits a final partial code point from a byte-bounded prefix while still
  // rejecting malformed UTF-8 in the part that will be frozen.
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: truncated });
}

function makeOutputReference(
  source: ReadSource,
  text: string,
  truncated: boolean,
): LearningSourceReference {
  const safeRange = source.quoteIsExact ? source.range : undefined;
  const quote =
    source.includeQuote &&
    source.quoteIsExact &&
    !truncated &&
    text.length <= LEARNING_SOURCE_QUOTE_CHARACTER_LIMIT
      ? text
      : undefined;
  const reference = source.makeReference({
    ...(quote !== undefined ? { quote } : {}),
    ...(safeRange ? { range: safeRange } : {}),
    truncated,
  });
  return {
    ...reference,
    ...(source.quoteIsExact && text === source.text && (source.includeQuote || safeRange)
      ? { fragmentHash: sha256(text) }
      : {}),
  };
}

function makeSelectionRange(selection: LearningSourceSelectionType) {
  switch (selection.kind) {
    case "message":
    case "attachment":
      return selection.range;
    case "document":
      if (selection.startOffset === undefined && selection.endOffset === undefined)
        return undefined;
      if (selection.startOffset === undefined || selection.endOffset === undefined) return null;
      return { startOffset: selection.startOffset, endOffset: selection.endOffset };
    case "runtime":
      return undefined;
  }
}

/** Freeze exact host-authorized sources into bounded, scrubbed text plus typed provenance. */
export function createLearningSourceFreezer(host: LearningSourceFreezerHost) {
  return {
    async freeze(
      context: LearningSourceFreezeContext,
      selections: ReadonlyArray<LearningSourceSelectionType>,
    ): Promise<LearningSourceFreezeResult> {
      const refs: LearningSourceReference[] = [];
      const texts: LearningSourceFrozenText[] = [];
      const coverage = new Set<string>();
      const selected = selections.slice(0, LEARNING_SOURCE_REFERENCE_LIMIT);
      if (selections.length > selected.length) coverage.add("source-reference-limit-truncated");
      if (selected.length === 0) return { refs, texts, coverage: [...coverage] };

      const decodedSelections: LearningSourceSelectionType[] = [];
      for (const selection of selected) {
        try {
          decodedSelections.push(Schema.decodeUnknownSync(LearningSourceSelection)(selection));
        } catch {
          coverage.add("invalid-source-selection");
        }
      }
      if (decodedSelections.length === 0) return { refs, texts, coverage: [...coverage] };

      let thread: OrchestrationThread | undefined;
      try {
        thread = await host.readThread(context.threadId);
      } catch {
        coverage.add("current-thread-unavailable");
      }
      if (
        !thread ||
        thread.id !== context.threadId ||
        thread.projectId !== context.scope.projectId
      ) {
        coverage.add("current-thread-unavailable");
        return { refs, texts, coverage: [...coverage] };
      }

      const selectedMessageCandidate = thread.messages.find(
        (message) => message.id === context.currentUserMessageId && message.role === "user",
      );
      const currentTurnId = TurnId.makeUnsafe(context.turnId);
      const selectedMessage =
        selectedMessageCandidate &&
        (selectedMessageCandidate.turnId === null ||
          selectedMessageCandidate.turnId === currentTurnId)
          ? selectedMessageCandidate
          : undefined;
      const allowedMessages = learningEvidenceMessagesForTurn({
        messages: thread.messages,
        turnId: currentTurnId,
        pendingMessageId: context.currentUserMessageId,
      });
      const allowedMessageIds = new Set(allowedMessages.items.map((item) => item.id));

      const needsRuntime = decodedSelections.some(
        (selection) =>
          selection.kind === "runtime" ||
          selection.kind === "document" ||
          selection.kind === "attachment",
      );
      let runtimeRows: ReadonlyArray<LearningSourceAcceptedRuntimeEvent> = [];
      if (needsRuntime) {
        const requestedEventIds = decodedSelections.flatMap((selection) =>
          selection.kind === "runtime" ? [selection.eventId] : [],
        );
        const needsTurnReadProofs = decodedSelections.some(
          (selection) => selection.kind === "document" || selection.kind === "attachment",
        );
        const documentPaths = decodedSelections.flatMap((selection) =>
          selection.kind === "document" && isSafeLearningSourceRelativePath(selection.relativePath)
            ? [
                {
                  relativePath: selection.relativePath.replaceAll("\\", "/"),
                  ...(selection.rootIndex !== undefined ? { rootIndex: selection.rootIndex } : {}),
                },
              ]
            : [],
        );
        const attachmentIds = decodedSelections.flatMap((selection) =>
          selection.kind === "attachment" ? [selection.attachmentId] : [],
        );
        try {
          runtimeRows = await host.readRuntimeEvents({
            threadId: context.threadId,
            turnId: context.turnId,
            ...(!needsTurnReadProofs && requestedEventIds.length > 0
              ? { eventIds: requestedEventIds }
              : {}),
            ...(documentPaths.length > 0 ? { documentPaths } : {}),
            ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
            maxEvents: LEARNING_SOURCE_RUNTIME_EVENT_LIMIT,
            maxBytes: LEARNING_SOURCE_TOTAL_BYTE_LIMIT,
          });
        } catch {
          coverage.add("runtime-source-unavailable");
        }
        if (runtimeRows.length > LEARNING_SOURCE_RUNTIME_EVENT_LIMIT) {
          runtimeRows = runtimeRows.slice(0, LEARNING_SOURCE_RUNTIME_EVENT_LIMIT);
          coverage.add("runtime-source-event-limit-truncated");
        }
        runtimeRows = runtimeRows.filter((row) => eventIsForContext(row, context));
      }

      const wantsDocuments = decodedSelections.some((selection) => selection.kind === "document");
      let project: LearningSourceProject | undefined;
      if (wantsDocuments) {
        try {
          project = await host.readCurrentProject({
            threadId: context.threadId,
            projectId: context.scope.projectId,
          });
        } catch {
          coverage.add("current-project-unavailable");
        }
        if (
          !project ||
          project.projectId !== context.scope.projectId ||
          project.roots.length === 0
        ) {
          coverage.add("current-project-unavailable");
          project = undefined;
        }
      }

      const identities = new Set<string>();
      let totalCharacters = 0;
      let remainingBytes = LEARNING_SOURCE_TOTAL_BYTE_LIMIT;
      for (const selection of decodedSelections) {
        let source: ReadSource | undefined;
        const range = makeSelectionRange(selection);
        const quote = "quote" in selection ? selection.quote : undefined;
        if (range === null) {
          coverage.add("invalid-source-range");
          continue;
        }

        if (selection.kind === "message") {
          const message = thread.messages.find((item) => item.id === selection.messageId);
          if (!message || !allowedMessageIds.has(message.id) || !message.text) {
            coverage.add("message-source-not-in-current-turn");
            continue;
          }
          const rawText = boundedUtf16(message.text, LEARNING_SOURCE_TOTAL_CHARACTER_LIMIT);
          if (rawText.truncated) coverage.add("message-source-truncated");
          const safeText = scrubLearningSourceText(rawText.text);
          if (range && safeText !== rawText.text) {
            coverage.add("message-range-unverifiable-after-redaction");
            continue;
          }
          const slice = selectSlice(safeText, {
            ...(quote !== undefined ? { quote } : {}),
            ...(range ? { range } : {}),
          });
          if (!slice || slice.text.length === 0) {
            coverage.add(quote ? "message-quote-not-exact" : "message-range-invalid");
            continue;
          }
          const contentHash = sha256(rawText.text);
          source = {
            identity: `message:${message.id}`,
            text: slice.text,
            contentHash,
            truncated: rawText.truncated,
            redacted: safeText !== rawText.text,
            ...(slice.range ? { range: slice.range } : {}),
            includeQuote: quote !== undefined,
            quoteIsExact: safeText === rawText.text,
            makeReference: (referenceInput) => ({
              kind: "message",
              messageId: message.id,
              threadId: context.threadId,
              ...(message.turnId ? { turnId: message.turnId } : {}),
              role: message.role as "user" | "assistant",
              contentHash,
              ...(referenceInput.quote ? { quote: referenceInput.quote } : {}),
              ...(referenceInput.range ? referenceInput.range : {}),
              ...(referenceInput.truncated ? { truncated: true } : {}),
            }),
          };
        } else if (selection.kind === "runtime") {
          const row = runtimeRows.find((item) => item.event.eventId === selection.eventId);
          if (!row) {
            coverage.add("runtime-event-not-accepted-for-current-turn");
            continue;
          }
          const evidence = runtimeLearningEvidence(row);
          if (!evidence) {
            coverage.add("runtime-event-has-no-learning-evidence");
            continue;
          }
          const safeText = scrubLearningSourceText(evidence.text);
          const slice = selectSlice(safeText, quote !== undefined ? { quote } : {});
          if (!slice || !slice.text) {
            coverage.add("runtime-quote-not-exact");
            continue;
          }
          const contentHash = sha256(evidence.text);
          const item = evidence.items[0];
          if (evidence.truncated) coverage.add("runtime-source-evidence-truncated");
          source = {
            identity: `runtime:${row.event.eventId}`,
            text: slice.text,
            contentHash,
            truncated: evidence.truncated,
            redacted: safeText !== evidence.text || evidence.redacted,
            ...(slice.range ? { range: slice.range } : {}),
            includeQuote: quote !== undefined,
            quoteIsExact: safeText === evidence.text,
            makeReference: (referenceInput) => ({
              kind: "runtime",
              runId: row.runId,
              eventId: row.event.eventId,
              eventSequence: row.sequence,
              ...(item?.toolCallId ? { toolCallId: item.toolCallId } : {}),
              contentHash,
              ...(referenceInput.quote ? { quote: referenceInput.quote } : {}),
              ...(referenceInput.range ? referenceInput.range : {}),
              ...(referenceInput.truncated ? { truncated: true } : {}),
            }),
          };
        } else if (selection.kind === "document") {
          if (
            !project ||
            !host.readDocument ||
            !isSafeLearningSourceRelativePath(selection.relativePath)
          ) {
            coverage.add(
              host.readDocument
                ? "document-path-invalid-or-outside-project"
                : "document-reader-unavailable",
            );
            continue;
          }
          const normalizedPath = selection.relativePath.replaceAll("\\", "/");
          if (normalizedPath.length > 200) {
            coverage.add("document-source-id-too-long");
            continue;
          }
          const rootIndex = selection.rootIndex ?? 0;
          const root = project.roots[rootIndex];
          if (
            !root ||
            (!path.isAbsolute(root.canonicalPath) && !path.win32.isAbsolute(root.canonicalPath))
          ) {
            coverage.add("document-root-not-in-current-project");
            continue;
          }
          const mentioned = selectedMessage
            ? isMentionedByCurrentUser(selectedMessage.text, normalizedPath, root.canonicalPath)
            : false;
          const readInRuntime = runtimeRows.some((row) =>
            runtimeReadProofsMatch(row, normalizedPath, rootIndex),
          );
          if (!mentioned && !readInRuntime) {
            coverage.add("document-not-named-or-read-in-current-turn");
            continue;
          }
          const requestedBytes = Math.min(remainingBytes, LEARNING_SOURCE_DOCUMENT_BYTE_LIMIT);
          if (requestedBytes <= 0) {
            coverage.add("source-byte-budget-exhausted");
            continue;
          }
          let read: LearningSourceDocumentRead | undefined;
          try {
            read = await host.readDocument({
              threadId: context.threadId,
              projectId: context.scope.projectId,
              rootIndex,
              rootPath: root.canonicalPath,
              relativePath: normalizedPath,
              maxBytes: requestedBytes,
            });
          } catch {
            coverage.add("document-source-unavailable");
            continue;
          }
          if (
            !read ||
            read.relativePath !== normalizedPath ||
            read.rootIndex !== rootIndex ||
            read.symlink === true ||
            read.regularFile !== true ||
            !Number.isSafeInteger(read.byteLength) ||
            read.byteLength < 0 ||
            read.byteLength > requestedBytes ||
            Buffer.byteLength(read.text, "utf8") !== read.byteLength ||
            Buffer.byteLength(read.text, "utf8") > requestedBytes
          ) {
            coverage.add(
              read?.symlink ? "document-symlink-rejected" : "document-source-unsafe-or-invalid",
            );
            continue;
          }
          remainingBytes -= read.byteLength;
          const contentHash = sha256(read.text);
          if (selection.expectedHash !== undefined && selection.expectedHash !== contentHash) {
            coverage.add("document-content-hash-mismatch");
            continue;
          }
          const safeText = scrubLearningSourceText(read.text);
          if (range && safeText !== read.text) {
            coverage.add("document-range-unverifiable-after-redaction");
            continue;
          }
          const slice = selectSlice(safeText, {
            ...(quote !== undefined ? { quote } : {}),
            ...(range ? { range } : {}),
          });
          if (!slice || !slice.text) {
            coverage.add(quote ? "document-quote-not-exact" : "document-range-invalid");
            continue;
          }
          const contentId = `${context.scope.projectId}:${rootIndex}:${normalizedPath}`;
          if (contentId.length > 200) {
            coverage.add("document-source-id-too-long");
            continue;
          }
          const truncated = read.truncated;
          source = {
            identity: `document:${contentId}`,
            text: slice.text,
            contentHash,
            truncated,
            redacted: safeText !== read.text,
            name: normalizedPath,
            ...(slice.range ? { range: slice.range } : {}),
            includeQuote: quote !== undefined,
            quoteIsExact: safeText === read.text,
            makeReference: (referenceInput) => ({
              kind: "document",
              documentId: contentId,
              contentHash,
              ...(referenceInput.quote ? { quote: referenceInput.quote } : {}),
              ...(referenceInput.range ? referenceInput.range : {}),
              ...(referenceInput.truncated ? { truncated: true } : {}),
            }),
          };
        } else {
          const messageId = selection.messageId ?? context.currentUserMessageId;
          if (messageId !== context.currentUserMessageId || !selectedMessage) {
            coverage.add("attachment-not-owned-by-current-user-message");
            continue;
          }
          const inline = selectedAttachment(selectedMessage, selection.attachmentId);
          if (!inline) {
            coverage.add("attachment-not-in-current-user-message");
            continue;
          }
          if (inline.type === "assistant-selection") {
            coverage.add("attachment-not-managed");
            continue;
          }
          let rawText: string | undefined;
          let contentHash: string | undefined;
          let truncated = false;
          let name: string | undefined;
          const isTextAttachment = TEXT_MIME_TYPES.has(inline.mimeType.toLowerCase());
          if (isTextAttachment && remainingBytes <= 0) {
            coverage.add("source-byte-budget-exhausted");
            continue;
          }
          let read: LearningSourceAttachmentRead | undefined;
          try {
            read = await host.readAttachment({
              threadId: context.threadId,
              messageId,
              attachmentId: selection.attachmentId,
              maxBytes: isTextAttachment ? remainingBytes : 0,
              metadataOnly: !isTextAttachment,
            });
          } catch {
            coverage.add("managed-attachment-source-unavailable");
            continue;
          }
          if (
            !read ||
            read.ownership !== "verified-claimed" ||
            read.threadId !== context.threadId ||
            read.messageId !== messageId ||
            read.attachmentId !== selection.attachmentId ||
            !Number.isSafeInteger(read.byteLength) ||
            !Number.isSafeInteger(read.totalBytes) ||
            read.byteLength < 0 ||
            read.totalBytes < read.byteLength ||
            read.byteLength > remainingBytes
          ) {
            coverage.add("managed-attachment-ownership-or-size-invalid");
            continue;
          }
          if (read.mimeType.toLowerCase() !== inline.mimeType.toLowerCase()) {
            coverage.add("managed-attachment-mime-mismatch");
            continue;
          }
          if (!isTextAttachment && (read.byteLength !== 0 || read.bytes !== undefined)) {
            coverage.add("binary-attachment-read-rejected");
            continue;
          }
          name = inline.name;
          remainingBytes -= read.byteLength;
          truncated = read.truncated || read.totalBytes > read.byteLength;
          const metadataHash = normalizeHash(read.contentHash);
          if (selection.expectedHash !== undefined) {
            if (!metadataHash || read.hashIsComplete !== true) {
              coverage.add("attachment-expected-hash-unverifiable");
              continue;
            }
            if (selection.expectedHash !== metadataHash) {
              coverage.add("attachment-content-hash-mismatch");
              continue;
            }
          }
          if (read.textMarkdown !== undefined && TEXT_MIME_TYPES.has(read.mimeType.toLowerCase())) {
            rawText = read.textMarkdown;
            if (Buffer.byteLength(rawText, "utf8") > read.byteLength) {
              coverage.add("managed-attachment-size-mismatch");
              continue;
            }
            contentHash = metadataHash ?? sha256(rawText);
          } else if (read.bytes && TEXT_MIME_TYPES.has(read.mimeType.toLowerCase())) {
            try {
              rawText = decodeUtf8Source(read.bytes, truncated);
            } catch {
              coverage.add("attachment-text-encoding-unsupported");
              continue;
            }
            if (actualByteLength(read.bytes) !== read.byteLength) {
              coverage.add("managed-attachment-size-mismatch");
              continue;
            }
            contentHash = metadataHash ?? sha256(read.bytes);
          } else {
            // PDFs and images are accepted only through a scrubbed excerpt on an exact
            // persisted accepted event for this same attachment and user message.
            const excerpts = runtimeRows
              .filter((row) => eventIsForContext(row, context))
              .flatMap((row) =>
                (row.attachmentExcerpts ?? [])
                  .filter(
                    (item) =>
                      item.attachmentId === selection.attachmentId && item.messageId === messageId,
                  )
                  .map((item) => ({ row, item })),
              );
            if (excerpts.length === 0) {
              coverage.add("attachment-not-read-in-current-turn");
              continue;
            }

            let excerpt: (typeof excerpts)[number] | undefined;
            if (quote !== undefined || range !== undefined) {
              let rangeUnverifiable = false;
              const matching = excerpts.flatMap((candidate) => {
                const safeText = scrubLearningSourceText(candidate.item.text);
                if (range && safeText !== candidate.item.text) {
                  rangeUnverifiable = true;
                  return [];
                }
                const slice = selectSlice(safeText, {
                  ...(quote !== undefined ? { quote } : {}),
                  ...(range ? { range } : {}),
                });
                return slice && slice.text ? [{ ...candidate, selectedText: slice.text }] : [];
              });
              if (matching.length === 0) {
                coverage.add(
                  range
                    ? rangeUnverifiable
                      ? "attachment-range-unverifiable-after-redaction"
                      : "attachment-range-invalid"
                    : "attachment-quote-not-exact",
                );
                continue;
              }
              const selectedTexts = new Set(matching.map((candidate) => candidate.selectedText));
              if (selectedTexts.size > 1) {
                coverage.add(range ? "attachment-range-ambiguous" : "attachment-source-ambiguous");
                continue;
              }
              excerpt = matching.toSorted(
                (left, right) => right.row.sequence - left.row.sequence,
              )[0];
            } else {
              const latestSequence = Math.max(
                ...excerpts.map((candidate) => candidate.row.sequence),
              );
              const latest = excerpts.filter(
                (candidate) => candidate.row.sequence === latestSequence,
              );
              if (new Set(latest.map((candidate) => candidate.item.text)).size > 1) {
                coverage.add("attachment-excerpt-ambiguous");
                continue;
              }
              excerpt = latest[0];
            }
            if (!excerpt) {
              coverage.add("attachment-not-read-in-current-turn");
              continue;
            }
            rawText = excerpt.item.text;
            const excerptByteLength = Buffer.byteLength(rawText, "utf8");
            if (excerptByteLength > remainingBytes) {
              coverage.add("source-byte-budget-exhausted");
              continue;
            }
            remainingBytes -= excerptByteLength;
            contentHash = sha256(rawText);
            truncated = excerpt.item.truncated ?? false;
            name = inline.name;
          }
          if (!rawText || !contentHash || !isSha256(contentHash)) {
            coverage.add("attachment-text-unavailable");
            continue;
          }
          const safeText = scrubLearningSourceText(rawText);
          if (range && safeText !== rawText) {
            coverage.add("attachment-range-unverifiable-after-redaction");
            continue;
          }
          const slice = selectSlice(safeText, {
            ...(quote !== undefined ? { quote } : {}),
            ...(range ? { range } : {}),
          });
          if (!slice || !slice.text) {
            coverage.add(quote ? "attachment-quote-not-exact" : "attachment-range-invalid");
            continue;
          }
          source = {
            identity: `attachment:${selection.attachmentId}:${messageId}`,
            text: slice.text,
            contentHash,
            truncated,
            redacted: safeText !== rawText,
            ...(name ? { name } : {}),
            ...(slice.range ? { range: slice.range } : {}),
            includeQuote: quote !== undefined,
            quoteIsExact: safeText === rawText,
            makeReference: (referenceInput) => ({
              kind: "attachment",
              attachmentId: selection.attachmentId,
              messageId,
              contentHash: contentHash!,
              ...(referenceInput.quote ? { quote: referenceInput.quote } : {}),
              ...(referenceInput.range ? referenceInput.range : {}),
              ...(referenceInput.truncated ? { truncated: true } : {}),
            }),
          };
        }

        if (!source) continue;
        if (identities.has(source.identity)) {
          coverage.add("duplicate-source-selection");
          continue;
        }
        identities.add(source.identity);

        const safeText = source.text;
        const bounded = boundedUtf16(
          safeText,
          Math.max(0, LEARNING_SOURCE_TOTAL_CHARACTER_LIMIT - totalCharacters),
        );
        if (!bounded.text) {
          coverage.add("source-character-budget-exhausted");
          continue;
        }
        totalCharacters += bounded.text.length;
        const textTruncated = source.truncated || bounded.truncated;
        if (textTruncated) coverage.add("source-text-truncated");
        if (source.redacted) coverage.add("source-sensitive-content-redacted");
        const outputRange = source.range
          ? {
              startOffset: source.range.startOffset,
              endOffset: Math.min(
                source.range.endOffset,
                source.range.startOffset + bounded.text.length,
              ),
            }
          : source.quoteIsExact && bounded.truncated
            ? { startOffset: 0, endOffset: bounded.text.length }
            : undefined;
        const ref = makeOutputReference(
          {
            ...source,
            ...(outputRange ? { range: outputRange } : {}),
            ...(bounded.truncated ? { includeQuote: false } : {}),
          },
          bounded.text,
          textTruncated,
        );
        refs.push(ref);
        texts.push({ ref, text: bounded.text, ...(source.name ? { name: source.name } : {}) });
      }

      return { refs, texts, coverage: [...coverage] };
    },
  };
}
