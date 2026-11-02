import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExpertDefinition, ExpertSkillBinding } from "@synara/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { expertResourceFiles } from "../ExpertStore";
import { createSkillLibraryStore } from "../SkillLibraryStore";
import { createSkillPackageStore } from "../SkillPackageStore";
import type {
  ExpertLearningRepositoryShape,
  LearningCycleRow,
  LearningEvidenceRow,
  LearningStateRow,
} from "./ExpertLearningRepository";
import {
  captureLearningBindings,
  decodeLearningState,
  flattenLearningBindings,
  frozenLearningEntriesReader,
  reconcileExplicitLearningEdits,
  type StoredLearningState,
} from "./ExpertLearningState";

const roots: string[] = [];
const libraries: Array<ReturnType<typeof createSkillLibraryStore>> = [];
const timestamp = "2026-10-31T01:00:00.000Z";

class MemoryRepository implements ExpertLearningRepositoryShape {
  readonly states = new Map<string, LearningStateRow>();
  readState = (ownerId: string, expertId: string) =>
    Effect.succeed(this.states.get(`${ownerId}\0${expertId}`));
  listStates = () => Effect.succeed([...this.states.values()]);
  writeState = (row: LearningStateRow, expectedRevision: number) =>
    Effect.sync(() => {
      const key = `${row.ownerId}\0${row.expertId}`;
      const old = this.states.get(key);
      if ((old?.revision ?? 0) !== expectedRevision) throw new Error("revision conflict");
      if (row.revision !== expectedRevision + 1) throw new Error("invalid next revision");
      this.states.set(key, row);
    });
  readEvidence = (_evidenceId: string) => Effect.succeed(undefined);
  listEvidence = (_ownerId: string, _expertId: string) => Effect.succeed([]);
  writeEvidence = (_row: LearningEvidenceRow) => Effect.succeed(undefined);
  readCycle = (_cycleId: string) => Effect.succeed(undefined);
  listCycles = (_ownerId?: string, _expertId?: string) => Effect.succeed([]);
  writeCycle = (_row: LearningCycleRow) => Effect.succeed(undefined);
}

async function unlock(entry: string): Promise<void> {
  const stat = await fs.lstat(entry).catch(() => undefined);
  if (!stat || stat.isSymbolicLink()) return;
  await fs.chmod(entry, stat.isDirectory() ? 0o700 : 0o600).catch(() => undefined);
  if (stat.isDirectory())
    for (const child of await fs.readdir(entry)) await unlock(path.join(entry, child));
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "expert-learning-state-"));
  roots.push(root);
  const stateDir = path.join(root, "state");
  const library = createSkillLibraryStore(stateDir);
  libraries.push(library);
  return { root, stateDir, library, repository: new MemoryRepository() };
}

async function createSkill(library: ReturnType<typeof createSkillLibraryStore>, name: string) {
  const result = await library.execute(
    {
      action: "create",
      requestId: `create-${name}`,
      name,
      body: `---\nname: ${name.toLowerCase().replaceAll(" ", "-")}\ndescription: Test skill\n---\n${name} instructions.\n`,
      tags: [],
    },
    { actor: "learning-state-test" },
  );
  if (!result.skill) throw new Error(`failed to create ${name}`);
  return result.skill;
}

function binding(skillId: string, options: Partial<ExpertSkillBinding> = {}): ExpertSkillBinding {
  return { skillId: skillId as ExpertSkillBinding["skillId"], enabled: true, ...options };
}

function stateRow(input: {
  ownerId: string;
  expertId: string;
  frozenBindings: NonNullable<StoredLearningState["frozenBindings"]>;
  frozenRuleSequence?: number;
  ruleOverrides?: StoredLearningState["ruleOverrides"];
}): LearningStateRow {
  const record: StoredLearningState = {
    ownerKind: "session",
    state: {
      expertId: input.expertId,
      enabled: false,
      epoch: 2,
      revision: 1,
      updatedAt: timestamp,
    },
    frozenBindings: input.frozenBindings,
    ...(input.frozenRuleSequence !== undefined
      ? { frozenRuleSequence: input.frozenRuleSequence }
      : {}),
    ...(input.ruleOverrides !== undefined ? { ruleOverrides: input.ruleOverrides } : {}),
  };
  return {
    ownerId: input.ownerId,
    expertId: input.expertId,
    revision: record.state.revision,
    updatedAt: record.state.updatedAt,
    record: JSON.stringify(record),
  };
}

