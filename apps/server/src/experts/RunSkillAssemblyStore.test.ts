import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSkillLibraryStore } from "./SkillLibraryStore";
import { createExpertStore, expertResourceFiles } from "./ExpertStore";
import {
  createRunSkillAssemblyStore,
  listRunSkillAssemblies,
  skillAssemblyFingerprint,
} from "./RunSkillAssemblyStore";
import { skillRuntimeEntries } from "./skillRunResources";
import { scanSkillPackageReferences } from "./skillPackageReferences";

const roots: string[] = [];
const body = "---\nname: alpha\ndescription: Assembly fixture\n---\nVersion one.\n";
afterEach(async () => {
  for (const root of roots.splice(0)) await expertResourceFiles.removeStaging(root);
});
async function fixture(skillBody = body) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-run-skills-"));
  roots.push(root);
  const stateDir = path.join(root, "state");
  const library = createSkillLibraryStore(stateDir);
  const skill = (
    await library.execute({ action: "create", name: "alpha", body: skillBody, tags: [] })
  ).skill!;
  const experts = createExpertStore(stateDir);
  const expert = await experts.save({
    name: "Run owner",
    description: "",
    useCases: "",
    persona: "Fixed persona",
    outputRequirements: "",
    skills: [],
    references: [],
    connections: [],
    skillBindings: [{ skillId: skill.skillId, enabled: true }],
  });
  const binding = await experts.prepareSnapshot(expert.id);
  const store = createRunSkillAssemblyStore(stateDir);
  const prepare = (rootRunId: string, continuationKey?: string, inheritContinuation?: boolean) =>
    store.prepare({
      threadId: "thread-fixture",
      rootRunId,
      baseSnapshotId: binding.snapshotId,
      createdAt: "2026-10-26T10:00:00.000Z",
      ...(continuationKey ? { continuationKey } : {}),
      ...(inheritContinuation ? { inheritContinuation } : {}),
    });
  return { stateDir, library, experts, expert, skill, binding, store, prepare };
}

