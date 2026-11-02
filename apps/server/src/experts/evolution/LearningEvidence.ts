import type {
  ExpertLearningEvidenceItem,
  OrchestrationMessage,
  ProviderRuntimeEvent,
  TurnId,
} from "@synara/contracts";
import { redactSensitiveProcessArgs } from "../../processArgumentRedaction.ts";
import { isSensitiveKey, redactSensitiveJsonFields } from "../../sensitiveKeys.ts";
interface LearningRuntimeEvidenceEvent {
  readonly sequence: number;
  readonly event: ProviderRuntimeEvent;
}

export const LEARNING_EVIDENCE_ITEM_LIMIT = 128;
export const LEARNING_EVIDENCE_ITEM_TEXT_LIMIT = 8_000;
export const LEARNING_EVIDENCE_TOTAL_TEXT_LIMIT = 128_000;
export const LEARNING_EVIDENCE_TRANSCRIPT_TAIL_LIMIT = 128;

export interface LearningEvidenceDelta {
  readonly items: ReadonlyArray<ExpertLearningEvidenceItem>;
  readonly coverage: ReadonlyArray<string>;
}

export interface LearningEvidenceMessageSlice {
  readonly items: ReadonlyArray<ExpertLearningEvidenceItem>;
  readonly coverage: ReadonlyArray<string>;
  readonly hasUserMessage: boolean;
  readonly hasAssistantMessage: boolean;
}

const TOOL_ITEM_TYPES = new Set([
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "dynamic_tool_call",
  "collab_agent_tool_call",
  "web_search",
  "image_view",
  "image_generation",
]);
const TOOL_CALL_METADATA_FIELDS = new Set([
  "tool",
  "toolName",
  "toolCallId",
  "callID",
  "command",
  "arguments",
  "input",
  "params",
  "path",
  "filePath",
  "url",
  "query",
  "provider",
]);
const TOOL_RESULT_METADATA_FIELDS = new Set([
  "tool",
  "toolName",
  "toolCallId",
  "callID",
  "exitCode",
  "status",
  "output",
  "stdout",
  "stderr",
  "result",
  "error",
  "summary",
  "content",
  "structured",
  "provider",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedText(value: string, limit = LEARNING_EVIDENCE_ITEM_TEXT_LIMIT) {
  if (value.length <= limit) return { text: value, truncated: false };
  let end = limit - 1;
  const codeUnit = value.charCodeAt(end - 1);
  if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) end -= 1;
  return { text: `${value.slice(0, end)}…`, truncated: true };
}

interface SanitizedToolValue {
  readonly value: unknown;
  readonly omitted: boolean;
  readonly redacted: boolean;
}

function sanitizedToolValue(value: unknown): SanitizedToolValue {
  let budget = 80;
  let omitted = false;
  let redacted = false;
  const visit = (current: unknown, depth: number): unknown => {
    budget -= 1;
    if (budget < 0 || depth > 5) {
      omitted = true;
      return "[omitted: evidence limit]";
    }
    if (typeof current === "string") {
      const trimmed = current.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          const parsed: unknown = JSON.parse(current);
          if (typeof parsed === "object" && parsed !== null) {
            return visit(parsed, depth + 1);
          }
        } catch {
          // Retain a bounded command/result string after the process-argument scrubber.
        }
      }
      return boundedText(redactSensitiveProcessArgs(current), 1_500).text;
    }
    if (current === null || typeof current === "boolean" || typeof current === "number") {
      return current;
    }
    if (Array.isArray(current)) {
      const values = current.slice(0, 12).map((item) => visit(item, depth + 1));
      if (current.length > 12) omitted = true;
      return values;
    }
    const record = asRecord(current);
    if (!record) {
      omitted = true;
      return "[omitted: unsupported value]";
    }
    const entries = Object.entries(record);
    const output: Record<string, unknown> = {};
    for (const [key, item] of entries.slice(0, 32)) {
      if (isSensitiveKey(key)) {
        output[key] = redactSensitiveJsonFields(key, item);
        redacted = true;
      } else {
        output[key] = visit(item, depth + 1);
      }
    }
    if (entries.length > 32) omitted = true;
    return output;
  };
  return { value: visit(value, 0), omitted, redacted };
}

