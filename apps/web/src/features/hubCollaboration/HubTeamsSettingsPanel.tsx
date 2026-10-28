import type { ExpertDefinition, HubTeamPreset, HubTeamSaveInput } from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import {
  useExpertDraftGuard,
  type UseExpertDraftGuardOptions,
} from "~/components/settings/useExpertDraftGuard";
import {
  SettingsCard,
  SettingsEmptyState,
  SettingsListRow,
  SettingsSectionShell,
} from "~/components/settings/SettingsPanelPrimitives";
import { HubExpertSelectionSection } from "~/features/hubCollaboration/HubExpertSelectionSection";
import { useNativeApiServerCapabilitySnapshot } from "~/hooks/useNativeApiServerCapability";
import { ensureHubTeamsClient } from "~/workbench/host/hubCollaborationClient";

export const hubTeamsQueryKey = (generation: string | null) => ["hub-teams", generation] as const;

const EMPTY_TEAMS: ReadonlyArray<HubTeamPreset> = [];

interface HubTeamDraft {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
  readonly expertIds: ReadonlyArray<string>;
  readonly coordinatorInstructions: string;
  readonly collaborationPreferences: string;
}

export interface HubTeamsSettingsPanelHandle {
  confirmLeave: () => Promise<boolean>;
}

function draftFromTeam(team?: HubTeamPreset | null): HubTeamDraft {
  return {
    id: team?.id ?? `team-${crypto.randomUUID()}`,
    name: team?.name ?? "",
    purpose: team?.purpose ?? "",
    expertIds: [...new Set(team?.expertIds ?? [])],
    coordinatorInstructions: team?.coordinatorInstructions ?? "",
    collaborationPreferences: team?.collaborationPreferences ?? "",
  };
}

function teamDraftsEqual(left: HubTeamDraft | null, right: HubTeamDraft | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.id === right.id &&
    left.name.trim() === right.name.trim() &&
    left.purpose === right.purpose &&
    left.coordinatorInstructions === right.coordinatorInstructions &&
    left.collaborationPreferences === right.collaborationPreferences &&
    left.expertIds.length === right.expertIds.length &&
    left.expertIds.every((id) => right.expertIds.includes(id))
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "保存失败，请重试。";
}

export const HubTeamsSettingsPanel = forwardRef<
  HubTeamsSettingsPanelHandle,
  {
    readonly active: boolean;
    readonly shouldGuardNavigation?: UseExpertDraftGuardOptions["shouldGuardNavigation"];
    readonly experts: ReadonlyArray<ExpertDefinition> | undefined;
    readonly expertsLoading: boolean;
    readonly expertsError: string | null;
  }
