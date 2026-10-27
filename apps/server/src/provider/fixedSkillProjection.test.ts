import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIXED_EXPERT_SKILL_POLICY, type ProviderExpertSession } from "@synara/contracts";
import { createSkillPackageStore } from "../experts/SkillPackageStore";
import { expertResourceFiles } from "../experts/ExpertStore";
import { createFixedSkillProjection } from "./fixedSkillProjection";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    const makeDirectoriesWritable = async (current: string): Promise<void> => {
      const info = await fs.lstat(current).catch(() => undefined);
      if (!info?.isDirectory() || info.isSymbolicLink()) return;
      await fs.chmod(current, 0o700);
      for (const item of await fs.readdir(current, { withFileTypes: true }))
        if (item.isDirectory()) await makeDirectoriesWritable(path.join(current, item.name));
    };
    await makeDirectoriesWritable(directory);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe("fixed native Skill projection", () => {
  it("hard-links original Skill metadata and package resources while excluding unselected entries", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-fixed-projection-"));
    temporaryDirectories.push(root);
    const stateDir = path.join(root, "state");
    const packageSource = path.join(root, "package");
    await fs.mkdir(path.join(packageSource, "skills", "pm"), { recursive: true });
    await fs.mkdir(path.join(packageSource, "skills", "unused"), { recursive: true });
    await fs.mkdir(path.join(packageSource, "agents"), { recursive: true });
    await fs.mkdir(path.join(packageSource, "scripts"), { recursive: true });
    const original = [
      "---",
      "name: bmad-pm",
      "description: Product role",
      "context: fork",
      "agent: reviewer",
      "model: sonnet",
      "hooks:",
      "  PreToolUse:",
      "    - matcher: Bash",
      "      hooks:",
      "        - type: command",
      "          command: ${CLAUDE_PLUGIN_ROOT}/scripts/check.sh",
      "---",
      "Use scripts/check.sh and preserve all metadata.",
      "",
    ].join("\n");
    await fs.writeFile(path.join(packageSource, "skills", "pm", "SKILL.md"), original);
    await fs.writeFile(path.join(packageSource, "skills", "unused", "SKILL.md"), "unselected\n");
    await fs.writeFile(path.join(packageSource, "scripts", "check.sh"), "exit 0\n");
    await fs.writeFile(
      path.join(packageSource, "agents", "reviewer.md"),
      [
        "---",
        "name: reviewer",
        "description: Review the selected Skill work.",
        "tools: Read, Grep",
        "disallowedTools: Bash, Write",
        "maxTurns: 2",
        "autoCompactWindow: 1024",
        "skills: []",
        "permissionMode: bypassPermissions",
        "hooks:",
        "  PreToolUse: []",
        "---",
        "Review the selected Expert task.",
        "",
      ].join("\n"),
    );

    const store = createSkillPackageStore(stateDir);
    const preview = await store.preview({ path: packageSource });
    const imported = await store.import({ previewId: preview.previewId });
    const [entry] = await store.resolveSelections([
      {
        packageId: imported.package.packageId,
        entryPath: "skills/pm/SKILL.md",
        activation: "on-demand",
      },
    ]);
    expect(entry).toBeDefined();
    const session: ProviderExpertSession = {
      skillAssemblyId: "assembly-projection-a",
      skillRootRunId: "root-run-a",
      snapshotId: `exp_${"a".repeat(64)}`,
      persona: "Expert",
      skills: [{ name: entry!.name, path: entry!.path }],
      skillEntries: [entry!],
      skillPolicy: FIXED_EXPERT_SKILL_POLICY,
      references: [],
    };

    const projection = await createFixedSkillProjection(path.join(root, "views"), session);
    const nativeEntry = projection.entries[0]!;
    expect(await fs.readFile(nativeEntry.path, "utf8")).toBe(original);
    expect(nativeEntry.nativeName).toBe(`${nativeEntry.pluginName}:${entry!.name}`);
    const [sourceStat, viewStat] = await Promise.all([
      fs.lstat(entry!.path),
      fs.lstat(nativeEntry.path),
    ]);
    expect([viewStat.dev, viewStat.ino]).toEqual([sourceStat.dev, sourceStat.ino]);
    expect(
      await fs.readFile(path.join(projection.plugins[0]!.path, "scripts", "check.sh"), "utf8"),
    ).toBe("exit 0\n");
    await expect(
      fs.access(path.join(projection.plugins[0]!.path, "skills", "unused", "SKILL.md")),
    ).rejects.toThrow();
    expect(projection.allowedSubagentTypes).toContain("reviewer");
    expect(projection.agents.reviewer?.model).toBe("inherit");
    expect(projection.agents.reviewer).toMatchObject({
      tools: ["Read", "Grep"],
      disallowedTools: ["Bash", "Write"],
      maxTurns: 2,
      autoCompactWindow: 1024,
      skills: [],
    });
    expect(projection.agents.reviewer).not.toHaveProperty("permissionMode");
    expect(projection.agents.reviewer).not.toHaveProperty("hooks");
    expect(projection.allowedSubagentTypes).toEqual(
      expect.arrayContaining(["Explore", "Plan", "general-purpose"]),
    );

    const second = await createFixedSkillProjection(path.join(root, "views"), session);
    expect(second.root).toBe(projection.root);
    const otherAssembly = await createFixedSkillProjection(path.join(root, "views"), {
      ...session,
      skillAssemblyId: "assembly-projection-b",
    });
    expect(otherAssembly.root).not.toBe(projection.root);
  });

  it("projects an imported Claude plugin manifest with the fixed identity and preserves native metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-fixed-plugin-manifest-"));
    temporaryDirectories.push(root);
    const stateDir = path.join(root, "state");
    const packageSource = path.join(root, "package");
    await fs.mkdir(path.join(packageSource, "skills", "review"), { recursive: true });
    await fs.mkdir(path.join(packageSource, ".claude-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(packageSource, "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: Review changes\n---\nReview the selected change.\n",
    );
    const nativeManifest = {
      name: "source-review-plugin",
      displayName: "Source Review Plugin",
      version: "2.4.1",
      description: "A native plugin manifest imported with this Skill package.",
      author: { name: "Example Team", email: "dev@example.com" },
      homepage: "https://example.com/review-plugin",
      repository: "https://github.com/example/review-plugin",
      license: "MIT",
      keywords: ["review", "skills"],
      metadata: { catalogId: "catalog-review" },
      skills: ["./skills/"],
    };
    const originalManifest = `${JSON.stringify(nativeManifest, null, 2)}\n`;
    await fs.writeFile(path.join(packageSource, ".claude-plugin", "plugin.json"), originalManifest);

    const store = createSkillPackageStore(stateDir);
    const preview = await store.preview({ path: packageSource });
    const imported = await store.import({ previewId: preview.previewId });
    const [entry] = await store.resolveSelections([
      {
        packageId: imported.package.packageId,
        entryPath: "skills/review/SKILL.md",
        activation: "on-demand",
      },
    ]);
    expect(entry).toBeDefined();
    const immutableManifestPath = path.join(
      stateDir,
      "experts",
      "skill-packages",
      imported.package.packageId,
      "content",
      ".claude-plugin",
      "plugin.json",
    );
    expect(await fs.readFile(immutableManifestPath, "utf8")).toBe(originalManifest);
    const session: ProviderExpertSession = {
      skillAssemblyId: "assembly-native-plugin-manifest",
      snapshotId: `exp_${"b".repeat(64)}`,
      persona: "Expert",
      skills: [{ name: entry!.name, path: entry!.path }],
      skillEntries: [entry!],
      skillPolicy: FIXED_EXPERT_SKILL_POLICY,
      references: [],
    };

    const views = path.join(root, "views");
    const assemblyHash = createHash("sha256").update(session.skillAssemblyId!).digest("hex");
    const staleV3 = path.join(views, `native-skill-view-v3-${assemblyHash}`);
    const legacyManifest = path.join(
      staleV3,
      "plugins",
      `synara-fixed-${assemblyHash.slice(0, 20)}-${entry!.packageId.slice(4, 12)}`,
      ".claude-plugin",
      "plugin.json",
    );
    await fs.mkdir(path.dirname(legacyManifest), { recursive: true });
    await fs.link(immutableManifestPath, legacyManifest);
    const projection = await createFixedSkillProjection(views, session);
    expect(projection.root).toContain("native-skill-view-v4-");
    expect(projection.root).not.toBe(staleV3);
    expect(await fs.readFile(legacyManifest, "utf8")).toBe(originalManifest);
    const nativeEntry = projection.entries[0]!;
    const plugin = projection.plugins[0]!;
    const projectedManifest = JSON.parse(
      await fs.readFile(path.join(plugin.path, ".claude-plugin", "plugin.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(projectedManifest).toMatchObject({ ...nativeManifest, name: plugin.name });
    expect(projectedManifest.name).toBe(nativeEntry.pluginName);
    expect(nativeEntry.pluginName).toBe(plugin.name);
    expect(nativeEntry.nativeName).toBe(`${projectedManifest.name}:${nativeEntry.name}`);
    expect(await fs.readFile(immutableManifestPath, "utf8")).toBe(originalManifest);

    const read = expertResourceFiles.read;
    vi.spyOn(expertResourceFiles, "read").mockImplementation((...args) =>
      args[0] === immutableManifestPath
        ? Promise.resolve(
            Buffer.from(
              JSON.stringify({
                ...nativeManifest,
                description: "Changed after package verification",
              }),
            ),
          )
        : read(...args),
    );
    await expect(createFixedSkillProjection(views, session)).rejects.toThrow(
      "Immutable Claude plugin manifest changed before projection",
    );
  });

  it("keeps root Skill relative resources beside its entry and bypasses stale v2 projections", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-root-skill-projection-"));
    temporaryDirectories.push(root);
    const stateDir = path.join(root, "state");
    const packageSource = path.join(root, "package");
    const views = path.join(root, "views");
    const assemblyId = "assembly-root-relative-resource";
    await fs.mkdir(path.join(packageSource, "assets"), { recursive: true });
    await fs.writeFile(
      path.join(packageSource, "SKILL.md"),
      "---\nname: root-skill\ndescription: Root entry resource probe\n---\nRead ./assets/example.txt relative to this Skill.\n",
    );
    await fs.writeFile(path.join(packageSource, "assets", "example.txt"), "root asset\n");
    const store = createSkillPackageStore(stateDir);
    const preview = await store.preview({ path: packageSource });
    const imported = await store.import({ previewId: preview.previewId });
    const [entry] = await store.resolveSelections([
      { packageId: imported.package.packageId, entryPath: "SKILL.md", activation: "on-demand" },
    ]);
    expect(entry).toBeDefined();
    const session: ProviderExpertSession = {
      skillAssemblyId: assemblyId,
      skillRootRunId: "root-run-root-relative-resource",
      snapshotId: `exp_${"c".repeat(64)}`,
      persona: "Expert",
      skills: [{ name: entry!.name, path: entry!.path }],
      skillEntries: [entry!],
      skillPolicy: FIXED_EXPERT_SKILL_POLICY,
      references: [],
    };
    const assemblyHash = createHash("sha256").update(assemblyId).digest("hex");
    const staleV2 = path.join(views, `native-skill-view-v2-${assemblyHash}`);
    await fs.mkdir(staleV2, { recursive: true });
    await fs.writeFile(path.join(staleV2, "stale-cache-marker"), "old projection shape");

    const projection = await createFixedSkillProjection(views, session);
    const nativeEntry = projection.entries[0]!;
    expect(projection.root).toContain("native-skill-view-v4-");
    expect(projection.root).not.toBe(staleV2);
    expect(await fs.readFile(nativeEntry.path, "utf8")).toContain("Read ./assets/example.txt");
    expect(
      await fs.readFile(path.join(path.dirname(nativeEntry.path), "assets", "example.txt"), "utf8"),
    ).toBe("root asset\n");
    expect(projection.allowedSubagentTypes).toEqual(
      expect.arrayContaining(["Explore", "Plan", "general-purpose"]),
    );

    const skillFiles: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const item of await fs.readdir(directory, { withFileTypes: true })) {
        const child = path.join(directory, item.name);
        if (item.isDirectory()) await walk(child);
        else if (item.name === "SKILL.md") skillFiles.push(child);
      }
    };
    await walk(projection.plugins[0]!.path);
    expect(skillFiles).toEqual([nativeEntry.path]);
  });

  it("maps declared managed-agent Skills to selected native names and blocks unassembled references", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-managed-agent-skills-"));
    temporaryDirectories.push(root);
    const stateDir = path.join(root, "state");
    const packageSource = path.join(root, "package");
    await fs.mkdir(path.join(packageSource, "skills", "selected"), { recursive: true });
    await fs.mkdir(path.join(packageSource, "skills", "unselected"), { recursive: true });
    await fs.mkdir(path.join(packageSource, "agents"), { recursive: true });
    await fs.writeFile(
      path.join(packageSource, "skills", "selected", "SKILL.md"),
      "---\nname: selected-skill\ndescription: Selected parent skill\nagent: reviewer\ncontext: fork\n---\nReview.\n",
    );
    await fs.writeFile(
      path.join(packageSource, "skills", "unselected", "SKILL.md"),
      "---\nname: other-skill\ndescription: Unselected sibling\n---\nDo not preload.\n",
    );
    await fs.writeFile(
      path.join(packageSource, "agents", "reviewer.md"),
      "---\nname: reviewer\ndescription: Review\nskills: selected-skill\ntools: Read, Grep\ndisallowedTools: Bash, Write\nmaxTurns: 2\n---\nReview only.\n",
    );
    const store = createSkillPackageStore(stateDir);
    const preview = await store.preview({ path: packageSource });
    const imported = await store.import({ previewId: preview.previewId });
    const [entry] = await store.resolveSelections([
      {
        packageId: imported.package.packageId,
        entryPath: "skills/selected/SKILL.md",
        activation: "on-demand",
      },
    ]);
    const session: ProviderExpertSession = {
      skillAssemblyId: "assembly-managed-agent-skills",
      snapshotId: `exp_${"e".repeat(64)}`,
      persona: "Expert",
      skills: [{ name: entry!.name, path: entry!.path }],
      skillEntries: [entry!],
      skillPolicy: FIXED_EXPERT_SKILL_POLICY,
      references: [],
    };
    const projection = await createFixedSkillProjection(path.join(root, "views"), session);
    expect(projection.agents.reviewer).toMatchObject({
      skills: [projection.entries[0]!.nativeName],
      tools: ["Read", "Grep"],
      disallowedTools: ["Bash", "Write"],
      maxTurns: 2,
    });

    await fs.chmod(path.join(packageSource, "agents", "reviewer.md"), 0o600);
    await fs.writeFile(
      path.join(packageSource, "agents", "reviewer.md"),
      "---\nname: reviewer\ndescription: Review\nskills: other-skill\n---\nReview only.\n",
    );
    const otherPreview = await store.preview({ path: packageSource });
    const otherPackage = await store.import({ previewId: otherPreview.previewId });
    const [otherEntry] = await store.resolveSelections([
      {
        packageId: otherPackage.package.packageId,
        entryPath: "skills/selected/SKILL.md",
        activation: "on-demand",
      },
    ]);
    await expect(
      createFixedSkillProjection(path.join(root, "views"), {
        ...session,
        skillAssemblyId: "assembly-unselected-managed-agent-skill",
        skills: [{ name: otherEntry!.name, path: otherEntry!.path }],
        skillEntries: [otherEntry!],
      }),
    ).rejects.toThrow(/references Skill "other-skill" outside or ambiguously/u);
  });

  it("allows only the controlled built-in child agents for an empty inherited assembly", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-empty-native-agents-"));
    temporaryDirectories.push(root);
    const projection = await createFixedSkillProjection(path.join(root, "views"), {
      skillAssemblyId: "assembly-empty-native-agents",
      snapshotId: `exp_${"f".repeat(64)}`,
      persona: "Expert",
      skills: [],
      skillEntries: [],
      skillPolicy: FIXED_EXPERT_SKILL_POLICY,
      references: [],
    });
    expect(projection.plugins).toEqual([]);
    expect(projection.allowedSubagentTypes).toEqual(["Explore", "Plan", "general-purpose"]);
    expect(projection.agents).toEqual({});
  });
});
