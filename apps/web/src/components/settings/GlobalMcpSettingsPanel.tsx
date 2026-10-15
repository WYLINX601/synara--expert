import type {
  ExpertConnectionConfig,
  ExpertConnectionReferencesResult,
  ExpertDefinition,
  ExpertSaveInput,
} from "@synara/contracts";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { useRadioGroupKeyboardNav } from "~/hooks/useRadioGroupKeyboardNav";
import { ensureExpertClient } from "~/workbench/host/expertClient";
import { ExternalMcpSettingsPanel } from "./ExternalMcpSettingsPanel";
import { LocalMcpDiscoveryPanel } from "./LocalMcpDiscoveryPanel";
import { SettingsCard, SettingsEmptyState, SettingsSectionShell } from "./SettingsPanelPrimitives";
import { useExpertDraftGuard } from "./useExpertDraftGuard";
import {
  expertDraftFromDefinition,
  expertDraftsEqual,
  expertSaveInputForDraft,
  validateExpertDraft,
} from "./expertSettingsModel";
import {
  authorizedExpertCount,
  connectionReferencesQueryKey,
  connectionSaveInput,
  connectionStateQueryKey,
  isConnectionTestStale,
  referenceCount,
  referencesPreventDeletion,
  sameConnectionDraft,
  validateConnectionDraft,
  type ConnectionDraft,
  draftFromConnection,
} from "./globalMcpSettingsModel";
import { EXPERT_CONNECTIONS_QUERY_KEY, EXPERTS_QUERY_KEY } from "./expertSettingsQueries";

export type GlobalMcpTab = "tools" | "apps";
export interface GlobalMcpSettingsPanelProps {
  initialTab?: GlobalMcpTab;
  initialConnectionId?: string;
  initialExpertId?: string;
  initialSearch?: string;
  returnExpertId?: string;
  onTabChange?: (tab: GlobalMcpTab) => void;
  onReturnToExpert?: (target: { expertId: string; connectionId?: string }) => void;
}
type DetailTab = "config" | "authorization" | "usage";
const REQUIRED_MODE_VALUES = ["continue", "block"] as const;
type TestRecord = {
  revision: number;
  testedAt: number;
  tools: ReadonlyArray<string>;
  error?: string;
};
type Impact = {
  state: { revision: number };
  refs: ExpertConnectionReferencesResult;
  action: "disabled" | "active" | "retired" | "delete";
};
const err = (value: unknown) => (value instanceof Error ? value.message : "操作失败，请重试。");
function scrollOwner(node: HTMLElement | null): HTMLElement | null {
  let current = node?.parentElement ?? null;
  while (current) {
    const css = getComputedStyle(current);
    if (
      /(auto|scroll)/u.test(`${css.overflow} ${css.overflowY}`) &&
      current.scrollHeight > current.clientHeight
    )
      return current;
    current = current.parentElement;
  }
  return null;
}