function selectedToolMetadata(data: unknown, fields: ReadonlySet<string>) {
  const record = asRecord(data);
  if (!record) return { text: undefined, omitted: false, redacted: false };
  const containsSensitiveField = Object.keys(record).some((key) => isSensitiveKey(key));
  const selected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (fields.has(key)) selected[key] = value;
  }
  if (Object.keys(selected).length === 0) {
    return { text: undefined, omitted: false, redacted: containsSensitiveField };
  }
  const sanitized = sanitizedToolValue(selected);
  let text: string | undefined;
  try {
    text = JSON.stringify(sanitized.value);
  } catch {
    return { text: undefined, omitted: true, redacted: sanitized.redacted };
  }
  return {
    text,
    omitted: sanitized.omitted,
    redacted: sanitized.redacted || containsSensitiveField,
  };
}

function makeItem(input: {
  readonly id: string;
  readonly kind: ExpertLearningEvidenceItem["kind"];
  readonly text: string;
  readonly role?: "user" | "assistant" | undefined;
  readonly eventSequence?: number | undefined;
  readonly toolCallId?: string | undefined;
}):
  | { readonly item: ExpertLearningEvidenceItem; readonly coverage: ReadonlyArray<string> }
  | undefined {
  const trimmedId = input.id.trim();
  if (!trimmedId || input.text.length === 0) return undefined;
  const id = boundedText(trimmedId, 200).text;
  const bounded = boundedText(input.text);
  const item: ExpertLearningEvidenceItem = {
    id,
    kind: input.kind,
    text: bounded.text,
    ...(input.role ? { role: input.role } : {}),
    ...(input.eventSequence !== undefined &&
    Number.isSafeInteger(input.eventSequence) &&
    input.eventSequence >= 0
      ? { eventSequence: input.eventSequence }
      : {}),
    ...(input.toolCallId ? { toolCallId: boundedText(input.toolCallId, 200).text } : {}),
    ...(bounded.truncated ? { truncated: true } : {}),
  };
  return {
    item,
    coverage: [
      ...(bounded.truncated ? ["item-text-truncated"] : []),
      ...(id !== trimmedId ? ["item-id-truncated"] : []),
    ],
  };
}

