import type { HubPlanSnapshot, ThreadId } from "@synara/contracts";
import { Fragment, useEffect, useRef, useState } from "react";
import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel } from "~/components/ui/collapsible";
import { Menu, MenuItem, MenuTrigger } from "~/components/ui/menu";
import {
  ArrowUpCircleIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleQuestionIcon,
  ClockIcon,
  EllipsisIcon,
  LoaderCircleIcon,
  XIcon,
} from "~/lib/icons";
import { StageInspector } from "./StageInspector";
import { describeHubNodeIssue } from "./StageInspector.logic";
import {
  hubGraphDefaultStageKey,
  hubGraphNodes,
  hubGraphStageWaitsForUpstream,
  type HubGraphNode,
} from "./hubGraph.logic";

function NodeStatus({
  node,
  feedback = false,
}: {
  readonly node: HubGraphNode;
  readonly feedback?: boolean;
}) {
  const iconClass = feedback ? "size-4 shrink-0 text-muted-foreground" : "size-3.5 shrink-0";
  switch (node.status) {
    case "completed":
      return (
        <CheckIcon
          className={`${iconClass} ${feedback ? "" : "text-success-foreground"}`}
          aria-hidden
        />
      );
    case "running":
      return (
        <LoaderCircleIcon
          className={`${iconClass} ${feedback ? "" : "text-info-foreground"} animate-spin motion-reduce:animate-none`}
          aria-hidden
        />
      );
    case "queued":
    case "waiting":
      return <ClockIcon className={`${iconClass} text-muted-foreground`} aria-hidden />;
    case "blocked":
      return feedback ? (
        <CircleAlertIcon className={iconClass} aria-hidden />
      ) : (
        <span className="size-2 shrink-0 rounded-full bg-destructive" aria-hidden />
      );
    case "awaiting_confirmation":
      return <CircleQuestionIcon className={`${iconClass} text-muted-foreground`} aria-hidden />;
    case "dispatched":
      return <ArrowUpCircleIcon className={`${iconClass} text-muted-foreground`} aria-hidden />;
    case "cancelled":
      return <XIcon className={`${iconClass} text-muted-foreground`} aria-hidden />;
    case "pending":
      return (
        <span
          className="size-2 shrink-0 rounded-full border border-muted-foreground/60"
          aria-hidden
        />
      );
  }
}

function PipelineNodeButton(props: {
  readonly node: HubGraphNode;
  readonly selected: boolean;
  readonly number: number;
  readonly onClick: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!props.selected || !ref.current) return;
    const track = ref.current.closest<HTMLElement>("[data-hub-graph-track]");
    if (!track) return;
    const nodeBounds = ref.current.getBoundingClientRect();
    const trackBounds = track.getBoundingClientRect();
    if (nodeBounds.left < trackBounds.left)
      track.scrollLeft += nodeBounds.left - trackBounds.left - 8;
    else if (nodeBounds.right > trackBounds.right)
      track.scrollLeft += nodeBounds.right - trackBounds.right + 8;
  }, [props.selected]);
  const { node } = props;
  const tone = props.selected
    ? `${node.status === "blocked" ? "bg-destructive/5 hover:bg-destructive/5" : "bg-secondary hover:bg-secondary"} font-semibold text-foreground`
    : "font-normal text-muted-foreground hover:bg-secondary/50";
  return (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      size="default"
      aria-pressed={props.selected}
      aria-label={`${node.roleLabel}：${node.taskTitle}，${node.statusLabel}`}
      title={`${node.roleLabel}：${node.taskTitle} · ${node.statusLabel}`}
      data-status={node.status}
      onClick={props.onClick}
      className={`h-8 min-h-8 min-w-36 flex-1 justify-start gap-2 rounded-full px-3 py-1 text-left text-ui sm:h-8 ${tone}`}
    >
      <NodeStatus node={node} />
      <span className="shrink-0 tabular-nums">{String(props.number).padStart(2, "0")}</span>
      <span className="min-w-0 truncate">
        {node.roleLabel}：{node.taskTitle}
      </span>
    </Button>
  );
}

