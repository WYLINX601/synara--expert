import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  LearningCommitInput,
  LearningReadInput,
  LearningSkillEditBaseline,
  LearningRevertInput,
  ExpertLearningEvidence,
  ProjectId,
  ThreadId,
  type LearningChangeSet,
  type LearningChangeReference,
  type LearningSkillChangeDetail,
  type LearningSourceReference,
  type MemoryScope,
  type SpaceMemoryEntry,
  type SpaceMemoryRevisionRef,
  type OrchestrationThread,
  type LearningSourceSelection,
  type SkillPackage,
} from "@synara/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import { stableJsonStringify } from "@synara/shared/browserAutomationCatalogue";
import { ServerConfig } from "../../config";
import type { ManagedAttachmentPrincipal } from "../../managedAttachmentPrincipal";
import { resolveAttachmentRelativePath } from "../../attachmentPaths";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns";
import { ExpertAppliedRuntimeRepository } from "../../persistence/Services/ExpertAppliedRuntimeRecords";
import {
  ProviderRuntimeEventRepository,
  PROVIDER_RUNTIME_INGESTION_CONSUMER,
} from "../../persistence/Services/ProviderRuntimeEvents";
import { ManagedAttachmentRepository } from "../../persistence/Services/ManagedAttachments";
import { WorkspaceFileSystem } from "../../workspace/Services/WorkspaceFileSystem";
import { SpaceMemoryService } from "../../spaceMemory/SpaceMemoryService";
import { ExpertLearningRepository } from "../../experts/evolution/ExpertLearningRepository";
import {
  decodeLearningState,
  writeLearningState,
} from "../../experts/evolution/ExpertLearningState";
import {
  ExpertLearningActions,
  type LearningActionContext,
  type LearningActionResult,
  type ExpertLearningActionsShape,
} from "../../experts/evolution/ExpertLearningActions";
import {
  createPreparedSkillChanges,
  type PreparedSkillChangeRecord,
  type PreparedSkillChangeIntent,
  type PreparedSkillRevertResult,
} from "../../experts/evolution/PreparedSkillChanges";
import {
  createLearningSourceFreezer,
  LEARNING_SOURCE_RUNTIME_EVENT_LIMIT,
  LEARNING_SOURCE_TOTAL_BYTE_LIMIT,
  LEARNING_SOURCE_DOCUMENT_BYTE_LIMIT,
  LEARNING_SOURCE_TOTAL_CHARACTER_LIMIT,
  type LearningSourceRuntimeReadRequest,
  type LearningSourceAcceptedRuntimeEvent,
} from "../../experts/evolution/LearningSources";
import {
  managedLearningAttachmentReader,
  workspaceLearningDocumentReader,
  toAcceptedLearningSourceRows,
} from "./learningSourceReaders";
import { WorkbenchExpertRuntime } from "../runtimeLayer";
import { withExpertLearningCommit } from "../../experts/expertLearningCommit";
import { handledLearningSignal } from "../../experts/evolution/LearningSignals";
import { expertResourceFiles } from "../../experts/ExpertStore";

const MAX_SKILL_CHANGE_FILES = 100;
const MAX_SKILL_CHANGE_TEXT_UNITS = 128_000;
const MAX_SKILL_CHANGE_CONTENT_BYTES = 1_000_000;
type SkillPackageFileResource = SkillPackage["resources"][number];

function packageFileResources(pkg: SkillPackage | null): Map<string, SkillPackageFileResource> {
  const files = new Map<string, SkillPackageFileResource>();
  for (const resource of pkg?.resources ?? []) {
    if (resource.kind !== "file") continue;
    if (!resource.path.startsWith("content/"))
      throw new Error("历史 Skill 包含无效的文件资源路径。");
    const relative = resource.path.slice("content/".length);
    if (
      !relative ||
      relative.length > 4_096 ||
      relative.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
      relative.includes("\\")
    )
      throw new Error("历史 Skill 包含无效的文件资源路径。");
    if (files.has(relative)) throw new Error("历史 Skill 包含重复的文件资源路径。");
    files.set(relative, resource);
  }
  return files;
}

function exactSkillPackageId(reference: LearningChangeReference | null | undefined): string | null {
  if (reference === null) return null;
  if (!reference || reference.assetKind !== "skill" || !reference.packageId)
    throw new Error("Skill 变化缺少准确的历史包引用。");
  return reference.packageId;
}

function samePackageFile(
  left: SkillPackageFileResource | undefined,
  right: SkillPackageFileResource | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.size === right.size &&
    left.sha256 === right.sha256 &&
    (left.executable ?? false) === (right.executable ?? false)
  );
}

function sameLearningAssetIdentity(
  left: LearningChangeReference | null | undefined,
  right: LearningChangeReference | null | undefined,
): boolean {
  if (!left || !right || left.assetKind !== right.assetKind) return false;
  if (left.assetKind === "memory")
    return right.assetKind === "memory" && left.memoryId === right.memoryId;
  if (left.assetKind === "skill")
    return right.assetKind === "skill" && left.skillId === right.skillId;
  return false;
}

const hash = (value: unknown) =>
  `sha256:${createHash("sha256")
    .update(stableJsonStringify(JSON.parse(JSON.stringify(value))))
    .digest("hex")}`;

