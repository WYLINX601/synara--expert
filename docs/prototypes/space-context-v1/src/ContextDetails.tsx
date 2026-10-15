import { Button } from "synara-ui/components/ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "synara-ui/components/ui/dialog";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsiblePanel,
} from "synara-ui/components/ui/collapsible";
import { DisclosureChevron } from "synara-ui/components/ui/DisclosureChevron";
import { useState } from "react";
import { ContextText } from "./ContextEditor";
import type { DemoThread, DemoProject, DemoSpace } from "./ContextDemoAdapter";

export function ContextDetails({
  open,
  onOpenChange,
  thread,
  project,
  space,
  stale,
  onNewThread,
  onRetry,
  onReturnFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  thread: DemoThread;
  project: DemoProject;
  space: DemoSpace | undefined;
  stale: boolean;
  onNewThread: () => void;
  onRetry: () => void;
  onReturnFocus: () => HTMLElement | null;
}) {
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const snapshot = thread.snapshot;
  const legacy = thread.mode === "legacy";
  const sourceSpaceName = snapshot ? snapshot.spaceName : space?.name;
  const sourceProjectName = snapshot?.projectName ?? project.name;
  const activeSpace = snapshot ? snapshot.space : space?.context;
  const activeProject = snapshot?.project ?? project.context;
  const empty =
    !activeSpace?.goal &&
    !activeSpace?.instructions &&
    !activeProject.goal &&
    !activeProject.instructions;
  const status = legacy
    ? "旧对话"
    : thread.applied.status === "failed"
      ? "加载失败"
      : thread.applied.status === "loading"
        ? "正在加载…"
        : thread.applied.status === "loaded"
          ? empty
            ? "未配置 Synara Context"
            : "已加载"
          : "待首次发送";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl" finalFocus={onReturnFocus}>
        <DialogHeader>
          <DialogTitle>当前上下文</DialogTitle>
          <DialogDescription>
            {legacy
              ? "旧对话沿用原有内容。"
              : snapshot
                ? "固定于首次发送，已有对话保留原内容。"
                : "已保存配置预览；以首次发送实际固定的内容为准。"}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          <p className="text-ui-sm text-muted-foreground" role="status">
            {status}
          </p>
          {legacy ? (
            <p className="text-ui text-muted-foreground">
              旧对话不会自动补入新 Context，原 Thread Notes 保留。
            </p>
          ) : (
            <>
              {activeSpace && (
                <section className="space-y-3">
                  <h3 className="text-ui font-medium">{sourceSpaceName}</h3>
                  <ContextText label="方向目标" value={activeSpace.goal} />
                  <ContextText label="共享指令" value={activeSpace.instructions} />
                </section>
              )}
              <section className="space-y-3">
                <h3 className="text-ui font-medium">{sourceProjectName}</h3>
                <ContextText label="项目目标" value={activeProject.goal} />
                <ContextText label="项目指令" value={activeProject.instructions} />
              </section>
              {empty && (
                <p className="text-ui-sm text-muted-foreground">
                  四个字段均为空，继续使用现有专家和运行配置。
                </p>
              )}
              {stale && (
                <div className="space-y-1 rounded-lg bg-muted/40 p-3">
                  <p className="text-ui font-medium">配置有更新</p>
                  <p className="text-ui-sm text-muted-foreground">
                    这段对话继续使用上述内容。新配置从新对话开始使用。
                  </p>
                </div>
              )}
              {thread.applied.status === "failed" && (
                <div className="space-y-2">
                  <p role="alert" className="text-ui-sm text-destructive">
                    上下文加载失败，消息尚未执行。
                  </p>
                  <Button type="button" size="sm" variant="outline" onClick={onRetry}>
                    按原上下文重试
                  </Button>
                </div>
              )}
              <Collapsible open={technicalOpen} onOpenChange={setTechnicalOpen}>
                <CollapsibleTrigger className="flex items-center gap-2 text-ui-sm text-muted-foreground">
                  <DisclosureChevron open={technicalOpen} className="size-3" />
                  技术详情
                </CollapsibleTrigger>
                <CollapsiblePanel>
                  <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 rounded-lg bg-muted/40 p-3 text-ui-xs break-all">
                    <dt>快照</dt>
                    <dd>{snapshot?.id ?? "首次发送时创建"}</dd>
                    <dt>版本</dt>
                    <dd>
                      Space {activeSpace?.revision ?? "—"} / Project {activeProject.revision}
                    </dd>
                    <dt>哈希</dt>
                    <dd>{snapshot?.hash ?? "—"}</dd>
                    <dt>会话代次</dt>
                    <dd>{thread.applied.generation}</dd>
                    <dt>提供方</dt>
                    <dd>{thread.provider}</dd>
                  </dl>
                  <p className="mt-2 text-ui-xs text-muted-foreground">
                    演示记录。原生 Provider 文件指令可能另行加载。
                  </p>
                </CollapsiblePanel>
              </Collapsible>
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          {(stale || legacy) && (
            <Button
              type="button"
              onClick={() => {
                onOpenChange(false);
                onNewThread();
              }}
            >
              在新对话中使用最新配置
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