function feedbackForNode(snapshot: HubPlanSnapshot, node: HubGraphNode): string {
  const state = snapshot.nodeStates.find((item) => item.nodeKey === node.nodeKey);
  if (node.status === "blocked") {
    if (state?.reviewOutcome === "changes_requested") return "审核要求修改成果";
    if (state?.reviewOutcome === "blocked") return "审核未能完成";
    if (state?.workState === "failed") return "本次执行失败，尚无已验收成果";
    return state?.retryable ? "回合结束，未提交成果" : "执行受阻，需要核实原因";
  }
  switch (node.status) {
    case "completed":
      return node.nodeKey === null
        ? "已确认放行"
        : state?.reviewOutcome === "pass"
          ? "审核通过"
          : "本次任务已完成";
    case "awaiting_confirmation":
      return "成果与必要审核已就绪，等待人工确认";
    case "running":
      return "正在执行，尚无最终结果";
    case "queued":
      return "已进入队列，等待执行";
    case "waiting":
      if (node.statusLabel === "等待回复") return "需要你的补充后才能继续";
      if (node.statusLabel === "等待送达") return "回复已保存，等待原线程接收";
      return "尚未返回最终成果";
    case "dispatched":
      return "已派发，等待运行反馈";
    case "cancelled":
      return "本次执行已取消";
    case "pending":
      return "尚无执行结果";
  }
}

