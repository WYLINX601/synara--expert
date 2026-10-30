import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ExpertDefinition, ExpertSaveInput } from "@synara/contracts";
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
import { SettingsEditorDialog } from "./SettingsEditorDialog";
import { SettingsSegmentedControl } from "./SettingControls";
import {
  expertDraftFromDefinition,
  expertDraftsEqual,
  expertSaveInputForDraft,
  validateExpertDraft,
} from "./expertSettingsModel";
import type { ExpertDraftIssue } from "./expertSettingsModel";
import { SKILL_LIBRARY_QUERY_KEY } from "./ExpertSkillBindingsEditor";
import { EXPERT_CONNECTIONS_QUERY_KEY, EXPERTS_QUERY_KEY } from "./expertSettingsQueries";
import { useExpertDraftGuard } from "./useExpertDraftGuard";
import {
  HubTeamsSettingsPanel,
  type HubTeamsSettingsPanelHandle,
} from "~/features/hubCollaboration/HubTeamsSettingsPanel";

const SkillLibrarySettingsPanel = lazy(() =>
  import("./SkillLibrarySettingsPanel").then((module) => ({
    default: module.SkillLibrarySettingsPanel,
  })),
);

type ExpertCenterKind = "experts" | "teams" | "skills";

const EMPTY_EXPERTS: ReadonlyArray<ExpertDefinition> = [];

type ExpertActionType = "archive" | "restore" | "delete";
type ConfirmAction = { type: ExpertActionType; expert: ExpertDefinition } | null;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请重试。";
}

