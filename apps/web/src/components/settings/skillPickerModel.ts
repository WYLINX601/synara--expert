// FILE: skillPickerModel.ts
// Purpose: Convert the mixed legacy/package Expert skill draft into package selections.
// Layer: Settings UI logic

import type {
  ExpertSaveInput,
  ExpertSkillSelection,
  ProviderSkillReference,
  SkillPackage,
  SkillPackagePreview,
} from "@synara/contracts";

import type { ExpertClient } from "~/workbench/host/expertClient";
import { expertSkillPathKey } from "./expertSkillsSettingsModel";
import { expertSkillSelectionKey } from "./expertSkillPackagesSettingsModel";

export type SkillPickerChoice =
  | { kind: "path"; reference: ProviderSkillReference }
  | { kind: "package"; selection: ExpertSkillSelection };

type SkillPackageClient = Pick<
  ExpertClient,
  "previewSkillPackage" | "importSkillPackage" | "readSkillPackage"
>;

type Candidate = {
  readonly kind: "path" | "package";
  readonly selection: ExpertSkillSelection;
  readonly entry: SkillPackage["entries"][number];
};

function ensureCurrent(isCurrent: () => boolean): void {
  if (!isCurrent()) throw new Error("当前技能选择已失效，请重试。");
}

async function awaitCurrent<T>(call: () => Promise<T>, isCurrent: () => boolean): Promise<T> {
  ensureCurrent(isCurrent);
  try {
    const result = await call();
    ensureCurrent(isCurrent);
    return result;
  } catch (error) {
    ensureCurrent(isCurrent);
    throw error;
  }
}

function entryForPath(
  reference: ProviderSkillReference,
  preview: SkillPackagePreview,
): SkillPackage["entries"][number] {
  const isSkillFile = reference.path.replaceAll("\\", "/").split("/").at(-1) === "SKILL.md";
  if (isSkillFile) {
    const entry = preview.package.entries.find((item) => item.entryPath === "SKILL.md");
    if (entry) return entry;
    throw new Error("所选 SKILL.md 入口不在技能包预览中。");
  }

  if (preview.package.entries.length === 1) return preview.package.entries[0]!;
  if (preview.package.entries.length > 1) {
    throw new Error("该目录包含多个技能，请在路径预览中选择具体入口。");
  }

  throw new Error("此路径没有对应的技能入口，请选择 SKILL.md 文件或在目录预览中选择具体入口。");
}

function validateCandidateSet(candidates: ReadonlyArray<Candidate>): void {
  if (candidates.length > 100) {
    throw new Error("一个 Expert 最多选择 100 个技能。");
  }

  let startupCount = 0;
  const names = new Set<string>();
  for (const candidate of candidates) {
    const { selection, entry } = candidate;
    if (!entry || entry.entryPath !== selection.entryPath) {
      throw new Error(`所选技能入口不可用：${selection.entryPath}`);
    }
    if (entry.incompatibleReason) {
      throw new Error(`技能 ${entry.name} 不兼容：${entry.incompatibleReason}`);
    }
    if (selection.activation === "startup") {
      startupCount += 1;
      if (entry.disableModelInvocation) {
        throw new Error(`技能 ${entry.name} 已禁用自动调用，不能设为启动时加载。`);
      }
    }
    const normalizedName = entry.name.normalize("NFC").toLowerCase();
    if (names.has(normalizedName)) {
      throw new Error(`所选技能名称不能重复：${entry.name}。`);
    }
    names.add(normalizedName);
  }
  if (startupCount > 1) {
    throw new Error("一个 Expert 最多设置一个启动时加载的技能。");
  }
}

export function choiceKey(choice: SkillPickerChoice): string {
  return choice.kind === "path"
    ? `path:${expertSkillPathKey(choice.reference.path)}`
    : `package:${expertSkillSelectionKey(choice.selection)}`;
}

export function choicesForExpert(
  config: Pick<ExpertSaveInput, "skills" | "skillSelections">,
): SkillPickerChoice[] {
  if (config.skillSelections !== undefined) {
    return config.skillSelections.map((selection) => ({
      kind: "package",
      selection: { ...selection },
    }));
  }
  return config.skills.map((reference) => ({
    kind: "path",
    reference: { ...reference, ...(reference.expert ? { expert: { ...reference.expert } } : {}) },
  }));
}

