import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createExpertStore } from "./ExpertStore.ts";
import {
  createSkillPackageSwitchService,
  type SkillPackageSwitchHost,
  type SkillPackageSwitchInventory,
} from "./SkillPackageSwitch.ts";
import { createSkillPackageStore } from "./SkillPackageStore.ts";

const temporaryRoots: string[] = [];

async function makeWritable(root: string): Promise<void> {
  const stat = await lstat(root).catch(() => null);
  if (!stat) return;
  if (stat.isDirectory()) {
    await chmod(root, 0o700);
    for (const entry of await readdir(root)) await makeWritable(path.join(root, entry));
  } else {
    await chmod(root, 0o600);
  }
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "synara-skill-switch-"));
  temporaryRoots.push(root);
  return root;
}

async function makePackage(stateDir: string, root: string, name = "Writer") {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "SKILL.md"),
    "---\nname: " + name + "\ndescription: Package backed skill.\n---\nInstructions.\n",
  );
  const packages = createSkillPackageStore(stateDir);
  const preview = await packages.preview({ path: root });
  return packages.import({ previewId: preview.previewId });
}

function makeInventory(snapshotId: string): SkillPackageSwitchInventory {
  return {
    complete: true,
    threads: [{ threadId: "test-thread-1", kind: "test", snapshotIds: [snapshotId] }],
    hubWorks: [
      {
        workId: "test-work-1",
        kind: "test",
        state: "queued",
        references: [
          { kind: "thread", id: "test-thread-1" },
          { kind: "snapshot", id: snapshotId },
        ],
      },
    ],
    snapshots: [
      {
        snapshotId,
        kind: "legacy-skill",
        references: [
          { kind: "thread", id: "test-thread-1" },
          { kind: "hub-work", id: "test-work-1" },
        ],
        projectionIds: ["legacy-projection-1"],
      },
    ],
  };
}

function makeHost(initial: SkillPackageSwitchInventory) {
  let inventory = structuredClone(initial);
  const calls: string[] = [];
  const host: SkillPackageSwitchHost = {
    readInventory: async () => structuredClone(inventory),
    stopThread: async (threadId) => {
      calls.push("stop:" + threadId);
    },
    cancelHubWork: async (workId) => {
      calls.push("cancel:" + workId);
      inventory = {
        ...inventory,
        hubWorks: inventory.hubWorks.map((work) =>
          work.workId === workId ? { ...work, state: "cancelled" } : work,
        ),
      };
    },
    deleteThread: async (threadId) => {
      calls.push("delete:" + threadId);
      inventory = {
        ...inventory,
        threads: inventory.threads.filter((thread) => thread.threadId !== threadId),
        snapshots: inventory.snapshots.map((snapshot) => ({
          ...snapshot,
          references: snapshot.references.filter(
            (reference) => !(reference.kind === "thread" && reference.id === threadId),
          ),
        })),
      };
    },
    cleanupLegacyArtifacts: async ({ snapshotIds, projectionIds }) => {
      calls.push("cleanup:" + snapshotIds.join(",") + ":" + projectionIds.join(","));
      inventory = {
        ...inventory,
        snapshots: inventory.snapshots.filter(
          (snapshot) => !snapshotIds.includes(snapshot.snapshotId),
        ),
      };
    },
  };
  return {
    host,
    calls,
    replaceInventory(next: SkillPackageSwitchInventory) {
      inventory = structuredClone(next);
    },
    currentInventory: () => inventory,
  };
}

async function makeLegacyExpert(stateDir: string) {
  const experts = createExpertStore(stateDir);
  const definition = await experts.save({
    name: "Legacy writer",
    description: "Preserved description",
    useCases: "Preserved use cases",
    persona: "Original reviewed persona",
    outputRequirements: "Preserved output requirements",
    skills: [{ name: "Old writer", path: path.join(stateDir, "old-skills", "SKILL.md") }],
    references: [path.join(stateDir, "references", "guide.md")],
    connections: [],
  });
  return { experts, definition };
}

