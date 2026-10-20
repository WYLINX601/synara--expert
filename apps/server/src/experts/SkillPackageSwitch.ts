import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  ExpertSkillSelection,
  SkillPackageSwitchInput as SkillPackageSwitchInputSchema,
  SkillPackageSwitchPlan as SkillPackageSwitchPlanSchema,
  SkillPackageSwitchProgress as SkillPackageSwitchProgressSchema,
  type ExpertDefinition,
  type ExpertSaveInput,
  type ExpertSkillSelection as ExpertSkillSelectionType,
  type HubWorkState,
} from "@synara/contracts";
import { Schema } from "effect";

import { ensurePrivateDirectorySync, syncDirectoryEntry } from "../privatePathPermissions";
import { withSkillPackageLifecycle } from "./skillPackageLifecycle.ts";

const SWITCH_SCHEMA_VERSION = 1;
const EXPERT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const SNAPSHOT_ID_PATTERN = /^exp_[a-f0-9]{64}$/u;

export type SkillPackageSwitchReference =
  | { readonly kind: "thread"; readonly id: string }
  | { readonly kind: "snapshot"; readonly id: string }
  | { readonly kind: "hub-work"; readonly id: string }
  | { readonly kind: "ordinary"; readonly id: string };

export interface SkillPackageSwitchInventoryRequest {
  readonly allowlistedThreadIds: readonly string[];
  readonly allowlistedSnapshotIds: readonly string[];
}

export interface SkillPackageSwitchThread {
  readonly threadId: string;
  readonly kind: "test" | "ordinary";
  readonly snapshotIds: readonly string[];
  readonly deleted?: boolean;
}

export interface SkillPackageSwitchHubWork {
  readonly workId: string;
  readonly kind: "test" | "ordinary";
  readonly state: HubWorkState;
  readonly references: readonly SkillPackageSwitchReference[];
}

export interface SkillPackageSwitchSnapshot {
  readonly snapshotId: string;
  readonly kind: "legacy-skill" | "other";
  readonly references: readonly SkillPackageSwitchReference[];
  readonly projectionIds: readonly string[];
}

export interface SkillPackageSwitchInventory {
  readonly complete: boolean;
  readonly threads: readonly SkillPackageSwitchThread[];
  readonly hubWorks: readonly SkillPackageSwitchHubWork[];
  readonly snapshots: readonly SkillPackageSwitchSnapshot[];
}

export interface SkillPackageSwitchHost {
  /** Must return a complete inventory, including ordinary tasks and Hub references. */
  readInventory(request: SkillPackageSwitchInventoryRequest): Promise<SkillPackageSwitchInventory>;
  /** Host actions must be safe to retry after an interruption. */
  stopThread(threadId: string): Promise<void>;
  /** Host actions must be safe to retry after an interruption. */
  cancelHubWork(workId: string): Promise<void>;
  /** Host-owned, retry-safe task deletion; preserve event/reference consistency. */
  deleteThread(threadId: string): Promise<void>;
  /** Retry-safe cleanup, called only after readInventory proves no references remain. */
  cleanupLegacyArtifacts(input: {
    readonly threadIds: readonly string[];
    readonly snapshotIds: readonly string[];
    readonly projectionIds: readonly string[];
  }): Promise<void>;
}

export interface SkillPackageSwitchExpertStore {
  read(id: string): Promise<ExpertDefinition | null>;
  save(input: ExpertSaveInput): Promise<ExpertDefinition>;
}

export interface SkillPackageSwitchPackageStore {
  resolveSelections(
    selections: ReadonlyArray<ExpertSkillSelectionType>,
  ): Promise<ReadonlyArray<unknown>>;
}

export interface SkillPackageSwitchPersonaPatch {
  readonly reviewed: true;
  readonly before: string;
  readonly after: string;
}

export interface SkillPackageSwitchExpertInput {
  readonly expertId: string;
  readonly skillSelections: readonly ExpertSkillSelectionType[];
  readonly personaPatch?: SkillPackageSwitchPersonaPatch | undefined;
}

export interface SkillPackageSwitchInput {
  readonly experts: readonly SkillPackageSwitchExpertInput[];
  readonly allowlistedThreadIds: readonly string[];
  readonly allowlistedSnapshotIds: readonly string[];
}

interface ExpertTarget {
  readonly expertId: string;
  readonly expectedRevision: number;
  readonly originalDefinitionHash: string;
  readonly originalNonSkillHash: string;
  readonly targetNonSkillHash: string;
  readonly targetSkillSelections: readonly ExpertSkillSelectionType[];
  readonly personaBefore: string;
  readonly targetPersona: string;
}

