import { Link } from "@tanstack/react-router";
import type { RefObject } from "react";
import type { SuiteIssue } from "@synara/contracts";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";

export function SuiteIssuesDialog({
  issues,
  open,
  onOpenChange,
  onRetry,
  finalFocus,
}: {
  issues: ReadonlyArray<SuiteIssue>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRetry: () => void;
  finalFocus: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>识别问题</DialogTitle>
          <DialogDescription>问题只影响列出的动作或能力；返回预览不会代替保存。</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <ul className="space-y-4 text-ui">
            {issues.map((issue, index) => (
              <li key={index} className="space-y-1">
                <p>{issue.message}</p>
                <p className="break-all text-ui-sm text-muted-foreground">
                  {issue.subject.id}
                  {issue.subject.path ? ` · ${issue.subject.path}` : ""} · {issue.action}
                </p>
                <p className="text-ui-sm text-muted-foreground">
                  {issue.effect === "deny-action"
                    ? "仅当前动作无法执行，请处理对应问题。"
                    : issue.effect === "limit-capability"
                      ? "此能力受到限制，其余可执行工作可以继续。"
                      : "暂未完成检查，不代表能力已通过或全部不可用。"}
                </p>
                {issue.subject.kind === "connection" ? (
                  <Link
                    className="inline-flex rounded-md border border-border px-3 py-1.5 text-ui-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    to="/settings"
                    search={{ section: "mcp", tab: "tools", connectionId: issue.subject.id }}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    处理连接
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
              onRetry();
            }}
          >
            重新读取检查
          </Button>
          <Button onClick={() => onOpenChange(false)}>返回预览</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
