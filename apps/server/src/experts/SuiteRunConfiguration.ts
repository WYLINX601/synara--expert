import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { EffectiveSuiteConfig, SuiteDefaults, SuiteIssue } from "@synara/contracts";
import { mergeBmadCustomization, readSuiteSourceFile } from "../suites/SuiteSourceAdapters";

const CONFIGURATION_LAYERS = [
  { sourceId: "_bmad/config.toml", layer: "project" },
  { sourceId: "_bmad/custom/config.toml", layer: "project" },
  { sourceId: "_bmad/custom/config.user.toml", layer: "personal" },
] as const;
const MAX_CONFIGURATION_BYTES = 128 * 1024;

function isTable(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Date.prototype
  );
}

/** Resolve only supported central configuration. No scripts, arbitrary config, or credentials are published. */
export async function resolveSuiteRunConfiguration(input: {
  readonly defaults?: SuiteDefaults;
  readonly suiteId?: string;
  readonly projectRoot?: string;
  readonly createdAt: string;
  /** The Run owner's diagnostic collection; later resource diagnostics use the same collection. */
  readonly issues: SuiteIssue[];
}): Promise<EffectiveSuiteConfig> {
  const provenance: EffectiveSuiteConfig["provenance"][number][] = [];
  let language: string | null = null,
    outputDirectory: string | null = null;
  let projectRoot: string | undefined;
  if (input.projectRoot) {
    try {
      projectRoot = await fs.realpath(input.projectRoot);
    } catch {
      projectRoot = undefined;
    }
  }
  const issue = (
    sourceId: string,
    field: "language" | "outputDirectory" | "configuration",
    unsafe = false,
  ) => {
    input.issues.push({
      code: unsafe ? "unsafe_path" : "resource_corrupt",
      category: unsafe ? "security" : "dependency",
      subject: {
        kind: "resource",
        id: sourceId,
        path: sourceId.startsWith("_bmad/") ? sourceId : null,
      },
      action: unsafe ? "tool-call" : "run",
      effect: unsafe ? "deny-action" : "limit-capability",
      message: unsafe
        ? "The configured output directory is not a safe location inside this project. That output destination is unavailable for this Run."
        : `The ${field} setting could not be read as supported project configuration. Only the affected fixed configuration is unavailable.`,
      evidenceRef: null,
      checkedAt: input.createdAt,
      recovery: "repair-source",
    });
  };
  const outputWithinProject = async (value: string): Promise<string | null> => {
    if (!projectRoot || !value.trim() || value.length > 4096 || /[\p{Cc}]/u.test(value))
      return null;
    const expanded = value.replaceAll("{project-root}", projectRoot);
    if (
      /[{}]/u.test(value.replaceAll("{project-root}", "")) ||
      (process.platform !== "win32" && (/^[a-z]:/iu.test(expanded) || expanded.includes("\\")))
    )
      return null;
    let target = path.resolve(projectRoot, expanded);
    let relative = path.relative(projectRoot, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      return null;
    const parts = relative.split(path.sep).filter(Boolean);
    for (let index = 0; index < parts.length; index += 1) {
      const ancestor = path.join(projectRoot, ...parts.slice(0, index + 1));
      const stat = await fs.lstat(ancestor).catch((cause: unknown) => {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw cause;
      });
      if (!stat) break;
      if (!stat.isDirectory() && !stat.isSymbolicLink()) return null;
      if (stat.isSymbolicLink()) {
        const canonical = await fs.realpath(ancestor);
        const inside = path.relative(projectRoot, canonical);
        if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside))
          return null;
        if (!(await fs.stat(canonical)).isDirectory()) return null;
        target = path.resolve(canonical, ...parts.slice(index + 1));
      }
    }
    relative = path.relative(projectRoot, target);
    return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      ? null
      : relative.split(path.sep).join("/") || ".";
  };
  const apply = async (
    field: "language" | "outputDirectory",
    value: unknown,
    sourceId: string,
    layer: EffectiveSuiteConfig["provenance"][number]["layer"],
  ) => {
    if (field === "language") {
      language =
        typeof value === "string" &&
        value.trim().length > 0 &&
        value.trim().length <= 200 &&
        !/[\p{Cc}]/u.test(value)
          ? value.trim()
          : null;
      if (language === null) issue(sourceId, field);
      else provenance.push({ field, layer, sourceId, value: language });
    } else {
      try {
        outputDirectory = typeof value === "string" ? await outputWithinProject(value) : null;
      } catch {
        outputDirectory = null;
      }
      if (outputDirectory === null) issue(sourceId, field, typeof value === "string");
      else provenance.push({ field, layer, sourceId, value: outputDirectory });
    }
  };
  if (input.defaults?.language !== undefined)
    await apply("language", input.defaults.language, input.suiteId ?? "suite-defaults", "suite");
  if (input.defaults?.outputDirectory !== undefined)
    await apply(
      "outputDirectory",
      input.defaults.outputDirectory,
      input.suiteId ?? "suite-defaults",
      "suite",
    );
  if (projectRoot) {
    let merged: unknown = {};
    for (const { sourceId, layer } of CONFIGURATION_LAYERS) {
      let parsed: unknown;
      try {
        const stat = await fs.lstat(path.join(projectRoot, sourceId));
        if (stat.size > MAX_CONFIGURATION_BYTES)
          throw new Error("Configuration exceeds the supported byte limit.");
        const bytes = await readSuiteSourceFile(projectRoot, sourceId);
        if (bytes.byteLength > MAX_CONFIGURATION_BYTES)
          throw new Error("Configuration exceeds the supported byte limit.");
        const text = bytes.toString("utf8");
        if (!Buffer.from(text).equals(bytes)) throw new Error("Configuration is not UTF-8.");
        parsed = parseToml(text);
        if (!isTable(parsed) || (Object.hasOwn(parsed, "core") && !isTable(parsed.core)))
          throw new Error("Configuration core is not a table.");
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue;
        // A broken layer cannot silently grant a lower/default value. Later valid overrides may restore each field.
        language = null;
        outputDirectory = null;
        merged = {};
        issue(sourceId, "configuration");
        continue;
      }
      if (!isTable(parsed) || !isTable(parsed.core)) continue;
      const supported: Record<string, unknown> = {};
      for (const key of ["communication_language", "output_folder"])
        if (Object.hasOwn(parsed.core, key)) supported[key] = parsed.core[key];
      merged = mergeBmadCustomization(merged, { core: supported });
      if (!isTable(merged) || !isTable(merged.core)) continue;
      if (Object.hasOwn(supported, "communication_language"))
        await apply("language", merged.core.communication_language, sourceId, layer);
      if (Object.hasOwn(supported, "output_folder"))
        await apply("outputDirectory", merged.core.output_folder, sourceId, layer);
    }
  }
  return { language, outputDirectory, provenance, issues: input.issues };
}
