import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import {
  BMAD_PRESET_COMMIT,
  BMAD_ROLE_PRESETS,
  bmadPresetSelections,
} from "../../apps/server/src/experts/bmadSkillPreset.ts";
import { createExpertStore } from "../../apps/server/src/experts/ExpertStore.ts";
import { createSkillPackageStore } from "../../apps/server/src/experts/SkillPackageStore.ts";
import { ExpertDefinition } from "@synara/contracts";
import { Schema } from "effect";

// Run with Bun from the repository root. All writes go into a newly created
// output directory; the installed package, existing definitions and project are read-only inputs.
const [sourceArg, definitionsArg, projectArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !definitionsArg || !projectArg || !outputArg)
  throw new Error(
    "Usage: bun scripts/expert-p0/skill-packages-local.ts <BMad-install> <definitions> <project> <new-output-dir>",
  );
const source = path.resolve(sourceArg);
const definitions = path.resolve(definitionsArg);
const project = path.resolve(projectArg);
const output = path.resolve(outputArg);
await fs.mkdir(output, { mode: 0o700 });
const stateDir = path.join(output, "state");
const projectCopy = path.join(output, "project");
await fs.mkdir(projectCopy, { mode: 0o700 });
await fs.cp(path.join(project, "_bmad"), path.join(projectCopy, "_bmad"), {
  recursive: true,
  errorOnExist: true,
});
const lock = JSON.parse(
  await fs.readFile(path.join(source, "synara-bmad", "SOURCE_LOCK.json"), "utf8"),
) as {
  commit: string;
  skills: Array<{ files: Array<{ path: string; sha256: string }> }>;
};
assert.equal(lock.commit, BMAD_PRESET_COMMIT);
let verifiedFiles = 0;
for (const file of lock.skills.flatMap((skill) => skill.files)) {
  assert(!file.path.includes("..") && !path.isAbsolute(file.path));
  const bytes = await fs.readFile(path.join(source, "skills", file.path));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256, file.path);
  verifiedFiles += 1;
}
const packages = createSkillPackageStore(stateDir);
const importStart = performance.now();
const preview = await packages.preview({ path: path.join(source, "skills") });
const imported = await packages.import({
  previewId: preview.previewId,
  idempotencyKey: "bmad-fixed-version",
});
const importMs = performance.now() - importStart;
assert.equal(
  imported.package.fileCount,
  verifiedFiles,
  "Unexpected files outside the pinned source inventory",
);
const experts = createExpertStore(stateDir);
const results = [];
for (const preset of BMAD_ROLE_PRESETS) {
  const original = Schema.decodeUnknownSync(ExpertDefinition)(
    JSON.parse(await fs.readFile(path.join(definitions, `${preset.id}.json`), "utf8")),
  );
  // Exact, reviewable removal of only the obsolete bridge routing sentence.
  const bridge = `开始任务时先加载所绑定的 synara-bmad Skill，再按它的路径映射加载并执行官方 ${preset.role}/SKILL.md。`;
  assert(original.persona.includes(bridge), `Unexpected Persona routing for ${preset.id}`);
  const persona = original.persona.replace(bridge, "");
  const converted = await experts.save({
    ...original,
    persona,
    skills: [],
    skillSelections: bmadPresetSelections(imported.package, preset.id),
  });
  const start = performance.now();
  const binding = await experts.prepareSnapshot(converted.id);
  const snapshot = await experts.readSnapshot(binding.snapshotId);
  const snapshotMs = performance.now() - start;
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.persona, persona);
  const role = snapshot.skillEntries!.find((entry) => entry.name === preset.role)!;
  assert.equal(role.name, preset.role);
  assert.equal(path.basename(path.dirname(role.path)), preset.role);
  assert(
    !(await fs.readdir(path.join(stateDir, "experts", "snapshots", binding.snapshotId))).includes(
      "skills",
    ),
  );
  results.push({
    expertId: preset.id,
    snapshotId: binding.snapshotId,
    packageId: imported.package.packageId,
    rolePath: role.path,
    selectedEntries: snapshot.skillEntries!.map((entry) => entry.entryPath),
    snapshotMs,
    preflight,
    personaChange: { before: original.persona, after: persona },
  });
}
assert.equal((await packages.list()).length, 1);
await fs.writeFile(
  path.join(output, "result.json"),
  JSON.stringify(
    {
      sourceCommit: lock.commit,
      verifiedFiles,
      packageId: imported.package.packageId,
      fileCount: imported.package.fileCount,
      totalBytes: imported.package.totalBytes,
      importMs,
      stateDir,
      projectCopy,
      results,
      realModelExecution: "not-run",
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    result: path.join(output, "result.json"),
    verifiedFiles,
    roleCount: results.length,
    importMs,
  }),
);
