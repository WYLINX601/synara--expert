import type { ExpertDefinition, ExpertSaveInput } from "@synara/contracts";
import { expertSkillPathKey, validateExpertSkillReferences } from "./expertSkillsSettingsModel";

export type ExpertDraftField =
  | "name"
  | "description"
  | "useCases"
  | "persona"
  | "outputRequirements"
  | "preferredProvider"
  | "skills"
  | "skillSelections"
  | "skillBindings"
  | "references"
  | "connections";

export type ExpertDraftIssue = Readonly<{
  field: ExpertDraftField;
  code: "required" | "too_long" | "too_many" | "duplicate" | "invalid";
  message: string;
  index?: number;
  subfield?: "name" | "path";
}>;

const REFERENCE_TEXT_LIMIT = 32_000;

function referenceKey(reference: string): string {
  return expertSkillPathKey(reference);
}

export function normalizeExpertReferences(references: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const rawReference of references) {
    const reference = rawReference.trim();
    const key = referenceKey(reference);
    if (!reference || !key || seen.has(key)) continue;
    seen.add(key);
    normalized.push(reference);
  }
  return normalized;
}

export function parseExpertReferences(text: string): {
  references: string[];
  duplicateCount: number;
} {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const references = normalizeExpertReferences(lines);
  return { references, duplicateCount: lines.length - references.length };
}

export function expertDraftFromDefinition(expert?: ExpertDefinition): ExpertSaveInput {
  return {
    name: expert?.name ?? "",
    description: expert?.description ?? "",
    useCases: expert?.useCases ?? "",
    persona: expert?.persona ?? "",
    outputRequirements: expert?.outputRequirements ?? "",
    skills: expert?.skills.map((skill) => ({ ...skill })) ?? [],
    ...(!expert || expert.skillBindings !== undefined
      ? { skillBindings: expert?.skillBindings?.map((binding) => ({ ...binding })) ?? [] }
      : {}),
    ...(expert?.skillSelections === undefined
      ? {}
      : { skillSelections: expert.skillSelections.map((selection) => ({ ...selection })) }),
    references: expert?.references.map((reference) => reference) ?? [],
    connections:
      expert?.connections.map((connection) => ({ ...connection, tools: [...connection.tools] })) ??
      [],
    ...(expert?.preferredProvider ? { preferredProvider: expert.preferredProvider } : {}),
  };
}

export function expertSaveInputForDraft(
  draft: ExpertSaveInput,
  baseline?: ExpertDefinition,
): ExpertSaveInput {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    useCases: draft.useCases.trim(),
    persona: draft.persona.trim(),
    outputRequirements: draft.outputRequirements.trim(),
    skills:
      draft.skillSelections === undefined
        ? draft.skills.map((skill) => ({ name: skill.name.trim(), path: skill.path.trim() }))
        : [],
    ...(draft.skillBindings === undefined
      ? {}
      : { skillBindings: draft.skillBindings.map((binding) => ({ ...binding })) }),
    ...(draft.skillSelections === undefined
      ? {}
      : { skillSelections: draft.skillSelections.map((selection) => ({ ...selection })) }),
    references: normalizeExpertReferences(draft.references),
    connections: draft.connections.map((connection) => ({
      ...connection,
      id: connection.id.trim(),
      tools: connection.tools.map((tool) => tool.trim()).filter(Boolean),
    })),
    ...(draft.preferredProvider ? { preferredProvider: draft.preferredProvider } : {}),
    ...(baseline ? { id: baseline.id, expectedRevision: baseline.revision } : {}),
  };
}

export function expertDraftsEqual(a: ExpertSaveInput, b: ExpertSaveInput): boolean {
  return (
    a.name === b.name &&
    a.description === b.description &&
    a.useCases === b.useCases &&
    a.persona === b.persona &&
    a.outputRequirements === b.outputRequirements &&
    a.preferredProvider === b.preferredProvider &&
    JSON.stringify(a.skills) === JSON.stringify(b.skills) &&
    JSON.stringify(a.skillSelections) === JSON.stringify(b.skillSelections) &&
    JSON.stringify(a.skillBindings) === JSON.stringify(b.skillBindings) &&
    JSON.stringify(a.references) === JSON.stringify(b.references) &&
    JSON.stringify(a.connections) === JSON.stringify(b.connections)
  );
}

