// FILE: OmpExpertSession.test.ts
// Purpose: Verifies fail-closed OMP-native Expert/Context projection.
// Layer: Provider ACP tests

import {
  chmod,
  lstat,
  link,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  FIXED_EXPERT_SKILL_POLICY,
  type ProviderExpertSession,
  type ProviderSkillReference,
  type SkillPackageResource,
} from "@synara/contracts";
import { Effect } from "effect";
import { composeProviderBaseInstructions } from "@synara/shared/contextInstructions";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { createExpertSkillApplication } from "../expertSkillCatalog";
import { createSkillPackageStore } from "../../experts/SkillPackageStore.ts";

import {
  OMP_EXPERT_PROJECTION_VERSION,
  prepareOmpExpertSession,
  removeFixedProjectionStaging,
  type OmpExpertCliResult,
  type OmpExpertSessionPreparationInput,
} from "./OmpExpertSession.ts";

const tempRoots: string[] = [];

async function makeTreeWritable(target: string): Promise<void> {
  const info = await lstat(target).catch(() => undefined);
  if (!info || info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await chmod(target, 0o700);
    for (const name of await readdir(target)) await makeTreeWritable(path.join(target, name));
    return;
  }
  if (info.isFile()) await chmod(target, 0o600);
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "omp-expert-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await makeTreeWritable(root);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

function nativeConfig(overrides: Record<string, unknown> = {}) {
  return {
    "skills.enabled": { value: true },
    "skills.customDirectories": { value: ["/existing/native-skills"] },
    "skills.ignoredSkills": { value: [] },
    "skills.includeSkills": { value: [] },
    disabledExtensions: { value: [] },
    enabledProviders: { value: [] },
    disabledProviders: { value: [] },
    ...overrides,
  };
}

function result(stdout: string, exitCode = 0): OmpExpertCliResult {
  return { stdout, stderr: "", exitCode };
}

async function createSkill(root: string, name = "reviewer"): Promise<ProviderSkillReference> {
  const skillsRoot = path.join(root, "snapshot", "skills");
  const directory = path.join(skillsRoot, name);
  await mkdir(directory, { recursive: true });
  const skillPath = path.join(directory, "SKILL.md");
  await writeFile(
    skillPath,
    `---\nname: ${name}\ndescription: Review with care.\n---\nInstructions.\n`,
  );
  return { name, path: skillPath };
}

function makeRunner(input: {
  readonly cwd: string;
  readonly skills: ReadonlyArray<ProviderSkillReference>;
  readonly config?: ReturnType<typeof nativeConfig>;
  readonly version?: string;
  readonly omitNativeSkills?: boolean;
  readonly omitDescription?: boolean;
  readonly hideSkill?: boolean;
  readonly failOverlayCheck?: boolean;
  readonly calls?: Array<ReadonlyArray<string>>;
}) {
  const config = input.config ?? nativeConfig();
  return (args: ReadonlyArray<string>, _cwd: string, env: NodeJS.ProcessEnv) =>
    Effect.tryPromise({
      try: async () => {
        input.calls?.push([...args]);
        if (args.length === 1 && args[0] === "--version") {
          return result(input.version ?? "omp/18.12.1\n");
        }
        if (args[0] === "config" && args[1] === "list") {
          return result(JSON.stringify(config));
        }
        if (args[0] === "config" && args[1] === "get") {
          if (input.failOverlayCheck) return result("", 1);
          const files = (env.PI_CONFIG_FILES ?? "").split(path.delimiter).filter(Boolean);
          const overlayPath = files.at(-1);
          if (!overlayPath) return result("", 1);
          const overlay = parseYaml(await readFile(overlayPath, "utf8")) as {
            skills?: { customDirectories?: ReadonlyArray<string> };
          };
          return result(JSON.stringify({ value: overlay.skills?.customDirectories }));
        }
        if (args[0] === "skill" && args[1] === "list") {
          const skills = input.omitNativeSkills
            ? []
            : await Promise.all(
                input.skills.map(async ({ name, path: referencePath }) => {
                  const referenceInfo = await stat(referencePath);
                  const filePath = referenceInfo.isDirectory()
                    ? path.join(referencePath, "SKILL.md")
                    : referencePath;
                  return {
                    name,
                    ...(!input.omitDescription ? { description: "Review with care." } : {}),
                    filePath,
                    ...(input.hideSkill ? { hide: true } : {}),
                    source: "custom",
                  };
                }),
              );
          return result(JSON.stringify({ skills, warnings: [] }));
        }
        return result("", 2);
      },
      catch: (cause) => (cause instanceof Error ? cause : new Error("Fake OMP command failed.")),
    });
}

function baseInput(
  cwd: string,
  runCli: OmpExpertSessionPreparationInput["runCli"],
  skills: ReadonlyArray<ProviderSkillReference>,
): OmpExpertSessionPreparationInput {
  const expertSession: ProviderExpertSession = {
    snapshotId: "expert-snapshot-1",
    persona: "You are a careful reviewer.",
    skillsRoot: path.dirname(path.dirname(skills[0]!.path)),
    skills,
    references: [],
  };
  return { cwd, env: { HOME: path.dirname(cwd) }, runCli, expertSession };
}

describe("prepareOmpExpertSession", () => {
  it.each([
    {
      title: "ignores PI_CODING_AGENT_DIR and follows the default config root",
      env: { PI_CODING_AGENT_DIR: "/custom/agent" },
      configRoot: [".omp", "agent"],
    },
    {
      title: "uses the native named-profile config root",
      env: { OMP_PROFILE: " reviewer ", PI_CODING_AGENT_DIR: "/custom/agent" },
      configRoot: [".omp", "profiles", "reviewer", "agent"],
    },
    {
      title: "honors PI_CONFIG_DIR for the generic config root",
      env: { PI_CONFIG_DIR: ".omp-test", PI_CODING_AGENT_DIR: "/custom/agent" },
      configRoot: [".omp-test", "agent"],
    },
  ])(
    "resolves native APPEND_SYSTEM through generic config discovery: $title",
    async ({ env, configRoot }) => {
      const root = await makeRoot();
      const cwd = path.join(root, "project");
      const activeNativeRoot = path.join(root, ...configRoot);
      const customAgentRoot = path.join(root, "custom", "agent");
      await mkdir(activeNativeRoot, { recursive: true });
      await mkdir(customAgentRoot, { recursive: true });
      await writeFile(path.join(activeNativeRoot, "APPEND_SYSTEM.md"), "native generic root");
      await writeFile(path.join(customAgentRoot, "APPEND_SYSTEM.md"), "custom agent dir decoy");
      const runCli = makeRunner({ cwd, skills: [] });
      const preparation = await Effect.runPromise(
        prepareOmpExpertSession({
          cwd,
          env: { HOME: root, ...env },
          runCli,
          expertSession: {
            snapshotId: "expert-snapshot-1",
            persona: "You are a careful reviewer.",
            skills: [],
            references: [],
          },
        }),
      );

      expect(preparation.issues).toEqual([]);
      const prompt = await readFile(preparation.appendSystemPromptPath!, "utf8");
      expect(prompt).toContain("native generic root");
      expect(prompt).not.toContain("custom agent dir decoy");
      await Effect.runPromise(preparation.cleanup());
    },
  );

  it("keeps the native .omp user config root when OMP is disabled as a provider", async () => {
    const root = await makeRoot();
    const cwd = path.join(root, "project");
    const activeNativeRoot = path.join(root, ".omp", "agent");
    await mkdir(activeNativeRoot, { recursive: true });
    await writeFile(path.join(activeNativeRoot, "APPEND_SYSTEM.md"), "native root remains active");
    const runCli = makeRunner({
      cwd,
      skills: [],
      config: nativeConfig({ disabledProviders: { value: ["omp"] } }),
    });

    const preparation = await Effect.runPromise(
      prepareOmpExpertSession({
        cwd,
        env: { HOME: root },
        runCli,
        expertSession: {
          snapshotId: "expert-snapshot-1",
          persona: "You are a careful reviewer.",
          skills: [],
          references: [],
        },
      }),
    );

    expect(preparation.issues).toEqual([]);
    const prompt = await readFile(preparation.appendSystemPromptPath!, "utf8");
    expect(prompt).toContain("native root remains active");
    await Effect.runPromise(preparation.cleanup());
  });

  it("uses the verified native loader, keeps native APPEND_SYSTEM.md, and creates read-only overlays", async () => {
    const root = await makeRoot();
    const cwd = path.join(root, "project");
    const skill = await createSkill(root);
    await mkdir(path.join(cwd, ".omp"), { recursive: true });
    await writeFile(path.join(cwd, ".omp", "APPEND_SYSTEM.md"), "Native project instructions.");
    const calls: Array<ReadonlyArray<string>> = [];
    const runCli = makeRunner({ cwd, skills: [skill], calls });

    const preparation = await Effect.runPromise(
      prepareOmpExpertSession(baseInput(cwd, runCli, [skill])),
    );

    expect(preparation.issues).toEqual([]);
    expect(preparation.instructionsHash).toMatch(/^[a-f0-9]{64}$/);
    expect(preparation.loadedSkills).toEqual([{ name: "reviewer", path: skill.path }]);
    expect(calls.map((args) => args.slice(0, 2))).toEqual([
      ["--version"],
      ["config", "list"],
      ["config", "get"],
      ["skill", "list"],
    ]);

    const overlayPath = preparation.configOverlayPath!;
    const overlay = parseYaml(await readFile(overlayPath, "utf8")) as {
      skills: { customDirectories: ReadonlyArray<string> };
    };
    expect(overlay.skills.customDirectories).toEqual([
      path.dirname(path.dirname(await realpath(skill.path))),
      "/existing/native-skills",
    ]);
    expect((await stat(overlayPath)).mode & 0o777).toBe(0o400);
    expect(await readFile(preparation.appendSystemPromptPath!, "utf8")).toContain(
      "Native project instructions.",
    );
    expect(await readFile(preparation.appendSystemPromptPath!, "utf8")).toContain(
      "You are a careful reviewer.",
    );
    expect((await stat(preparation.appendSystemPromptPath!)).mode & 0o777).toBe(0o400);

    await Effect.runPromise(preparation.cleanup());
    await expect(stat(overlayPath)).rejects.toThrow();
    expect(OMP_EXPERT_PROJECTION_VERSION).toBe("omp-acp-native-v1");
  });

  it("keeps Expert V2 catalog instructions while bypassing OMP native skill projection", async () => {
    const root = await makeRoot();
    const cwd = path.join(root, "project");
    const skill = await createSkill(root);
    const calls: Array<ReadonlyArray<string>> = [];
    const runCli = makeRunner({ cwd, skills: [skill], calls });
    const persona = "You are a careful reviewer.\n\nFixed V2 catalog and startup body.";
    const expertSession: ProviderExpertSession = {
      snapshotId: "expert-v2-omp",
      persona,
      skillsRoot: path.dirname(path.dirname(skill.path)),
      skills: [skill],
      skillLoading: "index",
      skillEntries: [
        {
          packageId: `pkg_${"c".repeat(64)}`,
          entryPath: "skills/reviewer/SKILL.md",
          activation: "startup",
          name: skill.name,
          description: "Review with care.",
          path: skill.path,
        },
      ],
      references: [],
    };

    const preparation = await Effect.runPromise(
      prepareOmpExpertSession({
        cwd,
        env: { HOME: root },
        runCli,
        expertSession,
      }),
    );

    const instructions = composeProviderBaseInstructions({ expertPersona: persona }) ?? "";
    expect(preparation.issues).toEqual([]);
    expect(preparation.loadedSkills).toEqual([]);
    expect(preparation.configOverlayPath).toBeUndefined();
    expect(preparation.instructionsHash).toBe(
      createHash("sha256").update(instructions, "utf8").digest("hex"),
    );
    expect(await readFile(preparation.appendSystemPromptPath!, "utf8")).toContain(persona);
    expect(calls.some((args) => args[0] === "skill")).toBe(false);
    expect(calls.some((args) => args[0] === "config" && args[1] === "get")).toBe(false);
    await Effect.runPromise(preparation.cleanup());
  });

  it("blocks skills.enabled=false without silently enabling skills", async () => {
    const root = await makeRoot();
    const cwd = path.join(root, "project");
    const skill = await createSkill(root);
    const calls: Array<ReadonlyArray<string>> = [];
    const runCli = makeRunner({
      cwd,
      skills: [skill],
      config: nativeConfig({ "skills.enabled": { value: false } }),
      calls,
    });

    const preparation = await Effect.runPromise(
      prepareOmpExpertSession(baseInput(cwd, runCli, [skill])),
    );

    expect(preparation.issues.join(" ")).toContain("skills.enabled=false");
    expect(calls.some((args) => args[0] === "skill")).toBe(false);
    await Effect.runPromise(preparation.cleanup());
  });

  it.each([
    ["skills.ignoredSkills", nativeConfig({ "skills.ignoredSkills": { value: ["reviewer"] } })],
    [
      "skills.includeSkills",
      nativeConfig({ "skills.includeSkills": { value: ["another-skill"] } }),
    ],
    ["disabledExtensions", nativeConfig({ disabledExtensions: { value: ["skill:reviewer"] } })],
  ])("blocks a required skill filtered by %s", async (filter, config) => {
    const root = await makeRoot();
    const cwd = path.join(root, "project");
    const skill = await createSkill(root);
    const runCli = makeRunner({
      cwd,
      skills: [skill],
      omitNativeSkills: true,
      config,
    });

    const preparation = await Effect.runPromise(
      prepareOmpExpertSession(baseInput(cwd, runCli, [skill])),
    );

    expect(preparation.issues.join(" ")).toContain(filter);
    await Effect.runPromise(preparation.cleanup());
  });

  it("blocks native skills that do not have a description", async () => {
    const root = await makeRoot();
    const cwd = path.join(root, "project");
    const skill = await createSkill(root);
    const preparation = await Effect.runPromise(
      prepareOmpExpertSession(
        baseInput(cwd, makeRunner({ cwd, skills: [skill], omitDescription: true }), [skill]),
      ),
    );

    expect(preparation.issues.join(" ")).toContain("has no native description");
    await Effect.runPromise(preparation.cleanup());
  });

  it("blocks skills hidden from native model invocation", async () => {
    const root = await makeRoot();
    const cwd = path.join(root, "project");
    const skill = await createSkill(root);
    const preparation = await Effect.runPromise(
      prepareOmpExpertSession(
        baseInput(cwd, makeRunner({ cwd, skills: [skill], hideSkill: true }), [skill]),
      ),
    );

    expect(preparation.issues.join(" ")).toContain("hidden from native model invocation");
    await Effect.runPromise(preparation.cleanup());
  });

  it("previews skills from multiple source roots and normalizes skill-directory refs", async () => {
    const root = await makeRoot();
    const cwd = path.join(root, "project");
    const first = await createSkill(path.join(root, "first"), "first-skill");
    const second = await createSkill(path.join(root, "second"), "second-skill");
    const directoryReference = { name: first.name, path: path.dirname(first.path) };
    const preparation = await Effect.runPromise(
      prepareOmpExpertSession({
        cwd,
        env: { HOME: root },
        skills: [directoryReference, second],
        runCli: makeRunner({ cwd, skills: [directoryReference, second] }),
      }),
    );

    expect(preparation.issues).toEqual([]);
    expect(preparation.loadedSkills).toEqual([
      { name: first.name, path: first.path },
      { name: second.name, path: second.path },
    ]);
    const overlay = parseYaml(await readFile(preparation.configOverlayPath!, "utf8")) as {
      skills: { customDirectories: ReadonlyArray<string> };
    };
    expect(overlay.skills.customDirectories).toEqual([
      path.dirname(path.dirname(await realpath(first.path))),
      path.dirname(path.dirname(await realpath(second.path))),
      "/existing/native-skills",
    ]);
    await Effect.runPromise(preparation.cleanup());
  });

  it("blocks duplicate Expert skill names before native loading", async () => {
    const root = await makeRoot();
    const cwd = path.join(root, "project");
    const first = await createSkill(path.join(root, "first"), "duplicate");
    const second = await createSkill(path.join(root, "second"), "duplicate");
    const calls: Array<ReadonlyArray<string>> = [];
    const preparation = await Effect.runPromise(
      prepareOmpExpertSession({
        cwd,
        env: { HOME: root },
        skills: [first, second],
        runCli: makeRunner({ cwd, skills: [first, second], calls }),
      }),
    );

    expect(preparation.issues.join(" ")).toContain("same-name conflict");
    expect(calls.some((args) => args[0] === "skill")).toBe(false);
  });

  it("fails closed for unverified CLI versions and cleans up failed probes", async () => {
    const root = await makeRoot();
    const cwd = path.join(root, "project");
    const skill = await createSkill(root);
    const tempDirectory = path.join(root, "temp");
    await mkdir(tempDirectory);
    const preparation = await Effect.runPromise(
      prepareOmpExpertSession({
        ...baseInput(cwd, makeRunner({ cwd, skills: [skill], version: "omp/18.12.2" }), [skill]),
        tempDirectory,
      }),
    );

    expect(preparation.issues.join(" ")).toContain("no verified Expert projection contract");
    expect(preparation.configOverlayPath).toBeUndefined();
    expect(await readdir(tempDirectory)).toEqual([]);
    await Effect.runPromise(preparation.cleanup());
  });

  it("fails closed when OMP cannot confirm config-overlay effectiveness", async () => {
    const root = await makeRoot();
    const cwd = path.join(root, "project");
    const skill = await createSkill(root);
    const tempDirectory = path.join(root, "temp");
    await mkdir(tempDirectory);
    const preparation = await Effect.runPromise(
      prepareOmpExpertSession({
        ...baseInput(cwd, makeRunner({ cwd, skills: [skill], failOverlayCheck: true }), [skill]),
        tempDirectory,
      }),
    );

    expect(preparation.issues.join(" ")).toContain("did not confirm the Expert skills overlay");
    expect(await readdir(tempDirectory)).toEqual([]);
  });
});

describe("OMP fixed native Skill preparation", () => {
  async function fixedFixture(empty = false) {
    const root = await makeRoot(),
      packageSource = path.join(root, "package"),
      skillPath = path.join(packageSource, "skills", "reviewer", "SKILL.md");
    await mkdir(path.join(path.dirname(skillPath), "assets"), { recursive: true });
    await writeFile(
      skillPath,
      "---\nname: reviewer\ndescription: Review with care.\n---\nInstructions; read assets/guide.txt relative to this Skill.\n",
    );
    await writeFile(path.join(path.dirname(skillPath), "assets", "guide.txt"), "Fixture guide.\n");
    const entries: Array<NonNullable<ProviderExpertSession["skillEntries"]>[number]> = [];
    let resources: ReadonlyArray<SkillPackageResource> = [];
    if (!empty) {
      const store = createSkillPackageStore(path.join(root, "state"));
      const preview = await store.preview({ path: packageSource });
      const imported = await store.import({ previewId: preview.previewId });
      resources = imported.package.resources;
      entries.push(
        ...(await store.resolveSelections([
          {
            packageId: imported.package.packageId,
            entryPath: "skills/reviewer/SKILL.md",
            activation: "on-demand",
          },
        ])),
      );
    }
    const session: ProviderExpertSession = {
      snapshotId: `exp_${"e".repeat(64)}`,
      persona: "Fixed Expert",
      skillPolicy: FIXED_EXPERT_SKILL_POLICY,
      skillLoading: "index",
      skills: entries.map(({ name, path }) => ({ name, path })),
      skillEntries: entries,
      references: [],
    };
    return { root, session, resources };
  }
  it("keeps temp and shared package inode untouched when leaf unlink reports EPERM", async () => {
    const root = await makeRoot();
    const packageFile = path.join(root, "package", "SKILL.md");
    const staging = path.join(root, "synara-omp-expert-staging");
    const projectionFile = path.join(staging, "entry", "SKILL.md");
    await mkdir(path.dirname(packageFile), { recursive: true });
    await mkdir(path.dirname(projectionFile), { recursive: true });
    await writeFile(packageFile, "immutable source\n");
    await chmod(packageFile, 0o400);
    await link(packageFile, projectionFile);
    await chmod(path.dirname(projectionFile), 0o500);
    await chmod(staging, 0o500);
    const [beforeInfo, beforeBytes] = await Promise.all([stat(packageFile), readFile(packageFile)]);
    const fileSystem: NonNullable<Parameters<typeof removeFixedProjectionStaging>[1]> = {
      lstat,
      readdir,
      chmod,
      unlink: async (target) => {
        if (target === projectionFile) {
          throw Object.assign(new Error("simulated Windows read-only unlink"), { code: "EPERM" });
        }
        await unlink(target);
      },
      rmdir,
    };

    await expect(removeFixedProjectionStaging(staging, fileSystem)).rejects.toMatchObject({
      code: "EPERM",
    });
    await expect(stat(projectionFile)).resolves.toBeDefined();
    await expect(stat(staging)).resolves.toBeDefined();
    const [afterInfo, afterBytes] = await Promise.all([stat(packageFile), readFile(packageFile)]);
    expect({ dev: afterInfo.dev, ino: afterInfo.ino, mode: afterInfo.mode & 0o777 }).toEqual({
      dev: beforeInfo.dev,
      ino: beforeInfo.ino,
      mode: 0o400,
    });
    expect(createHash("sha256").update(afterBytes).digest("hex")).toEqual(
      createHash("sha256").update(beforeBytes).digest("hex"),
    );
    await removeFixedProjectionStaging(staging);
  });
  function fixedRunner(control: {
    foreign?: boolean;
    subagents?: boolean;
    advisor?: boolean;
    ambientSource?: boolean;
  }): OmpExpertSessionPreparationInput["runCli"] {
    return (args, _cwd, env) =>
      Effect.tryPromise({
        try: async () => {
          if (args[0] === "--version") return result("omp/18.12.1");
          if (args[0] === "config" && !env.PI_CONFIG_FILES)
            return result(JSON.stringify(nativeConfig()));
          const file = env.PI_CONFIG_FILES!.split(path.delimiter).at(-1)!,
            config = parseYaml(await readFile(file, "utf8")) as {
              skills: Record<string, unknown>;
              task: { maxRecursionDepth: number };
              advisor: { enabled: boolean };
            };
          if (args[0] === "config") {
            const values: Record<string, { value: unknown }> = {};
            for (const [key, value] of Object.entries(config.skills))
              values[`skills.${key}`] = { value };
            values["task.maxRecursionDepth"] = {
              value: control.subagents ? 0 : config.task.maxRecursionDepth,
            };
            values["advisor.enabled"] = { value: control.advisor ? true : config.advisor.enabled };
            if (control.ambientSource) values["skills.enableAgentsProject"] = { value: true };
            return result(JSON.stringify(values));
          }
          const skills = [];
          for (const directory of config.skills.customDirectories as string[])
            for (const name of await readdir(directory))
              skills.push({
                name,
                description: "Selected Skill",
                filePath: path.join(directory, name, "SKILL.md"),
              });
          if (control.foreign)
            skills.push({
              name: skills[0]?.name ?? "ambient-c",
              description: "Unselected impostor",
              filePath: "/outside/ambient/SKILL.md",
            });
          return result(JSON.stringify({ skills, warnings: [] }));
        },
        catch: (error) => error,
      });
  }
  it.each([false, true])(
    "fixes every source/filter and native subagent gate (empty=%s), then checks reloads",
    async (empty) => {
      const { root, session } = await fixedFixture(empty),
        control: { foreign?: boolean } = {};
      const preparation = await Effect.runPromise(
        prepareOmpExpertSession({
          cwd: root,
          env: { HOME: root },
          expertSession: session,
          lifecycleGeneration: "fixed-preparation-generation",
          tempDirectory: root,
          runCli: fixedRunner(control),
        }),
      );
      expect(preparation.issues).toEqual([]);
      expect(preparation.loadedSkills).toEqual(session.skills);
      expect(preparation.verify).toBeTypeOf("function");
      await Effect.runPromise(preparation.verify!());
      const config = parseYaml(await readFile(preparation.configOverlayPath!, "utf8")) as {
        skills: Record<string, unknown>;
        task: { maxRecursionDepth: number };
        advisor: { enabled: boolean };
      };
      expect(config.advisor.enabled).toBe(false);
      expect(config.task.maxRecursionDepth).toBe(1);
      for (const key of [
        "enableCodexUser",
        "enableClaudeUser",
        "enableClaudeProject",
        "enablePiUser",
        "enablePiProject",
        "enableAgentsUser",
        "enableAgentsProject",
      ])
        expect(config.skills[key]).toBe(false);
      control.foreign = true;
      await expect(Effect.runPromise(preparation.verify!())).rejects.toThrow(
        /unselected|catalog/iu,
      );
      await Effect.runPromise(preparation.cleanup());
      await expect(stat(preparation.configOverlayPath!)).rejects.toThrow();
    },
  );
  it.each(["foreign", "subagents", "advisor", "ambientSource"] as const)(
    "fails closed on native %s and cleans its owned projection",
    async (failure) => {
      const { root, session } = await fixedFixture();
      const preparation = await Effect.runPromise(
        prepareOmpExpertSession({
          cwd: root,
          env: { HOME: root },
          expertSession: session,
          lifecycleGeneration: "fixed-preparation-generation",
          tempDirectory: root,
          runCli: fixedRunner({ [failure]: true }),
        }),
      );
      expect(preparation.issues.length).toBeGreaterThan(0);
      expect(preparation.loadedSkills).toEqual([]);
      expect((await readdir(root)).some((name) => name.startsWith("synara-omp-expert-"))).toBe(
        false,
      );
    },
  );
  it("preserves the effective native append instructions while fixing Skills", async () => {
    const { root, session, resources } = await fixedFixture();
    await mkdir(path.join(root, ".omp"));
    await writeFile(path.join(root, ".omp", "APPEND_SYSTEM.md"), "Native project instructions.");
    const preparation = await Effect.runPromise(
      prepareOmpExpertSession({
        cwd: root,
        env: { HOME: root },
        expertSession: session,
        lifecycleGeneration: "fixed-preparation-generation",
        tempDirectory: root,
        runCli: fixedRunner({}),
      }),
    );
    expect(preparation.issues).toEqual([]);
    const prompt = await readFile(preparation.appendSystemPromptPath!, "utf8");
    expect(prompt).toContain("Native project instructions.");
    expect(prompt).toContain("Fixed Expert");
    const entry = session.skillEntries![0]!;
    const packageRoot = path.join(
      root,
      "state",
      "experts",
      "skill-packages",
      entry.packageId,
      "content",
    );
    const immutableFiles = await Promise.all(
      resources
        .filter((resource) => resource.kind === "file")
        .map(async (resource) => {
          const filePath = path.join(
            packageRoot,
            ...resource.path.slice("content/".length).split("/"),
          );
          const [info, bytes] = await Promise.all([stat(filePath), readFile(filePath)]);
          return {
            filePath,
            dev: info.dev,
            ino: info.ino,
            mode: info.mode & 0o777,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          };
        }),
    );
    expect(immutableFiles).toHaveLength(2);
    expect(immutableFiles.every((file) => file.mode === 0o400)).toBe(true);
    const tempRoot = path.dirname(preparation.configOverlayPath!);
    await Effect.runPromise(preparation.cleanup());
    await expect(stat(tempRoot)).rejects.toThrow();
    for (const before of immutableFiles) {
      const [after, bytes] = await Promise.all([stat(before.filePath), readFile(before.filePath)]);
      expect({ dev: after.dev, ino: after.ino, mode: after.mode & 0o777 }).toEqual({
        dev: before.dev,
        ino: before.ino,
        mode: before.mode,
      });
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(before.sha256);
    }
  });
  it.each(["configOverlayPath", "appendSystemPromptPath"] as const)(
    "revokes prior native proof when the read-only %s changes",
    async (fileKey) => {
      const { root, session } = await fixedFixture();
      const preparation = await Effect.runPromise(
        prepareOmpExpertSession({
          cwd: root,
          env: { HOME: root },
          expertSession: session,
          lifecycleGeneration: "fixed-preparation-generation",
          tempDirectory: root,
          runCli: fixedRunner({}),
        }),
      );
      expect(preparation.issues).toEqual([]);
      const receipt = () =>
        createExpertSkillApplication({
          session,
          instructions: "fixed",
          lifecycleGeneration: "fixed-preparation-generation",
        });
      expect(receipt().enforcement).toBe("native-fixed");
      const originalContent = await readFile(preparation[fileKey]!, "utf8");
      await chmod(preparation[fileKey]!, 0o600);
      await expect(Effect.runPromise(preparation.verify!())).rejects.toThrow(/read-only/iu);
      expect(receipt).toThrow(/native verification/iu);
      await chmod(preparation[fileKey]!, 0o400);
      await Effect.runPromise(preparation.verify!());
      expect(receipt().enforcement).toBe("native-fixed");
      await chmod(preparation[fileKey]!, 0o600);
      await writeFile(
        preparation[fileKey]!,
        `${originalContent}\n# Changed after native catalog resolution.\n`,
      );
      await chmod(preparation[fileKey]!, 0o400);
      await expect(Effect.runPromise(preparation.verify!())).rejects.toThrow(/content changed/iu);
      expect(receipt).toThrow(/native verification/iu);
      await Effect.runPromise(preparation.cleanup());
    },
  );
});
