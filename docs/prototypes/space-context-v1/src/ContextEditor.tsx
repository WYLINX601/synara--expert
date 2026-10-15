import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
  type Ref,
} from "react";
import { Button } from "synara-ui/components/ui/button";
import { Textarea } from "synara-ui/components/ui/textarea";
import { SpaceEditorDialog, type SpaceEditorValue } from "synara-ui/components/SpaceEditorDialog";
import { SpaceIcon, type SpaceIconValue } from "synara-ui/components/SpaceIcon";
import { EnvironmentProjectInstructionsSection } from "synara-ui/components/chat/environment/EnvironmentProjectInstructionsSection";
import { useExpertDraftGuard } from "synara-ui/components/settings/useExpertDraftGuard";
import { Tooltip, TooltipTrigger, TooltipPopup } from "synara-ui/components/ui/tooltip";
import { IconInfoCircle, IconArrowUpRight } from "@tabler/icons-react";
import { toSpaceIconName } from "synara-ui/lib/spaceGrouping";
import type { ProjectId } from "@synara/contracts";
import {
  DemoError,
  type ContextConfig,
  type ContextFields,
  type ContextDemoAdapter,
  type DemoSpace,
  type DemoProject,
} from "./ContextDemoAdapter";
import { ProjectContextAutosave } from "./ProjectContextAutosave";

export interface EditorHandle {
  confirmLeave: () => Promise<boolean>;
}

export function ContextText({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <div className="text-ui-sm text-muted-foreground">{label}</div>
      <p className="whitespace-pre-wrap break-words text-ui leading-relaxed">{value || "未设置"}</p>
    </div>
  );
}

function ContextHelp() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button type="button" variant="ghost" size="icon-xs" aria-label="上下文生效说明" />}
      >
        <IconInfoCircle className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup>
        新对话首次发送使用已保存配置。已有对话保留原上下文。目标最多 4096 字符，指令最多 16384
        字符。
      </TooltipPopup>
    </Tooltip>
  );
}

export function ContextComparison({
  saved,
  draft,
  savedMetadata,
  draftMetadata,
  onUseSaved,
  onKeepDraft,
  busy = false,
}: {
  saved: ContextConfig;
  draft: ContextFields;
  savedMetadata?: { name: string; icon: string };
  draftMetadata?: { name: string; icon: string };
  onUseSaved: () => void;
  onKeepDraft: () => void;
  busy?: boolean;
}) {
  const metadata = (value: { name: string; icon: string } | undefined) =>
    value ? (
      <>
        <ContextText label="名称" value={value.name} />
        <div className="flex items-center gap-2 text-ui-sm text-muted-foreground">
          图标 <SpaceIcon icon={value.icon as SpaceIconValue} className="size-4" />
        </div>
      </>
    ) : null;
  return (
    <div className="space-y-3 rounded-lg border border-border p-3" data-testid="context-conflict">
      <p className="text-ui font-medium">内容在另一处更新了</p>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <div className="min-w-0 space-y-2">
          <p className="text-ui-sm font-medium">当前已保存</p>
          {metadata(savedMetadata)}
          <ContextText label="目标" value={saved.goal} />
          <ContextText label="指令" value={saved.instructions} />
        </div>
        <div className="min-w-0 space-y-2">
          <p className="text-ui-sm font-medium">我的草稿</p>
          {metadata(draftMetadata)}
          <ContextText label="目标" value={draft.goal} />
          <ContextText label="指令" value={draft.instructions} />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="xs" variant="outline" disabled={busy} onClick={onUseSaved}>
          使用已保存版本
        </Button>
        <Button type="button" size="xs" disabled={busy} onClick={onKeepDraft}>
          保留草稿并保存
        </Button>
      </div>
    </div>
  );
}