export interface SkillPackageSwitchPlan {
  readonly schemaVersion: typeof SWITCH_SCHEMA_VERSION;
  readonly switchId: string;
  readonly createdAt: string;
  readonly experts: readonly ExpertTarget[];
  readonly threadIds: readonly string[];
  readonly threadTargets: readonly {
    readonly threadId: string;
    readonly snapshotIds: readonly string[];
  }[];
  readonly snapshotIds: readonly string[];
  readonly snapshotTargets: readonly SkillPackageSwitchSnapshot[];
  /** Hub work rows are durable history; snapshots they reference are retained. */
  readonly retainedSnapshotIds: readonly string[];
  readonly hubWorkIds: readonly string[];
  readonly hubWorkTargets: readonly SkillPackageSwitchHubWork[];
  readonly projectionIds: readonly string[];
  readonly inventoryHash: string;
}

export interface SkillPackageSwitchPreview {
  readonly switchId: string;
  readonly digest: string;
  readonly plan: SkillPackageSwitchPlan;
}

export type SkillPackageSwitchErrorCode =
  | "invalid_input"
  | "not_found"
  | "unsafe_inventory"
  | "stale_preview"
  | "switch_conflict"
  | "switch_incomplete";

export class SkillPackageSwitchError extends Error {
  constructor(
    message: string,
    readonly code: SkillPackageSwitchErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SkillPackageSwitchError";
  }
}

export interface SkillPackageSwitchProgress {
  readonly schemaVersion: typeof SWITCH_SCHEMA_VERSION;
  readonly switchId: string;
  readonly digest: string;
  readonly backupPath: string;
  status:
    | "prepared"
    | "stopping"
    | "publishing"
    | "deleting"
    | "verifying"
    | "cleaning"
    | "complete"
    | "complete_with_retained_artifacts"
    | "failed";
  stoppedThreadIds: string[];
  cancelledHubWorkIds: string[];
  publishedExperts: Record<string, number>;
  deletedThreadIds: string[];
  cleaned: boolean;
  retainedSnapshotIds: string[];
  error?: string;
  updatedAt: string;
}

function stableJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, sort(child)]),
      );
    }
    return item;
  };
  return JSON.stringify(sort(value));
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function definitionNonSkillFields(
  definition: ExpertDefinition,
  persona = definition.persona,
): unknown {
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    useCases: definition.useCases,
    persona,
    outputRequirements: definition.outputRequirements,
    references: definition.references,
    connections: definition.connections,
    preferredProvider: definition.preferredProvider ?? null,
    archived: definition.archived,
  };
}

function ensureUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new SkillPackageSwitchError(
      "Duplicate " + label + " in switch request.",
      "invalid_input",
    );
  }
}

function validateInput(input: SkillPackageSwitchInput): void {
  if (!input.experts.length) {
    throw new SkillPackageSwitchError("At least one Expert must be selected.", "invalid_input");
  }
  ensureUnique(
    input.experts.map((expert) => expert.expertId),
    "Expert IDs",
  );
  ensureUnique(input.allowlistedThreadIds, "thread IDs");
  ensureUnique(input.allowlistedSnapshotIds, "snapshot IDs");
  for (const expert of input.experts) {
    if (!EXPERT_ID_PATTERN.test(expert.expertId)) {
      throw new SkillPackageSwitchError("Invalid Expert ID: " + expert.expertId, "invalid_input");
    }
    if (expert.personaPatch && expert.personaPatch.reviewed !== true) {
      throw new SkillPackageSwitchError(
        "Persona changes require an explicitly reviewed patch.",
        "invalid_input",
      );
    }
    for (const selection of expert.skillSelections) {
      try {
        Schema.decodeUnknownSync(ExpertSkillSelection)(selection);
      } catch (cause) {
        throw new SkillPackageSwitchError("Expert skill selection is invalid.", "invalid_input", {
          cause,
        });
      }
    }
  }
  for (const threadId of input.allowlistedThreadIds) {
    if (!threadId || threadId.length > 256 || threadId.includes("\0")) {
      throw new SkillPackageSwitchError("Invalid test thread ID.", "invalid_input");
    }
  }
  for (const snapshotId of input.allowlistedSnapshotIds) {
    if (!SNAPSHOT_ID_PATTERN.test(snapshotId)) {
      throw new SkillPackageSwitchError("Invalid snapshot ID.", "invalid_input");
    }
  }
}

function referenceKey(reference: SkillPackageSwitchReference): string {
  return reference.kind + ":" + reference.id;
}

function intersects(
  references: readonly SkillPackageSwitchReference[],
  threadIds: ReadonlySet<string>,
  snapshotIds: ReadonlySet<string>,
): boolean {
  return references.some(
    (reference) =>
      (reference.kind === "thread" && threadIds.has(reference.id)) ||
      (reference.kind === "snapshot" && snapshotIds.has(reference.id)),
  );
}

