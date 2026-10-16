import { useQuery } from "@tanstack/react-query";
import type {
  ExpertBinding,
  ExpertConnectionConfig,
  ExpertDefinition,
  ProviderKind,
  ThreadId,
} from "@synara/contracts";
import { useEffect, useRef, useState } from "react";

import { ensureExpertClient } from "~/workbench/host/expertClient";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

export function ExpertTaskControl(props: {
  threadId: ThreadId;
  binding: ExpertBinding;
  provider: ProviderKind;
  model: string;
  canContinue: boolean;
  onContinue: (expertId: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testingConnectionId, setTestingConnectionId] = useState<string | null>(null);
  const [connectionTestResults, setConnectionTestResults] = useState<
    Record<string, { tools: readonly string[]; error: boolean }>
  >({});
  const connectionTestGeneration = useRef(0);
  const snapshot = useQuery({
    queryKey: ["server", "expertSnapshot", props.binding.snapshotId],
    queryFn: () =>
      ensureExpertClient().readExpertSnapshot({ snapshotId: props.binding.snapshotId }),
    enabled: open,
  });
  const appliedRuntime = useQuery({
    queryKey: ["server", "expertAppliedRuntime", props.threadId],
    queryFn: () => ensureExpertClient().readExpertAppliedRuntime({ threadId: props.threadId }),
    enabled: open,
  });
  const experts = useQuery({
    queryKey: ["server", "experts"],
    queryFn: () => ensureExpertClient().listExperts(),
    enabled: open,
  });
  const connections = useQuery({
    queryKey: ["server", "expertConnections"],
    queryFn: () => ensureExpertClient().listExpertConnections(),
    enabled: open,
  });
  const selected = experts.data?.find((expert) => expert.id === selectedId);
  const preview = useQuery({
    queryKey: ["server", "expertPreview", selectedId, selected?.revision, props.provider],
    queryFn: () =>
      ensureExpertClient().previewExpert({
        expertId: selectedId!,
        provider: props.provider as "codex" | "pi",
      }),
    enabled: open && !!selectedId && (props.provider === "codex" || props.provider === "pi"),
  });
  const canStart =
    props.canContinue &&
    !!snapshot.data &&
    !!selected &&
    (preview.data?.status === "available" || preview.data?.status === "partial") &&
    !busy;

  useEffect(
    () => () => {
      connectionTestGeneration.current += 1;
    },
    [],
  );

  const openDialog = () => {
    connectionTestGeneration.current += 1;
    setConnectionTestResults({});
    setOpen(true);
  };

  const closeDialog = () => {
    connectionTestGeneration.current += 1;
    setTestingConnectionId(null);
    setOpen(false);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      openDialog();
    } else {
      closeDialog();
    }
  };

  const testConnection = async (connection: ExpertConnectionConfig) => {
    if (testingConnectionId) return;
    const generation = ++connectionTestGeneration.current;
    setTestingConnectionId(connection.id);
    setConnectionTestResults((current) => {
      const next = { ...current };
      delete next[connection.id];
      return next;
    });
    try {
      const result = await ensureExpertClient().testExpertConnection({ id: connection.id });
      if (generation !== connectionTestGeneration.current) return;
      setConnectionTestResults((current) => ({
        ...current,
        [connection.id]: { tools: result.tools, error: false },
      }));
    } catch {
      if (generation !== connectionTestGeneration.current) return;
      setConnectionTestResults((current) => ({
        ...current,
        [connection.id]: { tools: [], error: true },
      }));
    } finally {
      if (generation === connectionTestGeneration.current) setTestingConnectionId(null);
    }
  };

  const continueWithExpert = async () => {
    if (!selectedId || !canStart) return;
    setBusy(true);
    setError(null);
    try {
      await props.onContinue(selectedId);
      closeDialog();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法创建接续任务。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="outline" size="xs" onClick={openDialog}>
        {props.binding.displayName}
      </Button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{props.binding.displayName}</DialogTitle>
            <DialogDescription>
              本任务固定使用专家版本 v{props.binding.revision}。编辑模板不会改变当前任务。
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4 text-ui">
            {snapshot.data ? (
              <>
                <section>
                  <h3 className="font-medium">工作方式</h3>
                  <p className="whitespace-pre-wrap text-muted-foreground">
                    {snapshot.data.persona || "未设置"}
                  </p>
                </section>
                <section>
                  <h3 className="font-medium">固定的技能</h3>
                  <p className="text-muted-foreground">
                    {snapshot.data.skills.length
                      ? snapshot.data.skills.map((skill) => skill.name).join(" · ")
                      : "未选择技能"}
                  </p>
                </section>
                <section>
                  <h3 className="font-medium">固定环境</h3>
                  <dl className="mt-1 grid gap-1 text-muted-foreground">
                    <div className="flex flex-wrap gap-x-2">
                      <dt>快照 ID</dt>
                      <dd className="break-all font-mono text-ui-xs">{snapshot.data.snapshotId}</dd>
                    </div>
                    <div className="flex flex-wrap gap-x-2">
                      <dt>任务配置模型</dt>
                      <dd>
                        {props.provider} · {props.model}
                      </dd>
                    </div>
                    <div className="flex flex-wrap gap-x-2">
                      <dt>技能目录</dt>
                      <dd className="break-all">{snapshot.data.skillsRoot}</dd>
                    </div>
                    <div className="flex flex-wrap gap-x-2">
                      <dt>资源</dt>
                      <dd>{snapshot.data.references.length} 份固定参考资料</dd>
                    </div>
                  </dl>
                </section>
                <section className="space-y-2">
                  <h3 className="font-medium">固定的 MCP 连接</h3>
                  {snapshot.data.connections.length ? (
                    <ul className="space-y-2">
                      {snapshot.data.connections.map((connection) => {
                        const config = connections.data?.find((item) => item.id === connection.id);
                        const boundRevision = snapshot.data.mcpBinding?.servers.find(
                          (server) => server.id === connection.id,
                        )?.configRevision;
                        const snapshotDisabled = connection.enabled === false;
                        const connectionName = config?.name ?? connection.id;
                        const result = connectionTestResults[connection.id];
                        const allToolsAuthorized = connection.toolMode === "all";
                        const detectedAllowedTools = result?.tools.filter(
                          (tool) => allToolsAuthorized || connection.tools.includes(tool),
                        );
                        const missingTools = allToolsAuthorized
                          ? []
                          : connection.tools.filter((tool) => !result?.tools.includes(tool));

                        return (
                          <li
                            key={connection.id}
                            className="space-y-1 rounded-md border border-border p-3"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <p className="font-medium">
                                {connectionName} · {connection.required ? "必需" : "可选"}
                              </p>
                              {snapshotDisabled ? (
                                <span role="status" className="text-ui-sm text-muted-foreground">
                                  已停用
                                </span>
                              ) : config ? (
                                <span className="text-ui-sm text-muted-foreground">已配置</span>
                              ) : connections.isLoading ? (
                                <span className="text-ui-sm text-muted-foreground">
                                  正在读取配置
                                </span>
                              ) : connections.isError ? (
                                <span role="status" className="text-ui-sm text-destructive">
                                  无法读取配置
                                </span>
                              ) : (
                                <span className="text-ui-sm text-destructive">未配置</span>
                              )}
                            </div>
                            {boundRevision !== undefined ? (
                              <p className="text-ui-sm text-muted-foreground">
                                固定配置 · v{boundRevision}
                              </p>
                            ) : null}
                            <p className="text-ui-sm text-muted-foreground">
                              允许的工具：
                              {allToolsAuthorized
                                ? "全部工具（本任务首次启动时自动读取并固定）"
                                : connection.tools.length
                                  ? connection.tools.join("、")
                                  : "无"}
                            </p>
                            {config && !snapshotDisabled ? (
                              <Button
                                type="button"
                                size="xs"
                                variant="outline"
                                disabled={Boolean(testingConnectionId)}
                                aria-label={`检测当前配置 ${connectionName}`}
                                onClick={() => void testConnection(config)}
                              >
                                {testingConnectionId === connection.id ? "检测中…" : "检测当前配置"}
                              </Button>
                            ) : null}
                            {result?.error ? (
                              <p role="alert" className="text-ui-sm text-destructive">
                                当前配置检测失败。请检查连接设置和服务状态。
                              </p>
                            ) : result ? (
                              <div role="status" className="space-y-1 text-ui-sm">
                                <p>
                                  {allToolsAuthorized
                                    ? "当前配置检测完成 · 当前提供："
                                    : "当前配置检测完成 · 已发现且获准："}
                                  {detectedAllowedTools?.length
                                    ? detectedAllowedTools.join("、")
                                    : "无"}
                                </p>
                                {!allToolsAuthorized && connection.tools.length ? (
                                  <p className="text-muted-foreground">
                                    允许但未发现：
                                    {missingTools.length ? missingTools.join("、") : "无"}
                                  </p>
                                ) : null}
                              </div>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="text-muted-foreground">此专家快照未固定 MCP 连接。</p>
                  )}
                  <p className="text-ui-sm text-muted-foreground">
                    检测使用连接的当前配置；本任务固定版本的加载情况请查看实际运行记录。
                  </p>
                </section>
              </>
            ) : (
              <p className="text-muted-foreground">
                {snapshot.isError ? "无法读取固定的专家快照。" : "正在读取专家快照…"}
              </p>
            )}
            <section className="space-y-2 border-t border-border pt-4">
              <h3 className="font-medium">实际运行记录</h3>
              {appliedRuntime.isLoading ? (
                <p role="status" className="text-muted-foreground">
                  正在读取实际运行记录…
                </p>
              ) : appliedRuntime.isError ? (
                <p role="alert" className="text-destructive">
                  无法读取实际运行记录。
                </p>
              ) : appliedRuntime.data ? (
                <dl className="grid gap-1 text-muted-foreground">
                  <div className="flex flex-wrap gap-x-2">
                    <dt>运行组件</dt>
                    <dd>{appliedRuntime.data.runtimeComponent ?? "未识别"}</dd>
                  </div>
                  <div className="flex flex-wrap gap-x-2">
                    <dt>运行版本</dt>
                    <dd>{appliedRuntime.data.runtimeVersion ?? "未识别"}</dd>
                  </div>
                  <div className="flex flex-wrap gap-x-2">
                    <dt>实际模型</dt>
                    <dd>
                      {appliedRuntime.data.provider} · {appliedRuntime.data.model ?? "未识别"}
                    </dd>
                  </div>
                  <div className="flex flex-wrap gap-x-2">
                    <dt>生命周期代次</dt>
                    <dd className="break-all font-mono text-ui-xs">
                      {appliedRuntime.data.lifecycleGeneration}
                    </dd>
                  </div>
                  <div className="flex flex-wrap gap-x-2">
                    <dt>成功应用时间</dt>
                    <dd>
                      <time dateTime={appliedRuntime.data.appliedAt}>
                        {new Date(appliedRuntime.data.appliedAt).toLocaleString()}
                      </time>
                    </dd>
                  </div>
                </dl>
              ) : (
                <p className="text-muted-foreground">尚无成功启动记录。</p>
              )}
            </section>
            <section className="space-y-2 border-t border-border pt-4">
              <h3 className="font-medium">用其他专家继续</h3>
              <p className="text-muted-foreground">
                创建独立接续任务，使用新会话并带入当前任务的有界摘要。
              </p>
              <div className="grid gap-2">
                {(experts.data ?? [])
                  .filter((expert: ExpertDefinition) => !expert.archived)
                  .map((expert) => (
                    <Button
                      key={expert.id}
                      type="button"
                      variant={selectedId === expert.id ? "secondary" : "outline"}
                      className="justify-start"
                      onClick={() => setSelectedId(expert.id)}
                    >
                      {expert.name} · v{expert.revision}
                      {expert.id === props.binding.expertId &&
                      expert.revision > props.binding.revision
                        ? " · 有新版"
                        : ""}
                    </Button>
                  ))}
              </div>
              {selected && preview.data ? (
                <p className="text-muted-foreground">
                  {preview.data.status === "available"
                    ? "可用"
                    : preview.data.status === "partial"
                      ? "部分可用"
                      : preview.data.status === "blocked"
                        ? "需连接"
                        : "不兼容"}
                  {preview.data.issues.length ? `: ${preview.data.issues.join("; ")}` : ""}
                </p>
              ) : null}
              {props.provider !== "codex" && props.provider !== "pi" ? (
                <p className="text-destructive">专家目前支持 Codex 和 Pi。</p>
              ) : null}
              {!props.canContinue ? (
                <p className="text-muted-foreground">请先完成或取消当前工作，再创建接续任务。</p>
              ) : null}
              {error ? (
                <p role="alert" className="text-destructive">
                  {error}
                </p>
              ) : null}
            </section>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>
              取消
            </Button>
            <Button disabled={!canStart} onClick={() => void continueWithExpert()}>
              创建接续任务
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