export function ProjectContextEditor({
  controller,
  project,
  space,
  onEditSpace,
  ref,
}: {
  controller: ProjectContextAutosave;
  project: DemoProject;
  space: DemoSpace | undefined;
  onEditSpace: (element: HTMLButtonElement) => void;
  ref?: Ref<EditorHandle>;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const invalid = state.draft.goal.length > 4096 || state.draft.instructions.length > 16384;
  const guard = useExpertDraftGuard({
    isDirty: state.dirty || state.saving,
    canSave: !invalid && state.status !== "conflict",
    saveDisabledReason: invalid
      ? "内容超出上限，请先缩短内容。"
      : "先比较两个版本，再选择要保留的内容。",
    onSave: () => (state.status === "error" ? controller.retry() : controller.flush()),
    onDiscard: () => controller.discard(),
  });
  useImperativeHandle(ref, () => ({
    confirmLeave: async () => {
      if (await controller.flush()) return true;
      return guard.confirmLeave();
    },
  }));
  useEffect(() => {
    const current = controller.getState();
    if (!current.dirty && !current.saving && current.base.revision !== project.context.revision)
      void controller.useSaved();
  }, [controller, project.context.revision]);
  return (
    <div data-testid="project-editor">
      <EnvironmentProjectInstructionsSection
        projectId={project.id as ProjectId}
        instructions={state.base.instructions}
        threadNotes=""
        canCopyToThreadNotes={false}
        onInstructionsChange={() => undefined}
        onCopyToThreadNotes={() => undefined}
        controlledContext={{
          goal: state.draft.goal,
          instructions: state.draft.instructions,
          onGoalChange: (goal) => controller.setDraft({ ...controller.getState().draft, goal }),
          onInstructionsChange: (instructions) =>
            controller.setDraft({ ...controller.getState().draft, instructions }),
          inheritedLabel: space ? `继承自 ${space.name}` : undefined,
          inheritedContent: space ? (
            <div className="space-y-3 px-2 pb-2">
              <ContextText label="方向目标" value={space.context.goal} />
              <ContextText label="共享指令" value={space.context.instructions} />
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="-ml-1"
                data-edit-space
                onClick={(event) => onEditSpace(event.currentTarget)}
              >
                前往 Space 修改 <IconArrowUpRight className="size-3.5" />
              </Button>
            </div>
          ) : undefined,
          status: state.saving ? (
            <span role="status">正在保存…</span>
          ) : state.error ? (
            <div className="space-y-2">
              <p role="alert" className="text-destructive">
                {state.error.message}
              </p>
              {state.status === "conflict" ? (
                <ContextComparison
                  saved={project.context}
                  draft={state.draft}
                  onUseSaved={() => void controller.useSaved()}
                  onKeepDraft={() => void controller.keepDraft()}
                />
              ) : !invalid ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => void controller.retry()}
                >
                  重试保存
                </Button>
              ) : null}
            </div>
          ) : undefined,
        }}
      />
      <div className="flex justify-end">
        <ContextHelp />
      </div>
      {guard.dialog}
    </div>
  );
}

