import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ExpertDefinition, ExpertSaveInput } from "@synara/contracts";
import { ArrowLeftIcon } from "~/lib/icons";
import { ensureExpertClient } from "~/workbench/host/expertClient";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { SettingsEmptyState } from "./SettingsPanelPrimitives";
import { ExpertEditor, type ExpertEditorTab } from "./ExpertEditor";
import { ExpertList } from "./ExpertList";
import { ExpertActionsMenu } from "./ExpertActionsMenu";
import { ExpertPreviewPopover } from "./ExpertPreviewPopover";
import { ExpertSaveBar } from "./ExpertSaveBar";
import {
  expertDraftFromDefinition,
  expertDraftsEqual,
  expertSaveInputForDraft,
  validateExpertDraft,
} from "./expertSettingsModel";
import type { ExpertDraftIssue } from "./expertSettingsModel";
import { EXPERT_CONNECTIONS_QUERY_KEY, EXPERTS_QUERY_KEY } from "./expertSettingsQueries";
import { skillsCatalogQueryOptions } from "~/lib/providerDiscoveryReactQuery";
import { useExpertDraftGuard } from "./useExpertDraftGuard";

const EMPTY_EXPERTS: ReadonlyArray<ExpertDefinition> = [];

type ExpertActionType = "archive" | "restore" | "delete";
type ConfirmAction = { type: ExpertActionType; expert: ExpertDefinition } | null;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请重试。";
}

