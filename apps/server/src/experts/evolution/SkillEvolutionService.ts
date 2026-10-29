import { createHash } from "node:crypto";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  CommandId,
  ExpertSkillBinding,
  MessageId,
  SkillDefinition,
  SkillEvolutionEvent,
  SkillEvolutionRun,
  ThreadId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationThread,
  type SkillEvolutionCapability,
  type SkillEvolutionGraph,
  type SkillEvolutionProposal,
  type SkillEvolutionRequest,
  type SkillEvolutionResponse,
  type SkillEvolutionSource,
  type SkillEvolutionSourceSelection,
  type SkillFileChange,
  type TurnId,
} from "@synara/contracts";
import { Effect, Schema } from "effect";
import { expertResourceFiles, type ExpertStore } from "../ExpertStore";
import type { SkillPackageStore } from "../SkillPackageStore";
import { createSkillLibraryStore, readSkillLibraryDefinitions } from "../SkillLibraryStore";
import { retainSkillEvolutionPackages } from "../skillEvolutionPackagePins";
import {
  assertSkillScopeForExpert,
  effectiveSkillEvolutionPolicy,
  effectiveSkillScope,
} from "../skillEvolutionPolicy";
import {
  buildSkillEvolutionPrompt,
  evolutionDigest,
  parseSkillEvolutionModelResult,
  validateEvolutionChanges,
  validateEvolutionEvidence,
  type EvolutionSourceMessage,
} from "./SkillEvolutionPrompt";
import type { SkillEvolutionRepositoryShape } from "./SkillEvolutionRepository";

type Library = ReturnType<typeof createSkillLibraryStore>;
type Turn = {
  readonly turnId: TurnId | null;
  readonly state: string;
  readonly completedAt: string | null;
  readonly pendingMessageId?: MessageId | null;
};
export interface SkillEvolutionHost {
  readonly readThreads: () => Promise<
    readonly Pick<OrchestrationThread, "id" | "expertBinding" | "archivedAt">[]
  >;
  readonly readThread: (id: ThreadId) => Promise<OrchestrationThread | undefined>;
  readonly readTaskState?: (
    id: ThreadId,
  ) => Promise<Pick<OrchestrationThread, "id" | "session" | "latestTurn"> | undefined>;
  readonly readTurns: (id: ThreadId) => Promise<readonly Turn[]>;
  readonly dispatch: (command: OrchestrationCommand) => Promise<unknown>;
}
interface ApplyIntent {
  readonly proposalId: string;
  readonly operationId: string;
  readonly digest: string;
  readonly result?: SkillDefinition;
  readonly approvedProtected?: boolean;
  readonly createdAt?: string;
  readonly appliedAt?: string;
}
interface BindingRestoreIntent {
  readonly operationId: string;
  readonly digest: string;
  readonly expertRevision: number;
  readonly bindings: readonly ExpertSkillBinding[];
  readonly event: SkillEvolutionEvent;
  readonly completed?: boolean;
  readonly appliedAt?: string;
}
interface StoredRequest {
  readonly requestId: string;
  readonly ownerId: string;
  readonly fingerprint: string;
  readonly sourceDigest: string;
  readonly taskThreadId: ThreadId;
  readonly projectId: OrchestrationThread["projectId"];
  readonly run: SkillEvolutionRun;
  readonly expertRevision: number;
  readonly bindings: readonly ExpertSkillBinding[];
  readonly base?: SkillDefinition;
  readonly requestedAction?: "update" | "derive";
  readonly files: readonly {
    readonly path: string;
    readonly content: string;
    readonly executable?: boolean;
  }[];
  readonly messages: readonly EvolutionSourceMessage[];
  readonly prompt: string;
  readonly repairCount: number;
  readonly intents: readonly ApplyIntent[];
  readonly bindingRestores?: readonly BindingRestoreIntent[];
  readonly restoreOfEventId?: string;
  readonly taskTitle: string;
  readonly dispatchAccepted: boolean;
  readonly dispatchAttempts: number;
}
const busy = new Set<SkillEvolutionRun["status"]>([
  "queued",
  "running",
  "waiting_authorization",
  "cancel_requested",
]);
const pending = new Map<string, Promise<unknown>>();
const serialize = <T>(key: string, operation: () => Promise<T>): Promise<T> => {
  const result = (pending.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
  pending.set(key, result);
  void result
    .finally(() => {
      if (pending.get(key) === result) pending.delete(key);
    })
    .catch(() => {});
  return result;
};
const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : "提炼操作失败。");
const nativeId = (requestId: string, kind: string) =>
  "skill-evolution:" + kind + ":" + createHash("sha256").update(requestId).digest("hex");
export const SKILL_EVOLUTION_CAPABILITIES: readonly SkillEvolutionCapability[] = [
  { provider: "pi", supported: true, reason: "无工具、无环境技能及上下文文件的提炼会话。" },
  {
    provider: "claudeAgent",
    supported: true,
    reason: "无工具、无 MCP、无环境技能及记忆的提炼会话。",
  },
  { provider: "codex", supported: false, reason: "尚未验证独立于普通只读模式的无工具提炼约束。" },
  { provider: "omp", supported: false, reason: "尚未验证原生无工具提炼约束。" },
];

