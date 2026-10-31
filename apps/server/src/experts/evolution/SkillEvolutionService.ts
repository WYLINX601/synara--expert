import { createHash } from "node:crypto";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  CommandId,
  ExpertSkillBinding,
  MessageId,
  SkillDefinition,
  SkillEvolutionDiscoveryResult,
  SkillEvolutionEvent,
  SkillEvolutionOpportunity,
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
  type ExpertLearningEvidence,
} from "@synara/contracts";
import { Effect, Schema } from "effect";
import { expertResourceFiles, type ExpertStore } from "../ExpertStore";
import type { SkillPackageStore } from "../SkillPackageStore";
import { createSkillLibraryStore, readSkillLibraryDefinitions } from "../SkillLibraryStore";
import { retainSkillEvolutionPackages } from "../skillEvolutionPackagePins";
import { decodeStoredExpertSkillBindings } from "../storedExpertSkillBinding.ts";
import { assertSkillScopeForExpert, effectiveSkillScope } from "../skillEvolutionPolicy";
import {
  buildSkillEvolutionDiscoveryPrompt,
  buildSkillEvolutionPrompt,
  evolutionDigest,
  parseSkillEvolutionDiscoveryResult,
  parseSkillEvolutionModelResult,
  validateEvolutionChanges,
  validateEvolutionEvidence,
  type EvolutionSourceMessage,
  type EvolutionRuntimeEvidence,
} from "./SkillEvolutionPrompt";
import { withExpertLearningCommit } from "../expertLearningCommit";
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
  readonly readProjectIdentity?: (
    projectId: string,
  ) => Promise<{ readonly projectId: string; readonly spaceId?: string | null } | undefined>;
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
  readonly opportunityDigest?: string;
  readonly catalogSkillIds?: readonly string[];
  readonly taskThreadId: ThreadId;
  readonly projectId: OrchestrationThread["projectId"];
  readonly run: SkillEvolutionRun;
  readonly expertRevision: number;
  readonly bindings: readonly ExpertSkillBinding[];
  readonly base?: SkillDefinition;
  /** Binding granting permission, retained when an existing private copy is reused. */
  readonly bindingSkillId?: string;
  readonly files: readonly {
    readonly path: string;
    readonly content: string;
    readonly executable?: boolean;
  }[];
  readonly messages: readonly EvolutionSourceMessage[];
  readonly runtimeEvidence?: readonly EvolutionRuntimeEvidence[];
  readonly evidenceCoverage?: readonly string[];
  readonly memoryEnabled?: boolean;
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
  {
    provider: "omp",
    supported: true,
    reason: "原生 ACP 会话已验证无工具、无环境技能及上下文文件。",
  },
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
  /** Trusted host capability; unavailable to public request payloads. */
  readonly authorizeAutomatic?: (
    run: SkillEvolutionRun,
    opportunity?: Pick<SkillEvolutionOpportunity, "targetSkillId" | "memory" | "evidence">,
  ) => Promise<void>;
  readonly readSourceChanges?: (
    evidence: import("@synara/contracts").ExpertLearningEvidence,
  ) => Promise<readonly import("@synara/contracts").LearningChangeSet[]>;
  readonly readMemoryCatalog?: (
    evidence: import("@synara/contracts").ExpertLearningEvidence,
  ) => Promise<readonly import("@synara/contracts").SpaceMemoryEntry[] | undefined>;
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
    return {
      ...value,
      run,
      bindings: decodeStoredExpertSkillBindings(value.bindings),
      ...(value.bindingRestores !== undefined
        ? {
            bindingRestores: value.bindingRestores.map((intent) => ({
              ...intent,
              bindings: decodeStoredExpertSkillBindings(intent.bindings),
            })),
          }
        : {}),
    };
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
  const assertCanImprove = (expert: Awaited<ReturnType<typeof activeExpert>>, skillId: string) => {
    const binding = expert.skillBindings?.find((item) => item.skillId === skillId);
    if (!binding) throw new Error("目标 Skill 已不在该专家的已保存绑定中。");
    if (binding.allowEvolution !== true)
      throw new Error("请先在专家的技能绑定中开启“允许复制并改进”。");
    return binding;
  };
  const assertMutationPermission = async (record: StoredRequest, result?: SkillDefinition) => {
    if (record.run.origin === "automatic") {
      if (!input.authorizeAutomatic) throw new Error("自动学习授权服务不可用。");
      const parent = record.run.discoveryRequestId
        ? await load(record.run.discoveryRequestId)
        : undefined;
      const opportunity = parent?.run.opportunities?.find(
        (item) => item.opportunityId === record.run.opportunityId,
      );
      if (record.run.stage === "generation" && !opportunity)
        throw new Error("自动生成缺少准确的来源进化点。");
      await input.authorizeAutomatic(record.run, opportunity);
    }
    const expert = await activeExpert(record.run.expertId);
    if (record.base) {
      const bindingSkillId = record.bindingSkillId ?? record.base.skillId;
      const targetId = expert.skillBindings?.some((item) => item.skillId === bindingSkillId)
        ? bindingSkillId
        : (result?.skillId ?? bindingSkillId);
      assertCanImprove(expert, targetId);
      assertSkillScopeForExpert(record.base, expert.id);
    }
    if (result) {
      const scope = effectiveSkillScope(result);
      if (scope.kind !== "expert" || scope.expertId !== expert.id)
        throw new Error("专家改进只能保存为本专家的专属 Skill。");
    }
    return expert;
  };
  const opportunityContent = (opportunity: SkillEvolutionOpportunity) => ({
    opportunityId: opportunity.opportunityId,
    requestId: opportunity.requestId,
    expertId: opportunity.expertId,
    name: opportunity.name,
    reason: opportunity.reason,
    outcomes: opportunity.outcomes,
    evidence: opportunity.evidence,
    ...(opportunity.targetSkillId ? { targetSkillId: opportunity.targetSkillId } : {}),
    ...(opportunity.memory ? { memory: opportunity.memory } : {}),
  });
  const opportunityDigest = (opportunity: SkillEvolutionOpportunity) =>
    evolutionDigest(opportunityContent(opportunity));
  const generationChildren = async (
    expertId: string,
    discoveryRequestId: string,
    opportunityId: string,
  ): Promise<StoredRequest[]> => {
    const rows = await runEffect(input.repository.list(expertId));
    const matches: StoredRequest[] = [];
    for (const row of rows) {
      const raw = JSON.parse(row.record) as StoredRequest;
      if (
        raw.ownerId !== input.ownerId ||
        raw.run?.stage !== "generation" ||
        raw.run.discoveryRequestId !== discoveryRequestId ||
        raw.run.opportunityId !== opportunityId
      )
        continue;
      matches.push(await load(row.requestId));
    }
    return matches;
  };
  const assertGenerationParent = async (
    record: StoredRequest,
    requireSuggested: boolean,
  ): Promise<{ parent: StoredRequest; opportunity: SkillEvolutionOpportunity }> => {
    const { discoveryRequestId, opportunityId } = record.run;
    if (
      record.run.stage !== "generation" ||
      !discoveryRequestId ||
      !opportunityId ||
      !record.opportunityDigest
    )
      throw new Error("生成记录缺少其发现机会的固定身份。 ");
    const parent = await load(discoveryRequestId);
    const opportunity = parent.run.opportunities?.find(
      (item) => item.opportunityId === opportunityId,
    );
    if (
      parent.run.stage !== "discovery" ||
      parent.run.expertId !== record.run.expertId ||
      !opportunity ||
      opportunityDigest(opportunity) !== record.opportunityDigest
    )
      throw new Error("生成记录对应的发现机会已改变或不可用。 ");
    if (requireSuggested && opportunity.status !== "suggested")
      throw new Error("该经验机会已关闭，不能继续生成或采用候选。 ");
    return { parent, opportunity };
  };
  const assertLatestGeneration = async (record: StoredRequest) => {
    const { discoveryRequestId, opportunityId } = record.run;
    if (!discoveryRequestId || !opportunityId)
      throw new Error("生成记录缺少其发现机会的固定身份。 ");
    const children = await generationChildren(
      record.run.expertId,
      discoveryRequestId,
      opportunityId,
    );
    const latest = children.toSorted(
      (left, right) =>
        (right.run.generationIndex ?? 0) - (left.run.generationIndex ?? 0) ||
        right.requestId.localeCompare(left.requestId),
    )[0];
    if (!latest || latest.requestId !== record.requestId)
      throw new Error("已有更新的生成候选，请只查看并采用最新一轮。 ");
    if (
      children.some(
        (child) =>
          child.requestId !== record.requestId &&
          child.run.proposals.some((proposal) =>
            ["applied", "saved_unbound", "applying"].includes(proposal.status),
          ),
      )
    )
      throw new Error("该经验机会已有采用中的或已保存的候选。 ");
    return children;
  };
  const assertGenerationCanApply = async (record: StoredRequest) => {
    await assertGenerationParent(record, true);
    await assertLatestGeneration(record);
  };
  const boundSkillCatalog = async (expert: Awaited<ReturnType<typeof activeExpert>>) => {
    const bound = new Set((expert.skillBindings ?? []).map((binding) => binding.skillId as string));
    const response = await input.library.execute({
      action: "list",
      query: { expertIds: [expert.id] },
    });
    return (response.skills ?? [])
      .filter((skill) => bound.has(skill.skillId) && !skill.deleted)
      .filter((skill) => {
        try {
          assertSkillScopeForExpert(skill, expert.id);
          return true;
        } catch {
          return false;
        }
      })
      .map((skill) => ({
        skillId: skill.skillId,
        name: skill.name,
        description: skill.description,
        tags: skill.tags,
      }));
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
  const dispatchTurnCommit = async (record: StoredRequest, repair: boolean) => {
    await assertMutationPermission(record);
    if (record.run.stage === "generation") await assertGenerationCanApply(record);
    await assertMutationPermission(record);
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
  const dispatchTurn = (record: StoredRequest, repair: boolean) =>
    record.run.origin === "automatic"
      ? withExpertLearningCommit(
          input.stateDir,
          () => dispatchTurnCommit(record, repair),
          {},
          "automatic",
        )
      : dispatchTurnCommit(record, repair);
  const dispatchRequestCommit = async (record: StoredRequest) => {
    if (record.run.stage === "generation") await assertGenerationCanApply(record);
    await assertMutationPermission(record);
    let next = await save({ ...record, dispatchAttempts: record.dispatchAttempts + 1 });
    await input.host.dispatch({
      type: "thread.create",
      commandId: CommandId.makeUnsafe(nativeId(record.requestId, "create")),
      threadId: record.taskThreadId,
      projectId: record.projectId,
      title: record.taskTitle,
      ...(record.run.origin === "automatic"
        ? {
            creationSource: "expert_learning" as const,
            ...(record.run.sourceSelections?.[0]
              ? { sourceThreadId: record.run.sourceSelections[0].threadId }
              : {}),
          }
        : {}),
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
  const dispatchRequest = (record: StoredRequest) =>
    record.run.origin === "automatic"
      ? withExpertLearningCommit(
          input.stateDir,
          () => dispatchRequestCommit(record),
          {},
          "automatic",
        )
      : dispatchRequestCommit(record);
  const setDiscoveryResult = async (record: StoredRequest, text: string) => {
    const result: SkillEvolutionDiscoveryResult = parseSkillEvolutionDiscoveryResult(text);
    if (result.action !== "opportunities")
      return updateRun(record, { status: result.action, summary: result.reason });
    const catalogIds = new Set(record.catalogSkillIds ?? []);
    const opportunities: SkillEvolutionOpportunity[] = [];
    const candidates: Array<(typeof result.opportunities)[number]> = [];
    for (const candidate of result.opportunities) {
      const previousIndex =
        record.run.origin === "automatic" && candidate.targetSkillId
          ? candidates.findIndex((item) => item.targetSkillId === candidate.targetSkillId)
          : -1;
      if (previousIndex < 0) {
        candidates.push(candidate);
        continue;
      }
      const previous = candidates[previousIndex]!;
      candidates[previousIndex] = {
        ...previous,
        reason: previous.reason + "\n\n[" + candidate.name + "] " + candidate.reason,
        outcomes: [...new Set([...previous.outcomes, ...candidate.outcomes])],
        evidence: [
          ...new Map(
            [...previous.evidence, ...candidate.evidence].map((item) => [
              evolutionDigest(item),
              item,
            ]),
          ).values(),
        ],
      };
    }
    for (const [index, candidate] of candidates.entries()) {
      if (!candidate.reason.trim() || candidate.outcomes.some((outcome) => !outcome.trim()))
        throw new Error("经验机会的原因和预期结果必须填写具体内容。");
      validateEvolutionEvidence(candidate.evidence, record.messages, record.runtimeEvidence);
      if (candidate.memory && candidate.evidence.length > 5)
        throw new Error("单项记忆最多引用五个准确片段。");
      if (
        candidate.memory &&
        (record.run.origin !== "automatic" || !record.memoryEnabled || candidate.targetSkillId)
      )
        throw new Error("记忆学习只接受宿主自动用途，且不能借它绕过已有 Skill 目标授权。");
      if (candidate.targetSkillId && !catalogIds.has(candidate.targetSkillId))
        throw new Error("经验机会引用了不属于当前专家绑定目录的 Skill，请使用目录中的准确 ID。");
      const content = {
        opportunityId: nativeId(record.requestId, "opportunity-" + index),
        requestId: record.requestId,
        expertId: record.run.expertId,
        name: candidate.name,
        reason: candidate.reason,
        outcomes: candidate.outcomes,
        evidence: candidate.evidence,
        ...(candidate.targetSkillId ? { targetSkillId: candidate.targetSkillId } : {}),
        ...(candidate.memory ? { memory: candidate.memory } : {}),
      };
      const opportunity = {
        ...content,
        digest: evolutionDigest(content),
        status: "suggested" as const,
      };
      opportunities.push(Schema.decodeUnknownSync(SkillEvolutionOpportunity)(opportunity));
    }
    return updateRun(record, {
      status: opportunities.length ? "opportunity_ready" : "no_change",
      summary: opportunities.length
        ? "已发现可复核的经验机会；尚未读取或改变任何 Skill。"
        : "没有发现新的可复用经验。",
      opportunities,
    });
  };
  const setProposals = async (record: StoredRequest, text: string) => {
    const result = parseSkillEvolutionModelResult(text);
    if (result.action !== "proposals")
      return updateRun(record, { status: result.action, summary: result.reason });
    if (record.run.origin === "automatic" && result.proposals.length !== 1)
      throw new Error("自动学习每个进化点只能生成一个确定修订。");
    const proposals: SkillEvolutionProposal[] = [];
    for (const [index, candidate] of result.proposals.entries()) {
      validateEvolutionEvidence(candidate.evidence, record.messages, record.runtimeEvidence);
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
      const action = !record.base
        ? "create"
        : effectiveSkillScope(record.base).kind === "shared"
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
        affectedExpertIds: [record.run.expertId],
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
  const setModelResult = (record: StoredRequest, text: string) =>
    record.run.stage === "discovery"
      ? setDiscoveryResult(record, text)
      : setProposals(record, text);
  const reconcile = async (id: string): Promise<StoredRequest> => {
    let record = await load(id);
    if (record.run.stage === "generation") {
      const { opportunity } = await assertGenerationParent(record, false);
      if (busy.has(record.run.status) || record.intents.length) {
        if (opportunity.status !== "suggested")
          throw new Error("该经验机会已关闭，不能继续恢复其生成任务。 ");
        await assertLatestGeneration(record);
      }
    }
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
      if (
        !intent ||
        !["proposed", "applying", "saved_unbound", "conflict"].includes(proposal.status)
      )
        continue;
      // A durable intent is the user's acknowledgement of this exact digest.
      // Replay the same library operation; never infer approval from model text.
      try {
        await apply({
          action: "apply",
          requestId: id,
          proposalId: proposal.proposalId,
          expectedDigest: intent.digest,
          operationId: intent.operationId,
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
      return await setModelResult(record, response);
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

  const applyCommit = async (request: Extract<SkillEvolutionRequest, { action: "apply" }>) => {
    let record = await load(request.requestId);
    if (record.run.stage === "generation") await assertGenerationCanApply(record);
    let proposal = proposalFor(record, request.proposalId, request.expectedDigest);
    if (proposal.status === "applied") return { run: publicRun(record) };
    if (proposal.status === "rejected") throw new Error("已拒绝的候选不能采用。");
    let intent = record.intents.find((item) => item.proposalId === proposal.proposalId);
    const expert = await assertMutationPermission(record, intent?.result);
    const expectedAction = !record.base
      ? "create"
      : effectiveSkillScope(record.base).kind === "shared"
        ? "derive"
        : "update";
    if (proposal.action !== expectedAction)
      throw new Error("候选的写入目标与当前专属改进规则不符，请重新提炼。");
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
        if (current.revision !== record.base.revision)
          throw new Error("Skill 版本已改变，请重新提炼。");
      }
      intent = {
        proposalId: proposal.proposalId,
        operationId: request.operationId,
        digest: proposal.digest,
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
    const adoptionContext = {
      ...ctx,
      beforeMutation: async () => {
        if (record.run.stage === "generation") await assertGenerationCanApply(record);
        await assertMutationPermission(record, intent?.result);
      },
    };
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
                changes: proposal.changes.filter((file) => file.path !== "SKILL.md"),
              },
              { ...adoptionContext, createForExpertId: expert.id },
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
      await assertMutationPermission(record, result);
      const bindingSkillId = record.bindingSkillId ?? record.base?.skillId;
      const alreadyBound =
        expert.skillBindings?.some((binding) => binding.skillId === result.skillId) &&
        (!bindingSkillId ||
          bindingSkillId === result.skillId ||
          !expert.skillBindings.some((binding) => binding.skillId === bindingSkillId));
      const needsBinding = !alreadyBound && (!bindingSkillId || bindingSkillId !== result.skillId);
      if (needsBinding) {
        proposal = {
          ...proposal,
          status: "saved_unbound",
          resultSkillId: result.skillId,
          resultRevision: result.revision,
        };
        record = await changeProposal(record, proposal);
        const bindings = record.base
          ? record.bindings.map((binding) =>
              binding.skillId === bindingSkillId
                ? { ...binding, skillId: result!.skillId }
                : binding,
            )
          : [
              ...record.bindings,
              {
                skillId: result.skillId,
                enabled: true,
                ...(record.run.origin === "automatic" ? { allowEvolution: true } : {}),
              },
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
          adoptionContext,
        );
        if (
          !bindingResult.bindingResult ||
          !["applied", "unchanged"].includes(bindingResult.bindingResult.status ?? "") ||
          !bindingResult.bindingResult.bindings.some(
            (binding) => binding.skillId === result!.skillId,
          ) ||
          (bindingSkillId &&
            bindingResult.bindingResult.bindings.some(
              (binding) => binding.skillId === bindingSkillId,
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
          ? { derivedFromSkillId: result.derivedFrom?.skillId ?? record.base.skillId }
          : {}),
        scope: effectiveSkillScope(result),
        ...(record.base
          ? {
              previousScope: effectiveSkillScope(record.base),
            }
          : {}),
        affectedExpertIds: [expert.id],
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
      const partial =
        !!intent.result &&
        (!record.base || (record.bindingSkillId ?? record.base.skillId) !== intent.result.skillId);
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
    assertCanImprove(expert, skill.skillId);
    if (effectiveSkillScope(skill).kind !== "expert")
      throw new Error("只能在此处恢复专家专属版本；共享原版由技能库维护。");
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

  const apply = async (request: Extract<SkillEvolutionRequest, { action: "apply" }>) => {
    const record = await load(request.requestId);
    return withExpertLearningCommit(
      input.stateDir,
      () => applyCommit(request),
      {},
      record.run.origin === "automatic" ? "automatic" : "manual",
    );
  };
  const execute = async (
    request: SkillEvolutionRequest,
    automatic?: {
      readonly cycleId: string;
      readonly epoch: number;
      readonly evidence: ExpertLearningEvidence;
    },
  ): Promise<SkillEvolutionResponse> => {
    if (request.action === "capabilities")
      return { capabilities: [...SKILL_EVOLUTION_CAPABILITIES] };
    return serialize(input.stateDir, async () => {
      switch (request.action) {
        case "learningChanges":
        case "learningReadMemory":
        case "learningReadSkillChange":
        case "learningEditMemory":
        case "learningRevert":
          throw new Error("学习记忆操作必须通过宿主共享能力处理。");
        case "learningRead":
        case "learningSet":
          throw new Error("自学习设置由宿主学习服务处理。");
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
          const fingerprint = evolutionDigest({
            ...request,
            requestId: undefined,
            ...(automatic ? { automatic } : {}),
          });
          const previous = await runEffect(input.repository.read(request.requestId));
          if (previous) {
            const record = await load(request.requestId);
            if (record.fingerprint !== fingerprint)
              throw new Error("同一请求 ID 已用于不同的提炼操作。");
            const current = await reconcile(request.requestId);
            if (busy.has(current.run.status)) observe(request.requestId);
            return { run: publicRun(current) };
          }
          if (
            !SKILL_EVOLUTION_CAPABILITIES.some(
              (capability) =>
                capability.provider === request.modelSelection.provider && capability.supported,
            )
          )
            throw new Error("所选 Provider 尚不支持受限的 Skill 提炼，不会自动切换 Provider。");
          const expert = await activeExpert(request.expertId);
          const unique = new Map(
            request.sources.map((selection) => [
              selection.threadId + ":" + selection.turnId,
              selection,
            ]),
          );
          const selected = await Promise.all(
            [...unique.values()].map((selection) => sourceFor(expert.id, selection)),
          );
          if (
            automatic &&
            (automatic.evidence.expertId !== expert.id ||
              automatic.evidence.ownerId !== input.ownerId ||
              !selected.some(
                (source) =>
                  source.source.threadId === automatic.evidence.threadId &&
                  source.source.turnId === automatic.evidence.turnId &&
                  source.source.snapshotId === automatic.evidence.snapshotId &&
                  source.source.projectId === automatic.evidence.projectId,
              ))
          )
            throw new Error("自动学习证据与已完成任务归属不符。");
          const messages: readonly EvolutionSourceMessage[] = automatic
            ? automatic.evidence.items
                .filter((item) => item.kind === "message" && item.role)
                .slice(-6)
                .map((item) => ({
                  threadId: ThreadId.makeUnsafe(automatic.evidence.threadId),
                  messageId: MessageId.makeUnsafe(item.id),
                  role: item.role!,
                  text: item.text.slice(-4_000),
                  ...(item.truncated || item.text.length > 4_000 ? { truncated: true } : {}),
                }))
            : selected.flatMap((source) => source.messages);
          const runtimeEvidence: readonly EvolutionRuntimeEvidence[] = automatic
            ? automatic.evidence.items
                .filter((item) => item.kind !== "message")
                .slice(-20)
                .map((item) => ({
                  threadId: ThreadId.makeUnsafe(automatic.evidence.threadId),
                  eventId: item.sourceEventId ?? item.id,
                  kind: item.kind,
                  text: item.text.slice(0, 1_500),
                  ...(item.toolCallId ? { toolCallId: item.toolCallId } : {}),
                  ...(item.truncated || item.text.length > 1_500 ? { truncated: true } : {}),
                }))
            : [];
          const evidenceCoverage = automatic
            ? [
                ...automatic.evidence.coverage,
                ...(automatic.evidence.items.filter((item) => item.kind === "message").length >
                messages.length
                  ? ["prompt-messages-truncated"]
                  : []),
                ...(automatic.evidence.items.filter((item) => item.kind !== "message").length >
                runtimeEvidence.length
                  ? ["prompt-runtime-items-truncated"]
                  : []),
              ]
            : [];
          const catalog = await boundSkillCatalog(expert);
          const rawMemoryCatalog =
            automatic && input.readMemoryCatalog
              ? await input.readMemoryCatalog(automatic.evidence)
              : undefined;
          if (rawMemoryCatalog && rawMemoryCatalog.length > 12)
            evidenceCoverage.push("prompt-memory-catalog-items-truncated");
          const memoryCatalog = rawMemoryCatalog
            ? rawMemoryCatalog
                .slice(0, 12)
                .map(({ memoryId, revision, kind, key, content, projectBound, scope }) => ({
                  memoryId,
                  revision,
                  kind,
                  key,
                  projectOnly: projectBound ?? (kind !== "rule" || scope.spaceId === null),
                  content: content.slice(0, 2_000),
                  truncated: content.length > 2_000,
                }))
            : undefined;
          const rawHandledSourceChanges =
            automatic && input.readSourceChanges
              ? await input.readSourceChanges(automatic.evidence)
              : undefined;
          const handledSourceChanges = rawHandledSourceChanges
            ?.toSorted((a, b) => Number(b.status === "reverted") - Number(a.status === "reverted"))
            .slice(0, 8)
            .map((change) => ({ ...change, summary: change.summary.slice(0, 500) }));
          if (rawHandledSourceChanges && rawHandledSourceChanges.length > 8)
            evidenceCoverage.push("source-change-receipts-truncated");
          const sourceDigest = evolutionDigest({
            messages,
            focus: request.focus ?? "",
            catalog,
            ...(memoryCatalog ? { memoryCatalog } : {}),
            ...(handledSourceChanges ? { handledSourceChanges } : {}),
            ...(automatic ? { runtimeEvidence, evidenceCoverage } : {}),
          });
          const prompt = buildSkillEvolutionDiscoveryPrompt({
            ...(automatic ? { automatic: true, runtimeEvidence, evidenceCoverage } : {}),
            expert: { name: expert.name, description: expert.description },
            ...(request.focus ? { focus: request.focus } : {}),
            messages,
            catalog,
            ...(memoryCatalog ? { memoryCatalog } : {}),
            ...(handledSourceChanges ? { handledSourceChanges } : {}),
          });
          let record: StoredRequest = {
            requestId: request.requestId,
            ownerId: input.ownerId,
            fingerprint,
            sourceDigest,
            catalogSkillIds: catalog.map((skill) => skill.skillId),
            ...(memoryCatalog ? { memoryEnabled: true } : {}),
            taskThreadId: ThreadId.makeUnsafe(nativeId(request.requestId, "task")),
            projectId: selected[0]!.source.projectId,
            run: {
              requestId: request.requestId,
              expertId: expert.id,
              stage: "discovery",
              ...(automatic
                ? {
                    origin: "automatic" as const,
                    cycleId: automatic.cycleId,
                    learningEpoch: automatic.epoch,
                  }
                : {}),
              sourceSelections: [...unique.values()],
              createdAt: now(),
              updatedAt: now(),
              modelSelection: request.modelSelection,
              sourceCount: selected.length,
              status: "queued",
              proposals: [],
              opportunities: [],
            },
            expertRevision: expert.revision,
            bindings: expert.skillBindings ?? [],
            files: [],
            messages,
            ...(automatic ? { runtimeEvidence, evidenceCoverage } : {}),
            prompt,
            repairCount: 0,
            intents: [],
            taskTitle: "Skill 提炼 · " + expert.name,
            dispatchAccepted: false,
            dispatchAttempts: 0,
          };
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
        case "generate": {
          const fingerprint = evolutionDigest({ ...request, requestId: undefined });
          const previous = await runEffect(input.repository.read(request.requestId));
          if (previous) {
            const existing = await load(request.requestId);
            if (existing.fingerprint !== fingerprint || existing.run.stage !== "generation")
              throw new Error("同一请求 ID 已用于不同的生成操作。");
            const current = await reconcile(request.requestId);
            if (busy.has(current.run.status)) observe(request.requestId);
            return { run: publicRun(current) };
          }

          const parent = await load(request.discoveryRequestId);
          const opportunity = parent.run.opportunities?.find(
            (item) => item.opportunityId === request.opportunityId,
          );
          if (
            parent.run.stage !== "discovery" ||
            !opportunity ||
            opportunity.expertId !== parent.run.expertId ||
            opportunity.digest !== request.expectedDigest ||
            opportunityDigest(opportunity) !== request.expectedDigest
          )
            throw new Error("经验机会已改变，请重新查看后再生成。");
          if (opportunity.status !== "suggested")
            throw new Error("已关闭的经验机会不能生成 Skill。");

          const children = await generationChildren(
            parent.run.expertId,
            parent.requestId,
            opportunity.opportunityId,
          );
          if (
            children.some((child) =>
              child.run.proposals.some((proposal) =>
                ["applied", "saved_unbound"].includes(proposal.status),
              ),
            )
          )
            throw new Error("该经验机会已有采用或已保存的 Skill 候选。");
          const latest = children.toSorted(
            (left, right) =>
              (right.run.generationIndex ?? 0) - (left.run.generationIndex ?? 0) ||
              right.requestId.localeCompare(left.requestId),
          )[0];
          if (
            latest &&
            (busy.has(latest.run.status) ||
              latest.intents.length > 0 ||
              latest.run.proposals.some((proposal) =>
                ["applying", "saved_unbound"].includes(proposal.status),
              ))
          )
            throw new Error("上一轮生成仍在执行或采用中，请等待其结束。");
          const retryAfterFailure =
            latest?.run.status === "failed" || latest?.run.status === "cancelled";
          if (latest && !retryAfterFailure && !request.feedback?.trim())
            throw new Error("再次生成前请提供具体反馈，说明上一轮需要调整的地方。");
          if (!parent.run.sourceSelections)
            throw new Error("发现记录缺少冻结的来源选择，无法继续生成。");

          const expert = await activeExpert(parent.run.expertId);
          let base: SkillDefinition | undefined;
          if (opportunity.targetSkillId) {
            if (!parent.catalogSkillIds?.includes(opportunity.targetSkillId))
              throw new Error("发现机会的目标不属于其冻结的专家技能目录。");
            const boundTargetId = opportunity.targetSkillId;
            assertCanImprove(expert, boundTargetId);
            base = await readSkill(boundTargetId);
            assertSkillScopeForExpert(base, expert.id);
            if (effectiveSkillScope(base).kind === "shared") {
              const copies = (
                (await input.library.execute({ action: "list" })).skills ?? []
              ).filter(
                (skill) =>
                  !skill.deleted &&
                  skill.scope?.kind === "expert" &&
                  skill.scope.expertId === expert.id &&
                  skill.derivedFrom?.skillId === boundTargetId,
              );
              if (copies.length > 1) throw new Error("该来源存在多个专属副本，请先检查技能库。");
              if (copies[0]) base = await readSkill(copies[0].skillId);
            }
            await retainSkillEvolutionPackages(input.stateDir, [base.packageId]);
          }
          const files = base ? await filesFor(base) : [];
          const selectedOpportunity = {
            name: opportunity.name,
            reason: opportunity.reason,
            outcomes: opportunity.outcomes,
            evidence: opportunity.evidence,
          };
          const prompt = buildSkillEvolutionPrompt({
            ...(parent.run.origin === "automatic"
              ? {
                  automatic: true,
                  runtimeEvidence: parent.runtimeEvidence ?? [],
                  evidenceCoverage: parent.evidenceCoverage ?? [],
                }
              : {}),
            expert: { name: expert.name, description: expert.description },
            opportunity: selectedOpportunity,
            ...(request.feedback ? { feedback: request.feedback } : {}),
            messages: parent.messages,
            ...(base
              ? {
                  target: {
                    name: base.name,
                    entryPath: base.entryPath,
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
          const generationIndex =
            Math.max(0, ...children.map((child) => child.run.generationIndex ?? 0)) + 1;
          let record: StoredRequest = {
            requestId: request.requestId,
            ownerId: input.ownerId,
            fingerprint,
            sourceDigest: evolutionDigest({
              parentSourceDigest: parent.sourceDigest,
              opportunityDigest: request.expectedDigest,
              feedback: request.feedback ?? "",
              target: base
                ? { skillId: base.skillId, revision: base.revision, packageId: base.packageId }
                : "new",
              messages: parent.messages,
            }),
            opportunityDigest: request.expectedDigest,
            taskThreadId: ThreadId.makeUnsafe(nativeId(request.requestId, "task")),
            projectId: parent.projectId,
            run: {
              requestId: request.requestId,
              expertId: expert.id,
              stage: "generation",
              ...(parent.run.origin === "automatic"
                ? {
                    origin: "automatic" as const,
                    cycleId: parent.run.cycleId,
                    learningEpoch: parent.run.learningEpoch,
                  }
                : {}),
              discoveryRequestId: parent.requestId,
              opportunityId: opportunity.opportunityId,
              generationIndex,
              ...(request.feedback !== undefined ? { feedback: request.feedback } : {}),
              sourceSelections: parent.run.sourceSelections,
              createdAt: now(),
              updatedAt: now(),
              modelSelection: parent.run.modelSelection,
              sourceCount: parent.run.sourceCount,
              ...(base ? { targetSkillId: base.skillId } : {}),
              status: "queued",
              proposals: [],
            },
            expertRevision: expert.revision,
            bindings: expert.skillBindings ?? [],
            ...(base && opportunity.targetSkillId
              ? { base, bindingSkillId: opportunity.targetSkillId }
              : {}),
            files,
            messages: parent.messages,
            ...(parent.runtimeEvidence ? { runtimeEvidence: parent.runtimeEvidence } : {}),
            ...(parent.evidenceCoverage ? { evidenceCoverage: parent.evidenceCoverage } : {}),
            prompt,
            repairCount: 0,
            intents: [],
            taskTitle: "Skill 经验生成 · " + opportunity.name,
            dispatchAccepted: false,
            dispatchAttempts: 0,
          };
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
        case "dismissOpportunity": {
          const record = await load(request.requestId);
          if (record.run.stage !== "discovery")
            throw new Error("只有发现记录中的经验机会可以关闭。");
          const opportunity = record.run.opportunities?.find(
            (item) => item.opportunityId === request.opportunityId,
          );
          if (
            !opportunity ||
            opportunity.digest !== request.expectedDigest ||
            opportunityDigest(opportunity) !== request.expectedDigest
          )
            throw new Error("经验机会已改变，请重新查看后再关闭。");
          if (opportunity.status === "dismissed") return { run: publicRun(record) };
          const children = await generationChildren(
            record.run.expertId,
            record.requestId,
            opportunity.opportunityId,
          );
          if (
            children.some(
              (child) =>
                busy.has(child.run.status) ||
                child.intents.length > 0 ||
                child.run.proposals.some((proposal) =>
                  ["applying", "saved_unbound", "applied"].includes(proposal.status),
                ),
            )
          )
            throw new Error("该经验机会已有执行中或已采用的生成候选，暂时不能关闭。");
          const opportunities = record.run.opportunities!.map((item) =>
            item.opportunityId === opportunity.opportunityId
              ? { ...item, status: "dismissed" as const }
              : item,
          );
          return { run: publicRun(await updateRun(record, { opportunities })) };
        }
        case "cancel": {
          let record = await load(request.requestId);
          if (record.run.stage === "generation") await assertGenerationParent(record, false);
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
          if (record.run.stage === "generation") await assertGenerationParent(record, true);
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
          if (record.run.stage === "generation") await assertGenerationParent(record, true);
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
            const restoreRecord = { ...origin };
            delete restoreRecord.opportunityDigest;
            delete restoreRecord.catalogSkillIds;
            const restoreRun = { ...origin.run };
            delete restoreRun.origin;
            delete restoreRun.cycleId;
            delete restoreRun.learningEpoch;
            delete restoreRun.stage;
            delete restoreRun.discoveryRequestId;
            delete restoreRun.opportunityId;
            delete restoreRun.generationIndex;
            delete restoreRun.feedback;
            delete restoreRun.sourceSelections;
            delete restoreRun.opportunities;
            await save({
              ...restoreRecord,
              requestId: id,
              fingerprint: evolutionDigest(request),
              taskThreadId: ThreadId.makeUnsafe(nativeId(id, "task")),
              expertRevision: preview.expert.revision,
              bindings: preview.expert.skillBindings ?? [],
              base: preview.skill,
              bindingSkillId: preview.skill.skillId,
              files: preview.current,
              intents: [],
              restoreOfEventId: request.eventId,
              run: {
                ...restoreRun,
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
            throw new Error("同一恢复操作 ID 的目标或版本已改变。");
          return apply({
            action: "apply",
            requestId: id,
            proposalId: record.run.proposals[0]!.proposalId,
            expectedDigest: record.run.proposals[0]!.digest,
            operationId: request.operationId,
          });
        }
      }
    });
  };
  return {
    execute: (request: SkillEvolutionRequest) => execute(request),
    startAutomatic: (
      request: Extract<SkillEvolutionRequest, { action: "start" }>,
      context: { cycleId: string; epoch: number; evidence: ExpertLearningEvidence },
    ) => execute(request, context),
    hasAutomaticIntent: async (requestId: string) => {
      const record = await load(requestId);
      return record.run.origin === "automatic" && record.intents.length > 0;
    },
    dispose: async () => {
      for (const watcher of watchers.values()) watcher.abort();
      watchers.clear();
    },
  };
}
