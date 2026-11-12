export type BaselineScene = "idle" | "history" | "running" | "question" | "approval" | "error";

export type CompanionPhase = "idle" | "running" | "question" | "approval" | "error" | "complete";

export interface CompanionStatus {
  phase: CompanionPhase;
  threadId: string;
  threadTitle: string;
  revision: number;
}

export interface BaselineStatusMessage {
  source: "synara-zen-baseline";
  type: "status";
  status: CompanionStatus;
}

/** Preview-only controls. The production router and ChatView own all UI rendering. */
export interface BaselineFixtureController {
  setScene: (scene: BaselineScene) => void;
  subscribeStatus: (listener: (status: CompanionStatus) => void) => () => void;
  dispose: () => void;
}

export interface BaselineFrameMessage {
  source: "synara-zen-baseline";
  mode: "zen" | "workspace";
  expanded: boolean;
  isBubble: boolean;
  height: number;
}