function scopeInventory(
  inventory: SkillPackageSwitchInventory,
  allowlistedThreadIds: readonly string[],
  allowlistedSnapshotIds: readonly string[],
  allowPartial = false,
): {
  readonly threadIds: string[];
  readonly threadTargets: readonly { threadId: string; snapshotIds: readonly string[] }[];
  readonly snapshotIds: string[];
  readonly snapshotTargets: readonly SkillPackageSwitchSnapshot[];
  readonly retainedSnapshotIds: readonly string[];
  readonly hubWorkIds: string[];
  readonly hubWorkTargets: readonly SkillPackageSwitchHubWork[];
  readonly projectionIds: string[];
} {
  if (!inventory.complete) {
    throw new SkillPackageSwitchError(
      "The host inventory is incomplete; legacy data cannot be cleaned safely.",
      "unsafe_inventory",
    );
  }
  const allowedThreads = new Set(allowlistedThreadIds);
  const allowedSnapshots = new Set(allowlistedSnapshotIds);
  const snapshots = new Map(inventory.snapshots.map((snapshot) => [snapshot.snapshotId, snapshot]));
  const threads = new Map(inventory.threads.map((thread) => [thread.threadId, thread]));

  const plannedHubWorkIds: string[] = [];
  for (const work of inventory.hubWorks) {
    if (!intersects(work.references, allowedThreads, allowedSnapshots)) continue;
    if (work.kind !== "test") {
      throw new SkillPackageSwitchError(
        "A selected legacy resource is referenced by ordinary Hub work: " + work.workId,
        "unsafe_inventory",
      );
    }
    const hasUnlistedReference = work.references.some((reference) => {
      if (reference.kind === "ordinary" || reference.kind === "hub-work") return true;
      if (reference.kind === "thread") return !allowedThreads.has(reference.id);
      return !allowedSnapshots.has(reference.id);
    });
    if (hasUnlistedReference) {
      throw new SkillPackageSwitchError(
        "A Hub work item has an ordinary or unlisted reference: " + work.workId,
        "unsafe_inventory",
      );
    }
    plannedHubWorkIds.push(work.workId);
  }
  const plannedHubWorks = new Set(plannedHubWorkIds);

  for (const snapshotId of allowlistedSnapshotIds) {
    const snapshot = snapshots.get(snapshotId);
    if (!snapshot && !allowPartial) {
      throw new SkillPackageSwitchError(
        "Allowlisted legacy snapshot is absent from host inventory: " + snapshotId,
        "unsafe_inventory",
      );
    }
    if (snapshot && snapshot.kind !== "legacy-skill") {
      throw new SkillPackageSwitchError(
        "Only legacy skill snapshots may be cleaned: " + snapshotId,
        "unsafe_inventory",
      );
    }
  }
  for (const threadId of allowlistedThreadIds) {
    const thread = threads.get(threadId);
    if (!thread && !allowPartial) {
      throw new SkillPackageSwitchError(
        "Allowlisted test thread is absent from host inventory: " + threadId,
        "unsafe_inventory",
      );
    }
    if (thread && thread.kind !== "test") {
      throw new SkillPackageSwitchError(
        "An ordinary thread cannot be included in the switch: " + threadId,
        "unsafe_inventory",
      );
    }
  }

  for (const thread of inventory.threads) {
    const hasTargetSnapshot = thread.snapshotIds.some((snapshotId) =>
      allowedSnapshots.has(snapshotId),
    );
    const explicitlyTargeted = allowedThreads.has(thread.threadId);
    if (hasTargetSnapshot && !explicitlyTargeted) {
      throw new SkillPackageSwitchError(
        "A selected legacy snapshot is referenced by an unlisted thread: " + thread.threadId,
        "unsafe_inventory",
      );
    }
    if (explicitlyTargeted) {
      if (thread.kind !== "test") {
        throw new SkillPackageSwitchError(
          "An ordinary thread cannot be included in the switch: " + thread.threadId,
          "unsafe_inventory",
        );
      }
      for (const snapshotId of thread.snapshotIds) {
        if (!allowedSnapshots.has(snapshotId)) {
          throw new SkillPackageSwitchError(
            "A selected test thread has an unlisted snapshot reference: " + snapshotId,
            "unsafe_inventory",
          );
        }
      }
    }
  }

  for (const snapshotId of allowlistedSnapshotIds) {
    const snapshot = snapshots.get(snapshotId);
    for (const reference of snapshot?.references ?? []) {
      const allowed =
        (reference.kind === "thread" && allowedThreads.has(reference.id)) ||
        (reference.kind === "snapshot" && allowedSnapshots.has(reference.id)) ||
        (reference.kind === "hub-work" && plannedHubWorks.has(reference.id));
      if (!allowed) {
        throw new SkillPackageSwitchError(
          "A selected legacy snapshot has an ordinary or unlisted reference: " +
            referenceKey(reference),
          "unsafe_inventory",
        );
      }
    }
  }

  const selectedSnapshots = allowlistedSnapshotIds
    .filter((snapshotId) => snapshots.has(snapshotId))
    .map((snapshotId) => snapshots.get(snapshotId)!);
  const selectedThreads = allowlistedThreadIds
    .filter((threadId) => threads.has(threadId))
    .map((threadId) => threads.get(threadId)!)
    .sort((left, right) => left.threadId.localeCompare(right.threadId));
  const selectedHubWorks = inventory.hubWorks
    .filter((work) => plannedHubWorkIds.includes(work.workId))
    .map((work) => ({
      ...work,
      references: [...work.references].sort((left, right) =>
        referenceKey(left).localeCompare(referenceKey(right)),
      ),
    }))
    .sort((left, right) => left.workId.localeCompare(right.workId));
  return {
    threadIds: allowlistedThreadIds.filter((threadId) => threads.has(threadId)).sort(),
    threadTargets: selectedThreads.map((thread) => ({
      threadId: thread.threadId,
      snapshotIds: [...thread.snapshotIds].sort(),
    })),
    snapshotIds: allowlistedSnapshotIds.filter((snapshotId) => snapshots.has(snapshotId)).sort(),
    snapshotTargets: selectedSnapshots
      .map((snapshot) => ({
        ...snapshot,
        references: [...snapshot.references].sort((left, right) =>
          referenceKey(left).localeCompare(referenceKey(right)),
        ),
        projectionIds: [...snapshot.projectionIds].sort(),
      }))
      .sort((left, right) => left.snapshotId.localeCompare(right.snapshotId)),
    retainedSnapshotIds: selectedSnapshots
      .filter((snapshot) =>
        snapshot.references.some(
          (reference) =>
            reference.kind === "hub-work" ||
            (reference.kind === "thread" && allowedThreads.has(reference.id)),
        ),
      )
      .map((snapshot) => snapshot.snapshotId)
      .sort(),
    hubWorkIds: [...new Set(plannedHubWorkIds)].sort(),
    hubWorkTargets: selectedHubWorks,
    projectionIds: [
      ...new Set(selectedSnapshots.flatMap((snapshot) => snapshot.projectionIds)),
    ].sort(),
  };
}

