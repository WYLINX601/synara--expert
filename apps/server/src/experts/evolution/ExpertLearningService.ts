import { createHash } from "node:crypto";
import {
  ExpertLearningEvidence,
  ExpertLearningState,
  ThreadId,
  TurnId,
  type SkillEvolutionRequest,
  type SkillEvolutionRun,
} from "@synara/contracts";
import { Effect, Schema } from "effect";
import type { ManagedAttachmentPrincipal } from "../../managedAttachmentPrincipal";
import { withExpertLearningCommit, installExpertLearningReconciler } from "../expertLearningCommit";
import type { ExpertStore } from "../ExpertStore";
import type { ExpertLearningRepositoryShape, LearningCycleRow } from "./ExpertLearningRepository";
import type { createSkillEvolutionService, SkillEvolutionHost } from "./SkillEvolutionService";
import {
  captureLearningBindings,
  decodeLearningState,
  reconcileExplicitLearningEdits,
  saveLearningState,
  type StoredLearningState,
} from "./ExpertLearningState";

const Id = Schema.String.check(Schema.isMaxLength(200));
const Cycle = Schema.Struct({
  cycleId: Id,
  ownerId: Id,
  expertId: Id,
  evidenceId: Id,
  epoch: Schema.Number,
  discoveryId: Id,
  generationId: Schema.optional(Id),
  opportunityId: Schema.optional(Id),
  processed: Schema.Array(Id),
  targets: Schema.Array(Id),
  applied: Schema.Number,
  attempt: Schema.Number,
  failures: Schema.optional(Schema.Number),
  retryAt: Schema.optional(Schema.String),
  status: Schema.Literals([
    "queued",
    "discovery",
    "generation",
    "applied",
    "no_change",
    "failed",
    "cancelled",
  ]),
  updatedAt: Schema.String,
  error: Schema.optional(Schema.String),
});
type Cycle = typeof Cycle.Type;
const active = (cycle: Cycle) => ["queued", "discovery", "generation"].includes(cycle.status);
const busyRun = (run: SkillEvolutionRun) =>
  ["queued", "running", "waiting_authorization", "cancel_requested"].includes(run.status);
const key = (value: string) => "learn_" + createHash("sha256").update(value).digest("hex");
const failure = (error: unknown) =>
  (error instanceof Error ? error.message : "学习暂未完成。").slice(0, 2_000);
const principalFor = (
  ownerId: string,
  ownerKind: StoredLearningState["ownerKind"],
): ManagedAttachmentPrincipal =>
  ownerKind === "local-loopback" && ownerId === "local-loopback"
    ? { ownerKind, ownerId }
    : { ownerKind: "session", ownerId };