describe("per-run Skill assemblies", () => {
  it("keeps historical parsed metadata and policy through recovery and continuation", async () => {
    const f = await fixture();
    const first = await f.prepare("historical-run", "historical-work");
    const historicalSession = {
      ...first.session,
      skillPolicy: {
        version: 1 as const,
        discovery: "fixed" as const,
        nativeSubagents: "blocked" as const,
      },
      skillEntries: first.session.skillEntries!.map((entry) => ({
        ...entry,
        name: "historical-parser-name",
        description: "Description produced by an older parser.",
      })),
      skills: first.session.skills.map((entry) => ({ ...entry, name: "historical-parser-name" })),
    };
    const assemblyId = skillAssemblyFingerprint(historicalSession);
    const session = { ...historicalSession, skillAssemblyId: assemblyId };
    const file = path.join(
      f.stateDir,
      "experts",
      "run-skill-assemblies",
      createHash("sha256").update(first.rootRunId).digest("hex") + ".json",
    );
    await fs.writeFile(file, JSON.stringify({ ...first, assemblyId, session }));
    await expect(f.store.verifySession(session)).resolves.toEqual(session);
    const continued = await f.prepare("continued-historical", "historical-work", true);
    expect(continued.session.skillPolicy).toEqual(session.skillPolicy);
    expect(continued.session.skillEntries).toEqual(session.skillEntries);
    await expect(f.store.verifySession(continued.session)).resolves.toEqual(continued.session);
    const latest = await f.prepare("independent-after-history");
    expect(latest.session.skillPolicy?.version).toBe(2);
    expect(latest.session.skillEntries?.[0]?.name).toBe("alpha");
  });

  it("persists a true private copy across restart and cross-Worker continuation", async () => {
    const f = await fixture();
    await f.experts.save({
      ...f.expert,
      expectedRevision: f.expert.revision,
      skillBindings: [
        {
          skillId: f.skill.skillId,
          enabled: true,
          resourceMode: "run-private",
        },
      ],
    });
    const first = await f.prepare("private-first", "private-work");
    const reference = first.session.skillResourceRefs![0]!;
    const source = first.session.skillEntries![0]!.path;
    const working = skillRuntimeEntries(first.session)[0]!.path;
    expect(working).toBe(path.join(reference.rootPath, "SKILL.md"));
    const [originalStat, workingStat] = await Promise.all([fs.stat(source), fs.stat(working)]);
    expect(workingStat.ino).not.toBe(originalStat.ino);
    await fs.writeFile(path.join(reference.rootPath, "generated.txt"), "Keep this output.");
    const reopened = createRunSkillAssemblyStore(f.stateDir);
    await expect(reopened.verifySession(first.session)).resolves.toEqual(first.session);
    const continued = await reopened.prepare({
      threadId: "replacement-worker",
      rootRunId: "replacement-worker-run",
      baseSnapshotId: f.binding.snapshotId,
      continuationKey: "private-work",
      inheritContinuation: true,
      createdAt: first.createdAt,
    });
    expect(continued.session.skillResourceRefs).toEqual(first.session.skillResourceRefs);
    expect(continued.session.skillResourceRefs![0]!.ownerRootRunId).toBe("private-first");
    expect(await fs.readFile(path.join(reference.rootPath, "generated.txt"), "utf8")).toBe(
      "Keep this output.",
    );
    const independent = await f.prepare("private-independent");
    expect(independent.session.skillResourceRefs![0]!.rootPath).not.toBe(reference.rootPath);
    await expect(
      fs.access(path.join(independent.session.skillResourceRefs![0]!.rootPath, "generated.txt")),
    ).rejects.toThrow();
    expect(await fs.readFile(source, "utf8")).toBe(body);
    const references = await scanSkillPackageReferences(f.stateDir, f.skill.packageId);
    expect(references.some((item) => item.includes("private-first"))).toBe(true);
    await fs.writeFile(working, body + "Unexpected edit.");
    await expect(reopened.verifySession(first.session)).rejects.toThrow("working copy drifted");
    expect(await fs.readFile(path.join(reference.rootPath, "generated.txt"), "utf8")).toBe(
      "Keep this output.",
    );
    expect(await fs.readFile(source, "utf8")).toBe(body);
  });

  it("resolves heads only at actual preparation and recovers the original run after edits", async () => {
    const f = await fixture();
    const first = await f.prepare("run-A", "goal-fixture");
    const changed = (
      await f.library.execute({
        action: "save",
        skillId: f.skill.skillId,
        expectedRevision: f.skill.revision,
        name: "alpha",
        tags: [],
        changes: [
          { path: "SKILL.md", content: Buffer.from(body + "Version two.\n").toString("base64") },
        ],
      })
    ).skill!;
    expect((await f.prepare("run-A")).assemblyId).toBe(first.assemblyId);
    const next = await f.prepare("run-B");
    expect(next.assemblyId).not.toBe(first.assemblyId);
    expect(next.session.skillEntries?.[0]?.packageId).toBe(changed.packageId);
    expect(next.session.skillEntries?.[0]?.managedSkillId).toBe(f.skill.skillId);
    expect(next.session.persona).toBe(first.session.persona);
    expect((await f.store.continuation("thread-fixture", "goal-fixture"))?.rootRunId).toBe("run-A");
    const reopened = createRunSkillAssemblyStore(f.stateDir);
    expect((await reopened.read("run-A"))?.session.skillEntries?.[0]?.packageId).toBe(
      f.skill.packageId,
    );
    expect((await reopened.current("thread-fixture"))?.rootRunId).toBe("run-B");
    await expect(reopened.verifySession(first.session)).resolves.toEqual(first.session);
  });

  it("does not apply later Persona edits and rejects a forged runtime identity", async () => {
    const f = await fixture();
    await f.experts.save({
      ...f.expert,
      expectedRevision: f.expert.revision,
      persona: "Unadopted persona",
    });
    const record = await f.prepare("run-A");
    expect(record.session.persona).toContain("Fixed persona");
    expect(record.session.persona).not.toContain("Unadopted persona");
    await expect(f.store.verifySession({ ...record.session, persona: "Forged" })).rejects.toThrow(
      "does not match",
    );
    await expect(
      f.store.prepare({
        threadId: "another",
        rootRunId: "run-A",
        baseSnapshotId: f.binding.snapshotId,
        createdAt: record.createdAt,
      }),
    ).rejects.toThrow("another task");
  });

  it("rejects a private Skill in another Expert's current Run assembly", async () => {
    const f = await fixture();
    const owner = await f.experts.save({
      name: "Private owner",
      description: "",
      useCases: "",
      persona: "Owner",
      outputRequirements: "",
      skills: [],
      references: [],
      connections: [],
    });
    const privateSkill = (
      await f.library.execute(
        {
          action: "create",
          name: "Private method",
          body,
          tags: [],
        },
        { createForExpertId: owner.id },
      )
    ).skill!;
    const other = await f.experts.save({
      name: "Other Expert",
      description: "",
      useCases: "",
      persona: "Other",
      outputRequirements: "",
      skills: [],
      references: [],
      connections: [],
    });
    const otherSnapshot = await f.experts.prepareSnapshot(other.id),
      definitionFile = path.join(f.stateDir, "experts", "definitions", `${other.id}.json`),
      stored = await f.experts.read(other.id);
    await fs.writeFile(
      definitionFile,
      JSON.stringify({
        ...stored,
        skillBindings: [{ skillId: privateSkill.skillId, enabled: true }],
      }),
    );
    await expect(f.store.preview(otherSnapshot.snapshotId)).rejects.toThrow(
      `belongs to Expert ${owner.id}`,
    );
  });

  it("does not rebuild the effective assembly for tags-only edits", async () => {
    const f = await fixture();
    const first = await f.prepare("run-A");
    await f.library.execute({
      action: "save",
      skillId: f.skill.skillId,
      expectedRevision: f.skill.revision,
      name: "alpha",
      tags: ["new-label"],
      changes: [],
    });
    const next = await f.prepare("run-B");
    expect(next.assemblyId).toBe(first.assemblyId);
    expect(next.rootRunId).not.toBe(first.rootRunId);
  });

  it("previews latest saved bindings without freezing a queued Run", async () => {
    const f = await fixture();
    const before = await f.store.preview(f.binding.snapshotId);
    expect(before.skillEntries?.[0]?.managedSkillId).toBe(f.skill.skillId);
    expect(await f.store.current("thread-fixture")).toBeUndefined();
    await f.experts.save({
      ...f.expert,
      expectedRevision: f.expert.revision,
      skillBindings: [{ skillId: f.skill.skillId, enabled: false }],
    });
    expect((await f.store.preview(f.binding.snapshotId)).skillEntries).toEqual([]);
    expect((await f.prepare("queued-later")).session.skillEntries).toEqual([]);
    expect(await listRunSkillAssemblies(f.stateDir)).toHaveLength(1);
  });

  it("keeps a managed work item fixed across a new Worker thread and retries", async () => {
    const f = await fixture();
    const first = await f.prepare("worker-attempt-1", "hub-work:fixture");
    await f.library.execute({
      action: "save",
      skillId: f.skill.skillId,
      expectedRevision: f.skill.revision,
      name: "alpha",
      tags: [],
      changes: [{ path: "SKILL.md", content: Buffer.from(body + "Later head").toString("base64") }],
    });
    const retry = await f.store.prepare({
      threadId: "new-worker-thread",
      rootRunId: "worker-attempt-2",
      baseSnapshotId: f.binding.snapshotId,
      continuationKey: "hub-work:fixture",
      inheritContinuation: true,
      createdAt: first.createdAt,
    });
    expect(retry.session.skillEntries).toEqual(first.session.skillEntries);
    expect((await f.store.current("new-worker-thread"))?.rootRunId).toBe("worker-attempt-2");
    expect((await f.prepare("independent-work", "hub-work:independent")).assemblyId).not.toBe(
      first.assemblyId,
    );
    await expect(f.store.verifySession(retry.session)).resolves.toEqual(retry.session);
  });

  it("makes failed hook initialization visibly uncertain and refuses continuation replay", async () => {
    const f = await fixture(
      "---\nname: alpha\ndescription: Assembly fixture\nhooks:\n  Setup: []\n---\nVersion one.\n",
    );
    await f.experts.save({
      ...f.expert,
      expectedRevision: f.expert.revision,
      skillBindings: [{ skillId: f.skill.skillId, enabled: true }],
    });
    const first = await f.prepare("run-A", "hub-work:uncertain");
    const attempt = await f.store.beginInitialization(first.rootRunId);
    await f.store.finishInitialization(
      first.rootRunId,
      attempt,
      new Error("Native outcome unknown"),
    );
    expect((await f.store.read(first.rootRunId))?.phase).toBe("uncertain");
    await expect(f.prepare("retry", "hub-work:uncertain", true)).rejects.toThrow("uncertain");
  });

  it("starts a new user intent at the latest head even while the same goal remains active", async () => {
    const f = await fixture();
    const first = await f.prepare("run-A", "goal-active");
    await f.library.execute({
      action: "save",
      skillId: f.skill.skillId,
      expectedRevision: f.skill.revision,
      name: "alpha",
      tags: [],
      changes: [{ path: "SKILL.md", content: Buffer.from(body + "New intent").toString("base64") }],
    });
    const next = await f.prepare("run-B", "goal-active");
    expect(next.assemblyId).not.toBe(first.assemblyId);
    expect((await f.store.continuation("thread-fixture", "goal-active"))?.rootRunId).toBe("run-B");
    expect((await f.store.read(first.rootRunId))?.assemblyId).toBe(first.assemblyId);
  });

  it("retains run references independently of current managed heads", async () => {
    const f = await fixture();
    const first = await f.prepare("run-A");
    expect(await scanSkillPackageReferences(f.stateDir, f.skill.packageId)).toContain(
      `Run run-A (${first.assemblyId})`,
    );
    expect(await listRunSkillAssemblies(f.stateDir)).toHaveLength(1);
  });

  it("records initialization before it starts and stops uncertain non-idempotent replay", async () => {
    const f = await fixture();
    const record = await f.prepare("run-A");
    const attempt = await f.store.beginInitialization(record.rootRunId);
    expect((await f.store.read("run-A"))?.phase).toBe("initializing");
    await f.store.finishInitialization("run-A", attempt);
    expect((await f.store.read("run-A"))?.phase).toBe("ready");
    await expect(f.store.finishInitialization("run-A", "forged")).rejects.toThrow(
      "attempt changed",
    );
  });

  it("blocks crash replay from legacy startup metadata without activating a Skill", async () => {
    const f = await fixture();
    const record = await f.prepare("run-A");
    expect(record.hasInitializationEffects).toBe(false);
    const legacySession = {
      ...record.session,
      skillEntries: record.session.skillEntries!.map((entry, index) =>
        index === 0 ? { ...entry, activation: "startup" as const } : entry,
      ),
    };
    const assemblyId = skillAssemblyFingerprint(legacySession);
    const session = { ...legacySession, skillAssemblyId: assemblyId };
    const recordFile = path.join(
      f.stateDir,
      "experts",
      "run-skill-assemblies",
      createHash("sha256").update(record.rootRunId).digest("hex") + ".json",
    );
    await fs.writeFile(
      recordFile,
      JSON.stringify({ ...record, assemblyId, session, hasInitializationEffects: false }),
    );
    await f.store.beginInitialization("run-A");
    expect((await f.store.read("run-A"))?.hasInitializationEffects).toBe(true);
    await expect(
      createRunSkillAssemblyStore(f.stateDir).beginInitialization("run-A"),
    ).rejects.toThrow("uncertain");
  });

  it.each(["hooks/hooks.json", ".claude-plugin/plugin.json", ".mcp.json"])(
    "does not replay uncertain initialization from native plugin resource %s",
    async (resourcePath) => {
      const f = await fixture();
      await f.library.execute({
        action: "save",
        skillId: f.skill.skillId,
        expectedRevision: f.skill.revision,
        name: f.skill.name,
        tags: [],
        changes: [
          {
            path: resourcePath,
            content: Buffer.from(
              JSON.stringify({
                hooks: {
                  SessionStart: [{ hooks: [{ type: "command", command: "synthetic command" }] }],
                },
              }),
            ).toString("base64"),
          },
        ],
      });
      const record = await f.prepare("run-native-hook", "hub-native-hooks");
      expect(record.hasInitializationEffects).toBe(true);
      await f.store.beginInitialization(record.rootRunId);
      // An earlier process may have journalled the same native resources before
      // package-level effect classification was available. Recheck before replay.
      const file = path.join(
        f.stateDir,
        "experts",
        "run-skill-assemblies",
        `${createHash("sha256").update(record.rootRunId).digest("hex")}.json`,
      );
      const stale = { ...(await f.store.read(record.rootRunId)), hasInitializationEffects: false };
      await fs.writeFile(file, JSON.stringify(stale), { mode: 0o600 });
      await expect(
        createRunSkillAssemblyStore(f.stateDir).beginInitialization(record.rootRunId),
      ).rejects.toThrow("uncertain");
      expect((await f.store.read(record.rootRunId))?.phase).toBe("uncertain");
      await fs.writeFile(file, JSON.stringify(stale), { mode: 0o600 });
      await expect(
        createRunSkillAssemblyStore(f.stateDir).prepare({
          threadId: "replacement-worker",
          rootRunId: "replacement-root",
          baseSnapshotId: f.binding.snapshotId,
          createdAt: record.createdAt,
          continuationKey: "hub-native-hooks",
          inheritContinuation: true,
        }),
      ).rejects.toThrow("uncertain");
      expect((await f.store.read(record.rootRunId))?.phase).toBe("uncertain");
      await fs.writeFile(
        file,
        JSON.stringify({
          ...stale,
          phase: "prepared",
          initializationError: "Earlier native initialization failed after an unknown effect",
        }),
        { mode: 0o600 },
      );
      await expect(
        createRunSkillAssemblyStore(f.stateDir).beginInitialization(record.rootRunId),
      ).rejects.toThrow("uncertain");
    },
  );
});
