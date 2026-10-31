import * as NodeFs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  EventId,
  MessageId,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type LearningSourceReference,
  type OrchestrationMessage,
  type OrchestrationThread,
  type ProviderRuntimeEvent,
} from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  createLearningSourceFreezer,
  type LearningSourceFreezeContext,
} from "../../experts/evolution/LearningSources.ts";
import { WorkspaceEntriesLive } from "../../workspace/Layers/WorkspaceEntries.ts";
import { WorkspaceFileSystemLive } from "../../workspace/Layers/WorkspaceFileSystem.ts";
import { WorkspacePathsLive } from "../../workspace/Layers/WorkspacePaths.ts";
import { WorkspaceFileSystem } from "../../workspace/Services/WorkspaceFileSystem.ts";
import {
  toAcceptedLearningSourceRows,
  workspaceLearningDocumentReader,
  type AcceptedLearningSourceContext,
} from "./learningSourceReaders.ts";

const thread = ThreadId.makeUnsafe("learning-source-thread");
const turn = TurnId.makeUnsafe("learning-source-turn");
const acceptedContext: AcceptedLearningSourceContext = {
  rootRunId: "run:learning-source-thread:learning-source-turn",
  threadId: thread,
  turnId: turn,
  roots: ["/workspace"],
  attachments: [],
};

const WorkspaceLayer = Layer.mergeAll(
  WorkspacePathsLive,
  WorkspaceEntriesLive,
  WorkspaceFileSystemLive.pipe(
    Layer.provide(WorkspacePathsLive),
    Layer.provide(WorkspaceEntriesLive),
  ),
);

const WorkspaceTestLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspaceLayer),
  Layer.provideMerge(NodeServices.layer),
);

const runtimes: Array<{ dispose(): Promise<void> }> = [];
let runtimeEventCounter = 0;

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
});

function runtimeEvent(input: {
  readonly provider?: "pi" | "omp" | "codex";
  readonly data: unknown;
  readonly status?: "completed" | "failed" | "inProgress";
  readonly type?: "item.completed" | "item.started";
  readonly threadId?: ThreadId;
  readonly turnId?: TurnId;
  readonly title?: string;
  readonly detail?: string;
}): ProviderRuntimeEvent {
  const type = input.type ?? "item.completed";
  return {
    type,
    eventId: EventId.makeUnsafe(`learning-source-event-${runtimeEventCounter++}`),
    provider: input.provider ?? "pi",
    providerInstanceId: input.provider ?? "pi",
    lifecycleGeneration: "learning-source-generation",
    threadId: input.threadId ?? thread,
    turnId: input.turnId ?? turn,
    itemId: RuntimeItemId.makeUnsafe("learning-source-item"),
    createdAt: "2026-10-31T00:00:00.000Z",
    payload: {
      itemType: "dynamic_tool_call",
      status: input.status ?? (type === "item.completed" ? "completed" : "inProgress"),
      ...(input.title ? { title: input.title } : {}),
      ...(input.detail ? { detail: input.detail } : {}),
      data: input.data,
    },
  } as ProviderRuntimeEvent;
}

function row(event: ProviderRuntimeEvent, sequence = 1) {
  return { event, sequence };
}

function readRows(
  event: ProviderRuntimeEvent,
  context: AcceptedLearningSourceContext = acceptedContext,
) {
  return toAcceptedLearningSourceRows([row(event)], context);
}