export function ExpertsSettingsPanel(props: {
  readonly active?: boolean;
  readonly centerRoute?: {
    readonly expertId: string | null;
    readonly kind?: ExpertCenterKind;
    readonly navigateKind?: (kind: ExpertCenterKind) => Promise<void>;
    readonly tab: ExpertEditorTab;
    readonly navigate: (
      expertId: string | null,
      tab: ExpertEditorTab,
      replace?: boolean,
    ) => Promise<void>;
  };
  readonly renderHistory?: (expertId: string, canExtract: boolean) => ReactNode;
  readonly renderEvolution?: (expert: ExpertDefinition, active: boolean) => ReactNode;
  readonly onUseExpert?: (expertId: string) => Promise<void>;
  readonly initialExpertId?: string;
  readonly onOpenConnections?: (expertId: string, connectionId?: string) => void;
}) {
  const active = props.active ?? true;
  const requestedExpertId = props.centerRoute?.expertId ?? props.initialExpertId ?? null;
  const queryClient = useQueryClient();
  const expertsQuery = useQuery({
    queryKey: EXPERTS_QUERY_KEY,
    queryFn: () => ensureExpertClient().listExperts(),
    enabled: active,
  });
  const experts = expertsQuery.data ?? EMPTY_EXPERTS;
  const [view, setView] = useState<"list" | "editor">("list");
  const [localSettingsKind, setSettingsKind] = useState<"experts" | "teams">("experts");
  const settingsKind = props.centerRoute?.kind ?? localSettingsKind;
  const hubTeamsPanelRef = useRef<HubTeamsSettingsPanelHandle>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<ExpertDefinition | null>(null);
  const [draft, setDraft] = useState<ExpertSaveInput | null>(null);
  const [tab, setTab] = useState<ExpertEditorTab>("settings");
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [displayConfirmAction, setDisplayConfirmAction] = useState<ConfirmAction>(null);
  const savingRef = useRef(false);
  const generationRef = useRef(0);
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const centerRouteRef = useRef(props.centerRoute);
  centerRouteRef.current = props.centerRoute;
  const lastRouteRequestRef = useRef<string | null>(null);
  const lastRouteKindRef = useRef(props.centerRoute?.kind);
  const baselineRef = useRef(baseline);
  const draftRef = useRef(draft);
  baselineRef.current = baseline;
  draftRef.current = draft;

  const readonly = baseline?.archived === true;
  const baselineDraft = useMemo(() => expertDraftFromDefinition(baseline ?? undefined), [baseline]);
  const isDirty = Boolean(
    settingsKind === "experts" && draft && !readonly && !expertDraftsEqual(draft, baselineDraft),
  );
  const issues = useMemo(() => (draft ? validateExpertDraft(draft) : []), [draft]);
  const showEditorData =
    settingsKind === "experts" && active && view === "editor" && tab === "capabilities";
  const connectionsQuery = useQuery({
    queryKey: EXPERT_CONNECTIONS_QUERY_KEY,
    queryFn: () => ensureExpertClient().listExpertConnections(),
    enabled: showEditorData,
  });

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
    const skillBindingsChanged = currentBaseline
      ? JSON.stringify(currentDraft.skillBindings ?? []) !==
        JSON.stringify(currentBaseline.skillBindings ?? [])
      : (currentDraft.skillBindings?.length ?? 0) > 0;
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

    const generation = generationRef.current;
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
      if (skillBindingsChanged)
        void queryClient.invalidateQueries({ queryKey: SKILL_LIBRARY_QUERY_KEY });
      if (generation !== generationRef.current) return null;
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
    ...(props.centerRoute
      ? {
          shouldGuardNavigation: ({
            currentPathname,
            nextPathname,
            currentSearch,
            nextSearch,
          }: {
            currentPathname: string;
            nextPathname: string;
            currentSearch: Readonly<Record<string, unknown>>;
            nextSearch: Readonly<Record<string, unknown>>;
          }) =>
            (currentPathname !== nextPathname || currentSearch.kind !== nextSearch.kind) &&
            Boolean(
              draftRef.current &&
              !expertDraftsEqual(
                draftRef.current,
                expertDraftFromDefinition(baselineRef.current ?? undefined),
              ),
            ),
        }
      : {}),
    canSave: issues.length === 0,
    ...(issues[0] ? { saveDisabledReason: issues[0].message } : {}),
    onSave: async () => Boolean(await saveDraft()),
    onDiscard: discardDraft,
  });

  const changeSettingsKind = async (next: ExpertCenterKind) => {
    if (next === settingsKind) return;
    if (settingsKind === "teams") {
      const teamPanel = hubTeamsPanelRef.current;
      if (teamPanel && !(await teamPanel.confirmLeave())) return;
    } else if (!(await confirmLeave())) {
      return;
    }
    if (props.centerRoute?.navigateKind) {
      await props.centerRoute.navigateKind(next);
    } else if (next !== "skills") {
      setSettingsKind(next);
    }
  };

  // Route changes reach this controller only after the shared route blocker has settled.
  useEffect(() => {
    const route = centerRouteRef.current;
    if (!route) return;
    if (!expertsQuery.data) return;
    if (route.expertId === lastRouteRequestRef.current && route.kind === lastRouteKindRef.current)
      return;
    generationRef.current += 1;
    lastRouteRequestRef.current = route.expertId;
    lastRouteKindRef.current = route.kind;
    const requested = expertsQuery.data.find((expert) => expert.id === route.expertId);
    baselineRef.current = requested ?? null;
    draftRef.current = requested ? expertDraftFromDefinition(requested) : null;
    setBaseline(baselineRef.current);
    setDraft(draftRef.current);
    setSelectedId(requested?.id ?? null);
    setView(route.expertId ? "editor" : "list");
    setActionError(null);
  }, [props.centerRoute?.expertId, props.centerRoute?.kind, expertsQuery.data]);

  useEffect(() => {
    if (props.centerRoute) setTab(props.centerRoute.tab);
  }, [props.centerRoute?.tab]);

  useEffect(() => {
    if (centerRouteRef.current) return;
    if (!requestedExpertId) {
      lastRouteRequestRef.current = null;
      return;
    }
    if (!expertsQuery.data || lastRouteRequestRef.current === requestedExpertId) return;
    const requested = experts.find((expert) => expert.id === requestedExpertId);
    if (!requested) {
      lastRouteRequestRef.current = requestedExpertId;
      return;
    }
    if (
      settingsKind === "experts" &&
      view === "editor" &&
      baselineRef.current?.id === requested.id
    ) {
      lastRouteRequestRef.current = requestedExpertId;
      return;
    }

    void (async () => {
      if (settingsKind === "teams" && !(await hubTeamsPanelRef.current?.confirmLeave())) return;
      if (!(await confirmLeave())) return;
      lastRouteRequestRef.current = requestedExpertId;
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
      setTab("settings");
      setActionError(null);
      setSettingsKind("experts");
      setView("editor");
    })();
  }, [
    confirmLeave,
    experts,
    expertsQuery.data,
    queryClient,
    requestedExpertId,
    settingsKind,
    view,
  ]);

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
    if (props.centerRoute) {
      await props.centerRoute.navigate(expert.id, "settings");
      return;
    }
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
    setTab("settings");
    setActionError(null);
    setView("editor");
  };

  const startNew = async () => {
    if (!(await confirmLeave())) return;
    if (props.centerRoute) {
      lastRouteRequestRef.current = null;
      await props.centerRoute.navigate(null, "settings");
    }
    generationRef.current += 1;
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
    if (props.centerRoute) {
      lastRouteRequestRef.current = null;
      await props.centerRoute.navigate(null, "settings");
    }
    generationRef.current += 1;
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
    if (pending || starting) return;
    if (!(await confirmLeave())) return;
    if (props.centerRoute) await props.centerRoute.navigate(null, "capabilities");
    setView("list");
    setDraft(null);
    draftRef.current = null;
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
          if (props.centerRoute) await props.centerRoute.navigate(null, "capabilities", true);
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
          if (action.type === "archive") {
            setView("list");
            if (props.centerRoute) await props.centerRoute.navigate(null, "capabilities", true);
          }
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

  const saveAndLocate = async () => {
    const saved = await saveDraft();
    if (saved && centerRouteRef.current && centerRouteRef.current.expertId !== saved.id) {
      lastRouteRequestRef.current = saved.id;
      await centerRouteRef.current.navigate(saved.id, tab, true);
    }
  };
  const changeTab = (next: ExpertEditorTab) => {
    setTab(next);
    if (props.centerRoute) void props.centerRoute.navigate(props.centerRoute.expertId, next);
  };
  const useExpert = async () => {
    if (!props.onUseExpert || startingRef.current || pending) return;
    startingRef.current = true;
    setStarting(true);
    try {
      if (!(await confirmLeave())) return;
      let current = baselineRef.current;
      if (!current) current = await saveDraft();
      if (current && !current.archived) await props.onUseExpert(current.id);
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  };

  const handleSaveKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLocaleLowerCase() !== "s") return;
    if (settingsKind !== "experts") return;
    if (view !== "editor" || !active) return;
    event.preventDefault();
    event.stopPropagation();
    if (readonly || pending || !isDirty) return;
    void saveAndLocate();
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
        case "skillBindings":
          return "技能";
        case "references":
          return issue.index === undefined ? "添加参考资料" : `参考资料路径 ${issue.index + 1}`;
        case "connections":
          return "添加专家 MCP 连接";
      }
    })();
    changeTab(nextTab);
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
    <div className="flex min-h-0 flex-1 flex-col gap-5" onKeyDown={handleSaveKey}>
      <div className={props.centerRoute ? "border-b border-border pb-3" : undefined}>
        <SettingsSegmentedControl
          value={settingsKind}
          onValueChange={(next) => void changeSettingsKind(next)}
          ariaLabel="专家设置分类"
          options={[
            { value: "experts", label: props.centerRoute ? "专家" : "单个专家" },
            { value: "teams", label: "专家团" },
            ...(props.centerRoute ? [{ value: "skills" as const, label: "技能" }] : []),
          ]}
        />
      </div>
      {props.centerRoute?.expertId &&
      expertsQuery.data &&
      !experts.some((expert) => expert.id === props.centerRoute?.expertId) ? (
        <SettingsEmptyState layout="status">
          <p>该专家不存在或已删除。</p>
          <Button variant="outline" onClick={() => void backToList()}>
            返回专家列表
          </Button>
        </SettingsEmptyState>
      ) : settingsKind === "teams" ? (
        <HubTeamsSettingsPanel
          ref={hubTeamsPanelRef}
          active={active}
          {...(props.centerRoute
            ? {
                shouldGuardNavigation: ({
                  currentPathname,
                  nextPathname,
                  nextSearch,
                }: {
                  currentPathname: string;
                  nextPathname: string;
                  nextSearch: Readonly<Record<string, unknown>>;
                }) => currentPathname !== nextPathname || nextSearch.kind !== "teams",
              }
            : {})}
          experts={expertsQuery.data}
          expertsLoading={expertsQuery.isPending || expertsQuery.isFetching}
          expertsError={expertsQuery.error ? errorText(expertsQuery.error) : null}
        />
      ) : settingsKind === "skills" ? (
        <Suspense
          fallback={<SettingsEmptyState layout="status">正在读取技能库…</SettingsEmptyState>}
        >
          <SkillLibrarySettingsPanel />
        </Suspense>
      ) : expertsQuery.isPending && !expertsQuery.data ? (
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
      )}
      {settingsKind === "experts" && draft && view === "editor" && active ? (
        <SettingsEditorDialog
          open
          onClose={() => void backToList()}
          closeButtonLabel="关闭专家编辑"
        >
          <ExpertEditor
            key={selectedId ?? `new-expert:${generationRef.current}`}
            header={
              <div className="flex min-h-8 flex-wrap items-center justify-between gap-2 pr-8">
                <div className="flex min-w-32 flex-1 items-center gap-2">
                  <DialogTitle
                    render={<h1 />}
                    className="min-w-0 truncate text-ui-lg font-semibold"
                    title={baseline?.name ?? (draft.name.trim() || "新建专家")}
                  >
                    {baseline?.name ?? (draft.name.trim() || "新建专家")}
                  </DialogTitle>
                  {baseline?.archived ? (
                    <span className="shrink-0 rounded-md bg-foreground/5 px-2 py-0.5 text-ui-xs text-muted-foreground">
                      已归档 · 只读
                    </span>
                  ) : null}
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-1">
                  {props.onUseExpert && !readonly ? (
                    <Button
                      size="sm"
                      disabled={pending || starting}
                      onClick={() => void useExpert()}
                    >
                      {starting ? "准备中…" : "对话"}
                    </Button>
                  ) : null}
                  {baseline?.archived ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void requestExpertAction("restore", baseline)}
                      disabled={pending}
                    >
                      恢复专家
                    </Button>
                  ) : null}
                  {baseline ? (
                    <ExpertPreviewPopover
                      expert={baseline}
                      provider={previewProvider}
                      active={active && view === "editor"}
                      disabled={pending}
                      renderTrigger={({ onCheck, disabled, anchorRef }) => (
                        <ExpertActionsMenu
                          expert={baseline}
                          busy={pending}
                          {...expertActions}
                          triggerRef={anchorRef}
                          checkConfiguration={{ onCheck, disabled }}
                          showRestore={!baseline.archived}
                        />
                      )}
                    />
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
                    专家配置已在其他位置更新。当前草稿仍保留；保存前请核对更改，或放弃更改以载入最新配置。
                  </p>
                ) : null}
              </>
            }
            history={
              baseline && props.renderHistory
                ? props.renderHistory(baseline.id, !readonly)
                : undefined
            }
            evolution={
              baseline && props.renderEvolution
                ? props.renderEvolution(
                    baseline,
                    active && view === "editor" && tab === "evolution",
                  )
                : undefined
            }
            draft={draft}
            issues={issues}
            tab={tab}
            readonly={readonly || pending}
            connections={connectionsQuery.data ?? []}
            connectionsLoading={connectionsQuery.isPending && !connectionsQuery.data}
            connectionsError={connectionsQuery.isError ? errorText(connectionsQuery.error) : null}
            onTabChange={changeTab}
            onChange={updateDraft}
            onOpenConnections={() => void openConnectionManager()}
          />

          {!readonly ? (
            <ExpertSaveBar
              evolution={tab === "evolution"}
              disabled={issues.length > 0}
              pending={pending}
              dirty={isDirty}
              onClose={() => void backToList()}
              issueCount={issues.length}
              {...(issues[0] ? { issueSummary: issues[0].message } : {})}
              onSave={() => void saveAndLocate()}
              onDiscard={discardDraft}
              onFocusIssue={() => {
                const firstIssue = issues[0];
                if (firstIssue) focusDraftIssue(firstIssue);
              }}
            />
          ) : null}
        </SettingsEditorDialog>
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
