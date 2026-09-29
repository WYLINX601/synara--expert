import {
  PROVIDER_DISPLAY_NAMES,
  type ExpertDefinition,
  type ExpertConnectionConfig,
  type ExpertConnectionSaveInput,
  type ExpertPreview,
  type ExpertSaveInput,
} from "@synara/contracts";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Select, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { ensureNativeApi } from "~/nativeApi";
import { skillsCatalogQueryOptions } from "~/lib/providerDiscoveryReactQuery";
import {
  addExpertSkillReference,
  expertSkillPathKey,
  removeExpertSkillReference,
  removeExpertSkillReferencesByPath,
  updateExpertSkillReference,
  validateExpertSkillReferences,
} from "./expertSkillsSettingsModel";
import { skillDisplayName, skillOriginInfo } from "./skillsSettingsModel";
import {
  SettingsCard,
  SettingsEmptyState,
  SettingsListRow,
  SettingsRow,
  SettingsSection,
  SettingsSectionShell,
  SettingsSelectPopup,
} from "./SettingsPanelPrimitives";

const EXPERTS_QUERY_KEY = ["server", "experts"] as const;
const EXPERT_CONNECTIONS_QUERY_KEY = ["server", "expertConnections"] as const;
const EXPERT_GROUPS = [
  ["basic", "基本信息"],
  ["persona", "工作方式"],
  ["skills", "技能"],
  ["tools", "工具与资料"],
  ["runtime", "运行偏好"],
] as const;

type ExpertGroup = (typeof EXPERT_GROUPS)[number][0];
type ExpertProvider = NonNullable<ExpertSaveInput["preferredProvider"]>;
type ExpertDraft = Omit<
  ExpertSaveInput,
  "id" | "expectedRevision" | "references" | "preferredProvider"
> & {
  preferredProvider: ExpertProvider | null;
  referencesText: string;
};
type ExpertEditor = {
  id: string | null;
  expectedRevision: number | null;
  draft: ExpertDraft;
};
type ExpertConnectionBinding = ExpertDefinition["connections"][number];
type ExpertConnectionDraft = {
  id: string;
  name: string;
  type: "stdio" | "http";
  command: string;
  argsText: string;
  envFromHostText: string;
  url: string;
  headersFromHostText: string;
  expectedRevision: number | null;
};

const EMPTY_EXPERTS: ExpertDefinition[] = [];

function draftFor(expert?: ExpertDefinition): ExpertDraft {
  return {
    name: expert?.name ?? "新专家",
    description: expert?.description ?? "",
    useCases: expert?.useCases ?? "",
    persona: expert?.persona ?? "",
    outputRequirements: expert?.outputRequirements ?? "",
    skills: expert ? [...expert.skills] : [],
    referencesText: expert?.references.join("\n") ?? "",
    connections: expert
      ? expert.connections.map((connection) => ({ ...connection, tools: [...connection.tools] }))
      : [],
    preferredProvider: expert?.preferredProvider ?? null,
  };
}

function editorFor(expert: ExpertDefinition): ExpertEditor {
  return { id: expert.id, expectedRevision: expert.revision, draft: draftFor(expert) };
}

