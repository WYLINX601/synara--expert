import { chmod, lstat, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  ThreadId,
  type ExpertAppliedRuntimeRecord,
  type ExpertSnapshot,
  type HubWorkRecord,
  type OrchestrationThread,
} from "@synara/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createExpertStore, type ExpertStore } from "../../experts/ExpertStore.ts";
import { CLAUDE_EXPERT_PROJECTION_VERSION } from "../../provider/claudeExpertSession.ts";
import type { HubWorkService } from "../../projectAgent/hubWorkService.ts";
import type { HubWorkRepositoryShape } from "../../persistence/Services/HubWorkRepository.ts";
import { createSkillPackageSwitchHost } from "./skillPackageSwitchHost.ts";

const roots: string[] = [];

async function unlockTree(entry: string): Promise<void> {
  await chmod(entry, 0o700).catch(() => undefined);
  for (const name of await readdir(entry).catch(() => [])) {
    const child = path.join(entry, name);
    const childStat = await lstat(child);
    if (childStat.isSymbolicLink()) continue;
    if (childStat.isDirectory()) await unlockTree(child);
    else await chmod(child, 0o600).catch(() => undefined);
  }
}

async function makeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "skill-package-switch-host-"));
  roots.push(root);
  const stateDir = path.join(root, "state");
  const experts = createExpertStore(stateDir);
  const definition = await experts.save({
    id: "switch-fixture",
    name: "Switch fixture",
    description: "",
    useCases: "",
    persona: "",
    outputRequirements: "",
    skills: [],
    skillSelections: [],
    references: [],
    connections: [],
  });
  const binding = await experts.prepareSnapshot(definition.id);
  return { stateDir, experts, binding };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await unlockTree(root);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("skill package switch host adapter", () => {
  it("inventories projected threads, applied runtime rows, and durable Hub history", async () => {
    const { stateDir, experts, binding } = await makeFixture();
    const threadId = ThreadId.makeUnsafe("switch-thread");
    const thread = {
      id: threadId,
      expertBinding: binding,
      latestTurn: null,
      session: null,
    } as unknown as OrchestrationThread;
    const history = {
      id: "hub-history-1",
      sourceThreadId: threadId,
      sourceMessages: [],
      workerThreadId: null,
      state: "completed",
      creationSpec: { expertBinding: binding },
    } as unknown as HubWorkRecord;
    const repo = {
      listAll: () => Effect.succeed([history]),
      get: (id: string) => Effect.succeed(id === history.id ? history : null),
    } as unknown as HubWorkRepositoryShape;
    const service = {
      cancel: vi.fn(() => Effect.succeed(history)),
      setState: vi.fn(() => Effect.succeed(history)),
    } as unknown as Pick<HubWorkService, "cancel" | "setState">;
    const host = createSkillPackageSwitchHost({
      stateDir,
      experts,
      hubWorkRepository: repo,
      hubWorkService: service,
      readThreads: async () => [thread],
      readAppliedRuntimeRecords: async () => [],
      runEffect: Effect.runPromise,
      dispatch: async () => undefined,
    });

    const inventory = await host.readInventory({
      allowlistedThreadIds: [threadId],
      allowlistedSnapshotIds: [binding.snapshotId],
    });
    expect(inventory.complete).toBe(true);
    expect(inventory.threads).toEqual([
      { threadId, kind: "test", snapshotIds: [binding.snapshotId], deleted: false },
    ]);
    expect(inventory.hubWorks).toMatchObject([
      { workId: history.id, kind: "test", state: "completed" },
    ]);
    expect(inventory.snapshots[0]?.references).toEqual([
      { kind: "hub-work", id: history.id },
      { kind: "thread", id: threadId },
    ]);
  });

  it("fails closed when an applied runtime points at a snapshot outside stored inventory", async () => {
    const { stateDir, experts, binding } = await makeFixture();
    const threadId = ThreadId.makeUnsafe("orphan-runtime-thread");
    const repo = {
      listAll: () => Effect.succeed([]),
      get: () => Effect.succeed(null),
    } as unknown as HubWorkRepositoryShape;
    const host = createSkillPackageSwitchHost({
      stateDir,
      experts,
      hubWorkRepository: repo,
      hubWorkService: {
        cancel: vi.fn(),
        setState: vi.fn(),
      } as unknown as Pick<HubWorkService, "cancel" | "setState">,
      readThreads: async () => [
        {
          id: threadId,
          expertBinding: binding,
          latestTurn: null,
          session: null,
        } as unknown as OrchestrationThread,
      ],
      readAppliedRuntimeRecords: async () => [
        {
          threadId,
          snapshotId: `exp_${"f".repeat(64)}`,
        } as ExpertAppliedRuntimeRecord,
      ],
      runEffect: Effect.runPromise,
      dispatch: async () => undefined,
    });

    const inventory = await host.readInventory({
      allowlistedThreadIds: [threadId],
      allowlistedSnapshotIds: [binding.snapshotId],
    });
    expect(inventory.complete).toBe(false);
  });

  it("rechecks under ExpertStore's lifecycle lock before removing a newly referenced snapshot", async () => {
    const { stateDir, experts, binding } = await makeFixture();
    const threadId = ThreadId.makeUnsafe("late-switch-thread");
    let bindingAppeared = false;
    const lateThread = {
      id: threadId,
      expertBinding: binding,
      latestTurn: null,
      session: null,
    } as unknown as OrchestrationThread;
    const repo = {
      listAll: () => Effect.succeed([]),
      get: () => Effect.succeed(null),
    } as unknown as HubWorkRepositoryShape;
    const host = createSkillPackageSwitchHost({
      stateDir,
      experts,
      hubWorkRepository: repo,
      hubWorkService: {
        cancel: vi.fn(),
        setState: vi.fn(),
      } as unknown as Pick<HubWorkService, "cancel" | "setState">,
      readThreads: async () => (bindingAppeared ? [lateThread] : []),
      readAppliedRuntimeRecords: async () => [],
      runEffect: Effect.runPromise,
      dispatch: async () => undefined,
    });

    const reviewed = await host.readInventory({
      allowlistedThreadIds: [threadId],
      allowlistedSnapshotIds: [binding.snapshotId],
    });
    expect(reviewed.snapshots[0]?.references).toEqual([]);
    bindingAppeared = true;

    await expect(
      host.cleanupLegacyArtifacts({
        threadIds: [threadId],
        snapshotIds: [binding.snapshotId],
        projectionIds: [],
      }),
    ).rejects.toThrow(/new task or Hub reference/u);
    await expect(
      stat(path.join(stateDir, "experts", "snapshots", binding.snapshotId, "snapshot.json")),
    ).resolves.toBeDefined();
  });

  it("allows an already soft-deleted target when cleanup intentionally retains its snapshot", async () => {
    const { stateDir, experts, binding } = await makeFixture();
    const threadId = ThreadId.makeUnsafe("deleted-switch-thread");
    const deletedThread = {
      id: threadId,
      expertBinding: binding,
      deletedAt: new Date().toISOString(),
      latestTurn: null,
      session: null,
    } as unknown as OrchestrationThread;
    const repo = {
      listAll: () => Effect.succeed([]),
      get: () => Effect.succeed(null),
    } as unknown as HubWorkRepositoryShape;
    const host = createSkillPackageSwitchHost({
      stateDir,
      experts,
      hubWorkRepository: repo,
      hubWorkService: {
        cancel: vi.fn(),
        setState: vi.fn(),
      } as unknown as Pick<HubWorkService, "cancel" | "setState">,
      readThreads: async () => [deletedThread],
      readAppliedRuntimeRecords: async () => [],
      runEffect: Effect.runPromise,
      dispatch: async () => undefined,
    });

    await expect(
      host.cleanupLegacyArtifacts({
        threadIds: [threadId],
        snapshotIds: [],
        projectionIds: [],
      }),
    ).resolves.toBeUndefined();
    await expect(
      stat(path.join(stateDir, "experts", "snapshots", binding.snapshotId, "snapshot.json")),
    ).resolves.toBeDefined();
  });

  it("uses native interrupt, session stop, and delete commands and waits for readback", async () => {
    const { stateDir, experts, binding } = await makeFixture();
    const threadId = ThreadId.makeUnsafe("native-switch-thread");
    let thread: OrchestrationThread | null = {
      id: threadId,
      expertBinding: binding,
      deletedAt: null,
      latestTurn: {
        turnId: "turn-running",
        state: "running",
        requestedAt: "2026-10-20T00:00:00.000Z",
        startedAt: "2026-10-20T00:00:01.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
      session: {
        threadId,
        status: "ready",
        providerName: null,
        runtimeMode: "approval-required",
        activeTurnId: "turn-running",
        lastError: null,
        updatedAt: "2026-10-20T00:00:01.000Z",
      },
    } as unknown as OrchestrationThread;
    const commands: string[] = [];
    const repo = {
      listAll: () => Effect.succeed([]),
      get: () => Effect.succeed(null),
    } as unknown as HubWorkRepositoryShape;
    const host = createSkillPackageSwitchHost({
      stateDir,
      experts,
      hubWorkRepository: repo,
      hubWorkService: {
        cancel: vi.fn(),
        setState: vi.fn(),
      } as unknown as Pick<HubWorkService, "cancel" | "setState">,
      readThreads: async () => (thread ? [thread] : []),
      readAppliedRuntimeRecords: async () => [],
      runEffect: Effect.runPromise,
      dispatch: async (command) => {
        commands.push(command.type);
        if (command.type === "thread.turn.interrupt" && thread?.latestTurn) {
          thread = {
            ...thread,
            latestTurn: {
              ...thread.latestTurn,
              state: "interrupted",
              completedAt: command.createdAt,
            },
          } as OrchestrationThread;
        }
        if (command.type === "thread.session.stop" && thread?.session) {
          thread = {
            ...thread,
            session: { ...thread.session, status: "stopped" },
          } as OrchestrationThread;
        }
        if (command.type === "thread.delete" && thread) {
          thread = { ...thread, deletedAt: "2026-10-20T00:00:02.000Z" } as OrchestrationThread;
        }
      },
      sleep: async () => undefined,
    });

    await host.deleteThread(threadId);
    expect(commands).toEqual(["thread.turn.interrupt", "thread.session.stop", "thread.delete"]);
    expect(thread?.deletedAt).toBeTruthy();
    const inventory = await host.readInventory({
      allowlistedThreadIds: [threadId],
      allowlistedSnapshotIds: [binding.snapshotId],
    });
    expect(inventory.threads).toEqual([
      { threadId, kind: "test", snapshotIds: [binding.snapshotId], deleted: true },
    ]);
  });

  it("inventories only well-formed managed Claude projections and fails closed on unknown entries", async () => {
    const { stateDir, experts, binding } = await makeFixture();
    const projectionId = "snapshot-projection";
    const projectionDirectory = path.join(
      stateDir,
      "claude-expert",
      CLAUDE_EXPERT_PROJECTION_VERSION,
      projectionId,
    );
    await mkdir(projectionDirectory, { recursive: true });
    await writeFile(
      path.join(projectionDirectory, "projection.json"),
      JSON.stringify({
        projectionVersion: CLAUDE_EXPERT_PROJECTION_VERSION,
        snapshotId: binding.snapshotId,
        contentHash: "a".repeat(64),
      }),
    );
    const repo = {
      listAll: () => Effect.succeed([]),
      get: () => Effect.succeed(null),
    } as unknown as HubWorkRepositoryShape;
    const host = createSkillPackageSwitchHost({
      stateDir,
      experts,
      hubWorkRepository: repo,
      hubWorkService: {
        cancel: vi.fn(),
        setState: vi.fn(),
      } as unknown as Pick<HubWorkService, "cancel" | "setState">,
      readThreads: async () => [],
      readAppliedRuntimeRecords: async () => [],
      runEffect: Effect.runPromise,
      dispatch: async () => undefined,
    });

    const inventory = await host.readInventory({
      allowlistedThreadIds: [],
      allowlistedSnapshotIds: [binding.snapshotId],
    });
    expect(inventory.complete).toBe(true);
    expect(inventory.snapshots[0]?.projectionIds).toEqual([projectionId]);

    await writeFile(path.join(projectionDirectory, "projection.json"), "{broken");
    expect(
      (
        await host.readInventory({
          allowlistedThreadIds: [],
          allowlistedSnapshotIds: [binding.snapshotId],
        })
      ).complete,
    ).toBe(false);
  });

  it("removes the reviewed Claude projection under the verified snapshot cleanup callback", async () => {
    const { stateDir, experts, binding } = await makeFixture();
    const storedSnapshot = await experts.readSnapshot(binding.snapshotId);
    const legacySnapshot = {
      ...storedSnapshot,
      schemaVersion: 1,
      skills: [{ name: "legacy", path: "skills/legacy/SKILL.md" }],
    } as unknown as ExpertSnapshot;
    const projectionId = "legacy-projection";
    const projectionDirectory = path.join(
      stateDir,
      "claude-expert",
      CLAUDE_EXPERT_PROJECTION_VERSION,
      projectionId,
    );
    await mkdir(projectionDirectory, { recursive: true });
    await writeFile(
      path.join(projectionDirectory, "projection.json"),
      JSON.stringify({
        projectionVersion: CLAUDE_EXPERT_PROJECTION_VERSION,
        snapshotId: binding.snapshotId,
        contentHash: "b".repeat(64),
      }),
    );
    let snapshots = [legacySnapshot];
    const expertAdapter = {
      listStoredSnapshots: async () => snapshots,
      removeLegacySkillSnapshots: async (
        snapshotIds: ReadonlyArray<string>,
        verifyNoReferences?: () => Promise<void>,
      ) => {
        await verifyNoReferences?.();
        snapshots = snapshots.filter((snapshot) => !snapshotIds.includes(snapshot.snapshotId));
        return snapshotIds;
      },
    } as unknown as Pick<ExpertStore, "listStoredSnapshots" | "removeLegacySkillSnapshots">;
    const repo = {
      listAll: () => Effect.succeed([]),
      get: () => Effect.succeed(null),
    } as unknown as HubWorkRepositoryShape;
    const host = createSkillPackageSwitchHost({
      stateDir,
      experts: expertAdapter,
      hubWorkRepository: repo,
      hubWorkService: {
        cancel: vi.fn(),
        setState: vi.fn(),
      } as unknown as Pick<HubWorkService, "cancel" | "setState">,
      readThreads: async () => [],
      readAppliedRuntimeRecords: async () => [],
      runEffect: Effect.runPromise,
      dispatch: async () => undefined,
    });

    await host.cleanupLegacyArtifacts({
      threadIds: [],
      snapshotIds: [binding.snapshotId],
      projectionIds: [projectionId],
    });
    await expect(stat(projectionDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(snapshots).toEqual([]);
  });

  it("cancels queued Hub work through the existing service and preserves the row", async () => {
    const { stateDir, experts, binding } = await makeFixture();
    const threadId = ThreadId.makeUnsafe("queued-hub-thread");
    const history = {
      id: "hub-queued-history",
      sourceThreadId: threadId,
      sourceMessages: [],
      workerThreadId: null,
      state: "queued",
      creationSpec: { expertBinding: binding },
    } as unknown as HubWorkRecord;
    const repo = {
      listAll: () => Effect.succeed([history]),
      get: (id: string) => Effect.succeed(id === history.id ? history : null),
    } as unknown as HubWorkRepositoryShape;
    const cancel = vi.fn(() => Effect.succeed({ ...history, state: "cancelled" } as HubWorkRecord));
    const host = createSkillPackageSwitchHost({
      stateDir,
      experts,
      hubWorkRepository: repo,
      hubWorkService: {
        cancel,
        setState: vi.fn(),
      } as unknown as Pick<HubWorkService, "cancel" | "setState">,
      readThreads: async () => [],
      readAppliedRuntimeRecords: async () => [],
      runEffect: Effect.runPromise,
      dispatch: async () => undefined,
    });

    await host.cancelHubWork(history.id);
    expect(cancel).toHaveBeenCalledWith({ workItemId: history.id }, { kind: "user" });
    expect(
      await host.readInventory({ allowlistedThreadIds: [], allowlistedSnapshotIds: [] }),
    ).toMatchObject({
      hubWorks: [{ workId: history.id, state: "queued" }],
    });
  });
});
