#!/usr/bin/env node
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.argv[2];
const errors = [];
const warnings = [];
const fail = (message) => errors.push(message);
const warn = (message) => warnings.push(message);

if (!ROOT) {
  console.error("Usage: node scripts/validate-suite.mjs <suite-root>");
  process.exit(2);
}

const suiteRoot = path.resolve(ROOT);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;
const safeRelative = (value, label, { allowDot = false } = {}) => {
  if (typeof value !== "string" || !value.trim()) {
    fail(`${label} must be a non-empty string.`);
    return false;
  }
  if (allowDot && value === ".") return true;
  if (
    path.isAbsolute(value) ||
    value.includes("\\") ||
    /[\p{Cc}]/u.test(value) ||
    value !== value.normalize("NFC") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail(`${label} must be a safe relative path inside the suite source: ${value}`);
    return false;
  }
  return true;
};

const lstatPath = async (target, label) => {
  try {
    return await lstat(target);
  } catch (cause) {
    fail(`${label} is missing: ${target}${cause?.code ? ` (${cause.code})` : ""}`);
    return null;
  }
};

const checkPath = async (relative, label, kind) => {
  if (!safeRelative(relative, label, { allowDot: kind === "directory" })) return;
  const target = path.resolve(suiteRoot, relative);
  const within = path.relative(suiteRoot, target);
  if (within.startsWith("..") || path.isAbsolute(within)) {
    fail(`${label} escapes the suite source: ${relative}`);
    return;
  }
  const parts = within === "" ? [] : within.split(path.sep);
  for (let index = 0; index < parts.length; index += 1) {
    const current = path.join(suiteRoot, ...parts.slice(0, index + 1));
    const stat = await lstatPath(current, label);
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      fail(`${label} contains a symbolic link: ${current}`);
      return;
    }
    const final = index === parts.length - 1;
    if (final) {
      if (kind === "file" && !stat.isFile()) fail(`${label} must be a regular file: ${relative}`);
      if (kind === "directory" && !stat.isDirectory())
        fail(`${label} must be a directory: ${relative}`);
    } else if (!stat.isDirectory()) {
      fail(`${label} has a non-directory component: ${current}`);
      return;
    }
  }
};

const readUtf8 = async (relative, label) => {
  const target = path.resolve(suiteRoot, relative);
  const bytes = await readFile(target);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) fail(`${label} must be UTF-8: ${relative}`);
  return text;
};

const checkString = (value, label, max) => {
  if (!isNonEmptyString(value)) {
    fail(`${label} must be a non-empty string.`);
    return;
  }
  if (value.length > max) fail(`${label} exceeds ${max} characters.`);
};

const checkOptionalStringArray = (value, label) => {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    fail(`${label} must be an array.`);
    return;
  }
  for (const [index, item] of value.entries()) checkString(item, `${label}[${index}]`, 200);
};

const allowedTop = new Set([
  "schemaVersion",
  "name",
  "description",
  "experts",
  "resources",
  "sharedResourceKeys",
  "coordinatorResourceKeys",
  "defaults",
]);
const allowedExpert = new Set([
  "key",
  "kind",
  "name",
  "personaPath",
  "description",
  "resourceKeys",
]);
const allowedReference = new Set(["key", "kind", "expertId"]);
const allowedResource = new Set([
  "key",
  "kind",
  "packageRoot",
  "entryPath",
  "root",
  "purpose",
  "connectionId",
  "tools",
  "resourceRef",
]);
const filePurposes = new Set(["instructions", "reference", "template", "workflow"]);
const refKinds = new Set(["skill", "managed-skill", "files", "connection"]);

const checkUnknown = (value, allowed, label) => {
  for (const key of Object.keys(value))
    if (!allowed.has(key)) warn(`${label} has unsupported field "${key}"; it is preserved only.`);
};

