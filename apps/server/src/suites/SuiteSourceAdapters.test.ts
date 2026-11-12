import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeSuiteSource, compileBmadRole, mergeBmadCustomization } from "./SuiteSourceAdapters";
import { createSuiteSourceSnapshot } from "./SuiteSourceSnapshot";
import { expertResourceFiles } from "../experts/ExpertStore";
import { BMAD_ROLE_FIXTURES } from "./bmadRoleFixtures.test-fixture";
import { BMAD_ROLE_PRESETS } from "../experts/bmadSkillPreset";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await expertResourceFiles.removeStaging(root);
});

describe("Suite source adaptation", () => {
  it("compiles all six exact source roles without invoking a source script", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "suite-roles-")));
    roots.push(root);
    for (const [relative, text] of Object.entries(BMAD_ROLE_FIXTURES)) {
      await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await fs.writeFile(path.join(root, relative), text);
    }
    for (const preset of BMAD_ROLE_PRESETS) {
      const role = await compileBmadRole({ sourceRoot: root, roleKey: preset.id });
      expect(role.name).toBe(preset.name);
      expect(role.bmadRole).toBe(preset.role);
      expect(role.persona).toContain("real target Expert delegation");
      expect(role.persona).not.toContain("uv run --no-cache");
      if (preset.id === "bmad-po") {
        expect(role.persona).toContain("Never show the menu");
        expect(role.persona).not.toContain("{{");
        expect(role.persona).toContain(
          "file resource bmad-source-dependencies/bmad-agent-po/references/board.md",
        );
      }
    }
    await fs.mkdir(path.join(root, "_bmad", "custom"), { recursive: true });
    await fs.writeFile(
      path.join(root, "_bmad", "custom", "bmad-agent-pm.toml"),
      '[agent]\nidentity = "Team identity"\nprinciples = ["Team principle"]\n[[agent.menu]]\ncode = "DEV"\ndescription = "Delegate implementation"\nskill = "bmad-build"\n',
    );
    await fs.writeFile(
      path.join(root, "_bmad", "custom", "bmad-agent-pm.user.toml"),
      '[agent]\nidentity = "Personal identity"\nprinciples = ["Personal principle"]\n',
    );
    const customized = await compileBmadRole({
      sourceRoot: root,
      projectRoot: root,
      roleKey: "bmad-pm",
      expertIds: { "bmad-dev": "expert-real-dev" },
    });
    expect(customized.persona).toContain("Personal identity");
    expect(customized.persona).toContain("Team principle");
    expect(customized.persona).toContain("Personal principle");
    expect(customized.persona).toContain('expertId="expert-real-dev"');
    expect(customized.persona).not.toContain("Team identity");
    await fs.mkdir(path.join(root, "docs"));
    await fs.writeFile(path.join(root, "docs", "facts.md"), "Fixed project fact");
    await fs.writeFile(
      path.join(root, "_bmad", "custom", "bmad-agent-pm.user.toml"),
      '[agent]\npersistent_facts = ["file:{project-root}/docs/*.md"]\n',
    );
    const withFacts = await compileBmadRole({
      sourceRoot: root,
      projectRoot: root,
      roleKey: "bmad-pm",
    });
    expect(withFacts.persona).toContain("Source: project/docs/facts.md");
    expect(withFacts.persona).toContain("Fixed project fact");
    await fs.writeFile(
      path.join(root, "_bmad", "custom", "bmad-agent-pm.user.toml"),
      '[agent]\npersistent_facts = ["file:../outside"]\n',
    );
    await expect(
      compileBmadRole({ sourceRoot: root, projectRoot: root, roleKey: "bmad-pm" }),
    ).rejects.toMatchObject({
      issue: { code: "unsafe_path", action: "run", effect: "deny-action" },
    });
    await fs.writeFile(
      path.join(root, "_bmad", "custom", "bmad-agent-pm.user.toml"),
      '[agent]\n[[agent.menu]]\ncode = "UNKNOWN"\ndescription = "Unknown"\nskill = "not-registered"\n',
    );
    await expect(
      compileBmadRole({ sourceRoot: root, projectRoot: root, roleKey: "bmad-pm" }),
    ).rejects.toMatchObject({
      issue: { code: "identity_unavailable", action: "run", effect: "deny-action" },
    });
  });

  it("captures immutable local input and consumes files with no SKILL.md", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "suite-source-")));
    roots.push(root);
    const source = path.join(root, "source");
    await fs.mkdir(path.join(source, "rules"), { recursive: true });
    await fs.writeFile(path.join(source, "author.md"), "A real specification author.");
    await fs.writeFile(path.join(source, "rules", "policy.md"), "Use evidence.");
    await fs.writeFile(
      path.join(source, "synara-suite.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "Specifications",
        description: "Read-only rules",
        experts: [
          {
            key: "author",
            kind: "definition",
            name: "Author",
            description: "Write specifications",
            personaPath: "author.md",
          },
        ],
        resources: [{ key: "rules", kind: "files", root: "rules", purpose: "instructions" }],
        sharedResourceKeys: ["rules"],
        unsupportedSetting: "preserved only",
      }),
    );
    const captured = await createSuiteSourceSnapshot(path.join(root, "state")).capture({
      kind: "local-folder",
      path: source,
    });
    expect(captured.source).not.toHaveProperty("path");
    expect(captured.source).not.toHaveProperty("realpath");
    await fs.writeFile(path.join(source, "author.md"), "Mutated original");
    const analyzed = await analyzeSuiteSource(captured.rootPath, captured.source);
    expect(analyzed.adapterId).toBe("synara-suite-v1");
    expect(analyzed.roles.author?.persona).toBe("A real specification author.");
    expect(analyzed.issues).toEqual([
      expect.objectContaining({ code: "unsupported_capability", effect: "observe" }),
    ]);
    expect(analyzed.manifest).not.toHaveProperty("unsupportedSetting");
  });

  it("reports a missing member locally without blocking another valid identity", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "suite-partial-")));
    roots.push(root);
    await fs.writeFile(path.join(root, "valid.md"), "Valid identity");
    await fs.writeFile(
      path.join(root, "synara-suite.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "Partial",
        description: "",
        experts: [
          {
            key: "valid",
            kind: "definition",
            name: "Valid",
            description: "",
            personaPath: "valid.md",
          },
          {
            key: "missing",
            kind: "definition",
            name: "Missing",
            description: "",
            personaPath: "missing.md",
          },
        ],
      }),
    );
    const captured = await createSuiteSourceSnapshot(path.join(root, "state")).capture({
      kind: "local-folder",
      path: root,
    });
    const result = await analyzeSuiteSource(captured.rootPath, captured.source);
    expect(result.roles.valid?.persona).toBe("Valid identity");
    expect(result.roles).not.toHaveProperty("missing");
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "identity_unavailable",
        action: "run",
        effect: "deny-action",
        subject: expect.objectContaining({ id: "missing" }),
      }),
    );
  });

  it("rejects invalid root manifest rather than guessing BMAD and rejects undeclared resource keys", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "suite-invalid-")));
    roots.push(root);
    await fs.writeFile(
      path.join(root, "synara-suite.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "Invalid",
        description: "",
        experts: [{ key: "reference", kind: "reference", expertId: "existing-expert" }],
        sharedResourceKeys: ["not-declared"],
      }),
    );
    const source = {
      kind: "local-folder" as const,
      sourceId: "source-fixture",
      contentHash: "a".repeat(64),
    };
    await expect(analyzeSuiteSource(root, source)).rejects.toMatchObject({
      issue: { code: "invalid_manifest", effect: "deny-action" },
    });
  });

  it("merges scalars, deep tables, keyed replacements and ordinary array appends", () => {
    expect(
      mergeBmadCustomization(
        {
          scalar: "base",
          nested: { keep: true, replace: 1 },
          facts: ["base"],
          menu: [
            { code: "A", prompt: "old", oldField: true },
            { code: "B", prompt: "keep" },
          ],
        },
        {
          scalar: "team",
          nested: { replace: 2 },
          facts: ["team"],
          menu: [
            { code: "A", prompt: "new" },
            { code: "C", prompt: "append" },
          ],
        },
      ),
    ).toEqual({
      scalar: "team",
      nested: { keep: true, replace: 2 },
      facts: ["base", "team"],
      menu: [
        { code: "A", prompt: "new" },
        { code: "B", prompt: "keep" },
        { code: "C", prompt: "append" },
      ],
    });
    expect(
      mergeBmadCustomization(
        [{ id: "one", value: 1 }],
        [
          { id: "one", value: 2 },
          { id: "two", value: 3 },
        ],
      ),
    ).toEqual([
      { id: "one", value: 2 },
      { id: "two", value: 3 },
    ]);
    expect(() => mergeBmadCustomization([{ code: "A" }], [{ code: 7 }])).toThrow(
      /identifier|keyed/u,
    );
  });
});