function switchInput(
  definition: Awaited<ReturnType<typeof makeLegacyExpert>>["definition"],
  packageId: string,
  entryPath: string,
) {
  return {
    experts: [
      {
        expertId: definition.id,
        skillSelections: [{ packageId, entryPath, activation: "startup" as const }],
        personaPatch: {
          reviewed: true as const,
          before: definition.persona,
          after: "Reviewed package persona without the legacy bridge.",
        },
      },
    ],
    allowlistedThreadIds: ["test-thread-1"],
    allowlistedSnapshotIds: ["exp_" + "a".repeat(64)],
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await makeWritable(root);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("SkillPackageSwitch", () => {
  it("backs up managed Expert state, preserves non-skill fields, and cleans only after host readback", async () => {
    const root = await makeRoot();
    const stateDir = path.join(root, "state");
    const { experts, definition } = await makeLegacyExpert(stateDir);
    const imported = await makePackage(stateDir, path.join(root, "source", "writer"));
    const inventory = makeHost(makeInventory("exp_" + "a".repeat(64)));
    const service = createSkillPackageSwitchService({
      stateDir,
      experts,
      packages: createSkillPackageStore(stateDir),
      host: inventory.host,
    });
    const preview = await service.preview(
      switchInput(definition, imported.package.packageId, imported.package.entries[0]!.entryPath),
    );
    expect(preview.plan.snapshotIds).toEqual(["exp_" + "a".repeat(64)]);
    expect(preview.plan.hubWorkIds).toEqual(["test-work-1"]);
    expect(preview.plan.hubWorkTargets[0]?.references).toEqual([
      { kind: "snapshot", id: "exp_" + "a".repeat(64) },
      { kind: "thread", id: "test-thread-1" },
    ]);
    expect(preview.plan.experts[0]).toMatchObject({
      personaBefore: definition.persona,
      targetPersona: "Reviewed package persona without the legacy bridge.",
    });

    await service.apply({ switchId: preview.switchId, digest: preview.digest });

    const current = await experts.read(definition.id);
    expect(current).toMatchObject({
      id: definition.id,
      revision: definition.revision + 1,
      name: definition.name,
      description: definition.description,
      useCases: definition.useCases,
      persona: "Reviewed package persona without the legacy bridge.",
      outputRequirements: definition.outputRequirements,
      skills: [],
      skillSelections: [
        {
          packageId: imported.package.packageId,
          entryPath: imported.package.entries[0]!.entryPath,
          activation: "startup",
        },
      ],
      references: definition.references,
      connections: definition.connections,
    });
    const progress = await service.readProgress(preview.switchId);
    expect(progress.status).toBe("complete_with_retained_artifacts");
    expect(progress.cleaned).toBe(true);
    expect(progress.retainedSnapshotIds).toEqual(["exp_" + "a".repeat(64)]);
    expect(inventory.calls).toEqual([
      "stop:test-thread-1",
      "cancel:test-work-1",
      "delete:test-thread-1",
      "cleanup::",
    ]);
    const backedUpDefinition = JSON.parse(
      await readFile(
        path.join(progress.backupPath, "definitions", definition.id + ".json"),
        "utf8",
      ),
    ) as { revision: number; skills: unknown[] };
    expect(backedUpDefinition).toMatchObject({
      revision: definition.revision,
      skills: definition.skills,
    });
    await expect(
      readFile(
        path.join(
          progress.backupPath,
          "skill-packages",
          imported.package.packageId,
          "package.json",
        ),
      ),
    ).resolves.toBeTruthy();
  });

  it("blocks ordinary and unlisted references in authoritative host inventory", async () => {
    const root = await makeRoot();
    const stateDir = path.join(root, "state");
    const { experts, definition } = await makeLegacyExpert(stateDir);
    const imported = await makePackage(stateDir, path.join(root, "source", "writer"));
    const baseInventory = makeInventory("exp_" + "a".repeat(64));
    const ordinaryReference: SkillPackageSwitchInventory = {
      ...baseInventory,
      threads: [
        ...baseInventory.threads,
        {
          threadId: "ordinary-thread",
          kind: "ordinary",
          snapshotIds: ["exp_" + "a".repeat(64)],
        },
      ],
    };
    const host = makeHost(ordinaryReference);
    const service = createSkillPackageSwitchService({
      stateDir,
      experts,
      packages: createSkillPackageStore(stateDir),
      host: host.host,
    });

    await expect(
      service.preview(
        switchInput(definition, imported.package.packageId, imported.package.entries[0]!.entryPath),
      ),
    ).rejects.toMatchObject({ code: "unsafe_inventory" });
    expect(host.calls).toEqual([]);
  });

  it("persists reviewed retained snapshots in progress when cleanup fails after native deletion", async () => {
    const root = await makeRoot();
    const stateDir = path.join(root, "state");
    const { experts, definition } = await makeLegacyExpert(stateDir);
    const imported = await makePackage(stateDir, path.join(root, "source", "writer"));
    const inventory = makeHost(makeInventory("exp_" + "a".repeat(64)));
    inventory.host.cleanupLegacyArtifacts = async () => {
      throw new Error("New task or Hub reference appeared at cleanup.");
    };
    const service = createSkillPackageSwitchService({
      stateDir,
      experts,
      packages: createSkillPackageStore(stateDir),
      host: inventory.host,
    });
    const preview = await service.preview(
      switchInput(definition, imported.package.packageId, imported.package.entries[0]!.entryPath),
    );

    await expect(
      service.apply({ switchId: preview.switchId, digest: preview.digest }),
    ).rejects.toThrow(/New task or Hub reference/u);
    const progress = await service.readProgress(preview.switchId);
    expect(progress.status).toBe("failed");
    expect(progress.deletedThreadIds).toEqual(["test-thread-1"]);
    expect(progress.retainedSnapshotIds).toEqual(["exp_" + "a".repeat(64)]);
  });

  it("rejects a changed plan digest and unrelated Expert edits before host mutation", async () => {
    const root = await makeRoot();
    const stateDir = path.join(root, "state");
    const { experts, definition } = await makeLegacyExpert(stateDir);
    const imported = await makePackage(stateDir, path.join(root, "source", "writer"));
    const host = makeHost(makeInventory("exp_" + "a".repeat(64)));
    const service = createSkillPackageSwitchService({
      stateDir,
      experts,
      packages: createSkillPackageStore(stateDir),
      host: host.host,
    });
    const preview = await service.preview(
      switchInput(definition, imported.package.packageId, imported.package.entries[0]!.entryPath),
    );

    await expect(
      service.apply({ switchId: preview.switchId, digest: "0".repeat(64) }),
    ).rejects.toMatchObject({ code: "stale_preview" });
    await experts.save({
      id: definition.id,
      expectedRevision: definition.revision,
      name: definition.name,
      description: "Unrelated concurrent edit",
      useCases: definition.useCases,
      persona: definition.persona,
      outputRequirements: definition.outputRequirements,
      skills: definition.skills,
      references: definition.references,
      connections: definition.connections,
    });
    await expect(
      service.apply({ switchId: preview.switchId, digest: preview.digest }),
    ).rejects.toMatchObject({ code: "switch_conflict" });
    expect(host.calls).toEqual([]);
  });

  it("resumes after a host deletion failure without republishing the Expert revision", async () => {
    const root = await makeRoot();
    const stateDir = path.join(root, "state");
    const { experts, definition } = await makeLegacyExpert(stateDir);
    const imported = await makePackage(stateDir, path.join(root, "source", "writer"));
    const baseHost = makeHost(makeInventory("exp_" + "a".repeat(64)));
    const deleteThread = vi
      .fn<SkillPackageSwitchHost["deleteThread"]>()
      .mockRejectedValueOnce(new Error("temporary host failure"))
      .mockImplementation(async (threadId) => {
        await baseHost.host.deleteThread(threadId);
      });
    const host: SkillPackageSwitchHost = { ...baseHost.host, deleteThread };
    const service = createSkillPackageSwitchService({
      stateDir,
      experts,
      packages: createSkillPackageStore(stateDir),
      host,
    });
    const preview = await service.preview(
      switchInput(definition, imported.package.packageId, imported.package.entries[0]!.entryPath),
    );
    const command = { switchId: preview.switchId, digest: preview.digest };

    await expect(service.apply(command)).rejects.toThrow("temporary host failure");
    expect(await experts.read(definition.id)).toMatchObject({
      revision: definition.revision + 1,
      skillSelections: [{ packageId: imported.package.packageId }],
    });
    await service.apply(command);
    expect(await experts.read(definition.id)).toMatchObject({
      revision: definition.revision + 1,
    });
    expect(deleteThread).toHaveBeenCalledTimes(2);
    expect((await service.readProgress(preview.switchId)).status).toBe(
      "complete_with_retained_artifacts",
    );
  });

  it("retains legacy artifacts when host readback still reports an ordinary reference", async () => {
    const root = await makeRoot();
    const stateDir = path.join(root, "state");
    const { experts, definition } = await makeLegacyExpert(stateDir);
    const imported = await makePackage(stateDir, path.join(root, "source", "writer"));
    const initial = makeInventory("exp_" + "a".repeat(64));
    const host = makeHost(initial);
    const readInventory = vi
      .fn<SkillPackageSwitchHost["readInventory"]>()
      .mockImplementationOnce(async () => structuredClone(initial))
      .mockImplementationOnce(async () => host.currentInventory())
      .mockImplementationOnce(async () => {
        const afterDelete = host.currentInventory();
        return {
          ...afterDelete,
          snapshots: afterDelete.snapshots.map((snapshot) => ({
            ...snapshot,
            references: [{ kind: "ordinary" as const, id: "unlisted-resource" }],
          })),
        };
      });
    const serviceHost: SkillPackageSwitchHost = {
      ...host.host,
      readInventory,
    };
    const service = createSkillPackageSwitchService({
      stateDir,
      experts,
      packages: createSkillPackageStore(stateDir),
      host: serviceHost,
    });
    const preview = await service.preview(
      switchInput(definition, imported.package.packageId, imported.package.entries[0]!.entryPath),
    );

    await expect(
      service.apply({ switchId: preview.switchId, digest: preview.digest }),
    ).rejects.toMatchObject({ code: "unsafe_inventory" });
    expect(host.calls.some((call) => call.startsWith("cleanup:"))).toBe(false);
  });

  it("resolves every selected package before creating any Expert revision", async () => {
    const root = await makeRoot();
    const stateDir = path.join(root, "state");
    const { experts, definition } = await makeLegacyExpert(stateDir);
    const imported = await makePackage(stateDir, path.join(root, "source", "writer"));
    const service = createSkillPackageSwitchService({
      stateDir,
      experts,
      packages: createSkillPackageStore(stateDir),
      host: makeHost(makeInventory("exp_" + "a".repeat(64))).host,
    });
    const second = await experts.save({
      name: "Second legacy expert",
      description: "",
      useCases: "",
      persona: "",
      outputRequirements: "",
      skills: [{ name: "Old", path: path.join(stateDir, "old", "SKILL.md") }],
      references: [],
      connections: [],
    });
    const selections = [
      {
        expertId: definition.id,
        skillSelections: [
          {
            packageId: imported.package.packageId,
            entryPath: imported.package.entries[0]!.entryPath,
            activation: "startup" as const,
          },
        ],
      },
      {
        expertId: second.id,
        skillSelections: [
          {
            packageId: "pkg_" + "f".repeat(64),
            entryPath: "missing/SKILL.md",
            activation: "startup" as const,
          },
        ],
      },
    ];

    await expect(
      service.preview({
        experts: selections,
        allowlistedThreadIds: ["test-thread-1"],
        allowlistedSnapshotIds: ["exp_" + "a".repeat(64)],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(await experts.read(definition.id)).toMatchObject({
      revision: definition.revision,
      skills: definition.skills,
    });
    expect(await experts.read(second.id)).toMatchObject({
      revision: second.revision,
      skills: second.skills,
    });
  });
});
