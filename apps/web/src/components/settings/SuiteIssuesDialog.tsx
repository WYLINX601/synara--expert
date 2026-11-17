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
import { useTranslation } from "~/i18n";

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
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>{t("settings:suiteIssuesTitle")}</DialogTitle>
          <DialogDescription>{t("settings:suiteIssuesDescription")}</DialogDescription>
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
                    ? t("settings:suiteIssueDeny")
                    : issue.effect === "limit-capability"
                      ? t("settings:suiteIssueLimit")
                      : t("settings:suiteIssueUnknown")}
                </p>
                {issue.subject.kind === "connection" ? (
                  <Link
                    className="inline-flex rounded-md border border-border px-3 py-1.5 text-ui-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    to="/settings"
                    search={{ section: "mcp", tab: "tools", connectionId: issue.subject.id }}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t("settings:suiteIssueFixConnection")}
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
            {t("settings:suiteIssueRefresh")}
          </Button>
          <Button onClick={() => onOpenChange(false)}>
            {t("settings:suiteIssueBackToPreview")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
