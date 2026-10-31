import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExpertSkillBinding, SkillFileChange } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExpertStore, expertResourceFiles } from "../ExpertStore";
import { createSkillLibraryStore, readSkillDefinition } from "../SkillLibraryStore";
import { createSkillPackageStore } from "../SkillPackageStore";
import { createPreparedSkillChanges, type PreparedSkillChangeIntent } from "./PreparedSkillChanges";

const roots: string[] = [];
const libraries: Array<ReturnType<typeof createSkillLibraryStore>> = [];
const ownerId = "prepared-skill-owner";
const encode = (text: string) => Buffer.from(text, "utf8").toString("base64");
const file = (text: string, executable?: boolean): SkillFileChange => ({
  path: "SKILL.md",
  content: encode(text),
  ...(executable !== undefined ? { executable } : {}),
});
const skillBody = (name: string, lines = ["alpha original", "beta original"]) =>
  `---\nname: ${name}\ndescription: ${name} workflow\n---\n${lines.join("\n")}\n`;

async function unlock(target: string): Promise<void> {
  const stat = await fs.lstat(target).catch(() => undefined);
  if (!stat || stat.isSymbolicLink()) return;
  await fs.chmod(target, stat.isDirectory() ? 0o700 : 0o600).catch(() => undefined);
  if (stat.isDirectory())
    for (const child of await fs.readdir(target)) await unlock(path.join(target, child));
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const library of libraries.splice(0)) await library.dispose();
  for (const root of roots.splice(0)) {
    await expertResourceFiles.removeStaging(root);
    await unlock(root);
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-prepared-skill-"));
  roots.push(root);
  const stateDir = path.join(root, "state");
  const experts = createExpertStore(stateDir);
  const library = createSkillLibraryStore(stateDir);
  libraries.push(library);
  const packages = createSkillPackageStore(stateDir);
  const prepared = createPreparedSkillChanges({ stateDir, experts, library, packages });
  return { root, stateDir, experts, library, packages, prepared };
}

async function createExpert(state: Awaited<ReturnType<typeof fixture>>, id = "expert-prepared") {
  return state.experts.save({
    id,
    name: `Expert ${id}`,
    description: "Prepared Skill test.",
    useCases: "Bounded edits.",
    persona: "Preserve unrelated work.",
    outputRequirements: "Keep references exact.",
    skills: [],
    skillBindings: [],
    references: [],
    connections: [],
  });
}

async function createSkill(
  state: Awaited<ReturnType<typeof fixture>>,
  input: {
    readonly name: string;
    readonly expertId?: string;
    readonly body?: string;
    readonly extraFiles?: readonly SkillFileChange[];
  },
) {
  const result = await state.library.execute(
    {
      action: "create",
      requestId: `fixture-create-${input.name}`,
      name: input.name,
      body: input.body ?? skillBody(input.name),
      tags: [],
      ...(input.extraFiles ? { changes: [...input.extraFiles] } : {}),
    },
    { actor: ownerId, ...(input.expertId ? { createForExpertId: input.expertId } : {}) },
  );
  if (!result.skill) throw new Error("Fixture Skill was not created.");
  return result.skill;
}

async function bind(
  state: Awaited<ReturnType<typeof fixture>>,
  expert: Awaited<ReturnType<typeof createExpert>>,
  bindings: readonly ExpertSkillBinding[],
  requestId: string,
) {
  const result = await state.library.execute(
    {
      action: "bindings",
      operation: "set",
      expertId: expert.id,
      expectedRevision: expert.revision,
      requestId,
      bindings: [...bindings],
    },
    { actor: ownerId },
  );
  if (
    !result.bindingResult ||
    !["applied", "unchanged"].includes(result.bindingResult.status ?? "")
  )
    throw new Error(result.bindingResult?.error ?? "Fixture binding failed.");
  return result.bindingResult.bindings;
}

function trustedContext() {
  return {
    actor: ownerId,
    beforeMutation: async () => {},
  } as const;
}

async function packageFile(
  state: Awaited<ReturnType<typeof fixture>>,
  packageId: string,
  filePath: string,
) {
  return expertResourceFiles.read(
    path.join(
      state.stateDir,
      "experts",
      "skill-packages",
      packageId,
      "content",
      ...filePath.split("/"),
    ),
  );
}

