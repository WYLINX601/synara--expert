import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

import {
  CommandId,
  ThreadId,
  type ExpertAppliedRuntimeRecord,
  type ExpertSnapshot,
  type HubWorkRecord,
  type OrchestrationCommand,
  type OrchestrationThread,
} from "@synara/contracts";
import { Effect } from "effect";

import type { ExpertStore } from "../../experts/ExpertStore.ts";
import { CLAUDE_EXPERT_PROJECTION_VERSION } from "../../provider/claudeExpertSession.ts";
import type {
  SkillPackageSwitchHost,
  SkillPackageSwitchInventoryRequest,
  SkillPackageSwitchReference,
} from "../../experts/SkillPackageSwitch.ts";
import type { HubWorkService } from "../../projectAgent/hubWorkService.ts";
import type { HubWorkRepositoryShape } from "../../persistence/Services/HubWorkRepository.ts";

const terminalHubStates = new Set(["completed", "failed", "cancelled"]);
const SETTLE_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 100;
const SNAPSHOT_ID_PATTERN = /^exp_[a-f0-9]{64}$/u;

interface ClaudeProjectionRecord {
  readonly id: string;
  readonly snapshotId: string;
  readonly absolutePath: string;
}

interface ClaudeProjectionInventory {
  readonly complete: boolean;
  readonly records: readonly ClaudeProjectionRecord[];
}

function isMissing(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

async function inspectClaudeProjectionTree(stateDir: string): Promise<ClaudeProjectionInventory> {
  const outputRoot = path.join(path.resolve(stateDir), "claude-expert");
  const managedRoot = path.join(outputRoot, CLAUDE_EXPERT_PROJECTION_VERSION);
  let outputRootStat;
  try {
    outputRootStat = await lstat(outputRoot);
  } catch (cause) {
    if (isMissing(cause)) return { complete: true, records: [] };
    throw cause;
  }
  if (!outputRootStat.isDirectory() || outputRootStat.isSymbolicLink()) {
    return { complete: false, records: [] };
  }
  let rootStat;
  try {
    rootStat = await lstat(managedRoot);
  } catch (cause) {
    if (isMissing(cause)) return { complete: true, records: [] };
    throw cause;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return { complete: false, records: [] };
  }

  const records: ClaudeProjectionRecord[] = [];
  try {
    const entries = await readdir(managedRoot, { withFileTypes: true });
    if (entries.length > 10_000) return { complete: false, records: [] };
    for (const entry of entries) {
      const projectionPath = path.join(managedRoot, entry.name);
      const projectionStat = await lstat(projectionPath);
      if (
        !entry.isDirectory() ||
        !projectionStat.isDirectory() ||
        projectionStat.isSymbolicLink()
      ) {
        return { complete: false, records: [] };
      }
      const metadataPath = path.join(projectionPath, "projection.json");
      const metadataStat = await lstat(metadataPath);
      if (!metadataStat.isFile() || metadataStat.isSymbolicLink()) {
        return { complete: false, records: [] };
      }
      const metadata: unknown = JSON.parse(await readFile(metadataPath, "utf8"));
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
        return { complete: false, records: [] };
      }
      const record = metadata as Record<string, unknown>;
      if (
        record.projectionVersion !== CLAUDE_EXPERT_PROJECTION_VERSION ||
        typeof record.snapshotId !== "string" ||
        !SNAPSHOT_ID_PATTERN.test(record.snapshotId) ||
        typeof record.contentHash !== "string" ||
        !/^[a-f0-9]{64}$/u.test(record.contentHash)
      ) {
        return { complete: false, records: [] };
      }
      records.push({ id: entry.name, snapshotId: record.snapshotId, absolutePath: projectionPath });
    }
  } catch (cause) {
    if (isMissing(cause) || cause instanceof SyntaxError) {
      return { complete: false, records: [] };
    }
    throw cause;
  }
  return { complete: true, records };
}

