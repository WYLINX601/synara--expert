import type {
  HubPlanCommandInput,
  HubPlanEvent,
  HubPlanInputRequest,
  HubPlanSnapshot,
  ProjectId,
} from "@synara/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { startVisibleInterval } from "~/lib/visibleInterval";
import { useNativeApiServerCapabilitySnapshot } from "~/hooks/useNativeApiServerCapability";
import { getHubPlansClient, observeHubProjectAgentSnapshots } from "~/workbench/host/hubPlanClient";

import {
  isHubPlanControlEvent,
  latestSnapshotFromHubPlanEvents,
  mergeHubPlanEvents,
  sameHubPlanDefinition,
  selectCurrentHubPlan,
  snapshotFromHubPlanEvent,
} from "./hubPlan.logic";
import { currentHubInputRequest, sameHubInputRequestIdentity } from "./hubInputRequest.logic";

const REFRESH_INTERVAL_MS = 8_000;
const RETURNABLE_CANDIDATE_STATES = new Set([
  "waiting_user",
  "changes_requested",
  "ready_to_release",
]);

export type HubPlanCandidateReference = {
  readonly stageKey: string;
  readonly stageTitle: string;
  readonly generation: number;
  readonly candidateId: string;
  readonly outputDigest: string;
};

export type HubPlanRetryReference = {
  readonly nodeKey: string;
  readonly attemptId: NonNullable<HubPlanSnapshot["nodeStates"][number]["attemptId"]>;
  readonly stageKey: string;
  readonly generation: number;
};

export type HubPlanActionReference = HubPlanCandidateReference | HubPlanRetryReference;

export type HubPlanUserAction =
  | "confirm"
  | "pause"
  | "resume"
  | "cancel"
  | "release"
  | "return"
  | "retry";

export type HubPlansState = {
  readonly hubId: ProjectId | null;
  readonly connectionGeneration: string | null;
  readonly ready: boolean;
  readonly plan: HubPlanSnapshot | null;
  readonly events: ReadonlyArray<HubPlanEvent>;
  readonly loading: boolean;
  readonly error: string | null;
};

const emptyState = (
  hubId: ProjectId | null,
  connectionGeneration: string | null,
): HubPlansState => ({
  hubId,
  connectionGeneration,
  ready: false,
  plan: null,
  events: [],
  loading: false,
  error: null,
});

function actionError(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : "服务暂时不可用，请稍后重试。";
  if (/conflict|state.?version|revision|stale|version/i.test(detail)) {
    return "计划已更新，请查看最新操作卡后重试。";
  }
  return detail;
}

function sameEvent(left: HubPlanEvent, right: HubPlanEvent): boolean {
  return (
    left === right ||
    (left.hubId === right.hubId &&
      left.planId === right.planId &&
      left.sequence === right.sequence &&
      left.kind === right.kind &&
      left.createdAt === right.createdAt &&
      JSON.stringify(left.payload) === JSON.stringify(right.payload))
  );
}

function snapshotIsNewer(candidate: HubPlanSnapshot, current: HubPlanSnapshot): boolean {
  return (
    candidate.stateVersion > current.stateVersion ||
    (candidate.stateVersion === current.stateVersion &&
      candidate.eventSequence > current.eventSequence)
  );
}

function isLatestControlEvent(event: HubPlanEvent, events: ReadonlyArray<HubPlanEvent>): boolean {
  return (
    isHubPlanControlEvent(event) &&
    events
      .filter((candidate) => candidate.planId === event.planId && isHubPlanControlEvent(candidate))
      .reduce((latest, candidate) => Math.max(latest, candidate.sequence), 0) === event.sequence
  );
}

function isRetryReference(reference: HubPlanActionReference): reference is HubPlanRetryReference {
  return "attemptId" in reference;
}

