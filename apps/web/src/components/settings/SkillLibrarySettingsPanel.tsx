import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  SkillDefinition,
  SkillImportChoice,
  SkillLibraryPreview,
  SkillLibraryQuery,
  SkillLibraryRequest,
  SkillLibraryResponse,
  SkillLibrarySourceFilter,
} from "@synara/contracts";
import { SKILL_UPLOAD_ROUTE_PATH } from "@synara/shared/binaryTransfer";
import { ensureExpertClient } from "~/workbench/host/expertClient";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  FolderIcon,
  RefreshCwIcon,
} from "~/lib/icons";
import { formatShortDateTimestamp } from "~/timestampFormat";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Select, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { SettingsCard, SettingsEmptyState, SettingsSelectPopup } from "./SettingsPanelPrimitives";
import { SKILL_LIBRARY_QUERY_KEY } from "./ExpertSkillBindingsEditor";
import { useSkillPackageConnection } from "./skillPackageSettingsQueries";
import { DEFAULT_SKILL_LIBRARY_COLUMNS, SkillLibraryToolbar } from "./SkillLibraryToolbar";
import { RuntimeSkillImportPanel } from "./RuntimeSkillImportPanel";

import { tagsFrom, errorText, transfer } from "./skillLibraryFiles";
import { SkillLibraryDetail } from "./SkillLibraryDetail";

const supportsHostedUpdate = (skill: SkillDefinition) => {
  if (skill.source.kind !== "url") return false;
  try {
    return ["github.com", "skills.sh", "clawhub.ai", "clawhub.com"].includes(
      new URL(skill.source.location).hostname.replace(/^www\./u, ""),
    );
  } catch {
    return false;
  }
};

