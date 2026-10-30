import type { ExpertDefinition, ExpertSaveInput, ExpertSkillBinding } from "@synara/contracts";

export type ExpertDraftField =
  | "name"
  | "description"
  | "useCases"
  | "persona"
  | "outputRequirements"
  | "preferredProvider"
  | "skillBindings"
  | "references"
  | "connections";

export type ExpertDraftIssue = Readonly<{
  field: ExpertDraftField;
  code: "required" | "too_long" | "too_many" | "duplicate" | "invalid";
  message: string;
  index?: number;
}>;

const REFERENCE_TEXT_LIMIT = 32_000;

function copySkillBinding(binding: ExpertSkillBinding): ExpertSkillBinding {
  return {
    skillId: binding.skillId,
    enabled: binding.enabled,
    ...(binding.allowEvolution === undefined ? {} : { allowEvolution: binding.allowEvolution }),
    ...(binding.selectionScope === undefined ? {} : { selectionScope: binding.selectionScope }),
    ...(binding.resourceMode === undefined ? {} : { resourceMode: binding.resourceMode }),
  };
}

function referenceKey(path: string): string {
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
    skills: [],
    skillBindings: expert?.skillBindings?.map(copySkillBinding) ?? [],
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
    skills: [],
    skillBindings: (draft.skillBindings ?? []).map(copySkillBinding),
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
    JSON.stringify(a.skillBindings ?? []) === JSON.stringify(b.skillBindings ?? []) &&
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

  if (draft.skillBindings !== undefined) {
    if (
      draft.skillBindings.length > 100 ||
      new Set(draft.skillBindings.map((binding) => binding.skillId)).size !==
        draft.skillBindings.length
    )
      issues.push({
        field: "skillBindings",
        code: "invalid",
        message: "技能绑定须唯一，最多100个。",
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
