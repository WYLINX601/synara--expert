// FILE: assistantImageAttachments.test.ts
// Purpose: Exercise filesystem scope, Markdown selection and managed snapshot recovery.
// Layer: Server storage boundary tests with the real SQLite attachment repository.
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it } from "vitest";

import {
  stageAssistantImageAttachments,
  cancelAssistantImageAttachments,
} from "./assistantImageAttachments.ts";
import { LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL } from "./managedAttachmentPrincipal.ts";
import { reserveManagedAttachmentUpload } from "./managedAttachmentStore.ts";
import { ManagedAttachmentRepositoryLive } from "./persistence/Layers/ManagedAttachments.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import { ManagedAttachmentRepository } from "./persistence/Services/ManagedAttachments.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);

it("keeps lexical and real image scope paired after discovering a sibling root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "inline-image-scope-"));
  const runtime = ManagedRuntime.make(
    ManagedAttachmentRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
  );
  try {
    const repository = await runtime.runPromise(Effect.service(ManagedAttachmentRepository));
    const cwd = path.join(root, "project");
    const sibling = path.join(root, "sibling");
    await fs.mkdir(cwd);
    await fs.mkdir(sibling);
    for (const name of ["first.png", "private.png"])
      await fs.writeFile(path.join(sibling, name), png);
    for (const name of ["inside space.png", "literal%20.png", "code-only.png"])
      await fs.writeFile(path.join(cwd, name), png);
    await fs.symlink(path.join(sibling, "private.png"), path.join(cwd, "escape.png"));
    const fileUri = pathToFileURL(path.join(cwd, "inside space.png"));
    const text = [
      "![legitimate](../sibling/first.png)",
      "![escaped](./escape.png)",
      `![URI](${fileUri.href})`,
      "![literal][named]",
      "[named]: ./literal%2520.png",
      "`![code](./code-only.png)`",
      "```md\n![fenced](./code-only.png)\n```",
      "[ordinary](./code-only.png)",
      "![network](https://example.invalid/image.png)",
    ].join("\n\n");
    const prepared = await runtime.runPromise(
      stageAssistantImageAttachments({
        text,
        threadId: "scope-thread",
        messageId: "scope-message",
        commandId: "scope-complete",
        cwd,
        sourceRoots: [cwd],
        additionalSourceRoots: Effect.succeed([sibling]),
        attachmentsDir: path.join(root, "attachments"),
        existingAttachments: [],
        repository,
      }),
    );
    expect(prepared.attachments.map((image) => image.sourcePath)).toEqual([
      "../sibling/first.png",
      decodeURIComponent(fileUri.pathname),
      "./literal%20.png",
    ]);
  } finally {
    await runtime.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("gives a rejected completion a new reservation without deleting an accepted snapshot", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "inline-image-retry-"));
  const runtime = ManagedRuntime.make(
    ManagedAttachmentRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
  );
  try {
    const repository = await runtime.runPromise(Effect.service(ManagedAttachmentRepository));
    const source = path.join(root, "image.png");
    await fs.writeFile(source, png);
    const input = {
      text: "![image](./image.png)",
      threadId: "retry-thread",
      messageId: "retry-message",
      cwd: root,
      sourceRoots: [root],
      attachmentsDir: path.join(root, "attachments"),
      existingAttachments: [],
      repository,
    };
    const foreign = await runtime.runPromise(
      stageAssistantImageAttachments({
        ...input,
        threadId: "other-thread",
        messageId: "other-message",
        commandId: "other-completion",
      }),
    );
    expect(foreign.attachments).toHaveLength(1);
    const foreignReference = await runtime.runPromise(
      stageAssistantImageAttachments({
        ...input,
        commandId: "foreign-alias-completion",
        existingAttachments: foreign.attachments,
      }),
    );
    expect(foreignReference.attachments).toEqual([]);
    const untouched = await runtime.runPromise(
      repository.findServerOwned({
        attachmentId: foreign.attachments[0]!.id,
        ownerThreadId: "other-thread",
        ...LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
        now: new Date().toISOString(),
      }),
    );
    expect(Option.isSome(untouched) && untouched.value.state).toBe("staged");
    const first = await runtime.runPromise(
      stageAssistantImageAttachments({ ...input, commandId: "rejected-completion" }),
    );
    expect(first.attachments).toHaveLength(1);
    await runtime.runPromise(
      cancelAssistantImageAttachments({ attachmentIds: first.attachmentIds, repository }),
    );
    const second = await runtime.runPromise(
      stageAssistantImageAttachments({ ...input, commandId: "accepted-completion" }),
    );
    expect(second.attachments).toHaveLength(1);
    expect(second.attachments[0]!.id).not.toBe(first.attachments[0]!.id);
    const claim = await runtime.runPromise(
      repository.claimForAcceptedTurn({
        attachmentIds: second.attachmentIds,
        ownerThreadId: input.threadId,
        ...LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
        commandId: "accepted-completion",
        messageId: input.messageId,
        now: new Date().toISOString(),
      }),
    );
    expect(claim.status).toBe("claimed");
    await fs.unlink(source);
    await runtime.runPromise(
      cancelAssistantImageAttachments({ attachmentIds: second.attachmentIds, repository }),
    );
    const replay = await runtime.runPromise(
      stageAssistantImageAttachments({
        ...input,
        commandId: "next-completion",
        existingAttachments: second.attachments,
      }),
    );
    expect(replay.attachments).toEqual(second.attachments);
    const claimed = await runtime.runPromise(
      repository.findClaimedById({ attachmentId: second.attachments[0]!.id }),
    );
    expect(Option.isSome(claimed)).toBe(true);
  } finally {
    await runtime.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function replayFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "inline-image-offline-retry-"));
  const runtime = ManagedRuntime.make(
    ManagedAttachmentRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
  );
  const repository = await runtime.runPromise(Effect.service(ManagedAttachmentRepository));
  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
  const input = {
    text: "![image](./image.png)",
    threadId: "offline-thread",
    messageId: "offline-message",
    commandId: "offline-completion",
    cwd: root,
    sourceRoots: [root],
    attachmentsDir: path.join(root, "attachments"),
    existingAttachments: [],
    repository,
  };
  await fs.writeFile(path.join(root, "image.png"), png);
  const identity = (sourcePath: string) => {
    const id = `att_v2_${createHash("sha256")
      .update(JSON.stringify([input.threadId, input.messageId, sourcePath, input.commandId]))
      .digest("hex")
      .slice(0, 32)}`;
    return {
      id,
      relativePath: `objects/${id.slice(7, 9)}/${id}.png`,
      partialPath: path.join(input.attachmentsDir, ".staging", `${id}.part`),
    };
  };
  return {
    root,
    runtime,
    repository,
    input,
    identity,
    rows: () =>
      runtime.runPromise(sql<{
        attachmentId: string;
        state: string;
        deleteReason: string | null;
      }>`SELECT attachment_id AS "attachmentId", state, delete_reason AS "deleteReason"
         FROM managed_attachment_blobs ORDER BY attachment_id`),
    jobs: () => runtime.runPromise(sql`SELECT * FROM managed_attachment_cleanup_jobs`),
    close: async () => {
      await runtime.dispose();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

it.each([true, false])(
  "retries a real post-reservation write failure only for offline replay (%s)",
  async (offline) => {
    const fixture = await replayFixture();
    const { input, root, runtime, identity } = fixture;
    const options = {
      ...input,
      ...(offline ? { resolveSourcePath: (source: string) => Effect.succeed(source) } : {}),
    };
    try {
      // The reservation succeeds, then directory creation actually fails.
      await fs.writeFile(input.attachmentsDir, "not a directory");
      const failed = runtime.runPromise(stageAssistantImageAttachments(options));
      if (offline) await expect(failed).rejects.toThrow("Failed to persist attachment bytes");
      else expect(await failed).toEqual({ attachments: [], attachmentIds: [] });
      expect(await fixture.rows()).toEqual([
        {
          attachmentId: identity("./image.png").id,
          state: "deleting",
          deleteReason: "upload-write-failed",
        },
      ]);
      expect(await fixture.jobs()).toHaveLength(1);
      await fs.unlink(input.attachmentsDir);
      const retried = await runtime.runPromise(stageAssistantImageAttachments(options));
      if (offline) {
        expect(retried.attachmentIds).toEqual([identity("./image.png").id]);
        expect(await fixture.jobs()).toEqual([]);
        expect(
          await fs.readFile(path.join(input.attachmentsDir, identity("./image.png").relativePath)),
        ).toEqual(png);
        expect(await fixture.rows()).toEqual([
          { attachmentId: identity("./image.png").id, state: "staged", deleteReason: null },
        ]);
      } else {
        expect(retried).toEqual({ attachments: [], attachmentIds: [] });
        expect(await fixture.jobs()).toHaveLength(1);
        expect((await fixture.rows())[0]?.state).toBe("deleting");
      }
      expect(await fs.readFile(path.join(root, "image.png"))).toEqual(png);
    } finally {
      await fixture.close();
    }
  },
);

it("recovers an offline crashed uploading row and only its deterministic private partial", async () => {
  const fixture = await replayFixture();
  const { input, root, runtime, repository, identity } = fixture;
  try {
    const own = identity("./image.png");
    await runtime.runPromise(
      reserveManagedAttachmentUpload({
        attachmentId: own.id,
        type: "image",
        threadId: input.threadId,
        name: "image.png",
        mimeType: "image/png",
        reservedBytes: png.byteLength,
        now: new Date().toISOString(),
        principal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
        repository,
      }),
    );
    await fs.mkdir(path.dirname(own.partialPath), { recursive: true });
    await fs.mkdir(path.dirname(path.join(input.attachmentsDir, own.relativePath)), {
      recursive: true,
    });
    await fs.writeFile(own.partialPath, "interrupted write", { mode: 0o600 });
    const otherPartial = path.join(path.dirname(own.partialPath), "unrelated.part");
    await fs.writeFile(otherPartial, "leave alone");
    const finalPath = path.join(input.attachmentsDir, own.relativePath);
    await fs.writeFile(finalPath, "previous uncommitted snapshot");
    const result = await runtime.runPromise(
      stageAssistantImageAttachments({
        ...input,
        resolveSourcePath: (source) => Effect.succeed(source),
      }),
    );
    expect(result.attachmentIds).toEqual([own.id]);
    expect(await fs.readFile(finalPath)).toEqual(png);
    expect((await fs.stat(finalPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(own.partialPath))).mode & 0o777).toBe(0o700);
    await expect(fs.stat(own.partialPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(otherPartial, "utf8")).toBe("leave alone");
    expect(await fs.readFile(path.join(root, "image.png"))).toEqual(png);
    expect(await fixture.jobs()).toEqual([]);
  } finally {
    await fixture.close();
  }
});

it("revives cancelled earlier images after a later offline image write fails", async () => {
  const fixture = await replayFixture();
  const { input, root, runtime, identity } = fixture;
  const first = identity("./image.png");
  const second = identity("./second.png");
  const secondFinal = path.join(input.attachmentsDir, second.relativePath);
  const options = {
    ...input,
    text: "![first](./image.png)\n\n![second](./second.png)",
    resolveSourcePath: (source: string) => Effect.succeed(source),
  };
  try {
    await fs.writeFile(path.join(root, "second.png"), png);
    // Only the second atomic rename fails; the first snapshot is already staged.
    await fs.mkdir(secondFinal, { recursive: true });
    await expect(runtime.runPromise(stageAssistantImageAttachments(options))).rejects.toThrow(
      "Failed to persist attachment bytes",
    );
    expect(await fixture.rows()).toEqual(
      [
        {
          attachmentId: first.id,
          state: "deleting",
          deleteReason: "assistant-image-completion-not-committed",
        },
        { attachmentId: second.id, state: "deleting", deleteReason: "upload-write-failed" },
      ].sort((a, b) => a.attachmentId.localeCompare(b.attachmentId)),
    );
    expect(await fixture.jobs()).toHaveLength(2);
    expect(await fs.readFile(path.join(input.attachmentsDir, first.relativePath))).toEqual(png);
    await fs.rmdir(secondFinal);
    const retried = await runtime.runPromise(stageAssistantImageAttachments(options));
    expect(retried.attachmentIds).toEqual([first.id, second.id]);
    expect(await fixture.jobs()).toEqual([]);
    for (const own of [first, second]) {
      expect(await fs.readFile(path.join(input.attachmentsDir, own.relativePath))).toEqual(png);
    }
    expect(await fs.readFile(path.join(root, "image.png"))).toEqual(png);
    expect(await fs.readFile(path.join(root, "second.png"))).toEqual(png);
    const claimed = await runtime.runPromise(
      fixture.repository.claimForAcceptedTurn({
        attachmentIds: retried.attachmentIds,
        ownerThreadId: input.threadId,
        ...LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
        commandId: input.commandId,
        messageId: input.messageId,
        now: new Date().toISOString(),
      }),
    );
    expect(claimed.status).toBe("claimed");
  } finally {
    await fixture.close();
  }
});