export function SkillLibrarySettingsPanel() {
  const cache = useQueryClient(),
    connection = useSkillPackageConnection();
  const [search, setSearch] = useState(""),
    [usage, setUsage] = useState<"all" | "used" | "unused">("all"),
    [sources, setSources] = useState<SkillLibrarySourceFilter[]>([]),
    [expertIds, setExpertIds] = useState<string[]>([]),
    [filterTags, setFilterTags] = useState<string[]>([]),
    [sort, setSort] = useState<NonNullable<SkillLibraryQuery["sort"]>>({
      field: "updated",
      direction: "desc",
    });
  const activePreviewRequest = useRef<string | null>(null);
  const activePreviewId = useRef<string | null>(null);
  const queryInput: SkillLibraryQuery = {
    ...(search.trim() ? { search: search.trim() } : {}),
    ...(usage !== "all" ? { usage } : {}),
    ...(sources.length ? { sources } : {}),
    ...(expertIds.length ? { expertIds } : {}),
    ...(filterTags.length ? { tags: filterTags } : {}),
    sort,
  };
  const query = useQuery({
    queryKey: [...SKILL_LIBRARY_QUERY_KEY, connection.generation, queryInput],
    queryFn: () => ensureExpertClient().skillLibrary({ action: "list", query: queryInput }),
    enabled: connection.connected,
    refetchOnWindowFocus: false,
  });
  const allSkillsQuery = useQuery({
    queryKey: [...SKILL_LIBRARY_QUERY_KEY, "facets", connection.generation],
    queryFn: () => ensureExpertClient().skillLibrary({ action: "list" }),
    enabled: connection.connected,
    refetchOnWindowFocus: false,
  });
  const expertsQuery = useQuery({
    queryKey: ["server", "experts", connection.generation],
    queryFn: () => ensureExpertClient().listExperts(),
    enabled: connection.connected,
  });
  const [columns, setColumns] = useState(DEFAULT_SKILL_LIBRARY_COLUMNS);
  const showUsage = columns.usage || columns.source;
  const showDates = columns.updated || columns.created;
  const rowColumnStyle = {
    "--skill-library-columns": [
      "minmax(0,1fr)",
      ...(showUsage ? ["minmax(8rem,auto)"] : []),
      ...(showDates ? ["minmax(10rem,auto)"] : []),
      "auto",
    ].join(" "),
  } as CSSProperties;
  const skills = query.data?.skills ?? [],
    allSkills = allSkillsQuery.data?.skills ?? skills,
    metadata = new Map((query.data?.items ?? []).map((item) => [item.skillId, item]));
  const [selected, setSelected] = useState<string[]>([]),
    [batchTags, setBatchTags] = useState("");
  const [bindingDialogOpen, setBindingDialogOpen] = useState(false),
    [bindingSkillIds, setBindingSkillIds] = useState<string[]>([]),
    [bindingTargets, setBindingTargets] = useState<string[]>([]),
    [bindingTargetRevisions, setBindingTargetRevisions] = useState<Record<string, number>>({}),
    [bindingRequestId, setBindingRequestId] = useState<string | null>(null),
    [bindingPlan, setBindingPlan] = useState<SkillLibraryResponse["bindingResults"]>(undefined),
    [bindingApplied, setBindingApplied] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null),
    [createOpen, setCreateOpen] = useState(false),
    [newName, setNewName] = useState("new-skill"),
    [newBody, setNewBody] = useState(
      "---\nname: new-skill\ndescription: Describe when to use this skill.\n---\n\nWrite the skill instructions here.\n",
    );
  const [importOpen, setImportOpen] = useState(false),
    [importStep, setImportStep] = useState<"choose" | "source" | "runtime">("choose"),
    [location, setLocation] = useState(""),
    [kind, setKind] = useState<"local" | "url" | "runtime">("local"),
    [preview, setPreview] = useState<SkillLibraryPreview | null>(null),
    [choices, setChoices] = useState<SkillImportChoice[]>([]),
    [refresh, setRefresh] = useState<SkillDefinition | null>(null),
    [refreshRequestId, setRefreshRequestId] = useState<string | null>(null);
  const [deletions, setDeletions] = useState<
      { skill: SkillDefinition; expertIds: readonly string[] }[] | null
    >(null),
    [results, setResults] = useState<SkillLibraryResponse["results"]>([]),
    [refreshBases, setRefreshBases] = useState<SkillDefinition[]>([]),
    [batchUpdateRequestIds, setBatchUpdateRequestIds] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const generation = useRef(connection.generation);
  generation.current = connection.generation;
  useEffect(() => {
    activePreviewRequest.current = null;
    activePreviewId.current = null;
    setPreview(null);
    setChoices([]);
    setImportOpen(false);
    setImportStep("choose");
    setDeletions(null);
    setSelected([]);
    setResults([]);
    setRefreshBases([]);
    setBindingDialogOpen(false);
    setBindingSkillIds([]);
    setBindingTargets([]);
    setBindingRequestId(null);
    setBindingPlan(undefined);
    setBatchUpdateRequestIds({});
  }, [connection.generation]);
  const checked = async <T,>(operation: Promise<T>) => {
    const started = connection.generation,
      result = await operation;
    if (generation.current !== started) throw new Error("服务器连接已更改，请重新预览操作。");
    return result;
  };
  const call = (request: SkillLibraryRequest) =>
    checked(ensureExpertClient().skillLibrary(request));
  const reload = async () => {
    await Promise.all([
      cache.invalidateQueries({ queryKey: SKILL_LIBRARY_QUERY_KEY }),
      cache.invalidateQueries({ queryKey: ["server", "experts"] }),
      cache.invalidateQueries({ queryKey: ["server", "skillPackages"] }),
    ]);
  };
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await operation();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const clearPreviewOwnership = (cancel = true) => {
    const id = activePreviewId.current ?? activePreviewRequest.current;
    activePreviewRequest.current = null;
    activePreviewId.current = null;
    if (cancel && id) void call({ action: "cancel", previewId: id }).catch(() => undefined);
  };
  const beginPreview = () => {
    clearPreviewOwnership();
    const id = globalThis.crypto.randomUUID();
    activePreviewRequest.current = id;
    setPreview(null);
    return id;
  };
  const adoptPreview = (id: string, result: SkillLibraryResponse) => {
    if (activePreviewRequest.current !== id) {
      if (result.preview)
        void call({ action: "cancel", previewId: result.preview.previewId }).catch(() => undefined);
      return;
    }
    activePreviewId.current = result.preview?.previewId ?? null;
    setPreview(result.preview ?? null);
  };
  const openRefresh = (skill: SkillDefinition) => {
    const id = beginPreview();
    setRefresh(skill);
    setRefreshRequestId(id);
    setChoices([]);
    setImportOpen(true);
    return run(async () => {
      const result = await call({
        action: "updateFromSource",
        skillId: skill.skillId,
        expectedRevision: skill.revision,
        requestId: id,
        overwriteLocalEdits: true,
        dryRun: true,
      });
      if (!result.updateResult?.preview)
        throw new Error(result.updateResult?.error ?? "无法预演托管来源更新。");
      adoptPreview(id, { preview: result.updateResult.preview });
    });
  };
  const updateSource = (skill: SkillDefinition) =>
    run(async () => {
      const result = await call({
        action: "updateFromSource",
        skillId: skill.skillId,
        expectedRevision: skill.revision,
        requestId: globalThis.crypto.randomUUID(),
      });
      const update = result.updateResult;
      if (!update) throw new Error("来源更新没有返回结果。");
      if (update.status === "conflict" || update.status === "failed" || update.status === "skipped")
        throw new Error(update.error ?? `来源更新${update.status}。`);
      setNotice(
        update.status === "updated"
          ? `${skill.name} 已更新，下一次运行使用新内容；当前运行及其恢复仍保留原版本。`
          : `${skill.name} 来源内容未变化。`,
      );
      await reload();
    });
  const openImport = async (value: string, mode: typeof kind) => {
    const requestId = beginPreview();
    setImportOpen(true);
    setImportStep("source");
    setLocation(value);
    setKind(mode);
    setRefresh(null);
    setRefreshRequestId(null);
    setChoices([]);
    setPreview(null);
    await run(async () => {
      const result = await call({
        action: "previewImport",
        location: value,
        kind: mode,
        requestId,
      });
      adoptPreview(requestId, result);
    });
  };
  const cancelImport = () => {
    if (busy && importStep === "runtime") return;
    clearPreviewOwnership();
    setImportOpen(false);
    setPreview(null);
    setRefresh(null);
    setRefreshRequestId(null);
    setChoices([]);
  };
  const prepareDelete = (items: SkillDefinition[]) =>
    run(async () => {
      const prepared = [];
      for (const skill of items)
        prepared.push({
          skill,
          expertIds:
            (await call({ action: "previewDelete", skillId: skill.skillId })).expertIds ?? [],
        });
      setDeletions(prepared);
    });
  const selectedItems = allSkills.filter((skill) => selected.includes(skill.skillId)),
    visibleIds = new Set(skills.map((skill) => skill.skillId)),
    hiddenSelectedCount = selectedItems.filter((skill) => !visibleIds.has(skill.skillId)).length,
    detail = allSkills.find((skill) => skill.skillId === detailId),
    tagOptions = [...new Set(allSkills.flatMap((skill) => skill.tags))].toSorted((a, b) =>
      a.localeCompare(b, "zh-Hans"),
    );
  const updateChoice = (entryPath: string, patch: Partial<SkillImportChoice>) =>
    setChoices((current) =>
      current.map((choice) => (choice.entryPath === entryPath ? { ...choice, ...patch } : choice)),
    );
  const prepareBindingPlan = () =>
    void run(async () => {
      const refreshed = await expertsQuery.refetch(),
        experts = (refreshed.data ?? expertsQuery.data ?? []).filter((expert) => !expert.archived),
        selectedExperts = experts.filter((expert) => bindingTargets.includes(expert.id));
      if (!bindingSkillIds.length || !selectedExperts.length)
        throw new Error("请选择至少一个技能和一个有效专家。");
      const requestId = globalThis.crypto.randomUUID(),
        revisions = Object.fromEntries(
          selectedExperts.map((expert) => [expert.id, expert.revision]),
        );
      setBindingRequestId(requestId);
      setBindingTargetRevisions(revisions);
      setBindingApplied(false);
      const response = await call({
        action: "bindExperts",
        requestId,
        skillIds: bindingSkillIds,
        targets: selectedExperts.map((expert) => ({
          expertId: expert.id,
          expectedRevision: expert.revision,
        })),
        dryRun: true,
      });
      setBindingPlan(response.bindingResults);
    });
  const applyBindingPlan = () =>
    void run(async () => {
      if (!bindingRequestId) throw new Error("请先预演这次批量绑定。");
      const response = await call({
        action: "bindExperts",
        requestId: bindingRequestId,
        skillIds: bindingSkillIds,
        targets: bindingTargets
          .filter((expertId) => bindingTargetRevisions[expertId] !== undefined)
          .map((expertId) => ({
            expertId,
            expectedRevision: bindingTargetRevisions[expertId]!,
          })),
      });
      setBindingPlan(response.bindingResults);
      await reload();
      setBindingApplied(true);
      await expertsQuery.refetch();
      if (response.bindingResults?.every((item) => ["applied", "unchanged"].includes(item.status)))
        setNotice("批量绑定完成；已有禁用绑定和加载时机均保持不变。");
    });
  const replanBindingConflicts = () =>
    void run(async () => {
      const refreshed = await expertsQuery.refetch(),
        experts = (refreshed.data ?? expertsQuery.data ?? []).filter((expert) => !expert.archived),
        targets = experts.filter((expert) => bindingTargets.includes(expert.id));
      if (!bindingSkillIds.length || !targets.length)
        throw new Error("没有可重新预演的技能或专家。");
      const requestId = globalThis.crypto.randomUUID(),
        revisions = Object.fromEntries(targets.map((expert) => [expert.id, expert.revision]));
      setBindingRequestId(requestId);
      setBindingTargetRevisions(revisions);
      setBindingApplied(false);
      const response = await call({
        action: "bindExperts",
        requestId,
        skillIds: bindingSkillIds,
        targets: targets.map((expert) => ({
          expertId: expert.id,
          expectedRevision: expert.revision,
        })),
        dryRun: true,
      });
      setBindingPlan(response.bindingResults);
    });
  const prepareBatchSourceUpdates = () =>
    void run(async () => {
      const localEdits = selectedItems.filter((skill) => skill.locallyModified);
      if (
        localEdits.length &&
        !globalThis.confirm(
          `将覆盖 ${localEdits.length} 个技能的本地编辑。继续预演批量来源更新吗？`,
        )
      )
        return;
      const requestIds = Object.fromEntries(
          selectedItems.map((skill) => [skill.skillId, globalThis.crypto.randomUUID()]),
        ),
        response = await call({
          action: "batch",
          dryRun: true,
          items: selectedItems.map((skill) => ({
            skillId: skill.skillId,
            expectedRevision: skill.revision,
            operation: "updateFromSource",
            requestId: requestIds[skill.skillId]!,
            ...(skill.locallyModified ? { overwriteLocalEdits: true } : {}),
          })),
        });
      setRefreshBases(selectedItems);
      setBatchUpdateRequestIds(requestIds);
      setResults(response.results);
    });
  const applyBatchSourceUpdates = () =>
    void run(async () => {
      const planned = new Set(
        (results ?? [])
          .filter((result) => result.updateResult?.preview)
          .map((result) => result.skillId),
      );
      const response = await call({
        action: "batch",
        items: refreshBases
          .filter((skill) => planned.has(skill.skillId))
          .map((skill) => ({
            skillId: skill.skillId,
            expectedRevision: skill.revision,
            operation: "updateFromSource",
            requestId: batchUpdateRequestIds[skill.skillId]!,
            expectedPackageId: results?.find((result) => result.skillId === skill.skillId)
              ?.updateResult?.preview?.package.packageId,
            ...(skill.locallyModified ? { overwriteLocalEdits: true } : {}),
          })),
      });
      setResults(response.results);
      await reload();
    });
  return (
    <div className="space-y-6">
      <section aria-label="技能库" className="flex flex-col gap-1.5 not-first:mt-4">
        <SettingsCard divided={false} className="@container min-w-0 p-4">
          <div className="space-y-4">
            {!connection.connected ? (
              <p role="status" className="text-ui-sm text-muted-foreground">
                服务器未连接，管理操作已暂停。
              </p>
            ) : null}
            {query.isError ? (
              <p role="alert" className="text-ui-sm text-destructive">
                技能库读取失败，请重试。
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="whitespace-pre-wrap text-ui-sm text-destructive">
                {error}
              </p>
            ) : null}
            {notice ? (
              <p role="status" className="text-ui-sm">
                {notice}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={busy || !connection.connected}
                  onClick={() => setCreateOpen(true)}
                >
                  新建技能
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !connection.connected}
                  onClick={() => {
                    clearPreviewOwnership();
                    setImportOpen(true);
                    setImportStep("choose");
                    setError(null);
                    setPreview(null);
                    setRefresh(null);
                    setChoices([]);
                  }}
                >
                  导入技能
                </Button>
              </div>
              <Button
                size="icon-sm"
                variant="ghost"
                className="ml-auto"
                aria-label="刷新列表"
                title="刷新列表"
                disabled={busy || !connection.connected || query.isFetching}
                onClick={() => void reload()}
              >
                <RefreshCwIcon aria-hidden="true" className="size-3.5" />
              </Button>
            </div>
            <SkillLibraryToolbar
              search={search}
              onSearchChange={setSearch}
              filters={{ usage, sources, expertIds, tags: filterTags }}
              onFiltersChange={(next) => {
                setUsage(next.usage);
                setSources(next.sources);
                setExpertIds(next.expertIds);
                setFilterTags(next.tags);
              }}
              experts={(expertsQuery.data ?? []).filter((expert) => !expert.archived)}
              tags={tagOptions}
              sort={sort}
              onSortChange={setSort}
              columns={columns}
              onColumnsChange={setColumns}
            />
            {selectedItems.length > 0 ? (
              <div
                role="group"
                aria-label="批量操作"
                className="space-y-3 border-t border-border pt-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-ui-sm">
                    已选 {selectedItems.length} 项
                    {hiddenSelectedCount ? `（${hiddenSelectedCount} 项在当前筛选外）` : ""}
                  </span>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setSelected([])}>
                    取消选择
                  </Button>
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      busy ||
                      !selectedItems.length ||
                      !expertsQuery.data?.length ||
                      !connection.connected
                    }
                    onClick={() => {
                      setBindingSkillIds(selectedItems.map((skill) => skill.skillId));
                      setBindingTargets([]);
                      setBindingTargetRevisions({});
                      setBindingRequestId(null);
                      setBindingPlan(undefined);
                      setBindingDialogOpen(true);
                    }}
                  >
                    添加到专家
                  </Button>
                  <Input
                    className="min-w-0 flex-1 basis-48"
                    aria-label="批量设置标签"
                    value={batchTags}
                    onChange={(event) => setBatchTags(event.target.value)}
                    placeholder="批量标签，用逗号分隔"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !selectedItems.length || !connection.connected}
                    onClick={() =>
                      void run(async () => {
                        setResults(
                          (
                            await call({
                              action: "batch",
                              items: selectedItems.map((skill) => ({
                                skillId: skill.skillId,
                                expectedRevision: skill.revision,
                                operation: "tags",
                                tags: tagsFrom(batchTags),
                              })),
                            })
                          ).results,
                        );
                        await reload();
                      })
                    }
                  >
                    应用标签
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !selectedItems.length || !connection.connected}
                    onClick={prepareBatchSourceUpdates}
                  >
                    批量更新来源
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || !selectedItems.length || !connection.connected}
                    onClick={() => void prepareDelete(selectedItems)}
                  >
                    批量删除
                  </Button>
                </div>
              </div>
            ) : null}
            {results?.length ? (
              <div className="space-y-2 rounded-lg border border-border p-3">
                <ul className="space-y-2 text-ui-sm" aria-label="批量操作结果">
                  {results.map((result, index) => (
                    <li
                      key={`${result.skillId}:${index}`}
                      className={result.success ? "" : "text-destructive"}
                    >
                      {allSkills.find((skill) => skill.skillId === result.skillId)?.name ??
                        result.skillId}{" "}
                      · {result.success ? "成功" : "失败"} · {result.message}
                      {(result.preview ?? result.updateResult?.preview) ? (
                        <>
                          <p className="text-ui-xs">
                            {(result.preview ?? result.updateResult?.preview)?.overwritesLocalEdits
                              ? "将覆盖本地编辑。"
                              : ""}
                            新包{" "}
                            {(
                              result.preview ?? result.updateResult?.preview
                            )?.package.packageId.slice(4, 16)}
                          </p>
                          <ul className="max-h-24 overflow-auto text-ui-xs">
                            {(result.preview ?? result.updateResult?.preview)?.resourceChanges.map(
                              (file) => (
                                <li key={file}>{file}</li>
                              ),
                            )}
                          </ul>
                        </>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {results.some((result) => result.updateResult?.preview) ? (
                  <Button
                    size="sm"
                    disabled={busy || !connection.connected}
                    onClick={applyBatchSourceUpdates}
                  >
                    确认上述来源更新
                  </Button>
                ) : null}
              </div>
            ) : null}
            <ul className="divide-y divide-border" aria-label="托管技能">
              {skills.map((skill) => (
                <li
                  key={skill.skillId}
                  className="grid min-w-0 gap-3 py-3 @xl:grid-cols-[var(--skill-library-columns)] @xl:items-center"
                  style={rowColumnStyle}
                >
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <Checkbox
                      className="mt-1 shrink-0"
                      aria-label={`选择 ${skill.name}`}
                      checked={selected.includes(skill.skillId)}
                      onCheckedChange={(checked) =>
                        setSelected((current) =>
                          checked
                            ? [...current, skill.skillId]
                            : current.filter((id) => id !== skill.skillId),
                        )
                      }
                    />
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => setDetailId(skill.skillId)}
                    >
                      <span className="block break-words text-ui font-medium">{skill.name}</span>
                      <span className="block break-words text-ui-sm text-muted-foreground">
                        {skill.description}
                      </span>
                      <span className="mt-1 flex flex-wrap gap-x-2 break-all text-ui-xs text-muted-foreground">
                        {skill.tags.length ? <span>{skill.tags.join(" · ")}</span> : null}
                        {skill.locallyModified ? <span>有本地编辑</span> : null}
                      </span>
                    </button>
                  </div>
                  {showUsage ? (
                    <div
                      role="group"
                      aria-label={`${skill.name} 使用和来源`}
                      className="flex min-w-0 flex-wrap gap-x-3 break-words text-ui-xs text-muted-foreground @xl:flex-col @xl:gap-1"
                    >
                      {columns.usage ? (
                        <span>
                          {metadata.get(skill.skillId)?.usage.expertIds.length ?? 0} 个绑定专家 /{" "}
                          {metadata.get(skill.skillId)?.usage.enabledExpertIds.length ?? 0} 个已启用
                        </span>
                      ) : null}
                      {columns.source ? <span>来源：{skill.source.kind}</span> : null}
                    </div>
                  ) : null}
                  {showDates ? (
                    <div
                      role="group"
                      aria-label={`${skill.name} 时间`}
                      className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] gap-x-3 gap-y-1 break-words text-ui-xs text-muted-foreground @xl:min-w-[10rem] @xl:grid-cols-1 @xl:justify-items-end @xl:text-right"
                    >
                      {columns.updated ? (
                        <span>更新时间：{formatShortDateTimestamp(skill.updatedAt, "locale")}</span>
                      ) : null}
                      {columns.created ? (
                        <span>
                          创建时间：
                          {skill.createdAt
                            ? formatShortDateTimestamp(skill.createdAt, "locale")
                            : "未知"}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="flex min-w-0 flex-wrap items-center gap-1 @xl:justify-end">
                    {supportsHostedUpdate(skill) ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || !connection.connected}
                        onClick={() =>
                          void (skill.locallyModified ? openRefresh(skill) : updateSource(skill))
                        }
                      >
                        {skill.locallyModified ? "预览并确认覆盖" : "更新来源"}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || !connection.connected}
                      onClick={() => void prepareDelete([skill])}
                    >
                      删除
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            {connection.connected && query.isPending ? (
              <SettingsEmptyState layout="status">
                <p role="status">正在读取技能库…</p>
              </SettingsEmptyState>
            ) : null}
            {connection.connected && !query.isPending && !query.isError && !skills.length ? (
              <SettingsEmptyState>
                {search.trim() ||
                usage !== "all" ||
                sources.length ||
                expertIds.length ||
                filterTags.length
                  ? "没有匹配的托管技能。"
                  : "尚未创建或导入技能。"}
              </SettingsEmptyState>
            ) : null}
          </div>
        </SettingsCard>
      </section>
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogPopup className="w-[min(44rem,calc(100vw-1.5rem))]">
          <DialogHeader>
            <DialogTitle>新建技能</DialogTitle>
            <DialogDescription>保存为托管 SKILL.md，不会执行其中的脚本。</DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <Input
              aria-label="新技能名称"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
            <Textarea
              aria-label="新技能 SKILL.md"
              rows={15}
              value={newBody}
              onChange={(event) => setNewBody(event.target.value)}
            />
            {error ? (
              <p role="alert" className="text-ui-sm text-destructive">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button
              disabled={busy || !connection.connected || !newName.trim()}
              onClick={() =>
                void run(async () => {
                  const result = await call({
                    action: "create",
                    name: newName,
                    body: newBody,
                    tags: [],
                  });
                  await reload();
                  setCreateOpen(false);
                  setDetailId(result.skill?.skillId ?? null);
                })
              }
            >
              创建
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={importOpen}
        onOpenChange={(open) => {
          if (!open) cancelImport();
        }}
      >
        <DialogPopup className="w-[min(48rem,calc(100vw-1.5rem))]">
          <DialogHeader>
            <div className="flex items-center gap-2 pr-8">
              {!refresh && importStep !== "choose" ? (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="返回导入方式"
                  disabled={busy}
                  onClick={() => {
                    clearPreviewOwnership();
                    setPreview(null);
                    setChoices([]);
                    setError(null);
                    setImportStep("choose");
                  }}
                >
                  <ArrowLeftIcon className="size-4" />
                </Button>
              ) : null}
              <DialogTitle>
                {refresh
                  ? "确认来源更新"
                  : importStep === "runtime"
                    ? "从运行时复制"
                    : importStep === "source"
                      ? kind === "url"
                        ? "从 URL 导入"
                        : "从本地导入"
                      : "导入技能"}
              </DialogTitle>
            </div>
            <DialogDescription>
              {!refresh && importStep === "choose"
                ? "选择添加技能的方式。"
                : !refresh && importStep === "runtime"
                  ? "把本机运行时中已安装的技能复制到技能库。"
                  : "保留完整包目录，只登记选中的 SKILL.md 入口。来源文件保持只读。"}
            </DialogDescription>
          </DialogHeader>
          {!refresh && importStep === "runtime" ? (
            <RuntimeSkillImportPanel
              onChanged={reload}
              onClose={cancelImport}
              onBusyChange={setBusy}
            />
          ) : (
            <>
              <DialogPanel className="space-y-3">
                {!refresh && importStep === "choose" ? (
                  <div className="space-y-2">
                    {[
                      {
                        value: "local",
                        title: "从本地导入",
                        description: "选择包含 SKILL.md 的文件夹，或 .skill / .zip 压缩包。",
                        icon: FolderIcon,
                      },
                      {
                        value: "url",
                        title: "从 URL 导入",
                        description: "通过网址导入 GitHub、Skills.sh 或 ClawHub 发布的技能。",
                        icon: DownloadIcon,
                      },
                      {
                        value: "runtime",
                        title: "从运行时复制",
                        description: "选择运行时，发现并复制已安装的技能。",
                        icon: DownloadIcon,
                      },
                    ].map((method) => (
                      <Button
                        key={method.value}
                        variant="outline"
                        className="h-auto w-full justify-start gap-3 rounded-xl p-4 text-left whitespace-normal sm:h-auto"
                        onClick={() => {
                          setKind(method.value as typeof kind);
                          setLocation("");
                          setImportStep(method.value === "runtime" ? "runtime" : "source");
                        }}
                      >
                        <method.icon
                          aria-hidden
                          className="size-5 shrink-0 text-muted-foreground"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-ui font-medium">{method.title}</span>
                          <span className="mt-1 block text-ui-sm font-normal text-muted-foreground">
                            {method.description}
                          </span>
                        </span>
                        <ChevronRightIcon
                          aria-hidden
                          className="size-4 shrink-0 text-muted-foreground"
                        />
                      </Button>
                    ))}
                  </div>
                ) : null}
                {!refresh && importStep === "source" ? (
                  <>
                    <div className="flex min-w-0 flex-wrap gap-2">
                      <Input
                        aria-label="技能导入来源"
                        className="min-w-0 flex-1 basis-64"
                        value={location}
                        onChange={(event) => setLocation(event.target.value)}
                        placeholder={
                          kind === "url"
                            ? "GitHub / Skills.sh / ClawHub URL"
                            : "文件夹、SKILL.md 或 .zip / .skill 路径"
                        }
                      />
                      <Button
                        size="sm"
                        disabled={busy || !location.trim() || !connection.connected}
                        onClick={() => void openImport(location, kind)}
                      >
                        预览
                      </Button>
                    </div>
                    {kind === "local" ? (
                      <label className="block space-y-1 text-ui-sm">
                        上传 .zip / .skill
                        <Input
                          aria-label="上传技能压缩包"
                          type="file"
                          accept=".zip,.skill"
                          disabled={busy || !connection.connected}
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (!file) return;
                            const uploadId = beginPreview();
                            setChoices([]);
                            void run(async () => {
                              const result = await checked(
                                transfer(
                                  `${SKILL_UPLOAD_ROUTE_PATH}?${new URLSearchParams({ name: file.name })}`,
                                  { method: "POST", body: file },
                                ).then(
                                  (response) => response.json() as Promise<SkillLibraryResponse>,
                                ),
                              );
                              adoptPreview(uploadId, result);
                            });
                            event.target.value = "";
                          }}
                        />
                      </label>
                    ) : null}
                  </>
                ) : null}
                {error ? (
                  <p role="alert" className="text-ui-sm text-destructive">
                    {error}
                  </p>
                ) : null}
                {preview ? (
                  <>
                    <p className="break-all text-ui-xs text-muted-foreground">
                      {preview.package.rootName} · {preview.package.fileCount} 文件 ·{" "}
                      {preview.package.totalBytes.toLocaleString()} B · {preview.package.packageId}
                    </p>
                    {preview.overwritesLocalEdits ? (
                      <p role="alert" className="text-ui-sm text-destructive">
                        来源更新会覆盖本地编辑。技能身份和专家绑定保留；当前运行及其恢复仍使用原版本。
                      </p>
                    ) : null}
                    {refresh ? (
                      <ul className="max-h-52 overflow-auto text-ui-sm">
                        {preview.resourceChanges.map((file) => (
                          <li key={file}>{file}</li>
                        ))}
                      </ul>
                    ) : (
                      <ul className="max-h-80 space-y-3 overflow-auto">
                        {preview.package.entries
                          .filter(
                            (entry) =>
                              !preview.selectedEntryPaths ||
                              preview.selectedEntryPaths.includes(entry.entryPath),
                          )
                          .map((entry) => {
                            const choice = choices.find(
                              (item) => item.entryPath === entry.entryPath,
                            );
                            return (
                              <li
                                key={entry.entryPath}
                                className="space-y-2 rounded-lg border border-border p-2"
                              >
                                <label className="flex items-center gap-2 text-ui-sm">
                                  <Checkbox
                                    checked={!!choice}
                                    aria-label={`导入 ${entry.entryPath}`}
                                    onCheckedChange={(checked) =>
                                      setChoices((current) =>
                                        checked
                                          ? [
                                              ...current,
                                              { entryPath: entry.entryPath, duplicate: "skip" },
                                            ]
                                          : current.filter(
                                              (item) => item.entryPath !== entry.entryPath,
                                            ),
                                      )
                                    }
                                  />
                                  {entry.name} · {entry.entryPath}
                                </label>
                                <p className="text-ui-sm text-muted-foreground">
                                  {entry.description}
                                </p>
                                {choice ? (
                                  <div className="flex flex-wrap gap-2">
                                    <Select
                                      value={choice.duplicate}
                                      onValueChange={(value) => {
                                        if (
                                          value === "skip" ||
                                          value === "rename" ||
                                          value === "replace"
                                        )
                                          updateChoice(entry.entryPath, { duplicate: value });
                                      }}
                                    >
                                      <SelectTrigger
                                        size="sm"
                                        className="w-36"
                                        aria-label={`重复处理 ${entry.entryPath}`}
                                      >
                                        <SelectValue>
                                          {choice.duplicate === "skip"
                                            ? "同名跳过"
                                            : choice.duplicate === "rename"
                                              ? "重命名"
                                              : "替换已有"}
                                        </SelectValue>
                                      </SelectTrigger>
                                      <SettingsSelectPopup>
                                        <SelectItem value="skip">同名跳过</SelectItem>
                                        <SelectItem value="rename">重命名</SelectItem>
                                        <SelectItem value="replace">替换已有</SelectItem>
                                      </SettingsSelectPopup>
                                    </Select>
                                    {choice.duplicate === "rename" ? (
                                      <Input
                                        aria-label={`重命名 ${entry.entryPath}`}
                                        value={choice.name ?? entry.name}
                                        onChange={(event) =>
                                          updateChoice(entry.entryPath, {
                                            name: event.target.value,
                                          })
                                        }
                                      />
                                    ) : choice.duplicate === "replace" ? (
                                      <Select
                                        value={choice.replaceSkillId ?? ""}
                                        onValueChange={(id) => {
                                          const skill = skills.find((item) => item.skillId === id);
                                          if (skill)
                                            updateChoice(entry.entryPath, {
                                              replaceSkillId: skill.skillId,
                                              expectedRevision: skill.revision,
                                            });
                                        }}
                                      >
                                        <SelectTrigger
                                          size="sm"
                                          className="w-48"
                                          aria-label={`替换目标 ${entry.entryPath}`}
                                        >
                                          <SelectValue placeholder="选择替换目标">
                                            {
                                              skills.find(
                                                (item) => item.skillId === choice.replaceSkillId,
                                              )?.name
                                            }
                                          </SelectValue>
                                        </SelectTrigger>
                                        <SettingsSelectPopup>
                                          {skills.map((skill) => (
                                            <SelectItem key={skill.skillId} value={skill.skillId}>
                                              {skill.name} · r{skill.revision}
                                            </SelectItem>
                                          ))}
                                        </SettingsSelectPopup>
                                      </Select>
                                    ) : null}
                                  </div>
                                ) : null}
                                {entry.issues.map((issue) => (
                                  <p key={issue} className="text-ui-xs text-muted-foreground">
                                    {issue}
                                  </p>
                                ))}
                              </li>
                            );
                          })}
                      </ul>
                    )}
                  </>
                ) : null}
              </DialogPanel>
              <DialogFooter>
                <Button variant="outline" onClick={cancelImport}>
                  取消
                </Button>
                {refresh || importStep === "source" ? (
                  <Button
                    disabled={
                      busy || !connection.connected || !preview || (!refresh && !choices.length)
                    }
                    onClick={() =>
                      void run(async () => {
                        if (!preview) return;
                        const result = refresh
                          ? await call({
                              action: "updateFromSource",
                              skillId: refresh.skillId,
                              expectedRevision: refresh.revision,
                              requestId: refreshRequestId!,
                              overwriteLocalEdits: true,
                              expectedPackageId: preview.package.packageId,
                            })
                          : await call({ action: "import", previewId: preview.previewId, choices });
                        clearPreviewOwnership(false);
                        await reload();
                        if (refresh) {
                          const update = result.updateResult;
                          if (!update || ["conflict", "failed", "skipped"].includes(update.status))
                            throw new Error(update?.error ?? "来源更新未能完成。");
                          setNotice(
                            update.status === "updated"
                              ? "来源已更新，专家绑定保持不变。"
                              : "来源内容未变化。",
                          );
                        } else setNotice(`已导入 ${result.skills?.length ?? 0} 个选中入口。`);
                        setImportOpen(false);
                        setPreview(null);
                        setRefresh(null);
                        setRefreshRequestId(null);
                      })
                    }
                  >
                    {refresh ? "确认覆盖并更新来源" : "导入选中入口"}
                  </Button>
                ) : null}
              </DialogFooter>
            </>
          )}
        </DialogPopup>
      </Dialog>
      <Dialog
        open={bindingDialogOpen}
        onOpenChange={(open) => {
          if (!busy) setBindingDialogOpen(open);
        }}
      >
        <DialogPopup className="w-[min(42rem,calc(100vw-1.5rem))]">
          <DialogHeader>
            <DialogTitle>添加技能到专家</DialogTitle>
            <DialogDescription>
              只追加缺少的绑定；已有绑定（包括禁用状态和加载时机）保持不变。新绑定启用且按需加载。
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <p className="text-ui-sm text-muted-foreground">
              将 {bindingSkillIds.length}{" "}
              个已选技能绑定到所选专家。计划与提交均由服务器按专家版本比较。
            </p>
            <ul className="max-h-64 divide-y divide-border overflow-auto">
              {(expertsQuery.data ?? [])
                .filter((expert) => !expert.archived)
                .map((expert) => (
                  <li key={expert.id} className="flex items-center gap-2 py-2">
                    <Checkbox
                      aria-label={`选择专家 ${expert.name}`}
                      checked={bindingTargets.includes(expert.id)}
                      disabled={!!bindingRequestId}
                      onCheckedChange={(checked) =>
                        setBindingTargets((current) =>
                          checked === true
                            ? [...current, expert.id]
                            : current.filter((id) => id !== expert.id),
                        )
                      }
                    />
                    <span className="min-w-0 flex-1 text-ui">{expert.name}</span>
                    <span className="text-ui-xs text-muted-foreground">r{expert.revision}</span>
                  </li>
                ))}
            </ul>
            {bindingPlan ? (
              <ul
                className="space-y-2 rounded-lg border border-border p-3 text-ui-sm"
                aria-label="绑定计划结果"
              >
                {bindingPlan.map((item) => (
                  <li
                    key={item.expertId}
                    className={
                      item.status === "applied" || item.status === "unchanged"
                        ? ""
                        : "text-destructive"
                    }
                  >
                    {expertsQuery.data?.find((expert) => expert.id === item.expertId)?.name ??
                      item.expertId}
                    {" · "}
                    {item.status === "applied"
                      ? `${bindingApplied ? "已添加" : "将添加"} ${item.addedSkillIds.length} 项`
                      : item.status === "unchanged"
                        ? "无需更改"
                        : (item.error ?? item.status)}
                    {item.skippedSkillIds.length
                      ? ` · ${item.skippedSkillIds.length} 项已绑定`
                      : ""}
                  </li>
                ))}
              </ul>
            ) : null}
            {bindingPlan?.some((item) => item.status === "conflict") ? (
              <p role="alert" className="text-ui-sm text-destructive">
                检测到专家版本冲突。请读取最新版本并重新预演后再应用。
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-ui-sm text-destructive">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setBindingDialogOpen(false)}>
              关闭
            </Button>
            <Button
              variant="outline"
              disabled={
                busy || !bindingTargets.length || !!bindingRequestId || !connection.connected
              }
              onClick={prepareBindingPlan}
            >
              预演绑定
            </Button>
            {bindingRequestId ? (
              bindingPlan?.some((item) => item.status === "conflict") ? (
                <Button disabled={busy || !connection.connected} onClick={replanBindingConflicts}>
                  读取最新版本并重新预演
                </Button>
              ) : (
                <Button
                  disabled={
                    busy ||
                    !connection.connected ||
                    (bindingApplied &&
                      bindingPlan?.every((item) => ["applied", "unchanged"].includes(item.status)))
                  }
                  onClick={applyBindingPlan}
                >
                  应用计划／重试失败项
                </Button>
              )
            ) : null}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={deletions !== null}
        onOpenChange={(open) => {
          if (!open) setDeletions(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>删除技能</DialogTitle>
            <DialogDescription>
              先解除以下专家绑定，再逻辑删除技能。当前运行、恢复和历史数据保留。
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <ul className="space-y-2 text-ui-sm">
              {deletions?.map(({ skill, expertIds }) => (
                <li key={skill.skillId}>
                  {skill.name} ·{" "}
                  {expertIds.length
                    ? `影响 ${expertIds.length} 个专家：${expertIds.join("、")}`
                    : "没有专家绑定"}
                </li>
              ))}
            </ul>
            {error ? (
              <p role="alert" className="text-ui-sm text-destructive">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setDeletions(null)}>
              取消
            </Button>
            <Button
              disabled={busy || !connection.connected}
              onClick={() =>
                void run(async () => {
                  setResults(
                    (
                      await call({
                        action: "batch",
                        items: (deletions ?? []).map(({ skill, expertIds }) => ({
                          skillId: skill.skillId,
                          expectedRevision: skill.revision,
                          operation: "delete",
                          confirmExpertIds: expertIds,
                        })),
                      })
                    ).results,
                  );
                  setDeletions(null);
                  setSelected([]);
                  await reload();
                })
              }
            >
              确认解绑并删除
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      {detail ? (
        <SkillLibraryDetail
          key={`${detail.skillId}:${connection.generation}`}
          initial={detail}
          onClose={() => setDetailId(null)}
          onDelete={(skill) => {
            setDetailId(null);
            void prepareDelete([skill]);
          }}
          onChanged={reload}
        />
      ) : null}
    </div>
  );
}
