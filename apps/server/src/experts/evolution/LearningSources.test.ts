import {
  EventId,
  MessageId,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProjectReadFileInput,
  type ProjectReadFileResult,
  type OrchestrationMessage,
  type OrchestrationThread,
  type ProviderRuntimeEvent,
} from "@synara/contracts";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  LEARNING_SOURCE_TOTAL_BYTE_LIMIT,
  LEARNING_SOURCE_TOTAL_CHARACTER_LIMIT,
  createLearningSourceFreezer,
  scrubLearningSourceText,
  type LearningSourceAcceptedRuntimeEvent,
  type LearningSourceFreezeContext,
  type LearningSourceFreezerHost,
} from "./LearningSources.ts";
import {
  managedLearningAttachmentReader,
  workspaceLearningDocumentReader,
} from "../../workbench/host/learningSourceReaders.ts";

const THREAD = "thread-current";
const TURN = "turn-current";
const CURRENT_USER_MESSAGE = "message-pending";
const mentionTestDocumentReader = async (input: { relativePath: string; rootIndex: number }) => ({
  relativePath: input.relativePath,
  rootIndex: input.rootIndex,
  text: `Contents of ${input.relativePath}`,
  byteLength: Buffer.byteLength(`Contents of ${input.relativePath}`),
  truncated: false,
  regularFile: true,
});

function makeMessage(input: {
  readonly id: string;
  readonly role: OrchestrationMessage["role"];
  readonly text: string;
  readonly turnId?: OrchestrationMessage["turnId"];
  readonly streaming?: boolean;
  readonly attachments?: OrchestrationMessage["attachments"];
}): OrchestrationMessage {
  return {
    id: MessageId.makeUnsafe(input.id),
    role: input.role,
    text: input.text,
    turnId: input.turnId ?? null,
    streaming: input.streaming ?? false,
    source: "native",
    createdAt: "2026-10-31T10:00:00.000Z",
    updatedAt: "2026-10-31T10:00:00.000Z",
    ...(input.attachments ? { attachments: input.attachments } : {}),
  } as OrchestrationMessage;
}

function makeThread(messages: ReadonlyArray<OrchestrationMessage>): OrchestrationThread {
  return {
    id: ThreadId.makeUnsafe(THREAD),
    projectId: "project-current",
    messages,
  } as unknown as OrchestrationThread;
}

function makeContext(
  overrides: Partial<LearningSourceFreezeContext> = {},
): LearningSourceFreezeContext {
  return {
    scope: {
      ownerId: "owner-host",
      spaceId: null,
      expertId: "expert-current",
      projectId: "project-current",
    },
    threadId: THREAD,
    turnId: TURN,
    currentUserMessageId: CURRENT_USER_MESSAGE,
    ...overrides,
  };
}

function toolOutputEvent(
  input: {
    readonly threadId?: string;
    readonly turnId?: string;
    readonly eventId?: string;
    readonly output?: string;
  } = {},
): ProviderRuntimeEvent {
  return {
    type: "item.completed",
    eventId: EventId.makeUnsafe(input.eventId ?? "event-current"),
    provider: "omp",
    threadId: ThreadId.makeUnsafe(input.threadId ?? THREAD),
    turnId: TurnId.makeUnsafe(input.turnId ?? TURN),
    lifecycleGeneration: "generation-current",
    itemId: RuntimeItemId.makeUnsafe("tool-call-current"),
    createdAt: "2026-10-31T10:00:00.000Z",
    payload: {
      itemType: "command_execution",
      status: "failed",
      title: "Check source",
      detail: input.output ?? "Status: failed",
      data: { output: input.output ?? "Status: failed" },
    },
  } as ProviderRuntimeEvent;
}

function acceptedEvent(
  event: ProviderRuntimeEvent,
  extra: Partial<LearningSourceAcceptedRuntimeEvent> = {},
): LearningSourceAcceptedRuntimeEvent {
  return {
    accepted: true,
    runId: "run-current",
    sequence: 12,
    event,
    ...extra,
  };
}