async function removeClaudeProjection(record: ClaudeProjectionRecord): Promise<void> {
  const projectionStat = await lstat(record.absolutePath);
  const metadataPath = path.join(record.absolutePath, "projection.json");
  const metadataStat = await lstat(metadataPath);
  if (
    !projectionStat.isDirectory() ||
    projectionStat.isSymbolicLink() ||
    !metadataStat.isFile() ||
    metadataStat.isSymbolicLink()
  ) {
    throw new Error(`Claude projection changed before cleanup: ${record.id}`);
  }
  const metadata: unknown = JSON.parse(await readFile(metadataPath, "utf8"));
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    (metadata as Record<string, unknown>).projectionVersion !== CLAUDE_EXPERT_PROJECTION_VERSION ||
    (metadata as Record<string, unknown>).snapshotId !== record.snapshotId
  ) {
    throw new Error(`Claude projection metadata changed before cleanup: ${record.id}`);
  }
  await rm(record.absolutePath, { recursive: true, force: false });
}

export interface SkillPackageSwitchHostInput {
  readonly stateDir: string;
  readonly experts: Pick<ExpertStore, "listStoredSnapshots" | "removeLegacySkillSnapshots">;
  readonly hubWorkRepository: Pick<HubWorkRepositoryShape, "listAll" | "get">;
  readonly hubWorkService: Pick<HubWorkService, "cancel" | "setState">;
  readonly readThreads: () => Promise<ReadonlyArray<OrchestrationThread>>;
  readonly readAppliedRuntimeRecords: () => Promise<ReadonlyArray<ExpertAppliedRuntimeRecord>>;
  readonly runEffect: <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>;
  readonly dispatch: (command: OrchestrationCommand) => Promise<unknown>;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

const referenceKey = (reference: SkillPackageSwitchReference) =>
  `${reference.kind}:${reference.id}`;

function hubWorkReferences(record: HubWorkRecord): SkillPackageSwitchReference[] {
  const references: SkillPackageSwitchReference[] = [
    { kind: "thread", id: record.sourceThreadId },
    ...record.sourceMessages.map((message) => ({ kind: "thread" as const, id: message.threadId })),
  ];
  if (record.workerThreadId) references.push({ kind: "thread", id: record.workerThreadId });
  const snapshotId = record.creationSpec.expertBinding?.snapshotId;
  if (snapshotId) references.push({ kind: "snapshot", id: snapshotId });
  for (const message of record.sourceMessages) {
    if ((message.attachments?.length ?? 0) > 0 || (message.references?.length ?? 0) > 0) {
      // The switch cannot interpret arbitrary attachment or mention targets as
      // Expert ownership, so a target Hub record with these stays in scope as
      // an ordinary reference and blocks destructive cleanup.
      references.push({ kind: "ordinary", id: `hub-source:${message.messageId}` });
    }
  }
  return [
    ...new Map(references.map((reference) => [referenceKey(reference), reference])).values(),
  ].sort((left, right) => referenceKey(left).localeCompare(referenceKey(right)));
}

export function createSkillPackageSwitchHost(
  input: SkillPackageSwitchHostInput,
): SkillPackageSwitchHost {
  const now = input.now ?? (() => new Date());
  const sleep =
    input.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

  const readInventory = async (request: SkillPackageSwitchInventoryRequest) => {
    const [snapshots, threads, hubWorks, appliedRuntimeRecords, projectionInventory] =
      await Promise.all([
        input.experts.listStoredSnapshots(),
        input.readThreads(),
        input.runEffect(input.hubWorkRepository.listAll()),
        input.readAppliedRuntimeRecords(),
        inspectClaudeProjectionTree(input.stateDir),
      ]);
    const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.snapshotId, snapshot]));
    const threadById = new Map(threads.map((thread) => [thread.id, thread]));
    const snapshotRefs = new Map<string, Map<string, SkillPackageSwitchReference>>(
      snapshots.map((snapshot) => [snapshot.snapshotId, new Map()]),
    );
    const threadSnapshotIds = new Map<string, Set<string>>();
    let complete =
      snapshotById.size === snapshots.length &&
      threadById.size === threads.length &&
      projectionInventory.complete;

    const addSnapshotReference = (snapshotId: string, reference: SkillPackageSwitchReference) => {
      const references = snapshotRefs.get(snapshotId);
      if (!references) {
        complete = false;
        return;
      }
      references.set(referenceKey(reference), reference);
    };

    for (const thread of threads) {
      const snapshotIds = new Set<string>();
      if (thread.expertBinding) snapshotIds.add(thread.expertBinding.snapshotId);
      threadSnapshotIds.set(thread.id, snapshotIds);
      for (const snapshotId of snapshotIds) {
        addSnapshotReference(snapshotId, { kind: "thread", id: thread.id });
      }
    }

    const threadIds = new Set(threads.map((thread) => thread.id));
    for (const runtime of appliedRuntimeRecords) {
      const snapshotIds = threadSnapshotIds.get(runtime.threadId) ?? new Set<string>();
      snapshotIds.add(runtime.snapshotId);
      threadSnapshotIds.set(runtime.threadId, snapshotIds);
      addSnapshotReference(runtime.snapshotId, { kind: "thread", id: runtime.threadId });
      if (!threadIds.has(runtime.threadId)) complete = false;
    }

    const projectionIdsBySnapshot = new Map<string, string[]>();
    for (const projection of projectionInventory.records) {
      if (!snapshotById.has(projection.snapshotId)) {
        complete = false;
        continue;
      }
      const ids = projectionIdsBySnapshot.get(projection.snapshotId) ?? [];
      ids.push(projection.id);
      projectionIdsBySnapshot.set(projection.snapshotId, ids);
    }

    const allowedThreads = new Set(request.allowlistedThreadIds);
    const allowedSnapshots = new Set(request.allowlistedSnapshotIds);
    const projectedHubWorks = hubWorks.map((record) => {
      const references = hubWorkReferences(record);
      const touchesTarget = references.some(
        (reference) =>
          (reference.kind === "thread" && allowedThreads.has(reference.id)) ||
          (reference.kind === "snapshot" && allowedSnapshots.has(reference.id)),
      );
      const allReferencesAreAllowlisted = references.every((reference) => {
        if (reference.kind === "thread") return allowedThreads.has(reference.id);
        if (reference.kind === "snapshot") return allowedSnapshots.has(reference.id);
        return false;
      });
      const snapshotId = record.creationSpec.expertBinding?.snapshotId;
      if (snapshotId) addSnapshotReference(snapshotId, { kind: "hub-work", id: record.id });
      return {
        workId: record.id,
        kind:
          touchesTarget && allReferencesAreAllowlisted ? ("test" as const) : ("ordinary" as const),
        state: record.state,
        references,
      };
    });

    const projectedThreads = threads.map((thread) => ({
      threadId: thread.id,
      kind: allowedThreads.has(thread.id) ? ("test" as const) : ("ordinary" as const),
      snapshotIds: [...(threadSnapshotIds.get(thread.id) ?? [])].sort(),
      deleted: thread.deletedAt != null,
    }));
    const projectedSnapshots = snapshots.map((snapshot: ExpertSnapshot) => ({
      snapshotId: snapshot.snapshotId,
      kind:
        snapshot.schemaVersion !== 2 && snapshot.skills.length > 0
          ? ("legacy-skill" as const)
          : ("other" as const),
      references: [...(snapshotRefs.get(snapshot.snapshotId)?.values() ?? [])].sort((left, right) =>
        referenceKey(left).localeCompare(referenceKey(right)),
      ),
      projectionIds: [...(projectionIdsBySnapshot.get(snapshot.snapshotId) ?? [])].sort(),
    }));

    return {
      complete,
      threads: projectedThreads,
      hubWorks: projectedHubWorks,
      snapshots: projectedSnapshots,
    };
  };

  const readThread = async (threadId: string) =>
    (await input.readThreads()).find((entry) => entry.id === threadId);

  const waitUntil = async (predicate: () => Promise<boolean>, label: string): Promise<void> => {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`Timed out waiting for native ${label} readback.`);
  };

  const stopThread = async (threadId: string): Promise<void> => {
    const thread = await readThread(threadId);
    if (!thread) return;
    const activeTurn =
      thread.latestTurn && ["running", "pending"].includes(thread.latestTurn.state)
        ? thread.latestTurn
        : null;
    if (activeTurn) {
      await input.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe(randomUUID()),
        threadId: ThreadId.makeUnsafe(threadId),
        turnId: activeTurn.turnId,
        requestedBy: "user",
        createdAt: now().toISOString(),
      });
    }
    if (thread.session && thread.session.status !== "stopped") {
      await input.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.makeUnsafe(randomUUID()),
        threadId: ThreadId.makeUnsafe(threadId),
        createdAt: now().toISOString(),
      });
    }
    await waitUntil(async () => {
      const current = await readThread(threadId);
      if (!current) return true;
      const turnSettled =
        !current.latestTurn || !["running", "pending"].includes(current.latestTurn.state);
      const sessionStopped = !current.session || current.session.status === "stopped";
      return turnSettled && sessionStopped;
    }, `thread stop (${threadId})`);
  };

  const cancelHubWork = async (workId: string): Promise<void> => {
    const record = await input.runEffect(input.hubWorkRepository.get(workId));
    if (!record) throw new Error(`Hub work disappeared during switch: ${workId}`);
    if (terminalHubStates.has(record.state)) return;
    if (record.state === "queued" || record.state === "idle") {
      await input.runEffect(input.hubWorkService.cancel({ workItemId: workId }, { kind: "user" }));
      return;
    }
    if (record.workerThreadId) await stopThread(record.workerThreadId);
    await input.runEffect(
      input.hubWorkService.setState({ workItemId: workId, state: "cancelled" }),
    );
  };

  const deleteThread = async (threadId: string): Promise<void> => {
    const existing = await readThread(threadId);
    if (!existing || existing.deletedAt != null) return;
    await stopThread(threadId);
    await input.dispatch({
      type: "thread.delete",
      commandId: CommandId.makeUnsafe(randomUUID()),
      threadId: ThreadId.makeUnsafe(threadId),
    });
    await waitUntil(async () => {
      const current = await readThread(threadId);
      return !current || current.deletedAt != null;
    }, `thread deletion (${threadId})`);
  };

  return {
    readInventory,
    stopThread,
    cancelHubWork,
    deleteThread,
    cleanupLegacyArtifacts: async ({ threadIds, snapshotIds, projectionIds }) => {
      await input.experts.removeLegacySkillSnapshots(snapshotIds, async () => {
        const inventory = await readInventory({
          allowlistedThreadIds: threadIds,
          allowlistedSnapshotIds: snapshotIds,
        });
        if (!inventory.complete) {
          throw new Error(
            "Host inventory became incomplete before cleanup; snapshots were retained.",
          );
        }
        const remainingThreads = inventory.threads.filter(
          (thread) => threadIds.includes(thread.threadId) && !thread.deleted,
        );
        const remainingSnapshotRefs = inventory.snapshots.filter(
          (snapshot) => snapshotIds.includes(snapshot.snapshotId) && snapshot.references.length > 0,
        );
        if (remainingThreads.length || remainingSnapshotRefs.length) {
          throw new Error(
            "A new task or Hub reference appeared before cleanup; snapshots were retained.",
          );
        }
        const snapshotIdSet = new Set(snapshotIds);
        const plannedProjectionIds = new Set(projectionIds);
        const currentProjectionInventory = await inspectClaudeProjectionTree(input.stateDir);
        if (!currentProjectionInventory.complete) {
          throw new Error(
            "Claude projection inventory became incomplete before cleanup; snapshots were retained.",
          );
        }
        const currentProjectionRecords = currentProjectionInventory.records;
        const currentTargetProjections = currentProjectionRecords.filter((projection) =>
          snapshotIdSet.has(projection.snapshotId),
        );
        if (
          currentTargetProjections.some((projection) => !plannedProjectionIds.has(projection.id))
        ) {
          throw new Error(
            "A new Claude projection appeared before cleanup; snapshots were retained.",
          );
        }
        for (const projection of currentTargetProjections) {
          await removeClaudeProjection(projection);
        }
      });
    },
  } satisfies SkillPackageSwitchHost;
}