export function useHubPlans(input: {
  readonly hubId: ProjectId | null;
  readonly enabled: boolean;
}) {
  const { capability, generation, connected } =
    useNativeApiServerCapabilitySnapshot("hubCollaboration.plan");
  const [state, setState] = useState<HubPlansState>(() => emptyState(input.hubId, generation));
  const stateRef = useRef(state);
  const hubIdRef = useRef(input.hubId);
  const generationRef = useRef(generation);
  const connectedRef = useRef(connected);
  const capabilityRef = useRef(capability);
  const enabledRef = useRef(input.enabled);
  const refreshRef = useRef<((forceSnapshot?: boolean) => void) | null>(null);
  const pendingRequestIdsRef = useRef(new Map<string, string>());
  const inFlightRequestKeysRef = useRef(new Set<string>());
  const mutationEpochRef = useRef(0);
  useLayoutEffect(() => {
    stateRef.current = state;
    hubIdRef.current = input.hubId;
    generationRef.current = generation;
    connectedRef.current = connected;
    capabilityRef.current = capability;
    enabledRef.current = input.enabled;
  }, [capability, connected, generation, input.enabled, input.hubId, state]);

  const refreshNow = useCallback((forceSnapshot = true) => {
    refreshRef.current?.(forceSnapshot);
  }, []);

  useEffect(() => {
    const hubId = input.hubId;
    const effectGeneration = generation;
    if (!input.enabled || !hubId) {
      refreshRef.current = null;
      stateRef.current = emptyState(hubId, effectGeneration);
      setState(stateRef.current);
      return;
    }
    // Wait for capability negotiation before invoking a new RPC. Unsupported
    // hosts remain read-only and receive a clear message in the surface.
    if (capability !== "supported") {
      refreshRef.current = null;
      if (capability === "unsupported") {
        const current =
          stateRef.current.hubId === hubId ? stateRef.current : emptyState(hubId, generation);
        stateRef.current = {
          ...current,
          error: "当前服务端尚不支持协作计划，请更新服务端后重试。",
        };
        setState(stateRef.current);
      }
      return;
    }
    if (!connected) {
      refreshRef.current = null;
      return;
    }

    let disposed = false;
    let inFlight = false;
    let queued = false;
    let queuedForceSnapshot = false;
    const initialState = stateRef.current;
    const sameGenerationState =
      initialState.hubId === hubId && initialState.connectionGeneration === effectGeneration;
    let eventSequence = sameGenerationState
      ? initialState.events.reduce((latest, event) => Math.max(latest, event.sequence), 0)
      : 0;

    const publish = (update: (current: HubPlansState) => HubPlansState) => {
      if (disposed || hubIdRef.current !== hubId || generationRef.current !== effectGeneration)
        return;
      const current =
        stateRef.current.hubId === hubId ? stateRef.current : emptyState(hubId, effectGeneration);
      const next = update(current);
      stateRef.current = next;
      setState(next);
    };

    const stillCurrent = () =>
      !disposed &&
      enabledRef.current &&
      hubIdRef.current === hubId &&
      generationRef.current === effectGeneration &&
      connectedRef.current &&
      capabilityRef.current === "supported" &&
      document.visibilityState === "visible";

    const refresh = (forceSnapshot = false) => {
      if (!stillCurrent()) return;
      if (inFlight) {
        queued = true;
        queuedForceSnapshot ||= forceSnapshot;
        return;
      }
      inFlight = true;
      const startMutationEpoch = mutationEpochRef.current;
      if (stateRef.current.connectionGeneration === effectGeneration) {
        publish((current) => ({ ...current, loading: true }));
      }

      void (async () => {
        try {
          const api = getHubPlansClient();
          const listed = await api.list({ hubId });
          if (!stillCurrent()) return;
          const selected = selectCurrentHubPlan(listed);
          let nativeSnapshot: HubPlanSnapshot | null = selected;
          if (selected && (selected.id !== stateRef.current.plan?.id || forceSnapshot)) {
            const read = await api.read({ hubId, planId: selected.id });
            if (!stillCurrent()) return;
            if (read) nativeSnapshot = read;
          }

          // The cursor belongs to the Hub connection, never to the selected
          // plan. Keep events for previous plans so their timeline cards live on.
          const incoming = await api.events({ hubId, afterSequence: eventSequence });
          if (!stillCurrent()) return;
          const hubEvents = incoming.filter((event) => event.hubId === hubId);
          const latestSequence = Math.max(
            eventSequence,
            ...hubEvents.map((event) => event.sequence),
            0,
          );
          const current = stateRef.current;
          const sameConnection =
            current.hubId === hubId && current.connectionGeneration === effectGeneration;
          const cachedEvents = sameConnection ? current.events : [];
          const mergedEvents = mergeHubPlanEvents(cachedEvents, hubEvents);
          let nextPlan = nativeSnapshot;
          const currentPlan = sameConnection ? current.plan : null;
          if (mutationEpochRef.current !== startMutationEpoch && currentPlan) {
            // A query which overlapped a command cannot roll its response back.
            nextPlan = currentPlan;
          } else if (
            nextPlan &&
            current.connectionGeneration === effectGeneration &&
            currentPlan?.id === nextPlan.id &&
            snapshotIsNewer(currentPlan, nextPlan)
          ) {
            nextPlan = currentPlan;
          }
          if (nextPlan) nextPlan = latestSnapshotFromHubPlanEvents(hubEvents, nextPlan);
          eventSequence = latestSequence;
          publish(() => ({
            hubId,
            connectionGeneration: effectGeneration,
            ready: true,
            plan: nextPlan,
            events: mergedEvents,
            loading: false,
            error: null,
          }));
        } catch (cause) {
          publish((current) => ({
            ...current,
            loading: false,
            error: cause instanceof Error ? cause.message : "无法刷新协作计划。",
          }));
        } finally {
          inFlight = false;
          if (queued && !disposed) {
            const force = queuedForceSnapshot;
            queued = false;
            queuedForceSnapshot = false;
            refresh(force);
          }
        }
      })();
    };

    refreshRef.current = refresh;
    const unsubscribe = observeHubProjectAgentSnapshots(hubId, () => {
      if (document.visibilityState === "visible") refresh(true);
    });
    const stopInterval = startVisibleInterval(() => refresh(false), REFRESH_INTERVAL_MS);
    // A new connection generation always refetches a complete event window.
    refresh(!sameGenerationState);

    return () => {
      disposed = true;
      if (refreshRef.current === refresh) refreshRef.current = null;
      unsubscribe();
      stopInterval();
    };
  }, [capability, connected, generation, input.enabled, input.hubId]);

  const performAction = useCallback(
    async (
      event: HubPlanEvent,
      action: HubPlanUserAction,
      reference?: HubPlanActionReference,
      comment?: string,
    ) => {
      const hubId = input.hubId;
      const requestGeneration = generation;
      const currentState = stateRef.current;
      const currentPlan = currentState.plan;
      const canOperate =
        input.enabled &&
        connected &&
        capability === "supported" &&
        Boolean(hubId) &&
        currentState.hubId === hubId &&
        currentState.connectionGeneration === requestGeneration &&
        currentState.ready &&
        currentPlan !== null;
      if (!canOperate || !hubId || !currentPlan) {
        throw new Error("服务正在同步或尚未连接，当前计划暂不可操作。 ");
      }
      if (event.hubId !== hubId || event.planId !== currentPlan.id) {
        throw new Error("这张操作卡已过期，请查看当前计划。");
      }
      const cachedEvent = currentState.events.find(
        (item) =>
          item.hubId === event.hubId &&
          item.planId === event.planId &&
          item.sequence === event.sequence,
      );
      if (
        !cachedEvent ||
        !sameEvent(cachedEvent, event) ||
        !isLatestControlEvent(cachedEvent, currentState.events)
      ) {
        throw new Error("这张操作卡已过期或不属于当前连接，请查看最新计划。");
      }
      const eventSnapshot = snapshotFromHubPlanEvent(cachedEvent);
      if (!eventSnapshot || eventSnapshot.id !== currentPlan.id) {
        throw new Error("这张操作卡缺少可验证的计划快照，请查看最新操作卡。");
      }
      const api = getHubPlansClient();
      const readMutationEpoch = mutationEpochRef.current;
      const latest = await api.read({ hubId, planId: currentPlan.id });
      if (
        generationRef.current !== requestGeneration ||
        hubIdRef.current !== hubId ||
        !connectedRef.current ||
        capabilityRef.current !== "supported" ||
        stateRef.current.connectionGeneration !== requestGeneration ||
        !stateRef.current.ready
      ) {
        throw new Error("服务连接已变化，请刷新当前计划后重试。");
      }
      if (mutationEpochRef.current !== readMutationEpoch) {
        throw new Error("计划在操作期间已更新，请查看最新操作卡后重试。");
      }
      if (!latest) throw new Error("当前计划已不存在。");
      const latestCachedEvent = stateRef.current.events.find(
        (item) => item.planId === event.planId && item.sequence === event.sequence,
      );
      if (
        !latestCachedEvent ||
        !sameEvent(latestCachedEvent, event) ||
        !isLatestControlEvent(latestCachedEvent, stateRef.current.events)
      ) {
        throw new Error("这张操作卡已被新快照替代，请查看最新操作卡。");
      }

      let command: HubPlanCommandInput;
      const requestIdentity = JSON.stringify({
        generation: requestGeneration,
        hubId,
        planId: latest.id,
        action,
        stateVersion: latest.stateVersion,
        revision: latest.revision,
        eventSequence: event.sequence,
        candidate:
          reference && !isRetryReference(reference)
            ? {
                stageKey: reference.stageKey,
                generation: reference.generation,
                candidateId: reference.candidateId,
                outputDigest: reference.outputDigest,
              }
            : null,
        retry:
          action === "retry" && reference && isRetryReference(reference)
            ? {
                nodeKey: reference.nodeKey,
                attemptId: reference.attemptId,
                stageKey: reference.stageKey,
                generation: reference.generation,
              }
            : null,
        comment: action === "return" ? (comment?.trim() ?? "") : null,
      });
      if (inFlightRequestKeysRef.current.has(requestIdentity)) {
        throw new Error("该操作正在提交，请等待服务返回结果。");
      }
      let requestId = pendingRequestIdsRef.current.get(requestIdentity);
      if (!requestId) {
        requestId = crypto.randomUUID();
        pendingRequestIdsRef.current.set(requestIdentity, requestId);
      }
      const commandBase = {
        hubId,
        planId: latest.id,
        requestId,
        expectedStateVersion: latest.stateVersion,
        expectedRevision: latest.revision,
      };
      if (action === "confirm") {
        if (
          latest.controlState !== "draft" ||
          eventSnapshot.controlState !== "draft" ||
          eventSnapshot.revision !== latest.revision ||
          !sameHubPlanDefinition(eventSnapshot.definition, latest.definition)
        ) {
          throw new Error("计划草案内容已更新，请查看最新操作卡后重试。");
        }
        command = { ...commandBase, action: "confirm" };
      } else if (action === "pause") {
        if (latest.controlState !== "active") throw new Error("当前计划已变化，无法暂停。");
        command = { ...commandBase, action: "pause" };
      } else if (action === "resume") {
        if (latest.controlState !== "paused") throw new Error("当前计划已变化，无法恢复。");
        command = { ...commandBase, action: "resume" };
      } else if (action === "cancel") {
        if (["cancelled", "completed", "cancelling"].includes(latest.controlState)) {
          throw new Error("当前计划已结束或正在取消。");
        }
        command = { ...commandBase, action: "cancel" };
      } else if (action === "retry") {
        if (!reference || !isRetryReference(reference)) {
          throw new Error("重试节点引用缺失，请查看最新操作卡。");
        }
        const node = latest.nodeStates.find((item) => item.nodeKey === reference.nodeKey);
        const definitionNode = latest.definition.nodes.find(
          (item) => item.key === reference.nodeKey,
        );
        const stage = latest.graph.stages.find((item) => item.stageKey === reference.stageKey);
        if (
          latest.controlState !== "active" ||
          eventSnapshot.revision !== latest.revision ||
          !node?.retryable ||
          node.attemptId !== reference.attemptId ||
          definitionNode?.stageKey !== reference.stageKey ||
          stage?.generation !== reference.generation
        ) {
          throw new Error("该节点或执行尝试已更新，无法重试。请查看最新操作卡。");
        }
        command = {
          ...commandBase,
          action: "retry",
          nodeKey: reference.nodeKey,
          attemptId: reference.attemptId,
          stageKey: reference.stageKey,
          generation: reference.generation,
        };
      } else {
        if (!reference || isRetryReference(reference)) {
          throw new Error("候选成果引用缺失，无法操作。");
        }
        const candidate = reference;
        const eventStage = eventSnapshot.graph.stages.find(
          (item) => item.stageKey === candidate.stageKey,
        );
        const stage = latest.graph.stages.find((item) => item.stageKey === candidate.stageKey);
        const fixedCandidateMatches = (view: typeof stage) =>
          view !== undefined &&
          view.generation === candidate.generation &&
          view.candidateId === candidate.candidateId &&
          view.outputDigest === candidate.outputDigest;
        const validStatuses =
          action === "release" ? new Set(["waiting_user"]) : RETURNABLE_CANDIDATE_STATES;
        if (
          latest.controlState !== "active" ||
          !eventStage ||
          !stage ||
          !validStatuses.has(eventStage.status) ||
          !validStatuses.has(stage.status) ||
          !fixedCandidateMatches(eventStage) ||
          !fixedCandidateMatches(stage)
        ) {
          throw new Error("这项候选成果已过期，请查看最新候选版本。");
        }
        if (action === "return" && !comment?.trim()) {
          throw new Error("请填写需要修改的内容。");
        }
        command = {
          ...commandBase,
          action: action === "release" ? "release" : "return",
          stageKey: stage.stageKey,
          generation: stage.generation!,
          candidateId: candidate.candidateId,
          outputDigest: candidate.outputDigest,
          ...(action === "return" ? { comment: comment!.trim() } : {}),
        };
      }

      inFlightRequestKeysRef.current.add(requestIdentity);
      mutationEpochRef.current += 1;
      try {
        const updated = await api.command(command);
        mutationEpochRef.current += 1;
        pendingRequestIdsRef.current.delete(requestIdentity);
        if (
          generationRef.current === requestGeneration &&
          hubIdRef.current === hubId &&
          connectedRef.current &&
          capabilityRef.current === "supported"
        ) {
          const current = stateRef.current;
          const existing = current.plan;
          const nextPlan =
            current.connectionGeneration === requestGeneration &&
            existing &&
            !snapshotIsNewer(updated, existing)
              ? existing
              : updated;
          stateRef.current = { ...current, plan: nextPlan, ready: true, error: null };
          setState(stateRef.current);
          refreshRef.current?.(false);
        }
      } catch (cause) {
        mutationEpochRef.current += 1;
        refreshRef.current?.(true);
        throw new Error(actionError(cause), { cause });
      } finally {
        inFlightRequestKeysRef.current.delete(requestIdentity);
      }
    },
    [capability, connected, generation, input.enabled, input.hubId],
  );

  const respondInputRequest = useCallback(
    async (
      event: HubPlanEvent,
      request: HubPlanInputRequest,
      answers: ReadonlyArray<string>,
    ): Promise<HubPlanSnapshot> => {
      const hubId = input.hubId;
      const requestGeneration = generation;
      const currentState = stateRef.current;
      const currentPlan = currentState.plan;
      const canOperate =
        input.enabled &&
        connected &&
        capability === "supported" &&
        Boolean(hubId) &&
        currentState.hubId === hubId &&
        currentState.connectionGeneration === requestGeneration &&
        currentState.ready &&
        currentPlan !== null;
      if (!canOperate || !hubId || !currentPlan) {
        throw new Error("服务正在同步或尚未连接，当前问题暂不可回复。");
      }
      if (event.hubId !== hubId || event.planId !== currentPlan.id) {
        throw new Error("这张问题卡已过期，请查看当前计划。");
      }
      const cachedEvent = currentState.events.find(
        (item) =>
          item.hubId === event.hubId &&
          item.planId === event.planId &&
          item.sequence === event.sequence,
      );
      const eventRequest = cachedEvent?.payload.inputRequest;
      if (
        !cachedEvent ||
        !sameEvent(cachedEvent, event) ||
        !eventRequest ||
        !sameHubInputRequestIdentity(eventRequest, request)
      ) {
        throw new Error("这张问题卡不属于当前连接或问题已变化，请刷新后重试。");
      }
      const eventSnapshot = snapshotFromHubPlanEvent(cachedEvent);
      if (
        !eventSnapshot ||
        eventSnapshot.id !== currentPlan.id ||
        eventSnapshot.revision !== currentPlan.revision
      ) {
        throw new Error("计划版本已变化，请查看最新问题卡后重试。");
      }

      const responseTargetIdentity = JSON.stringify({
        generation: requestGeneration,
        hubId,
        planId: currentPlan.id,
        revision: currentPlan.revision,
        inputRequestId: request.id,
        nodeKey: request.nodeKey,
        stageKey: request.stageKey,
        generationNumber: request.generation,
        attemptId: request.attemptId,
      });
      if (inFlightRequestKeysRef.current.has(responseTargetIdentity)) {
        throw new Error("该回复正在提交，请等待服务返回结果。");
      }
      inFlightRequestKeysRef.current.add(responseTargetIdentity);
      try {
        const api = getHubPlansClient();
        const expectedMutationEpoch = mutationEpochRef.current;
        const latest = await api.read({ hubId, planId: currentPlan.id });
        if (
          generationRef.current !== requestGeneration ||
          hubIdRef.current !== hubId ||
          !connectedRef.current ||
          capabilityRef.current !== "supported" ||
          stateRef.current.connectionGeneration !== requestGeneration ||
          !stateRef.current.ready
        ) {
          throw new Error("服务连接已变化，请刷新当前问题后重试。");
        }
        if (mutationEpochRef.current !== expectedMutationEpoch) {
          throw new Error("计划在回复期间已更新，请查看最新问题卡后重试。");
        }
        if (!latest || latest.id !== currentPlan.id || latest.revision !== eventSnapshot.revision) {
          throw new Error("计划版本已变化，请查看最新问题卡后重试。");
        }
        const latestRequest = currentHubInputRequest(
          {
            hubId,
            planId: latest.id,
            revision: latest.revision,
            request,
          },
          latest,
        );
        if (!latestRequest) {
          throw new Error("该 Worker 问题已过期、暂停或执行尝试已变化。");
        }
        if (
          answers.length !== latestRequest.questions.length ||
          answers.some((answer) => !answer.trim())
        ) {
          throw new Error("请为每个问题填写一项回复。");
        }

        const normalizedAnswers = answers.map((answer) => answer.trim());
        const responseIdentity = JSON.stringify({
          generation: requestGeneration,
          hubId,
          planId: latest.id,
          revision: latest.revision,
          stateVersion: latest.stateVersion,
          inputRequestId: latestRequest.id,
          nodeKey: latestRequest.nodeKey,
          stageKey: latestRequest.stageKey,
          generationNumber: latestRequest.generation,
          attemptId: latestRequest.attemptId,
          answers: normalizedAnswers,
        });
        let requestId = pendingRequestIdsRef.current.get(responseIdentity);
        if (!requestId) {
          requestId = crypto.randomUUID();
          pendingRequestIdsRef.current.set(responseIdentity, requestId);
        }
        const command: HubPlanCommandInput = {
          hubId,
          planId: latest.id,
          requestId,
          expectedStateVersion: latest.stateVersion,
          expectedRevision: latest.revision,
          action: "respondInput",
          inputRequestId: latestRequest.id,
          answers: normalizedAnswers,
        };

        mutationEpochRef.current += 1;
        const updated = await api.command(command);
        mutationEpochRef.current += 1;
        if (
          generationRef.current !== requestGeneration ||
          hubIdRef.current !== hubId ||
          !connectedRef.current ||
          capabilityRef.current !== "supported"
        ) {
          throw new Error("服务连接已变化，已保留此回复草稿以便核对当前状态。");
        }
        pendingRequestIdsRef.current.delete(responseIdentity);
        const current = stateRef.current;
        const existing = current.plan;
        if (
          current.hubId !== hubId ||
          current.connectionGeneration !== requestGeneration ||
          !current.ready ||
          !existing ||
          existing.id !== currentPlan.id ||
          existing.revision !== currentPlan.revision
        ) {
          // A valid receipt for the submitted plan must not replace a different
          // plan or revision that became current while its command was pending.
          return updated;
        }
        const nextPlan = !snapshotIsNewer(updated, existing) ? existing : updated;
        stateRef.current = { ...current, plan: nextPlan, ready: true, error: null };
        setState(stateRef.current);
        refreshRef.current?.(false);
        return updated;
      } catch (cause) {
        mutationEpochRef.current += 1;
        refreshRef.current?.(true);
        throw new Error(actionError(cause), { cause });
      } finally {
        inFlightRequestKeysRef.current.delete(responseTargetIdentity);
      }
    },
    [capability, connected, generation, input.enabled, input.hubId],
  );

  const stateMatchesConnection =
    state.hubId === input.hubId && state.connectionGeneration === generation;
  const ready = stateMatchesConnection && state.ready;
  return {
    ...state,
    plan: input.enabled && ready ? state.plan : null,
    // Retain old-generation event cards as immutable history during reconnect,
    // but keep their actions disabled until this generation has a full snapshot.
    events: state.hubId === input.hubId ? state.events : [],
    loading: state.loading || (input.enabled && connected && capability === "supported" && !ready),
    error: stateMatchesConnection ? state.error : null,
    connected: connected && capability === "supported" && ready,
    performAction,
    respondInputRequest,
    refresh: refreshNow,
  };
}
