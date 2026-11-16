import { completeLinxHomeMigration } from "../linxHomeMigration";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { Effect, Layer, ManagedRuntime, Option, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ServerConfig } from "../config";
import { ServerSettingsService } from "../serverSettings";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite";
import { ProviderRuntimeEventRepositoryLive } from "../persistence/Layers/ProviderRuntimeEvents";
import { ProjectAgentRepositoryLive } from "../persistence/Layers/ProjectAgentRepository";
import {
  PROVIDER_RUNTIME_INGESTION_CONSUMER,
  ProviderRuntimeEventRepository,
} from "../persistence/Services/ProviderRuntimeEvents";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery";
import { OrchestrationInfrastructureLayerLive, OrchestrationLayerLive } from "./runtimeLayer";
import { threadHasCheckpointRevertInProgress } from "./commandInvariants";
import { readQuitResumeRecord } from "./quitResume";
import { resolveCodexGeneratedImagesRoot } from "../codexGeneratedImages";
import { ProviderService } from "../provider/Services/ProviderService";

const projectId = ProjectId.makeUnsafe("imported-project");
const threadId = ThreadId.makeUnsafe("crashed-chat");
const blockedThreadId = ThreadId.makeUnsafe("crashed-approval");
const turnId = TurnId.makeUnsafe("crashed-turn");
const createdAt = "2026-01-01T00:00:00.000Z";
const disposals: Array<() => Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "linx-startup-real-")));
  roots.push(root);
  const sourceHomePath = path.join(root, ".synara-workbench");
  const homePath = path.join(root, ".linx");
  for (const home of [sourceHomePath, homePath]) {
    await fs.mkdir(path.join(home, "projects", "chat"), { recursive: true });
    await fs.mkdir(path.join(home, "extra"), { recursive: true });
    await fs.mkdir(path.join(home, "userdata"), { recursive: true });
    await fs.writeFile(path.join(home, "projects", "chat", "source.txt"), "untouched source");
  }
  const base = ManagedRuntime.make(
    Layer.mergeAll(
      SqlitePersistenceMemory,
      ProviderRuntimeEventRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory)),
      ServerSettingsService.layerTest(),
      ServerConfig.layerTest(root, homePath),
    ).pipe(Layer.provideMerge(NodeServices.layer)),
  );
  disposals.push(() => base.dispose());
  const sql = await base.runPromise(Effect.service(SqlClient.SqlClient));
  const config = await base.runPromise(Effect.service(ServerConfig));
  const settings = await base.runPromise(Effect.service(ServerSettingsService));
  const journal = await base.runPromise(Effect.service(ProviderRuntimeEventRepository));
  const dependencies = Layer.mergeAll(
    Layer.succeed(SqlClient.SqlClient, sql),
    Layer.succeed(ServerConfig, config),
    Layer.succeed(ServerSettingsService, settings),
    NodeServices.layer,
  );
  const raw = ManagedRuntime.make(
    OrchestrationEngineLive.pipe(
      Layer.provideMerge(OrchestrationInfrastructureLayerLive),
      Layer.provide(dependencies),
    ),
  );
  const engine = await raw.runPromise(Effect.service(OrchestrationEngineService));
  const dispatch = (command: Parameters<typeof engine.dispatch>[0]) =>
    raw.runPromise(engine.dispatch(command));
  await dispatch({
    type: "project.create",
    commandId: CommandId.makeUnsafe("seed-project"),
    projectId,
    title: "Imported",
    workspaceRoot: path.join(sourceHomePath, "projects", "chat"),
    defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
    createdAt,
  });
  await dispatch({
    type: "project.meta.update",
    commandId: CommandId.makeUnsafe("seed-folders"),
    projectId,
    additionalFolders: [path.join(sourceHomePath, "extra")],
  });
  for (const id of [threadId, blockedThreadId]) {
    await dispatch({
      type: "thread.create",
      commandId: CommandId.makeUnsafe(`seed-${id}`),
      threadId: id,
      projectId,
      title: id,
      modelSelection: { provider: "codex", model: "gpt-5-codex" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    await dispatch({
      type: "thread.turn.start",
      commandId: CommandId.makeUnsafe(`request-${id}`),
      threadId: id,
      message: {
        messageId: MessageId.makeUnsafe(`request-${id}`),
        role: "user",
        text: "Continue my work",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt,
    });
    await dispatch({
      type: "thread.session.set",
      commandId: CommandId.makeUnsafe(`running-${id}`),
      threadId: id,
      session: {
        threadId: id,
        status: "running",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: id === threadId ? turnId : TurnId.makeUnsafe("blocked-turn"),
        lastError: null,
        updatedAt: createdAt,
      },
      createdAt,
    });
  }
  await dispatch({
    type: "thread.activity.append",
    commandId: CommandId.makeUnsafe("checkpoint-start"),
    threadId,
    activity: {
      id: EventId.makeUnsafe("checkpoint-start"),
      kind: "checkpoint.revert.started",
      tone: "info",
      summary: "Reverting checkpoint",
      payload: {},
      turnId: null,
      createdAt,
    },
    createdAt,
  });
  await dispatch({
    type: "thread.activity.append",
    commandId: CommandId.makeUnsafe("approval-start"),
    threadId: blockedThreadId,
    activity: {
      id: EventId.makeUnsafe("approval-start"),
      kind: "approval.requested",
      tone: "info",
      summary: "Approve command",
      payload: {
        requestId: "approval-before-crash",
        requestKind: "command",
        lifecycleGeneration: "original-generation",
      },
      turnId: TurnId.makeUnsafe("blocked-turn"),
      createdAt,
    },
    createdAt,
  });
  const seeded = await raw.runPromise(engine.getReadModel());
  const snapshotQuery = await raw.runPromise(Effect.service(ProjectionSnapshotQuery));
  const blockedDetail = Option.getOrThrow(
    await raw.runPromise(snapshotQuery.getThreadDetailById(blockedThreadId)),
  );
  expect(
    blockedDetail.pendingInteractions?.find((row) => row.requestId === "approval-before-crash"),
  ).toMatchObject({ interactionKind: "approval", status: "pending" });
  expect(
    threadHasCheckpointRevertInProgress(seeded.threads.find((thread) => thread.id === threadId)!),
  ).toBe(true);
  // An accepted buffered prefix plus an unread suffix must be ingested before
  // terminalization, not stranded or rejected against the interrupted turn.
  const prefix = await base.runPromise(
    journal.append({
      type: "content.delta",
      eventId: EventId.makeUnsafe("accepted-prefix"),
      provider: "codex",
      threadId,
      turnId,
      createdAt,
      payload: { streamKind: "assistant_text", delta: "accepted " },
    }),
  );
  await base.runPromise(
    journal.advanceConsumerCursor({
      consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
      eventSequence: prefix.sequence,
      updatedAt: createdAt,
    }),
  );
  const suffix = await base.runPromise(
    journal.append({
      type: "content.delta",
      eventId: EventId.makeUnsafe("pending-suffix"),
      provider: "codex",
      threadId,
      turnId,
      createdAt,
      payload: { streamKind: "assistant_text", delta: "pending" },
    }),
  );
  const historical = await raw.runPromise(Stream.runCollect(engine.readEvents(0)));
  await raw.dispose();
  const receiptPath = path.join(homePath, "linx-home-migration.json");
  const receipt = {
    schemaVersion: 1,
    status: "paths-pending",
    sourceHomePath,
    homePath: await fs.realpath(homePath),
  };
  await fs.writeFile(receiptPath, JSON.stringify(receipt));
  await fs.writeFile(`${homePath}.linx-migration.json`, JSON.stringify(receipt));
  const boot = (quitResumeStatePath = config.quitResumeStatePath) => {
    const runtime = ManagedRuntime.make(
      OrchestrationLayerLive.pipe(
        Layer.provide(Layer.succeed(ServerConfig, { ...config, quitResumeStatePath })),
        Layer.provide(dependencies),
      ),
    );
    disposals.push(() => runtime.dispose());
    return runtime;
  };
  return {
    base,
    boot,
    dependencies,
    journal,
    suffix,
    config,
    receiptPath,
    homePath,
    sourceHomePath,
    historical,
  };
}

describe("pending Linx migration restart settlement", () => {
  it("keeps normal busy-folder admission intact when settlement is omitted", async () => {
    const input = await fixture();
    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provideMerge(OrchestrationInfrastructureLayerLive),
        Layer.provide(input.dependencies),
      ),
    );
    disposals.push(() => runtime.dispose());
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    await expect(
      runtime.runPromise(
        completeLinxHomeMigration({
          homePath: input.homePath,
          engine,
          migrateProviderBindings: () => Effect.void,
          settleOrphanedActivity: () => Effect.void,
        }),
      ),
    ).rejects.toThrow("Stop active turns and wait for checkpoint restores");
  });

  it("replays native output and settles crashed turns, checkpoints and approvals before real folder admission", async () => {
    const input = await fixture();
    const runtime = input.boot();
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshot = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const model = await runtime.runPromise(engine.getReadModel());
    expect(model.projects.find((project) => project.id === projectId)).toMatchObject({
      workspaceRoot: path.join(input.homePath, "projects", "chat"),
      additionalFolders: [path.join(input.homePath, "extra")],
    });
    const detail = Option.getOrThrow(
      await runtime.runPromise(snapshot.getThreadDetailById(threadId)),
    );
    expect(detail.latestTurn?.state).toBe("interrupted");
    expect(detail.session?.activeTurnId).toBeNull();
    expect(threadHasCheckpointRevertInProgress(detail)).toBe(false);
    expect(
      detail.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.text)
        .join(""),
    ).toBe("accepted pending");
    expect(detail.messages.every((message) => !message.streaming)).toBe(true);
    const blocked = Option.getOrThrow(
      await runtime.runPromise(snapshot.getThreadDetailById(blockedThreadId)),
    );
    expect(blocked.pendingInteractions ?? []).toEqual([]);
    const resume = await input.base.runPromise(
      readQuitResumeRecord(input.config.quitResumeStatePath),
    );
    expect(resume.kind).toBe("record");
    if (resume.kind === "record") expect(resume.record.threads).toEqual([{ threadId, turnId }]);
    expect(
      await input.base.runPromise(
        input.journal.getConsumerCursor(PROVIDER_RUNTIME_INGESTION_CONSUMER),
      ),
    ).toBe(input.suffix.sequence);
    expect(
      await input.base.runPromise(
        input.journal.readAcceptedOpenTurnEvents({
          consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
          sequenceExclusive: 0,
          limit: 100,
        }),
      ),
    ).toEqual([]);
    expect(JSON.parse(await fs.readFile(input.receiptPath, "utf8")).status).toBe("complete");
    expect(
      await fs.readFile(path.join(input.sourceHomePath, "projects", "chat", "source.txt"), "utf8"),
    ).toBe("untouched source");
    const events = await runtime.runPromise(Stream.runCollect(engine.readEvents(0)));
    expect(events.slice(0, input.historical.length)).toEqual(input.historical);
    const sequence = await runtime.runPromise(engine.getEventHighWaterSequence);
    await runtime.dispose();
    const restarted = input.boot();
    const restartedEngine = await restarted.runPromise(Effect.service(OrchestrationEngineService));
    expect(await restarted.runPromise(restartedEngine.getEventHighWaterSequence)).toBe(sequence);
    expect(
      await input.base.runPromise(readQuitResumeRecord(input.config.quitResumeStatePath)),
    ).toEqual(resume);
  });

  it("replays image IO against imported paths without providers, source writes or Markdown rewriting", async () => {
    const input = await fixture();
    vi.stubEnv("SYNARA_HOME", input.homePath);
    const studioProjectId = ProjectId.makeUnsafe("imported-studio");
    const studioThreadId = ThreadId.makeUnsafe("studio-chat");
    const studioTurnId = TurnId.makeUnsafe("studio-turn");
    const workspace = path.join(input.sourceHomePath, "projects", "studio");
    const importedWorkspace = path.join(input.homePath, "projects", "studio");
    const imageRoot = resolveCodexGeneratedImagesRoot({
      environment: { SYNARA_HOME: input.sourceHomePath },
    });
    const importedImageRoot = resolveCodexGeneratedImagesRoot({
      environment: { SYNARA_HOME: input.homePath },
    });
    expect(imageRoot.startsWith(`${input.sourceHomePath}${path.sep}`)).toBe(true);
    expect(importedImageRoot.startsWith(`${input.homePath}${path.sep}`)).toBe(true);
    const originalBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
      "base64",
    );
    const importedBytes = Buffer.concat([originalBytes, Buffer.from("imported")]);
    for (const directory of [workspace, importedWorkspace, imageRoot, importedImageRoot]) {
      await fs.mkdir(directory, { recursive: true });
    }
    for (const name of ["relative.png", "absolute.png"]) {
      await fs.writeFile(path.join(workspace, name), originalBytes);
      await fs.writeFile(path.join(importedWorkspace, name), importedBytes);
    }
    const imagePath = path.join(imageRoot, "artifact.png");
    await fs.writeFile(imagePath, originalBytes);
    await fs.writeFile(path.join(importedImageRoot, "artifact.png"), importedBytes);
    const externalImage = path.join(path.dirname(input.homePath), "external.png");
    await fs.writeFile(externalImage, originalBytes);
    const markdown = `![relative](./relative.png)\n![absolute](${path.join(workspace, "absolute.png")})\n![external](${externalImage})`;
    const raw = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provideMerge(OrchestrationInfrastructureLayerLive),
        Layer.provideMerge(ProjectAgentRepositoryLive),
        Layer.provide(input.dependencies),
      ),
    );
    disposals.push(() => raw.dispose());
    const engine = await raw.runPromise(Effect.service(OrchestrationEngineService));
    await raw.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("studio-project"),
        projectId: studioProjectId,
        kind: "group",
        title: "Studio",
        workspaceRoot: workspace,
        createdAt,
      }),
    );
    await raw.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("studio-thread"),
        threadId: studioThreadId,
        projectId: studioProjectId,
        title: "Images",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await raw.runPromise(
      engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("studio-running"),
        threadId: studioThreadId,
        session: {
          threadId: studioThreadId,
          providerName: "codex",
          status: "running",
          runtimeMode: "approval-required",
          activeTurnId: studioTurnId,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );
    await raw.dispose();
    const base = {
      provider: "codex" as const,
      threadId: studioThreadId,
      turnId: studioTurnId,
      createdAt,
    };
    await input.base.runPromise(
      input.journal.append({
        ...base,
        type: "content.delta",
        eventId: EventId.makeUnsafe("image-markdown"),
        itemId: RuntimeItemId.makeUnsafe("image-answer"),
        payload: { streamKind: "assistant_text", delta: markdown },
      }),
    );
    await input.base.runPromise(
      input.journal.append({
        ...base,
        type: "item.completed",
        eventId: EventId.makeUnsafe("image-message-complete"),
        itemId: RuntimeItemId.makeUnsafe("image-answer"),
        payload: { itemType: "assistant_message", status: "completed" },
      }),
    );
    await input.base.runPromise(
      input.journal.append({
        ...base,
        type: "item.completed",
        eventId: EventId.makeUnsafe("image-artifact"),
        itemId: RuntimeItemId.makeUnsafe("generated-image"),
        payload: {
          itemType: "image_generation",
          status: "completed",
          data: { kind: "codex.generated_image", path: imagePath, callId: "generated-image" },
        },
      }),
    );
    const before = await fs.readdir(input.sourceHomePath, { recursive: true });
    const runtime = input.boot();
    await runtime.runPromise(Effect.service(OrchestrationEngineService));
    expect(await runtime.runPromise(Effect.serviceOption(ProviderService))).toEqual(Option.none());
    const query = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const detail = Option.getOrThrow(
      await runtime.runPromise(query.getThreadDetailById(studioThreadId)),
    );
    const message = detail.messages.find((message) => message.id === "assistant:image-answer");
    expect(message?.text).toContain(markdown);
    const images = message?.attachments?.filter((attachment) => attachment.type === "image") ?? [];
    expect(images.map((attachment) => attachment.sourcePath)).toEqual(
      expect.arrayContaining(["./relative.png", path.join(workspace, "absolute.png")]),
    );
    expect(images.some((attachment) => attachment.sourcePath === externalImage)).toBe(false);
    expect(
      await fs.readFile(
        path.join(importedWorkspace, "Outbox", "Images", "2026-01-01_generated-image.png"),
      ),
    ).toEqual(importedBytes);
    expect(await fs.readdir(input.sourceHomePath, { recursive: true })).toEqual(before);
    expect(await fs.readFile(imagePath)).toEqual(originalBytes);
    expect(await fs.readFile(path.join(workspace, "absolute.png"))).toEqual(originalBytes);
    const sourceEvent = (
      await input.base.runPromise(
        input.journal.readThreadEvents({
          threadId: studioThreadId,
          throughSequenceInclusive: await input.base.runPromise(input.journal.getHighWaterSequence),
          eventIds: ["image-artifact"],
          limit: 1,
        }),
      )
    )[0];
    expect(sourceEvent?.event.payload).toMatchObject({ data: { path: imagePath } });
  });

  it("retries pending image replay with the same reservation after a real storage failure", async () => {
    const input = await fixture();
    const sourceImage = path.join(input.sourceHomePath, "projects", "chat", "retry.png");
    const importedImage = path.join(input.homePath, "projects", "chat", "retry.png");
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
      "base64",
    );
    await fs.writeFile(sourceImage, bytes);
    await fs.writeFile(importedImage, bytes);
    const sourceBefore = await fs.readdir(input.sourceHomePath, { recursive: true });
    await input.base.runPromise(
      input.journal.append({
        type: "content.delta",
        eventId: EventId.makeUnsafe("retry-image-markdown"),
        itemId: RuntimeItemId.makeUnsafe("retry-image-answer"),
        provider: "codex",
        threadId,
        turnId,
        createdAt,
        payload: { streamKind: "assistant_text", delta: "![retry](./retry.png)" },
      }),
    );
    const completion = await input.base.runPromise(
      input.journal.append({
        type: "item.completed",
        eventId: EventId.makeUnsafe("retry-image-complete"),
        itemId: RuntimeItemId.makeUnsafe("retry-image-answer"),
        provider: "codex",
        threadId,
        turnId,
        createdAt,
        payload: { itemType: "assistant_message", status: "completed" },
      }),
    );
    // Block the managed write, not source resolution or the reservation transaction.
    await fs.rmdir(input.config.attachmentsDir);
    await fs.writeFile(input.config.attachmentsDir, "storage unavailable");
    const failed = input.boot();
    await expect(failed.runPromise(Effect.service(OrchestrationEngineService))).rejects.toThrow();
    await failed.dispose();
    expect(JSON.parse(await fs.readFile(input.receiptPath, "utf8")).status).toBe("paths-pending");
    const sql = await input.base.runPromise(Effect.service(SqlClient.SqlClient));
    const failedRows = await input.base.runPromise(
      sql<{ attachmentId: string; state: string; deleteReason: string }>`
        SELECT attachment_id AS "attachmentId", state, delete_reason AS "deleteReason"
        FROM managed_attachment_blobs
      `,
    );
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0]).toMatchObject({
      state: "deleting",
      deleteReason: "upload-write-failed",
    });
    expect(
      await input.base.runPromise(
        input.journal.getConsumerCursor(PROVIDER_RUNTIME_INGESTION_CONSUMER),
      ),
    ).toBeLessThan(completion.sequence);
    await fs.unlink(input.config.attachmentsDir);
    const retried = input.boot();
    await retried.runPromise(Effect.service(OrchestrationEngineService));
    const query = await retried.runPromise(Effect.service(ProjectionSnapshotQuery));
    const detail = Option.getOrThrow(await retried.runPromise(query.getThreadDetailById(threadId)));
    const message = detail.messages.find((row) => row.id === "assistant:retry-image-answer");
    expect(message?.text).toContain("![retry](./retry.png)");
    expect(message?.attachments).toEqual([
      expect.objectContaining({
        id: failedRows[0]!.attachmentId,
        type: "image",
        sourcePath: "./retry.png",
      }),
    ]);
    expect(
      await input.base.runPromise(sql`SELECT attachment_id FROM managed_attachment_cleanup_jobs`),
    ).toEqual([]);
    expect(
      await input.base.runPromise(
        sql<{ state: string }>`SELECT state FROM managed_attachment_blobs`,
      ),
    ).toEqual([{ state: "claimed" }]);
    expect(JSON.parse(await fs.readFile(input.receiptPath, "utf8")).status).toBe("complete");
    expect(await fs.readFile(sourceImage)).toEqual(bytes);
    expect(await fs.readFile(importedImage)).toEqual(bytes);
    expect(await fs.readdir(input.sourceHomePath, { recursive: true })).toEqual(sourceBefore);
  });

  it.each(["codex", "claudeAgent", "antigravity", "cursor"] as const)(
    "replays pending %s diff capability without a live provider",
    async (provider) => {
      const input = await fixture();
      for (const home of [input.sourceHomePath, input.homePath]) {
        await fs.mkdir(path.join(home, "projects", "chat", ".git"));
      }
      const pending = await input.base.runPromise(
        input.journal.append({
          type: "turn.diff.updated",
          eventId: EventId.makeUnsafe(`pending-${provider}-diff`),
          provider,
          threadId,
          turnId,
          createdAt,
          payload: {
            unifiedDiff: [
              "diff --git a/source.txt b/source.txt",
              "index 1111111..2222222 100644",
              "--- a/source.txt",
              "+++ b/source.txt",
              "@@ -1 +1,2 @@",
              "-untouched source",
              "+updated source",
              "+new line",
              "",
            ].join("\n"),
          },
        }),
      );
      const runtime = input.boot();
      await runtime.runPromise(Effect.service(OrchestrationEngineService));
      expect(await runtime.runPromise(Effect.serviceOption(ProviderService))).toEqual(
        Option.none(),
      );
      const query = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
      const detail = Option.getOrThrow(
        await runtime.runPromise(query.getThreadDetailById(threadId)),
      );
      expect(detail.checkpoints.find((checkpoint) => checkpoint.turnId === turnId)).toMatchObject({
        checkpointRef: `provider-diff:pending-${provider}-diff`,
        status: "missing",
        files:
          provider === "codex"
            ? [{ path: "source.txt", kind: "modified", additions: 2, deletions: 1 }]
            : [],
      });
      expect(detail.latestTurn?.state).toBe("interrupted");
      expect(
        await input.base.runPromise(
          input.journal.getConsumerCursor(PROVIDER_RUNTIME_INGESTION_CONSUMER),
        ),
      ).toBe(pending.sequence);
      expect(
        await fs.readFile(
          path.join(input.sourceHomePath, "projects", "chat", "source.txt"),
          "utf8",
        ),
      ).toBe("untouched source");
      expect(JSON.parse(await fs.readFile(input.receiptPath, "utf8")).status).toBe("complete");
    },
  );

  it("honors a terminal event already in the journal instead of resuming completed work", async () => {
    const input = await fixture();
    await input.base.runPromise(
      input.journal.append({
        type: "turn.completed",
        eventId: EventId.makeUnsafe("persisted-terminal"),
        provider: "codex",
        threadId,
        turnId,
        createdAt,
        payload: { state: "completed" },
      }),
    );
    const runtime = input.boot();
    const query = await runtime.runPromise(
      Effect.service(ProjectionSnapshotQuery).pipe(
        Effect.tap(() => Effect.service(OrchestrationEngineService)),
      ),
    );
    const detail = Option.getOrThrow(await runtime.runPromise(query.getThreadDetailById(threadId)));
    expect(detail.latestTurn?.state).toBe("completed");
    expect(
      await input.base.runPromise(readQuitResumeRecord(input.config.quitResumeStatePath)),
    ).toEqual({ kind: "absent" });
    expect(JSON.parse(await fs.readFile(input.receiptPath, "utf8")).status).toBe("complete");
  });

  it("retains explicit quit intent without claiming it during migration", async () => {
    const input = await fixture();
    const record = {
      version: 1,
      recordId: "explicit-quit",
      recordedAt: createdAt,
      continuationPrompt: "Use my original quit continuation",
      threads: [{ threadId, turnId }],
    };
    await fs.writeFile(input.config.quitResumeStatePath, JSON.stringify(record));
    const runtime = input.boot();
    await runtime.runPromise(Effect.service(OrchestrationEngineService));
    expect(
      await input.base.runPromise(readQuitResumeRecord(input.config.quitResumeStatePath)),
    ).toEqual({ kind: "record", record });
  });

  it("does not terminalize an orphan when its crash intent cannot be persisted", async () => {
    const input = await fixture();
    const blocker = path.join(input.homePath, "not-a-directory");
    await fs.writeFile(blocker, "block resume persistence");
    const runtime = input.boot(path.join(blocker, "resume.json"));
    await expect(runtime.runPromise(Effect.service(OrchestrationEngineService))).rejects.toThrow();
    await runtime.dispose();
    expect(JSON.parse(await fs.readFile(input.receiptPath, "utf8")).status).toBe("paths-pending");
    const raw = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provideMerge(OrchestrationInfrastructureLayerLive),
        Layer.provide(input.dependencies),
      ),
    );
    disposals.push(() => raw.dispose());
    const engine = await raw.runPromise(Effect.service(OrchestrationEngineService));
    expect(
      (await raw.runPromise(engine.getReadModel())).threads.find((thread) => thread.id === threadId)
        ?.latestTurn?.state,
    ).toBe("running");
    await raw.dispose();
    await input.boot().runPromise(Effect.service(OrchestrationEngineService));
    expect(JSON.parse(await fs.readFile(input.receiptPath, "utf8")).status).toBe("complete");
  });

  it("does not run migration settlement on an ordinary startup without a receipt", async () => {
    const input = await fixture();
    await fs.unlink(input.receiptPath);
    await fs.unlink(`${input.homePath}.linx-migration.json`);
    const runtime = input.boot();
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const model = await runtime.runPromise(engine.getReadModel());
    const thread = model.threads.find((thread) => thread.id === threadId);
    expect(thread?.latestTurn?.state).toBe("running");
    expect(thread && threadHasCheckpointRevertInProgress(thread)).toBe(true);
    expect(
      await input.base.runPromise(
        input.journal.getConsumerCursor(PROVIDER_RUNTIME_INGESTION_CONSUMER),
      ),
    ).toBe(input.suffix.sequence - 1);
    expect(
      await input.base.runPromise(readQuitResumeRecord(input.config.quitResumeStatePath)),
    ).toEqual({ kind: "absent" });
  });

  it("keeps the receipt pending and the orphan resumable when settlement persistence fails, then retries", async () => {
    const input = await fixture();
    // Inject a real persistence failure through SQLite, not a forwarding engine.
    const sql = await input.base.runPromise(Effect.service(SqlClient.SqlClient));
    await input.base.runPromise(
      sql.unsafe(
        `CREATE TRIGGER fail_restart_session BEFORE UPDATE ON projection_thread_sessions WHEN NEW.status = 'interrupted' BEGIN SELECT RAISE(ABORT, 'restart settlement unavailable'); END`,
      ),
    );
    const failed = input.boot();
    await expect(failed.runPromise(Effect.service(OrchestrationEngineService))).rejects.toThrow();
    await failed.dispose();
    expect(JSON.parse(await fs.readFile(input.receiptPath, "utf8")).status).toBe("paths-pending");
    expect(
      (await input.base.runPromise(readQuitResumeRecord(input.config.quitResumeStatePath))).kind,
    ).toBe("record");
    await input.base.runPromise(sql.unsafe("DROP TRIGGER fail_restart_session"));
    const retried = input.boot();
    await retried.runPromise(Effect.service(OrchestrationEngineService));
    expect(JSON.parse(await fs.readFile(input.receiptPath, "utf8")).status).toBe("complete");
  });
});
