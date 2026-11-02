import {
  ExpertLearningState,
  ExpertSkillBinding,
  ResolvedExpertSkillEntry,
  SpaceMemoryRevisionRef,
} from "@synara/contracts";
import { Effect, Schema } from "effect";
import { expertResourceFiles, type ExpertStore } from "../ExpertStore";
import { createSkillPackageStore } from "../SkillPackageStore";
import { readSkillDefinition, resolveSkillBindings } from "../SkillLibraryStore";
import { verifyPinnedSkillReferences } from "../pinnedSkillReferences";
import { retainSkillEvolutionPackages } from "../skillEvolutionPackagePins";
import { serializeJsonWithinByteLimit } from "../ExpertMcpStorage";
import type { ExpertLearningRepositoryShape, LearningStateRow } from "./ExpertLearningRepository";

const FrozenBinding = Schema.Struct({
  binding: ExpertSkillBinding,
  entries: Schema.Array(ResolvedExpertSkillEntry).check(Schema.isMaxLength(5_000)),
});
export const StoredLearningState = Schema.Struct({
  state: ExpertLearningState,
  ownerKind: Schema.Literals(["session", "local-loopback"]),
  frozenBindings: Schema.optional(Schema.Array(FrozenBinding).check(Schema.isMaxLength(100))),
  frozenRuleSequence: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  ruleOverrides: Schema.optional(
    Schema.Array(SpaceMemoryRevisionRef).check(Schema.isMaxLength(256)),
  ),
  lastRequestId: Schema.optional(Schema.String),
  lastRequestFingerprint: Schema.optional(Schema.String),
  /** Sources older than this authorization are never replayed when learning is re-enabled. */
  enabledAt: Schema.optional(Schema.String),
});
export type StoredLearningState = typeof StoredLearningState.Type;
export function decodeLearningState(row: LearningStateRow): StoredLearningState {
  const value = Schema.decodeUnknownSync(StoredLearningState)(JSON.parse(row.record));
  if (value.state.expertId !== row.expertId || value.state.revision !== row.revision)
    throw new Error("Expert learning state identity is invalid.");
  return value;
}
const equal = (a: unknown, b: unknown) =>
  expertResourceFiles.stableJson(a) === expertResourceFiles.stableJson(b);

/** Match native binding expansion: identity deduplication and package-wide private resources. */
export function flattenLearningBindings(
  groups: NonNullable<StoredLearningState["frozenBindings"]>,
) {
  const privatePackages = new Set(
    groups
      .filter((group) => group.binding.enabled && group.binding.resourceMode === "run-private")
      .flatMap((group) => group.entries.map((entry) => entry.packageId)),
  );
  const entries = new Map<string, ResolvedExpertSkillEntry>();
  for (const group of groups)
    for (const entry of group.entries) {
      if (!group.binding.enabled) continue;
      const { resourceMode: _mode, ...source } = entry;
      entries.set(
        entry.packageId + "\0" + entry.entryPath,
        privatePackages.has(entry.packageId) ? { ...source, resourceMode: "run-private" } : source,
      );
    }
  if (entries.size > 5_000)
    throw new Error("Fixed learning bindings exceed the Skill entry limit.");
  return [...entries.values()];
}

export async function captureLearningBindings(
  stateDir: string,
  bindings: readonly ExpertSkillBinding[],
  expertId: string,
  previous: StoredLearningState["frozenBindings"] = [],
  changedSkillIds: readonly string[] = [],
): Promise<NonNullable<StoredLearningState["frozenBindings"]>> {
  const packages = createSkillPackageStore(stateDir);
  const frozen = [];
  for (const binding of bindings) {
    const prior = previous.find((entry) => entry.binding.skillId === binding.skillId);
    const sameSource =
      prior &&
      prior.binding.skillId === binding.skillId &&
      (prior.binding.selectionScope ?? "entry") === (binding.selectionScope ?? "entry");
    if (sameSource && !changedSkillIds.includes(binding.skillId)) {
      frozen.push({ binding, entries: prior.entries });
      continue;
    }
    // Disabled bindings also retain their source version. Re-enabling a binding
    // or changing delivery/permission metadata is not an implicit source upgrade.
    const selections = await resolveSkillBindings(
      stateDir,
      [{ ...binding, enabled: true }],
      expertId,
    );
    const entries = (await packages.resolveSelections(selections)).map((entry) => ({
      ...entry,
      managedSkillId: binding.skillId,
    }));
    frozen.push({ binding, entries });
  }
  const entries = flattenLearningBindings(frozen);
  await verifyPinnedSkillReferences(stateDir, entries);
  await retainSkillEvolutionPackages(
    stateDir,
    frozen.flatMap((group) => group.entries.map((entry) => entry.packageId)),
  );
  return frozen;
}

