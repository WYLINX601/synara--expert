import { useMemo, useState } from "react";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { ChevronRightIcon, FileIcon, PlusIcon, XIcon } from "~/lib/icons";
import { disclosureChevronClassName } from "~/lib/disclosureMotion";
import { SettingsSegmentedControl } from "./SettingControls";
import { normalizeExpertReferences, parseExpertReferences } from "./expertSettingsModel";
import type { ExpertDraftIssue } from "./expertSettingsModel";
import { SettingsListRow, SettingsSectionShell } from "./SettingsPanelPrimitives";

type AddMode = "single" | "bulk";

const ADD_MODE_OPTIONS = [
  { value: "single", label: "单条路径" },
  { value: "bulk", label: "批量粘贴" },
] as const;

export function ExpertReferencesEditor({
  references,
  issues,
  disabled,
  onChange,
}: {
  references: ReadonlyArray<string>;
  issues: ReadonlyArray<ExpertDraftIssue>;
  disabled: boolean;
  onChange: (references: string[]) => void;
}) {
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addMode, setAddMode] = useState<AddMode>("single");
  const [singlePath, setSinglePath] = useState("");
  const [bulkText, setBulkText] = useState("");
  const [expandedRows, setExpandedRows] = useState<ReadonlySet<number>>(() => new Set());
  const inputText = addMode === "single" ? singlePath : bulkText;
  const preview = useMemo(() => {
    const parsed = parseExpertReferences(inputText);
    const currentUnique = normalizeExpertReferences(references);
    const merged = normalizeExpertReferences([...currentUnique, ...parsed.references]);
    const newReferences = merged.slice(currentUnique.length);
    return {
      newReferences,
      duplicateCount: parsed.duplicateCount + parsed.references.length - newReferences.length,
    };
  }, [inputText, references]);
  const referenceIssues = (index: number) =>
    issues.filter((issue) => issue.field === "references" && issue.index === index);

  const clearAddDraft = () => {
    setAddMode("single");
    setSinglePath("");
    setBulkText("");
  };

  const openAddDialog = () => {
    clearAddDraft();
    setAddDialogOpen(true);
  };

  const closeAddDialog = () => {
    setAddDialogOpen(false);
    clearAddDraft();
  };

  const applyAdd = () => {
    if (disabled || preview.newReferences.length === 0) return;
    onChange([...references, ...preview.newReferences]);
    closeAddDialog();
  };

  const removeReference = (index: number) => {
    onChange(references.filter((_, itemIndex) => itemIndex !== index));
    setExpandedRows((current) => {
      const next = new Set<number>();
      for (const expandedIndex of current) {
        if (expandedIndex < index) next.add(expandedIndex);
        else if (expandedIndex > index) next.add(expandedIndex - 1);
      }
      return next;
    });
  };

  return (
    <>
      <SettingsSectionShell
        title="参考资料"
        count={references.length}
        layout="compact"
        action={
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            aria-label="添加参考资料"
            onClick={openAddDialog}
          >
            <PlusIcon aria-hidden="true" className="size-3.5" />
            添加
          </Button>
        }
      >
        {issues
          .filter((issue) => issue.field === "references" && issue.index === undefined)
          .map((issue) => (
            <p
              key={issue.code + ":" + issue.message}
              className="py-1 text-ui-sm text-destructive"
              role="alert"
            >
              {issue.message}
            </p>
          ))}
        {references.length > 0 ? (
          <ul className="divide-y divide-border border-t border-border" aria-label="已配置参考资料">
            {references.map((reference, index) => {
              const rowIssues = referenceIssues(index);
              const isOpen = rowIssues.length > 0 || expandedRows.has(index);
              const trimmedReference = reference.trim();
              const pathSegments = trimmedReference.split(/[\\/]/u).filter(Boolean);
              const displayName =
                pathSegments[pathSegments.length - 1] || trimmedReference || "未填写路径";

              return (
                // Paths are editable; preserve the mounted input while the user types.
                // eslint-disable-next-line react/no-array-index-key
                <li key={index}>
                  <Collapsible
                    open={isOpen}
                    onOpenChange={(open) =>
                      setExpandedRows((current) => {
                        const next = new Set(current);
                        if (open) next.add(index);
                        else next.delete(index);
                        return next;
                      })
                    }
                  >
                    <SettingsListRow
                      layout="compact"
                      className="px-0 py-2"
                      title={
                        <CollapsibleTrigger
                          className="flex w-full min-w-0 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-border-focus)]"
                          aria-label={"查看参考资料 " + (index + 1)}
                          title={reference}
                        >
                          <ChevronRightIcon
                            aria-hidden="true"
                            className={disclosureChevronClassName(isOpen)}
                          />
                          <FileIcon
                            aria-hidden="true"
                            className="size-4 shrink-0 text-muted-foreground"
                          />
                          <span className="min-w-0 truncate text-ui font-medium">
                            {displayName}
                          </span>
                        </CollapsibleTrigger>
                      }
                      actions={
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          disabled={disabled}
                          aria-label={"移除参考资料 " + (index + 1)}
                          onClick={() => removeReference(index)}
                        >
                          <XIcon aria-hidden="true" className="size-4" />
                        </Button>
                      }
                    />
                    <CollapsiblePanel>
                      <div className="space-y-1.5 pb-2">
                        <Input
                          aria-label={"参考资料路径 " + (index + 1)}
                          aria-invalid={rowIssues.length > 0}
                          size="sm"
                          disabled={disabled}
                          value={reference}
                          onChange={(event) => {
                            setExpandedRows((current) => new Set(current).add(index));
                            onChange(
                              references.map((value, itemIndex) =>
                                itemIndex === index ? event.target.value : value,
                              ),
                            );
                          }}
                        />
                        {rowIssues.map((issue) => (
                          <p
                            key={issue.code + ":" + issue.message}
                            className="text-ui-xs text-destructive"
                            role="alert"
                          >
                            {issue.message}
                          </p>
                        ))}
                      </div>
                    </CollapsiblePanel>
                  </Collapsible>
                </li>
              );
            })}
          </ul>
        ) : null}
      </SettingsSectionShell>

      <Dialog
        open={addDialogOpen}
        onOpenChange={(open) => {
          if (open) setAddDialogOpen(true);
          else closeAddDialog();
        }}
      >
        <DialogPopup className="w-[min(36rem,calc(100vw-1.5rem))]">
          <DialogHeader>
            <DialogTitle>添加参考资料</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <SettingsSegmentedControl
              value={addMode}
              onValueChange={setAddMode}
              options={ADD_MODE_OPTIONS}
              ariaLabel="参考资料添加方式"
            />
            {addMode === "single" ? (
              <Input
                aria-label="参考资料路径"
                autoFocus
                disabled={disabled}
                placeholder="输入文件或目录路径"
                value={singlePath}
                onChange={(event) => setSinglePath(event.target.value)}
              />
            ) : (
              <Textarea
                aria-label="批量粘贴参考资料路径"
                disabled={disabled}
                placeholder="每行一条路径"
                className="min-h-24"
                value={bulkText}
                onChange={(event) => setBulkText(event.target.value)}
              />
            )}
            <div
              className="flex items-center justify-between gap-3 text-ui-sm text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              <span>新增 {preview.newReferences.length}</span>
              <span>重复 {preview.duplicateCount}</span>
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" onClick={closeAddDialog}>
              取消
            </Button>
            <Button disabled={disabled || preview.newReferences.length === 0} onClick={applyAdd}>
              添加 {preview.newReferences.length} 条
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