function host(overrides: Partial<LearningSourceFreezerHost> = {}): LearningSourceFreezerHost {
  return {
    readThread: async () =>
      makeThread([
        makeMessage({
          id: CURRENT_USER_MESSAGE,
          role: "user",
          text: "Please use this feedback.",
          turnId: null,
          streaming: true,
        }),
        makeMessage({
          id: "message-assistant-current",
          role: "assistant",
          text: "The active turn response.",
          turnId: TurnId.makeUnsafe(TURN),
        }),
      ]),
    readCurrentProject: async () => ({
      projectId: "project-current",
      roots: [{ canonicalPath: "/workspace/current" }],
    }),
    readRuntimeEvents: async () => [],
    readAttachment: async () => undefined,
    ...overrides,
  };
}

describe("LearningSources", () => {
  it("freezes an accepted pending user message without requiring a completed turn", async () => {
    const result = await createLearningSourceFreezer(host()).freeze(makeContext(), [
      { kind: "message", messageId: CURRENT_USER_MESSAGE, quote: "Please use this feedback." },
    ]);

    expect(result.refs).toHaveLength(1);
    expect(result.refs[0]).toMatchObject({
      kind: "message",
      messageId: CURRENT_USER_MESSAGE,
      threadId: THREAD,
      role: "user",
      quote: "Please use this feedback.",
      contentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(result.texts[0]?.text).toBe("Please use this feedback.");
    expect(result.coverage).toEqual([]);
  });

  it("rejects messages outside the current accepted turn and never broadens thread identity", async () => {
    const readThread = vi.fn(async () =>
      makeThread([
        makeMessage({ id: CURRENT_USER_MESSAGE, role: "user", text: "Current request." }),
        makeMessage({
          id: "message-old",
          role: "assistant",
          text: "Old response.",
          turnId: TurnId.makeUnsafe("turn-old"),
        }),
      ]),
    );
    const result = await createLearningSourceFreezer(host({ readThread })).freeze(makeContext(), [
      { kind: "message", messageId: "message-old" },
    ]);
    expect(result.refs).toEqual([]);
    expect(result.coverage).toContain("message-source-not-in-current-turn");

    const wrongThread = await createLearningSourceFreezer(
      host({
        readThread: async () => ({ ...makeThread([]), id: ThreadId.makeUnsafe("thread-other") }),
      }),
    ).freeze(makeContext(), [{ kind: "message", messageId: CURRENT_USER_MESSAGE }]);
    expect(wrongThread.refs).toEqual([]);
    expect(wrongThread.coverage).toContain("current-thread-unavailable");
  });

  it("caps source selections at five overall", async () => {
    const currentTurnMessages = [
      makeMessage({ id: CURRENT_USER_MESSAGE, role: "user", text: "Current request." }),
      ...Array.from({ length: 6 }, (_, index) =>
        makeMessage({
          id: `assistant-${index}`,
          role: "assistant",
          text: `Useful note ${index}`,
          turnId: TurnId.makeUnsafe(TURN),
        }),
      ),
    ];
    const selections = Array.from({ length: 6 }, (_, index) => ({
      kind: "message" as const,
      messageId: `assistant-${index}`,
    }));
    const result = await createLearningSourceFreezer(
      host({ readThread: async () => makeThread(currentTurnMessages) }),
    ).freeze(makeContext(), selections);

    expect(result.refs).toHaveLength(5);
    expect(result.coverage).toContain("source-reference-limit-truncated");
  });

  it("uses LearningEvidence to freeze only persisted accepted runtime evidence and scrubs secrets", async () => {
    const event = toolOutputEvent({
      output: 'password=runtime-secret output: "Bearer runtime-token"',
    });
    const result = await createLearningSourceFreezer(
      host({ readRuntimeEvents: async () => [acceptedEvent(event)] }),
    ).freeze(makeContext(), [
      { kind: "runtime", eventId: "event-current", quote: "Status: failed" },
    ]);

    expect(result.refs).toHaveLength(1);
    expect(result.refs[0]).toMatchObject({
      kind: "runtime",
      runId: "run-current",
      eventId: "event-current",
    });
    expect(result.texts[0]?.text).toContain("Status: failed");
    expect(result.texts[0]?.text).not.toContain("runtime-secret");
    expect(result.texts[0]?.text).not.toContain("runtime-token");

    const wrongTurn = await createLearningSourceFreezer(
      host({
        readRuntimeEvents: async () => [acceptedEvent(toolOutputEvent({ turnId: "turn-old" }))],
      }),
    ).freeze(makeContext(), [{ kind: "runtime", eventId: "event-current" }]);
    expect(wrongTurn.refs).toEqual([]);
    expect(wrongTurn.coverage).toContain("runtime-event-not-accepted-for-current-turn");
  });

  it("enforces the UTF-8 read budget before the reader and preserves valid Unicode at the text cap", async () => {
    const message = makeMessage({
      id: CURRENT_USER_MESSAGE,
      role: "user",
      text: `${"x".repeat(LEARNING_SOURCE_TOTAL_CHARACTER_LIMIT - 1)}😀`,
      turnId: null,
    });
    const readDocument = vi.fn(async (input) => ({
      relativePath: input.relativePath,
      rootIndex: input.rootIndex,
      text: "small document",
      byteLength: Buffer.byteLength("small document"),
      truncated: false,
      regularFile: true,
    }));
    const result = await createLearningSourceFreezer(
      host({ readThread: async () => makeThread([message]), readDocument }),
    ).freeze(makeContext(), [{ kind: "message", messageId: CURRENT_USER_MESSAGE }]);

    expect(result.texts[0]?.text.length).toBe(LEARNING_SOURCE_TOTAL_CHARACTER_LIMIT - 1);
    expect(result.texts[0]?.text.endsWith("😀")).toBe(false);
    expect(result.refs[0]).toMatchObject({ truncated: true });
    const documentResult = await createLearningSourceFreezer(
      host({
        readThread: async () =>
          makeThread([
            makeMessage({ id: CURRENT_USER_MESSAGE, role: "user", text: "Please use guide.md." }),
          ]),
        readDocument,
      }),
    ).freeze(makeContext(), [{ kind: "document", relativePath: "guide.md" }]);
    expect(documentResult.texts[0]?.text).toBe("small document");
    expect(readDocument).toHaveBeenCalledWith(
      expect.objectContaining({ maxBytes: Math.min(LEARNING_SOURCE_TOTAL_BYTE_LIMIT, 1_000_000) }),
    );
  });

  it("rejects traversal, symlink and non-regular document sources and only reads user-named files", async () => {
    const readDocument = vi.fn(async (input) => ({
      relativePath: input.relativePath,
      rootIndex: input.rootIndex,
      text: "file content",
      byteLength: Buffer.byteLength("file content"),
      truncated: false,
      regularFile: true,
    }));
    const make = (text: string) =>
      createLearningSourceFreezer(
        host({
          readThread: async () =>
            makeThread([
              makeMessage({ id: CURRENT_USER_MESSAGE, role: "user", text, turnId: null }),
            ]),
          readDocument,
        }),
      );

    const traversal = await make("Read ../outside.txt").freeze(makeContext(), [
      { kind: "document", relativePath: "../outside.txt" },
    ]);
    expect(traversal.refs).toEqual([]);
    expect(readDocument).not.toHaveBeenCalled();

    const notNamed = await make("Please learn the approach").freeze(makeContext(), [
      { kind: "document", relativePath: "private.md" },
    ]);
    expect(notNamed.coverage).toContain("document-not-named-or-read-in-current-turn");

    const symlink = await createLearningSourceFreezer(
      host({
        readThread: async () =>
          makeThread([
            makeMessage({ id: CURRENT_USER_MESSAGE, role: "user", text: "Read link.md" }),
          ]),
        readDocument: async (input) => ({
          relativePath: input.relativePath,
          rootIndex: input.rootIndex,
          text: "must not be frozen",
          byteLength: 19,
          truncated: false,
          regularFile: true,
          symlink: true,
        }),
      }),
    ).freeze(makeContext(), [{ kind: "document", relativePath: "link.md" }]);
    expect(symlink.refs).toEqual([]);
    expect(symlink.coverage).toContain("document-symlink-rejected");

    const device = await createLearningSourceFreezer(
      host({
        readThread: async () =>
          makeThread([
            makeMessage({ id: CURRENT_USER_MESSAGE, role: "user", text: "Read device" }),
          ]),
        readDocument: async () => {
          throw new Error("WorkspaceFileSystem rejected non-regular device path");
        },
      }),
    ).freeze(makeContext(), [{ kind: "document", relativePath: "device" }]);
    expect(device.refs).toEqual([]);
    expect(device.coverage).toContain("document-source-unavailable");
  });

  it("requires a complete bounded path mention while preserving exact names and runtime read proof", async () => {
    const freezeDocument = (
      messageText: string,
      relativePath: string,
      readRuntimeEvents: LearningSourceFreezerHost["readRuntimeEvents"] = async () => [],
      rootPath = "/workspace/current",
    ) =>
      createLearningSourceFreezer(
        host({
          readThread: async () =>
            makeThread([
              makeMessage({
                id: CURRENT_USER_MESSAGE,
                role: "user",
                text: messageText,
                turnId: null,
                streaming: true,
              }),
            ]),
          readRuntimeEvents,
          readCurrentProject: async () => ({
            projectId: "project-current",
            roots: [{ canonicalPath: rootPath }],
          }),
          readDocument: mentionTestDocumentReader,
        }),
      ).freeze(makeContext(), [{ kind: "document", relativePath }]);

    const filenameSubstring = await freezeDocument("Please learn data.md.", "a.md");
    expect(filenameSubstring.refs).toEqual([]);
    expect(filenameSubstring.coverage).toContain("document-not-named-or-read-in-current-turn");

    const pathSuffix = await freezeDocument("Please use folder/data.md.", "a.md");
    expect(pathSuffix.refs).toEqual([]);

    const quotedExactName = await freezeDocument('Please read "a.md".', "a.md");
    expect(quotedExactName.refs).toHaveLength(1);

    const markdownSpacedPath = await freezeDocument(
      "Open [folder/my notes.md] for the source.",
      "folder/my notes.md",
    );
    expect(markdownSpacedPath.refs).toHaveLength(1);

    const windowsPath = await freezeDocument(
      'Please read "folder\\windows.md".',
      "folder/windows.md",
    );
    expect(windowsPath.refs).toHaveLength(1);

    const absolutePath = await freezeDocument(
      "Please read /workspace/current/absolute.md.",
      "absolute.md",
    );
    expect(absolutePath.refs).toHaveLength(1);

    const windowsAbsolutePath = await freezeDocument(
      'Please read "C:\\Users\\worker\\project\\windows-absolute.md".',
      "windows-absolute.md",
      async () => [],
      "C:\\Users\\worker\\project",
    );
    expect(windowsAbsolutePath.refs).toHaveLength(1);

    const readProof = acceptedEvent(toolOutputEvent(), {
      documentsRead: [{ relativePath: "unmentioned.md", rootIndex: 0 }],
    });
    const previouslyRead = await freezeDocument(
      "Use the relevant source.",
      "unmentioned.md",
      async () => [readProof],
    );
    expect(previouslyRead.refs).toHaveLength(1);
    expect(previouslyRead.texts[0]?.text).toBe("Contents of unmentioned.md");
  });

  it("adapts WorkspaceFileSystem with exact-path and pre-read byte bounds", async () => {
    const readFile = vi.fn(
      async (input: ProjectReadFileInput): Promise<ProjectReadFileResult> => ({
        relativePath: input.relativePath,
        contents: "bounded markdown",
        truncated: false,
        version: null,
        encoding: null,
        lineEnding: null,
        symlink: false,
      }),
    );
    const reader = workspaceLearningDocumentReader(readFile);
    const result = await reader({
      threadId: THREAD,
      projectId: "project-current",
      rootIndex: 0,
      rootPath: "/workspace/current",
      relativePath: "docs/guide.md",
      maxBytes: 99,
    });
    expect(readFile).toHaveBeenCalledWith({
      cwd: "/workspace/current",
      relativePath: "docs/guide.md",
      maxBytes: 99,
    });
    expect(result).toMatchObject({ text: "bounded markdown", regularFile: true, symlink: false });

    readFile.mockResolvedValueOnce({
      relativePath: "other/guide.md",
      contents: "suffix fallback is not exact provenance",
      truncated: false,
      version: null,
      encoding: null,
      lineEnding: null,
    });
    await expect(
      reader({
        threadId: THREAD,
        projectId: "project-current",
        rootIndex: 0,
        rootPath: "/workspace/current",
        relativePath: "docs/guide.md",
        maxBytes: 99,
      }),
    ).resolves.toBeUndefined();
  });

  it("requires the selected attachment to belong to the pending user message and managed principal reader", async () => {
    const attachedMessage = makeMessage({
      id: CURRENT_USER_MESSAGE,
      role: "user",
      text: "",
      turnId: null,
      attachments: [
        {
          type: "file",
          id: "attachment-current",
          name: "guide.md",
          mimeType: "text/markdown",
          sizeBytes: 15,
        },
      ],
    });
    const bytes = new TextEncoder().encode("## Safe method");
    const readAttachment = vi.fn(async () => ({
      ownership: "verified-claimed" as const,
      threadId: THREAD,
      messageId: CURRENT_USER_MESSAGE,
      attachmentId: "attachment-current",
      mimeType: "text/markdown",
      byteLength: bytes.byteLength,
      totalBytes: bytes.byteLength,
      truncated: false,
      bytes,
      contentHash: `sha256:${"a".repeat(64)}`,
      hashIsComplete: true,
    }));
    const result = await createLearningSourceFreezer(
      host({ readThread: async () => makeThread([attachedMessage]), readAttachment }),
    ).freeze(makeContext(), [
      {
        kind: "attachment",
        attachmentId: "attachment-current",
        expectedHash: `sha256:${"a".repeat(64)}`,
      },
    ]);
    expect(result.refs).toHaveLength(1);
    expect(result.refs[0]).toMatchObject({
      kind: "attachment",
      attachmentId: "attachment-current",
      messageId: CURRENT_USER_MESSAGE,
    });
    expect(readAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: THREAD,
        messageId: CURRENT_USER_MESSAGE,
        maxBytes: LEARNING_SOURCE_TOTAL_BYTE_LIMIT,
      }),
    );

    const mismatch = await createLearningSourceFreezer(
      host({
        readThread: async () => makeThread([attachedMessage]),
        readAttachment: async () => ({
          ownership: "verified-claimed",
          threadId: THREAD,
          messageId: "message-other",
          attachmentId: "attachment-current",
          mimeType: "text/markdown",
          byteLength: 2,
          totalBytes: 2,
          truncated: false,
          bytes: new TextEncoder().encode("x\n"),
        }),
      }),
    ).freeze(makeContext(), [{ kind: "attachment", attachmentId: "attachment-current" }]);
    expect(mismatch.refs).toEqual([]);
    expect(mismatch.coverage).toContain("managed-attachment-ownership-or-size-invalid");
  });

  it("keeps a byte-truncated UTF-8 attachment prefix valid without emitting a replacement character", async () => {
    const attachedMessage = makeMessage({
      id: CURRENT_USER_MESSAGE,
      role: "user",
      text: "Use partial.txt",
      attachments: [
        {
          type: "file",
          id: "partial-text",
          name: "partial.txt",
          mimeType: "text/plain",
          sizeBytes: 8,
        },
      ],
    });
    const complete = new TextEncoder().encode("safe😀");
    const prefix = complete.subarray(0, 6);
    const result = await createLearningSourceFreezer(
      host({
        readThread: async () => makeThread([attachedMessage]),
        readAttachment: async () => ({
          ownership: "verified-claimed",
          threadId: THREAD,
          messageId: CURRENT_USER_MESSAGE,
          attachmentId: "partial-text",
          mimeType: "text/plain",
          byteLength: prefix.byteLength,
          totalBytes: complete.byteLength,
          truncated: true,
          bytes: prefix,
        }),
      }),
    ).freeze(makeContext(), [{ kind: "attachment", attachmentId: "partial-text" }]);

    expect(result.texts[0]?.text).toBe("safe");
    expect(result.texts[0]?.text).not.toContain("\uFFFD");
    expect(result.refs[0]).toMatchObject({ truncated: true });
    expect(result.coverage).toContain("source-text-truncated");
  });

  it("uses only exact-turn runtime excerpts for PDF or image attachments", async () => {
    const attachedMessage = makeMessage({
      id: CURRENT_USER_MESSAGE,
      role: "user",
      text: "Learn this figure.",
      attachments: [
        {
          type: "file",
          id: "pdf-current",
          name: "guide.pdf",
          mimeType: "application/pdf",
          sizeBytes: 40,
        },
      ],
    });
    const event = toolOutputEvent();
    const hostWithExcerpt = host({
      readThread: async () => makeThread([attachedMessage]),
      readRuntimeEvents: async () => [
        acceptedEvent(event, {
          attachmentExcerpts: [
            {
              attachmentId: "pdf-current",
              messageId: CURRENT_USER_MESSAGE,
              text: "Figure shows two steps.",
            },
          ],
        }),
      ],
      readAttachment: async () => ({
        ownership: "verified-claimed",
        threadId: THREAD,
        messageId: CURRENT_USER_MESSAGE,
        attachmentId: "pdf-current",
        mimeType: "application/pdf",
        byteLength: 0,
        totalBytes: 40,
        truncated: true,
      }),
    });
    const accepted = await createLearningSourceFreezer(hostWithExcerpt).freeze(makeContext(), [
      { kind: "attachment", attachmentId: "pdf-current" },
    ]);
    expect(accepted.texts[0]?.text).toBe("Figure shows two steps.");

    const missingRead = await createLearningSourceFreezer(
      host({
        readThread: async () => makeThread([attachedMessage]),
        readRuntimeEvents: async () => [],
        readAttachment: async () => ({
          ownership: "verified-claimed",
          threadId: THREAD,
          messageId: CURRENT_USER_MESSAGE,
          attachmentId: "pdf-current",
          mimeType: "application/pdf",
          byteLength: 0,
          totalBytes: 40,
          truncated: true,
        }),
      }),
    ).freeze(makeContext(), [{ kind: "attachment", attachmentId: "pdf-current" }]);
    expect(missingRead.refs).toEqual([]);
    expect(missingRead.coverage).toContain("attachment-not-read-in-current-turn");
  });

  it("selects binary attachment excerpts by exact selector or newest accepted sequence", async () => {
    const attachedMessage = makeMessage({
      id: CURRENT_USER_MESSAGE,
      role: "user",
      text: "Use the attached figure.",
      attachments: [
        {
          type: "file",
          id: "pdf-pages",
          name: "guide.pdf",
          mimeType: "application/pdf",
          sizeBytes: 80,
        },
      ],
    });
    const pageTwo = acceptedEvent(toolOutputEvent({ eventId: "page-two" }), {
      sequence: 2,
      attachmentExcerpts: [
        {
          attachmentId: "pdf-pages",
          messageId: CURRENT_USER_MESSAGE,
          text: "Latest page two",
        },
      ],
    });
    const pageOne = acceptedEvent(toolOutputEvent({ eventId: "page-one" }), {
      sequence: 1,
      attachmentExcerpts: [
        {
          attachmentId: "pdf-pages",
          messageId: CURRENT_USER_MESSAGE,
          text: "Earlier page one",
        },
      ],
    });
    const makeFreezer = () =>
      createLearningSourceFreezer(
        host({
          readThread: async () => makeThread([attachedMessage]),
          readRuntimeEvents: async () => [pageTwo, pageOne],
          readAttachment: async () => ({
            ownership: "verified-claimed",
            threadId: THREAD,
            messageId: CURRENT_USER_MESSAGE,
            attachmentId: "pdf-pages",
            mimeType: "application/pdf",
            byteLength: 0,
            totalBytes: 80,
            truncated: true,
          }),
        }),
      );

    const latestQuote = await makeFreezer().freeze(makeContext(), [
      { kind: "attachment", attachmentId: "pdf-pages", quote: "Latest page two" },
    ]);
    expect(latestQuote.texts[0]?.text).toBe("Latest page two");
    expect(latestQuote.refs[0]).toMatchObject({ kind: "attachment", quote: "Latest page two" });

    const oldQuote = await makeFreezer().freeze(makeContext(), [
      { kind: "attachment", attachmentId: "pdf-pages", quote: "Earlier page one" },
    ]);
    expect(oldQuote.texts[0]?.text).toBe("Earlier page one");
    expect(oldQuote.refs[0]).toMatchObject({ kind: "attachment", quote: "Earlier page one" });

    const latestWithoutSelector = await makeFreezer().freeze(makeContext(), [
      { kind: "attachment", attachmentId: "pdf-pages" },
    ]);
    expect(latestWithoutSelector.texts[0]?.text).toBe("Latest page two");

    const ambiguousRange = await makeFreezer().freeze(makeContext(), [
      { kind: "attachment", attachmentId: "pdf-pages", range: { startOffset: 0, endOffset: 5 } },
    ]);
    expect(ambiguousRange.refs).toEqual([]);
    expect(ambiguousRange.coverage).toContain("attachment-range-ambiguous");
  });

  it("rejects changed or missing sources instead of fabricating evidence", async () => {
    const readDocument = vi.fn(async (input) => ({
      relativePath: input.relativePath,
      rootIndex: input.rootIndex,
      text: "changed document",
      byteLength: Buffer.byteLength("changed document"),
      truncated: false,
      regularFile: true,
    }));
    const changed = await createLearningSourceFreezer(
      host({
        readThread: async () =>
          makeThread([makeMessage({ id: CURRENT_USER_MESSAGE, role: "user", text: "Use doc.md" })]),
        readDocument,
      }),
    ).freeze(makeContext(), [
      { kind: "document", relativePath: "doc.md", expectedHash: `sha256:${"0".repeat(64)}` },
    ]);
    expect(changed.refs).toEqual([]);
    expect(changed.coverage).toContain("document-content-hash-mismatch");

    const missing = await createLearningSourceFreezer(
      host({
        readThread: async () =>
          makeThread([
            makeMessage({ id: CURRENT_USER_MESSAGE, role: "user", text: "Use missing.md" }),
          ]),
        readDocument: async () => undefined,
      }),
    ).freeze(makeContext(), [{ kind: "document", relativePath: "missing.md" }]);
    expect(missing.refs).toEqual([]);
    expect(missing.coverage).toContain("document-source-unsafe-or-invalid");
    expect(scrubLearningSourceText('{"apiKey":"raw-secret","note":"safe"}')).not.toContain(
      "raw-secret",
    );
  });

  it("reads managed attachment prefixes only after principal, thread, message, and path checks", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "learning-source-"));
    const attachmentsDir = path.join(root, "attachments");
    const relativePath = "objects/ab/attachment-current.md";
    const filePath = path.join(attachmentsDir, relativePath);
    const bytes = new TextEncoder().encode("## Reading source");
    const storedHash = createHash("sha256").update(bytes).digest("hex");
    const blob = {
      attachmentId: "attachment-current",
      ownerThreadId: THREAD,
      ownerKind: "session",
      ownerId: "session-current",
      kind: "file",
      originalName: "guide.md",
      mimeType: "text/markdown",
      reservedBytes: bytes.byteLength,
      sizeBytes: bytes.byteLength,
      sha256: storedHash,
      relativePath,
      state: "claimed",
      stagingExpiresAt: null,
      claimCommandId: "command-current",
      claimMessageId: CURRENT_USER_MESSAGE,
      claimedAt: "2026-10-31T10:00:00.000Z",
      deleteReason: null,
      deleteRequestedAt: null,
      deletedAt: null,
      createdAt: "2026-10-31T10:00:00.000Z",
      updatedAt: "2026-10-31T10:00:00.000Z",
    } as const;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, bytes);
    try {
      const reader = managedLearningAttachmentReader({
        attachmentsDir,
        principal: { ownerKind: "session", ownerId: "session-current" },
        findClaimedById: async () => blob,
      });
      const prefix = await reader({
        threadId: THREAD,
        messageId: CURRENT_USER_MESSAGE,
        attachmentId: "attachment-current",
        maxBytes: 5,
        metadataOnly: false,
      });
      expect(prefix).toMatchObject({
        ownership: "verified-claimed",
        byteLength: 5,
        totalBytes: bytes.byteLength,
        truncated: true,
        hashIsComplete: false,
        contentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      });
      expect(new TextDecoder().decode(prefix?.bytes)).toBe("## Re");

      const metadataOnly = await reader({
        threadId: THREAD,
        messageId: CURRENT_USER_MESSAGE,
        attachmentId: "attachment-current",
        maxBytes: 0,
        metadataOnly: true,
      });
      expect(metadataOnly).toMatchObject({ byteLength: 0, totalBytes: bytes.byteLength });
      expect(metadataOnly?.bytes).toBeUndefined();

      const wrongPrincipal = managedLearningAttachmentReader({
        attachmentsDir,
        principal: { ownerKind: "session", ownerId: "session-other" },
        findClaimedById: async () => blob,
      });
      await expect(
        wrongPrincipal({
          threadId: THREAD,
          messageId: CURRENT_USER_MESSAGE,
          attachmentId: "attachment-current",
          maxBytes: 5,
          metadataOnly: false,
        }),
      ).resolves.toBeUndefined();

      const symlinkPath = path.join(attachmentsDir, "objects/ab/linked.md");
      await fs.symlink(filePath, symlinkPath);
      const symlinkBlob = {
        ...blob,
        attachmentId: "attachment-linked",
        relativePath: "objects/ab/linked.md",
      };
      const symlinkReader = managedLearningAttachmentReader({
        attachmentsDir,
        principal: { ownerKind: "session", ownerId: "session-current" },
        findClaimedById: async () => symlinkBlob,
      });
      await expect(
        symlinkReader({
          threadId: THREAD,
          messageId: CURRENT_USER_MESSAGE,
          attachmentId: "attachment-linked",
          maxBytes: 5,
          metadataOnly: false,
        }),
      ).resolves.toBeUndefined();

      const directoryBlob = {
        ...blob,
        attachmentId: "attachment-directory",
        relativePath: "objects/ab",
      };
      const directoryReader = managedLearningAttachmentReader({
        attachmentsDir,
        principal: { ownerKind: "session", ownerId: "session-current" },
        findClaimedById: async () => directoryBlob,
      });
      await expect(
        directoryReader({
          threadId: THREAD,
          messageId: CURRENT_USER_MESSAGE,
          attachmentId: "attachment-directory",
          maxBytes: 5,
          metadataOnly: false,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
