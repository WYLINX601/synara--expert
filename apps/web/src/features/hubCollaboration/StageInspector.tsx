import type { HubPlanSnapshot, ThreadId } from "@synara/contracts";
import { useState } from "react";
import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { Menu, MenuItem, MenuTrigger } from "~/components/ui/menu";
import { EllipsisIcon } from "~/lib/icons";
import { HubPlanDeliverablePreview } from "./HubPlanDeliverablePreview";
import { hubGraphNodes } from "./hubGraph.logic";
import { describeHubNodeIssue } from "./StageInspector.logic";

export function StageInspector(props: {
  readonly snapshot: HubPlanSnapshot;
  readonly stageKey: string;
  readonly nodeKey: string | null | undefined;
  readonly onOpenThread?: ((threadId: ThreadId) => void) | undefined;
  readonly onOpenPlanActions?: (() => void) | undefined;
  readonly showActions?: boolean;
}) {
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const stage = props.snapshot.graph.stages.find((item) => item.stageKey === props.stageKey);
  const graph = hubGraphNodes(props.snapshot, props.stageKey);
  const node =
    props.nodeKey === null
      ? graph.gate
      : graph.levels.flat().find((item) => item.nodeKey === props.nodeKey);
  if (!stage || (props.nodeKey !== undefined && !node)) return null;
  const state = props.snapshot.nodeStates.find((item) => item.nodeKey === props.nodeKey);
  const report = state?.progressSummary?.trim();
  const stageAffected = stage.status === "blocked" || stage.status === "changes_requested";
  const blocked = node?.status === "blocked" || (props.nodeKey === undefined && stageAffected);
  const reasons = blocked || stageAffected ? [...new Set(stage.blockingReasons)] : [];
  const awaitingReview = props.snapshot.definition.nodes.some(
    (definition) =>
      definition.stageKey === props.stageKey &&
      definition.role === "reviewer" &&
      definition.dependsOnNodeKeys.includes(props.nodeKey ?? "") &&
      graph.levels
        .flat()
        .some((item) => item.nodeKey === definition.key && item.status === "pending"),
  );
  const issue = blocked
    ? describeHubNodeIssue({
        report,
        reasons,
        retryable: state?.retryable === true,
        reviewOutcome: state?.reviewOutcome,
        awaitingReview,
      })
    : null;
  const showOutput = node?.status === "completed" || node?.status === "awaiting_confirmation";
  const showConfirmation = node?.status === "awaiting_confirmation" && props.onOpenPlanActions;
  const metadata = [
    ["Worker", node?.workerThreadId],
    ["任务", state?.taskId],
    ["当前尝试", state?.attemptId],
    ["计划修订", props.snapshot.revision],
    ["执行轮次", stage.generation],
  ].filter((entry) => entry[1] != null);
  return (
    <section className="space-y-3 px-3 pb-3 pt-1.5 text-ui-sm" aria-label="节点详情">
      {issue ? (
        <div className="max-w-prose space-y-2.5">
          <div className="space-y-1">
            <h3 className="font-medium">{issue.title}</h3>
            <p className="leading-relaxed text-muted-foreground">{issue.summary}</p>
          </div>
          <div className="space-y-1">
            <p className="font-medium">下一步</p>
            <p className="leading-relaxed text-muted-foreground">{issue.nextStep}</p>
            <p className="text-ui-xs text-muted-foreground">系统尚未确认阻塞是否解除。</p>
          </div>
        </div>
      ) : null}
      {showOutput && stage.outputSummary ? (
        <p className="max-w-prose whitespace-pre-wrap break-words">{stage.outputSummary}</p>
      ) : null}
      {showOutput && stage.deliverableRefs?.length ? (
        <div className="space-y-2" aria-label="阶段固定版本成果">
          {stage.deliverableRefs.map((reference) => (
            <HubPlanDeliverablePreview
              key={`${reference.workerThreadId}:${reference.revision}:${reference.file.path}`}
              reference={reference}
            />
          ))}
        </div>
      ) : null}
      <Collapsible open={technicalOpen} onOpenChange={setTechnicalOpen}>
        <div className="flex flex-wrap items-center gap-2">
          {showConfirmation && props.showActions !== false ? (
            <Button size="xs" onClick={props.onOpenPlanActions}>
              前往确认
            </Button>
          ) : null}
          {props.showActions !== false && node?.workerThreadId && props.onOpenThread ? (
            <Button
              size="xs"
              variant={blocked ? "default" : "outline"}
              onClick={() => props.onOpenThread?.(node.workerThreadId!)}
            >
              {node.status === "running" ? "查看进度" : "查看线程"}
            </Button>
          ) : null}
          <CollapsibleTrigger render={<Button size="xs" variant="ghost" />}>
            <DisclosureChevron open={technicalOpen} className="size-3" />
            技术详情
          </CollapsibleTrigger>
          {props.showActions !== false && !showConfirmation && props.onOpenPlanActions ? (
            <Menu>
              <MenuTrigger
                render={<Button size="icon-xs" variant="ghost" className="ml-auto" />}
                aria-label="更多操作"
              >
                <EllipsisIcon className="size-3.5" />
              </MenuTrigger>
              <ComposerPickerMenuPopup side="top" align="end">
                <MenuItem onClick={props.onOpenPlanActions}>计划操作</MenuItem>
              </ComposerPickerMenuPopup>
            </Menu>
          ) : null}
        </div>
        <CollapsiblePanel>
          <div
            className="space-y-3 pt-3 text-ui-xs text-muted-foreground [overflow-wrap:anywhere]"
            aria-label="原始技术信息"
          >
            {report ? (
              <div className="space-y-1">
                <p className="font-medium">线程原始报告</p>
                <p className="whitespace-pre-wrap">{report}</p>
              </div>
            ) : null}
            {reasons.length ? (
              <div className="space-y-1">
                <p className="font-medium">系统返回</p>
                <ul className="space-y-1" aria-label="阶段阻塞信息">
                  {reasons.map((reason) => (
                    <li className="whitespace-pre-wrap" key={reason}>
                      {reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {state?.queueReason ? (
              <p className="whitespace-pre-wrap">排队原因：{state.queueReason}</p>
            ) : null}
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
              {metadata.map(([label, value]) => (
                <div className="contents" key={label}>
                  <dt>{label}</dt>
                  <dd className="min-w-0 select-text">{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}