function toSaveInput(editor: ExpertEditor): ExpertSaveInput {
  const { referencesText, preferredProvider, name, skills, ...draft } = editor.draft;
  return {
    ...draft,
    name: name.trim(),
    skills: skills.map((skill) => ({ name: skill.name.trim(), path: skill.path.trim() })),
    references: referencesText
      .split(/\r?\n/)
      .map((reference) => reference.trim())
      .filter(Boolean),
    ...(preferredProvider ? { preferredProvider } : {}),
    ...(editor.id && editor.expectedRevision !== null
      ? { id: editor.id, expectedRevision: editor.expectedRevision }
      : {}),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请重试。";
}

function previewStatusLabel(status: ExpertPreview["status"]): string {
  switch (status) {
    case "available":
      return "可用";
    case "partial":
      return "部分能力可用";
    case "blocked":
      return "需连接";
    case "incompatible":
      return "不兼容";
  }
}

function connectionDraftFor(connection?: ExpertConnectionConfig): ExpertConnectionDraft {
  const transport = connection?.transport;
  return {
    id: connection?.id ?? "",
    name: connection?.name ?? "",
    type: transport?.type ?? "stdio",
    command: transport?.type === "stdio" ? transport.command : "",
    argsText: transport?.type === "stdio" ? transport.args.join("\n") : "",
    envFromHostText:
      transport?.type === "stdio"
        ? transport.envFromHost.map(({ name, envVar }) => `${name}=${envVar}`).join("\n")
        : "",
    url: transport?.type === "http" ? transport.url : "",
    headersFromHostText:
      transport?.type === "http"
        ? transport.headersFromHost
            .map(
              ({ name, envVar, prefix }) =>
                `${name}=${envVar}${prefix ? `|${prefix.trimEnd()}` : ""}`,
            )
            .join("\n")
        : "",
    expectedRevision: connection?.revision ?? null,
  };
}

function nonEmptyLines(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseNameMappings(value: string, withPrefix = false) {
  return nonEmptyLines(value).map((line) => {
    const prefixSeparator = withPrefix ? line.indexOf("|") : -1;
    if (prefixSeparator >= 0 && line.indexOf("|", prefixSeparator + 1) >= 0) {
      throw new Error("请求头映射最多只能包含一个前缀分隔符“|”。");
    }
    const pair = prefixSeparator >= 0 ? line.slice(0, prefixSeparator) : line;
    const prefix = prefixSeparator >= 0 ? line.slice(prefixSeparator + 1) : undefined;
    const separator = pair.indexOf("=");
    if (separator < 1 || separator === pair.length - 1) {
      throw new Error("每行请按“名称=环境变量名”填写。");
    }
    const name = pair.slice(0, separator).trim();
    const envVar = pair.slice(separator + 1).trim();
    if (withPrefix && prefix?.trim()) return { name, envVar, prefix: `${prefix.trim()} ` };
    return { name, envVar };
  });
}

function toConnectionSaveInput(draft: ExpertConnectionDraft): ExpertConnectionSaveInput {
  const base = {
    id: draft.id.trim(),
    name: draft.name.trim(),
    ...(draft.expectedRevision === null ? {} : { expectedRevision: draft.expectedRevision }),
  };
  if (draft.type === "stdio") {
    return {
      ...base,
      transport: {
        type: "stdio",
        command: draft.command.trim(),
        args: nonEmptyLines(draft.argsText),
        envFromHost: parseNameMappings(draft.envFromHostText),
      },
    };
  }
  return {
    ...base,
    transport: {
      type: "http",
      url: draft.url.trim(),
      headersFromHost: parseNameMappings(draft.headersFromHostText, true),
    },
  };
}

function withBinding(
  bindings: ReadonlyArray<ExpertConnectionBinding>,
  connectionId: string,
  enabled: boolean,
): ExpertConnectionBinding[] {
  if (enabled) {
    return bindings.some((binding) => binding.id === connectionId)
      ? [...bindings]
      : [...bindings, { id: connectionId, required: true, tools: [] }];
  }
  return bindings.filter((binding) => binding.id !== connectionId);
}

export function ExpertsSettingsPanel(props: { readonly active?: boolean }) {
  const active = props.active ?? true;
  const queryClient = useQueryClient();
  const expertsQuery = useQuery({
    queryKey: EXPERTS_QUERY_KEY,
    queryFn: () => ensureNativeApi().server.listExperts(),
    enabled: active,
  });
  const experts = expertsQuery.data ?? EMPTY_EXPERTS;
  const [editor, setEditor] = useState<ExpertEditor | null>(null);
  const [activeGroup, setActiveGroup] = useState<ExpertGroup>("basic");
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!active || editor || !expertsQuery.data) return;
    const first = expertsQuery.data.find((expert) => !expert.archived);
    if (first) setEditor(editorFor(first));
  }, [active, editor, expertsQuery.data]);

  const activeExperts = experts.filter((expert) => !expert.archived);
  const savedExpert = editor?.id ? experts.find((expert) => expert.id === editor.id) : undefined;
  const previewProvider = editor?.draft.preferredProvider ?? "codex";
  const previewRevision = savedExpert?.revision ?? editor?.expectedRevision ?? null;
  const previewQuery = useQuery({
    queryKey: [
      ...EXPERTS_QUERY_KEY,
      "preview",
      editor?.id ?? null,
      previewProvider,
      previewRevision,
    ],
    queryFn: () =>
      ensureNativeApi().server.previewExpert({
        expertId: editor?.id ?? "",
        provider: previewProvider,
      }),
    enabled: Boolean(active && activeGroup === "tools" && editor?.id),
    staleTime: 10_000,
  });
  const skillsQuery = useQuery(
    skillsCatalogQueryOptions({ enabled: active && activeGroup === "skills" }),
  );
  const connectionsQuery = useQuery({
    queryKey: EXPERT_CONNECTIONS_QUERY_KEY,
    queryFn: () => ensureNativeApi().server.listExpertConnections(),
    enabled: active && activeGroup === "tools",
  });

  const updateDraft = (patch: Partial<ExpertDraft>) => {
    setEditor((current) =>
      current ? { ...current, draft: { ...current.draft, ...patch } } : current,
    );
    setActionError(null);
  };

  const skillIssues = editor ? validateExpertSkillReferences(editor.draft.skills) : [];

  const beginNew = () => {
    setEditor({ id: null, expectedRevision: null, draft: draftFor() });
    setActiveGroup("basic");
    setActionError(null);
  };

  const duplicate = () => {
    if (!savedExpert) return;
    const draft = draftFor(savedExpert);
    setEditor({
      id: null,
      expectedRevision: null,
      draft: { ...draft, name: savedExpert.name + " 副本" },
    });
    setActiveGroup("basic");
    setActionError(null);
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor || pending || !editor.draft.name.trim() || skillIssues.length > 0) return;
    setPending(true);
    setActionError(null);
    try {
      const saved = await ensureNativeApi().server.saveExpert(toSaveInput(editor));
      queryClient.setQueryData<ExpertDefinition[]>(EXPERTS_QUERY_KEY, (current) => {
        const latest = current ?? [];
        return latest.some((expert) => expert.id === saved.id)
          ? latest.map((expert) => (expert.id === saved.id ? saved : expert))
          : [...latest, saved];
      });
      void queryClient.invalidateQueries({
        queryKey: [...EXPERTS_QUERY_KEY, "preview", saved.id],
      });
      setEditor((current) => (current === editor ? editorFor(saved) : current));
      toastManager.add({ type: "success", title: "专家已保存" });
    } catch (error) {
      setActionError(errorText(error));
      void queryClient.invalidateQueries({ queryKey: EXPERTS_QUERY_KEY });
    } finally {
      setPending(false);
    }
  };

  const archive = async () => {
    if (!editor?.id || editor.expectedRevision === null || pending) return;
    setPending(true);
    setActionError(null);
    try {
      const archived = await ensureNativeApi().server.archiveExpert({
        id: editor.id,
        expectedRevision: editor.expectedRevision,
      });
      queryClient.setQueryData<ExpertDefinition[]>(EXPERTS_QUERY_KEY, (current) =>
        (current ?? []).map((expert) => (expert.id === archived.id ? archived : expert)),
      );
      setEditor((current) => (current === editor ? null : current));
      toastManager.add({ type: "success", title: "专家已归档" });
    } catch (error) {
      setActionError(errorText(error));
      void queryClient.invalidateQueries({ queryKey: EXPERTS_QUERY_KEY });
    } finally {
      setPending(false);
    }
  };

  const catalogSkills = skillsQuery.data?.skills ?? [];
  const groupTitle = EXPERT_GROUPS.find(([id]) => id === activeGroup)?.[1] ?? "基本信息";

  return (
    <div className="space-y-6">
      <SettingsSectionShell
        title="我的专家"
        action={
          <Button size="sm" onClick={beginNew}>
            新建专家
          </Button>
        }
      >
        <SettingsCard>
          {expertsQuery.isLoading ? (
            <SettingsEmptyState layout="status">正在读取专家…</SettingsEmptyState>
          ) : expertsQuery.isError ? (
            <SettingsEmptyState layout="status" tone="destructive">
              {errorText(expertsQuery.error)}
            </SettingsEmptyState>
          ) : activeExperts.length === 0 ? (
            <SettingsEmptyState layout="status">还没有专家，创建一个开始配置。</SettingsEmptyState>
          ) : (
            activeExperts.map((expert) => (
              <SettingsRow
                key={expert.id}
                title={
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{expert.name}</span>
                    {editor?.id === expert.id ? (
                      <span className="shrink-0 text-ui-xs text-muted-foreground">正在编辑</span>
                    ) : null}
                  </span>
                }
                description={expert.description || "尚未填写用途。"}
                status={"v" + expert.revision}
                control={
                  <Button
                    size="xs"
                    variant={editor?.id === expert.id ? "secondary" : "ghost"}
                    onClick={() => {
                      setEditor(editorFor(expert));
                      setActiveGroup("basic");
                      setActionError(null);
                    }}
                  >
                    编辑
                  </Button>
                }
              />
            ))
          )}
        </SettingsCard>
      </SettingsSectionShell>

      {editor ? (
        <section className="space-y-4" aria-label="专家编辑器">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="truncate text-ui-lg font-medium">{editor.draft.name || "新专家"}</h2>
              <p className="mt-1 text-ui-sm text-muted-foreground">
                {editor.expectedRevision === null
                  ? "新专家草稿"
                  : "已保存版本 v" + editor.expectedRevision + " · 保存后生成新版本"}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!savedExpert || pending}
                onClick={duplicate}
              >
                复制
              </Button>
              <Button
                size="sm"
                variant="destructive-outline"
                disabled={!editor.id || pending}
                onClick={() => void archive()}
              >
                归档
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap gap-1" role="tablist" aria-label="专家配置组">
            {EXPERT_GROUPS.map(([id, title]) => (
              <Button
                key={id}
                id={"expert-tab-" + id}
                role="tab"
                aria-selected={activeGroup === id}
                aria-controls="expert-editor-group"
                size="sm"
                variant={activeGroup === id ? "secondary" : "ghost"}
                onClick={() => setActiveGroup(id)}
              >
                {title}
              </Button>
            ))}
          </div>

          <form onSubmit={(event) => void save(event)}>
            <div
              id="expert-editor-group"
              role="tabpanel"
              aria-labelledby={"expert-tab-" + activeGroup}
              className="space-y-4"
            >
              <SettingsSection title={groupTitle}>
                {activeGroup === "basic" ? (
                  <>
                    <SettingsRow
                      title="名称"
                      description="在专家列表和任务中显示的名称。"
                      control={
                        <Input
                          value={editor.draft.name}
                          maxLength={120}
                          required
                          onChange={(event) => updateDraft({ name: event.target.value })}
                        />
                      }
                    />
                    <SettingsRow
                      title="用途"
                      description="简短说明这位专家负责什么。"
                      control={
                        <Input
                          value={editor.draft.description}
                          maxLength={1_000}
                          onChange={(event) => updateDraft({ description: event.target.value })}
                        />
                      }
                    />
                    <SettingsRow title="适用任务" description="提示用户什么时候该选择这位专家。">
                      <div className="mt-3">
                        <Textarea
                          value={editor.draft.useCases}
                          maxLength={8_000}
                          onChange={(event) => updateDraft({ useCases: event.target.value })}
                        />
                      </div>
                    </SettingsRow>
                  </>
                ) : null}

                {activeGroup === "persona" ? (
                  <>
                    <SettingsRow
                      title="角色与工作原则"
                      description="写稳定的角色原则；详细流程放在技能中。"
                    >
                      <div className="mt-3">
                        <Textarea
                          value={editor.draft.persona}
                          maxLength={20_000}
                          onChange={(event) => updateDraft({ persona: event.target.value })}
                        />
                      </div>
                    </SettingsRow>
                    <SettingsRow
                      title="输出要求"
                      description="说明结果需要包含的内容、格式或边界。"
                    >
                      <div className="mt-3">
                        <Textarea
                          value={editor.draft.outputRequirements}
                          maxLength={8_000}
                          onChange={(event) =>
                            updateDraft({ outputRequirements: event.target.value })
                          }
                        />
                      </div>
                    </SettingsRow>
                  </>
                ) : null}

                {activeGroup === "skills" ? (
                  <>
                    <SettingsRow
                      title="已配置技能"
                      description="可手动添加本机技能入口，也可从下方发现目录快速添加。配置会随专家版本保存。"
                      control={
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          onClick={() =>
                            updateDraft({
                              skills: addExpertSkillReference(editor.draft.skills),
                            })
                          }
                        >
                          添加技能
                        </Button>
                      }
                    />
                    {editor.draft.skills.length === 0 ? (
                      <SettingsEmptyState layout="status">
                        尚未配置技能。点击“添加技能”填写本机技能名称和入口文件路径。
                      </SettingsEmptyState>
                    ) : (
                      editor.draft.skills.map((skill, index) => {
                        const nameIssue = skillIssues.find(
                          (issue) => issue.index === index && issue.field === "name",
                        );
                        const pathIssue = skillIssues.find(
                          (issue) => issue.index === index && issue.field === "path",
                        );
                        const nameErrorId = `expert-skill-${index}-name-error`;
                        const pathErrorId = `expert-skill-${index}-path-error`;
                        return (
                          <SettingsRow
                            // References do not reorder in this editor; index keeps the input mounted while its path changes.
                            // eslint-disable-next-line react/no-array-index-key -- the contract has no stable ID and editable values cannot be keys
                            key={index}
                            title={`技能 ${index + 1}`}
                            description="名称用于专家配置识别，入口路径指向本机技能说明文件。"
                            control={
                              <Button
                                type="button"
                                size="xs"
                                variant="ghost"
                                aria-label={`移除技能 ${skill.name.trim() || index + 1}`}
                                onClick={() =>
                                  updateDraft({
                                    skills: removeExpertSkillReference(editor.draft.skills, index),
                                  })
                                }
                              >
                                移除
                              </Button>
                            }
                          >
                            <div className="mt-3 grid gap-3 sm:grid-cols-2">
                              <label className="space-y-1 text-ui-sm">
                                <span>技能名称</span>
                                <Input
                                  value={skill.name}
                                  maxLength={200}
                                  aria-label={`技能 ${index + 1} 名称`}
                                  aria-invalid={Boolean(nameIssue)}
                                  aria-describedby={nameIssue ? nameErrorId : undefined}
                                  onChange={(event) =>
                                    updateDraft({
                                      skills: updateExpertSkillReference(
                                        editor.draft.skills,
                                        index,
                                        { name: event.target.value },
                                      ),
                                    })
                                  }
                                />
                                {nameIssue ? (
                                  <span
                                    id={nameErrorId}
                                    className="block text-ui-xs text-destructive"
                                  >
                                    {nameIssue.message}
                                  </span>
                                ) : null}
                              </label>
                              <label className="space-y-1 text-ui-sm">
                                <span>入口文件路径</span>
                                <Input
                                  value={skill.path}
                                  maxLength={4_096}
                                  placeholder="例如 /Users/me/skills/review/SKILL.md"
                                  aria-label={`技能 ${index + 1} 入口文件路径`}
                                  aria-invalid={Boolean(pathIssue)}
                                  aria-describedby={pathIssue ? pathErrorId : undefined}
                                  onChange={(event) =>
                                    updateDraft({
                                      skills: updateExpertSkillReference(
                                        editor.draft.skills,
                                        index,
                                        { path: event.target.value },
                                      ),
                                    })
                                  }
                                />
                                {pathIssue ? (
                                  <span
                                    id={pathErrorId}
                                    className="block text-ui-xs text-destructive"
                                  >
                                    {pathIssue.message}
                                  </span>
                                ) : null}
                              </label>
                            </div>
                          </SettingsRow>
                        );
                      })
                    )}
                    {skillIssues.length > 0 ? (
                      <p role="alert" className="px-4 py-2 text-ui-sm text-destructive">
                        请修正上方技能配置后再保存。
                      </p>
                    ) : null}
                    <SettingsRow
                      title="发现的技能目录"
                      description="从当前机器已发现的技能中快速添加或移除；目录不可用时仍可手动编辑上方配置。"
                    >
                      <div className="mt-3">
                        {skillsQuery.isError ? (
                          <SettingsEmptyState layout="status" tone="destructive">
                            无法读取技能目录：{errorText(skillsQuery.error)}
                          </SettingsEmptyState>
                        ) : skillsQuery.isLoading ? (
                          <SettingsEmptyState layout="status">正在读取技能目录…</SettingsEmptyState>
                        ) : catalogSkills.length === 0 ? (
                          <SettingsEmptyState layout="status">
                            没有发现可选技能。你仍可在上方手动配置技能。
                          </SettingsEmptyState>
                        ) : (
                          catalogSkills.map((skill) => {
                            const skillPathKey = expertSkillPathKey(skill.path);
                            const selected = editor.draft.skills.some(
                              (reference) => expertSkillPathKey(reference.path) === skillPathKey,
                            );
                            const source = skillOriginInfo(skill.scope);
                            return (
                              <SettingsRow
                                key={skill.path}
                                title={skillDisplayName(skill)}
                                description={skill.description ?? "未提供说明。"}
                                status={
                                  <span className="flex min-w-0 flex-col gap-0.5">
                                    <span>{source.label}</span>
                                    <code className="break-all">{skill.path}</code>
                                  </span>
                                }
                                control={
                                  <Checkbox
                                    checked={selected}
                                    aria-label={
                                      (selected ? "移除" : "添加") +
                                      "技能 " +
                                      skillDisplayName(skill)
                                    }
                                    onCheckedChange={(checked) => {
                                      const next =
                                        checked === true
                                          ? addExpertSkillReference(editor.draft.skills, {
                                              name: skill.name,
                                              path: skill.path,
                                            })
                                          : removeExpertSkillReferencesByPath(
                                              editor.draft.skills,
                                              skill.path,
                                            );
                                      updateDraft({ skills: next });
                                    }}
                                  />
                                }
                              />
                            );
                          })
                        )}
                      </div>
                    </SettingsRow>
                  </>
                ) : null}

                {activeGroup === "tools" ? (
                  <>
                    <SettingsRow
                      title="专家可使用的连接"
                      description="勾选要提供给此专家的本机 MCP 连接，并单独设置必需性和可调用工具。未填写工具名时不会授权该连接的任何工具。"
                    >
                      <div className="mt-3 space-y-3">
                        {connectionsQuery.isLoading ? (
                          <p className="text-ui-sm text-muted-foreground">正在读取连接…</p>
                        ) : connectionsQuery.isError ? (
                          <p role="alert" className="text-ui-sm text-destructive">
                            无法读取连接：{errorText(connectionsQuery.error)}
                          </p>
                        ) : (connectionsQuery.data ?? []).length === 0 ? (
                          <p className="text-ui-sm text-muted-foreground">
                            还没有本机连接，请在下方添加 MCP 连接。
                          </p>
                        ) : null}
                        {(connectionsQuery.data ?? []).map((connection) => {
                          const binding = editor.draft.connections.find(
                            (item) => item.id === connection.id,
                          );
                          return (
                            <div key={connection.id} className="space-y-2 rounded-lg border p-3">
                              <label className="flex cursor-pointer items-center gap-2 text-ui">
                                <Checkbox
                                  checked={Boolean(binding)}
                                  aria-label={
                                    (binding ? "移除" : "添加") + "连接 " + connection.name
                                  }
                                  onCheckedChange={(checked) =>
                                    updateDraft({
                                      connections: withBinding(
                                        editor.draft.connections,
                                        connection.id,
                                        checked === true,
                                      ),
                                    })
                                  }
                                />
                                <span className="font-medium">{connection.name}</span>
                                <code className="text-ui-xs text-muted-foreground">
                                  {connection.id}
                                </code>
                              </label>
                              {binding ? (
                                <div className="grid gap-2 pl-6 sm:grid-cols-[auto_1fr] sm:items-center">
                                  <label className="flex items-center gap-2 text-ui-sm">
                                    <Checkbox
                                      checked={binding.required}
                                      aria-label={connection.name + "为必需连接"}
                                      onCheckedChange={(checked) =>
                                        updateDraft({
                                          connections: editor.draft.connections.map((item) =>
                                            item.id === connection.id
                                              ? { ...item, required: checked === true }
                                              : item,
                                          ),
                                        })
                                      }
                                    />
                                    启动前必须可用
                                  </label>
                                  <Input
                                    value={binding.tools.join(", ")}
                                    aria-label={connection.name + "允许调用的工具"}
                                    placeholder="工具名，逗号分隔"
                                    onChange={(event) => {
                                      const tools = event.target.value
                                        .split(",")
                                        .map((tool) => tool.trim())
                                        .filter(Boolean);
                                      updateDraft({
                                        connections: editor.draft.connections.map((item) =>
                                          item.id === connection.id ? { ...item, tools } : item,
                                        ),
                                      });
                                    }}
                                  />
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                        {editor.draft.connections
                          .filter(
                            (binding) =>
                              !(connectionsQuery.data ?? []).some(
                                (connection) => connection.id === binding.id,
                              ),
                          )
                          .map((binding) => (
                            <div
                              key={binding.id}
                              className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 p-3"
                            >
                              <span className="min-w-0 text-ui-sm text-destructive">
                                找不到连接配置：{binding.id}
                              </span>
                              <Button
                                type="button"
                                size="xs"
                                variant="outline"
                                onClick={() =>
                                  updateDraft({
                                    connections: withBinding(
                                      editor.draft.connections,
                                      binding.id,
                                      false,
                                    ),
                                  })
                                }
                              >
                                移除
                              </Button>
                            </div>
                          ))}
                      </div>
                    </SettingsRow>
                    <SettingsRow
                      title="本机 MCP 连接"
                      description="连接只保存启动配置和环境变量引用。请勿在这里粘贴令牌或密码。"
                    >
                      <ExpertConnectionManager
                        connections={connectionsQuery.data ?? []}
                        isLoading={connectionsQuery.isLoading}
                        onRefresh={() => void connectionsQuery.refetch()}
                        onRemoved={(id) =>
                          updateDraft({
                            connections: withBinding(editor.draft.connections, id, false),
                          })
                        }
                      />
                    </SettingsRow>
                    <SettingsRow
                      title="参考资料"
                      description="每行填写一个本机参考文件的绝对路径；专家用于新任务时会复制到任务快照。"
                    >
                      <div className="mt-3">
                        <Textarea
                          value={editor.draft.referencesText}
                          maxLength={8_000}
                          placeholder="输入本机绝对路径"
                          onChange={(event) => updateDraft({ referencesText: event.target.value })}
                        />
                      </div>
                    </SettingsRow>
                    {editor.id ? (
                      <ExpertPreviewPanel previewProvider={previewProvider} query={previewQuery} />
                    ) : (
                      <SettingsEmptyState layout="status">
                        保存专家后可检查连接状态和缺失原因。
                      </SettingsEmptyState>
                    )}
                  </>
                ) : null}

                {activeGroup === "runtime" ? (
                  <>
                    <SettingsRow
                      title="首选运行环境"
                      description="任务中显式选择的运行环境优先；未设置时跟随任务当前选择。"
                      control={
                        <Select
                          value={editor.draft.preferredProvider ?? "__current__"}
                          onValueChange={(value) =>
                            updateDraft({
                              preferredProvider:
                                value === "__current__" ? null : (value as ExpertProvider),
                            })
                          }
                        >
                          <SelectTrigger
                            size="sm"
                            className="w-full sm:w-56"
                            aria-label="首选运行环境"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SettingsSelectPopup align="start">
                            <SelectItem value="__current__">跟随当前选择</SelectItem>
                            <SelectItem value="codex">{PROVIDER_DISPLAY_NAMES.codex}</SelectItem>
                            <SelectItem value="pi">{PROVIDER_DISPLAY_NAMES.pi}</SelectItem>
                          </SettingsSelectPopup>
                        </Select>
                      }
                    />
                    <SettingsRow
                      title="模型选项"
                      description="继续使用 Synara 当前设置；专家目前不覆盖模型参数。"
                    />
                  </>
                ) : null}
              </SettingsSection>
            </div>

            {actionError ? (
              <p role="alert" className="mt-3 text-ui text-destructive">
                {actionError}
              </p>
            ) : null}
            {savedExpert && savedExpert.revision !== editor.expectedRevision ? (
              <div
                role="alert"
                className="mt-3 flex flex-wrap items-center justify-between gap-2 text-ui text-destructive"
              >
                <span>此专家已在其他位置更新。保存时会按当前草稿修订号检查，避免覆盖新版本。</span>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    setEditor(editorFor(savedExpert));
                    setActionError(null);
                  }}
                >
                  载入最新版本
                </Button>
              </div>
            ) : null}
            <div className="mt-4 flex justify-end">
              <Button
                type="submit"
                disabled={pending || !editor.draft.name.trim() || skillIssues.length > 0}
              >
                {pending ? "保存中…" : editor.id ? "保存新版本" : "新建专家"}
              </Button>
            </div>
          </form>
        </section>
      ) : null}
    </div>
  );
}

function ExpertConnectionManager(props: {
  connections: ReadonlyArray<ExpertConnectionConfig>;
  isLoading: boolean;
  onRefresh: () => void;
  onRemoved: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ExpertConnectionDraft | null>(null);
  const [pending, setPending] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    id: string;
    message: string;
    error: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!draft || pending) return;
    setPending(true);
    setError(null);
    setTestResult(null);
    try {
      const saved = await ensureNativeApi().server.saveExpertConnection(
        toConnectionSaveInput(draft),
      );
      setDraft(connectionDraftFor(saved));
      await queryClient.invalidateQueries({ queryKey: EXPERT_CONNECTIONS_QUERY_KEY });
      props.onRefresh();
      toastManager.add({ type: "success", title: "MCP 连接已保存" });
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  };

  const remove = async (connection: ExpertConnectionConfig) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await ensureNativeApi().server.removeExpertConnection({
        id: connection.id,
        expectedRevision: connection.revision,
      });
      if (draft?.id === connection.id) setDraft(null);
      props.onRemoved(connection.id);
      await queryClient.invalidateQueries({ queryKey: EXPERT_CONNECTIONS_QUERY_KEY });
      props.onRefresh();
      toastManager.add({ type: "success", title: "MCP 连接已删除" });
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  };

  const test = async (connection: ExpertConnectionConfig) => {
    if (testingId) return;
    setTestingId(connection.id);
    setTestResult(null);
    try {
      const result = await ensureNativeApi().server.testExpertConnection({ id: connection.id });
      setTestResult({
        id: connection.id,
        message:
          result.tools.length > 0
            ? `连接成功，可发现 ${result.tools.length} 个工具：${result.tools.join("、")}`
            : "连接成功，但服务端没有提供工具。",
        error: false,
      });
    } catch (cause) {
      setTestResult({ id: connection.id, message: errorText(cause), error: true });
    } finally {
      setTestingId(null);
    }
  };

  const update = (patch: Partial<ExpertConnectionDraft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setError(null);
  };

  return (
    <div className="mt-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-ui-sm text-muted-foreground">
          支持本机 stdio 进程和 Streamable HTTP。环境变量只引用主机已有变量，不会保存密钥值。
        </p>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={pending}
          onClick={() => {
            setDraft(connectionDraftFor());
            setError(null);
            setTestResult(null);
          }}
        >
          添加连接
        </Button>
      </div>

      {props.isLoading ? (
        <SettingsEmptyState layout="status">正在读取连接…</SettingsEmptyState>
      ) : props.connections.length > 0 ? (
        <div className="overflow-hidden rounded-lg border">
          {props.connections.map((connection) => (
            <SettingsListRow
              key={connection.id}
              align="start"
              title={
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate">{connection.name}</span>
                  <code className="text-ui-xs text-muted-foreground">{connection.id}</code>
                </span>
              }
              description={
                connection.transport.type === "stdio"
                  ? `stdio · ${connection.transport.command}`
                  : `HTTP · ${connection.transport.url}`
              }
              actions={
                <>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => {
                      setDraft(connectionDraftFor(connection));
                      setError(null);
                      setTestResult(null);
                    }}
                  >
                    编辑
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={Boolean(testingId) || pending}
                    onClick={() => void test(connection)}
                  >
                    {testingId === connection.id ? "测试中…" : "测试"}
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="destructive-outline"
                    disabled={pending}
                    onClick={() => void remove(connection)}
                  >
                    删除
                  </Button>
                </>
              }
            />
          ))}
        </div>
      ) : (
        <SettingsEmptyState layout="status">还没有配置本机 MCP 连接。</SettingsEmptyState>
      )}

      {props.connections.map((connection) =>
        testResult?.id === connection.id ? (
          <p
            key={connection.id + "-test-result"}
            role="status"
            className={"text-ui-sm " + (testResult.error ? "text-destructive" : "text-emerald-600")}
          >
            {testResult.message}
          </p>
        ) : null,
      )}

      {draft ? (
        <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-ui-sm">
              <span>连接 ID</span>
              <Input
                value={draft.id}
                disabled={draft.expectedRevision !== null}
                maxLength={64}
                placeholder="例如 linear"
                aria-label="MCP 连接 ID"
                onChange={(event) => update({ id: event.target.value })}
              />
            </label>
            <label className="space-y-1 text-ui-sm">
              <span>显示名称</span>
              <Input
                value={draft.name}
                maxLength={200}
                placeholder="例如 Linear 工作区"
                aria-label="MCP 连接名称"
                onChange={(event) => update({ name: event.target.value })}
              />
            </label>
          </div>
          <div className="space-y-1 text-ui-sm">
            <span>连接方式</span>
            <Select
              value={draft.type}
              onValueChange={(value) => update({ type: value as ExpertConnectionDraft["type"] })}
            >
              <SelectTrigger size="sm" className="w-full sm:w-64" aria-label="MCP 连接方式">
                <SelectValue />
              </SelectTrigger>
              <SettingsSelectPopup align="start">
                <SelectItem value="stdio">本机命令（stdio）</SelectItem>
                <SelectItem value="http">HTTP 服务</SelectItem>
              </SettingsSelectPopup>
            </Select>
          </div>
          {draft.type === "stdio" ? (
            <>
              <label className="block space-y-1 text-ui-sm">
                <span>启动命令</span>
                <Input
                  value={draft.command}
                  maxLength={4_096}
                  placeholder="例如 npx"
                  aria-label="MCP 启动命令"
                  onChange={(event) => update({ command: event.target.value })}
                />
              </label>
              <label className="block space-y-1 text-ui-sm">
                <span>参数</span>
                <Textarea
                  value={draft.argsText}
                  maxLength={16_000}
                  placeholder="每行一个参数"
                  aria-label="MCP 启动参数"
                  onChange={(event) => update({ argsText: event.target.value })}
                />
              </label>
              <label className="block space-y-1 text-ui-sm">
                <span>环境变量映射</span>
                <Textarea
                  value={draft.envFromHostText}
                  maxLength={16_000}
                  placeholder={"每行一个映射，例如：\nAPI_TOKEN=LINEAR_API_TOKEN"}
                  aria-label="MCP 环境变量映射"
                  onChange={(event) => update({ envFromHostText: event.target.value })}
                />
                <span className="block text-ui-xs text-muted-foreground">
                  等号左侧是传给 MCP 的变量名，右侧是 Synara 主机已有的变量名。
                </span>
              </label>
            </>
          ) : (
            <>
              <label className="block space-y-1 text-ui-sm">
                <span>服务地址</span>
                <Input
                  value={draft.url}
                  maxLength={4_096}
                  placeholder="https://mcp.example.com/mcp"
                  aria-label="MCP HTTP 服务地址"
                  onChange={(event) => update({ url: event.target.value })}
                />
              </label>
              <label className="block space-y-1 text-ui-sm">
                <span>HTTP 请求头映射</span>
                <Textarea
                  value={draft.headersFromHostText}
                  maxLength={16_000}
                  placeholder={"每行一个映射，例如：\nAuthorization=LINEAR_TOKEN|Bearer"}
                  aria-label="MCP HTTP 请求头映射"
                  onChange={(event) => update({ headersFromHostText: event.target.value })}
                />
                <span className="block text-ui-xs text-muted-foreground">
                  格式为“请求头=主机环境变量名|可选前缀”；前缀后会自动加空格，密钥值不会保存在连接配置中。
                </span>
              </label>
            </>
          )}
          {error ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => setDraft(null)}
            >
              取消
            </Button>
            <Button type="button" size="sm" disabled={pending} onClick={() => void save()}>
              {pending ? "保存中…" : "保存连接"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ExpertPreviewPanel(props: {
  previewProvider: ExpertProvider;
  query: UseQueryResult<ExpertPreview>;
}) {
  const label = PROVIDER_DISPLAY_NAMES[props.previewProvider];
  const preview = props.query.data;

  return (
    <SettingsRow
      title={"按 " + label + " 检查"}
      description={
        preview
          ? "保存版本 v" +
            preview.definition.revision +
            " 的只读预检；不代表 Provider 已实际加载或连接。"
          : "只读检查保存版本的技能、连接与运行环境要求。"
      }
      control={
        <Button
          size="xs"
          variant="outline"
          disabled={props.query.isFetching}
          onClick={() => void props.query.refetch()}
        >
          {props.query.isFetching ? "检查中…" : "重新检查"}
        </Button>
      }
    >
      {props.query.isError ? (
        <SettingsEmptyState layout="status" tone="destructive">
          预检失败：{errorText(props.query.error)}
        </SettingsEmptyState>
      ) : props.query.isLoading ? (
        <SettingsEmptyState layout="status">正在检查…</SettingsEmptyState>
      ) : preview ? (
        <div className="mt-3 space-y-2" role="status">
          <p
            className={
              "text-ui font-medium " +
              (preview.status === "blocked" || preview.status === "incompatible"
                ? "text-destructive"
                : preview.status === "partial"
                  ? "text-amber-600 dark:text-amber-300"
                  : "text-emerald-600 dark:text-emerald-300")
            }
          >
            {previewStatusLabel(preview.status)}
          </p>
          {preview.issues.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5 text-ui-sm text-muted-foreground">
              {preview.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          ) : (
            <p className="text-ui-sm text-muted-foreground">未发现阻塞项。</p>
          )}
        </div>
      ) : (
        <SettingsEmptyState layout="status">
          当前保存的专家配置没有可显示的预检结果。
        </SettingsEmptyState>
      )}
    </SettingsRow>
  );
}