export function HubPipelineStrip(props: {
  readonly snapshot: HubPlanSnapshot;
  readonly connected: boolean;
  readonly error?: string | null | undefined;
  readonly onRefresh?: (() => void) | undefined;
  readonly onOpenThread?: ((threadId: ThreadId) => void) | undefined;
  readonly onOpenPlanActions?: (() => void) | undefined;
}) {
  const { snapshot } = props;
  const [selectedStage, setSelectedStage] = useState<{
    readonly planId: string;
    readonly stageKey: string;
  } | null>(null);
  const [selection, setSelection] = useState<{
    readonly scope: string;
    readonly key: string;
  } | null>(null);
  const [detailsSelection, setDetailsSelection] = useState<string | null>(null);
  const stage =
    snapshot.graph.stages.find(
      (item) =>
        item.stageKey ===
        (selectedStage?.planId === snapshot.id
          ? selectedStage.stageKey
          : hubGraphDefaultStageKey(snapshot)),
    ) ?? snapshot.graph.stages[0];
  if (!stage) return null;
  const scope = `${snapshot.id}:${snapshot.revision}:${stage.stageKey}:${stage.generation ?? ""}`;
  const graph = hubGraphNodes(snapshot, stage.stageKey);
  const flatNodes = graph.levels.flat();
  const nodes = graph.gate ? [...flatNodes, graph.gate] : flatNodes;
  const defaultNode =
    nodes.find((node) => node.status === "blocked") ??
    nodes.find((node) => node.status === "awaiting_confirmation") ??
    nodes.find((node) => ["running", "queued", "waiting", "dispatched"].includes(node.status)) ??
    nodes.find((node) => node.status === "pending") ??
    nodes.at(-1);
  const selectedNode =
    (selection?.scope === scope ? nodes.find((node) => node.key === selection.key) : undefined) ??
    defaultNode;
  const hasStageOnlyIssue =
    (stage.status === "blocked" || stage.status === "changes_requested") &&
    !hubGraphStageWaitsForUpstream(snapshot, stage.stageKey) &&
    !flatNodes.some((node) => node.status === "blocked");
  const showStageIssue = hasStageOnlyIssue && selection?.scope !== scope;
  const detailKey = `${scope}:${selectedNode?.key ?? "stage"}`;
  const detailsOpen = detailsSelection === detailKey;
  const summary = showStageIssue
    ? describeHubNodeIssue({
        report: undefined,
        reasons: stage.blockingReasons,
        retryable: false,
        reviewOutcome: undefined,
        awaitingReview: false,
      }).title
    : selectedNode
      ? feedbackForNode(snapshot, selectedNode)
      : "尚无执行结果";
  function selectNode(node: HubGraphNode) {
    setSelection({ scope, key: node.key });
    setDetailsSelection(null);
  }
  return (
    <section
      aria-label="协作流程"
      data-hub-pipeline-strip=""
      className="min-w-0"
      onKeyDown={(event) => {
        if (event.key === "Escape" && detailsOpen) {
          event.stopPropagation();
          setDetailsSelection(null);
        }
      }}
    >
      {!props.connected || props.error ? (
        <div
          className="flex min-h-9 items-center gap-2 px-6 py-2 text-ui-xs text-muted-foreground"
          role="status"
        >
          {!props.connected ? <span>连接已断开，显示最近状态</span> : null}
          {props.error ? (
            <span className="min-w-0 flex-1 truncate text-destructive" title={props.error}>
              状态更新失败：{props.error}
            </span>
          ) : null}
          {props.error && props.onRefresh ? (
            <Button variant="ghost" size="xs" onClick={props.onRefresh}>
              刷新
            </Button>
          ) : null}
        </div>
      ) : null}
      {snapshot.graph.stages.length > 1 ? (
        <div className="flex gap-1 overflow-x-auto px-6 pt-3" role="group" aria-label="计划阶段">
          {snapshot.graph.stages.map((item) => (
            <Button
              key={item.stageKey}
              variant={stage.stageKey === item.stageKey ? "secondary" : "ghost"}
              size="xs"
              aria-pressed={stage.stageKey === item.stageKey}
              title={item.title}
              className="max-w-64 shrink-0 truncate"
              onClick={() => {
                setSelectedStage({ planId: snapshot.id, stageKey: item.stageKey });
                setSelection(null);
                setDetailsSelection(null);
              }}
            >
              {item.title}
            </Button>
          ))}
        </div>
      ) : null}
      <div
        data-hub-graph-track=""
        className="flex min-h-[52px] items-center gap-2 overflow-x-auto px-4 py-2"
        role="group"
        aria-label={`${stage.title}协作进度链`}
      >
        {graph.levels.map((level, index) => (
          <Fragment key={level.map((node) => node.key).join("|")}>
            {index > 0 ? <span className="h-px w-5 shrink-0 bg-border" aria-hidden /> : null}
            <div
              className="flex flex-1 items-center gap-2"
              style={{
                minWidth:
                  level.length * 144 +
                  Math.max(0, level.length - 1) * 8 +
                  (level.length > 1 ? 40 : 0),
              }}
              role="group"
              aria-label={level.length > 1 ? "并行节点" : undefined}
            >
              {level.length > 1 ? (
                <span className="shrink-0 text-ui-xs text-muted-foreground">并行</span>
              ) : null}
              {level.map((node) => (
                <PipelineNodeButton
                  key={node.key}
                  node={node}
                  number={flatNodes.indexOf(node) + 1}
                  selected={selectedNode?.key === node.key}
                  onClick={() => selectNode(node)}
                />
              ))}
            </div>
          </Fragment>
        ))}
        {graph.gate ? (
          <>
            {flatNodes.length ? <span className="h-px w-5 shrink-0 bg-border" aria-hidden /> : null}
            <PipelineNodeButton
              node={graph.gate}
              number={flatNodes.length + 1}
              selected={selectedNode?.key === graph.gate.key}
              onClick={() => selectNode(graph.gate!)}
            />
          </>
        ) : null}
      </div>
      <div
        className="flex min-h-[48px] flex-wrap items-center justify-between gap-2 border-t border-border/60 px-4 py-2"
        aria-label="执行反馈"
      >
        <div className="flex min-w-36 flex-1 items-center gap-2">
          {showStageIssue ? (
            <CircleAlertIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          ) : selectedNode ? (
            <NodeStatus node={selectedNode} feedback />
          ) : null}
          <p className="line-clamp-2 text-ui font-medium text-muted-foreground" title={summary}>
            {summary}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            className="rounded-lg"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsSelection(detailsOpen ? null : detailKey)}
          >
            {detailsOpen ? "收起详情" : "查看详情"}
          </Button>
          {selectedNode?.workerThreadId && props.onOpenThread ? (
            <Button
              variant="outline"
              size="sm"
              className="rounded-lg"
              onClick={() => props.onOpenThread?.(selectedNode.workerThreadId!)}
            >
              查看线程
            </Button>
          ) : null}
          {props.onOpenPlanActions ? (
            <Menu>
              <MenuTrigger
                render={<Button variant="ghost" size="icon-sm" className="rounded-lg" />}
                aria-label="更多操作"
              >
                <EllipsisIcon className="size-4" />
              </MenuTrigger>
              <ComposerPickerMenuPopup side="top" align="end">
                <MenuItem onClick={props.onOpenPlanActions}>
                  {selectedNode?.status === "awaiting_confirmation" ? "前往确认" : "计划操作"}
                </MenuItem>
              </ComposerPickerMenuPopup>
            </Menu>
          ) : null}
        </div>
      </div>
      <Collapsible open={detailsOpen}>
        <CollapsiblePanel>
          {detailsOpen ? (
            <div className="px-3 pb-2">
              <StageInspector
                key={detailKey}
                snapshot={snapshot}
                stageKey={stage.stageKey}
                nodeKey={showStageIssue ? undefined : selectedNode?.nodeKey}
                showActions={false}
              />
            </div>
          ) : null}
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}