export function ExpertsSettingsPanel(props: {
  readonly active?: boolean;
  readonly initialExpertId?: string;
  readonly onOpenConnections?: (expertId: string, connectionId?: string) => void;
}) {
  const active = props.active ?? true;
  const requestedExpertId = props.initialExpertId ?? null;
  const queryClient = useQueryClient();
  const expertsQuery = useQuery({
    queryKey: EXPERTS_QUERY_KEY,
    queryFn: () => ensureExpertClient().listExperts(),
    enabled: active,
  });
  const experts = expertsQuery.data ?? EMPTY_EXPERTS;
  const [view, setView] = useState<"list" | "editor">("list");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<ExpertDefinition | null>(null);
  const [draft, setDraft] = useState<ExpertSaveInput | null>(null);
  const [tab, setTab] = useState<ExpertEditorTab>("settings");
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [displayConfirmAction, setDisplayConfirmAction] = useState<ConfirmAction>(null);
  const savingRef = useRef(false);
  const lastRouteRequestRef = useRef<string | null>(null);
  const baselineRef = useRef(baseline);
  const draftRef = useRef(draft);
  baselineRef.current = baseline;
  draftRef.current = draft;

  const readonly = baseline?.archived === true;
  const baselineDraft = useMemo(() => expertDraftFromDefinition(baseline ?? undefined), [baseline]);
  const isDirty = Boolean(draft && !readonly && !expertDraftsEqual(draft, baselineDraft));
  const issues = useMemo(() => (draft ? validateExpertDraft(draft) : []), [draft]);
  const showEditorData = active && view === "editor" && tab === "capabilities";
  const connectionsQuery = useQuery({
    queryKey: EXPERT_CONNECTIONS_QUERY_KEY,
    queryFn: () => ensureExpertClient().listExpertConnections(),
    enabled: showEditorData,
  });
  const skillsQuery = useQuery(skillsCatalogQueryOptions({ enabled: showEditorData }));

  const updateDraft = useCallback((patch: Partial<ExpertSaveInput>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setActionError(null);
  }, []);

  const discardDraft = useCallback(() => {
    const currentBaseline = baselineRef.current;
    const latestBaseline = currentBaseline
      ? (queryClient
          .getQueryData<ReadonlyArray<ExpertDefinition>>(EXPERTS_QUERY_KEY)
          ?.find((expert) => expert.id === currentBaseline.id) ?? currentBaseline)
      : null;
    const cleanDraft = expertDraftFromDefinition(latestBaseline ?? undefined);
    baselineRef.current = latestBaseline;
    draftRef.current = cleanDraft;
    setBaseline(latestBaseline);
    setDraft(cleanDraft);
    setActionError(null);
  }, [queryClient]);

  const saveDraft = useCallback(async (): Promise<ExpertDefinition | null> => {
    const currentDraft = draftRef.current;
    const currentBaseline = baselineRef.current;
    if (!currentDraft || currentBaseline?.archived || savingRef.current) return null;
    if (
      currentBaseline &&
      expertDraftsEqual(currentDraft, expertDraftFromDefinition(currentBaseline))
    ) {
      return currentBaseline;
    }
    const validationIssues = validateExpertDraft(currentDraft);
    if (validationIssues.length > 0) {
      setActionError(null);
      return null;
    }

    savingRef.current = true;
    setPending(true);
    setActionError(null);
    try {
      const saved = await ensureExpertClient().saveExpert(
        expertSaveInputForDraft(currentDraft, currentBaseline ?? undefined),
      );
      queryClient.setQueryData<ReadonlyArray<ExpertDefinition>>(EXPERTS_QUERY_KEY, (current) => {
        const latest = current ?? [];
        return latest.some((expert) => expert.id === saved.id)
          ? latest.map((expert) => (expert.id === saved.id ? saved : expert))
          : [saved, ...latest];
      });
      void queryClient.invalidateQueries({ queryKey: EXPERTS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: EXPERT_CONNECTIONS_QUERY_KEY });
      const cleanDraft = expertDraftFromDefinition(saved);
      baselineRef.current = saved;
      draftRef.current = cleanDraft;
      setBaseline(saved);
      setSelectedId(saved.id);
      setDraft(cleanDraft);
      return saved;
    } catch (error) {
      setActionError(errorText(error));
      void queryClient.invalidateQueries({ queryKey: EXPERTS_QUERY_KEY });
      return null;
    } finally {
      savingRef.current = false;
      setPending(false);
    }
  }, [queryClient]);

  const { confirmLeave, dialog: leaveDialog } = useExpertDraftGuard({
    isDirty,
    canSave: issues.length === 0,
    ...(issues[0] ? { saveDisabledReason: issues[0].message } : {}),
    onSave: async () => Boolean(await saveDraft()),
    onDiscard: discardDraft,
  });

  useEffect(() => {
    if (!requestedExpertId) {
      lastRouteRequestRef.current = null;
      return;
    }
    if (!expertsQuery.data || lastRouteRequestRef.current === requestedExpertId) return;
    const requested = experts.find((expert) => expert.id === requestedExpertId);
    lastRouteRequestRef.current = requestedExpertId;
    if (!requested) return;
    if (view === "editor" && baselineRef.current?.id === requested.id) return;

    void (async () => {
      if (!(await confirmLeave())) return;
      const latest =
        queryClient
          .getQueryData<ReadonlyArray<ExpertDefinition>>(EXPERTS_QUERY_KEY)
          ?.find((expert) => expert.id === requested.id) ?? requested;
      const nextDraft = expertDraftFromDefinition(latest);
      baselineRef.current = latest;
      draftRef.current = nextDraft;
      setBaseline(latest);
      setDraft(nextDraft);
      setSelectedId(latest.id);
      setTab("capabilities");
      setActionError(null);
      setView("editor");
    })();
  }, [confirmLeave, experts, expertsQuery.data, queryClient, requestedExpertId, view]);

  useEffect(() => {
    if (!baseline || !draft || !expertsQuery.data) return;
    const latest = experts.find((expert) => expert.id === baseline.id);
    if (!latest || latest.revision === baseline.revision) return;
    if (!expertDraftsEqual(draft, expertDraftFromDefinition(baseline))) return;
    const nextDraft = expertDraftFromDefinition(latest);
    baselineRef.current = latest;
    draftRef.current = nextDraft;
    setBaseline(latest);
    setDraft(nextDraft);
  }, [baseline, draft, experts, expertsQuery.data]);

  const openExpert = async (expert: ExpertDefinition) => {
    if (!(await confirmLeave())) return;
    const latest =
      queryClient
        .getQueryData<ReadonlyArray<ExpertDefinition>>(EXPERTS_QUERY_KEY)
        ?.find((candidate) => candidate.id === expert.id) ?? expert;
    const nextDraft = expertDraftFromDefinition(latest);
    baselineRef.current = latest;
    draftRef.current = nextDraft;
    setBaseline(latest);
    setDraft(nextDraft);
    setSelectedId(latest.id);
    setTab("capabilities");
    setActionError(null);
    setView("editor");
  };

  const startNew = async () => {
    if (!(await confirmLeave())) return;
    baselineRef.current = null;
    draftRef.current = expertDraftFromDefinition();
    setBaseline(null);
    setDraft(expertDraftFromDefinition());
    setSelectedId(null);
    setTab("settings");
    setActionError(null);
    setView("editor");
  };

  const latestExpert = (source: ExpertDefinition) => {
    const cached =
      queryClient
        .getQueryData<ReadonlyArray<ExpertDefinition>>(EXPERTS_QUERY_KEY)
        ?.find((expert) => expert.id === source.id) ?? source;
    const current = baselineRef.current;
    return current?.id === source.id && current.revision > cached.revision ? current : cached;
  };

  const duplicateExpert = async (source: ExpertDefinition) => {
    if (pending || !(await confirmLeave())) return;
    const current = latestExpert(source);
    const duplicate = expertDraftFromDefinition(current);
    const newDraft = { ...duplicate, name: `${current.name} 副本` };
    baselineRef.current = null;
    draftRef.current = newDraft;
    setBaseline(null);
    setDraft(newDraft);
    setSelectedId(null);
    setTab("settings");
    setActionError(null);
    setView("editor");
  };

  const backToList = async () => {
    if (!(await confirmLeave())) return;
    setView("list");
  };

  const openConnectionManager = async () => {
    if (!props.onOpenConnections) return;
    if (!(await confirmLeave())) return;
    let current = baselineRef.current;
    if (!current) current = (await saveDraft()) ?? null;
    if (!current || current.archived) return;
    props.onOpenConnections(current.id);
  };

  const requestExpertAction = async (type: ExpertActionType, source: ExpertDefinition) => {
    if (pending || !(await confirmLeave())) return;
    const expert = latestExpert(source);
    if (type === "archive" && expert.archived) return;
    if (type === "restore" && !expert.archived) return;
    const action = { type, expert };
    setActionError(null);
    setDisplayConfirmAction(action);
    setConfirmAction(action);
  };

  const runConfirmedAction = async () => {
    if (!confirmAction || pending) return;
    const action = confirmAction;
    const input = { id: action.expert.id, expectedRevision: action.expert.revision };
    setPending(true);
    setActionError(null);
    try {
      if (action.type === "delete") {
        await ensureExpertClient().deleteExpert(input);
        queryClient.setQueryData<ReadonlyArray<ExpertDefinition>>(EXPERTS_QUERY_KEY, (current) =>
          (current ?? []).filter((expert) => expert.id !== input.id),
        );
        if (selectedId === input.id) setSelectedId(null);
        if (baselineRef.current?.id === input.id) {
          baselineRef.current = null;
          draftRef.current = null;
          setBaseline(null);
          setDraft(null);
          setView("list");
        }
      } else {
        const result =
          action.type === "archive"
            ? await ensureExpertClient().archiveExpert(input)
            : await ensureExpertClient().restoreExpert(input);
        queryClient.setQueryData<ReadonlyArray<ExpertDefinition>>(EXPERTS_QUERY_KEY, (current) =>
          (current ?? []).map((expert) => (expert.id === result.id ? result : expert)),
        );
        if (baselineRef.current?.id === result.id) {
          const cleanDraft = expertDraftFromDefinition(result);
          baselineRef.current = result;
          draftRef.current = cleanDraft;
          setBaseline(result);
          setDraft(cleanDraft);
          if (action.type === "archive") setView("list");
        }
      }
      void queryClient.invalidateQueries({ queryKey: EXPERTS_QUERY_KEY });
      setConfirmAction(null);
    } catch (error) {
      setActionError(errorText(error));
      void queryClient.invalidateQueries({ queryKey: EXPERTS_QUERY_KEY });
      setConfirmAction(null);
    } finally {
      setPending(false);
    }
  };

  const expertActions = {
    onDuplicate: (expert: ExpertDefinition) => void duplicateExpert(expert),
    onArchive: (expert: ExpertDefinition) => void requestExpertAction("archive", expert),
    onRestore: (expert: ExpertDefinition) => void requestExpertAction("restore", expert),
    onDelete: (expert: ExpertDefinition) => void requestExpertAction("delete", expert),
  };

  const handleSaveKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLocaleLowerCase() !== "s") return;
    if (view !== "editor" || !active) return;
    event.preventDefault();
    event.stopPropagation();
    if (readonly || pending || !isDirty) return;
    void saveDraft();
  };

  const focusDraftIssue = (issue: ExpertDraftIssue) => {
    const settingsFields = new Set(["name", "description", "useCases", "preferredProvider"]);
    const nextTab: ExpertEditorTab = settingsFields.has(issue.field) ? "settings" : "capabilities";
    const targetLabel = (() => {
      switch (issue.field) {
        case "name":
          return "专家名称";
        case "description":
          return "专家描述";
        case "useCases":
          return "专家使用场景";
        case "preferredProvider":
          return "专家首选 Provider";
        case "persona":
          return "专家角色与工作方式";
        case "outputRequirements":
          return "专家输出要求";
        case "skills":
          return issue.index === undefined
            ? "添加技能"
            : `技能 ${issue.index + 1} ${issue.subfield === "path" ? "路径" : "名称"}`;
        case "skillSelections":
          return issue.index === undefined ? "选择技能" : `选择技能 ${issue.index + 1}`;
        case "references":
          return issue.index === undefined ? "添加参考资料" : `参考资料路径 ${issue.index + 1}`;
        case "connections":
          return "添加专家 MCP 连接";
      }
    })();
    setTab(nextTab);
    window.requestAnimationFrame(() => {
      const panel = document.getElementById(`expert-panel-${nextTab}`);
      const target = Array.from(panel?.querySelectorAll<HTMLElement>("[aria-label]") ?? []).find(
        (element) => element.getAttribute("aria-label") === targetLabel,
      );
      (target ?? panel)?.focus();
    });
  };

  const previewProvider = draft?.preferredProvider ?? "codex";
  const latestBaseline = baseline ? experts.find((expert) => expert.id === baseline.id) : undefined;
  const hasNewerRevision = Boolean(
    isDirty && baseline && latestBaseline && latestBaseline.revision !== baseline.revision,
  );

  const actionErrorMessage = actionError ? (
    <div
      className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-ui-sm text-destructive"
      role="alert"
    >
      {actionError}
    </div>
  ) : null;

  return (
    <div className="space-y-5" onKeyDown={handleSaveKey}>
      {view === "list" ? (
        expertsQuery.isPending && !expertsQuery.data ? (
          <SettingsEmptyState layout="status">正在读取专家…</SettingsEmptyState>
        ) : expertsQuery.isError && !expertsQuery.data ? (
          <SettingsEmptyState layout="status" tone="destructive">
            无法读取专家：{errorText(expertsQuery.error)}
          </SettingsEmptyState>
        ) : (
          <ExpertList
            experts={experts}
            selectedId={selectedId}
            busy={pending}
            onSelect={(expert) => void openExpert(expert)}
            onNew={() => void startNew()}
            status={
              actionErrorMessage ??
              (expertsQuery.isError ? (
                <SettingsEmptyState layout="status" tone="destructive">
                  无法刷新专家：{errorText(expertsQuery.error)}
                </SettingsEmptyState>
              ) : null)
            }
            {...expertActions}
          />
        )
      ) : draft ? (
        <>
          <ExpertEditor
            header={
              <div className="flex min-h-8 flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-32 flex-1 items-center gap-2">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="shrink-0"
                    aria-label="返回专家列表"
                    title="返回专家列表"
                    onClick={() => void backToList()}
                    disabled={pending}
                  >
                    <ArrowLeftIcon aria-hidden="true" className="size-4" />
                  </Button>
                  <h1
                    className="min-w-0 truncate text-ui-lg font-semibold"
                    title={baseline?.name ?? (draft.name.trim() || "新建专家")}
                  >
                    {baseline?.name ?? (draft.name.trim() || "新建专家")}
                  </h1>
                  {baseline ? (
                    <span className="shrink-0 text-ui-xs tabular-nums text-muted-foreground">
                      v{baseline.revision}
                    </span>
                  ) : null}
                  {baseline?.archived ? (
                    <span className="shrink-0 rounded-md bg-foreground/5 px-2 py-0.5 text-ui-xs text-muted-foreground">
                      已归档 · 只读
                    </span>
                  ) : null}
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-1">
                  <ExpertPreviewPopover
                    expert={baseline}
                    provider={previewProvider}
                    active={active && view === "editor"}
                    disabled={pending}
                  />
                  {baseline?.archived ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void requestExpertAction("restore", baseline)}
                      disabled={pending}
                    >
                      恢复专家
                    </Button>
                  ) : baseline ? (
                    <ExpertActionsMenu expert={baseline} busy={pending} {...expertActions} />
                  ) : null}
                </div>
              </div>
            }
            status={
              <>
                {actionErrorMessage}

                {hasNewerRevision && baseline ? (
                  <p
                    className="rounded-lg border border-border bg-foreground/2 px-3 py-2 text-ui-sm text-muted-foreground"
                    role="status"
                  >
                    服务端已有 v{latestBaseline?.revision}。当前更改仍基于 v{baseline.revision}
                    ；保存可能遇到版本冲突。放弃更改会载入最新版。
                  </p>
                ) : null}
              </>
            }
            draft={draft}
            issues={issues}
            tab={tab}
            readonly={readonly || pending}
            connections={connectionsQuery.data ?? []}
            connectionsLoading={connectionsQuery.isPending && !connectionsQuery.data}
            connectionsError={connectionsQuery.isError ? errorText(connectionsQuery.error) : null}
            catalog={skillsQuery.data?.skills ?? []}
            catalogLoading={skillsQuery.isPending && !skillsQuery.data}
            catalogError={skillsQuery.isError ? errorText(skillsQuery.error) : null}
            onTabChange={setTab}
            onChange={updateDraft}
            onOpenConnections={() => void openConnectionManager()}
          />

          {isDirty && !readonly ? (
            <ExpertSaveBar
              disabled={issues.length > 0}
              pending={pending}
              issueCount={issues.length}
              {...(issues[0] ? { issueSummary: issues[0].message } : {})}
              onSave={() => void saveDraft()}
              onDiscard={discardDraft}
              onFocusIssue={() => {
                const firstIssue = issues[0];
                if (firstIssue) focusDraftIssue(firstIssue);
              }}
            />
          ) : null}
        </>
      ) : null}

      {leaveDialog}
      <Dialog
        open={confirmAction !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setConfirmAction(null);
        }}
      >
        <DialogPopup showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {displayConfirmAction?.type === "delete"
                ? "删除这位专家？"
                : displayConfirmAction?.type === "archive"
                  ? "归档这位专家？"
                  : "恢复这位专家？"}
            </DialogTitle>
            <DialogDescription>
              {displayConfirmAction?.type === "delete"
                ? `删除“${displayConfirmAction.expert.name}”后无法恢复。已有任务继续使用原配置。`
                : displayConfirmAction?.type === "archive"
                  ? `“${displayConfirmAction.expert.name}”归档后会从使用中的专家列表移出。你可以之后再恢复。`
                  : `恢复“${displayConfirmAction?.expert.name ?? ""}”后，它会重新出现在使用中的专家列表中。`}
            </DialogDescription>
          </DialogHeader>

          <DialogFooter>
            <Button variant="ghost" disabled={pending} onClick={() => setConfirmAction(null)}>
              取消
            </Button>
            <Button
              variant={displayConfirmAction?.type === "restore" ? "default" : "destructive"}
              disabled={pending}
              onClick={() => void runConfirmedAction()}
            >
              {pending
                ? "处理中…"
                : displayConfirmAction?.type === "delete"
                  ? "确认删除"
                  : displayConfirmAction?.type === "archive"
                    ? "确认归档"
                    : "确认恢复"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