try {
  const rootStat = await lstatPath(suiteRoot, "Suite source");
  if (rootStat && (!rootStat.isDirectory() || rootStat.isSymbolicLink()))
    fail(`Suite source must be a real directory, not a symlink or file: ${suiteRoot}`);
  if (!rootStat) throw new Error("suite root unavailable");

  const manifestPath = path.join(suiteRoot, "synara-suite.json");
  const manifestStat = await lstatPath(manifestPath, "synara-suite.json");
  if (!manifestStat) throw new Error("manifest unavailable");
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink())
    fail("synara-suite.json must be a regular file, not a symlink.");

  const rawBytes = await readFile(manifestPath);
  const rawText = rawBytes.toString("utf8");
  if (!Buffer.from(rawText).equals(rawBytes)) fail("synara-suite.json must be UTF-8.");
  let manifest;
  try {
    manifest = JSON.parse(rawText);
  } catch (cause) {
    fail(`synara-suite.json is not valid JSON: ${cause.message}`);
    throw new Error("invalid manifest");
  }
  if (!isObject(manifest)) {
    fail("synara-suite.json must contain a JSON object.");
    throw new Error("invalid manifest");
  }

  checkUnknown(manifest, allowedTop, "manifest");
  if (manifest.schemaVersion !== 1) fail("schemaVersion must be 1.");
  checkString(manifest.name, "name", 200);
  if (typeof manifest.description !== "string") fail("description must be a string.");
  else if (manifest.description.length > 16_000) fail("description exceeds 16000 characters.");

  if (!Array.isArray(manifest.experts) || manifest.experts.length === 0)
    fail("experts must be a non-empty array.");
  if (Array.isArray(manifest.experts) && manifest.experts.length > 5_000)
    fail("experts exceeds 5000 entries.");

  if (manifest.resources !== undefined && !Array.isArray(manifest.resources))
    fail("resources must be an array.");
  const resources = Array.isArray(manifest.resources) ? manifest.resources : [];
  if (resources.length > 5_000) fail("resources exceeds 5000 entries.");

  const keys = new Set();
  const resourceKeys = new Set();
  const addKey = (key, label) => {
    checkString(key, `${label}.key`, 200);
    if (typeof key === "string") {
      if (keys.has(key)) fail(`Duplicate package local key: ${key}`);
      keys.add(key);
    }
  };

  for (const [index, expert] of (Array.isArray(manifest.experts)
    ? manifest.experts
    : []
  ).entries()) {
    const label = `experts[${index}]`;
    if (!isObject(expert)) {
      fail(`${label} must be an object.`);
      continue;
    }
    checkUnknown(expert, expert.kind === "reference" ? allowedReference : allowedExpert, label);
    addKey(expert.key, label);
    if (expert.kind === "reference") {
      checkString(expert.expertId, `${label}.expertId`, 200);
      continue;
    }
    if (expert.kind !== "definition") {
      fail(`${label}.kind must be "definition" or "reference".`);
      continue;
    }
    checkString(expert.name, `${label}.name`, 200);
    if (typeof expert.description !== "string") fail(`${label}.description must be a string.`);
    else if (expert.description.length > 16_000)
      fail(`${label}.description exceeds 16000 characters.`);
    if (safeRelative(expert.personaPath, `${label}.personaPath`)) {
      await checkPath(expert.personaPath, `${label}.personaPath`, "file");
      try {
        const persona = await readUtf8(expert.personaPath, `${label}.personaPath`);
        if (!persona.trim()) fail(`${label}.personaPath is empty.`);
        if (persona.length > 32_000) fail(`${label}.personaPath exceeds 32000 characters.`);
      } catch (cause) {
        if (cause?.code !== "ENOENT") fail(`${label}.personaPath cannot be read: ${cause.message}`);
      }
    }
    checkOptionalStringArray(expert.resourceKeys, `${label}.resourceKeys`);
  }

  for (const [index, resource] of resources.entries()) {
    const label = `resources[${index}]`;
    if (!isObject(resource)) {
      fail(`${label} must be an object.`);
      continue;
    }
    checkUnknown(resource, allowedResource, label);
    addKey(resource.key, label);
    if (typeof resource.key === "string") resourceKeys.add(resource.key);
    if (!["skill", "files", "connection", "resource-reference"].includes(resource.kind)) {
      fail(`${label}.kind is unsupported.`);
      continue;
    }
    if (resource.kind === "skill") {
      const packageRoot = resource.packageRoot;
      if (!safeRelative(packageRoot, `${label}.packageRoot`, { allowDot: true })) continue;
      await checkPath(packageRoot, `${label}.packageRoot`, "directory");
      if (safeRelative(resource.entryPath, `${label}.entryPath`)) {
        if (path.posix.basename(resource.entryPath) !== "SKILL.md")
          fail(`${label}.entryPath must end with SKILL.md.`);
        const entry =
          packageRoot === "." ? resource.entryPath : `${packageRoot}/${resource.entryPath}`;
        await checkPath(entry, `${label}.entryPath`, "file");
      }
    } else if (resource.kind === "files") {
      if (!safeRelative(resource.root, `${label}.root`, { allowDot: true })) continue;
      await checkPath(resource.root, `${label}.root`, "directory");
      if (!filePurposes.has(resource.purpose)) fail(`${label}.purpose is unsupported.`);
    } else if (resource.kind === "connection") {
      checkString(resource.connectionId, `${label}.connectionId`, 200);
      if (!isObject(resource.tools)) fail(`${label}.tools must be an object.`);
      else if (resource.tools.mode === "all") {
        if (resource.tools.names !== undefined)
          warn(`${label}.tools.names is ignored when mode is "all".`);
      } else if (resource.tools.mode === "selected") {
        if (!Array.isArray(resource.tools.names) || resource.tools.names.length === 0)
          fail(`${label}.tools.names must be a non-empty array when mode is "selected".`);
        else checkOptionalStringArray(resource.tools.names, `${label}.tools.names`);
      } else fail(`${label}.tools.mode must be "all" or "selected".`);
      warn(
        `${label} references connection "${resource.connectionId}" outside this source; existence is checked on import.`,
      );
    } else {
      const ref = resource.resourceRef;
      if (!isObject(ref)) fail(`${label}.resourceRef must be an object.`);
      else if (!refKinds.has(ref.kind)) fail(`${label}.resourceRef.kind is unsupported.`);
      else {
        checkString(ref.sourceId, `${label}.resourceRef.sourceId`, 4000);
        if (ref.kind === "skill") {
          if (!isObject(ref.selection)) fail(`${label}.resourceRef.selection must be an object.`);
          else {
            checkString(ref.selection.packageId, `${label}.resourceRef.selection.packageId`, 200);
            safeRelative(ref.selection.entryPath, `${label}.resourceRef.selection.entryPath`);
          }
        } else if (ref.kind === "managed-skill") {
          checkString(ref.managedSkillId, `${label}.resourceRef.managedSkillId`, 200);
        } else if (ref.kind === "files") {
          checkString(ref.resourceId, `${label}.resourceRef.resourceId`, 200);
          if (!filePurposes.has(ref.purpose)) fail(`${label}.resourceRef.purpose is unsupported.`);
        } else {
          if (!isObject(ref.connection)) fail(`${label}.resourceRef.connection must be an object.`);
          else checkString(ref.connection.id, `${label}.resourceRef.connection.id`, 200);
        }
        warn(
          `${label} references existing ${ref.kind} data outside this source; existence is checked on import.`,
        );
      }
    }
  }

  for (const label of ["sharedResourceKeys", "coordinatorResourceKeys"]) {
    const value = manifest[label];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      fail(`${label} must be an array.`);
      continue;
    }
    for (const [index, key] of value.entries()) {
      checkString(key, `${label}[${index}]`, 200);
      if (typeof key === "string" && !resourceKeys.has(key))
        fail(`${label}[${index}] is not declared in resources: ${key}`);
    }
  }
  for (const [index, expert] of (Array.isArray(manifest.experts)
    ? manifest.experts
    : []
  ).entries()) {
    if (!isObject(expert) || !Array.isArray(expert.resourceKeys)) continue;
    for (const key of expert.resourceKeys)
      if (typeof key === "string" && !resourceKeys.has(key))
        fail(`experts[${index}].resourceKeys references an undeclared resource: ${key}`);
  }

  if (manifest.defaults !== undefined) {
    if (!isObject(manifest.defaults)) fail("defaults must be an object.");
    else {
      for (const key of Object.keys(manifest.defaults))
        if (!["language", "outputDirectory"].includes(key))
          warn(`defaults.${key} is unsupported and is preserved only.`);
      if (manifest.defaults.language !== undefined)
        checkString(manifest.defaults.language, "defaults.language", 200);
      if (manifest.defaults.outputDirectory !== undefined) {
        if (typeof manifest.defaults.outputDirectory !== "string")
          fail("defaults.outputDirectory must be a string.");
        else if (path.isAbsolute(manifest.defaults.outputDirectory))
          warn("defaults.outputDirectory is absolute; it may be rejected by the project boundary.");
      }
    }
  }
} catch (cause) {
  if (errors.length === 0) fail(cause instanceof Error ? cause.message : String(cause));
}

if (warnings.length) {
  console.log("Warnings:");
  for (const warning of warnings) console.log(`  - ${warning}`);
}
if (errors.length) {
  console.error("Errors:");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(`OK: ${suiteRoot}`);