export function SpaceContextDialog({
  adapter,
  space,
  open,
  onOpenChange,
  existingNames,
  finalFocus,
}: {
  adapter: ContextDemoAdapter;
  space: DemoSpace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingNames: readonly string[];
  finalFocus: () => HTMLElement | null;
}) {
  const [draft, setDraft] = useState<ContextFields>({
    goal: space.context.goal,
    instructions: space.context.instructions,
  });
  const [metadata, setMetadata] = useState<SpaceEditorValue>({
    name: space.name,
    icon: space.icon as SpaceEditorValue["icon"],
  });
  const [base, setBase] = useState(space);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savedRef = useRef(base);
  const draftRef = useRef(draft);
  const metadataRef = useRef(metadata);
  const busyRef = useRef(false);
  draftRef.current = draft;
  metadataRef.current = metadata;
  const invalid = draft.goal.length > 4096 || draft.instructions.length > 16384;
  const invalidName =
    !metadata.name.trim() ||
    existingNames.some((name) => name.trim().toLowerCase() === metadata.name.trim().toLowerCase());
  const dirtyNow = () => {
    const saved = savedRef.current;
    return (
      draftRef.current.goal !== saved.context.goal ||
      draftRef.current.instructions !== saved.context.instructions ||
      metadataRef.current.name.trim() !== saved.name ||
      toSpaceIconName(metadataRef.current.icon) !== saved.icon
    );
  };
  const dirty = dirtyNow();
  const adopt = useCallback(() => {
    const current = adapter.getState().spaces.find((item) => item.id === space.id);
    if (!current) return;
    savedRef.current = current;
    setBase(current);
    const fields = { goal: current.context.goal, instructions: current.context.instructions };
    draftRef.current = fields;
    setDraft(fields);
    const info = { name: current.name, icon: current.icon as SpaceEditorValue["icon"] };
    metadataRef.current = info;
    setMetadata(info);
    setConflict(false);
    setError(null);
  }, [adapter, space.id]);
  const save = async (
    value = metadataRef.current,
    revision = savedRef.current.context.revision,
    expectedMetadata = { name: savedRef.current.name, icon: savedRef.current.icon },
  ) => {
    if (busyRef.current || invalid || !value.name.trim()) return false;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const fields = {
      name: value.name.trim(),
      icon: toSpaceIconName(value.icon),
      ...draftRef.current,
    };
    try {
      let saved;
      try {
        saved = await adapter.saveSpace(space.id, fields, revision, expectedMetadata);
      } catch (cause) {
        if (!(cause instanceof DemoError) || !cause.outcomeUncertain) throw cause;
        const current = adapter.getState().spaces.find((item) => item.id === space.id);
        if (
          !current ||
          current.name !== fields.name ||
          current.icon !== fields.icon ||
          current.context.goal !== fields.goal ||
          current.context.instructions !== fields.instructions
        )
          throw cause;
        saved = current;
      }
      savedRef.current = saved;
      setBase(saved);
      metadataRef.current = { name: saved.name, icon: saved.icon as SpaceEditorValue["icon"] };
      setMetadata(metadataRef.current);
      setConflict(false);
      return true;
    } catch (cause) {
      setConflict(cause instanceof DemoError && cause.code === "conflict");
      setError(cause instanceof Error ? cause.message : "保存未完成，草稿仍保留。");
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const guard = useExpertDraftGuard({
    isDirty: dirty,
    canSave: !invalid && !invalidName && !conflict,
    saveDisabledReason: conflict
      ? "先比较两个版本，再选择要保留的内容。"
      : "请检查名称或超出上限的内容。",
    onSave: () => save(),
    onDiscard: adopt,
  });
  const onMetadataChange = useCallback((value: SpaceEditorValue) => {
    metadataRef.current = value;
    setMetadata(value);
  }, []);
  const close = async () => {
    if (!busyRef.current && (!dirtyNow() || (await guard.confirmLeave()))) onOpenChange(false);
  };
  const field = (key: keyof ContextFields, label: string, rows: number, limit: number) => (
    <div className="space-y-1.5">
      <label className="text-ui-sm text-muted-foreground" htmlFor={`space-${space.id}-${key}`}>
        {label}
      </label>
      <Textarea
        id={`space-${space.id}-${key}`}
        rows={rows}
        value={draft[key]}
        disabled={busy}
        onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
        aria-invalid={draft[key].length > limit}
        aria-describedby={draft[key].length > limit ? `space-${space.id}-${key}-limit` : undefined}
        placeholder={
          key === "goal" ? "这个方向希望持续推进什么（可选）" : "适用于所有项目的要求（可选）"
        }
      />
      {draft[key].length > limit && (
        <p
          id={`space-${space.id}-${key}-limit`}
          role="alert"
          className="text-ui-sm text-destructive"
        >
          {label}最多 {limit} 个字符，当前 {draft[key].length} 个。内容不会被裁剪。
        </p>
      )}
    </div>
  );
  return (
    <>
      <SpaceEditorDialog
        key={`${space.id}:${base.context.revision}:${base.name}:${base.icon}`}
        open={open}
        mode="edit"
        initialValue={{ name: base.name, icon: base.icon as SpaceEditorValue["icon"] }}
        existingNames={existingNames}
        onValueChange={onMetadataChange}
        lockWhileSubmitting
        closeDisabled={busy}
        submitDisabled={invalid || conflict}
        finalFocus={finalFocus}
        onOpenChange={(next) => {
          if (next) onOpenChange(true);
          else void close();
        }}
        onSubmit={async (value) => {
          if (!(await save(value))) throw new Error("保存未完成，请处理上方提示后重试。");
        }}
        bodyContent={
          <div className="space-y-4" data-testid="space-editor">
            {field("goal", "方向目标", 2, 4096)}
            {field("instructions", "共享指令", 4, 16384)}
            {error && (
              <p role="alert" className="text-ui-sm text-destructive">
                {error}
              </p>
            )}
            {conflict && (
              <ContextComparison
                saved={space.context}
                draft={draft}
                savedMetadata={{ name: space.name, icon: space.icon }}
                draftMetadata={{ name: metadata.name, icon: toSpaceIconName(metadata.icon) }}
                busy={busy}
                onUseSaved={adopt}
                onKeepDraft={() =>
                  void save(metadataRef.current, space.context.revision, {
                    name: space.name,
                    icon: space.icon,
                  })
                }
              />
            )}
            <div className="flex justify-end">
              <ContextHelp />
            </div>
          </div>
        }
      />
      {guard.dialog}
    </>
  );
}