>(function HubTeamsSettingsPanel(props, ref) {
  const queryClient = useQueryClient();
  const { generation } = useNativeApiServerCapabilitySnapshot("hubCollaboration.team.presets");
  const teamsKey = useMemo(() => hubTeamsQueryKey(generation), [generation]);
  const teamsQuery = useQuery({
    queryKey: teamsKey,
    queryFn: () => ensureHubTeamsClient().list(),
    enabled: props.active,
  });
  const teams = teamsQuery.data ?? EMPTY_TEAMS;
  const [view, setView] = useState<"list" | "editor">("list");
  const [archivedView, setArchivedView] = useState(false);
  const [search, setSearch] = useState("");
  const [baseline, setBaseline] = useState<HubTeamPreset | null>(null);
  const [draft, setDraft] = useState<HubTeamDraft | null>(null);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [ownerChanged, setOwnerChanged] = useState(false);
  const [coordinatorOpen, setCoordinatorOpen] = useState(false);
  const [archiveAction, setArchiveAction] = useState<{
    readonly team: HubTeamPreset;
    readonly archived: boolean;
  } | null>(null);
  const [archivePending, setArchivePending] = useState(false);
  const savingRef = useRef(false);
  const baselineRef = useRef(baseline);
  const draftRef = useRef(draft);
  const sessionRef = useRef(0);
  const generationRef = useRef(generation);
  const previousGenerationRef = useRef(generation);
  const editorGenerationRef = useRef(generation);
  baselineRef.current = baseline;
  draftRef.current = draft;
  generationRef.current = generation;

  const isDirty = Boolean(
    draft && !teamDraftsEqual(draft, baseline ? draftFromTeam(baseline) : null),
  );
  const validationError = ownerChanged
    ? "服务连接已变化。放弃当前草稿后重新载入专家团。"
    : !draft || draft.name.trim().length === 0
      ? "请填写专家团名称。"
      : draft.expertIds.length === 0
        ? "至少选择一位专家。"
        : draft.expertIds.length > 64
          ? "一个专家团最多选择 64 位专家。"
          : null;

  useEffect(() => {
    if (previousGenerationRef.current === generation) return;
    previousGenerationRef.current = generation;
    sessionRef.current += 1;
    savingRef.current = false;
    setPending(false);
    setArchivePending(false);
    setArchiveAction(null);
    if (view === "editor") {
      setOwnerChanged(true);
      setActionError("服务连接已变化。当前草稿仍保留，放弃后可载入新服务中的专家团。");
    }
  }, [generation, view]);

  const updateDraft = useCallback((patch: Partial<HubTeamDraft>) => {
    setDraft((current) => {
      const next = current ? { ...current, ...patch } : current;
      draftRef.current = next;
      return next;
    });
    setActionError(null);
  }, []);

  const discardDraft = useCallback(() => {
    if (ownerChanged || editorGenerationRef.current !== generationRef.current) {
      sessionRef.current += 1;
      setOwnerChanged(false);
      editorGenerationRef.current = generationRef.current;
      baselineRef.current = null;
      draftRef.current = null;
      setBaseline(null);
      setDraft(null);
      setView("list");
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: hubTeamsQueryKey(generationRef.current) });
      return;
    }
    const currentBaseline = baselineRef.current;
    const currentTeams = queryClient.getQueryData<ReadonlyArray<HubTeamPreset>>(
      hubTeamsQueryKey(generationRef.current),
    );
    const latest = currentBaseline
      ? (currentTeams?.find((team) => team.id === currentBaseline.id) ?? currentBaseline)
      : null;
    if (!latest) {
      sessionRef.current += 1;
      setOwnerChanged(false);
      editorGenerationRef.current = generationRef.current;
      baselineRef.current = null;
      draftRef.current = null;
      setBaseline(null);
      setDraft(null);
      setView("list");
      setActionError(null);
      return;
    }
    const cleanDraft = draftFromTeam(latest);
    baselineRef.current = latest;
    draftRef.current = cleanDraft;
    setBaseline(latest);
    setDraft(cleanDraft);
    setActionError(null);
    setOwnerChanged(false);
  }, [ownerChanged, queryClient]);

  const saveDraft = useCallback(async (): Promise<HubTeamPreset | null> => {
    const currentDraft = draftRef.current;
    const currentBaseline = baselineRef.current;
    if (!currentDraft || savingRef.current) return null;
    if (currentBaseline && teamDraftsEqual(currentDraft, draftFromTeam(currentBaseline))) {
      return currentBaseline;
    }
    if (currentDraft.name.trim().length === 0) {
      setActionError("请填写专家团名称。");
      return null;
    }
    if (currentDraft.expertIds.length === 0) {
      setActionError("至少选择一位专家。");
      return null;
    }
    if (currentDraft.expertIds.length > 64) {
      setActionError("一个专家团最多选择 64 位专家。");
      return null;
    }

    const requestGeneration = generationRef.current;
    if (editorGenerationRef.current !== requestGeneration) {
      setOwnerChanged(true);
      setActionError("服务连接已变化。放弃当前草稿后重新载入专家团。");
      return null;
    }
    const session = sessionRef.current;
    const requestDraft = currentDraft;
    const input: HubTeamSaveInput = {
      id: requestDraft.id,
      name: requestDraft.name.trim(),
      purpose: requestDraft.purpose,
      expertIds: [...new Set(requestDraft.expertIds)],
      ...(requestDraft.coordinatorInstructions.trim()
        ? { coordinatorInstructions: requestDraft.coordinatorInstructions }
        : {}),
      ...(requestDraft.collaborationPreferences.trim()
        ? { collaborationPreferences: requestDraft.collaborationPreferences }
        : {}),
      expectedRevision: currentBaseline?.revision ?? null,
      requestId: crypto.randomUUID(),
    };
    savingRef.current = true;
    setPending(true);
    setActionError(null);
    try {
      const saved = await ensureHubTeamsClient().save(input);
      queryClient.setQueryData<ReadonlyArray<HubTeamPreset>>(
        hubTeamsQueryKey(requestGeneration),
        (current) => {
          const latest = current ?? [];
          return latest.some((team) => team.id === saved.id)
            ? latest.map((team) => (team.id === saved.id ? saved : team))
            : [saved, ...latest];
        },
      );
      void queryClient.invalidateQueries({ queryKey: hubTeamsQueryKey(requestGeneration) });
      if (generationRef.current !== requestGeneration || sessionRef.current !== session)
        return null;
      const cleanDraft = draftFromTeam(saved);
      baselineRef.current = saved;
      draftRef.current = cleanDraft;
      setBaseline(saved);
      setDraft(cleanDraft);
      setView("list");
      setArchivedView(false);
      return saved;
    } catch (error) {
      if (generationRef.current !== requestGeneration || sessionRef.current !== session)
        return null;
      const latest = teamsQuery.data?.find((team) => team.id === requestDraft.id);
      setActionError(
        currentBaseline && latest && latest.revision > currentBaseline.revision
          ? `专家团已在其他位置保存为 v${latest.revision}；当前草稿仍保留。放弃更改可载入最新版。`
          : errorText(error),
      );
      void queryClient.invalidateQueries({ queryKey: hubTeamsQueryKey(requestGeneration) });
      return null;
    } finally {
      savingRef.current = false;
      if (generationRef.current === requestGeneration && sessionRef.current === session) {
        setPending(false);
      }
    }
  }, [queryClient, teamsQuery.data]);

  const { confirmLeave, dialog: leaveDialog } = useExpertDraftGuard({
    isDirty: props.active && isDirty,
    ...(props.shouldGuardNavigation ? { shouldGuardNavigation: props.shouldGuardNavigation } : {}),
    canSave: validationError === null,
    ...(validationError ? { saveDisabledReason: validationError } : {}),
    onSave: async () => Boolean(await saveDraft()),
    onDiscard: discardDraft,
  });
  useImperativeHandle(ref, () => ({ confirmLeave }), [confirmLeave]);

  useEffect(() => {
    if (!baseline || !draft || !teamsQuery.data) return;
    if (editorGenerationRef.current !== generationRef.current) {
      setOwnerChanged(true);
      return;
    }
    const latest = teamsQuery.data.find((team) => team.id === baseline.id);
    if (!latest || latest.revision === baseline.revision) return;
    if (!teamDraftsEqual(draft, draftFromTeam(baseline))) return;
    const next = draftFromTeam(latest);
    baselineRef.current = latest;
    draftRef.current = next;
    setBaseline(latest);
    setDraft(next);
  }, [baseline, draft, teamsQuery.data]);

  const openNew = async () => {
    if (pending || !(await confirmLeave())) return;
    sessionRef.current += 1;
    const next = draftFromTeam();
    baselineRef.current = null;
    draftRef.current = next;
    setBaseline(null);
    setDraft(next);
    setCoordinatorOpen(false);
    setActionError(null);
    setView("editor");
    editorGenerationRef.current = generationRef.current;
    setOwnerChanged(false);
  };

  const openTeam = async (team: HubTeamPreset) => {
    if (pending || !(await confirmLeave())) return;
    const latest =
      queryClient
        .getQueryData<ReadonlyArray<HubTeamPreset>>(hubTeamsQueryKey(generationRef.current))
        ?.find((candidate) => candidate.id === team.id) ?? team;
    sessionRef.current += 1;
    const next = draftFromTeam(latest);
    editorGenerationRef.current = generationRef.current;
    setOwnerChanged(false);
    baselineRef.current = latest;
    draftRef.current = next;
    setBaseline(latest);
    setDraft(next);
    setCoordinatorOpen(false);
    setActionError(null);
    setView("editor");
  };

  const backToList = async () => {
    if (!(await confirmLeave())) return;
    setView("list");
  };

  const runArchiveAction = async () => {
    if (!archiveAction || archivePending) return;
    const action = archiveAction;
    const requestGeneration = generationRef.current;
    setArchivePending(true);
    setActionError(null);
    try {
      const result = await ensureHubTeamsClient().setArchived({
        id: action.team.id,
        expectedRevision: action.team.revision,
        requestId: crypto.randomUUID(),
        archived: action.archived,
      });
      queryClient.setQueryData<ReadonlyArray<HubTeamPreset>>(
        hubTeamsQueryKey(requestGeneration),
        (current) => (current ?? []).map((team) => (team.id === result.id ? result : team)),
      );
      void queryClient.invalidateQueries({ queryKey: hubTeamsQueryKey(requestGeneration) });
      if (generationRef.current === requestGeneration) setArchiveAction(null);
    } catch (error) {
      if (generationRef.current === requestGeneration) {
        setActionError(errorText(error));
        setArchiveAction(null);
      }
      void queryClient.invalidateQueries({ queryKey: hubTeamsQueryKey(requestGeneration) });
    } finally {
      if (generationRef.current === requestGeneration) setArchivePending(false);
    }
  };

  const expertNames = useMemo(
    () => new Map((props.experts ?? []).map((expert) => [expert.id, expert.name])),
    [props.experts],
  );
  const visibleTeams = useMemo(() => {
    const normalized = search.trim().toLocaleLowerCase();
    return teams
      .filter((team) => Boolean(team.archivedAt) === archivedView)
      .filter(
        (team) =>
          normalized.length === 0 ||
          `${team.name} ${team.purpose}`.toLocaleLowerCase().includes(normalized),
      )
      .toSorted((left, right) => left.name.localeCompare(right.name));
  }, [archivedView, search, teams]);
  const readonly = baseline?.archivedAt !== null && baseline !== null;
  const latestBaseline = baseline ? teams.find((team) => team.id === baseline.id) : undefined;
  const hasNewerRevision = Boolean(
    isDirty && baseline && latestBaseline && latestBaseline.revision > baseline.revision,
  );

  return (
    <div className="space-y-5">
      {view === "list" ? (
        teamsQuery.isPending && !teamsQuery.data ? (
          <SettingsEmptyState layout="status">正在读取专家团…</SettingsEmptyState>
        ) : teamsQuery.isError && !teamsQuery.data ? (
          <SettingsEmptyState layout="status" tone="destructive">
            无法读取专家团：{errorText(teamsQuery.error)}
          </SettingsEmptyState>
        ) : (
          <>
            {actionError ? (
              <div
                className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-ui-sm text-destructive"
                role="alert"
              >
                {actionError}
              </div>
            ) : null}
            <SettingsSectionShell
              title={archivedView ? "已归档的专家团" : "专家团"}
              layout="compact"
              count={visibleTeams.length}
              action={
                archivedView ? (
                  <Button size="sm" variant="outline" onClick={() => setArchivedView(false)}>
                    返回专家团
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => void openNew()}>
                    新建专家团
                  </Button>
                )
              }
            >
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="搜索专家团"
                    aria-label="搜索专家团"
                  />
                  {!archivedView ? (
                    <Button size="sm" variant="ghost" onClick={() => setArchivedView(true)}>
                      查看已归档
                    </Button>
                  ) : null}
                </div>
                {visibleTeams.length > 0 ? (
                  <SettingsCard>
                    {visibleTeams.map((team) => {
                      const members = team.expertIds
                        .map((id) => expertNames.get(id) ?? `${id} · 不可用`)
                        .join("、");
                      const action = team.archivedAt ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setArchiveAction({ team, archived: false })}
                        >
                          恢复
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setArchiveAction({ team, archived: true })}
                        >
                          归档
                        </Button>
                      );
                      return (
                        <SettingsListRow
                          key={team.id}
                          layout="compact"
                          title={
                            <button
                              type="button"
                              className="truncate text-left text-ui font-medium hover:underline"
                              onClick={() => void openTeam(team)}
                            >
                              {team.name}{" "}
                              <span className="text-ui-xs text-muted-foreground">
                                v{team.revision}
                              </span>
                            </button>
                          }
                          description={
                            <span>
                              {team.purpose.trim() || "未设置用途"}
                              {members ? ` · ${members}` : ""}
                            </span>
                          }
                          actions={
                            <div className="flex items-center gap-1">
                              {action}
                              <Button size="sm" variant="ghost" onClick={() => void openTeam(team)}>
                                编辑
                              </Button>
                            </div>
                          }
                        />
                      );
                    })}
                  </SettingsCard>
                ) : (
                  <SettingsEmptyState layout="status">
                    {search.trim()
                      ? "没有符合搜索条件的专家团。"
                      : archivedView
                        ? "没有已归档的专家团。"
                        : "还没有专家团。"}
                  </SettingsEmptyState>
                )}
              </div>
            </SettingsSectionShell>
          </>
        )
      ) : draft ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void backToList()}
                disabled={pending}
              >
                返回列表
              </Button>
              <h2 className="truncate text-ui-lg font-semibold">
                {baseline ? baseline.name : "新建专家团"}
              </h2>
              {baseline ? (
                <span className="text-ui-xs tabular-nums text-muted-foreground">
                  v{baseline.revision}
                </span>
              ) : null}
              {readonly ? (
                <span className="text-ui-xs text-muted-foreground">已归档 · 只读</span>
              ) : null}
            </div>
            {baseline && !readonly ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setArchiveAction({ team: baseline, archived: true })}
              >
                归档
              </Button>
            ) : null}
            {readonly ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setArchiveAction({ team: baseline, archived: false })}
              >
                恢复专家团
              </Button>
            ) : null}
          </div>
          {actionError ? (
            <div
              className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-ui-sm text-destructive"
              role="alert"
            >
              {actionError}
            </div>
          ) : null}
          {hasNewerRevision && latestBaseline ? (
            <p
              className="rounded-lg border border-border bg-foreground/2 px-3 py-2 text-ui-sm text-muted-foreground"
              role="status"
            >
              服务端已有 v{latestBaseline.revision}。当前草稿仍基于 v{baseline?.revision}
              ；保存会进行版本校验，放弃更改可载入最新版。
            </p>
          ) : null}
          <fieldset disabled={readonly || pending} className="space-y-5 disabled:opacity-70">
            <SettingsSectionShell title="基本信息">
              <SettingsCard>
                <label className="block space-y-1.5 px-4 py-3 text-ui-sm font-medium">
                  名称
                  <Input
                    value={draft.name}
                    maxLength={160}
                    onChange={(event) => updateDraft({ name: event.target.value })}
                    placeholder="例如：产品协作团"
                    aria-label="专家团名称"
                  />
                </label>
                <label className="block space-y-1.5 px-4 py-3 text-ui-sm font-medium">
                  用途 <span className="font-normal text-muted-foreground">· 可选</span>
                  <Textarea
                    value={draft.purpose}
                    maxLength={8000}
                    onChange={(event) => updateDraft({ purpose: event.target.value })}
                    placeholder="这支团队主要帮助你完成什么？"
                    aria-label="专家团用途"
                  />
                </label>
              </SettingsCard>
            </SettingsSectionShell>
            <SettingsSectionShell title="协调者">
              <SettingsCard divided={false} className="px-4 py-3">
                <Collapsible open={coordinatorOpen} onOpenChange={setCoordinatorOpen}>
                  <CollapsibleTrigger className="flex w-full items-center gap-2 py-1 text-left text-ui font-medium">
                    <DisclosureChevron open={coordinatorOpen} className="size-4 shrink-0" />
                    <span>角色与协调方式</span>
                    <span className="text-ui-sm font-normal text-muted-foreground">
                      · {draft.coordinatorInstructions.trim() ? "已自定义" : "默认协调方式"}
                    </span>
                  </CollapsibleTrigger>
                  <CollapsiblePanel>
                    <div className="space-y-2 pt-3">
                      <Textarea
                        value={draft.coordinatorInstructions}
                        maxLength={8000}
                        onChange={(event) =>
                          updateDraft({ coordinatorInstructions: event.target.value })
                        }
                        placeholder="可选。留空时使用默认协调方式。"
                        aria-label="协调者角色与协调方式"
                      />
                      <p className="text-ui-xs text-muted-foreground">
                        仅指导协调者组织工作，不替代成员专家的角色与能力。
                      </p>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => updateDraft({ coordinatorInstructions: "" })}
                      >
                        恢复默认
                      </Button>
                    </div>
                  </CollapsiblePanel>
                </Collapsible>
              </SettingsCard>
            </SettingsSectionShell>
            <HubExpertSelectionSection
              expertIds={draft.expertIds}
              experts={props.experts}
              loading={props.expertsLoading}
              error={props.expertsError}
              showOrdinaryFallback={false}
              onChange={(expertIds) => updateDraft({ expertIds })}
            />
            <SettingsSectionShell title="协作偏好">
              <SettingsCard divided={false} className="space-y-2 px-4 py-3">
                <Textarea
                  value={draft.collaborationPreferences}
                  maxLength={8000}
                  onChange={(event) =>
                    updateDraft({ collaborationPreferences: event.target.value })
                  }
                  placeholder="可选。留空时按任务需要安排协作。"
                  aria-label="协作偏好"
                />
              </SettingsCard>
            </SettingsSectionShell>
          </fieldset>
          {validationError ? (
            <p className="text-ui-sm text-destructive" role="status">
              {validationError}
            </p>
          ) : null}
          <div className="sticky bottom-0 z-10 flex justify-end gap-2 border-t border-border bg-background/92 py-3 backdrop-blur-xl">
            <Button variant="ghost" disabled={pending} onClick={discardDraft}>
              放弃
            </Button>
            <Button
              disabled={pending || readonly || validationError !== null || !isDirty}
              onClick={() => void saveDraft()}
            >
              {pending ? "保存中…" : "保存专家团"}
            </Button>
          </div>
        </>
      ) : null}

      {leaveDialog}
      <AlertDialog
        open={archiveAction !== null}
        onOpenChange={(open) => {
          if (!open && !archivePending) setArchiveAction(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {archiveAction?.archived ? "归档这份专家团？" : "恢复这份专家团？"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {archiveAction?.archived
                ? `“${archiveAction.team.name}”归档后不会出现在新 Hub 的预设列表中；已有 Hub 的副本不受影响。`
                : `恢复“${archiveAction?.team.name ?? ""}”后，它会重新出现在可选预设中。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="ghost"
              disabled={archivePending}
              onClick={() => setArchiveAction(null)}
            >
              取消
            </Button>
            <Button
              variant={archiveAction?.archived ? "destructive" : "default"}
              disabled={archivePending}
              onClick={() => void runArchiveAction()}
            >
              {archivePending ? "处理中…" : archiveAction?.archived ? "确认归档" : "确认恢复"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
});

export const hubTeamDraftFromPreset = draftFromTeam;