export function createSkillEvolutionService(input: {
  readonly stateDir: string;
  readonly ownerId: string;
  readonly repository: SkillEvolutionRepositoryShape;
  readonly experts: Pick<ExpertStore, "read" | "list">;
  readonly library: Library;
  readonly packages: Pick<SkillPackageStore, "read">;
  readonly host: SkillEvolutionHost;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}) {
  const now = () => (input.now?.() ?? new Date()).toISOString();
  const runEffect = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect);
  const ctx = { actor: input.ownerId, retainForEvolution: true } as const;
  const watchers = new Map<string, AbortController>();
  const load = async (id: string): Promise<StoredRequest> => {
    const row = await runEffect(input.repository.read(id));
    if (!row) throw new Error("提炼记录不存在。");
    const value = JSON.parse(row.record) as StoredRequest;
    const run = Schema.decodeUnknownSync(SkillEvolutionRun)(value.run);
    if (
      value.requestId !== row.requestId ||
      run.requestId !== row.requestId ||
      value.ownerId !== input.ownerId ||
      value.taskThreadId !== row.taskThreadId ||
      !Array.isArray(value.messages) ||
      !Array.isArray(value.files) ||
      !Array.isArray(value.intents)
    )
      throw new Error("提炼记录身份无效或不属于当前用户。");
    return { ...value, run };
  };
  const save = async (record: StoredRequest) => {
    await runEffect(
      input.repository.write({
        requestId: record.requestId,
        expertId: record.run.expertId,
        taskThreadId: record.taskThreadId,
        record: JSON.stringify(record),
        updatedAt: record.run.updatedAt,
      }),
    );
    return record;
  };
  const updateRun = async (record: StoredRequest, patch: Partial<SkillEvolutionRun>) => {
    const next = { ...record.run, ...patch };
    if (isDeepStrictEqual(record.run, next)) return record;
    return save({ ...record, run: { ...next, updatedAt: now() } });
  };
  const activeExpert = async (id: string) => {
    const expert = await input.experts.read(id);
    if (!expert || expert.archived) throw new Error("专家不存在或已归档。");
    return expert;
  };
  const readSkill = async (skillId: string) => {
    const response = await input.library.execute({ action: "read", skillId });
    if (!response.skill || response.skill.deleted) throw new Error("Skill 不存在或已删除。");
    return response.skill;
  };
  const filesFor = async (skill: SkillDefinition) => {
    const response = await input.library.execute({ action: "read", skillId: skill.skillId });
    const files: { path: string; content: string; executable?: boolean }[] = [];
    let bytes = 0;
    for (const resource of response.resources ?? []) {
      if (resource.kind !== "file") continue;
      const relative = resource.path.startsWith("content/")
        ? resource.path.slice(8)
        : resource.path;
      const value = await input.library.execute({
        action: "readFile",
        skillId: skill.skillId,
        path: relative,
      });
      if (!value.file) throw new Error("Skill 支持资源不可读。");
      bytes += Buffer.byteLength(value.file.content, "base64");
      if (bytes > 2 * 1024 * 1024 || files.length >= 100)
        throw new Error("目标 Skill 资源过大，请选择范围更小的 Skill。");
      files.push({
        path: relative,
        content: value.file.content,
        ...(resource.executable !== undefined ? { executable: resource.executable } : {}),
      });
    }
    return files;
  };
  const sourceFor = async (expertId: string, selection: SkillEvolutionSourceSelection) => {
    const thread = await input.host.readThread(selection.threadId);
    const extraction = await runEffect(input.repository.execution(selection.threadId));
    if (!thread || thread.archivedAt || extraction || thread.expertBinding?.expertId !== expertId)
      throw new Error("所选来源不属于当前专家或已不可访问。");
    const turns = await input.host.readTurns(selection.threadId);
    const turn = turns.find((entry) => entry.turnId === selection.turnId);
    if (!turn || turn.state !== "completed" || !turn.completedAt)
      throw new Error("只能提炼已正常结束的工作片段。");
    const messages = thread.messages.filter(
      (message) =>
        !message.streaming &&
        (message.turnId === selection.turnId || message.id === turn.pendingMessageId),
    );
    if (!messages.length || !messages.some((message) => message.role === "assistant"))
      throw new Error("来源缺少可读取的完整回复。");
    const source: SkillEvolutionSource = {
      threadId: thread.id,
      turnId: selection.turnId,
      projectId: thread.projectId,
      title: thread.title,
      expertId,
      expertRevision: thread.expertBinding.revision,
      snapshotId: thread.expertBinding.snapshotId,
      completedAt: turn.completedAt,
      messageCount: messages.length,
    };
    return {
      source,
      messages: messages.map(
        (message): EvolutionSourceMessage => ({
          threadId: thread.id,
          messageId: message.id,
          role: message.role,
          text: message.text,
        }),
      ),
    };
  };
  const sources = async (expertId: string): Promise<readonly SkillEvolutionSource[]> => {
    await activeExpert(expertId);
    const rows: SkillEvolutionSource[] = [];
    for (const thread of await input.host.readThreads()) {
      if (thread.archivedAt || thread.expertBinding?.expertId !== expertId) continue;
      if (await runEffect(input.repository.execution(thread.id))) continue;
      const turns = await input.host.readTurns(thread.id);
      for (const turn of turns) {
        if (turn.turnId && turn.state === "completed" && turn.completedAt) {
          try {
            rows.push(
              (await sourceFor(expertId, { threadId: thread.id, turnId: turn.turnId })).source,
            );
          } catch {
            /* Unreadable historical fragments are not selectable evidence. */
          }
        }
      }
    }
    return rows.sort((a, b) => b.completedAt.localeCompare(a.completedAt)).slice(0, 200);
  };
  const dispatchTurn = async (record: StoredRequest, repair: boolean) => {
    await input.host.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.makeUnsafe(nativeId(record.requestId, repair ? "repair" : "turn")),
      threadId: record.taskThreadId,
      message: {
        messageId: MessageId.makeUnsafe(
          nativeId(record.requestId, repair ? "repair-message" : "message"),
        ),
        role: "user",
        text: repair
          ? record.prompt +
            "\nYour previous output failed the result schema or evidence checks. Return ONE corrected JSON object using only SOURCE_DATA."
          : record.prompt,
        attachments: [],
      },
      modelSelection: record.run.modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: record.run.createdAt,
    });
  };
  const dispatchRequest = async (record: StoredRequest) => {
    let next = await save({ ...record, dispatchAttempts: record.dispatchAttempts + 1 });
    await input.host.dispatch({
      type: "thread.create",
      commandId: CommandId.makeUnsafe(nativeId(record.requestId, "create")),
      threadId: record.taskThreadId,
      projectId: record.projectId,
      title: record.taskTitle,
      modelSelection: record.run.modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: record.run.createdAt,
    });
    await dispatchTurn(record, record.repairCount > 0);
    next = await save({
      ...next,
      dispatchAccepted: true,
      run: {
        ...next.run,
        taskThreadId: next.taskThreadId,
        updatedAt: now(),
        error: undefined,
      },
    });
    return next;
  };
  const setProposals = async (record: StoredRequest, text: string) => {
    const result = parseSkillEvolutionModelResult(text);
    if (result.action !== "proposals")
      return updateRun(record, { status: result.action, summary: result.reason });
    const proposals: SkillEvolutionProposal[] = [];
    for (const [index, candidate] of result.proposals.entries()) {
      validateEvolutionEvidence(candidate.evidence, record.messages);
      const changes = validateEvolutionChanges(
        candidate.files.map((file) => ({
          path: file.path,
          ...(file.remove
            ? {}
            : { content: Buffer.from(file.text ?? "", "utf8").toString("base64") }),
          ...(record.files.find((base) => base.path === file.path)?.executable === true
            ? { executable: true }
            : {}),
        })),
        record.base?.entryPath ?? "SKILL.md",
        record.files,
      );
      if (!changes.length) continue;
      const policy = record.base ? effectiveSkillEvolutionPolicy(record.base) : "protected";
      const action = !record.base
        ? "create"
        : (policy === "independent" && record.base.scope?.kind !== "expert") ||
            (policy === "protected" && record.requestedAction === "derive")
          ? "derive"
          : "update";
      const content = {
        proposalId: nativeId(record.requestId, "proposal-" + index),
        requestId: record.requestId,
        expertId: record.run.expertId,
        action,
        name: candidate.name,
        summary: candidate.summary,
        evidence: candidate.evidence,
        ...(record.base
          ? {
              baseSkillId: record.base.skillId,
              baseRevision: record.base.revision,
              basePackageId: record.base.packageId,
            }
          : {}),
        policy,
        affectedExpertIds:
          record.base && action === "update"
            ? await affectedExperts(record.base.skillId)
            : [record.run.expertId],
        changes,
      } as const;
      proposals.push({ ...content, digest: evolutionDigest(content), status: "proposed" });
    }
    return updateRun(record, {
      status: proposals.length ? "proposal_ready" : "no_change",
      summary: proposals.length
        ? "候选已生成，尚未改变正式 Skill 或绑定。"
        : "所选方法已经覆盖，无需产生新版本。",
      proposals,
    });
  };
  const reconcile = async (id: string): Promise<StoredRequest> => {
    let record = await load(id);
    for (const intent of record.bindingRestores ?? []) {
      if (intent.completed) continue;
      try {
        record = await finishBindingRestore(record, intent);
      } catch {
        /* Keep the approved intent and the copy; a conflict never rebases itself. */
      }
    }
    for (const proposal of record.run.proposals) {
      const intent = record.intents.find((item) => item.proposalId === proposal.proposalId);
      if (!intent || !["proposed", "applying", "conflict"].includes(proposal.status)) continue;
      // A durable intent is the user's acknowledgement of this exact digest.
      // Replay the same library operation; never infer approval from model text.
      try {
        await apply({
          action: "apply",
          requestId: id,
          proposalId: proposal.proposalId,
          expectedDigest: intent.digest,
          operationId: intent.operationId,
          ...(intent.approvedProtected ? { approveProtected: true } : {}),
        });
        record = await load(id);
      } catch (cause) {
        record = await changeProposal(record, {
          ...proposal,
          status: "conflict",
          error: errorText(cause),
        });
      }
    }
    if (!busy.has(record.run.status)) return record;
    const thread = await (input.host.readTaskState?.(record.taskThreadId) ??
      input.host.readThread(record.taskThreadId));
    const expectedMessageId = nativeId(id, record.repairCount > 0 ? "repair-message" : "message");
    const turns = thread ? await input.host.readTurns(record.taskThreadId) : [];
    const turn = turns.find((item) => item.pendingMessageId === expectedMessageId);
    if (
      thread?.session?.status === "error" &&
      !thread.session.activeTurnId &&
      (!turn?.turnId || turn.state === "error")
    )
      return updateRun(record, {
        status: record.run.status === "cancel_requested" ? "cancelled" : "failed",
        error:
          thread.session.lastError?.split("\n")[0]?.slice(0, 8_000) ?? "原生提炼任务启动失败。",
      });
    if (turn?.turnId && turn.turnId !== record.run.taskTurnId)
      record = await updateRun(record, { taskTurnId: turn.turnId });
    if (
      record.run.status === "cancel_requested" &&
      (!turn || !["running", "pending"].includes(turn.state)) &&
      !thread?.session?.activeTurnId
    )
      return updateRun(record, { status: "cancelled", summary: "提炼回合已停止，未采用其输出。" });
    if (!turn || turn.state === "running" || turn.state === "pending") {
      const timeout =
        Date.parse(now()) - Date.parse(record.run.createdAt) > (input.timeoutMs ?? 600_000);
      if (timeout && record.run.status !== "cancel_requested") {
        await input.host.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe(nativeId(id, "timeout")),
          threadId: record.taskThreadId,
          ...(turn?.turnId ? { turnId: turn.turnId } : {}),
          requestedBy: "user",
          createdAt: record.run.createdAt,
        });
        return updateRun(record, {
          status: "cancel_requested",
          error: "提炼超时，正在等待原生任务停止。",
        });
      }
      if (!turn && !record.dispatchAccepted && record.run.status !== "cancel_requested") {
        if (record.dispatchAttempts >= 3)
          return updateRun(record, {
            status: "failed",
            error: record.run.error ?? "原生提炼任务未被接受。",
          });
        try {
          return await dispatchRequest(record);
        } catch (cause) {
          record = await load(id);
          return updateRun(record, { status: "queued", error: errorText(cause) });
        }
      }
      return updateRun(record, {
        status:
          record.run.status === "cancel_requested"
            ? "cancel_requested"
            : turn?.state === "running"
              ? "running"
              : "queued",
      });
    }
    if (turn.state === "interrupted")
      return updateRun(record, { status: "cancelled", summary: "提炼任务已停止。" });
    if (turn.state === "error")
      return updateRun(record, {
        status: "failed",
        error: thread?.session?.lastError ?? "提炼任务执行失败。",
      });
    if (record.run.status === "cancel_requested")
      return updateRun(record, {
        status: "cancelled",
        summary: "任务已结束，取消后未采用其输出。",
      });
    if (!turn.turnId)
      return updateRun(record, { status: "failed", error: "提炼回合缺少可核验的执行身份。" });
    const detail = await input.host.readThread(record.taskThreadId);
    const response =
      detail?.messages
        .filter(
          (message) =>
            message.role === "assistant" && message.turnId === turn.turnId && !message.streaming,
        )
        .map((message) => message.text)
        .join("\n") ?? "";
    try {
      return await setProposals(record, response);
    } catch (cause) {
      if (record.repairCount < 1) {
        record = await save({
          ...record,
          repairCount: 1,
          run: {
            ...record.run,
            status: "queued",
            summary: "正在修正候选输出格式。",
            updatedAt: now(),
          },
          dispatchAccepted: false,
          dispatchAttempts: 0,
        });
        try {
          return await dispatchRequest(record);
        } catch (repairCause) {
          record = await load(id);
          return updateRun(record, { status: "queued", error: errorText(repairCause) });
        }
      }
      return updateRun(record, { status: "failed", error: errorText(cause) });
    }
  };
  const observe = (id: string) => {
    if (watchers.has(id)) return;
    const controller = new AbortController();
    watchers.set(id, controller);
    void (async () => {
      try {
        while (!controller.signal.aborted) {
          const record = await serialize(input.stateDir, () => reconcile(id));
          if (!busy.has(record.run.status)) break;
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              controller.signal.removeEventListener("abort", done);
              resolve();
            };
            const timer = setTimeout(done, input.pollMs ?? 1_000);
            timer.unref?.();
            controller.signal.addEventListener("abort", done, { once: true });
          });
        }
      } catch {
        /* The durable request is reconciled again on the next owner read. */
      } finally {
        watchers.delete(id);
      }
    })();
  };
  const publicRun = (record: StoredRequest) =>
    Schema.decodeUnknownSync(SkillEvolutionRun)(record.run);
  const changeProposal = (record: StoredRequest, proposal: SkillEvolutionProposal) => {
    const proposals = record.run.proposals.map((item) =>
      item.proposalId === proposal.proposalId ? proposal : item,
    );
    const applied = proposals.filter((item) => item.status === "applied").length;
    const summary = proposals.some((item) => item.status === "saved_unbound")
      ? "专用 Skill 已保存，尚未完成专家绑定。"
      : proposals.some((item) => item.status === "applying")
        ? "正在采用候选，完成状态以下方收据为准。"
        : applied > 0
          ? `已采用 ${applied} 条候选，从下一次独立运行生效；其他候选状态见下方。`
          : proposals.every((item) => item.status === "rejected")
            ? "已拒绝本次候选，正式 Skill 和绑定未改变。"
            : "候选尚未采用，具体状态和冲突原因见下方。";
    return updateRun(record, { proposals, summary });
  };
  const proposalFor = (record: StoredRequest, proposalId: string, expectedDigest: string) => {
    const proposal = record.run.proposals.find((item) => item.proposalId === proposalId);
    if (!proposal || proposal.digest !== expectedDigest)
      throw new Error("候选内容已改变，请重新查看差异。");
    return proposal;
  };
  const affectedExperts = async (skillId: string) =>
    (await input.experts.list())
      .filter((expert) => expert.skillBindings?.some((binding) => binding.skillId === skillId))
      .map((expert) => expert.id)
      .toSorted();

  const apply = async (request: Extract<SkillEvolutionRequest, { action: "apply" }>) => {
    let record = await load(request.requestId);
    let proposal = proposalFor(record, request.proposalId, request.expectedDigest);
    if (proposal.status === "applied") return { run: publicRun(record) };
    if (proposal.status === "rejected") throw new Error("已拒绝的候选不能采用。");
    if (proposal.policy === "protected" && !request.approveProtected)
      throw new Error("请明确认可本次受保护 Skill 的准确改动。");
    const expert = await activeExpert(record.run.expertId);
    let intent = record.intents.find((item) => item.proposalId === proposal.proposalId);
    if (
      intent &&
      (intent.operationId !== request.operationId || intent.digest !== request.expectedDigest)
    )
      throw new Error("采用操作已固定，请继续原操作或重新生成候选。");
    if (!intent) {
      if (expert.revision !== record.expertRevision)
        throw new Error("专家或绑定已经改变，请重新提炼。");
      if (record.base) {
        const current = await readSkill(record.base.skillId);
        assertSkillScopeForExpert(current, expert.id);
        if (
          current.revision !== record.base.revision ||
          effectiveSkillEvolutionPolicy(current) !== proposal.policy
        )
          throw new Error("Skill 版本或策略已改变，请重新提炼。");
      }
      intent = {
        proposalId: proposal.proposalId,
        operationId: request.operationId,
        digest: proposal.digest,
        ...(request.approveProtected ? { approvedProtected: true } : {}),
        createdAt: now(),
      };
      record = await save({
        ...record,
        intents: [...record.intents, intent],
        run: {
          ...record.run,
          updatedAt: now(),
          proposals: record.run.proposals.map((item) =>
            item.proposalId === proposal.proposalId ? { ...item, status: "applying" } : item,
          ),
        },
      });
    }
    proposal = { ...proposal, status: "applying", error: undefined };
    record = await changeProposal(record, proposal);
    const adoptionContext =
      record.base &&
      proposal.action === "update" &&
      effectiveSkillScope(record.base).kind === "shared"
        ? {
            ...ctx,
            beforeMutation: async () => {
              const affected = await affectedExperts(record.base!.skillId);
              if (
                !proposal.affectedExpertIds ||
                !isDeepStrictEqual(affected, [...proposal.affectedExpertIds].toSorted())
              )
                throw new Error("共享使用方已改变，请重新提炼并核对受影响专家。");
            },
          }
        : ctx;
    try {
      let result = intent.result;
      if (!result) {
        if (proposal.action === "derive" && record.base) {
          result = (
            await input.library.execute(
              {
                action: "derive",
                requestId: "evolution:" + intent.operationId,
                sourceSkillId: record.base.skillId,
                expectedRevision: record.base.revision,
                expertId: expert.id,
                name: proposal.name,
                changes: proposal.changes,
              },
              adoptionContext,
            )
          ).skill;
        } else if (proposal.action === "update" && record.base) {
          result = (
            await input.library.execute(
              {
                action: "save",
                requestId: "evolution:" + intent.operationId,
                skillId: record.base.skillId,
                expectedRevision: record.base.revision,
                name: proposal.name,
                tags: record.base.tags,
                changes: proposal.changes,
              },
              adoptionContext,
            )
          ).skill;
        } else {
          const entry = proposal.changes.find((file) => file.path === "SKILL.md");
          if (!entry?.content) throw new Error("新 Skill 缺少入口。");
          result = (
            await input.library.execute(
              {
                action: "create",
                requestId: "evolution:" + intent.operationId,
                name: proposal.name,
                body: Buffer.from(entry.content, "base64").toString("utf8"),
                tags: [],
                scope: { kind: "expert", expertId: expert.id },
                evolutionPolicy: "protected",
                changes: proposal.changes.filter((file) => file.path !== "SKILL.md"),
              },
              ctx,
            )
          ).skill;
        }
        if (!result) throw new Error("Skill 保存未返回完成收据。");
        intent = { ...intent, result };
        record = await save({
          ...record,
          intents: record.intents.map((item) =>
            item.proposalId === proposal.proposalId ? intent! : item,
          ),
        });
      }
      if (proposal.action !== "update") {
        proposal = {
          ...proposal,
          status: "saved_unbound",
          resultSkillId: result.skillId,
          resultRevision: result.revision,
        };
        record = await changeProposal(record, proposal);
        const bindings = record.base
          ? record.bindings.map((binding) =>
              binding.skillId === record.base!.skillId
                ? { ...binding, skillId: result!.skillId }
                : binding,
            )
          : [
              ...record.bindings,
              { skillId: result.skillId, enabled: true, activation: "on-demand" as const },
            ];
        const bindingResult = await input.library.execute(
          {
            action: "bindings",
            operation: "set",
            expertId: expert.id,
            expectedRevision: record.expertRevision,
            requestId: "evolution-bind:" + intent.operationId,
            bindings,
          },
          ctx,
        );
        if (
          !bindingResult.bindingResult ||
          !["applied", "unchanged"].includes(bindingResult.bindingResult.status ?? "") ||
          !bindingResult.bindingResult.bindings.some(
            (binding) => binding.skillId === result!.skillId,
          ) ||
          (record.base &&
            bindingResult.bindingResult.bindings.some(
              (binding) => binding.skillId === record.base!.skillId,
            ))
        )
          throw new Error(
            bindingResult.bindingResult?.error ?? "专用 Skill 已保存，但专家绑定未完成。",
          );
      }
      if (!intent.appliedAt) {
        intent = { ...intent, appliedAt: now() };
        record = await save({
          ...record,
          intents: record.intents.map((item) =>
            item.proposalId === proposal.proposalId ? intent! : item,
          ),
        });
      }
      const event: SkillEvolutionEvent = {
        eventId: nativeId(intent.operationId, "event"),
        operationId: intent.operationId,
        requestId: record.requestId,
        expertId: expert.id,
        skillId: result.skillId,
        name: result.name,
        kind: record.restoreOfEventId
          ? "restored"
          : proposal.action === "create"
            ? "created"
            : proposal.action === "derive"
              ? "derived"
              : "updated",
        createdAt: intent.appliedAt!,
        revision: result.revision,
        packageId: result.packageId,
        ...(record.base
          ? { previousRevision: record.base.revision, previousPackageId: record.base.packageId }
          : {}),
        ...(proposal.action === "derive" && record.base
          ? { derivedFromSkillId: record.base.skillId }
          : {}),
        policy: effectiveSkillEvolutionPolicy(result),
        scope: effectiveSkillScope(result),
        ...(record.base
          ? {
              previousPolicy: effectiveSkillEvolutionPolicy(record.base),
              previousScope: effectiveSkillScope(record.base),
            }
          : {}),
        affectedExpertIds: proposal.affectedExpertIds ?? (await affectedExperts(result.skillId)),
      };
      await runEffect(input.repository.appendEvent(event));
      record = await changeProposal(record, {
        ...proposal,
        status: "applied",
        resultSkillId: result.skillId,
        resultRevision: result.revision,
        error: undefined,
      });
      return { run: publicRun(record), skill: result };
    } catch (cause) {
      const partial = !!intent.result && proposal.action !== "update";
      record = await changeProposal(record, {
        ...proposal,
        status: partial ? "saved_unbound" : "conflict",
        error: errorText(cause),
      });
      return { run: publicRun(record) };
    }
  };

  const graph = async (expertId: string, at?: string): Promise<SkillEvolutionGraph> => {
    const expert = await input.experts.read(expertId);
    if (!expert) throw new Error("专家不存在。");
    const allEvents = await runEffect(input.repository.events());
    const definitions = await readSkillLibraryDefinitions(input.stateDir);
    const ids = new Set((expert.skillBindings ?? []).map((binding) => binding.skillId as string));
    allEvents
      .filter((event) => event.expertId === expertId || event.affectedExpertIds.includes(expertId))
      .forEach((event) => {
        ids.add(event.skillId);
        if (event.derivedFromSkillId) ids.add(event.derivedFromSkillId);
      });
    const events = allEvents.filter(
      (event) =>
        ids.has(event.skillId) &&
        (event.expertId === expertId || event.affectedExpertIds.includes(expertId)),
    );
    const nodes: SkillEvolutionGraph["nodes"][number][] = [];
    for (const skillId of ids) {
      const history = events.filter((event) => event.skillId === skillId);
      const skill = definitions.find((item) => item.skillId === skillId);
      if (!skill && !history.length) continue;
      const scope = skill ? effectiveSkillScope(skill) : history.at(-1)?.scope;
      if (scope?.kind === "expert" && scope.expertId !== expertId) continue;
      const creation = history.find(
        (event) => event.kind === "created" || event.kind === "derived",
      );
      if (at && creation && creation.createdAt > at) continue;
      const last = history.filter((event) => !at || event.createdAt <= at).at(-1);
      const first = history[0];
      const nodeScope = at ? (last?.scope ?? first?.previousScope ?? scope) : scope;
      const packageId = at
        ? (last?.packageId ?? first?.previousPackageId ?? skill?.packageId)
        : (skill?.packageId ?? last?.packageId);
      if (!packageId) continue;
      nodes.push({
        skillId: last?.skillId ?? skill!.skillId,
        name: last?.name ?? skill?.name ?? first!.name,
        revision:
          (at ? (last?.revision ?? first?.previousRevision) : skill?.revision) ??
          last?.revision ??
          first!.revision,
        packageId,
        policy:
          (at ? (last?.policy ?? first?.previousPolicy) : undefined) ??
          (skill ? effectiveSkillEvolutionPolicy(skill) : (last?.policy ?? "protected")),
        ...(nodeScope?.kind === "expert" ? { ownerExpertId: nodeScope.expertId } : {}),
        timestamp: creation?.createdAt ?? null,
        baseline: !creation,
        ...((skill?.derivedFrom?.skillId ?? creation?.derivedFromSkillId)
          ? {
              derivedFromSkillId: skill?.derivedFrom?.skillId ?? creation!.derivedFromSkillId,
            }
          : {}),
        ...(!skill || skill.deleted ? { deleted: true } : {}),
      });
    }
    return { nodes, events: events.filter((event) => !at || event.createdAt <= at) };
  };
  const restorePreview = async (eventId: string, expertId: string) => {
    const expert = await activeExpert(expertId);
    const event = (await runEffect(input.repository.events())).find(
      (item) => item.eventId === eventId,
    );
    if (!event) throw new Error("进化版本记录不存在。");
    const skill = await readSkill(event.skillId);
    assertSkillScopeForExpert(skill, expert.id);
    if (!expert.skillBindings?.some((binding) => binding.skillId === skill.skillId))
      throw new Error("该 Skill 已不在当前专家的绑定中。");
    const current = await filesFor(skill);
    const oldPackage = await input.packages.read(event.packageId);
    const oldFiles: SkillFileChange[] = [];
    for (const resource of oldPackage.resources) {
      if (resource.kind !== "file") continue;
      const relative = resource.path.startsWith("content/")
        ? resource.path.slice(8)
        : resource.path;
      const bytes = await expertResourceFiles.read(
        path.join(
          input.stateDir,
          "experts",
          "skill-packages",
          event.packageId,
          "content",
          ...relative.split("/"),
        ),
      );
      const old: SkillFileChange = {
        path: relative,
        content: bytes.toString("base64"),
        ...(resource.executable !== undefined ? { executable: resource.executable } : {}),
      };
      const present = current.find((file) => file.path === relative);
      if (!present || present.content !== old.content || present.executable !== old.executable)
        oldFiles.push(old);
    }
    for (const file of current)
      if (
        !oldPackage.resources.some(
          (resource) =>
            resource.kind === "file" && resource.path.replace(/^content\//u, "") === file.path,
        )
      )
        oldFiles.push({ path: file.path });
    if (JSON.stringify(oldFiles).length > 900_000)
      throw new Error("该历史版本体积过大，无法在提炼面板恢复，请使用现有技能文件管理。");
    return { event, skill, current, changes: oldFiles, expert };
  };

  const bindingRestorePreview = async (eventId: string, expertId: string) => {
    const event = (await runEffect(input.repository.events())).find(
      (entry) => entry.eventId === eventId,
    );
    if (
      !event ||
      event.kind !== "derived" ||
      event.expertId !== expertId ||
      !event.derivedFromSkillId
    )
      throw new Error("只有本专家的首次独立派生可以恢复原绑定。");
    const record = await load(event.requestId);
    if (
      !record.run.proposals.some(
        (proposal) =>
          proposal.status === "applied" &&
          proposal.action === "derive" &&
          proposal.resultSkillId === event.skillId,
      )
    )
      throw new Error("无法核验首次派生的绑定来源。");
    const expert = await activeExpert(expertId);
    const fromSkill = await readSkill(event.skillId);
    const toSkill = await readSkill(event.derivedFromSkillId);
    assertSkillScopeForExpert(fromSkill, expertId);
    assertSkillScopeForExpert(toSkill, expertId);
    const before = expert.skillBindings ?? [];
    if (
      !before.some((binding) => binding.skillId === fromSkill.skillId) ||
      before.some((binding) => binding.skillId === toSkill.skillId)
    )
      throw new Error("当前绑定已改变，不能重复恢复或覆盖已有来源绑定。");
    const after = before.map((binding) =>
      binding.skillId === fromSkill.skillId ? { ...binding, skillId: toSkill.skillId } : binding,
    );
    const preview = {
      eventId,
      expertId,
      expertRevision: expert.revision,
      fromSkill,
      toSkill,
      before,
      after,
    };
    return { record, preview: { ...preview, digest: evolutionDigest(preview) } };
  };
  const finishBindingRestore = async (record: StoredRequest, original: BindingRestoreIntent) => {
    let intent = original;
    await activeExpert(record.run.expertId);
    const result = await input.library.execute(
      {
        action: "bindings",
        operation: "set",
        expertId: record.run.expertId,
        expectedRevision: intent.expertRevision,
        requestId: "evolution-restore-binding:" + intent.operationId,
        bindings: intent.bindings,
      },
      ctx,
    );
    if (
      !result.bindingResult ||
      !["applied", "unchanged"].includes(result.bindingResult.status ?? "") ||
      !isDeepStrictEqual(result.bindingResult.bindings, intent.bindings)
    )
      throw new Error(result.bindingResult?.error ?? "原绑定尚未恢复；已保留专用副本。");
    if (!intent.appliedAt) {
      const appliedAt = now();
      intent = { ...intent, appliedAt, event: { ...intent.event, createdAt: appliedAt } };
      record = await save({
        ...record,
        bindingRestores: (record.bindingRestores ?? []).map((item) =>
          item.operationId === intent.operationId ? intent : item,
        ),
      });
    }
    await runEffect(input.repository.appendEvent(intent.event));
    return save({
      ...record,
      bindingRestores: (record.bindingRestores ?? []).map((item) =>
        item.operationId === intent.operationId ? { ...item, completed: true } : item,
      ),
    });
  };

  const execute = async (request: SkillEvolutionRequest): Promise<SkillEvolutionResponse> => {
    if (request.action === "capabilities")
      return { capabilities: [...SKILL_EVOLUTION_CAPABILITIES] };
    return serialize(input.stateDir, async () => {
      switch (request.action) {
        case "sources":
          return { sources: await sources(request.expertId) };
        case "list": {
          const rows = await runEffect(input.repository.list(request.expertId));
          const runs: SkillEvolutionRun[] = [];
          for (const row of rows) {
            if ((JSON.parse(row.record) as StoredRequest).ownerId !== input.ownerId) continue;
            const record = await reconcile(row.requestId);
            runs.push(publicRun(record));
            if (busy.has(record.run.status)) observe(row.requestId);
          }
          return { runs };
        }
        case "read": {
          const record = await reconcile(request.requestId);
          if (busy.has(record.run.status)) observe(request.requestId);
          return { run: publicRun(record) };
        }
        case "start": {
          const fingerprint = evolutionDigest({ ...request, requestId: undefined });
          const previous = await runEffect(input.repository.read(request.requestId));
          if (previous) {
            const record = await load(request.requestId);
            if (record.fingerprint !== fingerprint)
              throw new Error("同一请求 ID 已用于不同的提炼操作。");
            if (busy.has(record.run.status)) observe(request.requestId);
            return { run: publicRun(record) };
          }
          if (
            !SKILL_EVOLUTION_CAPABILITIES.some(
              (capability) =>
                capability.provider === request.modelSelection.provider && capability.supported,
            )
          )
            throw new Error("所选 Provider 尚不支持受限的 Skill 提炼，不会自动切换 Provider。");
          const expert = await activeExpert(request.expertId);
          if (
            expert.skillBindings === undefined &&
            (expert.skills.length || expert.skillSelections?.length)
          )
            throw new Error("请先在专家能力页完成原装配转换，再提炼或绑定新 Skill。");
          const unique = new Map(
            request.sources.map((selection) => [
              selection.threadId + ":" + selection.turnId,
              selection,
            ]),
          );
          const selected = await Promise.all(
            [...unique.values()].map((selection) => sourceFor(expert.id, selection)),
          );
          const messages = selected.flatMap((source) => source.messages);
          const base = request.targetSkillId ? await readSkill(request.targetSkillId) : undefined;
          if (base) {
            assertSkillScopeForExpert(base, expert.id);
            if (!expert.skillBindings?.some((binding) => binding.skillId === base.skillId))
              throw new Error("目标 Skill 已不在该专家的已保存绑定中。");
            if (
              effectiveSkillEvolutionPolicy(base) === "independent" &&
              base.scope?.kind !== "expert"
            ) {
              const copies = (await input.library.execute({ action: "list" })).skills ?? [];
              if (
                copies.some(
                  (skill) =>
                    !skill.deleted &&
                    skill.scope?.kind === "expert" &&
                    skill.scope.expertId === expert.id &&
                    skill.derivedFrom?.skillId === base.skillId,
                )
              )
                throw new Error(
                  "该来源已有当前专家的专用副本，请选择该副本，或继续原候选的绑定操作。",
                );
            }
            await retainSkillEvolutionPackages(input.stateDir, [base.packageId]);
          }
          const files = base ? await filesFor(base) : [];
          const sourceDigest = evolutionDigest({
            messages,
            focus: request.focus ?? "",
            target: base?.derivedFrom?.skillId ?? base?.skillId ?? "new",
          });
          const prompt = buildSkillEvolutionPrompt({
            expert: { name: expert.name, description: expert.description },
            ...(request.focus ? { focus: request.focus } : {}),
            messages,
            ...(base
              ? {
                  target: {
                    name: base.name,
                    entryPath: base.entryPath,
                    policy: effectiveSkillEvolutionPolicy(base),
                    files: files.map((file) => {
                      const bytes = Buffer.from(file.content, "base64");
                      const text = bytes.toString("utf8");
                      return {
                        path: file.path,
                        ...(Buffer.from(text, "utf8").equals(bytes) ? { text } : {}),
                      };
                    }),
                  },
                }
              : {}),
          });
          let record: StoredRequest = {
            requestId: request.requestId,
            ownerId: input.ownerId,
            fingerprint,
            sourceDigest,
            taskThreadId: ThreadId.makeUnsafe(nativeId(request.requestId, "task")),
            projectId: selected[0]!.source.projectId,
            run: {
              requestId: request.requestId,
              expertId: expert.id,
              createdAt: now(),
              updatedAt: now(),
              modelSelection: request.modelSelection,
              sourceCount: selected.length,
              ...(base ? { targetSkillId: base.skillId } : {}),
              status: "queued",
              proposals: [],
            },
            expertRevision: expert.revision,
            bindings: expert.skillBindings ?? [],
            ...(base ? { base } : {}),
            ...(request.protectedAction ? { requestedAction: request.protectedAction } : {}),
            files,
            messages,
            prompt,
            repairCount: 0,
            intents: [],
            taskTitle: "Skill 提炼 · " + expert.name,
            dispatchAccepted: false,
            dispatchAttempts: 0,
          };
          const old = await runEffect(input.repository.list(expert.id));
          if (
            old.some((row) => {
              const value = JSON.parse(row.record) as StoredRequest;
              return (
                value.sourceDigest === sourceDigest &&
                value.run.proposals.some((proposal) => proposal.status === "applied")
              );
            })
          ) {
            record = await save({
              ...record,
              run: {
                ...record.run,
                status: "no_change",
                summary: "相同来源与提炼重点已有采用记录，无需重复提炼。",
              },
            });
            return { run: publicRun(record) };
          }
          record = await save(record);
          try {
            record = await dispatchRequest(record);
            observe(record.requestId);
          } catch (cause) {
            record = await load(record.requestId);
            record = await updateRun(record, { status: "queued", error: errorText(cause) });
            observe(record.requestId);
          }
          return { run: publicRun(record) };
        }
        case "cancel": {
          let record = await load(request.requestId);
          if (!busy.has(record.run.status)) return { run: publicRun(record) };
          const thread = await input.host.readThread(record.taskThreadId);
          await input.host.dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.makeUnsafe(nativeId(record.requestId, "cancel")),
            threadId: record.taskThreadId,
            ...(thread?.latestTurn?.turnId ? { turnId: thread.latestTurn.turnId } : {}),
            requestedBy: "user",
            createdAt: record.run.createdAt,
          });
          record = await updateRun(record, { status: "cancel_requested" });
          observe(record.requestId);
          return { run: publicRun(record) };
        }
        case "apply":
          return apply(request);
        case "reject": {
          const record = await load(request.requestId);
          const proposal = proposalFor(record, request.proposalId, request.expectedDigest);
          if (
            proposal.status !== "proposed" ||
            record.intents.some((intent) => intent.proposalId === proposal.proposalId)
          )
            throw new Error("只能拒绝尚未开始采用的候选。");
          return {
            run: publicRun(await changeProposal(record, { ...proposal, status: "rejected" })),
          };
        }
        case "edit": {
          const record = await load(request.requestId);
          const proposal = proposalFor(record, request.proposalId, request.expectedDigest);
          if (
            proposal.status !== "proposed" ||
            record.intents.some((intent) => intent.proposalId === proposal.proposalId)
          )
            throw new Error("只能编辑尚未采用的候选。");
          const changes = validateEvolutionChanges(
            request.changes,
            record.base?.entryPath ?? "SKILL.md",
            record.files,
          );
          if (!changes.length) throw new Error("候选没有实际内容变化。");
          const content = { ...proposal, name: request.name, changes, digest: undefined };
          return {
            run: publicRun(
              await changeProposal(record, { ...content, digest: evolutionDigest(content) }),
            ),
          };
        }
        case "graph":
          return { graph: await graph(request.expertId, request.at) };
        case "previewBindingRestore":
          return {
            bindingRestorePreview: (await bindingRestorePreview(request.eventId, request.expertId))
              .preview,
          };
        case "restoreBinding": {
          const event = (await runEffect(input.repository.events())).find(
            (entry) => entry.eventId === request.eventId,
          );
          if (!event || event.expertId !== request.expertId)
            throw new Error("首次派生记录不属于当前专家。");
          let record = await load(event.requestId);
          let intent = record.bindingRestores?.find(
            (item) => item.operationId === request.operationId,
          );
          if (
            intent &&
            (intent.digest !== request.expectedDigest ||
              intent.event.previousSkillId !== event.skillId)
          )
            throw new Error("同一恢复操作不能用于不同的绑定变化。");
          if (!intent) {
            const { preview } = await bindingRestorePreview(request.eventId, request.expertId);
            if (preview.digest !== request.expectedDigest)
              throw new Error("绑定或 Skill 已改变，请重新预览。");
            intent = {
              operationId: request.operationId,
              digest: request.expectedDigest,
              expertRevision: preview.expertRevision,
              bindings: preview.after,
              event: {
                eventId: nativeId(request.operationId, "binding-event"),
                operationId: request.operationId,
                requestId: record.requestId,
                expertId: request.expertId,
                skillId: preview.toSkill.skillId,
                name: preview.toSkill.name,
                kind: "binding_restored",
                createdAt: now(),
                revision: preview.toSkill.revision,
                packageId: preview.toSkill.packageId,
                previousSkillId: preview.fromSkill.skillId,
                policy: effectiveSkillEvolutionPolicy(preview.toSkill),
                scope: effectiveSkillScope(preview.toSkill),
                affectedExpertIds: [request.expertId],
              },
            };
            await retainSkillEvolutionPackages(input.stateDir, [
              preview.fromSkill.packageId,
              preview.toSkill.packageId,
            ]);
            record = await save({
              ...record,
              bindingRestores: [...(record.bindingRestores ?? []), intent],
            });
          }
          if (!intent.completed) record = await finishBindingRestore(record, intent);
          return { run: publicRun(record), skill: await readSkill(intent.event.skillId) };
        }
        case "previewRestore": {
          const preview = await restorePreview(request.eventId, request.expertId);
          return {
            restorePreview: {
              eventId: request.eventId,
              skill: preview.skill,
              changes: preview.changes,
              affectedExpertIds: await affectedExperts(preview.skill.skillId),
            },
          };
        }
        case "restore": {
          const id = "restore:" + request.operationId;
          let saved = await runEffect(input.repository.read(id));
          if (!saved) {
            const preview = await restorePreview(request.eventId, request.expertId);
            if (preview.skill.revision !== request.expectedRevision)
              throw new Error("Skill 已改变，请重新预览恢复差异。");
            const affectedExpertIds = await affectedExperts(preview.skill.skillId);
            if (
              effectiveSkillScope(preview.skill).kind === "shared" &&
              (!request.expectedAffectedExpertIds ||
                !isDeepStrictEqual(
                  affectedExpertIds,
                  [...request.expectedAffectedExpertIds].toSorted(),
                ))
            )
              throw new Error("共享使用方已改变，请重新预览恢复影响。");
            if (!preview.changes.length) return { skill: preview.skill };
            const origin = await load(preview.event.requestId);
            const content = {
              proposalId: nativeId(id, "proposal"),
              requestId: id,
              expertId: request.expertId,
              action: "update" as const,
              name: preview.skill.name,
              summary: "恢复到修订 " + preview.event.revision,
              evidence: origin.run.proposals.flatMap((proposal) => proposal.evidence).slice(0, 20),
              baseSkillId: preview.skill.skillId,
              baseRevision: preview.skill.revision,
              basePackageId: preview.skill.packageId,
              policy: effectiveSkillEvolutionPolicy(preview.skill),
              affectedExpertIds,
              changes: preview.changes,
            };
            const proposal: SkillEvolutionProposal = {
              ...content,
              digest: evolutionDigest(content),
              status: "proposed",
            };
            await retainSkillEvolutionPackages(input.stateDir, [
              preview.skill.packageId,
              preview.event.packageId,
            ]);
            await save({
              ...origin,
              requestId: id,
              fingerprint: evolutionDigest(request),
              taskThreadId: ThreadId.makeUnsafe(nativeId(id, "task")),
              expertRevision: preview.expert.revision,
              bindings: preview.expert.skillBindings ?? [],
              base: preview.skill,
              files: preview.current,
              intents: [],
              restoreOfEventId: request.eventId,
              run: {
                ...origin.run,
                requestId: id,
                expertId: request.expertId,
                taskThreadId: undefined,
                taskTurnId: undefined,
                createdAt: now(),
                updatedAt: now(),
                targetSkillId: preview.skill.skillId,
                sourceCount: origin.run.sourceCount,
                status: "proposal_ready",
                proposals: [proposal],
              },
            });
            saved = await runEffect(input.repository.read(id));
          }
          const record = await load(id);
          if (record.fingerprint !== evolutionDigest(request))
            throw new Error("同一恢复操作 ID 的目标、版本或认可已改变。");
          return apply({
            action: "apply",
            requestId: id,
            proposalId: record.run.proposals[0]!.proposalId,
            expectedDigest: record.run.proposals[0]!.digest,
            operationId: request.operationId,
            ...(request.approveProtected !== undefined
              ? { approveProtected: request.approveProtected }
              : {}),
          });
        }
      }
    });
  };
  return {
    execute,
    dispose: async () => {
      for (const watcher of watchers.values()) watcher.abort();
      watchers.clear();
    },
  };
}