/** Business coordination only. Native task execution and cancellation remain owned by the host. */
export function createExpertLearningService(input: {
  readonly stateDir: string;
  readonly repository: ExpertLearningRepositoryShape;
  readonly experts: Pick<ExpertStore, "read">;
  readonly evolution: (
    principal: ManagedAttachmentPrincipal,
  ) => ReturnType<typeof createSkillEvolutionService>;
  readonly host: (principal: ManagedAttachmentPrincipal) => SkillEvolutionHost;
  readonly now?: () => Date;
  readonly pollMs?: number;
  readonly reportError?: (error: unknown) => void;
}) {
  const now = () => (input.now?.() ?? new Date()).toISOString();
  const run = <T>(effect: Effect.Effect<T, unknown>) => Effect.runPromise(effect);
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking: Promise<void> | undefined;
  let uninstall: (() => void) | undefined;
  const readStored = async (ownerId: string, expertId: string) => {
    const row = await run(input.repository.readState(ownerId, expertId));
    return row ? decodeLearningState(row) : undefined;
  };
  const expertFor = async (id: string) => {
    const expert = await input.experts.read(id);
    if (!expert || expert.archived) throw new Error("专家不存在或已归档。");
    return expert;
  };
  const cycles = async (ownerId?: string, expertId?: string, activeOnly = false) =>
    (await run(input.repository.listCycles(ownerId, expertId, activeOnly))).map((row) => {
      const cycle = Schema.decodeUnknownSync(Cycle)(JSON.parse(row.record));
      if (
        cycle.cycleId !== row.cycleId ||
        cycle.ownerId !== row.ownerId ||
        cycle.expertId !== row.expertId
      )
        throw new Error("学习周期身份不符。");
      return cycle;
    });
  const saveCycle = async (cycle: Cycle) => {
    const next = { ...cycle, updatedAt: now() };
    await run(
      input.repository.writeCycle({
        ...next,
        record: JSON.stringify(next),
      } satisfies LearningCycleRow),
    );
    return next;
  };
  const read = async (
    principal: ManagedAttachmentPrincipal,
    expertId: string,
  ): Promise<ExpertLearningState> => {
    await expertFor(expertId);
    const record = await readStored(principal.ownerId, expertId);
    if (!record)
      return {
        expertId,
        enabled: false,
        epoch: 0,
        revision: 0,
        updatedAt: now(),
        status: "disabled",
      };
    if (!record.state.enabled) return { ...record.state, status: "disabled" };
    const current = (await cycles(principal.ownerId, expertId))
      .filter((cycle) => cycle.epoch === record.state.epoch)
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    return {
      ...record.state,
      status:
        current && active(current)
          ? current.status === "queued"
            ? "queued"
            : "learning"
          : current?.status === "failed"
            ? "failed"
            : "idle",
      ...(current?.error ? { summary: current.error } : {}),
    };
  };
  const hasForeground = async (host: SkillEvolutionHost, expertId: string) => {
    for (const thread of await host.readThreads()) {
      if (thread.archivedAt || thread.expertBinding?.expertId !== expertId) continue;
      const state = await (host.readTaskState?.(thread.id) ?? host.readThread(thread.id));
      if (
        state?.session?.activeTurnId ||
        state?.session?.status === "running" ||
        state?.session?.status === "starting"
      )
        return true;
    }
    return false;
  };
  const assertProjectIdentity = async (
    host: SkillEvolutionHost,
    evidence: ExpertLearningEvidence,
  ) => {
    const project = await host.readProjectIdentity?.(evidence.projectId);
    if (
      !project ||
      project.projectId !== evidence.projectId ||
      (project.spaceId ?? undefined) !== evidence.spaceId
    )
      throw new Error("学习来源的 Project/Space 归属已改变或无法确认。");
  };
  const authorize = async (principal: ManagedAttachmentPrincipal, request: SkillEvolutionRun) => {
    const record = await readStored(principal.ownerId, request.expertId);
    if (
      disposed ||
      !record?.state.enabled ||
      record.state.epoch !== request.learningEpoch ||
      !request.cycleId ||
      record.state.harnessKind !== request.modelSelection.provider
    )
      throw new Error("自学习已关闭或授权代次已改变，旧结果不能提交。");
    const cycle = await run(input.repository.readCycle(request.cycleId));
    if (!cycle || cycle.ownerId !== principal.ownerId || cycle.expertId !== request.expertId)
      throw new Error("自动学习周期不属于该专家或用户。");
    const value = Schema.decodeUnknownSync(Cycle)(JSON.parse(cycle.record));
    if (!active(value)) throw new Error("自动学习周期已结束，不能继续采用旧结果。");
    if (value.discoveryId !== request.requestId && value.generationId !== request.requestId)
      throw new Error("该学习生成任务已被替代。");
    const sourceRow = await run(input.repository.readEvidence(value.evidenceId));
    if (!sourceRow) throw new Error("自动学习来源不可用。");
    const evidence = Schema.decodeUnknownSync(ExpertLearningEvidence)(JSON.parse(sourceRow.record));
    const source = await input.host(principal).readThread(ThreadId.makeUnsafe(evidence.threadId));
    await assertProjectIdentity(input.host(principal), evidence);
    if (
      evidence.ownerId !== principal.ownerId ||
      evidence.expertId !== request.expertId ||
      evidence.learningEpoch !== request.learningEpoch ||
      !source ||
      source.archivedAt ||
      source.projectId !== evidence.projectId ||
      source.expertBinding?.expertId !== request.expertId ||
      source.expertBinding.snapshotId !== evidence.snapshotId
    )
      throw new Error("自动学习来源归属已改变。");
    const expert = await expertFor(request.expertId);
    if (expert.preferredProvider && expert.preferredProvider !== record.state.harnessKind)
      throw new Error("专家运行器已改变，原学习任务不能继续。");
    const current = await readStored(principal.ownerId, request.expertId);
    if (
      !current?.state.enabled ||
      current.state.epoch !== request.learningEpoch ||
      current.state.harnessKind !== request.modelSelection.provider
    )
      throw new Error("自学习授权在检查期间已改变。");
  };
  const set = async (
    principal: ManagedAttachmentPrincipal,
    request: Extract<SkillEvolutionRequest, { action: "learningSet" }>,
  ) => {
    const state = await withExpertLearningCommit(
      input.stateDir,
      async () => {
        const expert = await expertFor(request.expertId);
        const old = await readStored(principal.ownerId, expert.id);
        const fingerprint = key(JSON.stringify({ ...request, requestId: undefined }));
        if (old?.lastRequestId === request.requestId) {
          if (old.lastRequestFingerprint !== fingerprint)
            throw new Error("同一设置请求 ID 不能用于不同内容。");
          return old.state;
        }
        if ((old?.state.revision ?? 0) !== request.expectedRevision)
          throw new Error("自学习设置已改变，请重新读取。");
        const owners = (await run(input.repository.listStates())).filter(
          (row) => row.expertId === expert.id && row.ownerId !== principal.ownerId,
        );
        if (owners.length) throw new Error("该专家的学习设置已有其他所有者。");
        const harness = request.enabled
          ? (request.harnessKind ?? expert.preferredProvider ?? old?.state.harnessKind)
          : (old?.state.harnessKind ?? expert.preferredProvider);
        if (
          request.enabled &&
          ((harness !== "omp" && harness !== "pi") ||
            (expert.preferredProvider && expert.preferredProvider !== harness) ||
            (old?.state.enabled && old.state.harnessKind !== harness))
        )
          throw new Error("自学习仅支持该专家明确选择的 OMP 或 Pi，不会自动切换。");
        if (
          expert.skillBindings === undefined &&
          (expert.skills.length || expert.skillSelections?.length)
        )
          throw new Error("自学习需要已保存的技能库绑定，不能将其他技能配置静默转换或清空。");
        const next: StoredLearningState = {
          ownerKind: principal.ownerKind,
          state: {
            expertId: expert.id,
            enabled: request.enabled,
            epoch:
              (old?.state.epoch ?? 0) + (!old || old.state.enabled !== request.enabled ? 1 : 0),
            revision: request.expectedRevision + 1,
            updatedAt: now(),
            ...(harness === "omp" || harness === "pi" ? { harnessKind: harness } : {}),
          },
          lastRequestId: request.requestId,
          lastRequestFingerprint: fingerprint,
          ...(request.enabled
            ? { enabledAt: old?.state.enabled ? (old.enabledAt ?? now()) : now() }
            : {
                frozenBindings:
                  old && !old.state.enabled && old.frozenBindings
                    ? old.frozenBindings
                    : await captureLearningBindings(
                        input.stateDir,
                        expert.skillBindings ?? [],
                        expert.id,
                      ),
              }),
        };
        await saveLearningState(
          input.repository,
          principal.ownerId,
          next,
          request.expectedRevision,
        );
        return next.state;
      },
      {},
      "control",
    );
    void tick().catch(input.reportError ?? (() => {}));
    return state;
  };
  const readRun = async (evolution: ReturnType<typeof createSkillEvolutionService>, id: string) => {
    const response = await evolution.execute({ action: "read", requestId: id });
    if (!response.run) throw new Error("原生学习请求未返回状态。");
    return response.run;
  };
  const cancelCycle = async (cycle: Cycle, principal: ManagedAttachmentPrincipal) => {
    const evolution = input.evolution(principal);
    for (const id of [cycle.discoveryId, cycle.generationId].filter((id): id is string => !!id)) {
      try {
        await evolution.execute({ action: "cancel", requestId: id });
      } catch (error) {
        input.reportError?.(error);
      }
    }
    await saveCycle({ ...cycle, status: "cancelled", error: "该学习授权已结束；不采用迟到结果。" });
  };
  const process = async (
    cycle: Cycle,
    record: StoredLearningState,
    principal: ManagedAttachmentPrincipal,
  ) => {
    const row = await run(input.repository.readEvidence(cycle.evidenceId));
    if (!row) throw new Error("当前任务证据不可用。");
    const evidence = Schema.decodeUnknownSync(ExpertLearningEvidence)(JSON.parse(row.record));
    const expert = await expertFor(cycle.expertId);
    if (
      evidence.ownerId !== principal.ownerId ||
      evidence.expertId !== expert.id ||
      !evidence.completedAt ||
      evidence.modelSelection.provider !== record.state.harnessKind
    )
      throw new Error("学习证据与专家运行器或已结束工作不符。");
    const host = input.host(principal);
    await assertProjectIdentity(host, evidence);
    const source = await host.readThread(ThreadId.makeUnsafe(evidence.threadId));
    if (
      !source ||
      source.archivedAt ||
      source.projectId !== evidence.projectId ||
      source.expertBinding?.expertId !== expert.id ||
      source.expertBinding.snapshotId !== evidence.snapshotId
    )
      throw new Error("来源归属已改变，不将旧经验写入新的工作范围。");
    const evolution = input.evolution(principal);
    if (cycle.status === "queued") {
      if (await hasForeground(host, expert.id)) return;
      await evolution.startAutomatic(
        {
          action: "start",
          requestId: cycle.discoveryId,
          expertId: cycle.expertId,
          sources: [
            {
              threadId: ThreadId.makeUnsafe(evidence.threadId),
              turnId: TurnId.makeUnsafe(evidence.turnId),
            },
          ],
          modelSelection: evidence.modelSelection,
        },
        { cycleId: cycle.cycleId, epoch: cycle.epoch, evidence },
      );
      await saveCycle({ ...cycle, status: "discovery" });
      return;
    }
    const discovery = await readRun(evolution, cycle.discoveryId);
    if (busyRun(discovery)) return;
    if (["no_change", "insufficient_evidence"].includes(discovery.status)) {
      await saveCycle({ ...cycle, status: "no_change" });
      return;
    }
    if (discovery.status !== "opportunity_ready")
      throw new Error(discovery.error ?? "本轮未能完成经验发现。");
    if (cycle.generationId && cycle.opportunityId) {
      const processedOpportunityId = cycle.opportunityId;
      let generation: SkillEvolutionRun;
      try {
        generation = await readRun(evolution, cycle.generationId);
      } catch {
        if (await hasForeground(host, expert.id)) return;
        const opportunity = discovery.opportunities?.find(
          (item) => item.opportunityId === cycle.opportunityId,
        );
        if (!opportunity) throw new Error("学习进化点不可用。");
        const response = await evolution.execute({
          action: "generate",
          requestId: cycle.generationId,
          discoveryRequestId: discovery.requestId,
          opportunityId: opportunity.opportunityId,
          expectedDigest: opportunity.digest,
          ...(cycle.attempt > 0
            ? { feedback: "请根据当前已保存的技能与专家配置重新生成，保留原学习目的。" }
            : {}),
        });
        if (!response.run) throw new Error("生成任务未登记。");
        generation = response.run;
      }
      if (busyRun(generation)) return;
      if (generation.status === "proposal_ready") {
        if (generation.proposals.length !== 1) throw new Error("自动学习收到多个备选，未采用。");
        const proposal = generation.proposals[0]!;
        if (proposal.status !== "applied") {
          const response = await evolution.execute({
            action: "apply",
            requestId: generation.requestId,
            proposalId: proposal.proposalId,
            expectedDigest: proposal.digest,
            operationId: key(generation.requestId + ":apply"),
          });
          if (response.run?.proposals[0]?.status !== "applied")
            throw new Error(response.run?.proposals[0]?.error ?? "修订尚未保存并绑定。");
        }
        cycle = { ...cycle, applied: cycle.applied + 1 };
      } else if (!["no_change", "insufficient_evidence"].includes(generation.status))
        throw new Error(generation.error ?? "本轮未能完成修订。");
      await saveCycle({
        ...cycle,
        status: "discovery",
        processed: [...cycle.processed, processedOpportunityId],
        generationId: undefined,
        opportunityId: undefined,
        attempt: 0,
      });
      return;
    }
    const opportunity = discovery.opportunities?.find(
      (item) => !cycle.processed.includes(item.opportunityId),
    );
    if (!opportunity) {
      await saveCycle({ ...cycle, status: cycle.applied ? "applied" : "no_change" });
      return;
    }
    const target = opportunity.targetSkillId;
    if (
      (target &&
        (cycle.targets.includes(target) ||
          expert.skillBindings?.find((binding) => binding.skillId === target)?.allowEvolution !==
            true)) ||
      opportunity.status !== "suggested"
    ) {
      await saveCycle({ ...cycle, processed: [...cycle.processed, opportunity.opportunityId] });
      return;
    }
    // Register deterministic generation identity before native dispatch. A crash
    // between this write and dispatch resumes the very same request ID.
    await saveCycle({
      ...cycle,
      status: "generation",
      opportunityId: opportunity.opportunityId,
      generationId: key(cycle.cycleId + opportunity.opportunityId + ":0"),
      targets: target ? [...cycle.targets, target] : cycle.targets,
    });
  };
  const tickOnce = async () => {
    if (disposed) return;
    const rows = await run(input.repository.listStates());
    const allCycles = await cycles(undefined, undefined, true);
    for (const cycle of allCycles.filter(active)) {
      const row = rows.find(
        (entry) => entry.ownerId === cycle.ownerId && entry.expertId === cycle.expertId,
      );
      const record = row ? decodeLearningState(row) : undefined;
      const principal = principalFor(cycle.ownerId, record?.ownerKind ?? "session");
      if (!record?.state.enabled || record.state.epoch !== cycle.epoch) {
        await cancelCycle(cycle, principal);
        continue;
      }
      if (cycle.retryAt && Date.parse(cycle.retryAt) > Date.parse(now())) return;
      try {
        await process(cycle, record, principal);
      } catch (error) {
        const evolution = input.evolution(principal);
        const hasIntent = cycle.generationId
          ? await evolution.hasAutomaticIntent(cycle.generationId).catch(() => false)
          : false;
        if (hasIntent && (cycle.failures ?? 0) < 3) {
          await saveCycle({
            ...cycle,
            failures: (cycle.failures ?? 0) + 1,
            retryAt: new Date(Date.parse(now()) + 1_000 * 2 ** (cycle.failures ?? 0)).toISOString(),
            error: failure(error),
          });
        } else if (
          !hasIntent &&
          cycle.generationId &&
          cycle.attempt < 1 &&
          /版本|配置|绑定|revision|changed/iu.test(failure(error))
        ) {
          await saveCycle({
            ...cycle,
            generationId: key(cycle.cycleId + cycle.opportunityId + ":1"),
            attempt: cycle.attempt + 1,
            error: failure(error),
          });
        } else await saveCycle({ ...cycle, status: "failed", error: failure(error) });
      }
      // One host-wide native learning cycle at a time, regardless of owner.
      return;
    }
    for (const row of rows) {
      const record = decodeLearningState(row);
      if (!record.state.enabled) continue;
      const principal = principalFor(row.ownerId, record.ownerKind);
      const expert = await input.experts.read(row.expertId);
      if (
        !expert ||
        expert.archived ||
        (expert.preferredProvider && expert.preferredProvider !== record.state.harnessKind)
      )
        continue;
      if (await hasForeground(input.host(principal), expert.id)) continue;
      const sources = await run(input.repository.listEvidence(row.ownerId, row.expertId));
      for (const source of sources) {
        const evidence = Schema.decodeUnknownSync(ExpertLearningEvidence)(
          JSON.parse(source.record),
        );
        if (
          !evidence.completedAt ||
          !record.enabledAt ||
          evidence.completedAt < record.enabledAt ||
          evidence.modelSelection.provider !== record.state.harnessKind ||
          evidence.learningEpoch !== record.state.epoch
        )
          continue;
        const cycleId = key(row.ownerId + ":" + source.evidenceId + ":" + record.state.epoch);
        if (await run(input.repository.readCycle(cycleId))) continue;
        await saveCycle({
          cycleId,
          ownerId: row.ownerId,
          expertId: row.expertId,
          evidenceId: source.evidenceId,
          epoch: record.state.epoch,
          discoveryId: key(cycleId + ":discovery"),
          processed: [],
          targets: [],
          applied: 0,
          attempt: 0,
          status: "queued",
          updatedAt: now(),
        });
        return;
      }
    }
  };
  function tick() {
    if (ticking) return ticking;
    ticking = tickOnce().finally(() => {
      ticking = undefined;
    });
    return ticking;
  }
  return {
    read,
    set,
    authorize,
    tick,
    start: async () => {
      if (timer || disposed) return;
      uninstall = installExpertLearningReconciler(input.stateDir, (change) =>
        reconcileExplicitLearningEdits({ ...input, ...change }),
      );
      await withExpertLearningCommit(
        input.stateDir,
        () => reconcileExplicitLearningEdits(input),
        {},
        "control",
      );
      await tick();
      timer = setInterval(() => {
        void tick().catch(input.reportError ?? (() => {}));
      }, input.pollMs ?? 2_000);
      timer.unref?.();
    },
    dispose: async () => {
      disposed = true;
      if (timer) clearInterval(timer);
      uninstall?.();
      await ticking;
    },
  };
}