/** Shared owner RPC, foreground Gateway and background mutation capability. */
export const makeExpertLearningActions = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const memory = yield* SpaceMemoryService;
  const states = yield* ExpertLearningRepository;
  const projection = yield* ProjectionSnapshotQuery;
  const turns = yield* ProjectionTurnRepository;
  const applied = yield* ExpertAppliedRuntimeRepository;
  const events = yield* ProviderRuntimeEventRepository;
  const attachments = yield* ManagedAttachmentRepository;
  const workspace = yield* WorkspaceFileSystem;
  const runtime = yield* WorkbenchExpertRuntime;
  const skills = createPreparedSkillChanges({
    stateDir: config.stateDir,
    experts: runtime.experts,
    library: runtime.skillLibrary,
    packages: runtime.skillPackages,
  });
  const run = <A>(effect: Effect.Effect<A, unknown>, signal?: AbortSignal) =>
    Effect.runPromise(effect, signal ? { signal } : undefined);
  const projectPublicChange = async (
    ownerId: string,
    expertId: string,
    change: LearningChangeSet,
    signal?: AbortSignal,
  ): Promise<LearningChangeSet> => {
    const {
      data,
      operationRef: _operationRef,
      revertsChangeId: _storedRevertsChangeId,
      ...visible
    } = change;
    const reverts = data?.reverts;
    const revertedChangeId = data?.revertedChangeId;
    const candidateIds = [reverts, revertedChangeId].filter((value) => value !== undefined);
    const candidateId =
      candidateIds.length > 0 &&
      candidateIds.every(
        (value) => typeof value === "string" && value.length > 0 && value.length <= 200,
      ) &&
      candidateIds.every((value) => value === candidateIds[0])
        ? (candidateIds[0] as string)
        : undefined;
    if (
      !candidateId ||
      change.ownerId !== ownerId ||
      change.expertId !== expertId ||
      change.sourceScope.ownerId !== ownerId ||
      change.sourceScope.expertId !== expertId ||
      (change.status !== "committed" && change.status !== "reverted")
    )
      return visible;

    const original = await run(memory.getChange(ownerId, candidateId), signal);
    if (
      original &&
      original.ownerId === ownerId &&
      original.expertId === expertId &&
      original.sourceScope.ownerId === ownerId &&
      original.sourceScope.expertId === expertId &&
      original.sourceScope.projectId === change.sourceScope.projectId &&
      original.sourceScope.spaceId === change.sourceScope.spaceId &&
      change.assetKind === original.assetKind &&
      sameLearningAssetIdentity(change.before, original.after) &&
      original.changeId !== change.changeId &&
      (original.status === "committed" || original.status === "reverted")
    )
      return { ...visible, revertsChangeId: original.changeId };
    return visible;
  };
  const projectPublicResult = async (
    ownerId: string,
    expertId: string,
    result: LearningActionResult,
    signal?: AbortSignal,
  ): Promise<LearningActionResult> => ({
    ...result,
    ...(result.changeSet
      ? { changeSet: await projectPublicChange(ownerId, expertId, result.changeSet, signal) }
      : {}),
  });
  const threadFor = async (threadId: string) =>
    Option.getOrUndefined(
      await run(projection.getThreadDetailForExportById(ThreadId.makeUnsafe(threadId))),
    );

  const assertScope = async (scope: MemoryScope, threadId: string, snapshotId: string) => {
    const thread = await threadFor(threadId);
    const project = Option.getOrUndefined(
      await run(projection.getProjectShellById(ProjectId.makeUnsafe(scope.projectId))),
    );
    if (
      !thread ||
      thread.archivedAt ||
      !project ||
      thread.projectId !== scope.projectId ||
      (project.spaceId ?? null) !== scope.spaceId ||
      thread.expertBinding?.expertId !== scope.expertId ||
      thread.expertBinding.snapshotId !== snapshotId
    )
      throw new Error("学习来源归属已经改变。");
    const expert = await runtime.experts.read(scope.expertId);
    if (!expert || expert.archived) throw new Error("专家不存在或已归档。");
    const owner = await run(states.readState(scope.ownerId, scope.expertId));
    if (!owner) throw new Error("学习来源所有者无法确认。");
    return { thread, expert, state: decodeLearningState(owner) };
  };
  const authorize = async (
    context: LearningActionContext,
    write: boolean,
    signal?: AbortSignal,
  ) => {
    if (signal?.aborted) throw new Error("学习请求已取消。");
    await run(context.assertActive(), signal);
    const { session } = context;
    const current = await assertScope(session.scope, context.threadId, session.snapshotId);
    const manifest = await run(memory.readManifest(session.scope, session.manifestId), signal);
    if (
      manifest.hash !== session.knowledgeHash ||
      manifest.rootRunId !== session.rootRunId ||
      manifest.snapshotId !== session.snapshotId ||
      manifest.learningEpoch !== session.learningEpoch
    )
      throw new Error("学习工具的固定运行身份不匹配。");
    const native = Option.getOrUndefined(
      await run(applied.getByThreadId({ threadId: ThreadId.makeUnsafe(context.threadId) }), signal),
    );
    if (
      !native ||
      native.snapshotId !== session.snapshotId ||
      native.provider !== context.provider ||
      native.skillApplication?.skillRootRunId !== session.rootRunId ||
      native.skillApplication.skillAssemblyId !== manifest.skillAssemblyId
    )
      throw new Error("学习工具不属于当前原生运行。");
    if (
      write &&
      (session.learningEpoch === undefined ||
        !current.state.state.enabled ||
        current.state.state.epoch !== session.learningEpoch ||
        current.state.state.harnessKind !== context.provider ||
        (current.expert.preferredProvider && current.expert.preferredProvider !== context.provider))
    )
      throw new Error("自学习已关闭或原授权代次已结束。");
    return { ...current, manifest };
  };

  const principalFor = (
    context: LearningActionContext,
    ownerKind: string,
  ): ManagedAttachmentPrincipal =>
    ownerKind === "local-loopback" && context.session.scope.ownerId === "local-loopback"
      ? { ownerKind: "local-loopback", ownerId: "local-loopback" }
      : { ownerKind: "session", ownerId: context.session.scope.ownerId };

  const runtimeSourceReader =
    (
      context: LearningActionContext,
      principal: ManagedAttachmentPrincipal,
      thread: OrchestrationThread,
      currentUserMessageId: string | undefined,
      signal?: AbortSignal,
    ) =>
    async (request: LearningSourceRuntimeReadRequest) => {
      if (request.threadId !== context.threadId || request.turnId !== context.turnId) return [];
      const accepted = await run(
        events.getConsumerCursor(PROVIDER_RUNTIME_INGESTION_CONSUMER),
        signal,
      );
      const rows = await run(
        events.readThreadEvents({
          threadId: context.threadId,
          turnId: context.turnId,
          throughSequenceInclusive: accepted,
          limit: request.maxEvents,
          maxBytes: request.maxBytes,
          ...(request.eventIds ? { eventIds: request.eventIds } : {}),
        }),
        signal,
      );
      const project = Option.getOrUndefined(
        await run(
          projection.getProjectShellById(ProjectId.makeUnsafe(context.session.scope.projectId)),
          signal,
        ),
      );
      if (!project || (project.spaceId ?? null) !== context.session.scope.spaceId)
        throw new Error("资料来源范围已经改变。");
      const attachmentSources: Array<{
        attachmentId: string;
        messageId: string;
        absolutePath: string;
      }> = [];
      const messages = thread.messages.filter(
        (message) => message.turnId === context.turnId || message.id === currentUserMessageId,
      );
      for (const message of messages)
        for (const attachment of message.attachments ?? []) {
          if (attachmentSources.length >= 128) break;
          if (request.attachmentIds && !request.attachmentIds.includes(attachment.id)) continue;
          const blob = Option.getOrUndefined(
            await run(attachments.findClaimedById({ attachmentId: attachment.id }), signal),
          );
          if (
            !blob ||
            blob.state !== "claimed" ||
            blob.ownerThreadId !== context.threadId ||
            blob.claimMessageId !== message.id ||
            blob.ownerKind !== principal.ownerKind ||
            blob.ownerId !== principal.ownerId
          )
            continue;
          const absolutePath = resolveAttachmentRelativePath({
            attachmentsDir: config.attachmentsDir,
            relativePath: blob.relativePath,
          });
          if (absolutePath)
            attachmentSources.push({
              attachmentId: attachment.id,
              messageId: message.id,
              absolutePath,
            });
        }
      return toAcceptedLearningSourceRows(rows, {
        rootRunId: context.session.rootRunId,
        threadId: context.threadId,
        turnId: context.turnId,
        roots: [thread.worktreePath ?? project.workspaceRoot, ...(project.additionalFolders ?? [])],
        attachments: attachmentSources,
      });
    };

  const frozenOverride = (scope: MemoryScope, entry: SpaceMemoryEntry) =>
    Effect.gen(function* () {
      if (entry.kind !== "rule") return;
      const row = yield* states.readState(scope.ownerId, scope.expertId);
      if (!row) throw new Error("固定规则的学习状态不可用。");
      const old = decodeLearningState(row);
      if (old.state.enabled) return;
      const ref: SpaceMemoryRevisionRef = {
        memoryId: entry.memoryId,
        revision: entry.revision,
        contentHash: entry.contentHash,
      };
      const overrides = [
        ...(old.ruleOverrides ?? []).filter((x) => x.memoryId !== entry.memoryId),
        ref,
      ];
      if (overrides.length > 256) throw new Error("固定规则覆盖项超过容量上限。");
      yield* writeLearningState(
        states,
        scope.ownerId,
        {
          ...old,
          ruleOverrides: overrides,
          state: {
            ...old.state,
            revision: old.state.revision + 1,
            updatedAt: new Date().toISOString(),
          },
        },
        old.state.revision,
      );
    });

  const memoryCommit = async (
    scope: MemoryScope,
    draft: typeof import("@synara/contracts").LearningMemoryDraft.Type,
    sources: readonly LearningSourceReference[],
    requestId: string,
    fingerprint: string,
    signal?: AbortSignal,
  ): Promise<LearningActionResult> => {
    const prior = await run(memory.readChange(scope.ownerId, scope.expertId, requestId), signal);
    if (prior) {
      if (prior.requestFingerprint !== fingerprint)
        throw new Error("同一学习请求不能用于不同内容。");
      if (prior.status === "committed" || prior.status === "reverted")
        return {
          status: prior.status === "reverted" ? "unchanged" : "committed",
          changeSet: prior,
        };
    }
    const entries = await run(
      memory.readApplicable({ scope, kinds: [draft.kind], includeShadowed: true }),
      signal,
    );
    const projectBound =
      draft.kind !== "rule" || scope.spaceId === null || draft.projectOnly === true;
    const existing = draft.memoryId
      ? entries.find((x) => x.memoryId === draft.memoryId)
      : entries.find(
          (x) =>
            x.key === draft.key &&
            (x.projectBound ?? (x.kind !== "rule" || x.scope.spaceId === null)) === projectBound,
        );
    if (!draft.memoryId && existing)
      throw new Error("该记忆主题已经存在，请使用准确条目和修订版本更新。");
    if (draft.memoryId && (!existing || draft.expectedRevision === undefined))
      throw new Error("更新记忆必须提供可读目标及准确基线。");
    if (existing && existing.key !== draft.key) throw new Error("记忆主题身份不能通过改名替换。");
    const validUntil = draft.validUntil ?? existing?.validUntil;
    const validUntilEpoch = validUntil === undefined ? undefined : Date.parse(validUntil);
    const sameExpiry =
      existing?.validUntil === validUntil ||
      (existing?.validUntil !== undefined &&
        validUntilEpoch !== undefined &&
        Number.isFinite(validUntilEpoch) &&
        Date.parse(existing.validUntil) === validUntilEpoch);
    if (existing && existing.content === draft.content && sameExpiry) {
      const priorChange = await run(memory.getChange(scope.ownerId, existing.changeId), signal);
      return { status: "unchanged", ...(priorChange ? { changeSet: priorChange } : {}) };
    }
    const result = await run(
      memory.commit({
        scope,
        ...(draft.memoryId ? { memoryId: draft.memoryId } : {}),
        expectedRevision: draft.expectedRevision ?? 0,
        kind: draft.kind,
        key: draft.key,
        content: draft.content,
        ...(draft.memoryId && draft.projectOnly === undefined ? {} : { projectBound }),
        sources,
        requestId,
        requestFingerprint: fingerprint,
        observedAt: new Date().toISOString(),
        ...(validUntil ? { validUntil } : {}),
      }),
      signal,
    );
    return { status: "committed", changeSet: result.changeSet };
  };

  const revertChange = async (
    ownerId: string,
    expertId: string,
    input: LearningRevertInput,
    check: () => Promise<void>,
    signal?: AbortSignal,
    scope?: MemoryScope,
  ): Promise<LearningActionResult> => {
    const change = await run(memory.getChange(ownerId, input.changeId), signal);
    if (!change || change.expertId !== expertId) throw new Error("学习变化不属于当前专家。");
    await check();
    if (scope && change.assetKind === "memory") {
      const ref = change.after?.assetKind === "memory" ? change.after : change.before;
      if (!ref || ref.assetKind !== "memory") throw new Error("记忆变化缺少可核对的范围引用。");
      // Agent authority follows the entry's formal applicability. Shared rules
      // may cross Projects within their Space; local rules and facts may not.
      await run(memory.readRevision(scope, ref.memoryId, ref.revision), signal);
    }
    if (change.status === "reverted") return { status: "unchanged", changeSet: change };
    if (change.assetKind === "memory") {
      return await run(
        memory.withTransaction(
          Effect.gen(function* () {
            const result = yield* memory.revert({
              ownerId,
              changeId: change.changeId,
              requestId: input.requestId,
              requestFingerprint: hash(input),
              ...(input.expectedRevision !== undefined
                ? { expectedRevision: input.expectedRevision }
                : {}),
            });
            yield* memory.completeChange({
              ownerId,
              changeId: change.changeId,
              status: "reverted",
            });
            yield* frozenOverride(change.sourceScope, result.entry);
            return { status: "committed" as const, changeSet: result.changeSet };
          }),
        ),
        signal,
      );
    }
    const prepared = change.data?.prepared as PreparedSkillChangeRecord | undefined;
    if (!prepared || prepared.expertId !== expertId || prepared.status !== "committed")
      throw new Error("Skill 变化缺少准确的已提交记录。");
    const fingerprint = hash({ action: "revert", changeId: change.changeId, input });
    const prior = await run(memory.readChange(ownerId, expertId, input.requestId), signal);
    if (prior?.requestFingerprint !== undefined && prior.requestFingerprint !== fingerprint)
      throw new Error("撤回请求内容已改变。");
    if (prior?.status === "committed") {
      await run(
        memory.markReverted({ ownerId, changeId: change.changeId, revertChangeId: prior.changeId }),
        signal,
      );
      return { status: "committed", changeSet: prior };
    }
    const receipt =
      prior ??
      (await run(
        memory.prepareChange({
          ownerId,
          expertId,
          requestId: input.requestId,
          requestFingerprint: fingerprint,
          assetKind: "skill",
          sourceScope: change.sourceScope,
          sourceRefs: change.sourceRefs,
          summary: `撤回：${change.summary}`,
          data: { reverts: change.changeId },
        }),
        signal,
      ));
    let inverseIntent = receipt.operationRef as unknown as PreparedSkillChangeIntent | undefined;
    const result = await skills.revert(
      {
        operationId: receipt.changeId,
        ...(prior?.data?.result
          ? {
              resumeResult: prior.data.result as Exclude<
                PreparedSkillRevertResult,
                { status: "conflict" }
              >,
            }
          : {}),
        ...(receipt.operationRef
          ? { resumeIntent: receipt.operationRef as unknown as PreparedSkillChangeIntent }
          : {}),
      },
      prepared,
      {
        actor: ownerId,
        retainForEvolution: true,
        beforeMutation: check,
        onPrepared: async (intent) => {
          await run(
            memory.stageChange({
              ownerId,
              changeId: receipt.changeId,
              requestFingerprint: receipt.requestFingerprint,
              operationRef: intent as unknown as Record<string, unknown>,
            }),
            signal,
          );
          inverseIntent = intent;
        },
      },
    );
    if (result.status === "conflict")
      throw new Error(`该变化与后续修改冲突：${result.conflicts.map((x) => x.reason).join("；")}`);
    const currentBefore =
      inverseIntent?.kind === "revert" ? inverseIntent.currentBefore : undefined;
    if (!currentBefore?.skill || !currentBefore.packageId)
      throw new Error("撤回缺少准确的修改前快照。");
    const after = result.skill
      ? {
          assetKind: "skill" as const,
          skillId: result.skill.skillId,
          revision: result.skill.revision,
          packageId: result.packageId,
          expertRevision: result.expertRevision,
        }
      : null;
    const saved = await run(
      memory.withTransaction(
        Effect.gen(function* () {
          const saved = yield* memory.completeChange({
            ownerId,
            changeId: receipt.changeId,
            status: result.status,
            before: {
              assetKind: "skill",
              skillId: currentBefore.skill!.skillId,
              revision: currentBefore.skill!.revision,
              packageId: currentBefore.packageId!,
              expertRevision: currentBefore.expertRevision,
            },
            after,
            data: { reverts: change.changeId, result },
          });
          if (result.status === "committed")
            yield* memory.markReverted({
              ownerId,
              changeId: change.changeId,
              revertChangeId: saved.changeId,
            });
          return saved;
        }),
      ),
      signal,
    );
    return { status: result.status, changeSet: saved };
  };

  const commit: ExpertLearningActionsShape["commit"] = (context, raw) =>
    Effect.tryPromise({
      try: async (signal) => {
        const input = Schema.decodeUnknownSync(LearningCommitInput)(raw);
        const current = await authorize(context, true, signal);
        const rows = await run(
          turns.listByThreadId({ threadId: ThreadId.makeUnsafe(context.threadId) }),
          signal,
        );
        const userMessageId = rows.find((x) => x.turnId === context.turnId)?.pendingMessageId;
        if (!userMessageId)
          return { status: "deferred" as const, coverage: ["accepted-user-message-unavailable"] };
        const principal = principalFor(context, current.state.ownerKind);
        const freezer = createLearningSourceFreezer({
          readThread: threadFor,
          readCurrentProject: async ({ projectId }) => {
            const p = Option.getOrUndefined(
              await run(projection.getProjectShellById(ProjectId.makeUnsafe(projectId)), signal),
            );
            return p
              ? {
                  projectId: p.id,
                  roots: [
                    current.thread.worktreePath ?? p.workspaceRoot,
                    ...(p.additionalFolders ?? []),
                  ].map((canonicalPath) => ({
                    canonicalPath,
                  })),
                }
              : undefined;
          },
          readRuntimeEvents: runtimeSourceReader(
            context,
            principal,
            current.thread,
            userMessageId,
            signal,
          ),
          readDocument: workspaceLearningDocumentReader((request) =>
            run(workspace.readFile(request), signal),
          ),
          readAttachment: managedLearningAttachmentReader({
            attachmentsDir: config.attachmentsDir,
            principal,
            findClaimedById: async (attachmentId) =>
              Option.getOrUndefined(
                await run(attachments.findClaimedById({ attachmentId }), signal),
              ),
          }),
        });
        const frozen = await freezer.freeze(
          {
            scope: context.session.scope,
            threadId: context.threadId,
            turnId: context.turnId,
            currentUserMessageId: userMessageId,
          },
          input.sources,
        );
        const partialCoverage = new Set([
          "source-reference-limit-truncated",
          "runtime-source-event-limit-truncated",
          "message-source-truncated",
          "runtime-source-evidence-truncated",
          "source-text-truncated",
          "source-sensitive-content-redacted",
        ]);
        if (!frozen.refs.length || frozen.coverage.some((x) => !partialCoverage.has(x)))
          return {
            status: "deferred" as const,
            coverage: frozen.coverage.length ? frozen.coverage : ["source-unavailable"],
          };
        if (frozen.refs.some((ref) => ref.kind !== "owner" && !ref.fragmentHash))
          return { status: "deferred" as const, coverage: ["source-fragment-required"] };
        return await withExpertLearningCommit(
          config.stateDir,
          async () => {
            const check = () => authorize(context, true, signal).then(() => {});
            await check();
            const fingerprint = hash({
              manifestId: context.session.manifestId,
              input,
              sources: frozen.refs,
            });
            if (input.change.assetKind === "memory")
              return memoryCommit(
                context.session.scope,
                input.change,
                frozen.refs,
                input.requestId,
                fingerprint,
                signal,
              );
            const draft = input.change;
            const before = await runtime.experts.read(context.session.scope.expertId);
            if (!before) throw new Error("专家不可用。");
            if (!draft.targetSkillId) {
              for (const binding of before.skillBindings ?? []) {
                const item = await runtime.skillLibrary.execute({
                  action: "read",
                  skillId: binding.skillId,
                });
                if (
                  item.skill?.name.normalize("NFKC").toLowerCase() ===
                  draft.name.normalize("NFKC").toLowerCase()
                )
                  throw new Error("已有同名技能，请更新准确绑定，不能创建副本绕过权限。");
              }
            }
            const prior = await run(
              memory.readChange(context.session.scope.ownerId, before.id, input.requestId),
              signal,
            );
            if (prior && prior.requestFingerprint !== fingerprint)
              throw new Error("学习请求内容已改变。");
            if (prior?.status === "committed")
              return { status: "committed" as const, changeSet: prior };
            if (prior?.status === "reverted")
              return { status: "unchanged" as const, changeSet: prior };
            const receipt =
              prior ??
              (await run(
                memory.prepareChange({
                  ownerId: context.session.scope.ownerId,
                  expertId: before.id,
                  sourceScope: context.session.scope,
                  assetKind: "skill",
                  requestId: input.requestId,
                  requestFingerprint: fingerprint,
                  sourceRefs: frozen.refs,
                  summary: `已更新方法：${draft.name}`,
                }),
                signal,
              ));
            const record = await skills.commit(
              {
                operationId: receipt.changeId,
                expertId: before.id,
                expectedExpertRevision: draft.expectedExpertRevision,
                ...(draft.targetSkillId ? { targetSkillId: draft.targetSkillId } : {}),
                ...(draft.expectedSkillRevision !== undefined
                  ? { expectedSkillRevision: draft.expectedSkillRevision }
                  : {}),
                ...(draft.basePackageId ? { basePackageId: draft.basePackageId } : {}),
                name: draft.name,
                ...(draft.description !== undefined ? { description: draft.description } : {}),
                changes: draft.changes,
                evidenceRefs: frozen.refs,
              },
              {
                actor: context.session.scope.ownerId,
                retainForEvolution: true,
                beforeMutation: check,
                onPrepared: async (intent) => {
                  await run(
                    memory.stageChange({
                      ownerId: context.session.scope.ownerId,
                      changeId: receipt.changeId,
                      requestFingerprint: receipt.requestFingerprint,
                      operationRef: intent as unknown as Record<string, unknown>,
                    }),
                    signal,
                  );
                },
              },
              prior?.data?.prepared as PreparedSkillChangeRecord | undefined,
              receipt.operationRef as unknown as PreparedSkillChangeIntent | undefined,
            );
            const beforeRef = record.before.skill
              ? {
                  assetKind: "skill" as const,
                  skillId: record.before.skill.skillId,
                  revision: record.before.skill.revision,
                  packageId: record.before.packageId,
                  expertRevision: record.before.expertRevision,
                }
              : null;
            const afterRef = {
              assetKind: "skill" as const,
              skillId: record.after.skill.skillId,
              revision: record.after.skill.revision,
              packageId: record.after.packageId,
              expertRevision: record.after.expertRevision,
            };
            const saved = await run(
              memory.completeChange({
                ownerId: context.session.scope.ownerId,
                changeId: receipt.changeId,
                status: record.status,
                before: beforeRef,
                after: afterRef,
                data: { prepared: record },
              }),
              signal,
            );
            return { status: record.status, changeSet: saved };
          },
          {},
          "automatic",
        );
      },
      catch: (cause) => cause,
    });

  const read: ExpertLearningActionsShape["read"] = (context, raw) =>
    Effect.tryPromise({
      try: async (signal) => {
        const input = Schema.decodeUnknownSync(LearningReadInput)(raw);
        const current = await authorize(context, input.mode === "edit", signal);
        if (input.skillId) {
          const binding = current.expert.skillBindings?.find((x) => x.skillId === input.skillId);
          if (!binding || (input.mode === "edit" && binding.allowEvolution !== true))
            throw new Error("当前专家没有该技能的相应授权。");
          if (input.mode !== "edit")
            throw new Error(
              "运行技能请从本次运行的固定原生技能目录按需读取；当前库版本仅用于明确的编辑基线。",
            );
          const baseline = await runtime.skillLibrary.execute({
            action: "read",
            skillId: input.skillId,
          });
          const skill = baseline.skill;
          const resource = baseline.resources?.find(
            (entry) => entry.kind === "file" && entry.path === `content/${skill?.entryPath}`,
          );
          if (!skill || !resource || resource.size > LEARNING_SOURCE_DOCUMENT_BYTE_LIMIT)
            throw new Error("技能编辑正文缺失或超过有界读取预算，未提供完整编辑基线。");
          const { file } = await runtime.skillLibrary.execute({
            action: "readFile",
            skillId: skill.skillId,
            path: skill.entryPath,
            expectedRevision: skill.revision,
          });
          if (!file?.text || file.text.length > LEARNING_SOURCE_TOTAL_CHARACTER_LIMIT)
            throw new Error("技能编辑正文不是预算内的完整文本，未提供完整编辑基线。");
          // Recheck current binding/permission after the asynchronous package reads.
          const authorized = await authorize(context, true, signal);
          const bindingNow = authorized.expert.skillBindings?.find(
            (x) => x.skillId === skill.skillId,
          );
          if (!bindingNow?.allowEvolution) throw new Error("当前专家没有该技能的相应授权。");
          const resources = [
            resource,
            ...(baseline.resources ?? []).filter((entry) => entry.path !== resource.path),
          ];
          return Schema.decodeUnknownSync(LearningSkillEditBaseline)({
            usage: "edit-baseline",
            expertRevision: authorized.expert.revision,
            skill,
            resources: resources.slice(0, 100),
            file,
            coverage: resources.length > 100 ? ["skill-resource-index-truncated"] : [],
          });
        }
        const applicable = await run(
          memory.readApplicable({
            scope: context.session.scope,
            ...(input.mode === "edit"
              ? { includeShadowed: true }
              : { kinds: ["fact", "environment"] }),
          }),
          signal,
        );
        if (input.memoryId) {
          const pin = current.manifest.rules.find((x) => x.memoryId === input.memoryId);
          const entry =
            input.mode !== "edit" && pin
              ? await run(
                  memory.readRevision(context.session.scope, pin.memoryId, pin.revision),
                  signal,
                )
              : applicable.find((x) => x.memoryId === input.memoryId);
          if (!entry) throw new Error("本次运行没有该记忆的可读版本。");
          if (input.mode !== "edit")
            await run(
              memory.recordRead(
                current.manifest.id,
                entry,
                hash({
                  sessionKey: context.sessionKey,
                  turnId: context.turnId,
                  requestId: context.requestId ?? entry.memoryId,
                }),
              ),
              signal,
            );
          return {
            entry,
            usage:
              input.mode === "edit"
                ? "edit-baseline"
                : entry.kind === "rule"
                  ? "pinned-rule"
                  : "task-data",
          };
        }
        const acceptedTurns = await run(
          turns.listByThreadId({ threadId: ThreadId.makeUnsafe(context.threadId) }),
          signal,
        );
        const pendingId = acceptedTurns.find(
          (turn) => turn.turnId === context.turnId,
        )?.pendingMessageId;
        let sourceRows: readonly LearningSourceAcceptedRuntimeEvent[] = [];
        const sourceCoverage: string[] = [];
        try {
          sourceRows = await runtimeSourceReader(
            context,
            principalFor(context, current.state.ownerKind),
            current.thread,
            pendingId ?? undefined,
            signal,
          )({
            threadId: context.threadId,
            turnId: context.turnId,
            maxEvents: LEARNING_SOURCE_RUNTIME_EVENT_LIMIT,
            maxBytes: LEARNING_SOURCE_TOTAL_BYTE_LIMIT,
          });
        } catch (error) {
          if (signal.aborted) throw error;
          sourceCoverage.push("runtime-source-index-unavailable");
        }
        const availableSources: LearningSourceSelection[] = [
          ...(pendingId ? [{ kind: "message" as const, messageId: pendingId }] : []),
          ...sourceRows.flatMap((row) =>
            (row.documentsRead ?? []).map((doc) => ({
              kind: "document" as const,
              relativePath: doc.relativePath,
              ...(doc.rootIndex !== undefined ? { rootIndex: doc.rootIndex } : {}),
            })),
          ),
          ...sourceRows.flatMap((row) =>
            (row.attachmentExcerpts ?? []).map((attachment) => ({
              kind: "attachment" as const,
              attachmentId: attachment.attachmentId,
              messageId: attachment.messageId,
            })),
          ),
          ...sourceRows.map((row) => ({ kind: "runtime" as const, eventId: row.event.eventId })),
        ];
        const uniqueSources = [
          ...new Map(availableSources.map((source) => [JSON.stringify(source), source])).values(),
        ];
        if (uniqueSources.length > 128) sourceCoverage.push("source-index-truncated");
        return {
          availableSources: uniqueSources.slice(0, 128),
          runtimeSourceIndex: sourceRows.map((row) => ({
            eventId: row.event.eventId,
            eventType: row.event.type,
            ...("itemId" in row.event ? { toolCallId: row.event.itemId } : {}),
          })),
          sourceCoverage,
          manifest: current.manifest,
          memoryIndex: applicable.map(({ memoryId, revision, kind, key, projectBound }) => ({
            memoryId,
            revision,
            kind,
            key,
            projectOnly:
              projectBound ?? (kind !== "rule" || context.session.scope.spaceId === null),
          })),
          skills: (current.expert.skillBindings ?? []).map((binding) => ({
            skillId: binding.skillId,
            enabled: binding.enabled,
            allowEvolution: binding.allowEvolution ?? false,
          })),
          expertRevision: current.expert.revision,
        };
      },
      catch: (cause) => cause,
    });

  const revert: ExpertLearningActionsShape["revert"] = (context, raw) =>
    Effect.tryPromise({
      try: async (signal) => {
        const input = Schema.decodeUnknownSync(LearningRevertInput)(raw);
        return withExpertLearningCommit(
          config.stateDir,
          async () => {
            const check = () => authorize(context, true, signal).then(() => {});
            await check();
            return revertChange(
              context.session.scope.ownerId,
              context.session.scope.expertId,
              input,
              check,
              signal,
              context.session.scope,
            );
          },
          {},
          "automatic",
        );
      },
      catch: (cause) => cause,
    });

  return {
    read,
    commit,
    revert,
    listChanges: (ownerId, expertId) =>
      Effect.tryPromise({
        try: async (signal) => {
          const changes = await run(memory.listChanges(ownerId, expertId), signal);
          const visibleChanges: LearningChangeSet[] = [];
          for (const change of changes)
            visibleChanges.push(await projectPublicChange(ownerId, expertId, change, signal));
          return visibleChanges;
        },
        catch: (cause) => cause,
      }),
    readMemory: (ownerId, expertId, changeId, revision) =>
      Effect.gen(function* () {
        const change = yield* memory.getChange(ownerId, changeId);
        if (!change || change.expertId !== expertId) throw new Error("变化不属于当前专家。");
        const refs = [change.before, change.after].filter((x) => x?.assetKind === "memory");
        const ref = refs.find((x) => x?.revision === revision);
        if (!ref || ref.assetKind !== "memory") throw new Error("变化不包含指定的记忆修订。");
        return yield* memory.readRevision(change.sourceScope, ref.memoryId, revision);
      }),
    readSkillChange: (ownerId, expertId, changeId) =>
      Effect.tryPromise({
        try: async (signal) => {
          const change = await run(memory.getChange(ownerId, changeId), signal);
          if (
            !change ||
            change.ownerId !== ownerId ||
            change.expertId !== expertId ||
            change.sourceScope.ownerId !== ownerId ||
            change.sourceScope.expertId !== expertId ||
            change.assetKind !== "skill"
          )
            throw new Error("Skill 变化不属于当前所有者和专家。");
          if (
            change.status !== "committed" &&
            change.status !== "reverted" &&
            change.status !== "saved_unbound"
          )
            throw new Error("Skill 变化尚无可读取的正式结果。");

          const beforePackageId = exactSkillPackageId(change.before);
          const afterPackageId = exactSkillPackageId(change.after);
          if (!beforePackageId && !afterPackageId)
            throw new Error("Skill 变化没有可读取的历史包引用。");
          const beforePackage = beforePackageId
            ? await runtime.skillPackages.read(beforePackageId)
            : null;
          const afterPackage = afterPackageId
            ? await runtime.skillPackages.read(afterPackageId)
            : null;
          if (
            (beforePackage && beforePackage.packageId !== beforePackageId) ||
            (afterPackage && afterPackage.packageId !== afterPackageId)
          )
            throw new Error("历史 Skill 包身份与变化记录不匹配。");
          const beforeFiles = packageFileResources(beforePackage);
          const afterFiles = packageFileResources(afterPackage);
          const changedPaths = [...new Set([...beforeFiles.keys(), ...afterFiles.keys()])]
            .filter(
              (filePath) => !samePackageFile(beforeFiles.get(filePath), afterFiles.get(filePath)),
            )
            .toSorted((left, right) => left.localeCompare(right));
          const returnedPaths = changedPaths.slice(0, MAX_SKILL_CHANGE_FILES);
          let contentReadBytes = 0;
          let returnedTextBytes = 0;
          let returnedTextUnits = 0;
          let budgetOmissions = 0;

          const sideFor = async (
            packageId: string,
            resource: SkillPackageFileResource,
            filePath: string,
          ): Promise<NonNullable<LearningSkillChangeDetail["files"][number]["before"]>> => {
            const base = {
              size: resource.size,
              sha256: resource.sha256,
              executable: resource.executable ?? false,
            };
            if (
              resource.size > MAX_SKILL_CHANGE_CONTENT_BYTES - contentReadBytes ||
              resource.size > MAX_SKILL_CHANGE_CONTENT_BYTES - returnedTextBytes
            ) {
              budgetOmissions += 1;
              return { ...base, omittedReason: "budget" };
            }
            const packageRoot = path.join(
              config.stateDir,
              "experts",
              "skill-packages",
              packageId,
              "content",
            );
            const realPackageRoot = await fs.realpath(packageRoot);
            const bytes = await expertResourceFiles.read(
              path.join(packageRoot, ...filePath.split("/")),
              realPackageRoot,
            );
            const actualHash = createHash("sha256").update(bytes).digest("hex");
            if (bytes.byteLength !== resource.size || actualHash !== resource.sha256)
              throw new Error(`历史 Skill 文件校验失败：${filePath}`);
            contentReadBytes += bytes.byteLength;
            const text = bytes.toString("utf8");
            if (!Buffer.from(text, "utf8").equals(bytes) || text.includes("\0"))
              return { ...base, omittedReason: "binary" };
            if (
              text.length > MAX_SKILL_CHANGE_TEXT_UNITS - returnedTextUnits ||
              returnedTextBytes + bytes.byteLength > MAX_SKILL_CHANGE_CONTENT_BYTES
            ) {
              budgetOmissions += 1;
              return { ...base, omittedReason: "budget" };
            }
            returnedTextBytes += bytes.byteLength;
            returnedTextUnits += text.length;
            return { ...base, sha256: actualHash, text };
          };

          const files: LearningSkillChangeDetail["files"][number][] = [];
          for (const filePath of returnedPaths) {
            const beforeResource = beforeFiles.get(filePath);
            const afterResource = afterFiles.get(filePath);
            files.push({
              path: filePath,
              before:
                beforePackageId && beforeResource
                  ? await sideFor(beforePackageId, beforeResource, filePath)
                  : null,
              after:
                afterPackageId && afterResource
                  ? await sideFor(afterPackageId, afterResource, filePath)
                  : null,
            });
          }
          const coverage = ["exact-historical-packages-integrity-validated"];
          if (changedPaths.length === 0) coverage.push("no-file-differences");
          if (changedPaths.length > MAX_SKILL_CHANGE_FILES)
            coverage.push(
              `additional-file-pairs-omitted:${changedPaths.length - MAX_SKILL_CHANGE_FILES}`,
            );
          if (budgetOmissions > 0)
            coverage.push(`file-text-omitted-by-content-budget:${budgetOmissions}`);
          return { changeId, files, coverage };
        },
        catch: (cause) => cause,
      }),
    revertOwner: (ownerId, expertId, input) =>
      Effect.tryPromise({
        try: async (signal) => {
          const result = await withExpertLearningCommit(
            config.stateDir,
            async () => {
              const check = async () => {
                if (signal.aborted) throw new Error("撤回已取消。");
                const expert = await runtime.experts.read(expertId);
                if (!expert || expert.archived) throw new Error("专家不存在或已归档。");
              };
              await check();
              return revertChange(ownerId, expertId, input, check, signal);
            },
            { expertIds: [expertId] },
          );
          return projectPublicResult(ownerId, expertId, result, signal);
        },
        catch: (cause) => cause,
      }),
    editOwnerMemory: (ownerId, expertId, input) =>
      Effect.tryPromise({
        try: async (signal) => {
          const result = await withExpertLearningCommit(
            config.stateDir,
            async () => {
              if (signal.aborted) throw new Error("编辑已取消。");
              const origin = await run(memory.getChange(ownerId, input.changeId), signal);
              if (!origin || origin.expertId !== expertId || origin.after?.assetKind !== "memory")
                throw new Error("记忆条目不属于当前专家。");
              const expert = await runtime.experts.read(expertId);
              if (!expert || expert.archived) throw new Error("专家不存在或已归档。");
              const base = await run(
                memory.readRevision(
                  origin.sourceScope,
                  origin.after.memoryId,
                  input.expectedRevision,
                ),
                signal,
              );
              const validUntil = input.validUntil ?? base.validUntil;
              return run(
                memory.withTransaction(
                  Effect.gen(function* () {
                    const result = yield* memory.commit({
                      scope: origin.sourceScope,
                      memoryId: base.memoryId,
                      expectedRevision: input.expectedRevision,
                      kind: base.kind,
                      key: base.key,
                      content: input.content,
                      sources: [
                        {
                          kind: "owner",
                          requestId: input.requestId,
                          contentHash: `sha256:${createHash("sha256").update(input.content).digest("hex")}`,
                          quote: input.content,
                        },
                      ],
                      requestId: input.requestId,
                      requestFingerprint: hash(input),
                      observedAt: new Date().toISOString(),
                      ...(validUntil ? { validUntil } : {}),
                    });
                    if (!result.idempotent) yield* frozenOverride(origin.sourceScope, result.entry);
                    return { status: "committed" as const, changeSet: result.changeSet };
                  }),
                ),
                signal,
              );
            },
            { expertIds: [expertId] },
          );
          return projectPublicResult(ownerId, expertId, result, signal);
        },
        catch: (cause) => cause,
      }),
    commitAutomaticMemory: (input) =>
      Effect.tryPromise({
        try: async (signal) =>
          withExpertLearningCommit(
            config.stateDir,
            async () => {
              const scope: MemoryScope = {
                ownerId: input.ownerId,
                expertId: input.expertId,
                projectId: input.evidence.projectId,
                spaceId: input.evidence.spaceId ?? null,
              };
              const current = await assertScope(
                scope,
                input.evidence.threadId,
                input.evidence.snapshotId,
              );
              const persisted = await run(states.readEvidence(input.evidence.evidenceId), signal);
              if (
                !persisted ||
                input.evidence.ownerId !== input.ownerId ||
                input.evidence.expertId !== input.expertId ||
                input.evidence.learningEpoch !== input.epoch ||
                !input.evidence.completedAt ||
                !current.state.state.enabled ||
                current.state.state.epoch !== input.epoch ||
                current.state.state.harnessKind !== input.evidence.modelSelection.provider ||
                (current.expert.preferredProvider &&
                  current.expert.preferredProvider !== input.evidence.modelSelection.provider)
              )
                throw new Error("原自动学习授权已经结束。");
              const canonical = Schema.decodeUnknownSync(ExpertLearningEvidence)(
                JSON.parse(persisted.record),
              );
              if (!canonical.rootRunId) throw new Error("记忆学习来源缺少原 Run 身份。");
              const sourceManifest = await run(
                memory.findRunManifest(scope, canonical.rootRunId),
                signal,
              );
              if (!sourceManifest || sourceManifest.learningEpoch !== input.epoch)
                throw new Error("原 Run 的记忆学习授权已经结束。");
              if (
                canonical.ownerId !== input.ownerId ||
                canonical.expertId !== input.expertId ||
                canonical.learningEpoch !== input.epoch ||
                canonical.threadId !== input.evidence.threadId ||
                canonical.turnId !== input.evidence.turnId ||
                canonical.rootRunId !== input.evidence.rootRunId ||
                hash(canonical.modelSelection) !== hash(input.evidence.modelSelection) ||
                canonical.projectId !== scope.projectId ||
                (canonical.spaceId ?? null) !== scope.spaceId ||
                canonical.snapshotId !== input.evidence.snapshotId ||
                !canonical.completedAt
              )
                throw new Error("自动记忆来源与持久证据不匹配。");
              if (input.citations.length > 5) throw new Error("单项记忆最多引用五个准确片段。");
              const refs: LearningSourceReference[] = input.citations.map((citation) => {
                const id = "eventId" in citation ? citation.eventId : citation.messageId;
                const item = canonical.items.find(
                  (x) =>
                    ("eventId" in citation ? (x.sourceEventId ?? x.id) === id : x.id === id) &&
                    ("eventId" in citation ? x.kind !== "message" : x.kind === "message") &&
                    x.text.includes(citation.quote) &&
                    citation.threadId === canonical.threadId,
                );
                if (!item) throw new Error("记忆引用不在原任务证据内。");
                const contentHash = `sha256:${createHash("sha256").update(item.text).digest("hex")}`;
                return "eventId" in citation
                  ? {
                      kind: "runtime" as const,
                      runId: canonical.rootRunId!,
                      eventId: item.sourceEventId ?? id,
                      ...(item.toolCallId ? { toolCallId: item.toolCallId } : {}),
                      contentHash,
                      quote: citation.quote,
                      ...(item.truncated ? { truncated: true } : {}),
                    }
                  : {
                      kind: "message" as const,
                      threadId: canonical.threadId,
                      turnId: canonical.turnId,
                      messageId: id,
                      contentHash,
                      quote: citation.quote,
                      ...(item.truncated ? { truncated: true } : {}),
                    };
              });
              if (!refs.length) throw new Error("记忆缺少准确来源。");
              const changes = await run(
                memory.findSourceChanges(input.ownerId, input.expertId, refs),
                signal,
              );
              const handled = handledLearningSignal(changes, refs, { memory: input.draft });
              if (handled) return { status: "unchanged" as const, changeSet: handled };
              return memoryCommit(
                scope,
                input.draft,
                refs,
                input.requestId,
                hash({ scope, draft: input.draft, refs }),
                signal,
              );
            },
            {},
            "automatic",
          ),
        catch: (cause) => cause,
      }),
  } satisfies ExpertLearningActionsShape;
});

export const ExpertLearningActionsLive = Layer.effect(
  ExpertLearningActions,
  makeExpertLearningActions,
);
