import { useState, type RefObject } from "react";
import { IconCheck, IconAlertCircle } from "@tabler/icons-react";
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
import { SettingsCard } from "synara-ui/components/settings/SettingsPanelPrimitives";
import { ContextText } from "./ContextEditor";
import type { ContextDemoAdapter, DemoState } from "./ContextDemoAdapter";

export function MigrationDialog({
  adapter,
  state,
  open,
  onOpenChange,
  finalFocus,
}: {
  adapter: ContextDemoAdapter;
  state: DemoState;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  finalFocus: RefObject<HTMLButtonElement | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remaining = state.migrations.filter((item) => item.status !== "completed").length;
  const unclaimed = state.migrations.some((item) => item.status === "unclaimed");
  const pending = state.migrations.some((item) => item.status === "pending");
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "迁移未完成，请重试。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) onOpenChange(value);
      }}
    >
      <DialogPopup className="max-w-2xl" showCloseButton={!busy} finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>迁移旧项目指令</DialogTitle>
          <DialogDescription>
            {unclaimed
              ? "请先确认这些旧指令属于当前工作区，再按项目导入。"
              : remaining
                ? "无冲突内容已导入；不同版本需要你选择。"
                : "迁移完成，已回读核对保存结果。"}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <p className="rounded-xl bg-muted/40 px-3 py-2 text-ui-sm text-muted-foreground">
            演示数据 · 这里不读取浏览器中的真实旧配置。
          </p>
          {state.migrations.map((item) => {
            const project = state.projects.find((value) => value.id === item.projectId);
            const space = state.spaces.find((value) => value.id === project?.spaceId);
            return (
              <SettingsCard key={item.id} divided={false} className="space-y-3 p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-ui font-medium">
                    {project?.name}{" "}
                    <span className="ml-1 text-ui-xs font-normal text-muted-foreground">
                      {space?.name ?? "Void"}
                    </span>
                  </span>
                  <span
                    className={`inline-flex items-center gap-1 text-ui-xs ${item.status === "conflict" ? "text-destructive" : "text-muted-foreground"}`}
                  >
                    {item.status === "completed" ? (
                      <>
                        <IconCheck className="size-4 text-success" />
                        已核对
                      </>
                    ) : item.status === "conflict" ? (
                      <>
                        <IconAlertCircle className="size-4" />
                        待选择
                      </>
                    ) : item.status === "pending" ? (
                      "等待导入"
                    ) : (
                      "待确认归属"
                    )}
                  </span>
                </div>
                {item.status === "conflict" ? (
                  <>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <ContextText label="当前已保存" value={project?.context.instructions ?? ""} />
                      <ContextText label="旧本地指令" value={item.localInstructions} />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void run(() => adapter.resolveMigration(item.id, "server"))}
                      >
                        保留已保存版本
                      </Button>
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => void run(() => adapter.resolveMigration(item.id, "local"))}
                      >
                        使用旧本地指令
                      </Button>
                    </div>
                  </>
                ) : (
                  <ContextText
                    label={item.status === "completed" ? "现在使用的项目指令" : "旧本地指令"}
                    value={
                      item.status === "completed"
                        ? (project?.context.instructions ?? "")
                        : item.localInstructions
                    }
                  />
                )}
              </SettingsCard>
            );
          })}
          {error && (
            <p role="alert" className="text-ui text-destructive">
              {error}
            </p>
          )}
          <p className="text-ui-sm text-muted-foreground">
            旧对话和旧 Thread Notes 保留原样。迁移结果供新对话使用。
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          {(unclaimed || pending) && (
            <Button disabled={busy} onClick={() => void run(() => adapter.claimMigrations())}>
              {busy ? "迁移中…" : unclaimed ? "确认属于当前工作区并迁移" : "重试未完成的迁移"}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