describe("learning source reader adapters", () => {
  it("derives a document proof from a completed Pi read and the actual read path", () => {
    const event = runtimeEvent({
      data: {
        toolName: "read",
        kind: "read",
        args: { path: "/workspace/src/guide.md" },
        result: { content: [{ type: "text", text: "Actual file contents." }] },
      },
      title: "Untrusted display title",
      detail: "Untrusted summary",
    });

    const [accepted] = toAcceptedLearningSourceRows([row(event, 27)], {
      ...acceptedContext,
      roots: ["/elsewhere", "/workspace"],
    });

    expect(accepted).toMatchObject({
      accepted: true,
      runId: acceptedContext.rootRunId,
      sequence: 27,
      documentsRead: [{ relativePath: "src/guide.md", rootIndex: 1 }],
    });
  });

  it("derives managed attachment excerpts only from actual completed OMP read output at its exact path", () => {
    const attachmentPath = "/managed/claimed/guide.pdf";
    const event = runtimeEvent({
      provider: "omp",
      data: {
        kind: "read",
        rawInput: { path: attachmentPath },
        rawOutput: { content: "Actual PDF text excerpt." },
      },
      title: "Read another file",
      detail: "This display text is not source evidence.",
    });

    const [accepted] = readRows(event, {
      ...acceptedContext,
      roots: [],
      attachments: [
        {
          attachmentId: "claimed-pdf",
          messageId: "current-user-message",
          absolutePath: attachmentPath,
        },
      ],
    });

    expect(accepted?.attachmentExcerpts).toEqual([
      {
        attachmentId: "claimed-pdf",
        messageId: "current-user-message",
        text: "Actual PDF text excerpt.",
      },
    ]);
    expect(accepted?.documentsRead).toBeUndefined();
  });

  it("uses exact ACP read locations and rejects untrusted titles, failures, started events, and foreign rows", () => {
    const acceptedRead = runtimeEvent({
      provider: "omp",
      data: {
        kind: "read",
        locations: [{ path: "/workspace/docs/design.md", line: 12 }],
        rawOutput: { content: [{ type: "text", text: "Read body." }] },
      },
      title: "A title mentioning /workspace/fake.md",
      detail: "cat /workspace/fake.md",
    });
    const fakeTitle = runtimeEvent({
      provider: "omp",
      data: { kind: "other", rawInput: { command: "cat /workspace/fake.md" } },
      title: "read /workspace/fake.md",
      detail: "File content: fabricated",
    });
    const failedRead = runtimeEvent({
      data: {
        toolName: "read",
        kind: "read",
        args: { path: "/workspace/failed.md" },
        result: { content: "Should not be accepted." },
        isError: true,
      },
      status: "failed",
    });
    const startedRead = runtimeEvent({
      type: "item.started",
      data: {
        toolName: "read",
        kind: "read",
        args: { path: "/workspace/started.md" },
        result: { content: "Not a completed result." },
      },
    });
    const outsideRead = runtimeEvent({
      data: {
        toolName: "read",
        kind: "read",
        args: { path: "/outside/secrets.txt" },
        result: { content: "Outside file." },
      },
    });
    const foreignRead = runtimeEvent({
      data: {
        toolName: "read",
        kind: "read",
        args: { path: "/workspace/foreign.md" },
        result: { content: "Foreign turn." },
      },
      turnId: TurnId.makeUnsafe("older-turn"),
    });
    const bashRead = runtimeEvent({
      data: {
        toolName: "bash",
        kind: "execute",
        args: { command: "cat /workspace/claimed.md" },
        result: { content: "Bash output is not a read proof." },
      },
    });

    const accepted = toAcceptedLearningSourceRows(
      [acceptedRead, fakeTitle, failedRead, startedRead, outsideRead, foreignRead, bashRead].map(
        (event, index) => row(event, index + 1),
      ),
      acceptedContext,
    );

    expect(accepted.map((item) => item.event.eventId)).not.toContain(foreignRead.eventId);
    expect(accepted[0]?.documentsRead).toEqual([{ relativePath: "docs/design.md", rootIndex: 0 }]);
    for (const event of [fakeTitle, failedRead, startedRead, outsideRead, bashRead]) {
      const item = accepted.find((candidate) => candidate.event.eventId === event.eventId);
      expect(item).toBeDefined();
      expect(item?.documentsRead).toBeUndefined();
      expect(item?.attachmentExcerpts).toBeUndefined();
    }
  });

  it("does not treat encoded binary or ambiguous roots as document evidence", () => {
    const binaryRead = runtimeEvent({
      data: {
        toolName: "read",
        kind: "read",
        args: { path: "/workspace/image.png" },
        result: { content: `data:image/png;base64,${"A".repeat(200)}` },
      },
    });
    const relativePathWithTwoRoots = runtimeEvent({
      provider: "omp",
      data: {
        kind: "read",
        rawInput: { path: "docs/guide.md" },
        rawOutput: { content: "Readable text." },
      },
    });

    const [binary, ambiguous] = toAcceptedLearningSourceRows(
      [row(binaryRead), row(relativePathWithTwoRoots, 2)],
      { ...acceptedContext, roots: ["/first", "/second"] },
    );

    expect(binary?.documentsRead).toBeUndefined();
    expect(ambiguous?.documentsRead).toBeUndefined();
  });

  it("preserves a genuine replacement character when the workspace read was not truncated", async () => {
    const reader = workspaceLearningDocumentReader(async (input) => ({
      relativePath: input.relativePath,
      contents: "valid \uFFFD text",
      truncated: false,
      version: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      encoding: "utf8",
      lineEnding: "lf",
      symlink: false,
    }));

    const read = await reader({
      threadId: thread,
      projectId: "project",
      rootIndex: 0,
      rootPath: "/workspace",
      relativePath: "notes.md",
      maxBytes: 100,
    });

    expect(read?.text).toBe("valid \uFFFD text");
    expect(read?.truncated).toBe(false);
    expect(read?.byteLength).toBe(Buffer.byteLength("valid \uFFFD text", "utf8"));
  });

  it("keeps a UTF-8 truncated Han document source through the real workspace reader and freezer", async () => {
    const runtime = ManagedRuntime.make(WorkspaceTestLayer);
    runtimes.push(runtime);
    const workspace = await runtime.runPromise(Effect.service(WorkspaceFileSystem));
    const root = await NodeFs.mkdtemp(path.join(tmpdir(), "learning-source-reader-"));
    const relativePath = "notes.md";
    const quote = "EVIDENCE: stable claim";
    const fullText = `${quote}\n${"汉".repeat(340_000)}`;
    await NodeFs.writeFile(path.join(root, relativePath), fullText, "utf8");

    const rawRead = await runtime.runPromise(
      workspace.readFile({ cwd: root, relativePath, maxBytes: 1_000_000 }),
    );
    expect(rawRead.truncated).toBe(true);
    // This exercises the original WFS Buffer.toString truncation defect: the native text
    // contains U+FFFD for a split Han code point and grows when re-encoded as UTF-8.
    expect(Buffer.byteLength(rawRead.contents, "utf8")).toBeGreaterThan(1_000_000);

    const userMessage = {
      id: MessageId.makeUnsafe("learning-source-pending-message"),
      role: "user",
      text: "Please use notes.md as the source.",
      turnId: null,
      streaming: true,
      createdAt: "2026-10-31T00:00:00.000Z",
      updatedAt: "2026-10-31T00:00:00.000Z",
    } as OrchestrationMessage;
    const threadRecord = {
      id: thread,
      projectId: "learning-source-project",
      messages: [userMessage],
    } as unknown as OrchestrationThread;
    const freezeContext: LearningSourceFreezeContext = {
      scope: {
        ownerId: "learning-source-owner",
        spaceId: null,
        expertId: "learning-source-expert",
        projectId: "learning-source-project",
      },
      threadId: thread,
      turnId: turn,
      currentUserMessageId: userMessage.id,
    };
    const freezer = createLearningSourceFreezer({
      readThread: async (id) => (id === thread ? threadRecord : undefined),
      readCurrentProject: async () => ({
        projectId: "learning-source-project",
        roots: [{ canonicalPath: root }],
      }),
      readRuntimeEvents: async () => [],
      readAttachment: async () => undefined,
      readDocument: workspaceLearningDocumentReader((input) =>
        runtime.runPromise(workspace.readFile(input)),
      ),
    });

    const result = await freezer.freeze(freezeContext, [{ kind: "document", relativePath, quote }]);

    expect(result.refs).toHaveLength(1);
    expect(result.refs[0]).toMatchObject({ kind: "document", truncated: true });
    expect((result.refs[0] as LearningSourceReference).kind === "document").toBe(true);
    const ref = result.refs[0];
    if (ref?.kind === "document" && ref.quote !== undefined) {
      expect(ref.quote.length).toBeLessThanOrEqual(16_000);
    }
    expect(result.texts[0]?.text).toBe(quote);
    expect(result.texts[0]?.text).not.toContain("\uFFFD");
    expect(result.coverage).toContain("source-text-truncated");

    await NodeFs.rm(root, { recursive: true, force: true });
  });
});