describe("PreparedSkillChanges", () => {
  it("derives a full immutable private copy without changing the shared package or binding fields", async () => {
    const state = await fixture();
    const expert = await createExpert(state);
    const binary = Buffer.from([0, 1, 2, 127, 255]);
    const source = await createSkill(state, {
      name: "Shared procedures",
      body: skillBody("Shared procedures"),
      extraFiles: [
        { path: "resources/blob.bin", content: binary.toString("base64") },
        { path: "scripts/check.sh", content: encode("#!/bin/sh\nexit 0\n"), executable: true },
      ],
    });
    const originalBinding: ExpertSkillBinding = {
      skillId: source.skillId,
      enabled: false,
      allowEvolution: true,
      selectionScope: "package",
      resourceMode: "run-private",
    };
    await bind(state, expert, [originalBinding], "fixture-bind-shared");
    const sourcePackage = await state.packages.read(source.packageId);
    const sourceBinary = await packageFile(state, source.packageId, "resources/blob.bin");
    const sourceScript = await packageFile(state, source.packageId, "scripts/check.sh");
    const currentExpert = await state.experts.read(expert.id);
    if (!currentExpert) throw new Error("Expert missing after fixture binding.");

    const committed = await state.prepared.commit(
      {
        operationId: "shared-copy-1",
        expertId: expert.id,
        expectedExpertRevision: currentExpert.revision,
        targetSkillId: source.skillId,
        expectedSkillRevision: source.revision,
        basePackageId: source.packageId,
        name: "Shared procedures for Expert",
        changes: [file(skillBody("Shared procedures", ["alpha corrected", "beta original"]))],
        evidenceRefs: [{ kind: "message", id: "message-1" }],
      },
      trustedContext(),
    );

    expect(committed.status).toBe("committed");
    expect(committed.mode).toBe("derive");
    expect(committed.after.skill.skillId).not.toBe(source.skillId);
    expect(committed.after.skill.packageId).not.toBe(source.packageId);
    expect(committed.after.bindings).toEqual([
      { ...originalBinding, skillId: committed.after.skill.skillId },
    ]);
    expect(await readSkillDefinition(state.stateDir, source.skillId)).toEqual(source);
    expect(await state.packages.read(source.packageId)).toEqual(sourcePackage);
    expect(await packageFile(state, source.packageId, "resources/blob.bin")).toEqual(sourceBinary);
    expect(await packageFile(state, committed.after.packageId, "resources/blob.bin")).toEqual(
      sourceBinary,
    );
    expect(await packageFile(state, committed.after.packageId, "scripts/check.sh")).toEqual(
      sourceScript,
    );
    const derivedPackage = await state.packages.read(committed.after.packageId);
    expect(
      derivedPackage.resources.find((resource) => resource.path === "content/scripts/check.sh")
        ?.executable,
    ).toBe(true);
    expect(committed.evidenceRefs).toEqual([{ kind: "message", id: "message-1" }]);
  });

  it("derives same-name edits under an Expert-specific name while preserving shared resources", async () => {
    const state = await fixture();
    const expert = await createExpert(state);
    const support = Buffer.from("Keep this shared reference intact.\n");
    const source = await createSkill(state, {
      name: "Shared procedures",
      extraFiles: [{ path: "references/guide.md", content: support.toString("base64") }],
    });
    const sourceBinding: ExpertSkillBinding = {
      skillId: source.skillId,
      enabled: false,
      allowEvolution: true,
      selectionScope: "package",
      resourceMode: "run-private",
    };
    await bind(state, expert, [sourceBinding], "fixture-bind-same-name-source");
    const currentExpert = (await state.experts.read(expert.id))!;
    const sourcePackage = await state.packages.read(source.packageId);
    let preparedIntent: PreparedSkillChangeIntent | undefined;

    const committed = await state.prepared.commit(
      {
        operationId: "same-name-shared-edit",
        expertId: expert.id,
        expectedExpertRevision: currentExpert.revision,
        targetSkillId: source.skillId,
        expectedSkillRevision: source.revision,
        basePackageId: source.packageId,
        name: source.name,
        changes: [file(skillBody(source.name, ["alpha corrected", "beta original"]))],
      },
      {
        ...trustedContext(),
        onPrepared: async (intent) => {
          preparedIntent = intent;
        },
      },
    );

    expect(preparedIntent?.kind).toBe("commit");
    if (preparedIntent?.kind !== "commit") throw new Error("Commit intent was not prepared.");
    expect(preparedIntent.request.name).toBe(source.name);
    expect(preparedIntent.mutation.request).toMatchObject({
      action: "derive",
      name: `${source.name} (${expert.name})`,
    });
    expect(committed.status).toBe("committed");
    expect(committed.after.skill.name).toBe(`${source.name} (${expert.name})`);
    expect(committed.after.bindings).toEqual([
      { ...sourceBinding, skillId: committed.after.skill.skillId },
    ]);
    expect(await readSkillDefinition(state.stateDir, source.skillId)).toEqual(source);
    expect(await state.packages.read(source.packageId)).toEqual(sourcePackage);
    expect(await packageFile(state, committed.after.packageId, "references/guide.md")).toEqual(
      support,
    );
  });

  it("adds a numeric suffix when the generated name collides after Library normalization", async () => {
    const state = await fixture();
    const expert = await createExpert(state);
    const source = await createSkill(state, { name: "Café" });
    const collidingName = `CAFE\u0301 (${expert.name.toUpperCase()})`;
    const collision = await createSkill(state, { name: collidingName });
    await bind(
      state,
      expert,
      [{ skillId: source.skillId, enabled: true, allowEvolution: true }],
      "fixture-bind-normalized-name-source",
    );
    const currentExpert = (await state.experts.read(expert.id))!;
    let preparedIntent: PreparedSkillChangeIntent | undefined;

    const committed = await state.prepared.commit(
      {
        operationId: "normalized-derived-name-collision",
        expertId: expert.id,
        expectedExpertRevision: currentExpert.revision,
        targetSkillId: source.skillId,
        expectedSkillRevision: source.revision,
        basePackageId: source.packageId,
        name: source.name,
        changes: [file(skillBody(source.name, ["alpha corrected", "beta original"]))],
      },
      {
        ...trustedContext(),
        onPrepared: async (intent) => {
          preparedIntent = intent;
        },
      },
    );

    const expectedName = `${source.name} (${expert.name}) (2)`;
    expect(preparedIntent?.kind).toBe("commit");
    if (preparedIntent?.kind !== "commit") throw new Error("Commit intent was not prepared.");
    expect(preparedIntent.request.name).toBe(source.name);
    expect(preparedIntent.mutation.request).toMatchObject({ action: "derive", name: expectedName });
    expect(committed.after.skill.name).toBe(expectedName);
    expect(await readSkillDefinition(state.stateDir, collision.skillId)).toEqual(collision);
  });

  it("bounds a long Unicode derived name without splitting code points", async () => {
    const state = await fixture();
    const expert = await createExpert(state);
    const sourceName = `${"😀".repeat(88)} Shared`;
    const source = await createSkill(state, { name: sourceName });
    await bind(
      state,
      expert,
      [{ skillId: source.skillId, enabled: true, allowEvolution: true }],
      "fixture-bind-long-unicode-source",
    );
    const currentExpert = (await state.experts.read(expert.id))!;
    let preparedIntent: PreparedSkillChangeIntent | undefined;

    await state.prepared.commit(
      {
        operationId: "long-unicode-derived-name",
        expertId: expert.id,
        expectedExpertRevision: currentExpert.revision,
        targetSkillId: source.skillId,
        expectedSkillRevision: source.revision,
        basePackageId: source.packageId,
        name: source.name,
        changes: [file(skillBody(source.name, ["alpha corrected", "beta original"]))],
      },
      {
        ...trustedContext(),
        onPrepared: async (intent) => {
          preparedIntent = intent;
        },
      },
    );

    expect(preparedIntent?.kind).toBe("commit");
    if (preparedIntent?.kind !== "commit") throw new Error("Commit intent was not prepared.");
    const generatedName = preparedIntent.mutation.request.name;
    expect(generatedName.length).toBeLessThanOrEqual(200);
    expect(generatedName.endsWith(` (${expert.name})`)).toBe(true);
    expect(generatedName).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
  });

  it("reuses the frozen generated name when a durable derive response is lost", async () => {
    const state = await fixture();
    const expert = await createExpert(state);
    const source = await createSkill(state, { name: "Replay shared procedures" });
    await bind(
      state,
      expert,
      [{ skillId: source.skillId, enabled: true, allowEvolution: true }],
      "fixture-bind-same-name-replay-source",
    );
    const currentExpert = (await state.experts.read(expert.id))!;
    const request = {
      operationId: "same-name-derived-lost-response",
      expertId: expert.id,
      expectedExpertRevision: currentExpert.revision,
      targetSkillId: source.skillId,
      expectedSkillRevision: source.revision,
      basePackageId: source.packageId,
      name: source.name,
      changes: [file(skillBody(source.name, ["alpha corrected", "beta original"]))],
    } as const;
    let preparedIntent: PreparedSkillChangeIntent | undefined;
    let failAfterWrite = true;
    const deriveRequests: string[] = [];
    let listReads = 0;
    const originalExecute = state.library.execute.bind(state.library);
    const execute = vi.spyOn(state.library, "execute");
    execute.mockImplementation((async (libraryRequest, libraryContext) => {
      if (libraryRequest.action === "list") listReads += 1;
      if (libraryRequest.action === "derive") deriveRequests.push(libraryRequest.name);
      const response = await originalExecute(libraryRequest, libraryContext);
      if (failAfterWrite && libraryRequest.action === "derive") {
        failAfterWrite = false;
        throw new Error("Simulated lost same-name derive response.");
      }
      return response;
    }) as typeof state.library.execute);
    const context = {
      ...trustedContext(),
      onPrepared: async (intent: PreparedSkillChangeIntent) => {
        preparedIntent = intent;
      },
    };

    await expect(state.prepared.commit(request, context)).rejects.toThrow(
      /lost same-name derive response/u,
    );
    expect(preparedIntent?.kind).toBe("commit");
    if (preparedIntent?.kind !== "commit") throw new Error("Commit intent was not prepared.");
    const frozenName = preparedIntent.mutation.request.name;
    const retry = await state.prepared.commit(request, trustedContext(), undefined, preparedIntent);

    expect(retry.status).toBe("committed");
    expect(retry.after.skill.name).toBe(frozenName);
    expect(deriveRequests).toEqual([frozenName, frozenName]);
    expect(listReads).toBe(1);
    const listed = await originalExecute({ action: "list" });
    expect(
      (listed.skills ?? []).filter((skill) => skill.derivedFrom?.skillId === source.skillId),
    ).toHaveLength(1);
    expect(await readSkillDefinition(state.stateDir, source.skillId)).toEqual(source);
  });

  it("applies two corrections to the same private Skill identity", async () => {
    const state = await fixture();
    const expert = await createExpert(state);
    const base = await createSkill(state, { name: "Private procedures", expertId: expert.id });
    await bind(
      state,
      expert,
      [{ skillId: base.skillId, enabled: true, allowEvolution: true }],
      "fixture-bind-private-twice",
    );
    let currentExpert = (await state.experts.read(expert.id))!;
    const first = await state.prepared.commit(
      {
        operationId: "private-correction-1",
        expertId: expert.id,
        expectedExpertRevision: currentExpert.revision,
        targetSkillId: base.skillId,
        expectedSkillRevision: base.revision,
        basePackageId: base.packageId,
        changes: [file(skillBody("Private procedures", ["alpha corrected", "beta original"]))],
      },
      trustedContext(),
    );
    currentExpert = (await state.experts.read(expert.id))!;
    const second = await state.prepared.commit(
      {
        operationId: "private-correction-2",
        expertId: expert.id,
        expectedExpertRevision: currentExpert.revision,
        targetSkillId: base.skillId,
        expectedSkillRevision: first.after.skill.revision,
        basePackageId: first.after.packageId,
        changes: [file(skillBody("Private procedures", ["alpha corrected", "beta corrected"]))],
      },
      trustedContext(),
    );
    expect(first.after.skill.skillId).toBe(base.skillId);
    expect(second.after.skill.skillId).toBe(base.skillId);
    expect(second.after.skill.revision).toBe(first.after.skill.revision + 1);
  });

  it("replays one committed operation from its record without rejecting a later revision", async () => {
    const state = await fixture();
    const expert = await createExpert(state);
    const base = await createSkill(state, { name: "Replay procedures", expertId: expert.id });
    await bind(
      state,
      expert,
      [{ skillId: base.skillId, enabled: true, allowEvolution: true }],
      "fixture-bind-replay",
    );
    const currentExpert = (await state.experts.read(expert.id))!;
    const request = {
      operationId: "replay-operation",
      expertId: expert.id,
      expectedExpertRevision: currentExpert.revision,
      targetSkillId: base.skillId,
      expectedSkillRevision: base.revision,
      basePackageId: base.packageId,
      changes: [file(skillBody("Replay procedures", ["alpha replayed", "beta original"]))],
    } as const;
    const first = await state.prepared.commit(request, trustedContext());
    const changedAgain = await state.library.execute(
      {
        action: "save",
        requestId: "later-edit-after-replay-operation",
        skillId: base.skillId,
        expectedRevision: first.after.skill.revision,
        name: first.after.skill.name,
        tags: first.after.skill.tags,
        changes: [
          {
            path: "SKILL.md",
            content: encode(skillBody("Replay procedures", ["alpha replayed", "beta later edit"])),
          },
        ],
      },
      { actor: ownerId, retainForEvolution: true },
    );
    expect(changedAgain.skill?.revision).toBeGreaterThan(first.after.skill.revision);
    await expect(state.prepared.commit(request, trustedContext(), first)).resolves.toEqual(first);
  });

  it("returns saved_unbound after a binding interruption and retries the same operation", async () => {
    const state = await fixture();
    const expert = await createExpert(state);
    const source = await createSkill(state, { name: "Recoverable shared skill" });
    await bind(
      state,
      expert,
      [{ skillId: source.skillId, enabled: true, allowEvolution: true }],
      "fixture-bind-unbound",
    );
    const currentExpert = (await state.experts.read(expert.id))!;
    const request = {
      operationId: "saved-unbound-operation",
      expertId: expert.id,
      expectedExpertRevision: currentExpert.revision,
      targetSkillId: source.skillId,
      expectedSkillRevision: source.revision,
      basePackageId: source.packageId,
      name: "Recoverable shared skill private",
      changes: [file(skillBody("Recoverable shared skill", ["alpha fixed", "beta original"]))],
    } as const;
    const originalExecute = state.library.execute.bind(state.library);
    const execute = vi.spyOn(state.library, "execute");
    let failBinding = true;
    execute.mockImplementation((async (libRequest, context) => {
      if (failBinding && libRequest.action === "bindings" && libRequest.operation === "set") {
        failBinding = false;
        throw new Error("Simulated binding outage.");
      }
      return await originalExecute(libRequest, context);
    }) as typeof state.library.execute);
    let preparedIntent: PreparedSkillChangeIntent | undefined;
    const context = {
      ...trustedContext(),
      onPrepared: async (intent: PreparedSkillChangeIntent) => {
        preparedIntent = intent;
      },
    };
    const saved = await state.prepared.commit(request, context);
    expect(saved.status).toBe("saved_unbound");
    expect(saved.after.skill.packageId).not.toBe(source.packageId);
    expect(preparedIntent?.kind).toBe("commit");
    const retry = await state.prepared.commit(request, trustedContext(), saved, preparedIntent);
    expect(retry.status).toBe("committed");
    expect(retry.after.skill.skillId).toBe(saved.after.skill.skillId);
    expect(
      (await state.experts.read(expert.id))?.skillBindings?.map((binding) => binding.skillId),
    ).toEqual([saved.after.skill.skillId]);
  });

  it("refuses a read-only binding before writing a package", async () => {
    const state = await fixture();
    const expert = await createExpert(state);
    const base = await createSkill(state, { name: "Read only procedures", expertId: expert.id });
    await bind(state, expert, [{ skillId: base.skillId, enabled: true }], "fixture-bind-readonly");
    const currentExpert = (await state.experts.read(expert.id))!;
    await expect(
      state.prepared.commit(
        {
          operationId: "read-only-operation",
          expertId: expert.id,
          expectedExpertRevision: currentExpert.revision,
          targetSkillId: base.skillId,
          expectedSkillRevision: base.revision,
          basePackageId: base.packageId,
          changes: [file(skillBody("Read only procedures", ["changed", "beta original"]))],
        },
        trustedContext(),
      ),
    ).rejects.toThrow(/read-only/u);
    expect(await readSkillDefinition(state.stateDir, base.skillId)).toEqual(base);
  });

  it("reverts C1 while preserving unrelated C2 text in the same Skill", async () => {
    const state = await fixture();
    const expert = await createExpert(state);
    const base = await createSkill(state, { name: "Undo procedures", expertId: expert.id });
    await bind(
      state,
      expert,
      [{ skillId: base.skillId, enabled: true, allowEvolution: true }],
      "fixture-bind-undo",
    );
    const currentExpert = (await state.experts.read(expert.id))!;
    const first = await state.prepared.commit(
      {
        operationId: "undo-c1",
        expertId: expert.id,
        expectedExpertRevision: currentExpert.revision,
        targetSkillId: base.skillId,
        expectedSkillRevision: base.revision,
        basePackageId: base.packageId,
        changes: [file(skillBody("Undo procedures", ["alpha C1", "beta original"]))],
      },
      trustedContext(),
    );
    const second = await state.library.execute(
      {
        action: "save",
        requestId: "undo-c2-unrelated",
        skillId: base.skillId,
        expectedRevision: first.after.skill.revision,
        name: first.after.skill.name,
        tags: first.after.skill.tags,
        changes: [file(skillBody("Undo procedures", ["alpha C1; beta C2"]))],
      },
      { actor: ownerId, retainForEvolution: true },
    );
    expect(second.skill).toBeDefined();
    let inverseIntent: PreparedSkillChangeIntent | undefined;
    const reverted = await state.prepared.revert({ operationId: "undo-c1-revert" }, first, {
      ...trustedContext(),
      onPrepared: async (intent) => {
        inverseIntent = intent;
      },
    });
    expect(reverted).toMatchObject({ status: "committed" });
    if (!inverseIntent || inverseIntent.kind !== "revert")
      throw new Error("The inverse intent was not staged.");
    const expertAtInverse = (await state.experts.read(expert.id))!;
    expect(inverseIntent.before.packageId).toBe(base.packageId);
    expect(inverseIntent.currentBefore).toEqual({
      skill: second.skill,
      packageId: second.skill!.packageId,
      bindings: expertAtInverse.skillBindings,
      expertRevision: expertAtInverse.revision,
    });
    expect(inverseIntent.currentBefore.packageId).toBe(second.skill!.packageId);
    expect(
      (await packageFile(state, inverseIntent.currentBefore.packageId!, "SKILL.md")).toString(
        "utf8",
      ),
    ).toContain("alpha C1; beta C2");
    const final = await state.library.execute({ action: "read", skillId: base.skillId });
    const finalPkg = await packageFile(state, final.skill!.packageId, "SKILL.md");
    expect(finalPkg.toString("utf8")).toContain("alpha original; beta C2");
    expect(finalPkg.toString("utf8")).toContain("beta C2");

    const replay = await state.prepared.revert(
      { operationId: "undo-c1-revert", resumeIntent: inverseIntent },
      first,
      trustedContext(),
    );
    expect(replay.status).toBe("committed");
    expect(inverseIntent.currentBefore).toEqual({
      skill: second.skill,
      packageId: second.skill!.packageId,
      bindings: expertAtInverse.skillBindings,
      expertRevision: expertAtInverse.revision,
    });
  });

  it("reverts a derived Skill after C2 while preserving its private name and inverse metadata", async () => {
    const state = await fixture();
    const expert = await createExpert(state);
    const support = Buffer.from("Shared instructions remain available.\n");
    const source = await createSkill(state, {
      name: "Derived inverse procedures",
      extraFiles: [{ path: "references/guide.md", content: support.toString("base64") }],
    });
    await bind(
      state,
      expert,
      [{ skillId: source.skillId, enabled: true, allowEvolution: true }],
      "fixture-bind-derived-inverse-c1-c2",
    );
    const currentExpert = (await state.experts.read(expert.id))!;
    const sourcePackage = await state.packages.read(source.packageId);
    const c1Body = skillBody(source.name, ["alpha C1", "beta original"]).replace(
      `description: ${source.name} workflow`,
      "description: C1 description",
    );
    const first = await state.prepared.commit(
      {
        operationId: "derived-inverse-c1-c2",
        expertId: expert.id,
        expectedExpertRevision: currentExpert.revision,
        targetSkillId: source.skillId,
        expectedSkillRevision: source.revision,
        basePackageId: source.packageId,
        name: source.name,
        changes: [file(c1Body)],
      },
      trustedContext(),
    );
    expect(first.mode).toBe("derive");

    const c2Body = `---\nname: ${first.after.skill.name}\ndescription: C1 description\n---\nalpha C1\nbeta C2\n`;
    const c2 = await state.library.execute(
      {
        action: "save",
        requestId: "derived-inverse-c2-unrelated",
        skillId: first.after.skill.skillId,
        expectedRevision: first.after.skill.revision,
        name: first.after.skill.name,
        tags: first.after.skill.tags,
        changes: [file(c2Body)],
      },
      { actor: ownerId, retainForEvolution: true },
    );
    expect(c2.skill).toBeDefined();

    let inverseIntent: PreparedSkillChangeIntent | undefined;
    let loseInverseResponse = true;
    const originalExecute = state.library.execute.bind(state.library);
    const execute = vi.spyOn(state.library, "execute");
    execute.mockImplementation((async (libraryRequest, libraryContext) => {
      const response = await originalExecute(libraryRequest, libraryContext);
      const inverseRequest =
        inverseIntent?.kind === "revert" ? inverseIntent.mutations[0]?.request : undefined;
      if (
        loseInverseResponse &&
        inverseRequest &&
        libraryRequest.action === "save" &&
        "requestId" in inverseRequest &&
        libraryRequest.requestId === inverseRequest.requestId
      ) {
        loseInverseResponse = false;
        throw new Error("Simulated lost derived inverse response.");
      }
      return response;
    }) as typeof state.library.execute);
    const revertRequest = { operationId: "derived-inverse-c1-c2-revert" } as const;
    await expect(
      state.prepared.revert(revertRequest, first, {
        ...trustedContext(),
        onPrepared: async (intent) => {
          inverseIntent = intent;
        },
      }),
    ).rejects.toThrow(/lost derived inverse response/u);
    expect(inverseIntent?.kind).toBe("revert");
    if (inverseIntent?.kind !== "revert") throw new Error("The inverse intent was not staged.");
    expect(inverseIntent.currentBefore.skill).toEqual(c2.skill);
    const frozenInverseEntry = inverseIntent.mutations[0];
    if (frozenInverseEntry?.request.action !== "save")
      throw new Error("The inverse entry save was not staged.");
    const stagedEntry = frozenInverseEntry.request.changes.find(
      (change) => change.path === first.after.skill.entryPath,
    );
    expect(stagedEntry?.content).toBeDefined();
    expect(Buffer.from(stagedEntry!.content!, "base64").toString("utf8")).toContain(
      `name: ${first.after.skill.name}`,
    );
    expect(Buffer.from(stagedEntry!.content!, "base64").toString("utf8")).toContain(
      "description: Derived inverse procedures workflow",
    );

    const reverted = await state.prepared.revert(
      { ...revertRequest, resumeIntent: inverseIntent },
      first,
      trustedContext(),
    );
    expect(reverted.status).toBe("committed");
    const final = await state.library.execute({
      action: "read",
      skillId: first.after.skill.skillId,
    });
    const finalEntry = await packageFile(
      state,
      final.skill!.packageId,
      first.after.skill.entryPath,
    );
    const finalBody = finalEntry.toString("utf8");
    expect(final.skill!.skillId).toBe(first.after.skill.skillId);
    expect(final.skill!.name).toBe(first.after.skill.name);
    expect(final.skill!.description).toBe(source.description);
    expect(finalBody).toContain("alpha original");
    expect(finalBody).toContain("beta C2");
    expect(finalBody).not.toContain("alpha C1");
    expect(finalBody).toContain(`name: ${first.after.skill.name}`);
    expect(finalBody).toContain(`description: ${source.description}`);
    expect(await packageFile(state, final.skill!.packageId, "references/guide.md")).toEqual(
      support,
    );
    expect((await state.experts.read(expert.id))?.skillBindings).toEqual(first.after.bindings);
    expect(await readSkillDefinition(state.stateDir, source.skillId)).toEqual(source);
    expect(await state.packages.read(source.packageId)).toEqual(sourcePackage);
  });

  it("keeps a derived Skill bound through inverse and continues learning on the same private identity", async () => {
    const state = await fixture();
    const expert = await createExpert(state);
    const support = Buffer.from([0, 1, 2, 127, 255]);
    const source = await createSkill(state, {
      name: "Derived inverse baseline",
      extraFiles: [{ path: "resources/data.bin", content: support.toString("base64") }],
    });
    const originalBinding: ExpertSkillBinding = {
      skillId: source.skillId,
      enabled: false,
      allowEvolution: true,
      selectionScope: "package",
      resourceMode: "run-private",
    };
    await bind(state, expert, [originalBinding], "fixture-bind-derived-inverse-baseline");
    const currentExpert = (await state.experts.read(expert.id))!;
    const sourcePackage = await state.packages.read(source.packageId);
    const first = await state.prepared.commit(
      {
        operationId: "derived-inverse-baseline-c1",
        expertId: expert.id,
        expectedExpertRevision: currentExpert.revision,
        targetSkillId: source.skillId,
        expectedSkillRevision: source.revision,
        basePackageId: source.packageId,
        name: source.name,
        changes: [
          file(
            skillBody(source.name, ["alpha C1", "beta original"]).replace(
              `description: ${source.name} workflow`,
              "description: Temporary C1 description",
            ),
          ),
        ],
      },
      trustedContext(),
    );
    const privateName = first.after.skill.name;
    expect(privateName).toBe(`${source.name} (${expert.name})`);

    const reverted = await state.prepared.revert(
      { operationId: "derived-inverse-baseline-revert" },
      first,
      trustedContext(),
    );
    expect(reverted.status).toBe("committed");
    const privateBinding = { ...originalBinding, skillId: first.after.skill.skillId };
    expect((await state.experts.read(expert.id))?.skillBindings).toEqual([privateBinding]);
    const retainedPrivate = await state.library.execute({
      action: "read",
      skillId: first.after.skill.skillId,
    });
    expect(retainedPrivate.skill).toMatchObject({
      skillId: first.after.skill.skillId,
      name: privateName,
      description: source.description,
      scope: { kind: "expert", expertId: expert.id },
    });
    const retainedText = await packageFile(
      state,
      retainedPrivate.skill!.packageId,
      retainedPrivate.skill!.entryPath,
    );
    expect(retainedText.toString("utf8")).toContain(`name: ${privateName}`);
    expect(retainedText.toString("utf8")).toContain("alpha original");
    expect(retainedText.toString("utf8")).not.toContain("alpha C1");
    expect(
      await packageFile(state, retainedPrivate.skill!.packageId, "resources/data.bin"),
    ).toEqual(support);
    expect(await readSkillDefinition(state.stateDir, source.skillId)).toEqual(source);
    expect(await state.packages.read(source.packageId)).toEqual(sourcePackage);

    const expertAfterRevert = (await state.experts.read(expert.id))!;
    const c3 = await state.prepared.commit(
      {
        operationId: "derived-inverse-baseline-c3",
        expertId: expert.id,
        expectedExpertRevision: expertAfterRevert.revision,
        targetSkillId: retainedPrivate.skill!.skillId,
        expectedSkillRevision: retainedPrivate.skill!.revision,
        basePackageId: retainedPrivate.skill!.packageId,
        name: privateName,
        changes: [
          file(
            `---\nname: ${privateName}\ndescription: ${source.description}\n---\nalpha C3\nbeta original\n`,
          ),
        ],
      },
      trustedContext(),
    );
    expect(c3.status).toBe("committed");
    expect(c3.mode).toBe("update");
    expect(c3.after.skill.skillId).toBe(first.after.skill.skillId);
    expect(c3.after.skill.name).toBe(privateName);
    expect(c3.after.bindings).toEqual([privateBinding]);
    const c3Entry = await packageFile(state, c3.after.packageId, c3.after.skill.entryPath);
    expect(c3Entry.toString("utf8")).toContain("alpha C3");
    expect(c3Entry.toString("utf8")).not.toContain("alpha C1");
    const listed = await state.library.execute({ action: "list" });
    expect(
      (listed.skills ?? []).filter((skill) => skill.derivedFrom?.skillId === source.skillId),
    ).toHaveLength(1);
    expect((await state.experts.read(expert.id))?.skillBindings).toEqual([privateBinding]);
    expect(await readSkillDefinition(state.stateDir, source.skillId)).toEqual(source);
    expect(await state.packages.read(source.packageId)).toEqual(sourcePackage);
    expect(await packageFile(state, c3.after.packageId, "resources/data.bin")).toEqual(support);
  });

  it("does not unbind a newly created Skill after C2 changed it", async () => {
    const state = await fixture();
    const expert = await createExpert(state);
    const currentExpert = (await state.experts.read(expert.id))!;
    const first = await state.prepared.commit(
      {
        operationId: "create-c1",
        expertId: expert.id,
        expectedExpertRevision: currentExpert.revision,
        name: "Created learning Skill",
        description: "Keep a verified decision log.",
        changes: [file(skillBody("Created learning Skill", ["alpha C1", "beta original"]))],
      },
      trustedContext(),
    );
    expect(first.status).toBe("committed");
    expect(first.after.skill.description).toBe("Keep a verified decision log.");
    const afterCreateExpert = (await state.experts.read(expert.id))!;
    const second = await state.prepared.commit(
      {
        operationId: "create-c2",
        expertId: expert.id,
        expectedExpertRevision: afterCreateExpert.revision,
        targetSkillId: first.after.skill.skillId,
        expectedSkillRevision: first.after.skill.revision,
        basePackageId: first.after.packageId,
        changes: [file(skillBody("Created learning Skill", ["alpha C1", "beta C2"]))],
      },
      trustedContext(),
    );
    expect(second.status).toBe("committed");
    const reverted = await state.prepared.revert(
      { operationId: "create-c1-revert" },
      first,
      trustedContext(),
    );
    expect(reverted.status).toBe("conflict");
    expect(
      (await state.experts.read(expert.id))?.skillBindings?.map((binding) => binding.skillId),
    ).toContain(first.after.skill.skillId);
  });

  it("reports overlap conflicts without overwriting a later correction", async () => {
    const state = await fixture();
    const expert = await createExpert(state);
    const base = await createSkill(state, { name: "Overlap procedures", expertId: expert.id });
    await bind(
      state,
      expert,
      [{ skillId: base.skillId, enabled: true, allowEvolution: true }],
      "fixture-bind-overlap",
    );
    const currentExpert = (await state.experts.read(expert.id))!;
    const first = await state.prepared.commit(
      {
        operationId: "overlap-c1",
        expertId: expert.id,
        expectedExpertRevision: currentExpert.revision,
        targetSkillId: base.skillId,
        expectedSkillRevision: base.revision,
        basePackageId: base.packageId,
        changes: [file(skillBody("Overlap procedures", ["alpha C1", "beta original"]))],
      },
      trustedContext(),
    );
    await state.library.execute(
      {
        action: "save",
        requestId: "overlap-c2-same-region",
        skillId: base.skillId,
        expectedRevision: first.after.skill.revision,
        name: first.after.skill.name,
        tags: first.after.skill.tags,
        changes: [file(skillBody("Overlap procedures", ["alpha C2", "beta original"]))],
      },
      { actor: ownerId, retainForEvolution: true },
    );
    const reverted = await state.prepared.revert(
      { operationId: "overlap-revert" },
      first,
      trustedContext(),
    );
    expect(reverted.status).toBe("conflict");
    const current = await state.library.execute({ action: "read", skillId: base.skillId });
    const currentText = await packageFile(state, current.skill!.packageId, "SKILL.md");
    expect(currentText.toString("utf8")).toContain("alpha C2");
  });

  it.each(["create", "derive", "update"] as const)(
    "replays the exact prepared %s mutation after its durable response is lost",
    async (mode) => {
      const state = await fixture();
      const expert = await createExpert(state);
      let target: Awaited<ReturnType<typeof createSkill>> | undefined;
      if (mode !== "create") {
        target = await createSkill(state, {
          name: `Prepared ${mode}`,
          ...(mode === "update" ? { expertId: expert.id } : {}),
        });
        const currentExpert = (await state.experts.read(expert.id))!;
        await bind(
          state,
          currentExpert,
          [{ skillId: target.skillId, enabled: true, allowEvolution: true }],
          `fixture-bind-prepared-${mode}`,
        );
      }
      const currentExpert = (await state.experts.read(expert.id))!;
      const request = {
        operationId: `prepared-lost-response-${mode}`,
        expertId: expert.id,
        expectedExpertRevision: currentExpert.revision,
        ...(target
          ? {
              targetSkillId: target.skillId,
              expectedSkillRevision: target.revision,
              basePackageId: target.packageId,
              ...(mode === "derive" ? { name: "Prepared derive private" } : {}),
            }
          : { name: "Prepared create" }),
        changes: [
          file(
            skillBody(mode === "create" ? "Prepared create" : `Prepared ${mode}`, [
              "alpha recovered",
              "beta original",
            ]),
          ),
        ],
      } as const;
      let preparedIntent: PreparedSkillChangeIntent | undefined;
      let writtenSkillId: string | undefined;
      let writtenPackageId: string | undefined;
      let failAfterWrite = true;
      const originalExecute = state.library.execute.bind(state.library);
      const execute = vi.spyOn(state.library, "execute");
      execute.mockImplementation((async (libraryRequest, libraryContext) => {
        const response = await originalExecute(libraryRequest, libraryContext);
        const preparedRequest =
          preparedIntent?.kind === "commit" ? preparedIntent.mutation.request : undefined;
        if (
          failAfterWrite &&
          preparedRequest &&
          "requestId" in libraryRequest &&
          libraryRequest.requestId === preparedRequest.requestId
        ) {
          failAfterWrite = false;
          writtenSkillId = response.skill?.skillId;
          writtenPackageId = response.skill?.packageId;
          throw new Error("Simulated lost Library response after durable write.");
        }
        return response;
      }) as typeof state.library.execute);

      const context = {
        ...trustedContext(),
        onPrepared: async (intent: PreparedSkillChangeIntent) => {
          preparedIntent = intent;
        },
      };
      await expect(state.prepared.commit(request, context)).rejects.toThrow(
        /lost Library response/u,
      );
      expect(preparedIntent?.kind).toBe("commit");
      const retry = await state.prepared.commit(
        request,
        trustedContext(),
        undefined,
        preparedIntent,
      );
      expect(retry.status).toBe("committed");
      expect(retry.after.skill.skillId).toBe(writtenSkillId);
      expect(retry.after.packageId).toBe(writtenPackageId);
      expect(retry.after.bindings.map((binding) => binding.skillId)).toEqual([
        retry.after.skill.skillId,
      ]);
      if (mode === "update") expect(retry.after.skill.skillId).toBe(target?.skillId);
      if (mode === "derive") {
        expect(retry.after.skill.skillId).not.toBe(target?.skillId);
        expect(await readSkillDefinition(state.stateDir, target!.skillId)).toEqual(target);
      }
    },
  );

  it("replays a completed binding request after the outer commit receipt is lost", async () => {
    const state = await fixture();
    const expert = await createExpert(state);
    const source = await createSkill(state, { name: "Lost binding source" });
    await bind(
      state,
      expert,
      [
        {
          skillId: source.skillId,
          enabled: false,
          allowEvolution: true,
          selectionScope: "package",
        },
      ],
      "fixture-bind-lost-binding",
    );
    const currentExpert = (await state.experts.read(expert.id))!;
    const request = {
      operationId: "lost-binding-response",
      expertId: expert.id,
      expectedExpertRevision: currentExpert.revision,
      targetSkillId: source.skillId,
      expectedSkillRevision: source.revision,
      basePackageId: source.packageId,
      name: "Lost binding private",
      changes: [file(skillBody("Lost binding source", ["alpha fixed", "beta original"]))],
    } as const;
    let preparedIntent: PreparedSkillChangeIntent | undefined;
    let bindingSavedRevision: number | undefined;
    let loseBindingResponse = true;
    const originalExecute = state.library.execute.bind(state.library);
    const execute = vi.spyOn(state.library, "execute");
    execute.mockImplementation((async (libraryRequest, libraryContext) => {
      const response = await originalExecute(libraryRequest, libraryContext);
      if (
        loseBindingResponse &&
        libraryRequest.action === "bindings" &&
        libraryRequest.operation === "set" &&
        libraryRequest.expertId === expert.id
      ) {
        loseBindingResponse = false;
        bindingSavedRevision = response.bindingResult?.revision;
        throw new Error("Simulated lost binding response after durable write.");
      }
      return response;
    }) as typeof state.library.execute);
    const context = {
      ...trustedContext(),
      onPrepared: async (intent: PreparedSkillChangeIntent) => {
        preparedIntent = intent;
      },
    };
    const first = await state.prepared.commit(request, context);
    expect(first.status).toBe("committed");
    const revisionAfterFirst = (await state.experts.read(expert.id))!.revision;
    expect(revisionAfterFirst).toBe(bindingSavedRevision);
    const retry = await state.prepared.commit(request, trustedContext(), undefined, preparedIntent);
    expect(retry.after.skill.skillId).toBe(first.after.skill.skillId);
    expect((await state.experts.read(expert.id))!.revision).toBe(revisionAfterFirst);
    expect((await state.experts.read(expert.id))?.skillBindings).toEqual(first.after.bindings);
  });

  it("keeps an external revision when a prepared commit resumes after a conflict", async () => {
    const state = await fixture();
    const expert = await createExpert(state);
    const base = await createSkill(state, {
      name: "External revision target",
      expertId: expert.id,
    });
    await bind(
      state,
      expert,
      [{ skillId: base.skillId, enabled: true, allowEvolution: true }],
      "fixture-bind-external-revision",
    );
    const currentExpert = (await state.experts.read(expert.id))!;
    const request = {
      operationId: "external-revision-retry",
      expertId: expert.id,
      expectedExpertRevision: currentExpert.revision,
      targetSkillId: base.skillId,
      expectedSkillRevision: base.revision,
      basePackageId: base.packageId,
      changes: [file(skillBody("External revision target", ["alpha model", "beta original"]))],
    } as const;
    let preparedIntent: PreparedSkillChangeIntent | undefined;
    const context = {
      ...trustedContext(),
      onPrepared: async (intent: PreparedSkillChangeIntent) => {
        preparedIntent = intent;
        await state.library.execute(
          {
            action: "save",
            requestId: "external-revision-c2",
            skillId: base.skillId,
            expectedRevision: base.revision,
            name: base.name,
            tags: base.tags,
            changes: [
              file(skillBody("External revision target", ["alpha external", "beta original"])),
            ],
          },
          { actor: ownerId, retainForEvolution: true },
        );
      },
    };
    await expect(state.prepared.commit(request, context)).rejects.toThrow(/revision changed/u);
    await expect(
      state.prepared.commit(request, trustedContext(), undefined, preparedIntent),
    ).rejects.toThrow(/revision changed/u);
    const current = await state.library.execute({ action: "read", skillId: base.skillId });
    expect(
      (await packageFile(state, current.skill!.packageId, "SKILL.md")).toString("utf8"),
    ).toContain("alpha external");
  });

  it.each(["unbind", "read-only"] as const)(
    "refuses a prepared commit after the live target permission is revoked by %s",
    async (revocation) => {
      const state = await fixture();
      const expert = await createExpert(state);
      const base = await createSkill(state, {
        name: `Revoked commit ${revocation}`,
        expertId: expert.id,
      });
      await bind(
        state,
        expert,
        [{ skillId: base.skillId, enabled: true, allowEvolution: true }],
        `fixture-bind-revoked-commit-${revocation}`,
      );
      const currentExpert = (await state.experts.read(expert.id))!;
      const request = {
        operationId: `revoked-commit-${revocation}`,
        expertId: expert.id,
        expectedExpertRevision: currentExpert.revision,
        targetSkillId: base.skillId,
        expectedSkillRevision: base.revision,
        basePackageId: base.packageId,
        changes: [file(skillBody(base.name, ["alpha must stay original", "beta original"]))],
      } as const;
      let preparedIntent: PreparedSkillChangeIntent | undefined;
      let beforeMutationCalls = 0;
      const context = {
        ...trustedContext(),
        onPrepared: async (intent: PreparedSkillChangeIntent) => {
          preparedIntent = intent;
        },
        beforeMutation: async () => {
          beforeMutationCalls += 1;
          if (beforeMutationCalls === 2)
            throw new Error("Simulated interruption after staging the intent.");
        },
      };
      await expect(state.prepared.commit(request, context)).rejects.toThrow(/interruption/u);
      if (!preparedIntent) throw new Error("The commit intent was not staged.");
      const beforeRevocation = (await state.experts.read(expert.id))!;
      await bind(
        state,
        beforeRevocation,
        revocation === "unbind"
          ? []
          : [{ skillId: base.skillId, enabled: true, allowEvolution: false }],
        `revoke-commit-${revocation}`,
      );
      const expertRevisionAfterRevocation = (await state.experts.read(expert.id))!.revision;
      await expect(
        state.prepared.commit(request, trustedContext(), undefined, preparedIntent),
      ).rejects.toThrow(revocation === "unbind" ? /no longer bound/u : /read-only/u);
      expect((await state.experts.read(expert.id))!.revision).toBe(expertRevisionAfterRevocation);
      expect(await readSkillDefinition(state.stateDir, base.skillId)).toEqual(base);
    },
  );

  it.each(["unbind", "read-only"] as const)(
    "refuses an unexecuted inverse intent after the live target permission is revoked by %s",
    async (revocation) => {
      const state = await fixture();
      const expert = await createExpert(state);
      const base = await createSkill(state, {
        name: `Revoked inverse ${revocation}`,
        expertId: expert.id,
      });
      await bind(
        state,
        expert,
        [{ skillId: base.skillId, enabled: true, allowEvolution: true }],
        `fixture-bind-revoked-inverse-${revocation}`,
      );
      const currentExpert = (await state.experts.read(expert.id))!;
      const committed = await state.prepared.commit(
        {
          operationId: `revoked-inverse-c1-${revocation}`,
          expertId: expert.id,
          expectedExpertRevision: currentExpert.revision,
          targetSkillId: base.skillId,
          expectedSkillRevision: base.revision,
          basePackageId: base.packageId,
          changes: [file(skillBody(base.name, ["alpha C1", "beta original"]))],
        },
        trustedContext(),
      );
      let preparedIntent: PreparedSkillChangeIntent | undefined;
      let beforeMutationCalls = 0;
      const revertRequest = { operationId: `revoked-inverse-revert-${revocation}` } as const;
      const context = {
        ...trustedContext(),
        onPrepared: async (intent: PreparedSkillChangeIntent) => {
          preparedIntent = intent;
        },
        beforeMutation: async () => {
          beforeMutationCalls += 1;
          if (beforeMutationCalls === 2)
            throw new Error("Simulated interruption after staging the inverse.");
        },
      };
      await expect(state.prepared.revert(revertRequest, committed, context)).rejects.toThrow(
        /interruption/u,
      );
      if (!preparedIntent) throw new Error("The inverse intent was not staged.");
      const beforeRevocation = (await state.experts.read(expert.id))!;
      await bind(
        state,
        beforeRevocation,
        revocation === "unbind"
          ? []
          : [{ skillId: base.skillId, enabled: true, allowEvolution: false }],
        `revoke-inverse-${revocation}`,
      );
      const expertRevisionAfterRevocation = (await state.experts.read(expert.id))!.revision;
      const retryRequest = { ...revertRequest, resumeIntent: preparedIntent } as const;
      if (revocation === "unbind") {
        const retry = await state.prepared.revert(retryRequest, committed, trustedContext());
        expect(retry.status).toBe("conflict");
      } else {
        await expect(
          state.prepared.revert(retryRequest, committed, trustedContext()),
        ).rejects.toThrow(/read-only/u);
      }
      expect((await state.experts.read(expert.id))!.revision).toBe(expertRevisionAfterRevocation);
      expect(await readSkillDefinition(state.stateDir, base.skillId)).toEqual(
        committed.after.skill,
      );
    },
  );

  it("restores a completed commit receipt after unbinding without writing or rebinding", async () => {
    const state = await fixture();
    const expert = await createExpert(state);
    const base = await createSkill(state, { name: "Read-only receipt", expertId: expert.id });
    await bind(
      state,
      expert,
      [{ skillId: base.skillId, enabled: true, allowEvolution: true }],
      "fixture-bind-read-only-receipt",
    );
    const currentExpert = (await state.experts.read(expert.id))!;
    const request = {
      operationId: "read-only-commit-receipt",
      expertId: expert.id,
      expectedExpertRevision: currentExpert.revision,
      targetSkillId: base.skillId,
      expectedSkillRevision: base.revision,
      basePackageId: base.packageId,
      changes: [file(skillBody(base.name, ["alpha committed", "beta original"]))],
    } as const;
    let preparedIntent: PreparedSkillChangeIntent | undefined;
    const committed = await state.prepared.commit(request, {
      ...trustedContext(),
      onPrepared: async (intent) => {
        preparedIntent = intent;
      },
    });
    if (!preparedIntent) throw new Error("The commit intent was not staged.");
    const afterCommitExpert = (await state.experts.read(expert.id))!;
    await bind(state, afterCommitExpert, [], "owner-unbind-after-commit");
    const revisionAfterUnbind = (await state.experts.read(expert.id))!.revision;
    const replay = await state.prepared.commit(
      request,
      trustedContext(),
      undefined,
      preparedIntent,
    );
    expect(replay.after.skill.skillId).toBe(committed.after.skill.skillId);
    expect((await state.experts.read(expert.id))!.revision).toBe(revisionAfterUnbind);
    expect((await state.experts.read(expert.id))?.skillBindings).toEqual([]);
  });

  it("restores a completed inverse receipt after unbinding without a new inverse write", async () => {
    const state = await fixture();
    const expert = await createExpert(state);
    const base = await createSkill(state, {
      name: "Read-only inverse receipt",
      expertId: expert.id,
    });
    await bind(
      state,
      expert,
      [{ skillId: base.skillId, enabled: true, allowEvolution: true }],
      "fixture-bind-read-only-inverse-receipt",
    );
    const currentExpert = (await state.experts.read(expert.id))!;
    const committed = await state.prepared.commit(
      {
        operationId: "read-only-inverse-c1",
        expertId: expert.id,
        expectedExpertRevision: currentExpert.revision,
        targetSkillId: base.skillId,
        expectedSkillRevision: base.revision,
        basePackageId: base.packageId,
        changes: [file(skillBody(base.name, ["alpha C1", "beta original"]))],
      },
      trustedContext(),
    );
    let preparedIntent: PreparedSkillChangeIntent | undefined;
    const revertRequest = { operationId: "read-only-inverse-revert" } as const;
    const reverted = await state.prepared.revert(revertRequest, committed, {
      ...trustedContext(),
      onPrepared: async (intent) => {
        preparedIntent = intent;
      },
    });
    if (!preparedIntent) throw new Error("The inverse intent was not staged.");
    const afterRevertExpert = (await state.experts.read(expert.id))!;
    await bind(state, afterRevertExpert, [], "owner-unbind-after-revert");
    const revisionAfterUnbind = (await state.experts.read(expert.id))!.revision;
    const replay = await state.prepared.revert(
      { ...revertRequest, resumeIntent: preparedIntent },
      committed,
      trustedContext(),
    );
    expect(replay.status).toBe("committed");
    if (replay.status !== "committed" || reverted.status !== "committed")
      throw new Error("The inverse receipt was not committed.");
    expect(replay.skill?.skillId).toBe(reverted.skill?.skillId);
    expect((await state.experts.read(expert.id))!.revision).toBe(revisionAfterUnbind);
    expect((await state.experts.read(expert.id))?.skillBindings).toEqual([]);
  });

  it("recovers an inverse save whose durable response was lost", async () => {
    const state = await fixture();
    const expert = await createExpert(state);
    const base = await createSkill(state, { name: "Lost inverse target", expertId: expert.id });
    await bind(
      state,
      expert,
      [{ skillId: base.skillId, enabled: true, allowEvolution: true }],
      "fixture-bind-lost-inverse",
    );
    const currentExpert = (await state.experts.read(expert.id))!;
    const first = await state.prepared.commit(
      {
        operationId: "lost-inverse-c1",
        expertId: expert.id,
        expectedExpertRevision: currentExpert.revision,
        targetSkillId: base.skillId,
        expectedSkillRevision: base.revision,
        basePackageId: base.packageId,
        changes: [file(skillBody("Lost inverse target", ["alpha C1", "beta original"]))],
      },
      trustedContext(),
    );
    let preparedIntent: PreparedSkillChangeIntent | undefined;
    let lostInverseResponse = true;
    const originalExecute = state.library.execute.bind(state.library);
    const execute = vi.spyOn(state.library, "execute");
    execute.mockImplementation((async (libraryRequest, libraryContext) => {
      const response = await originalExecute(libraryRequest, libraryContext);
      if (
        lostInverseResponse &&
        libraryRequest.action === "save" &&
        preparedIntent?.kind === "revert" &&
        preparedIntent.mutations[0]?.request.action === "save" &&
        libraryRequest.requestId === preparedIntent.mutations[0].request.requestId
      ) {
        lostInverseResponse = false;
        throw new Error("Simulated lost inverse response after durable write.");
      }
      return response;
    }) as typeof state.library.execute);
    const revertRequest = { operationId: "lost-inverse-revert" } as const;
    const context = {
      ...trustedContext(),
      onPrepared: async (intent: PreparedSkillChangeIntent) => {
        preparedIntent = intent;
      },
    };
    await expect(state.prepared.revert(revertRequest, first, context)).rejects.toThrow(
      /lost inverse response/u,
    );
    expect(preparedIntent?.kind).toBe("revert");
    if (!preparedIntent) throw new Error("The inverse intent was not prepared.");
    const retry = await state.prepared.revert(
      { ...revertRequest, resumeIntent: preparedIntent },
      first,
      trustedContext(),
    );
    expect(retry.status).toBe("committed");
    const current = await state.library.execute({ action: "read", skillId: base.skillId });
    expect(
      (await packageFile(state, current.skill!.packageId, "SKILL.md")).toString("utf8"),
    ).toContain("alpha original");
  });

  it("does not repeat a completed create undo after a later rebind", async () => {
    const state = await fixture();
    const expert = await createExpert(state);
    const currentExpert = (await state.experts.read(expert.id))!;
    const created = await state.prepared.commit(
      {
        operationId: "create-rebind-c1",
        expertId: expert.id,
        expectedExpertRevision: currentExpert.revision,
        name: "Created then rebound",
        changes: [file(skillBody("Created then rebound", ["alpha C1", "beta original"]))],
      },
      trustedContext(),
    );
    let preparedIntent: PreparedSkillChangeIntent | undefined;
    let loseUnbindResponse = true;
    const originalExecute = state.library.execute.bind(state.library);
    const execute = vi.spyOn(state.library, "execute");
    execute.mockImplementation((async (libraryRequest, libraryContext) => {
      const response = await originalExecute(libraryRequest, libraryContext);
      if (
        loseUnbindResponse &&
        libraryRequest.action === "bindings" &&
        libraryRequest.operation === "set" &&
        libraryRequest.requestId?.startsWith("learning-skill:revert-bind:")
      ) {
        loseUnbindResponse = false;
        throw new Error("Simulated lost create undo response.");
      }
      return response;
    }) as typeof state.library.execute);
    const revertRequest = { operationId: "create-rebind-revert" } as const;
    const context = {
      ...trustedContext(),
      onPrepared: async (intent: PreparedSkillChangeIntent) => {
        preparedIntent = intent;
      },
    };
    await expect(state.prepared.revert(revertRequest, created, context)).rejects.toThrow(
      /lost create undo response/u,
    );
    expect(preparedIntent?.kind).toBe("revert");
    if (!preparedIntent) throw new Error("The create undo intent was not prepared.");

    const afterUndo = (await state.experts.read(expert.id))!;
    await bind(
      state,
      afterUndo,
      [{ skillId: created.after.skill.skillId, enabled: true, allowEvolution: true }],
      "independent-rebind-after-undo",
    );
    const revisionAfterRebind = (await state.experts.read(expert.id))!.revision;
    const retry = await state.prepared.revert(
      { ...revertRequest, resumeIntent: preparedIntent },
      created,
      trustedContext(),
    );
    expect(retry.status).toBe("conflict");
    expect((await state.experts.read(expert.id))!.revision).toBe(revisionAfterRebind);
    expect((await state.experts.read(expert.id))?.skillBindings).toEqual([
      { skillId: created.after.skill.skillId, enabled: true, allowEvolution: true },
    ]);
  });

  it("conflicts when a later edit changes a numeric value by extending the after-text", async () => {
    const state = await fixture();
    const expert = await createExpert(state);
    const base = await createSkill(state, {
      name: "Numeric inverse target",
      expertId: expert.id,
      body: skillBody("Numeric inverse target", ["steps: 10", "beta original"]),
    });
    await bind(
      state,
      expert,
      [{ skillId: base.skillId, enabled: true, allowEvolution: true }],
      "fixture-bind-numeric-inverse",
    );
    const currentExpert = (await state.experts.read(expert.id))!;
    const first = await state.prepared.commit(
      {
        operationId: "numeric-inverse-c1",
        expertId: expert.id,
        expectedExpertRevision: currentExpert.revision,
        targetSkillId: base.skillId,
        expectedSkillRevision: base.revision,
        basePackageId: base.packageId,
        changes: [file(skillBody("Numeric inverse target", ["steps: 20", "beta original"]))],
      },
      trustedContext(),
    );
    await state.library.execute(
      {
        action: "save",
        requestId: "numeric-inverse-c2",
        skillId: base.skillId,
        expectedRevision: first.after.skill.revision,
        name: first.after.skill.name,
        tags: first.after.skill.tags,
        changes: [file(skillBody("Numeric inverse target", ["steps: 200", "beta original"]))],
      },
      { actor: ownerId, retainForEvolution: true },
    );
    const reverted = await state.prepared.revert(
      { operationId: "numeric-inverse-revert" },
      first,
      trustedContext(),
    );
    expect(reverted.status).toBe("conflict");
    const current = await state.library.execute({ action: "read", skillId: base.skillId });
    expect(
      (await packageFile(state, current.skill!.packageId, "SKILL.md")).toString("utf8"),
    ).toContain("steps: 200");
  });

  it("conflicts instead of choosing one of two complete after-lines", async () => {
    const state = await fixture();
    const expert = await createExpert(state);
    const base = await createSkill(state, { name: "Repeated inverse target", expertId: expert.id });
    await bind(
      state,
      expert,
      [{ skillId: base.skillId, enabled: true, allowEvolution: true }],
      "fixture-bind-repeated-inverse",
    );
    const currentExpert = (await state.experts.read(expert.id))!;
    const first = await state.prepared.commit(
      {
        operationId: "repeated-inverse-c1",
        expertId: expert.id,
        expectedExpertRevision: currentExpert.revision,
        targetSkillId: base.skillId,
        expectedSkillRevision: base.revision,
        basePackageId: base.packageId,
        changes: [file(skillBody("Repeated inverse target", ["alpha C1", "beta original"]))],
      },
      trustedContext(),
    );
    await state.library.execute(
      {
        action: "save",
        requestId: "repeated-inverse-c2",
        skillId: base.skillId,
        expectedRevision: first.after.skill.revision,
        name: first.after.skill.name,
        tags: first.after.skill.tags,
        changes: [
          file(skillBody("Repeated inverse target", ["alpha C1", "alpha C1", "beta original"])),
        ],
      },
      { actor: ownerId, retainForEvolution: true },
    );
    const reverted = await state.prepared.revert(
      { operationId: "repeated-inverse-revert" },
      first,
      trustedContext(),
    );
    expect(reverted.status).toBe("conflict");
    const current = await state.library.execute({ action: "read", skillId: base.skillId });
    expect(
      (await packageFile(state, current.skill!.packageId, "SKILL.md")).toString("utf8"),
    ).toContain("alpha C1\nalpha C1");
  });

  it("carries current bytes when reverting a mode-only change after C2 edited the file", async () => {
    const state = await fixture();
    const expert = await createExpert(state);
    const scriptBytes = Buffer.from("#!/bin/sh\nprintf 'original'\n", "utf8");
    const base = await createSkill(state, {
      name: "Mode inverse target",
      expertId: expert.id,
      extraFiles: [
        { path: "scripts/check.sh", content: scriptBytes.toString("base64"), executable: false },
      ],
    });
    await bind(
      state,
      expert,
      [{ skillId: base.skillId, enabled: true, allowEvolution: true }],
      "fixture-bind-mode-inverse",
    );
    const currentExpert = (await state.experts.read(expert.id))!;
    const first = await state.prepared.commit(
      {
        operationId: "mode-inverse-c1",
        expertId: expert.id,
        expectedExpertRevision: currentExpert.revision,
        targetSkillId: base.skillId,
        expectedSkillRevision: base.revision,
        basePackageId: base.packageId,
        changes: [
          {
            path: "scripts/check.sh",
            content: scriptBytes.toString("base64"),
            executable: true,
          },
        ],
      },
      trustedContext(),
    );
    await state.library.execute(
      {
        action: "save",
        requestId: "mode-inverse-c2",
        skillId: base.skillId,
        expectedRevision: first.after.skill.revision,
        name: first.after.skill.name,
        tags: first.after.skill.tags,
        changes: [file(skillBody("Mode inverse target", ["alpha C2", "beta original"]))],
      },
      { actor: ownerId, retainForEvolution: true },
    );
    const reverted = await state.prepared.revert(
      { operationId: "mode-inverse-revert" },
      first,
      trustedContext(),
    );
    expect(reverted.status).toBe("committed");
    const current = await state.library.execute({ action: "read", skillId: base.skillId });
    expect(await packageFile(state, current.skill!.packageId, "scripts/check.sh")).toEqual(
      scriptBytes,
    );
    expect(
      (await state.packages.read(current.skill!.packageId)).resources.find(
        (resource) => resource.path === "content/scripts/check.sh",
      )?.executable,
    ).toBe(false);
    expect(
      (await packageFile(state, current.skill!.packageId, "SKILL.md")).toString("utf8"),
    ).toContain("alpha C2");
  });
});