export function validateExpertDraft(draft: ExpertSaveInput): ExpertDraftIssue[] {
  const issues: ExpertDraftIssue[] = [];
  const addLengthIssue = (field: ExpertDraftField, value: string, limit: number) => {
    if (value.length > limit) {
      issues.push({
        field,
        code: "too_long",
        message: `最多可输入 ${limit.toLocaleString("zh-CN")} 个字符。`,
      });
    }
  };

  if (!draft.name.trim()) {
    issues.push({ field: "name", code: "required", message: "请填写专家名称。" });
  }
  addLengthIssue("name", draft.name, 200);
  addLengthIssue("description", draft.description, 4_000);
  addLengthIssue("useCases", draft.useCases, REFERENCE_TEXT_LIMIT);
  addLengthIssue("persona", draft.persona, REFERENCE_TEXT_LIMIT);
  addLengthIssue("outputRequirements", draft.outputRequirements, REFERENCE_TEXT_LIMIT);

  if (draft.skills.length > 100) {
    issues.push({ field: "skills", code: "too_many", message: "最多可配置 100 项技能。" });
  }
  if (draft.skillBindings !== undefined) {
    if (
      draft.skillBindings.length > 100 ||
      new Set(draft.skillBindings.map((binding) => binding.skillId)).size !==
        draft.skillBindings.length ||
      draft.skillBindings.filter((binding) => binding.enabled && binding.activation === "startup")
        .length > 1
    )
      issues.push({
        field: "skillBindings",
        code: "invalid",
        message: "技能绑定须唯一，最多100个，且最多启用一个启动技能。",
      });
  }
  if (draft.skillSelections !== undefined) {
    if (draft.skillSelections.length > 100) {
      issues.push({
        field: "skillSelections",
        code: "too_many",
        message: "最多可选择 100 个版本包技能入口。",
      });
    }
    if (
      draft.skillSelections.filter((selection) => selection.activation === "startup").length > 1
    ) {
      issues.push({
        field: "skillSelections",
        code: "invalid",
        message: "最多只能设置一个启动技能。",
      });
    }
    const selectionKeys = new Set<string>();
    draft.skillSelections.forEach((selection, index) => {
      const key = `${selection.packageId}\u0000${selection.entryPath}`;
      if (selectionKeys.has(key)) {
        issues.push({
          field: "skillSelections",
          code: "duplicate",
          message: "该版本包入口已选择。",
          index,
        });
      }
      selectionKeys.add(key);
    });
  }
  for (const skillIssue of validateExpertSkillReferences(draft.skills)) {
    issues.push({
      field: "skills",
      code: skillIssue.message.includes("重复") ? "duplicate" : "required",
      message: skillIssue.message,
      index: skillIssue.index,
      subfield: skillIssue.field,
    });
  }

  if (draft.references.length > 100) {
    issues.push({ field: "references", code: "too_many", message: "最多可配置 100 条参考资料。" });
  }
  addLengthIssue("references", draft.references.join("\n"), REFERENCE_TEXT_LIMIT);
  const firstReferenceIndex = new Map<string, number>();
  draft.references.forEach((reference, index) => {
    const key = referenceKey(reference);
    if (!reference.trim()) {
      issues.push({
        field: "references",
        code: "required",
        message: "参考资料路径不能为空。",
        index,
      });
      return;
    }
    const firstIndex = firstReferenceIndex.get(key);
    if (key && firstIndex !== undefined) {
      issues.push({
        field: "references",
        code: "duplicate",
        message: `此路径与第 ${firstIndex + 1} 条参考资料重复。`,
        index,
      });
    } else if (key) {
      firstReferenceIndex.set(key, index);
    }
  });

  if (draft.connections.length > 100) {
    issues.push({
      field: "connections",
      code: "too_many",
      message: "最多可配置 100 条 MCP 连接。",
    });
  }
  draft.connections.forEach((connection, index) => {
    if (connection.tools.length > 200) {
      issues.push({
        field: "connections",
        code: "too_many",
        message: "每条连接最多可授权 200 个工具。",
        index,
      });
    }
    const selectedTools = connection.tools.filter((tool) => tool.trim().length > 0);
    if (
      connection.toolMode !== "all" &&
      connection.enabled !== false &&
      selectedTools.length === 0
    ) {
      issues.push({
        field: "connections",
        code: "invalid",
        message: "启用的 MCP 连接至少需要选择一个工具。",
        index,
      });
    }
  });

  return issues;
}
