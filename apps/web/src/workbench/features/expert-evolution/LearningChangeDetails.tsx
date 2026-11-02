import type {
  LearningChangeSet,
  LearningSkillChangeSide,
  LearningSourceReference,
  SpaceMemoryEntry,
  ThreadId,
} from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SettingsEditorDialog } from "~/components/settings/SettingsEditorDialog";
import { Button } from "~/components/ui/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "~/components/ui/dialog";
import { ensureExpertClient } from "~/workbench/host/expertClient";
import {
  learningSkillCoverageLabel,
  skillEvolutionQueryKey,
  stableEvolutionOperationId,
} from "./model";

export const learningChangesQueryOptions = (expertId: string) => ({
  queryKey: [...skillEvolutionQueryKey(expertId), "learningChanges"] as const,
  queryFn: async () => {
    const result = await ensureExpertClient().skillEvolution({
      action: "learningChanges",
      expertId,
    });
    if (!result.learningChanges) throw new Error("学习变化回执缺失，暂不能确认成长记录。");
    return result.learningChanges;
  },
});

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sourceLabel(source: LearningSourceReference) {
  switch (source.kind) {
    case "owner":
      return "用户操作";
    case "message":
      return source.role === "assistant"
        ? "助手消息"
        : source.role === "user"
          ? "用户反馈"
          : "消息";
    case "runtime":
      return "运行记录";
    case "document":
      return "指定资料";
    case "attachment":
      return "附件";
  }
}

function MemoryContent({ entry, absent }: { entry: SpaceMemoryEntry | null; absent: string }) {
  return (
    <div className="space-y-2">
      <p className="whitespace-pre-wrap break-words text-ui-sm">{entry?.content ?? absent}</p>
      {entry ? (
        <p className="text-ui-xs text-muted-foreground">
          第 {entry.revision} 次修订{entry.status === "retracted" ? " · 已停用" : ""}
        </p>
      ) : null}
    </div>
  );
}

function SkillContent({ side }: { side: LearningSkillChangeSide | null }) {
  if (!side) return <p className="text-ui-sm text-muted-foreground">此版本没有该文件。</p>;
  return (
    <div className="min-w-0 space-y-2">
      {side.text !== undefined ? (
        <p className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-ui-sm">
          {side.text || "（空文件）"}
        </p>
      ) : (
        <p className="text-ui-sm text-muted-foreground">
          {side.omittedReason === "binary"
            ? "二进制文件，未展示正文。"
            : side.omittedReason === "budget"
              ? "超出本次展示上限，正文已省略。"
              : "此版本没有可展示的正文。"}
        </p>
      )}
      <p className="text-ui-xs text-muted-foreground">
        {side.size} 字节 · {side.executable ? "可执行" : "不可执行"}
      </p>
      <p className="break-all text-ui-xs text-muted-foreground" title={side.sha256}>
        内容指纹 {side.sha256.slice(0, 12)}
      </p>
    </div>
  );
}