afterEach(async () => {
  for (const library of libraries.splice(0)) await library.dispose();
  for (const root of roots.splice(0)) {
    await expertResourceFiles.removeStaging(root);
    await unlock(root);
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("ExpertLearningState frozen references", () => {
  it("deduplicates overlapping frozen package entries and promotes package resources to run-private", async () => {
    const f = await fixture();
    const skill = await createSkill(f.library, "Overlapping frozen entry");
    const shared = binding(skill.skillId, { resourceMode: "shared-readonly" });
    const privateBinding = binding(skill.skillId, { resourceMode: "run-private" });
    const captured = await captureLearningBindings(f.stateDir, [shared], "overlap-expert");
    const entry = captured[0]!.entries[0]!;

    const flattened = flattenLearningBindings([
      { binding: shared, entries: [entry] },
      { binding: privateBinding, entries: [entry] },
    ]);

    expect(flattened).toHaveLength(1);
    expect(flattened[0]).toMatchObject({
      packageId: skill.packageId,
      entryPath: skill.entryPath,
      resourceMode: "run-private",
    });
  });

  it("keeps unchanged package refs and unrelated bindings frozen while an explicit binding update advances only its target", async () => {
    const f = await fixture();
    const ownerId = "frozen-learning-owner";
    const expertId = "frozen-learning-expert";
    const original = await createSkill(f.library, "Original pinned workflow");
    const unrelated = await createSkill(f.library, "Unrelated pinned workflow");
    const replacement = await createSkill(f.library, "Replacement workflow");
    const firstBinding = binding(original.skillId, {
      allowEvolution: false,
      resourceMode: "run-private",
    });
    const unrelatedBinding = binding(unrelated.skillId, { selectionScope: "package" });
    const originalBindings = [firstBinding, unrelatedBinding];
    const initial = await captureLearningBindings(f.stateDir, originalBindings, expertId);
    const repository = f.repository;
    const row = stateRow({ ownerId, expertId, frozenBindings: initial });
    repository.states.set(`${ownerId}\0${expertId}`, row);
    const packages = createSkillPackageStore(f.stateDir);
    const originalFrozenEntries = initial.flatMap((group) => group.entries);
    const originalPackageIds = originalFrozenEntries.map((entry) => entry.packageId);

    await expect(
      frozenLearningEntriesReader(repository)(expertId, originalBindings),
    ).resolves.toEqual(originalFrozenEntries);

    const editedBinding = binding(replacement.skillId, {
      allowEvolution: true,
      resourceMode: "run-private",
    });
    const expert = {
      id: expertId,
      archived: false,
      skillBindings: [editedBinding, unrelatedBinding],
    } as unknown as ExpertDefinition;
    await reconcileExplicitLearningEdits({
      stateDir: f.stateDir,
      repository,
      experts: { read: async (id: string) => (id === expertId ? expert : undefined) } as never,
      expertIds: [expertId],
      skillIds: [replacement.skillId],
    });

    const updatedRow = repository.states.get(`${ownerId}\0${expertId}`)!;
    const updated = decodeLearningState(updatedRow);
    const updatedBindings = [editedBinding, unrelatedBinding];
    const updatedEntries = await frozenLearningEntriesReader(repository)(expertId, updatedBindings);
    expect(updatedRow.revision).toBe(2);
    expect(updated?.frozenBindings?.map((group) => group.binding)).toEqual(updatedBindings);
    expect(updated?.frozenBindings?.[1]).toEqual(initial[1]);
    expect(updatedEntries?.map((entry) => entry.packageId)).toEqual([
      replacement.packageId,
      unrelated.packageId,
    ]);
    expect(originalPackageIds).toEqual([original.packageId, unrelated.packageId]);

    await f.library.execute(
      {
        action: "delete",
        skillId: original.skillId,
        expectedRevision: original.revision,
        confirmExpertIds: [],
      },
      { actor: "learning-state-test" },
    );
    await expect(packages.remove(original.packageId)).rejects.toThrow(/referenced/u);
    await expect(packages.read(original.packageId)).resolves.toMatchObject({
      packageId: original.packageId,
    });
  });

  it("rejects a runtime lookup when its binding list has not been reconciled", async () => {
    const f = await fixture();
    const original = await createSkill(f.library, "Frozen binding");
    const updated = await createSkill(f.library, "Edited binding");
    const frozenBinding = binding(original.skillId);
    const frozen = await captureLearningBindings(
      f.stateDir,
      [frozenBinding],
      "frozen-reader-expert",
    );
    const row = stateRow({
      ownerId: "frozen-reader-owner",
      expertId: "frozen-reader-expert",
      frozenBindings: frozen,
    });
    f.repository.states.set(`${row.ownerId}\0${row.expertId}`, row);

    await expect(
      frozenLearningEntriesReader(f.repository)("frozen-reader-expert", [binding(updated.skillId)]),
    ).rejects.toThrow(/need reconciliation/u);
  });

  it("round-trips the close-time Memory rule watermark and explicit revision overrides", async () => {
    const f = await fixture();
    const skill = await createSkill(f.library, "Memory watermark binding");
    const frozenBindings = await captureLearningBindings(
      f.stateDir,
      [binding(skill.skillId)],
      "memory-watermark-expert",
    );
    const override = {
      memoryId: "memory-explicit-override",
      revision: 3,
      contentHash: `sha256:${"d".repeat(64)}`,
    };
    const row = stateRow({
      ownerId: "memory-watermark-owner",
      expertId: "memory-watermark-expert",
      frozenBindings,
      frozenRuleSequence: 9,
      ruleOverrides: [override],
    });
    const decoded = decodeLearningState(row);

    expect(decoded.frozenRuleSequence).toBe(9);
    expect(decoded.ruleOverrides).toEqual([override]);
    expect(decoded.frozenBindings).toEqual(frozenBindings);
  });
});
