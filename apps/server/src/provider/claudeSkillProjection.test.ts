import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { FIXED_EXPERT_SKILL_POLICY, type ProviderExpertSession } from "@synara/contracts";

import { createSkillPackageStore } from "../experts/SkillPackageStore";
import { prepareSkillRunResources } from "../experts/skillRunResources";
import {
  createClaudeFixedSkillProjection,
  UnsupportedClaudeEntryScopeError,
} from "./claudeSkillProjection";

const temporaryDirectories: string[] = [];

async function unlockTree(directory: string): Promise<void> {
  const stat = await fs.lstat(directory).catch(() => undefined);
  if (!stat || stat.isSymbolicLink()) return;
  await fs.chmod(directory, stat.isDirectory() ? 0o700 : 0o600);
  if (stat.isDirectory())
    for (const item of await fs.readdir(directory)) await unlockTree(path.join(directory, item));
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await unlockTree(directory);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function packageFixture(
  root: string,
  name: string,
  skills: ReadonlyArray<{ path: string; name: string; agent?: string }>,
  options: {
    readonly pluginManifest?: Record<string, unknown>;
    readonly agentFiles?: Readonly<Record<string, string>>;
    readonly assets?: Readonly<Record<string, string>>;
  } = {},
) {
  const source = path.join(root, name);
  for (const skill of skills) {
    const file = path.join(source, ...skill.path.split("/"));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      [
        "---",
        `name: ${skill.name}`,
        `description: ${skill.name} Skill`,
        ...(skill.agent ? [`agent: ${skill.agent}`] : []),
        "---",
        `Read ${"$"}{CLAUDE_PLUGIN_ROOT}/assets/reference.txt from ${skill.path}.`,
        "",
      ].join("\n"),
    );
  }
  for (const [relative, content] of Object.entries(options.agentFiles ?? {})) {
    const file = path.join(source, ...relative.split("/"));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  for (const [relative, content] of Object.entries(options.assets ?? {})) {
    const file = path.join(source, ...relative.split("/"));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  let originalManifest: string | undefined;
  if (options.pluginManifest) {
    originalManifest = `${JSON.stringify(options.pluginManifest, null, 2)}\n`;
    const file = path.join(source, ".claude-plugin", "plugin.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, originalManifest);
  }
  return { source, originalManifest };
}

async function importPackage(stateDir: string, source: string, entryPaths: ReadonlyArray<string>) {
  const store = createSkillPackageStore(stateDir);
  const preview = await store.preview({ path: source });
  const imported = await store.import({ previewId: preview.previewId });
  const entries = await store.resolveSelections(
    entryPaths.map((entryPath) => ({
      packageId: imported.package.packageId,
      entryPath,
    })),
  );
  return { imported, entries };
}

function session(
  stateDir: string,
  entries: Awaited<ReturnType<typeof importPackage>>["entries"],
): ProviderExpertSession {
  return {
    skillAssemblyId: `claude-assembly-${entries.map((entry) => entry.entryPath).join("-")}`,
    snapshotId: `exp_${"c".repeat(64)}`,
    persona: "Expert",
    skillsRoot: path.join(stateDir, "experts", "skill-packages"),
    skills: entries.map((entry) => ({ name: entry.name, path: entry.path })),
    skillEntries: entries,
    skillPolicy: FIXED_EXPERT_SKILL_POLICY,
    references: [],
  };
}

describe("Claude fixed Skill projection", () => {
  it("preserves a native plugin manifest and mirrors the full package at original paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-claude-full-plugin-"));
    temporaryDirectories.push(root);
    const stateDir = path.join(root, "state");
    const nativeManifest = {
      name: "source-review-plugin",
      version: "4.2.0",
      description: "Imported without rewriting.",
      skills: ["./"],
      metadata: { source: "package" },
    };
    const { source, originalManifest } = await packageFixture(
      root,
      "package",
      [
        { path: "skills/review/SKILL.md", name: "review", agent: "reviewer" },
        { path: "skills/unselected/SKILL.md", name: "unselected" },
      ],
      {
        pluginManifest: nativeManifest,
        agentFiles: {
          "agents/reviewer.md": [
            "---",
            "name: reviewer",
            "description: Review selected work",
            "tools: Read, Grep",
            "disallowedTools: Bash, Write",
            "skills: review",
            "maxTurns: 2",
            "permissionMode: bypassPermissions",
            "hooks:",
            "  PreToolUse: []",
            "---",
            "Review only.",
            "",
          ].join("\n"),
          "agents/unselected.md": "---\nname: [invalid\n",
        },
        assets: { "assets/reference.txt": "package asset\n" },
      },
    );
    const { imported, entries } = await importPackage(stateDir, source, ["skills/review/SKILL.md"]);
    const projection = await createClaudeFixedSkillProjection(
      path.join(root, "views"),
      session(stateDir, entries),
    );
    const plugin = projection.plugins[0]!;
    const nativeEntry = projection.entries[0]!;
    const mirroredManifest = path.join(plugin.path, ".claude-plugin", "plugin.json");
    const originalManifestPath = path.join(
      stateDir,
      "experts",
      "skill-packages",
      imported.package.packageId,
      "content",
      ".claude-plugin",
      "plugin.json",
    );

    expect(plugin.name).toBe("source-review-plugin");
    expect(await fs.readFile(mirroredManifest, "utf8")).toBe(originalManifest);
    expect(
      await fs.readFile(path.join(plugin.path, "skills", "unselected", "SKILL.md"), "utf8"),
    ).toContain("unselected Skill");
    expect(await fs.readFile(path.join(plugin.path, "assets", "reference.txt"), "utf8")).toBe(
      "package asset\n",
    );
    expect(await fs.readFile(nativeEntry.path, "utf8")).toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(nativeEntry.path).toBe(path.join(plugin.path, "skills", "review", "SKILL.md"));
    expect(nativeEntry.nativeName).toBe("source-review-plugin:review");
    const [originalStat, mirrorStat] = await Promise.all([
      fs.lstat(originalManifestPath),
      fs.lstat(mirroredManifest),
    ]);
    expect([mirrorStat.dev, mirrorStat.ino]).toEqual([originalStat.dev, originalStat.ino]);
    expect(projection.agents.reviewer).toMatchObject({
      skills: [nativeEntry.nativeName],
      tools: ["Read", "Grep"],
      disallowedTools: ["Bash", "Write"],
      maxTurns: 2,
    });
    expect(projection.agents.reviewer).not.toHaveProperty("permissionMode");
    expect(projection.agents.reviewer).not.toHaveProperty("hooks");
  });

  it("generates host manifest scopes for selected entry parents without moving or filtering files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-claude-generated-plugin-"));
    temporaryDirectories.push(root);
    const stateDir = path.join(root, "state");
    const { source } = await packageFixture(root, "package", [
      { path: "skills/review/SKILL.md", name: "review" },
      { path: "nested/y/SKILL.md", name: "nested-y" },
      { path: "skills/unselected/SKILL.md", name: "unselected" },
    ]);
    const { entries } = await importPackage(stateDir, source, [
      "skills/review/SKILL.md",
      "nested/y/SKILL.md",
    ]);
    const projection = await createClaudeFixedSkillProjection(
      path.join(root, "views"),
      session(stateDir, entries),
    );
    const plugin = projection.plugins[0]!;
    const generated = JSON.parse(
      await fs.readFile(path.join(plugin.path, ".claude-plugin", "plugin.json"), "utf8"),
    ) as { name: string; skills: string[] };

    expect(generated.skills).toEqual(["./nested/y", "./skills/review"]);
    expect(generated.name).toBe(plugin.name);
    expect(await fs.readFile(path.join(plugin.path, "nested", "y", "SKILL.md"), "utf8")).toContain(
      "nested-y Skill",
    );
    expect(
      await fs.readFile(path.join(plugin.path, "skills", "unselected", "SKILL.md"), "utf8"),
    ).toContain("unselected Skill");
    expect(projection.entries.map((entry) => entry.path)).toEqual([
      path.join(plugin.path, "skills", "review", "SKILL.md"),
      path.join(plugin.path, "nested", "y", "SKILL.md"),
    ]);
  });

  it("reports unsupported entry scope when a selected parent would expose an unselected skill", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-claude-unsupported-scope-"));
    temporaryDirectories.push(root);
    const stateDir = path.join(root, "state");
    const { source } = await packageFixture(root, "package", [
      { path: "SKILL.md", name: "root" },
      { path: "skills/other/SKILL.md", name: "other" },
    ]);
    const { entries } = await importPackage(stateDir, source, ["SKILL.md"]);
    await expect(
      createClaudeFixedSkillProjection(path.join(root, "views"), session(stateDir, entries)),
    ).rejects.toMatchObject({
      code: "unsupported_entry_scope",
      message: expect.stringContaining("select the complete package"),
    });
  });

  it("uses the persistent Run-private root directly and preserves generated host configuration", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-claude-private-plugin-"));
    temporaryDirectories.push(root);
    const stateDir = path.join(root, "state");
    const { source } = await packageFixture(root, "package", [
      { path: "skills/private/SKILL.md", name: "private" },
    ]);
    const { entries } = await importPackage(stateDir, source, ["skills/private/SKILL.md"]);
    const privateEntries = entries.map((entry) => ({
      ...entry,
      resourceMode: "run-private" as const,
    }));
    const refs = await prepareSkillRunResources(
      stateDir,
      "owner-run-claude-private",
      privateEntries,
    );
    const privateRoot = refs[0]!.rootPath;
    const output = path.join(privateRoot, "output.txt");
    await fs.writeFile(output, "keep output\n");
    const expert = session(stateDir, privateEntries);
    const projection = await createClaudeFixedSkillProjection(path.join(root, "views"), {
      ...expert,
      skillResourceRefs: refs,
    });
    const plugin = projection.plugins[0]!;
    const manifest = JSON.parse(
      await fs.readFile(path.join(privateRoot, ".claude-plugin", "plugin.json"), "utf8"),
    ) as { skills: string[] };

    expect(plugin.path).toBe(privateRoot);
    expect(projection.entries[0]?.path).toBe(
      path.join(privateRoot, "skills", "private", "SKILL.md"),
    );
    expect(manifest.skills).toEqual(["./skills/private"]);
    expect(await fs.readFile(output, "utf8")).toBe("keep output\n");
    await expect(fs.lstat(projection.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects conflicting native plugin namespaces instead of renaming source manifests", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-claude-plugin-conflict-"));
    temporaryDirectories.push(root);
    const stateDir = path.join(root, "state");
    const manifest = { name: "duplicate-source-name", skills: ["./"] };
    const firstSource = await packageFixture(
      root,
      "first-package",
      [{ path: "skills/first/SKILL.md", name: "first" }],
      { pluginManifest: manifest },
    );
    const secondSource = await packageFixture(
      root,
      "second-package",
      [{ path: "skills/second/SKILL.md", name: "second" }],
      { pluginManifest: manifest },
    );
    const first = await importPackage(stateDir, firstSource.source, ["skills/first/SKILL.md"]);
    const second = await importPackage(stateDir, secondSource.source, ["skills/second/SKILL.md"]);
    const entries = [...first.entries, ...second.entries];
    const expert: ProviderExpertSession = {
      ...session(stateDir, first.entries),
      skillAssemblyId: "claude-plugin-name-collision",
      skills: entries.map((entry) => ({ name: entry.name, path: entry.path })),
      skillEntries: entries,
    };

    await expect(
      createClaudeFixedSkillProjection(path.join(root, "views"), expert),
    ).rejects.toThrow(/plugin namespace collision/u);
  });

  it("conflicts rather than overwriting unexpected Run-private plugin manifest content", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "synara-claude-private-manifest-conflict-"),
    );
    temporaryDirectories.push(root);
    const stateDir = path.join(root, "state");
    const { source } = await packageFixture(root, "package", [
      { path: "skills/private/SKILL.md", name: "private" },
    ]);
    const { entries } = await importPackage(stateDir, source, ["skills/private/SKILL.md"]);
    const privateEntries = entries.map((entry) => ({
      ...entry,
      resourceMode: "run-private" as const,
    }));
    const refs = await prepareSkillRunResources(
      stateDir,
      "owner-run-manifest-conflict",
      privateEntries,
    );
    const privateRoot = refs[0]!.rootPath;
    await fs.mkdir(path.join(privateRoot, ".claude-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(privateRoot, ".claude-plugin", "plugin.json"),
      '{"name":"unexpected"}\n',
    );

    const expert = {
      ...session(stateDir, privateEntries),
      skillResourceRefs: refs,
    };
    await expect(
      createClaudeFixedSkillProjection(path.join(root, "views"), expert),
    ).rejects.toThrow(/conflicts with existing Run-private content/u);

    await fs.rm(path.join(privateRoot, ".claude-plugin", "plugin.json"));
    await fs.writeFile(path.join(privateRoot, ".claude-plugin", "custom.json"), "owned output\n");
    await expect(
      createClaudeFixedSkillProjection(path.join(root, "views"), expert),
    ).rejects.toThrow(/conflicts with existing Run-private content/u);
  });
});