export function LearningChangeDetails({
  change,
  expertId,
  expertName,
  disabled,
  onClose,
  sourceTitles,
  onOpenTask,
}: {
  change: LearningChangeSet | null;
  expertId: string;
  expertName: string;
  disabled: boolean;
  onClose: () => void;
  sourceTitles?: ReadonlyMap<string, string>;
  onOpenTask?: (threadId: ThreadId) => void;
}) {
  const queryClient = useQueryClient();
  const memory = useQuery({
    queryKey: [
      "server",
      "skillEvolutionDetail",
      expertId,
      "memory",
      change?.changeId,
      change?.before,
      change?.after,
    ],
    enabled: change?.assetKind === "memory",
    retry: false,
    staleTime: Infinity,
    queryFn: async () => {
      if (!change || change.assetKind !== "memory") throw new Error("记忆变化不可用。");
      const read = async (ref: LearningChangeSet["before"]): Promise<SpaceMemoryEntry | null> => {
        if (ref === null) return null;
        if (!ref || ref.assetKind !== "memory") throw new Error("变化缺少准确的记忆版本引用。");
        const result = await ensureExpertClient().skillEvolution({
          action: "learningReadMemory",
          expertId,
          changeId: change.changeId,
          revision: ref.revision,
        });
        const entry = result.memoryEntry;
        if (
          !entry ||
          entry.memoryId !== ref.memoryId ||
          entry.revision !== ref.revision ||
          entry.contentHash !== ref.contentHash
        )
          throw new Error("记忆版本回执不匹配，暂不能展示内容。");
        return entry;
      };
      const [before, after] = await Promise.all([read(change.before), read(change.after)]);
      return { before, after };
    },
  });
  const skill = useQuery({
    queryKey: [
      "server",
      "skillEvolutionDetail",
      expertId,
      "skill",
      change?.changeId,
      change?.before,
      change?.after,
    ],
    enabled: change?.assetKind === "skill",
    retry: false,
    staleTime: Infinity,
    queryFn: async () => {
      if (!change || change.assetKind !== "skill") throw new Error("技能变化不可用。");
      const result = await ensureExpertClient().skillEvolution({
        action: "learningReadSkillChange",
        expertId,
        changeId: change.changeId,
      });
      if (!result.learningSkillChange || result.learningSkillChange.changeId !== change.changeId)
        throw new Error("技能变化回执不匹配，暂不能展示内容。");
      return result.learningSkillChange;
    },
  });
  const undo = useMutation({
    retry: false,
    mutationFn: async (target: LearningChangeSet) => {
      // A learning change is withdrawn once; deterministic identity also survives remounts.
      const operationId = await stableEvolutionOperationId("learning-revert", [
        expertId,
        target.changeId,
      ]);
      const result = await ensureExpertClient().skillEvolution({
        action: "learningRevert",
        expertId,
        changeId: target.changeId,
        operationId,
      });
      const receipt = result.learningChange;
      const confirmed =
        receipt?.expertId === expertId &&
        receipt.assetKind === target.assetKind &&
        ((result.learningStatus === "unchanged" &&
          receipt.changeId === target.changeId &&
          receipt.status === "reverted") ||
          (result.learningStatus === "committed" &&
            receipt.status === "committed" &&
            receipt.requestId === operationId &&
            receipt.changeId !== target.changeId &&
            receipt.revertsChangeId === target.changeId));
      if (!confirmed)
        throw new Error(
          result.learningStatus === "saved_unbound"
            ? "撤回尚未完成：修改已保存，但绑定尚未确认。"
            : "撤回回执未确认，正在核对成长记录。",
        );
      return result;
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: skillEvolutionQueryKey(expertId) }),
        queryClient.invalidateQueries({ queryKey: ["server", "experts"] }),
        queryClient.invalidateQueries({ queryKey: ["server", "expertLearning", expertId] }),
        queryClient.invalidateQueries({ queryKey: ["server", "skillLibrary", "evolution"] }),
      ]);
    },
  });
  const inverse = Boolean(change?.revertsChangeId);
  const matches = undo.variables?.changeId === change?.changeId;
  const reverted = change?.status === "reverted" || (matches && undo.isSuccess);
  const pending = matches && undo.isPending;
  const entry = memory.data?.after ?? memory.data?.before;
  const kind =
    entry?.kind === "rule"
      ? "行为规则"
      : entry?.kind === "fact"
        ? "业务事实"
        : entry?.kind === "environment"
          ? "环境信息"
          : null;
  return (
    <SettingsEditorDialog open={Boolean(change)} onClose={onClose} closeButtonLabel="关闭变化详情">
      <DialogHeader className="shrink-0 px-6 pt-5 pb-4">
        <DialogTitle className="break-words pr-8">
          {change?.assetKind === "memory" ? (kind ?? "记忆") : change?.summary || "学习变化"} ·
          变化详情
        </DialogTitle>
        <DialogDescription>本次已保存的变化及其来源。</DialogDescription>
      </DialogHeader>
      <DialogPanel className="min-w-0 space-y-5 px-6 pb-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-md bg-muted px-2 py-1 text-ui-xs text-muted-foreground">
            {change?.assetKind === "memory" ? `记忆${kind ? ` · ${kind}` : ""}` : "技能"}
          </span>
          <span className="text-ui-xs text-muted-foreground">{expertName}</span>
        </div>
        {entry ? (
          <p className="break-words text-ui-xs text-muted-foreground">
            适用范围：{expertName} · {entry.scope.spaceId ? "来源 Space" : "Void"}
            {entry.kind !== "rule" || entry.scope.spaceId === null || (entry.projectBound ?? false)
              ? " · 来源项目"
              : ""}
          </p>
        ) : change?.assetKind === "skill" ? (
          <p className="text-ui-xs text-muted-foreground">
            学习来源范围：{expertName} · {change.sourceScope.spaceId ? "来源 Space" : "Void"} ·
            来源项目
          </p>
        ) : null}
        <section className="space-y-3" aria-label="本次变化">
          <h3 className="text-ui-lg font-medium">本次变化</h3>
          {change?.assetKind === "memory" ? (
            memory.isPending ? (
              <p role="status" className="text-ui-sm text-muted-foreground">
                正在读取准确版本…
              </p>
            ) : memory.isError ? (
              <p role="alert" className="break-words text-ui-sm text-destructive">
                无法读取变化详情：{errorText(memory.error)}
              </p>
            ) : memory.data ? (
              <div className="grid min-w-0 overflow-hidden rounded-lg border border-border sm:grid-cols-2">
                <div className="min-w-0 space-y-2 p-4">
                  <p className="text-ui-xs text-muted-foreground">修改前</p>
                  <MemoryContent entry={memory.data.before} absent="尚未保存这条记忆。" />
                </div>
                <div className="min-w-0 space-y-2 border-t border-border bg-muted/40 p-4 sm:border-l sm:border-t-0">
                  <p className="text-ui-xs text-muted-foreground">修改后</p>
                  <MemoryContent entry={memory.data.after} absent="已停用这条记忆。" />
                </div>
              </div>
            ) : null
          ) : skill.isPending ? (
            <p role="status" className="text-ui-sm text-muted-foreground">
              正在读取准确版本…
            </p>
          ) : skill.isError ? (
            <p role="alert" className="break-words text-ui-sm text-destructive">
              无法读取变化详情：{errorText(skill.error)}
            </p>
          ) : skill.data ? (
            <div className="space-y-3">
              <p className="break-all text-ui-xs text-muted-foreground">
                {change?.before?.assetKind === "skill"
                  ? `v${change.before.revision ?? "未知"}`
                  : change?.before === null
                    ? "新建技能"
                    : "修改前版本引用缺失"}{" "}
                →{" "}
                {change?.after?.assetKind === "skill"
                  ? `v${change.after.revision ?? "未知"}`
                  : change?.after === null
                    ? "已解除绑定"
                    : "修改后版本引用缺失"}
              </p>
              {skill.data.files.map((file) => (
                <div
                  key={file.path}
                  className="min-w-0 overflow-hidden rounded-lg border border-border"
                >
                  <p className="break-all border-b border-border px-4 py-2 text-ui-sm">
                    {file.path}
                  </p>
                  <div className="grid min-w-0 sm:grid-cols-2">
                    <div className="min-w-0 space-y-2 p-4">
                      <p className="text-ui-xs text-muted-foreground">修改前</p>
                      <SkillContent side={file.before} />
                    </div>
                    <div className="min-w-0 space-y-2 border-t border-border bg-muted/40 p-4 sm:border-l sm:border-t-0">
                      <p className="text-ui-xs text-muted-foreground">修改后</p>
                      <SkillContent side={file.after} />
                    </div>
                  </div>
                </div>
              ))}
              {!skill.data.files.length ? (
                <p className="text-ui-sm text-muted-foreground">此变化没有文件正文差异。</p>
              ) : null}
              {skill.data.coverage.map((code) => {
                const message = learningSkillCoverageLabel(code);
                return message ? (
                  <p key={code} className="break-words text-ui-xs text-muted-foreground">
                    {message}
                  </p>
                ) : null;
              })}
            </div>
          ) : null}
        </section>
        <section className="space-y-3" aria-label="变化来源">
          <h3 className="text-ui-lg font-medium">来源</h3>
          {change ? (
            <time dateTime={change.createdAt} className="text-ui-xs text-muted-foreground">
              {new Date(change.createdAt).toLocaleString()}
            </time>
          ) : null}
          {change?.sourceRefs.length ? (
            change.sourceRefs.map((source) => (
              <div key={JSON.stringify(source)} className="min-w-0 space-y-2">
                {source.quote ? (
                  <blockquote className="whitespace-pre-wrap break-words border-l-2 border-border pl-3 text-ui-sm">
                    {source.quote}
                  </blockquote>
                ) : (
                  <p className="text-ui-sm text-muted-foreground">此来源未保留可展示的原文片段。</p>
                )}
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ui-xs text-muted-foreground">
                  {source.kind === "message" ? (
                    onOpenTask ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => {
                          onClose();
                          onOpenTask(source.threadId as ThreadId);
                        }}
                      >
                        {sourceTitles?.get(source.threadId) ?? "来源任务"}
                      </Button>
                    ) : (
                      <span>{sourceTitles?.get(source.threadId) ?? "来源任务"}</span>
                    )
                  ) : null}
                  <span>
                    {sourceLabel(source)}
                    {"truncated" in source && source.truncated ? " · 来源已截断" : ""}
                  </span>
                </div>
              </div>
            ))
          ) : (
            <p className="text-ui-sm text-muted-foreground">此变化没有可展示的来源。</p>
          )}
        </section>
        <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-3">
          <p className="text-ui-sm">
            {inverse
              ? "这是一次撤回记录；原学习及本次逆向变化均保留在历史中。"
              : change?.assetKind === "memory"
                ? "仅撤回本次记忆变化；后续独立任务使用撤回后的版本。历史记录保留。"
                : "仅撤回本次技能修改；保留其他文件与后来的独立改进。"}
          </p>
          {!inverse ? (
            <p className="text-ui-xs text-muted-foreground">
              若同一内容已被后续修改，将显示冲突，不覆盖后续成果。
            </p>
          ) : null}
        </div>
        {matches && undo.isError && !reverted ? (
          <p role="alert" className="whitespace-pre-wrap break-words text-ui-sm text-destructive">
            暂不能确认撤回：{errorText(undo.error)}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter className="shrink-0 flex-col border-t border-border px-6 py-4 sm:flex-row sm:items-center">
        <p role="status" className="min-w-0 flex-1 text-ui-xs text-muted-foreground">
          {inverse
            ? "本次撤回已记录。"
            : reverted
              ? "已撤回本次学习；其他变化与历史记录保留。"
              : pending
                ? "正在撤回本次学习…"
                : "仅撤回本次学习。"}
        </p>
        <Button size="sm" variant="outline" onClick={onClose}>
          关闭
        </Button>
        {!inverse ? (
          <Button
            size="sm"
            variant="outline"
            disabled={
              disabled ||
              undo.isPending ||
              reverted ||
              change?.status !== "committed" ||
              (change?.assetKind === "memory" ? !memory.isSuccess : !skill.isSuccess)
            }
            onClick={() => {
              if (change) undo.mutate(change);
            }}
          >
            {reverted ? "已撤回" : "撤回本次学习"}
          </Button>
        ) : null}
      </DialogFooter>
    </SettingsEditorDialog>
  );
}
