import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CLAUDE_EXPERT_PLUGIN_NAME,
  CLAUDE_EXPERT_PROJECTION_VERSION,
  createClaudeExpertProjection,
  inspectClaudeExpertSkills,
} from "./claudeExpertSession.ts";

const temporaryDirectories: string[] = [];

function makeDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "synara-claude-expert-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Claude Expert skill projection", () => {
  it("projects only snapshot skills, preserves executable bits, and reuses an intact projection", async () => {
    const root = makeDirectory();
    const skillsRoot = path.join(root, "snapshot", "skills");
    const reviewer = path.join(skillsRoot, "reviewer");
    const sourceSkill = path.join(reviewer, "SKILL.md");
    const sourceScript = path.join(reviewer, "scripts", "review.sh");
    const outputRoot = path.join(root, "state", "claude-expert");
    mkdirSync(path.dirname(sourceScript), { recursive: true });
    writeFileSync(
      sourceSkill,
      "---\nname: reviewer\ndescription: Review code changes for correctness and safety.\n---\nReview the change.\n",
    );
    writeFileSync(sourceScript, "#!/bin/sh\nprintf review\n");
    chmodSync(sourceScript, 0o750);
    mkdirSync(path.join(skillsRoot, "unselected", "hooks"), { recursive: true });
    writeFileSync(path.join(skillsRoot, "unselected", "hooks", "unsafe.sh"), "exit 1\n");

    const input = {
      outputRoot,
      snapshotId: "expert-snapshot-1",
      skillsRoot,
      skills: [{ name: "reviewer", path: sourceSkill }],
    } as const;
    const first = await createClaudeExpertProjection(input);
    const second = await createClaudeExpertProjection(input);
    const projectedPluginJson = JSON.parse(
      readFileSync(path.join(first.pluginPath, ".claude-plugin", "plugin.json"), "utf8"),
    ) as Record<string, unknown>;
    const projectedScript = path.join(
      first.pluginPath,
      "skills",
      "reviewer",
      "scripts",
      "review.sh",
    );
    const pluginEntries = readFileSync(
      path.join(first.pluginPath, ".claude-plugin", "plugin.json"),
      "utf8",
    );

    expect(first.pluginName).toBe(CLAUDE_EXPERT_PLUGIN_NAME);
    expect(first.projectionVersion).toBe(CLAUDE_EXPERT_PROJECTION_VERSION);
    expect(first.pluginPath).toBe(second.pluginPath);
    expect(first.nativeSkillNames).toEqual(["synara-expert:reviewer"]);
    expect(first.skills).toEqual([
      {
        name: "reviewer",
        path: path.join(first.pluginPath, "skills", "reviewer", "SKILL.md"),
      },
    ]);
    expect(projectedPluginJson).toEqual({
      name: "synara-expert",
      version: "1.0.0",
      description: "Expert skills projected for this Synara session.",
    });
    expect(pluginEntries).not.toContain("hooks");
    expect(pluginEntries).not.toContain("agents");
    expect(pluginEntries).not.toContain("mcpServers");
    expect(
      readFileSync(path.join(first.pluginPath, "skills", "reviewer", "SKILL.md"), "utf8"),
    ).toBe(readFileSync(sourceSkill, "utf8"));
    expect(readFileSync(projectedScript, "utf8")).toBe(readFileSync(sourceScript, "utf8"));
    expect(statSync(projectedScript).mode & 0o777).toBe(0o750);
    expect(directoryEntries(first.pluginPath)).toEqual([".claude-plugin", "skills"]);
    expect(directoryEntries(path.join(first.pluginPath, "skills"))).toEqual(["reviewer"]);
  });

  it("reports duplicate skill-name conflicts and files outside the snapshot root", async () => {
    const root = makeDirectory();
    const skillsRoot = path.join(root, "snapshot", "skills");
    const firstSkill = path.join(skillsRoot, "reviewer", "SKILL.md");
    const otherSkill = path.join(root, "other", "SKILL.md");
    mkdirSync(path.dirname(firstSkill), { recursive: true });
    mkdirSync(path.dirname(otherSkill), { recursive: true });
    writeFileSync(
      firstSkill,
      "---\nname: reviewer\ndescription: Review code changes.\n---\nReview.\n",
    );
    writeFileSync(otherSkill, "Other.\n");

    const result = await inspectClaudeExpertSkills({
      skillsRoot,
      skills: [
        { name: "reviewer", path: firstSkill },
        { name: "REVIEWER", path: firstSkill },
        { name: "external", path: otherSkill },
      ],
    });

    expect(result.issues).toContain(
      "Expert skills contain duplicate names that would collide in Claude Code.",
    );
    expect(result.issues).toContain(
      "An Expert skill is outside its immutable snapshot skills root.",
    );
    expect(result.skills).toHaveLength(1);
  });

  it.each([
    {
      name: "user-invocable disabled",
      frontmatter: "name: private-check\ndescription: Safety checklist.\nuser-invocable: false",
      expected: /user-invocable: false/u,
    },
    {
      name: "missing description",
      frontmatter: "name: reviewer",
      expected: /no non-empty description/u,
    },
  ])(
    "fails closed for skill visibility that native init cannot prove: $name",
    async ({ frontmatter, expected }) => {
      const root = makeDirectory();
      const sourceSkill = path.join(root, "snapshot", "skills", "reviewer", "SKILL.md");
      mkdirSync(path.dirname(sourceSkill), { recursive: true });
      writeFileSync(sourceSkill, `---\n${frontmatter}\n---\nProtected instructions.\n`);

      const result = await inspectClaudeExpertSkills({
        skillsRoot: path.dirname(path.dirname(sourceSkill)),
        skills: [{ name: "reviewer", path: sourceSkill }],
      });

      expect(result.issues.join(" ")).toMatch(expected);
      expect(result.skills).toHaveLength(0);
      expect(readFileSync(sourceSkill, "utf8")).toContain(frontmatter);
    },
  );
});

function directoryEntries(directory: string): string[] {
  return readdirSync(directory).sort();
}
