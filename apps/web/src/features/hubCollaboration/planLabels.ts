import type { HubPlanControlState, HubPlanStageStatus } from "@synara/contracts";

const STAGE_STATUS_LABELS: Record<HubPlanStageStatus, string> = {
  draft: "待确认",
  not_started: "未开始",
  blocked: "受阻",
  ready: "待执行",
  queued: "排队中",
  running: "进行中",
  waiting: "等待中",
  awaiting_candidate: "等待成果",
  reviewing: "审核中",
  changes_requested: "需要修改",
  ready_to_release: "待放行",
  waiting_user: "待你确认",
  released: "已放行",
  pausing: "正在暂停",
  paused: "已暂停",
  cancelling: "正在取消",
  cancelled: "已取消",
};

const CONTROL_STATE_LABELS: Record<HubPlanControlState, string> = {
  draft: "待确认计划",
  active: "协作进行中",
  pausing: "正在暂停",
  paused: "已暂停",
  cancelling: "正在取消",
  cancelled: "已取消",
  completed: "已完成",
};

export function hubPlanStageStatusLabel(status: HubPlanStageStatus): string {
  return STAGE_STATUS_LABELS[status];
}

export function hubPlanControlStateLabel(status: HubPlanControlState): string {
  return CONTROL_STATE_LABELS[status];
}