export async function resolveSkillChoices(
  choices: ReadonlyArray<SkillPickerChoice>,
  client: SkillPackageClient,
  preparedPreviews: ReadonlyMap<string, SkillPackagePreview> = new Map(),
  isCurrent: () => boolean = () => true,
): Promise<ExpertSkillSelection[]> {
  ensureCurrent(isCurrent);

  // Normalize/deduplicate paths and package entries before any RPC calls.
  const uniqueChoices: SkillPickerChoice[] = [];
  const seenChoiceKeys = new Set<string>();
  for (const choice of choices) {
    const key = choiceKey(choice);
    if (seenChoiceKeys.has(key)) continue;
    seenChoiceKeys.add(key);
    uniqueChoices.push(choice);
  }
  if (uniqueChoices.some((choice) => choice.kind === "path" && choice.reference.expert)) {
    throw new Error(
      "固定 Expert 快照引用不能按本机路径转换为技能包，请改为选择原 Expert 或技能包。",
    );
  }
  if (uniqueChoices.length > 100 && uniqueChoices.every((choice) => choice.kind === "package")) {
    throw new Error("一个 Expert 最多选择 100 个技能。");
  }

  const candidates: Candidate[] = [];
  const packagesById = new Map<string, SkillPackage>();
  const previewsByPackageId = new Map<string, SkillPackagePreview>();
  for (const choice of uniqueChoices) {
    ensureCurrent(isCurrent);
    if (choice.kind === "package") {
      const prepared = preparedPreviews.get(choice.selection.packageId);
      let manifest = packagesById.get(choice.selection.packageId) ?? prepared?.package;
      if (prepared && prepared.package.packageId !== choice.selection.packageId) {
        throw new Error(`技能包 ${choice.selection.packageId} 的预览无效。`);
      }
      if (!manifest) {
        manifest = await awaitCurrent(
          () => client.readSkillPackage({ packageId: choice.selection.packageId }),
          isCurrent,
        );
        if (manifest.packageId !== choice.selection.packageId) {
          throw new Error(`读取技能包时版本发生变化：${choice.selection.packageId}`);
        }
        packagesById.set(manifest.packageId, manifest);
      }
      if (prepared) previewsByPackageId.set(choice.selection.packageId, prepared);
      const entry = manifest.entries.find((item) => item.entryPath === choice.selection.entryPath);
      if (!entry) {
        throw new Error(
          `技能包 ${choice.selection.packageId} 中不存在所选入口：${choice.selection.entryPath}`,
        );
      }
      candidates.push({ kind: "package", selection: { ...choice.selection }, entry });
      continue;
    }

    const preview = await awaitCurrent(
      () => client.previewSkillPackage({ path: choice.reference.path }),
      isCurrent,
    );
    const entry = entryForPath(choice.reference, preview);
    const activation = "on-demand";
    previewsByPackageId.set(preview.package.packageId, preview);
    candidates.push({
      kind: "path",
      selection: {
        packageId: preview.package.packageId,
        entryPath: entry.entryPath,
        activation,
      },
      entry,
    });
  }

  const canonicalCandidates = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const key = expertSkillSelectionKey(candidate.selection);
    const existing = canonicalCandidates.get(key);
    if (!existing || (existing.kind === "path" && candidate.kind === "package")) {
      canonicalCandidates.set(key, candidate);
    }
  }
  const resolvedCandidates = [...canonicalCandidates.values()];
  validateCandidateSet(resolvedCandidates);

  for (const [packageId, preview] of previewsByPackageId) {
    ensureCurrent(isCurrent);
    const imported = await awaitCurrent(
      () =>
        client.importSkillPackage({
          previewId: preview.previewId,
          idempotencyKey: preview.previewId,
        }),
      isCurrent,
    );
    if (imported.package.packageId !== packageId) {
      throw new Error(`导入技能包时版本发生变化：${packageId}`);
    }
  }

  return resolvedCandidates.map((candidate) => candidate.selection);
}