async function copyTree(source: string, destination: string): Promise<void> {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) {
    throw new SkillPackageSwitchError(
      "Managed Expert backup cannot contain symbolic links: " + source,
      "switch_incomplete",
    );
  }
  if (stat.isDirectory()) {
    await fs.mkdir(destination, { recursive: true, mode: 0o700 });
    const entries = (await fs.readdir(source)).sort();
    for (const entry of entries) {
      await copyTree(path.join(source, entry), path.join(destination, entry));
    }
    await fs.chmod(destination, stat.mode & 0o777);
    await syncDirectoryEntry(destination);
    return;
  }
  if (!stat.isFile()) {
    throw new SkillPackageSwitchError(
      "Managed Expert backup contains a non-file resource: " + source,
      "switch_incomplete",
    );
  }
  await fs.copyFile(source, destination);
  await fs.chmod(destination, stat.mode & 0o777);
  const handle = await fs.open(destination, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const parent = path.dirname(filePath);
  ensurePrivateDirectorySync(parent);
  const temporary = path.join(parent, "." + path.basename(filePath) + "." + randomUUID() + ".tmp");
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(stableJson(value) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, filePath);
  await syncDirectoryEntry(parent);
}

async function readJson<T>(filePath: string): Promise<T> {
  const stat = await fs.lstat(filePath).catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SkillPackageSwitchError("Switch record not found.", "not_found", { cause });
    }
    throw cause;
  });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new SkillPackageSwitchError("Switch record is invalid.", "switch_incomplete");
  }
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (cause) {
    throw new SkillPackageSwitchError("Switch record is corrupt.", "switch_incomplete", {
      cause,
    });
  }
}

function targetSaveInput(definition: ExpertDefinition, target: ExpertTarget): ExpertSaveInput {
  return {
    id: definition.id,
    expectedRevision: target.expectedRevision,
    name: definition.name,
    description: definition.description,
    useCases: definition.useCases,
    persona: target.targetPersona,
    outputRequirements: definition.outputRequirements,
    skills: [],
    skillSelections: [...target.targetSkillSelections],
    references: [...definition.references],
    connections: [...definition.connections],
    ...(definition.preferredProvider ? { preferredProvider: definition.preferredProvider } : {}),
  };
}