export function GlobalMcpSettingsPanel({
  initialTab = "tools",
  initialConnectionId,
  initialExpertId,
  initialSearch = "",
  returnExpertId,
  onTabChange,
  onReturnToExpert,
}: GlobalMcpSettingsPanelProps) {
  const queryClient = useQueryClient();
  const toolLabelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const initialRequestHandled = useRef(false);
  const scrollPosition = useRef<{ owner: HTMLElement | null; top: number } | null>(null);
  const [tab, setTab] = useState<GlobalMcpTab>(initialTab);
  const [search, setSearch] = useState(initialSearch);
  const [filter, setFilter] = useState<"all" | "authorized" | "unauthorized">("all");
  const [connectionId, setConnectionId] = useState<string | null>(initialConnectionId ?? null);
  const [detail, setDetail] = useState<DetailTab>(initialExpertId ? "authorization" : "config");
  const [draft, setDraft] = useState<ConnectionDraft | null>(null);
  const [baseline, setBaseline] = useState<ConnectionDraft | null>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const [expertId, setExpertId] = useState<string | null>(initialExpertId ?? null);
  const [authDraft, setAuthDraft] = useState<ExpertSaveInput | null>(null);
  const [authBase, setAuthBase] = useState<ExpertSaveInput | null>(null);
  const [authExpert, setAuthExpert] = useState<ExpertDefinition | null>(null);
  const [firstGrant, setFirstGrant] = useState(false);
  const [tests, setTests] = useState<Readonly<Record<string, TestRecord | undefined>>>({});
  const [returnWhenClean, setReturnWhenClean] = useState(false);
  const [showLocalDiscovery, setShowLocalDiscovery] = useState(false);
  const [pending, setPending] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [loadingImpact, setLoadingImpact] = useState(false);
  const configs = useQuery({
    queryKey: EXPERT_CONNECTIONS_QUERY_KEY,
    queryFn: () => ensureExpertClient().listExpertConnections(),
  });
  const expertsQuery = useQuery({
    queryKey: EXPERTS_QUERY_KEY,
    queryFn: () => ensureExpertClient().listExperts(),
  });
  const connections = configs.data ?? [];
  const experts = expertsQuery.data ?? [];
  const activeExperts = useMemo(() => experts.filter((x) => !x.archived), [experts]);
  const selected = connections.find((x) => x.id === connectionId);
  const selectedExpert = activeExperts.find((x) => x.id === expertId);
  const stateResults = useQueries({
    queries: connections.map((x) => ({
      queryKey: connectionStateQueryKey(x.id),
      queryFn: () => ensureExpertClient().getExpertConnectionState({ id: x.id }),
      retry: false,
    })),
  });
  const states = new Map(
    connections.map((x, i) => [
      x.id,
      { data: stateResults[i]?.data, failed: stateResults[i]?.isError ?? false },
    ]),
  );
  const stateQuery = useQuery({
    queryKey: connectionId
      ? connectionStateQueryKey(connectionId)
      : ["server", "expertConnectionState", "none"],
    queryFn: () => ensureExpertClient().getExpertConnectionState({ id: connectionId! }),
    enabled: Boolean(connectionId),
    retry: false,
  });
  const refsQuery = useQuery({
    queryKey: connectionId
      ? connectionReferencesQueryKey(connectionId)
      : ["server", "expertConnectionReferences", "none"],
    queryFn: () => ensureExpertClient().readExpertConnectionReferences({ id: connectionId! }),
    enabled: Boolean(connectionId),
    retry: false,
  });
  const connectionDirty = Boolean(draft && baseline && !sameConnectionDraft(draft, baseline));
  const authDirty = Boolean(
    authDraft && authBase && (firstGrant || !expertDraftsEqual(authDraft, authBase)),
  );
  const dirty = connectionDirty || authDirty;
  const authIssues = authDraft ? validateExpertDraft(authDraft) : [];
  const connectionIssue = draft ? validateConnectionDraft(draft) : null;
  const connectionSaveBlock =
    connectionDirty && connectionId
      ? !stateQuery.data
        ? stateQuery.isError
          ? "无法读取全局状态，因此连接配置保存已禁用。"
          : "正在读取连接状态，请稍后保存。"
        : stateQuery.data.status === "retired"
          ? "已退役的连接不能修改配置。"
          : undefined
      : undefined;
  const canSave =
    (!connectionDirty || (!connectionIssue && !connectionSaveBlock)) &&
    (!authDirty || authIssues.length === 0);
  const reason = connectionSaveBlock ?? connectionIssue ?? authIssues[0]?.message;
  const discard = useCallback(() => {
    const current = connections.find((x) => x.id === connectionId);
    const clean = current ? draftFromConnection(current) : null;
    setDraft(clean);
    setBaseline(clean);
    setRevision(current?.revision ?? null);
    const expert = activeExperts.find((x) => x.id === expertId) ?? null;
    const auth = expert ? expertDraftFromDefinition(expert) : null;
    setAuthExpert(expert);
    setAuthDraft(auth);
    setAuthBase(auth);
    setFirstGrant(false);
    setErrorText(null);
  }, [activeExperts, connectionId, connections, expertId]);
  const saveConnection = useCallback(async (): Promise<boolean> => {
    if (!connectionDirty) return true;
    if (!draft || pending) return false;
    if (
      connectionId &&
      (!stateQuery.data || stateQuery.isError || stateQuery.data.status === "retired")
    ) {
      setErrorText(
        stateQuery.data?.status === "retired"
          ? "已退役的连接不能修改配置。"
          : "无法确认连接状态，配置保存已禁用。",
      );
      return false;
    }
    const issue = validateConnectionDraft(draft);
    if (issue) {
      setErrorText(issue);
      return false;
    }
    setPending(true);
    setErrorText(null);
    try {
      const saved = await ensureExpertClient().saveExpertConnection(
        connectionSaveInput(draft, revision),
      );
      queryClient.setQueryData<ReadonlyArray<ExpertConnectionConfig>>(
        EXPERT_CONNECTIONS_QUERY_KEY,
        (old = []) =>
          old.some((x) => x.id === saved.id)
            ? old.map((x) => (x.id === saved.id ? saved : x))
            : [...old, saved],
      );
      await queryClient.invalidateQueries({ queryKey: EXPERT_CONNECTIONS_QUERY_KEY });
      setConnectionId(saved.id);
      const clean = draftFromConnection(saved);
      setDraft(clean);
      setBaseline(clean);
      setRevision(saved.revision);
      toastManager.add({ type: "success", title: "MCP 连接配置已保存" });
      return true;
    } catch (cause) {
      setErrorText(err(cause));
      void queryClient.invalidateQueries({ queryKey: EXPERT_CONNECTIONS_QUERY_KEY });
      return false;
    } finally {
      setPending(false);
    }
  }, [
    connectionDirty,
    connectionId,
    draft,
    pending,
    queryClient,
    revision,
    stateQuery.data,
    stateQuery.isError,
  ]);
  const saveAuthorization = useCallback(
    async (returnAfterSave = false): Promise<boolean> => {
      if (!authDirty) return true;
      if (!authDraft || !authExpert || pending) return false;
      const issues = validateExpertDraft(authDraft);
      if (issues.length) {
        setErrorText(issues[0]?.message ?? "授权内容无效。");
        return false;
      }
      setPending(true);
      setErrorText(null);
      try {
        const saved = await ensureExpertClient().saveExpert(
          expertSaveInputForDraft(authDraft, authExpert),
        );
        queryClient.setQueryData<ReadonlyArray<ExpertDefinition>>(EXPERTS_QUERY_KEY, (old = []) =>
          old.map((x) => (x.id === saved.id ? saved : x)),
        );
        await queryClient.invalidateQueries({ queryKey: EXPERTS_QUERY_KEY });
        const clean = expertDraftFromDefinition(saved);
        setAuthExpert(saved);
        setAuthDraft(clean);
        setAuthBase(clean);
        setFirstGrant(false);
        toastManager.add({ type: "success", title: "专家 MCP 授权已保存" });
        if (returnAfterSave && returnExpertId && firstGrant) setReturnWhenClean(true);
        return true;
      } catch (cause) {
        setErrorText(err(cause));
        void queryClient.invalidateQueries({ queryKey: EXPERTS_QUERY_KEY });
        return false;
      } finally {
        setPending(false);
      }
    },
    [authDirty, authDraft, authExpert, firstGrant, pending, queryClient, returnExpertId],
  );
  const saveAll = useCallback(async (): Promise<boolean> => {
    if (!(await saveConnection())) return false;
    return saveAuthorization(false);
  }, [saveAuthorization, saveConnection]);
  const { confirmLeave, dialog } = useExpertDraftGuard({
    isDirty: dirty,
    canSave,
    ...(reason ? { saveDisabledReason: reason } : {}),
    onSave: saveAll,
    onDiscard: discard,
  });
  useEffect(() => {
    if (!returnWhenClean || dirty || !returnExpertId) return;
    setReturnWhenClean(false);
    onReturnToExpert?.({ expertId: returnExpertId, ...(connectionId ? { connectionId } : {}) });
  }, [connectionId, dirty, onReturnToExpert, returnWhenClean, returnExpertId]);
  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);
  const changeDetail = async (next: DetailTab) => {
    if (next === detail || !(await confirmLeave())) return;
    setDetail(next);
  };
  const changeTab = async (next: GlobalMcpTab) => {
    if (next === tab || !(await confirmLeave())) return;
    setTab(next);
    onTabChange?.(next);
  };
  const open = async (connection: ExpertConnectionConfig, nextDetail: DetailTab = "config") => {
    if (!(await confirmLeave())) return;
    const owner = scrollOwner(root.current);
    scrollPosition.current = { owner, top: owner?.scrollTop ?? 0 };
    setConnectionId(connection.id);
    setDetail(nextDetail);
    const value = draftFromConnection(connection);
    setDraft(value);
    setBaseline(value);
    setRevision(connection.revision);
    setExpertId(null);
    setAuthDraft(null);
    setAuthBase(null);
    setAuthExpert(null);
    setErrorText(null);
  };
  const back = async () => {
    if (!(await confirmLeave())) return;
    setConnectionId(null);
    setDraft(null);
    setBaseline(null);
    setRevision(null);
    setExpertId(null);
    setAuthDraft(null);
    setAuthBase(null);
    setAuthExpert(null);
    const saved = scrollPosition.current;
    if (saved?.owner?.isConnected)
      requestAnimationFrame(() => {
        saved.owner!.scrollTop = saved.top;
      });
  };
  const newConnection = async () => {
    if (!(await confirmLeave())) return;
    const owner = scrollOwner(root.current);
    scrollPosition.current = { owner, top: owner?.scrollTop ?? 0 };
    setConnectionId(null);
    setDetail("config");
    const fresh: ConnectionDraft = {
      id: "",
      name: "",
      type: "stdio",
      command: "",
      args: "",
      envFromHost: "",
      url: "",
      headersFromHost: "",
    };
    setDraft(fresh);
    setBaseline(fresh);
    setRevision(null);
    setErrorText(null);
  };
  const openAuthorization = async (expert: ExpertDefinition, id = connectionId) => {
    if (!(await confirmLeave())) return;
    const baseAuth = expertDraftFromDefinition(expert);
    const exists = baseAuth.connections.some((x) => x.id === id);
    const auth =
      !exists && id
        ? {
            ...baseAuth,
            connections: [
              ...baseAuth.connections,
              { id, enabled: true, required: false, tools: [] },
            ],
          }
        : baseAuth;
    setExpertId(expert.id);
    setAuthExpert(expert);
    setAuthDraft(auth);
    setAuthBase(expertDraftFromDefinition(expert));
    setFirstGrant(!exists);
    setDetail("authorization");
    setErrorText(null);
  };
  useEffect(() => {
    if (initialRequestHandled.current || !configs.data || !expertsQuery.data) return;
    const expert = initialExpertId ? experts.find((x) => x.id === initialExpertId) : undefined;
    const targetId = initialConnectionId ?? expert?.connections[0]?.id;
    const conn = targetId ? connections.find((x) => x.id === targetId) : undefined;
    if (initialConnectionId && !conn) return;
    initialRequestHandled.current = true;
    if (conn) {
      const d = draftFromConnection(conn);
      setConnectionId(conn.id);
      setDraft(d);
      setBaseline(d);
      setRevision(conn.revision);
    }
    if (expert && conn) {
      const baseAuth = expertDraftFromDefinition(expert);
      const exists = baseAuth.connections.some((x) => x.id === conn.id);
      const a = !exists
        ? {
            ...baseAuth,
            connections: [
              ...baseAuth.connections,
              { id: conn.id, enabled: true, required: false, tools: [] },
            ],
          }
        : baseAuth;
      setExpertId(expert.id);
      setAuthExpert(expert);
      setAuthDraft(a);
      setAuthBase(expertDraftFromDefinition(expert));
      setFirstGrant(!exists);
      setDetail("authorization");
    }
  }, [configs.data, experts, expertsQuery.data, initialConnectionId, initialExpertId, connections]);
  const test = async () => {
    if (!selected || stateQuery.data?.status !== "active" || pending) return;
    setPending(true);
    setErrorText(null);
    try {
      const result = await ensureExpertClient().testExpertConnection({
        id: selected.id,
        expectedRevision: selected.revision,
      });
      setTests((old) => ({
        ...old,
        [selected.id]: { revision: result.revision, testedAt: Date.now(), tools: result.tools },
      }));
      toastManager.add({ type: "success", title: "已完成连接检查并读取工具" });
    } catch (cause) {
      setTests((old) => ({
        ...old,
        [selected.id]: {
          revision: selected.revision,
          testedAt: Date.now(),
          tools: [],
          error: err(cause),
        },
      }));
      setErrorText(err(cause));
    } finally {
      setPending(false);
    }
  };
  const openImpact = async (action: Impact["action"]) => {
    if (!selected || !stateQuery.data || stateQuery.isError || !(await confirmLeave())) return;
    setLoadingImpact(true);
    setErrorText(null);
    try {
      const [state, refs] = await Promise.all([
        ensureExpertClient().getExpertConnectionState({ id: selected.id }),
        ensureExpertClient().readExpertConnectionReferences({ id: selected.id }),
      ]);
      setImpact({ state, refs, action });
    } catch (cause) {
      setErrorText(`无法读取最新状态或引用，操作已停止：${err(cause)}`);
    } finally {
      setLoadingImpact(false);
    }
  };
  const applyImpact = async () => {
    if (
      !impact ||
      !selected ||
      pending ||
      (impact.action === "delete" && referencesPreventDeletion(impact.refs))
    )
      return;
    setPending(true);
    try {
      if (impact.action === "delete") {
        await ensureExpertClient().removeExpertConnection({
          id: selected.id,
          expectedRevision: selected.revision,
        });
        await queryClient.invalidateQueries({ queryKey: EXPERT_CONNECTIONS_QUERY_KEY });
        setImpact(null);
        await back();
        toastManager.add({ type: "success", title: "连接配置已删除" });
      } else {
        const state = await ensureExpertClient().setExpertConnectionState({
          id: selected.id,
          status: impact.action,
          expectedRevision: impact.state.revision,
        });
        queryClient.setQueryData(connectionStateQueryKey(selected.id), state);
        setImpact(null);
        toastManager.add({
          type: "success",
          title:
            state.status === "disabled"
              ? "连接已停用"
              : state.status === "retired"
                ? "连接已退役"
                : "连接已启用",
          description:
            state.status === "disabled"
              ? "后续调用会被阻止；系统会尝试取消在途调用，远端动作可能仍继续。"
              : undefined,
        });
      }
    } catch (cause) {
      setErrorText(err(cause));
      void queryClient.invalidateQueries({ queryKey: connectionStateQueryKey(selected.id) });
    } finally {
      setPending(false);
    }
  };
  const binding = authDraft?.connections.find((x) => x.id === connectionId);
  const testRecord = connectionId ? tests[connectionId] : undefined;
  const currentTestTools =
    testRecord && testRecord.revision === selected?.revision ? testRecord.tools : [];
  const authorizationTools = [...new Set([...currentTestTools, ...(binding?.tools ?? [])])];
  const requiredMode = binding?.required ? "block" : "continue";
  const requiredModeItemProps = useRadioGroupKeyboardNav({
    values: REQUIRED_MODE_VALUES,
    value: requiredMode,
    onValueChange: (mode) =>
      setAuthDraft((current) =>
        current
          ? {
              ...current,
              connections: current.connections.map((item) =>
                item.id === connectionId ? { ...item, required: mode === "block" } : item,
              ),
            }
          : current,
      ),
  });
  const retired = stateQuery.data?.status === "retired";
  const blockedStatus = stateQuery.isError || !stateQuery.data;
  const configReadOnly = retired || Boolean(connectionId && blockedStatus);
  const deleteReason = refsQuery.isError
    ? "引用读取失败，已禁用删除；请在使用情况查看错误。"
    : refsQuery.isLoading || refsQuery.isFetching
      ? "正在读取连接引用，确认完成前无法删除。"
      : refsQuery.data && referencesPreventDeletion(refsQuery.data)
        ? "连接仍被专家、任务或会话引用，无法删除。可在使用情况查看具体引用。"
        : null;
  const filtered = connections.filter((x) => {
    const count = authorizedExpertCount(x.id, experts);
    const host =
      x.transport.type === "stdio"
        ? x.transport.command.split(/[\\/]/u).pop()
        : (() => {
            try {
              return new URL(x.transport.url).host;
            } catch {
              return "";
            }
          })();
    const query = `${x.id}\n${x.name}\n${host}`.toLowerCase();
    if (search.trim() && !query.includes(search.trim().toLowerCase())) return false;
    if (filter === "authorized" && !count) return false;
    if (filter === "unauthorized" && count) return false;
    return true;
  });

  return (
    <div ref={root} className="space-y-5" data-global-mcp-settings>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <div role="tablist" aria-label="MCP 设置类别" className="flex gap-1">
          <Button
            role="tab"
            aria-selected={tab === "tools"}
            size="sm"
            variant={tab === "tools" ? "secondary" : "ghost"}
            onClick={() => void changeTab("tools")}
          >
            外部工具
          </Button>
          <Button
            role="tab"
            aria-selected={tab === "apps"}
            size="sm"
            variant={tab === "apps" ? "secondary" : "ghost"}
            onClick={() => void changeTab("apps")}
          >
            应用接入
          </Button>
        </div>
        {tab === "tools" && returnExpertId && expertId ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void confirmLeave().then((ok) => {
                if (ok)
                  onReturnToExpert?.({
                    expertId: returnExpertId,
                    ...(connectionId ? { connectionId } : {}),
                  });
              })
            }
          >
            返回专家
          </Button>
        ) : null}
      </div>
      <div hidden={tab !== "tools"}>
        {!connectionId && !draft ? (
          showLocalDiscovery ? (
            <LocalMcpDiscoveryPanel
              onBack={() => setShowLocalDiscovery(false)}
              onImported={async () => {
                await queryClient.invalidateQueries({ queryKey: EXPERT_CONNECTIONS_QUERY_KEY });
              }}
            />
          ) : (
            <div className="space-y-3">
              <SettingsCard className="overflow-hidden">
                <div className="flex flex-wrap items-center gap-2 p-3">
                  <Input
                    aria-label="搜索 MCP 连接"
                    placeholder="搜索名称、ID 或命令/主机"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="min-w-48 flex-1"
                  />
                  <div className="flex gap-1">
                    {(
                      [
                        ["all", "全部"],
                        ["authorized", "已授权"],
                        ["unauthorized", "未授权"],
                      ] as const
                    ).map(([value, label]) => (
                      <Button
                        key={value}
                        size="sm"
                        variant={filter === value ? "secondary" : "ghost"}
                        onClick={() => setFilter(value)}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                  <Button size="sm" onClick={() => void newConnection()}>
                    添加连接
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setShowLocalDiscovery(true)}>
                    从本机发现
                  </Button>
                </div>
                {!configs.isLoading && !configs.isError ? (
                  <p
                    aria-live="polite"
                    className="border-t border-border px-4 py-2 text-ui-xs text-muted-foreground"
                  >
                    显示 {filtered.length} 个结果
                  </p>
                ) : null}
                {configs.isLoading ? (
                  <SettingsEmptyState layout="status">正在读取 MCP 连接…</SettingsEmptyState>
                ) : configs.isError ? (
                  <SettingsEmptyState layout="status" tone="destructive">
                    读取 MCP 连接失败：{err(configs.error)}
                  </SettingsEmptyState>
                ) : !filtered.length ? (
                  <SettingsEmptyState layout="status">
                    {connections.length ? "没有符合条件的连接。" : "还没有共享连接配置。"}
                  </SettingsEmptyState>
                ) : (
                  <div className="divide-y divide-border border-t border-border">
                    <div className="hidden grid-cols-[minmax(10rem,1.5fr)_minmax(6rem,.7fr)_minmax(7rem,.8fr)_minmax(9rem,1fr)] gap-3 px-4 py-2 text-ui-xs text-muted-foreground md:grid">
                      <span>连接</span>
                      <span>全局状态</span>
                      <span>授权专家</span>
                      <span>最近检查</span>
                    </div>
                    {filtered.map((x) => {
                      const count = authorizedExpertCount(x.id, experts);
                      const state = states.get(x.id);
                      const recent = tests[x.id];
                      const stale = isConnectionTestStale(recent, x.revision);
                      return (
                        <div
                          key={x.id}
                          className="grid gap-2 px-3 py-3 md:grid-cols-[minmax(10rem,1.5fr)_minmax(6rem,.7fr)_minmax(7rem,.8fr)_minmax(9rem,1fr)] md:items-center md:gap-3 md:px-4"
                        >
                          <div className="min-w-0">
                            <button
                              className="max-w-full truncate text-left text-ui font-medium hover:underline"
                              onClick={() => void open(x)}
                            >
                              {x.name}
                            </button>
                            <p className="break-all text-ui-xs text-muted-foreground">
                              {x.transport.type === "stdio" ? "stdio" : "HTTP"}
                            </p>
                          </div>
                          <span className="text-ui-sm text-muted-foreground">
                            {state?.failed
                              ? "未知"
                              : state?.data?.status === "active"
                                ? "启用"
                                : state?.data?.status === "disabled"
                                  ? "已停用"
                                  : state?.data?.status === "retired"
                                    ? "已退役"
                                    : "读取中"}
                          </span>
                          <button
                            className="w-fit text-left text-ui-sm hover:underline"
                            onClick={() => void open(x, "authorization")}
                          >
                            {count} 位专家
                          </button>
                          <span className="text-ui-sm text-muted-foreground">
                            {recent ? (
                              <>
                                {new Date(recent.testedAt).toLocaleString("zh-CN")} · v
                                {recent.revision} · {stale ? "已过期" : "检查"}
                              </>
                            ) : (
                              "未检查"
                            )}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </SettingsCard>
              <p className="mt-3 text-ui-xs text-muted-foreground">
                连接配置更新只影响新任务；已绑定任务恢复时仍使用原版本。
              </p>
            </div>
          )
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button size="sm" variant="ghost" onClick={() => void back()}>
                ← 返回连接列表
              </Button>
              {connectionId ? (
                <div className="flex flex-wrap gap-2">
                  {stateQuery.data?.status === "active" && !retired ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending || connectionDirty}
                      onClick={() => void test()}
                    >
                      {pending ? "检查中…" : connectionDirty ? "先保存配置" : "检查连接并读取工具"}
                    </Button>
                  ) : null}
                  {stateQuery.data && !blockedStatus && !retired ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() =>
                        void openImpact(
                          stateQuery.data?.status === "active" ? "disabled" : "active",
                        )
                      }
                    >
                      {stateQuery.data.status === "active" ? "停用连接" : "启用连接"}
                    </Button>
                  ) : null}
                  {!retired ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending || blockedStatus}
                      onClick={() => void openImpact("retired")}
                    >
                      退役
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="destructive"
                    aria-describedby={deleteReason ? "mcp-connection-delete-reason" : undefined}
                    disabled={
                      pending ||
                      refsQuery.isLoading ||
                      refsQuery.isFetching ||
                      refsQuery.isError ||
                      !refsQuery.data ||
                      referencesPreventDeletion(refsQuery.data)
                    }
                    onClick={() => void openImpact("delete")}
                  >
                    删除
                  </Button>
                </div>
              ) : null}
              {connectionId && deleteReason ? (
                <p
                  id="mcp-connection-delete-reason"
                  className={`text-ui-sm ${refsQuery.isError ? "text-destructive" : "text-muted-foreground"}`}
                  role={refsQuery.isError ? "alert" : "status"}
                >
                  {deleteReason}
                </p>
              ) : null}
            </div>
            {connectionId && stateQuery.isError ? (
              <SettingsEmptyState layout="status" tone="destructive">
                无法读取连接全局状态；全局状态操作已禁用。{err(stateQuery.error)}
              </SettingsEmptyState>
            ) : null}
            {errorText ? (
              <p className="text-ui-sm text-destructive" role="alert">
                {errorText}
              </p>
            ) : null}
            {connectionId ? (
              <div
                className="flex flex-wrap gap-1 border-b border-border"
                role="tablist"
                aria-label="连接详情"
              >
                <Button
                  role="tab"
                  aria-selected={detail === "config"}
                  size="sm"
                  variant={detail === "config" ? "secondary" : "ghost"}
                  onClick={() => void changeDetail("config")}
                >
                  配置
                </Button>
                <Button
                  role="tab"
                  aria-selected={detail === "authorization"}
                  size="sm"
                  variant={detail === "authorization" ? "secondary" : "ghost"}
                  onClick={() => void changeDetail("authorization")}
                >
                  授权
                </Button>
                <Button
                  role="tab"
                  aria-selected={detail === "usage"}
                  size="sm"
                  variant={detail === "usage" ? "secondary" : "ghost"}
                  onClick={() => void changeDetail("usage")}
                >
                  使用情况
                </Button>
              </div>
            ) : null}
            {detail === "config" && draft ? (
              <SettingsSectionShell
                title={
                  connectionId
                    ? `${selected?.name ?? draft.name} · 配置 v${selected?.revision ?? revision ?? "—"}`
                    : "添加外部工具"
                }
              >
                <SettingsCard>
                  {retired ? (
                    <SettingsEmptyState layout="status">
                      此连接已退役，配置只读；历史引用保留。
                    </SettingsEmptyState>
                  ) : null}
                  <div className="grid gap-4 p-4 md:grid-cols-2">
                    <label className="space-y-1 text-ui-sm">
                      <span>连接 ID</span>
                      <Input
                        value={draft.id}
                        readOnly={Boolean(connectionId)}
                        disabled={Boolean(connectionId) || pending}
                        onChange={(e) => setDraft((d) => (d ? { ...d, id: e.target.value } : d))}
                        placeholder="literature-search"
                      />
                    </label>
                    <label className="space-y-1 text-ui-sm">
                      <span>显示名称</span>
                      <Input
                        value={draft.name}
                        disabled={configReadOnly || pending}
                        onChange={(e) => setDraft((d) => (d ? { ...d, name: e.target.value } : d))}
                      />
                    </label>
                    <label className="space-y-1 text-ui-sm">
                      <span>连接类型</span>
                      <select
                        className="h-9 w-full rounded-md border border-input bg-background px-3 text-ui"
                        value={draft.type}
                        disabled={configReadOnly || pending}
                        onChange={(e) =>
                          setDraft((d) =>
                            d ? { ...d, type: e.target.value as "stdio" | "http" } : d,
                          )
                        }
                      >
                        <option value="stdio">stdio</option>
                        <option value="http">HTTP</option>
                      </select>
                    </label>
                    {draft.type === "stdio" ? (
                      <>
                        <label className="space-y-1 text-ui-sm md:col-span-2">
                          <span>启动命令</span>
                          <Input
                            value={draft.command}
                            disabled={configReadOnly || pending}
                            onChange={(e) =>
                              setDraft((d) => (d ? { ...d, command: e.target.value } : d))
                            }
                          />
                        </label>
                        <label className="space-y-1 text-ui-sm">
                          <span>参数（每行一项）</span>
                          <Textarea
                            value={draft.args}
                            disabled={configReadOnly || pending}
                            onChange={(e) =>
                              setDraft((d) =>
                                d ? { ...d, args: e.target.value, argsEdited: true } : d,
                              )
                            }
                          />
                        </label>
                        <label className="space-y-1 text-ui-sm">
                          <span>主机环境变量映射</span>
                          <Textarea
                            value={draft.envFromHost}
                            disabled={configReadOnly || pending}
                            onChange={(e) =>
                              setDraft((d) => (d ? { ...d, envFromHost: e.target.value } : d))
                            }
                            placeholder="TOKEN=HOST_TOKEN"
                          />
                          <span className="text-ui-xs text-muted-foreground">
                            只填写名称映射，不填写凭证值。
                          </span>
                          {draft.envFromSecret?.names.length ? (
                            <span className="text-ui-xs text-muted-foreground">
                              已保存变量：{draft.envFromSecret.names.join("、")}
                            </span>
                          ) : null}
                        </label>
                      </>
                    ) : (
                      <>
                        <label className="space-y-1 text-ui-sm md:col-span-2">
                          <span>服务 URL</span>
                          <Input
                            value={draft.url}
                            disabled={configReadOnly || pending}
                            onChange={(e) =>
                              setDraft((d) => (d ? { ...d, url: e.target.value } : d))
                            }
                          />
                        </label>
                        <label className="space-y-1 text-ui-sm md:col-span-2">
                          <span>主机环境变量请求头映射</span>
                          <Textarea
                            value={draft.headersFromHost}
                            disabled={configReadOnly || pending}
                            onChange={(e) =>
                              setDraft((d) =>
                                d
                                  ? { ...d, headersFromHost: e.target.value, headersEdited: true }
                                  : d,
                              )
                            }
                            placeholder="Authorization=API_TOKEN|Bearer"
                          />
                          {draft.headersFromSecret?.names.length ? (
                            <span className="text-ui-xs text-muted-foreground">
                              已保存请求头：{draft.headersFromSecret.names.join("、")}
                            </span>
                          ) : null}
                        </label>
                      </>
                    )}
                  </div>
                  {connectionIssue ? (
                    <p className="px-4 text-ui-sm text-destructive">{connectionIssue}</p>
                  ) : null}
                  {selected ? (
                    <details className="mx-4 mb-4 rounded-lg border border-border">
                      <summary className="cursor-pointer px-3 py-2 text-ui-sm">
                        查看脱敏配置预览
                      </summary>
                      <pre className="overflow-auto border-t border-border bg-muted/30 p-3 text-ui-xs">
                        {JSON.stringify(
                          {
                            id: selected.id,
                            name: selected.name,
                            transport:
                              selected.transport.type === "stdio"
                                ? {
                                    ...selected.transport,
                                    args: selected.transport.args.map((v) =>
                                      /token|secret|password|key|auth/iu.test(v) ? "[已隐藏]" : v,
                                    ),
                                    envFromHost: selected.transport.envFromHost.map(({ name }) => ({
                                      name,
                                      envVar: "[主机环境变量]",
                                    })),
                                    envFromSecret: selected.transport.envFromSecret
                                      ? {
                                          credential: "[Synara 凭证]",
                                          names: selected.transport.envFromSecret.names,
                                        }
                                      : undefined,
                                  }
                                : {
                                    type: "http",
                                    url: (() => {
                                      try {
                                        const u = new URL(selected.transport.url);
                                        u.search = u.search ? "?[已隐藏]" : "";
                                        return u.toString();
                                      } catch {
                                        return "[无效 URL]";
                                      }
                                    })(),
                                    headersFromHost: selected.transport.headersFromHost.map(
                                      ({ name }) => ({ name, envVar: "[主机环境变量]" }),
                                    ),
                                    headersFromSecret: selected.transport.headersFromSecret
                                      ? {
                                          credential: "[Synara 凭证]",
                                          names: selected.transport.headersFromSecret.names,
                                        }
                                      : undefined,
                                  },
                          },
                          null,
                          2,
                        )}
                      </pre>
                    </details>
                  ) : null}
                  {testRecord ? (
                    <p className="px-4 pb-3 text-ui-sm text-muted-foreground">
                      最近检查 {new Date(testRecord.testedAt).toLocaleString("zh-CN")} · v
                      {testRecord.revision}
                      {isConnectionTestStale(testRecord, selected?.revision ?? -1)
                        ? " · 已过期"
                        : ""}
                      {testRecord.error
                        ? ` · ${testRecord.error}`
                        : ` · ${testRecord.tools.length} 项工具`}
                    </p>
                  ) : null}
                  {connectionId && stateQuery.data?.status === "active" ? (
                    <p className="px-4 pb-3 text-ui-xs text-muted-foreground">
                      检查可能会启动本地进程。
                    </p>
                  ) : null}
                  <div className="flex justify-end border-t border-border p-3">
                    <Button
                      disabled={
                        pending || configReadOnly || !connectionDirty || Boolean(connectionIssue)
                      }
                      onClick={() => void saveConnection()}
                    >
                      {pending ? "保存中…" : "保存连接配置"}
                    </Button>
                  </div>
                </SettingsCard>
              </SettingsSectionShell>
            ) : null}
            {detail === "authorization" ? (
              <SettingsSectionShell title="授权">
                <SettingsCard>
                  <div className="space-y-4 p-4">
                    <label className="space-y-1 text-ui-sm">
                      <span>选择专家</span>
                      <select
                        className="h-9 w-full rounded-md border border-input bg-background px-3 text-ui"
                        value={expertId ?? ""}
                        onChange={(e) => {
                          const expert = activeExperts.find((x) => x.id === e.target.value);
                          if (expert) void openAuthorization(expert);
                        }}
                      >
                        <option value="">选择专家</option>
                        {activeExperts.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {!authDraft || !connectionId ? (
                      <SettingsEmptyState layout="status">
                        选择专家和连接以编辑白名单。
                      </SettingsEmptyState>
                    ) : (
                      <>
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <h3 className="text-ui-lg font-medium">{selectedExpert?.name}</h3>
                            <p className="text-ui-sm text-muted-foreground">
                              专家授权单独保存；关闭后白名单仍保留。
                            </p>
                          </div>
                          {binding ? (
                            <div className="flex items-center gap-2 text-ui-sm">
                              允许使用
                              <Switch
                                aria-label="允许使用"
                                checked={binding.enabled !== false}
                                disabled={pending || retired}
                                onCheckedChange={(checked) =>
                                  setAuthDraft((d) =>
                                    d
                                      ? {
                                          ...d,
                                          connections: d.connections.map((x) =>
                                            x.id === connectionId ? { ...x, enabled: checked } : x,
                                          ),
                                        }
                                      : d,
                                  )
                                }
                              />
                            </div>
                          ) : null}
                        </div>
                        <div className="space-y-1">
                          <p className="text-ui-sm">启动时无法连接</p>
                          <div
                            role="radiogroup"
                            aria-label="启动时无法连接"
                            className="inline-flex rounded-lg border border-border p-0.5"
                          >
                            {(
                              [
                                ["continue", "继续任务"],
                                ["block", "阻止启动"],
                              ] as const
                            ).map(([mode, label]) => (
                              <Button
                                key={mode}
                                type="button"
                                role="radio"
                                aria-checked={requiredMode === mode}
                                size="sm"
                                variant={requiredMode === mode ? "secondary" : "ghost"}
                                disabled={
                                  pending || retired || !binding || binding.enabled === false
                                }
                                onClick={() =>
                                  setAuthDraft((d) =>
                                    d
                                      ? {
                                          ...d,
                                          connections: d.connections.map((x) =>
                                            x.id === connectionId
                                              ? { ...x, required: mode === "block" }
                                              : x,
                                          ),
                                        }
                                      : d,
                                  )
                                }
                                {...requiredModeItemProps(mode)}
                              >
                                {label}
                              </Button>
                            ))}
                          </div>
                        </div>
                        <div className="space-y-2">
                          <p className="text-ui-sm font-medium">
                            允许使用的工具 · 已选 {binding?.tools.length ?? 0} /{" "}
                            {authorizationTools.length}
                          </p>
                          {binding?.enabled !== false && binding?.tools.length === 0 ? (
                            <p className="rounded-md border border-dashed p-3 text-ui-sm text-amber-700 dark:text-amber-300">
                              此连接尚未授权工具。选择至少一项后才能保存。
                            </p>
                          ) : null}
                          {binding?.enabled === false ? (
                            <p className="text-ui-sm text-muted-foreground">
                              已关闭，保存和重新启用时保留当前白名单。
                            </p>
                          ) : null}
                          {currentTestTools.length ? (
                            <div className="grid gap-2 sm:grid-cols-2">
                              {authorizationTools.map((tool) => (
                                <label
                                  key={tool}
                                  className="flex items-start gap-2 rounded-md border border-border p-3 text-ui-sm"
                                >
                                  <Checkbox
                                    aria-labelledby={`${toolLabelId}-${encodeURIComponent(tool)}`}
                                    checked={binding?.tools.includes(tool) ?? false}
                                    disabled={pending || retired || binding?.enabled === false}
                                    onCheckedChange={(checked) =>
                                      setAuthDraft((d) =>
                                        d
                                          ? {
                                              ...d,
                                              connections: d.connections.map((x) =>
                                                x.id === connectionId
                                                  ? {
                                                      ...x,
                                                      tools:
                                                        checked === true
                                                          ? [...new Set([...x.tools, tool])]
                                                          : x.tools.filter((v) => v !== tool),
                                                    }
                                                  : x,
                                              ),
                                            }
                                          : d,
                                      )
                                    }
                                  />
                                  <code
                                    id={`${toolLabelId}-${encodeURIComponent(tool)}`}
                                    className="break-all"
                                  >
                                    {tool}
                                  </code>
                                </label>
                              ))}
                            </div>
                          ) : binding?.tools.length ? (
                            <div className="space-y-2">
                              {binding.tools.map((tool) => (
                                <label
                                  key={tool}
                                  className="flex items-center gap-2 rounded-md border border-border p-3 text-ui-sm"
                                >
                                  <Checkbox
                                    aria-labelledby={`${toolLabelId}-${encodeURIComponent(tool)}`}
                                    checked
                                    disabled={pending || retired || binding.enabled === false}
                                    onCheckedChange={(checked) =>
                                      setAuthDraft((d) =>
                                        d
                                          ? {
                                              ...d,
                                              connections: d.connections.map((x) =>
                                                x.id === connectionId
                                                  ? {
                                                      ...x,
                                                      tools: checked
                                                        ? [...new Set([...x.tools, tool])]
                                                        : x.tools.filter((v) => v !== tool),
                                                    }
                                                  : x,
                                              ),
                                            }
                                          : d,
                                      )
                                    }
                                  />
                                  <code
                                    id={`${toolLabelId}-${encodeURIComponent(tool)}`}
                                    className="break-all"
                                  >
                                    {tool}
                                  </code>
                                  <span className="text-ui-xs text-muted-foreground">
                                    检查后可添加新工具
                                  </span>
                                </label>
                              ))}
                            </div>
                          ) : (
                            <SettingsEmptyState layout="status">
                              保存连接后，可检查连接并读取工具；系统不会自动检查。
                            </SettingsEmptyState>
                          )}
                        </div>
                        {authIssues.length ? (
                          <p className="text-ui-sm text-destructive" role="alert">
                            {authIssues[0]?.message}
                          </p>
                        ) : null}
                        <div className="flex justify-end border-t border-border pt-3">
                          <Button
                            disabled={pending || retired || !authDirty || authIssues.length > 0}
                            onClick={() => void saveAuthorization(true)}
                          >
                            {pending ? "保存中…" : "保存此专家授权"}
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                </SettingsCard>
              </SettingsSectionShell>
            ) : null}
            {detail === "usage" ? (
              <SettingsSectionShell title="使用情况">
                <SettingsCard>
                  {refsQuery.isLoading ? (
                    <SettingsEmptyState layout="status">正在读取连接引用…</SettingsEmptyState>
                  ) : refsQuery.isError ? (
                    <SettingsEmptyState layout="status" tone="destructive">
                      引用读取失败；无法确认影响，删除已禁用。{err(refsQuery.error)}
                    </SettingsEmptyState>
                  ) : refsQuery.data ? (
                    <div className="space-y-4 p-4">
                      <p className="text-ui-sm text-muted-foreground">
                        更新连接配置只影响新任务；已绑定任务恢复时仍使用原版本。
                      </p>
                      <dl className="grid gap-3 sm:grid-cols-4">
                        {[
                          ["专家引用", refsQuery.data.experts.length],
                          ["任务快照", refsQuery.data.snapshots.length],
                          ["任务", refsQuery.data.tasks.length],
                          ["活跃会话", refsQuery.data.activeSessionCount],
                        ].map(([name, value]) => (
                          <div key={name} className="rounded-lg border border-border p-3">
                            <dt className="text-ui-xs text-muted-foreground">{name}</dt>
                            <dd className="text-ui-lg">{value}</dd>
                          </div>
                        ))}
                      </dl>
                      <p className="text-ui-sm text-muted-foreground">
                        {referenceCount(refsQuery.data)} 项历史引用；停用和归档项仍计入引用。
                      </p>
                      {refsQuery.data.experts.map((x) => (
                        <p key={`${x.id}-${x.revision}`} className="text-ui-sm">
                          {x.name} · v{x.revision} · {x.enabled ? "已启用" : "已关闭"} ·{" "}
                          {x.tools.length} 项工具
                        </p>
                      ))}
                      {refsQuery.data.snapshots.map((x) => (
                        <p key={x.snapshotId} className="text-ui-sm">
                          {x.displayName} ·{" "}
                          {x.configRevision ? `配置 v${x.configRevision}` : "旧任务版本未固定"}
                        </p>
                      ))}
                      {refsQuery.data.tasks.map((x) => (
                        <p key={x.threadId} className="text-ui-sm">
                          {x.title || x.threadId} ·{" "}
                          {x.configRevision ? `配置 v${x.configRevision}` : "旧任务版本未固定"}
                        </p>
                      ))}
                    </div>
                  ) : null}
                </SettingsCard>
              </SettingsSectionShell>
            ) : null}
          </div>
        )}
      </div>
      <div hidden={tab !== "apps"}>
        <ExternalMcpSettingsPanel active={tab === "apps"} />
      </div>
      {dialog}
      <AlertDialog
        open={Boolean(impact)}
        onOpenChange={(open) => {
          if (!open && !pending) setImpact(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {impact?.action === "delete"
                ? "删除连接配置？"
                : impact?.action === "retired"
                  ? "退役此连接？"
                  : impact?.action === "disabled"
                    ? "停用此连接？"
                    : "重新启用此连接？"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {impact ? (
                <>
                  读取到 {impact.refs.experts.length} 个专家引用、{impact.refs.tasks.length}{" "}
                  个任务、{impact.refs.activeSessionCount} 个活跃会话。
                  {impact.action === "disabled"
                    ? "后续调用会被阻止；系统尝试取消在途调用，远端动作可能仍继续。"
                    : impact.action === "retired"
                      ? "退役不可撤销，历史引用会保留。"
                      : impact.action === "delete"
                        ? "只允许删除完全没有引用的连接。"
                        : "确认后会启用连接。"}
                </>
              ) : (
                "读取引用影响失败，操作不可继续。"
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {errorText ? (
            <p className="px-4 text-ui-sm text-destructive" role="alert">
              {errorText}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogClose disabled={pending} render={<Button size="sm" variant="outline" />}>
              取消
            </AlertDialogClose>
            <Button
              size="sm"
              variant={impact?.action === "delete" ? "destructive" : "default"}
              disabled={
                pending ||
                loadingImpact ||
                !impact ||
                (impact.action === "delete" && referencesPreventDeletion(impact.refs))
              }
              onClick={() => void applyImpact()}
            >
              {pending
                ? "处理中…"
                : impact?.action === "delete"
                  ? "删除配置"
                  : impact?.action === "retired"
                    ? "确认退役"
                    : impact?.action === "disabled"
                      ? "确认停用"
                      : "确认启用"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