export const writeLearningState = (
  repository: ExpertLearningRepositoryShape,
  ownerId: string,
  record: StoredLearningState,
  expectedRevision: number,
) =>
  repository.writeState(
    {
      ownerId,
      expertId: record.state.expertId,
      revision: record.state.revision,
      updatedAt: record.state.updatedAt,
      record: serializeJsonWithinByteLimit(
        record,
        16 * 1024 * 1024,
        "Expert learning state exceeds its storage budget.",
      ),
    },
    expectedRevision,
  );

export const saveLearningState = (
  repository: ExpertLearningRepositoryShape,
  ownerId: string,
  record: StoredLearningState,
  expectedRevision: number,
) => Effect.runPromise(writeLearningState(repository, ownerId, record, expectedRevision));

/** Pure runtime lookup: never takes the commit gate while the Run holds package lifecycle. */
export function frozenLearningEntriesReader(repository: ExpertLearningRepositoryShape) {
  return async (expertId: string, bindings: readonly ExpertSkillBinding[]) => {
    const rows = (await Effect.runPromise(repository.listStates())).filter(
      (row) => row.expertId === expertId,
    );
    if (rows.length > 1) throw new Error("Expert learning has ambiguous ownership.");
    const record = rows[0] ? decodeLearningState(rows[0]) : undefined;
    if (!record || record.state.enabled || !record.frozenBindings) return undefined;
    if (
      !equal(
        record.frozenBindings.map((group) => group.binding),
        bindings,
      )
    )
      throw new Error("Expert learning fixed bindings need reconciliation before a new Run.");
    return flattenLearningBindings(record.frozenBindings);
  };
}

export async function reconcileExplicitLearningEdits(input: {
  stateDir: string;
  repository: ExpertLearningRepositoryShape;
  experts: Pick<ExpertStore, "read">;
  expertIds?: readonly string[];
  skillIds?: readonly string[];
}) {
  for (const row of await Effect.runPromise(input.repository.listStates())) {
    const scoped = input.expertIds !== undefined || input.skillIds !== undefined;
    const direct = input.expertIds?.includes(row.expertId) ?? false;
    if (scoped && !direct && !input.skillIds?.length) continue;
    const record = decodeLearningState(row);
    if (record.state.enabled || !record.frozenBindings) continue;
    if (
      scoped &&
      !direct &&
      !record.frozenBindings.some((group) => input.skillIds?.includes(group.binding.skillId))
    )
      continue;
    const expert = await input.experts.read(row.expertId);
    if (!expert || expert.archived) continue;
    const bindings = expert.skillBindings ?? [];
    const targeted: string[] = [];
    for (const id of input.skillIds ?? []) {
      if (!bindings.some((binding) => binding.skillId === id)) continue;
      const skill = await readSkillDefinition(input.stateDir, id);
      if (skill.scope?.kind === "expert" && skill.scope.expertId === expert.id) targeted.push(id);
    }
    const frozenBindings = await captureLearningBindings(
      input.stateDir,
      bindings,
      expert.id,
      record.frozenBindings,
      targeted,
    );
    if (equal(frozenBindings, record.frozenBindings)) continue;
    await saveLearningState(
      input.repository,
      row.ownerId,
      {
        ...record,
        frozenBindings,
        state: {
          ...record.state,
          revision: record.state.revision + 1,
          updatedAt: new Date().toISOString(),
        },
      },
      record.state.revision,
    );
  }
}