function isTargetDefinition(definition: ExpertDefinition, target: ExpertTarget): boolean {
  return (
    definition.id === target.expertId &&
    definition.revision === target.expectedRevision + 1 &&
    definition.skills.length === 0 &&
    stableJson(definition.skillSelections ?? []) === stableJson(target.targetSkillSelections) &&
    digest(definitionNonSkillFields(definition)) === target.targetNonSkillHash
  );
}

export interface SkillPackageSwitchService {
  preview(input: SkillPackageSwitchInput): Promise<SkillPackageSwitchPreview>;
  apply(input: { readonly switchId: string; readonly digest: string }): Promise<void>;
  readProgress(switchId: string): Promise<Readonly<SkillPackageSwitchProgress>>;
}

const switchQueues = new Map<string, Promise<void>>();

function withSwitchQueue<T>(stateDir: string, action: () => Promise<T>): Promise<T> {
  const key = path.resolve(stateDir);
  const result = (switchQueues.get(key) ?? Promise.resolve()).then(action);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  switchQueues.set(key, settled);
  void settled.then(() => {
    if (switchQueues.get(key) === settled) switchQueues.delete(key);
  });
  return result;
}

export function createSkillPackageSwitchService(input: {
  readonly stateDir: string;
  readonly experts: SkillPackageSwitchExpertStore;
  readonly packages: SkillPackageSwitchPackageStore;
  readonly host: SkillPackageSwitchHost;
  readonly now?: () => Date;
}): SkillPackageSwitchService {
  if (!path.isAbsolute(input.stateDir) || input.stateDir.includes("\0")) {
    throw new SkillPackageSwitchError("State directory must be absolute.", "invalid_input");
  }
  const root = path.join(path.resolve(input.stateDir), "expert-skill-package-switches");
  ensurePrivateDirectorySync(root);
  const now = input.now ?? (() => new Date());
  const switchDirectory = (switchId: string) => {
    if (!/^[a-f0-9-]{36}$/u.test(switchId)) {
      throw new SkillPackageSwitchError("Invalid switch ID.", "invalid_input");
    }
    return path.join(root, switchId);
  };
  const planPath = (switchId: string) => path.join(switchDirectory(switchId), "plan.json");
  const progressPath = (switchId: string) => path.join(switchDirectory(switchId), "progress.json");

  const resolveAllSelections = async (
    experts: readonly SkillPackageSwitchExpertInput[],
  ): Promise<void> => {
    for (const expert of experts) {
      try {
        await input.packages.resolveSelections(expert.skillSelections);
      } catch (cause) {
        throw new SkillPackageSwitchError(
          "Skill packages failed integrity validation for Expert " + expert.expertId + ".",
          "invalid_input",
          { cause },
        );
      }
    }
  };

  const previewUnlocked = async (
    request: SkillPackageSwitchInput,
  ): Promise<SkillPackageSwitchPreview> => {
    try {
      Schema.decodeUnknownSync(SkillPackageSwitchInputSchema)(request);
    } catch (cause) {
      throw new SkillPackageSwitchError("Switch request is invalid.", "invalid_input", { cause });
    }
    validateInput(request);
    await resolveAllSelections(request.experts);
    const expertTargets: ExpertTarget[] = [];
    for (const expertInput of [...request.experts].sort((left, right) =>
      left.expertId.localeCompare(right.expertId),
    )) {
      const definition = await input.experts.read(expertInput.expertId);
      if (!definition) {
        throw new SkillPackageSwitchError("Expert not found: " + expertInput.expertId, "not_found");
      }
      if (expertInput.personaPatch && definition.persona !== expertInput.personaPatch.before) {
        throw new SkillPackageSwitchError(
          "Reviewed persona patch no longer matches Expert " + expertInput.expertId + ".",
          "stale_preview",
        );
      }
      const targetPersona = expertInput.personaPatch?.after ?? definition.persona;
      expertTargets.push({
        expertId: definition.id,
        expectedRevision: definition.revision,
        originalDefinitionHash: digest(definition),
        originalNonSkillHash: digest(definitionNonSkillFields(definition)),
        targetNonSkillHash: digest(definitionNonSkillFields(definition, targetPersona)),
        targetSkillSelections: [...expertInput.skillSelections],
        personaBefore: definition.persona,
        targetPersona,
      });
    }

    const inventory = await input.host.readInventory({
      allowlistedThreadIds: request.allowlistedThreadIds,
      allowlistedSnapshotIds: request.allowlistedSnapshotIds,
    });
    const scope = scopeInventory(
      inventory,
      request.allowlistedThreadIds,
      request.allowlistedSnapshotIds,
    );
    const switchId = randomUUID();
    const plan: SkillPackageSwitchPlan = {
      schemaVersion: SWITCH_SCHEMA_VERSION,
      switchId,
      createdAt: now().toISOString(),
      experts: expertTargets,
      threadIds: scope.threadIds,
      threadTargets: scope.threadTargets,
      snapshotIds: scope.snapshotIds,
      snapshotTargets: scope.snapshotTargets,
      retainedSnapshotIds: scope.retainedSnapshotIds,
      hubWorkIds: scope.hubWorkIds,
      hubWorkTargets: scope.hubWorkTargets,
      projectionIds: scope.projectionIds,
      inventoryHash: digest(inventory),
    };
    const planDigest = digest(plan);
    ensurePrivateDirectorySync(switchDirectory(switchId));
    await writeJsonAtomically(planPath(switchId), { plan, digest: planDigest });
    return { switchId, digest: planDigest, plan };
  };

  const preview = (request: SkillPackageSwitchInput) =>
    withSwitchQueue(input.stateDir, () => previewUnlocked(request));

  const readStoredPlan = async (
    switchId: string,
    expectedDigest: string,
  ): Promise<SkillPackageSwitchPlan> => {
    const stored = await readJson<{ plan: unknown; digest: string }>(planPath(switchId));
    let plan: SkillPackageSwitchPlan;
    try {
      plan = Schema.decodeUnknownSync(SkillPackageSwitchPlanSchema)(stored.plan);
    } catch (cause) {
      throw new SkillPackageSwitchError("Switch plan is invalid.", "switch_incomplete", { cause });
    }
    if (
      plan.switchId !== switchId ||
      stored.digest !== expectedDigest ||
      digest(plan) !== expectedDigest
    ) {
      throw new SkillPackageSwitchError(
        "The switch preview changed or is stale; create a new preview.",
        "stale_preview",
      );
    }
    return plan;
  };

  const validateCurrentExperts = async (
    plan: SkillPackageSwitchPlan,
    progress: SkillPackageSwitchProgress | null,
  ): Promise<void> => {
    for (const target of plan.experts) {
      const current = await input.experts.read(target.expertId);
      if (!current) {
        throw new SkillPackageSwitchError(
          "Expert disappeared during switch: " + target.expertId,
          "switch_conflict",
        );
      }
      if (progress && isTargetDefinition(current, target)) continue;
      if (
        current.revision !== target.expectedRevision ||
        digest(current) !== target.originalDefinitionHash ||
        digest(definitionNonSkillFields(current)) !== target.originalNonSkillHash
      ) {
        throw new SkillPackageSwitchError(
          "Expert changed outside this switch: " + target.expertId,
          "switch_conflict",
        );
      }
    }
  };

  const ensureBackup = async (switchId: string): Promise<string> => {
    const source = path.join(path.resolve(input.stateDir), "experts");
    const switchRoot = switchDirectory(switchId);
    const final = path.join(switchRoot, "backup", "experts");
    const staging = path.join(switchRoot, "backup", ".experts-" + randomUUID());
    await fs.rm(path.dirname(final), { recursive: true, force: true });
    ensurePrivateDirectorySync(path.dirname(staging));
    try {
      await copyTree(source, staging);
      await fs.rename(staging, final);
      await syncDirectoryEntry(path.dirname(final));
      return final;
    } catch (cause) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw cause;
    }
  };

  const updateProgress = async (progress: SkillPackageSwitchProgress): Promise<void> => {
    progress.updatedAt = now().toISOString();
    await writeJsonAtomically(progressPath(progress.switchId), progress);
  };

  const assertResumeInventory = async (plan: SkillPackageSwitchPlan): Promise<void> => {
    const inventory = await input.host.readInventory({
      allowlistedThreadIds: plan.threadIds,
      allowlistedSnapshotIds: plan.snapshotIds,
    });
    const scope = scopeInventory(inventory, plan.threadIds, plan.snapshotIds, true);
    const plannedHubWork = new Set(plan.hubWorkIds);
    const unexpectedWork = scope.hubWorkIds.filter((workId) => !plannedHubWork.has(workId));
    if (unexpectedWork.length) {
      throw new SkillPackageSwitchError(
        "New Hub references appeared after preview: " + unexpectedWork.join(", "),
        "unsafe_inventory",
      );
    }
    const missingWork = plan.hubWorkIds.filter((workId) => !scope.hubWorkIds.includes(workId));
    if (missingWork.length) {
      throw new SkillPackageSwitchError(
        "Historical Hub work disappeared after preview; refusing to hide the changed inventory: " +
          missingWork.join(", "),
        "unsafe_inventory",
      );
    }
    const unplannedThreads = scope.threadIds.filter(
      (threadId) => !plan.threadIds.includes(threadId),
    );
    if (unplannedThreads.length) {
      throw new SkillPackageSwitchError(
        "New task references appeared after preview: " + unplannedThreads.join(", "),
        "unsafe_inventory",
      );
    }
  };

  const readProgressUnlocked = async (switchId: string): Promise<SkillPackageSwitchProgress> => {
    const raw = await readJson<unknown>(progressPath(switchId));
    try {
      const progress = Schema.decodeUnknownSync(SkillPackageSwitchProgressSchema)(raw);
      const { error, ...progressFields } = progress;
      return {
        ...progressFields,
        ...(error === undefined ? {} : { error }),
        stoppedThreadIds: [...progress.stoppedThreadIds],
        cancelledHubWorkIds: [...progress.cancelledHubWorkIds],
        publishedExperts: { ...progress.publishedExperts },
        deletedThreadIds: [...progress.deletedThreadIds],
        retainedSnapshotIds: [...progress.retainedSnapshotIds],
      };
    } catch (cause) {
      throw new SkillPackageSwitchError("Switch progress is invalid.", "switch_incomplete", {
        cause,
      });
    }
  };

  const readProgress = (switchId: string) =>
    withSwitchQueue(input.stateDir, () => readProgressUnlocked(switchId));

  const applyUnlocked = async (command: {
    readonly switchId: string;
    readonly digest: string;
  }): Promise<void> => {
    const plan = await readStoredPlan(command.switchId, command.digest);
    const existingProgress = await readProgressUnlocked(command.switchId).catch(
      (cause: unknown) => {
        if (cause instanceof SkillPackageSwitchError && cause.code === "not_found") {
          return null;
        }
        throw cause;
      },
    );
    if (existingProgress && existingProgress.digest !== command.digest) {
      throw new SkillPackageSwitchError(
        "Switch progress belongs to a different preview.",
        "stale_preview",
      );
    }

    try {
      await assertResumeInventory(plan);
      await resolveAllSelections(
        plan.experts.map((expert) => ({
          expertId: expert.expertId,
          skillSelections: expert.targetSkillSelections,
        })),
      );
      await validateCurrentExperts(plan, existingProgress);

      let progress = existingProgress;
      if (!progress) {
        const backupPath = await withSkillPackageLifecycle(input.stateDir, async () => {
          await validateCurrentExperts(plan, null);
          return ensureBackup(command.switchId);
        });
        progress = {
          schemaVersion: SWITCH_SCHEMA_VERSION,
          switchId: command.switchId,
          digest: command.digest,
          backupPath,
          status: "prepared",
          stoppedThreadIds: [],
          cancelledHubWorkIds: [],
          publishedExperts: {},
          deletedThreadIds: [],
          cleaned: false,
          retainedSnapshotIds: [...plan.retainedSnapshotIds],
          updatedAt: now().toISOString(),
        };
        await updateProgress(progress);
      } else {
        const previousRetainedSnapshotIds = [...progress.retainedSnapshotIds];
        const retainedSnapshotIds = [
          ...new Set([...previousRetainedSnapshotIds, ...plan.retainedSnapshotIds]),
        ].sort();
        if (
          retainedSnapshotIds.length !== previousRetainedSnapshotIds.length ||
          retainedSnapshotIds.some(
            (snapshotId, index) => snapshotId !== previousRetainedSnapshotIds[index],
          )
        ) {
          progress.retainedSnapshotIds = retainedSnapshotIds;
          await updateProgress(progress);
        }
      }
      if (progress.status === "complete" || progress.status === "complete_with_retained_artifacts")
        return;

      progress.status = "stopping";
      await updateProgress(progress);
      for (const threadId of plan.threadIds) {
        if (progress.stoppedThreadIds.includes(threadId)) continue;
        await input.host.stopThread(threadId);
        progress.stoppedThreadIds.push(threadId);
        await updateProgress(progress);
      }
      for (const workId of plan.hubWorkIds) {
        if (progress.cancelledHubWorkIds.includes(workId)) continue;
        await input.host.cancelHubWork(workId);
        progress.cancelledHubWorkIds.push(workId);
        await updateProgress(progress);
      }

      progress.status = "publishing";
      await updateProgress(progress);
      for (const target of plan.experts) {
        const current = await input.experts.read(target.expertId);
        if (!current) {
          throw new SkillPackageSwitchError(
            "Expert disappeared during switch: " + target.expertId,
            "switch_conflict",
          );
        }
        if (isTargetDefinition(current, target)) {
          progress.publishedExperts[target.expertId] = current.revision;
          await updateProgress(progress);
          continue;
        }
        if (
          current.revision !== target.expectedRevision ||
          digest(current) !== target.originalDefinitionHash
        ) {
          throw new SkillPackageSwitchError(
            "Expert changed outside this switch: " + target.expertId,
            "switch_conflict",
          );
        }
        const saved = await input.experts.save(targetSaveInput(current, target));
        if (!isTargetDefinition(saved, target)) {
          throw new SkillPackageSwitchError(
            "Saved Expert did not match the reviewed switch target: " + target.expertId,
            "switch_incomplete",
          );
        }
        progress.publishedExperts[target.expertId] = saved.revision;
        await updateProgress(progress);
      }

      progress.status = "deleting";
      await updateProgress(progress);
      for (const threadId of plan.threadIds) {
        if (progress.deletedThreadIds.includes(threadId)) continue;
        await input.host.deleteThread(threadId);
        progress.deletedThreadIds.push(threadId);
        await updateProgress(progress);
      }

      progress.status = "verifying";
      await updateProgress(progress);
      const readback = await input.host.readInventory({
        allowlistedThreadIds: plan.threadIds,
        allowlistedSnapshotIds: plan.snapshotIds,
      });
      if (!readback.complete) {
        throw new SkillPackageSwitchError(
          "Host readback is incomplete; legacy artifacts were retained.",
          "unsafe_inventory",
        );
      }
      const remainingThreadRefs = readback.threads.filter(
        (thread) =>
          (!thread.deleted && plan.threadIds.includes(thread.threadId)) ||
          (!thread.deleted &&
            thread.snapshotIds.some((snapshotId) => plan.snapshotIds.includes(snapshotId))) ||
          (thread.deleted &&
            thread.snapshotIds.some((snapshotId) => plan.snapshotIds.includes(snapshotId)) &&
            !plan.threadIds.includes(thread.threadId)),
      );
      const remainingHubRefs = readback.hubWorks.filter((work) =>
        intersects(work.references, new Set(plan.threadIds), new Set(plan.snapshotIds)),
      );
      const retainedHubWorkIds = new Set(plan.hubWorkTargets.map((work) => work.workId));
      const unresolvedHubRefs = remainingHubRefs.filter(
        (work) =>
          !retainedHubWorkIds.has(work.workId) ||
          !["completed", "failed", "cancelled"].includes(work.state) ||
          work.references.some((reference) => {
            if (reference.kind === "ordinary" || reference.kind === "hub-work") return true;
            if (reference.kind === "thread") return !plan.threadIds.includes(reference.id);
            return !plan.snapshotIds.includes(reference.id);
          }),
      );
      const retainedHubRefIds = new Set(
        remainingHubRefs
          .filter(
            (work) =>
              retainedHubWorkIds.has(work.workId) &&
              ["completed", "failed", "cancelled"].includes(work.state),
          )
          .map((work) => work.workId),
      );
      const retainedThreadRefIds = new Set(
        readback.threads
          .filter((thread) => plan.threadIds.includes(thread.threadId) && thread.deleted)
          .map((thread) => thread.threadId),
      );
      const remainingSnapshotRefs = readback.snapshots.filter(
        (snapshot) =>
          plan.snapshotIds.includes(snapshot.snapshotId) &&
          snapshot.references.some((reference) => {
            if (reference.kind === "hub-work" && retainedHubRefIds.has(reference.id)) return false;
            if (reference.kind === "thread" && retainedThreadRefIds.has(reference.id)) return false;
            return true;
          }),
      );
      if (remainingThreadRefs.length || unresolvedHubRefs.length || remainingSnapshotRefs.length) {
        throw new SkillPackageSwitchError(
          "Legacy snapshots still have task, Hub, or ordinary references; cleanup was blocked.",
          "unsafe_inventory",
        );
      }

      progress.status = "cleaning";
      await updateProgress(progress);
      if (!progress.cleaned) {
        const retainedSnapshots = new Set(plan.retainedSnapshotIds);
        const cleanSnapshotIds = plan.snapshotIds.filter(
          (snapshotId) => !retainedSnapshots.has(snapshotId),
        );
        const cleanProjectionIds = plan.snapshotTargets
          .filter((snapshot) => !retainedSnapshots.has(snapshot.snapshotId))
          .flatMap((snapshot) => snapshot.projectionIds);
        await input.host.cleanupLegacyArtifacts({
          threadIds: plan.threadIds,
          snapshotIds: cleanSnapshotIds,
          projectionIds: cleanProjectionIds,
        });
        progress.cleaned = true;
        progress.retainedSnapshotIds = [...retainedSnapshots].sort();
        await updateProgress(progress);
      }
      progress.status = progress.retainedSnapshotIds.length
        ? "complete_with_retained_artifacts"
        : "complete";
      delete progress.error;
      await updateProgress(progress);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const latest = await readProgressUnlocked(command.switchId).catch(() => null);
      if (latest && latest.status !== "complete") {
        latest.status = "failed";
        latest.error = message;
        await updateProgress(latest).catch(() => undefined);
      }
      throw cause;
    }
  };

  const apply = (command: { readonly switchId: string; readonly digest: string }) =>
    withSwitchQueue(input.stateDir, () => applyUnlocked(command));

  return { preview, apply, readProgress };
}
