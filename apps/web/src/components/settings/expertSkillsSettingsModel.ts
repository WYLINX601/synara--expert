// FILE: expertSkillsSettingsModel.ts
// Purpose: Pure draft operations and validation for Expert skill references.
// Layer: Settings UI logic

import type { ProviderSkillReference } from "@synara/contracts";

export type ExpertSkillReferenceIssue = {
  readonly index: number;
  readonly field: "name" | "path";
  readonly message: string;
};

/** Normalize path spelling for duplicate checks without changing case-sensitive names. */
export function expertSkillPathKey(path: string): string {
  const slashPath = path.trim().replaceAll("\\", "/");
  if (!slashPath) return "";

  const isUnc = slashPath.startsWith("//");
  const drive = slashPath.match(/^([A-Za-z]:)(?:\/|$)/u)?.[1];
  const isAbsolute = !isUnc && !drive && slashPath.startsWith("/");
  const prefixLength = isUnc
    ? 2
    : drive
      ? drive.length + (slashPath[2] === "/" ? 1 : 0)
      : isAbsolute
        ? 1
        : 0;
  const remainder = slashPath.slice(prefixLength);
  const segments: string[] = [];

  for (const segment of remainder.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0 && segments.at(-1) !== "..") {
        segments.pop();
      } else if (!isAbsolute && !isUnc && !drive) {
        segments.push(segment);
      }
      continue;
    }
    segments.push(segment);
  }

  const normalizedPrefix = isUnc ? "//" : drive ? `${drive.toLowerCase()}/` : isAbsolute ? "/" : "";
  return normalizedPrefix + segments.join("/");
}

export function addExpertSkillReference(
  skills: ReadonlyArray<ProviderSkillReference>,
  reference: ProviderSkillReference = { name: "", path: "" },
): ProviderSkillReference[] {
  const pathKey = expertSkillPathKey(reference.path);
  if (pathKey && skills.some((skill) => expertSkillPathKey(skill.path) === pathKey)) {
    return [...skills];
  }
  return [...skills, { ...reference }];
}

export function updateExpertSkillReference(
  skills: ReadonlyArray<ProviderSkillReference>,
  index: number,
  patch: Partial<ProviderSkillReference>,
): ProviderSkillReference[] {
  if (!skills[index]) return [...skills];
  return skills.map((skill, skillIndex) =>
    skillIndex === index ? { ...skill, ...patch } : { ...skill },
  );
}

export function removeExpertSkillReference(
  skills: ReadonlyArray<ProviderSkillReference>,
  index: number,
): ProviderSkillReference[] {
  return skills.filter((_, skillIndex) => skillIndex !== index);
}

export function removeExpertSkillReferencesByPath(
  skills: ReadonlyArray<ProviderSkillReference>,
  path: string,
): ProviderSkillReference[] {
  const pathKey = expertSkillPathKey(path);
  return skills.filter((skill) => expertSkillPathKey(skill.path) !== pathKey);
}

export function validateExpertSkillReferences(
  skills: ReadonlyArray<ProviderSkillReference>,
): ExpertSkillReferenceIssue[] {
  const issues: ExpertSkillReferenceIssue[] = [];
  const firstIndexByPath = new Map<string, number>();

  skills.forEach((skill, index) => {
    if (!skill.name.trim()) {
      issues.push({ index, field: "name", message: "请填写技能名称。" });
    }

    const pathKey = expertSkillPathKey(skill.path);
    if (!pathKey) {
      issues.push({ index, field: "path", message: "请填写本机技能入口文件路径，例如 SKILL.md。" });
      return;
    }

    const firstIndex = firstIndexByPath.get(pathKey);
    if (firstIndex !== undefined) {
      issues.push({
        index,
        field: "path",
        message: `此路径与第 ${firstIndex + 1} 条技能重复，请修改路径或移除重复项。`,
      });
      return;
    }
    firstIndexByPath.set(pathKey, index);
  });

  return issues;
}