function firstText(...values: ReadonlyArray<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function directResultText(data: unknown): string | undefined {
  const record = asRecord(data);
  if (!record) return undefined;
  const fields = ["output", "stdout", "stderr", "result", "summary", "error"];
  const parts = fields.flatMap((field) => {
    const value = record[field];
    if (typeof value !== "string" || value.trim().length === 0) return [];
    return [`${field}: ${value}`];
  });
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function eventSequence(entry: LearningRuntimeEvidenceEvent): number | undefined {
  return Number.isSafeInteger(entry.sequence) && entry.sequence >= 0 ? entry.sequence : undefined;
}

function lifecycleEvidence(entry: LearningRuntimeEvidenceEvent): LearningEvidenceDelta {
  const event = entry.event;
  if (
    event.type !== "item.started" &&
    event.type !== "item.updated" &&
    event.type !== "item.completed"
  ) {
    return { items: [], coverage: [] };
  }

  const payload = event.payload;
  if (TOOL_ITEM_TYPES.has(payload.itemType)) {
    const itemId = event.itemId ?? event.eventId;
    if (
      event.type === "item.started" ||
      (event.type === "item.updated" && payload.status === "inProgress")
    ) {
      const title = firstText(payload.title) ?? payload.itemType;
      const metadata = selectedToolMetadata(payload.data, TOOL_CALL_METADATA_FIELDS);
      const detail = firstText(payload.detail);
      const input = [detail ? redactSensitiveProcessArgs(detail) : undefined, metadata.text]
        .filter((part): part is string => part !== undefined)
        .join("\n");
      const made = makeItem({
        id: `tool-call:${itemId}`,
        kind: "tool_call",
        text: [`Started ${title}.`, ...(input ? [`Tool input: ${input}`] : [])].join("\n"),
        eventSequence: eventSequence(entry),
        toolCallId: itemId,
      });
      return made
        ? {
            items: [made.item],
            coverage: [
              ...made.coverage,
              ...(!detail && !metadata.text ? ["tool-input-unavailable"] : []),
              ...(metadata.omitted ? ["tool-input-partial"] : []),
              ...(metadata.redacted ? ["tool-input-credentials-redacted"] : []),
            ],
          }
        : { items: [], coverage: [] };
    }

    const isSettled =
      event.type === "item.completed" ||
      (event.type === "item.updated" &&
        (payload.status === "completed" ||
          payload.status === "failed" ||
          payload.status === "declined"));
    if (!isSettled) return { items: [], coverage: [] };
    const detail = firstText(payload.detail, directResultText(payload.data));
    const status = payload.status ? `Status: ${payload.status}.` : "Tool result received.";
    const title = firstText(payload.title) ?? payload.itemType;
    const metadata = selectedToolMetadata(payload.data, TOOL_RESULT_METADATA_FIELDS);
    const text = [
      `${title}.`,
      status,
      ...(detail ? [redactSensitiveProcessArgs(detail)] : []),
      ...(metadata.text ? [`Result metadata: ${metadata.text}`] : []),
    ].join("\n");
    const made = makeItem({
      id: `tool-result:${itemId}`,
      kind: "tool_result",
      text,
      eventSequence: eventSequence(entry),
      toolCallId: itemId,
    });
    const outputTruncated =
      detail !== undefined && detail.length > LEARNING_EVIDENCE_ITEM_TEXT_LIMIT;
    return made
      ? {
          items: [made.item],
          coverage: [
            ...made.coverage,
            ...(!detail && !metadata.text ? ["tool-result-unavailable"] : []),
            ...(outputTruncated ? ["tool-result-truncated"] : []),
            ...(metadata.omitted ? ["tool-result-partial"] : []),
            ...(metadata.redacted ? ["tool-result-credentials-redacted"] : []),
          ],
        }
      : { items: [], coverage: [] };
  }

  if (payload.itemType === "review_exited" || payload.itemType === "review_entered") {
    const text =
      firstText(payload.detail, payload.title) ?? `Review activity: ${payload.itemType}.`;
    const made = makeItem({
      id: `verification:${event.itemId ?? event.eventId}`,
      kind: "verification",
      text,
      eventSequence: eventSequence(entry),
    });
    return made ? { items: [made.item], coverage: made.coverage } : { items: [], coverage: [] };
  }

  if (payload.itemType === "error") {
    const text = firstText(payload.detail, payload.title) ?? "Provider reported an item error.";
    const made = makeItem({
      id: `activity:${event.eventId}`,
      kind: "activity",
      text,
      eventSequence: eventSequence(entry),
    });
    return made ? { items: [made.item], coverage: made.coverage } : { items: [], coverage: [] };
  }

  return { items: [], coverage: [] };
}

function terminalActivityEvidence(entry: LearningRuntimeEvidenceEvent): LearningEvidenceDelta {
  const event = entry.event;
  let text: string | undefined;
  if (event.type === "turn.aborted") {
    text = `Turn aborted: ${event.payload.reason}`;
  } else if (event.type === "turn.completed" && event.payload.state !== "completed") {
    const detail = firstText(
      event.payload.errorMessage,
      event.payload.errorCode,
      event.payload.stopReason,
    );
    text = `Turn ended as ${event.payload.state}.${detail ? ` ${detail}` : ""}`;
  } else if (event.type === "runtime.error") {
    text = `Runtime error: ${event.payload.message}${event.payload.errorCode ? ` (${event.payload.errorCode})` : ""}`;
  } else if (event.type === "runtime.warning") {
    text = `Runtime warning: ${event.payload.message}`;
  }
  if (!text) return { items: [], coverage: [] };
  const made = makeItem({
    id: `activity:${event.eventId}`,
    kind: "activity",
    text,
    eventSequence: eventSequence(entry),
  });
  return made ? { items: [made.item], coverage: made.coverage } : { items: [], coverage: [] };
}

/**
 * Project only durable, non-reasoning evidence from one already-persisted runtime row.
 * Content deltas, prompts, tool arguments, raw payloads, and reasoning streams are excluded.
 */
export function learningEvidenceDeltaFromRuntimeEvent(
  entry: LearningRuntimeEvidenceEvent,
): LearningEvidenceDelta {
  const lifecycle = lifecycleEvidence(entry);
  const terminal = terminalActivityEvidence(entry);
  return {
    items: [...lifecycle.items, ...terminal.items].map((item) => ({
      ...item,
      ...(entry.event.eventId.length <= 200 ? { sourceEventId: entry.event.eventId } : {}),
    })),
    coverage: [...new Set([...lifecycle.coverage, ...terminal.coverage])],
  };
}

function messageEventSequence(message: OrchestrationMessage): number | undefined {
  const sequences = (message.textSegments ?? [])
    .map((segment) => segment.sequence)
    .filter((sequence) => Number.isSafeInteger(sequence) && sequence >= 0);
  return sequences.length > 0 ? Math.min(...sequences) : undefined;
}

/** Return only user/assistant transcript rows belonging to this exact turn. */
export function learningEvidenceMessagesForTurn(input: {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly turnId: TurnId;
  readonly pendingMessageId?: string | null;
  readonly transcriptWasTruncated?: boolean;
}): LearningEvidenceMessageSlice {
  const items: ExpertLearningEvidenceItem[] = [];
  const coverage = new Set<string>();
  for (const message of input.messages) {
    const isExactRequest =
      message.role === "user" &&
      message.id === input.pendingMessageId &&
      (message.turnId == null || message.turnId === input.turnId);
    if (
      (!isExactRequest && message.turnId !== input.turnId) ||
      (message.role !== "user" && message.role !== "assistant") ||
      message.text.length === 0
    ) {
      continue;
    }
    const made = makeItem({
      // The coordinator uses this as the source-message reference.
      id: message.id,
      kind: "message",
      role: message.role,
      text: message.text,
      eventSequence: messageEventSequence(message),
    });
    if (made) {
      items.push(made.item);
      made.coverage.forEach((label) => coverage.add(label));
    }
  }
  const hasUserMessage = items.some((item) => item.role === "user");
  const hasAssistantMessage = items.some((item) => item.role === "assistant");
  if (!hasUserMessage) coverage.add("user-message-missing");
  if (!hasAssistantMessage) coverage.add("assistant-message-missing");
  if (input.pendingMessageId && !items.some((item) => item.id === input.pendingMessageId)) {
    coverage.add("turn-request-message-missing");
  }
  if (input.transcriptWasTruncated) coverage.add("transcript-tail-truncated");
  return { items, coverage: [...coverage], hasUserMessage, hasAssistantMessage };
}

function evidenceItemPriority(item: ExpertLearningEvidenceItem): number {
  if (item.kind === "message") return 0;
  if (item.kind === "verification") return 1;
  if (item.kind === "tool_result") return 2;
  if (item.kind === "tool_call") return 3;
  return 4;
}

/**
 * Merge by stable evidence id, keep the most useful items, and enforce both item and text budgets.
 * Replaying the same journal row is idempotent; a later settled item may replace its earlier form.
 */
export function mergeLearningEvidenceItems(
  existing: ReadonlyArray<ExpertLearningEvidenceItem>,
  incoming: ReadonlyArray<ExpertLearningEvidenceItem>,
): { readonly items: ReadonlyArray<ExpertLearningEvidenceItem>; readonly truncated: boolean } {
  const byId = new Map<string, ExpertLearningEvidenceItem>();
  for (const item of existing) byId.set(item.id, item);
  for (const item of incoming) byId.set(item.id, item);
  const bySequence = (left: ExpertLearningEvidenceItem, right: ExpertLearningEvidenceItem) =>
    (left.eventSequence ?? Number.MAX_SAFE_INTEGER) -
      (right.eventSequence ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id);
  const ordered = [...byId.values()].toSorted((left, right) => {
    return evidenceItemPriority(left) - evidenceItemPriority(right) || bySequence(right, left);
  });
  const selected: ExpertLearningEvidenceItem[] = [];
  let textBudget = LEARNING_EVIDENCE_TOTAL_TEXT_LIMIT;
  for (const item of ordered) {
    if (selected.length >= LEARNING_EVIDENCE_ITEM_LIMIT || textBudget <= 0) break;
    const text = boundedText(item.text, Math.min(LEARNING_EVIDENCE_ITEM_TEXT_LIMIT, textBudget));
    selected.push({
      ...item,
      text: text.text,
      ...(item.truncated || text.truncated ? { truncated: true } : {}),
    });
    textBudget -= text.text.length;
  }
  return {
    items: selected.toSorted(bySequence),
    truncated: selected.length < byId.size || textBudget <= 0,
  };
}

export function isLearningEvidenceRelevantEvent(event: ProviderRuntimeEvent): boolean {
  if (
    event.type === "turn.started" ||
    event.type === "turn.completed" ||
    event.type === "turn.aborted" ||
    event.type === "runtime.error" ||
    event.type === "runtime.warning" ||
    event.type === "model.rerouted"
  ) {
    return true;
  }
  return (
    event.type === "item.started" ||
    event.type === "item.updated" ||
    event.type === "item.completed"
  );
}
