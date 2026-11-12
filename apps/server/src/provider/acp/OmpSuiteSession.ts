import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { Effect } from "effect";
import type { SuiteRuntimeContext } from "../../experts/SuiteRunMaterialization";
import {
  parseNativeSkillList,
  parseOmpExpertCliVersion,
  type OmpExpertSessionPreparation,
  type OmpExpertCliRunner,
} from "./OmpExpertSession";
import { renderSuiteRuntimeInstructions } from "../suiteRuntimeInstructions";

/** Coordinator resources are projected directly; there is deliberately no Expert persona/session. */
export function prepareOmpSuiteCoordinator(
  context: SuiteRuntimeContext,
  input: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly runCli: OmpExpertCliRunner;
    readonly contextText?: string;
  },
): Effect.Effect<OmpExpertSessionPreparation, Error> {
  return Effect.tryPromise({
    try: async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "synara-omp-suite-"));
      try {
        const configOverlayPath = path.join(directory, "config.yml"),
          appendSystemPromptPath = path.join(directory, "APPEND_SYSTEM.md");
        const entries = context.skillEntries;
        const runtimeEntries = entries.map((entry) => {
          const resource = context.resources.find((item) => item.packageId === entry.packageId);
          const root =
            resource &&
            context.resourceRoots.find(
              (item) => item.contentHash === resource.contentHash && item.mode === resource.mode,
            );
          return {
            ...entry,
            path: root ? path.join(root.path, ...entry.entryPath.split("/")) : entry.path,
          };
        });
        const roots = [
          ...new Set(runtimeEntries.map((entry) => path.dirname(path.dirname(entry.path)))),
        ];
        const overlay = stringifyYaml({
          skills: {
            enabled: true,
            enableCodexUser: false,
            enableClaudeUser: false,
            enableClaudeProject: false,
            enablePiUser: false,
            enablePiProject: false,
            enableAgentsUser: false,
            enableAgentsProject: false,
            customDirectories: roots,
            includeSkills: entries.length
              ? entries.map((entry) => entry.name)
              : ["__synara_empty_suite_assembly__"],
            ignoredSkills: [],
          },
          task: { maxRecursionDepth: 1 },
          advisor: { enabled: false },
          autolearn: { enabled: false, autoContinue: false },
        });
        const instructions = [input.contextText, renderSuiteRuntimeInstructions(context)]
          .filter(Boolean)
          .join("\n\n");
        await writeFile(configOverlayPath, overlay, { mode: 0o400 });
        await writeFile(appendSystemPromptPath, instructions, { mode: 0o400 });
        const env = {
          ...input.env,
          PI_CONFIG_FILES: [input.env.PI_CONFIG_FILES, configOverlayPath]
            .filter(Boolean)
            .join(path.delimiter),
        };
        const version = await Effect.runPromise(input.runCli(["--version"], input.cwd, env));
        const cliVersion =
          version.exitCode === 0 ? parseOmpExpertCliVersion(version.stdout) : undefined;
        if (!cliVersion)
          throw new Error("OMP could not identify its runtime for Suite projection.");
        const verify = () =>
          Effect.tryPromise({
            try: async () => {
              if (
                (await readFile(configOverlayPath, "utf8")) !== overlay ||
                (await readFile(appendSystemPromptPath, "utf8")) !== instructions
              )
                throw new Error("Suite runtime projection changed.");
              const configResult = await Effect.runPromise(
                input.runCli(["config", "list", "--json"], input.cwd, env),
              );
              if (configResult.exitCode !== 0)
                throw new Error("OMP could not read the actual Suite configuration.");
              const config = JSON.parse(configResult.stdout) as Record<string, { value?: unknown }>;
              for (const key of [
                "enableCodexUser",
                "enableClaudeUser",
                "enableClaudeProject",
                "enablePiUser",
                "enablePiProject",
                "enableAgentsUser",
                "enableAgentsProject",
              ])
                if (config[`skills.${key}`]?.value !== false)
                  throw new Error(
                    "OMP did not isolate an ambient Skill source from the Suite coordinator.",
                  );
              if (
                config["skills.enabled"]?.value !== true ||
                config["autolearn.enabled"]?.value !== false ||
                config["autolearn.autoContinue"]?.value !== false ||
                config["advisor.enabled"]?.value !== false ||
                config["task.maxRecursionDepth"]?.value !== 1 ||
                JSON.stringify(config["skills.customDirectories"]?.value) !==
                  JSON.stringify(roots) ||
                JSON.stringify(config["skills.includeSkills"]?.value) !==
                  JSON.stringify(
                    entries.length
                      ? entries.map((entry) => entry.name)
                      : ["__synara_empty_suite_assembly__"],
                  )
              )
                throw new Error("OMP did not attest the fixed Suite configuration.");
              const result = await Effect.runPromise(
                input.runCli(["skill", "list", input.cwd, "--json"], input.cwd, env),
              );
              const catalog =
                result.exitCode === 0 ? parseNativeSkillList(result.stdout) : undefined;
              if (!catalog)
                throw new Error("OMP could not resolve the actual Suite Skill catalog.");
              const visible = catalog.skills.filter((entry) => !entry.hide);
              if (
                visible.length !== runtimeEntries.length ||
                runtimeEntries.some(
                  (entry) =>
                    visible.filter(
                      (native) =>
                        native.name === entry.name && path.resolve(native.filePath) === entry.path,
                    ).length !== 1,
                )
              )
                throw new Error("OMP did not load the exact Suite coordinator Skill catalog.");
              for (const entry of runtimeEntries)
                if (
                  entry.sha256 &&
                  createHash("sha256")
                    .update(await readFile(entry.path))
                    .digest("hex") !== entry.sha256
                )
                  throw new Error("Suite Skill bytes changed after projection.");
            },
            catch: (cause) => cause,
          });
        await Effect.runPromise(verify());
        return {
          issues: [],
          cliVersion,
          instructionsHash: createHash("sha256").update(instructions).digest("hex"),
          loadedSkills: runtimeEntries.map(({ name, path }) => ({ name, path })),
          configOverlayPath,
          appendSystemPromptPath,
          ownedTempDirectory: directory,
          cleanup: () => Effect.promise(() => rm(directory, { recursive: true, force: true })),
          verify,
          allowedSkillCommands: entries.map((entry) => entry.name),
        };
      } catch (cause) {
        await rm(directory, { recursive: true, force: true });
        throw cause;
      }
    },
    catch: (cause) =>
      cause instanceof Error ? cause : new Error("Suite runtime projection failed."),
  });
}
