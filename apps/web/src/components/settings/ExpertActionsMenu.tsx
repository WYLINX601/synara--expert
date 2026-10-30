import type { ExpertDefinition } from "@synara/contracts";
import type { Ref } from "react";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuTrigger } from "../ui/menu";
import { EllipsisIcon } from "~/lib/icons";

export type ExpertActionsMenuProps = {
  expert: ExpertDefinition;
  busy: boolean;
  onDuplicate: (expert: ExpertDefinition) => void;
  onArchive: (expert: ExpertDefinition) => void;
  onRestore: (expert: ExpertDefinition) => void;
  onDelete: (expert: ExpertDefinition) => void;
  triggerRef?: Ref<HTMLButtonElement>;
  checkConfiguration?: { onCheck: () => void; disabled: boolean };
  showRestore?: boolean;
};

export function ExpertActionsMenu({
  expert,
  busy,
  onDuplicate,
  onArchive,
  onRestore,
  onDelete,
  triggerRef,
  checkConfiguration,
  showRestore = true,
}: ExpertActionsMenuProps) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            ref={triggerRef}
            size="icon-sm"
            variant="ghost"
            aria-label={"管理专家 " + expert.name}
            disabled={busy}
          >
            <EllipsisIcon aria-hidden="true" className="size-4" />
          </Button>
        }
      />
      <ComposerPickerMenuPopup align="end" side="bottom" className="w-44 min-w-44">
        {checkConfiguration ? (
          <MenuItem
            disabled={busy || checkConfiguration.disabled}
            onClick={checkConfiguration.onCheck}
          >
            检查配置
          </MenuItem>
        ) : null}
        <MenuItem disabled={busy} onClick={() => onDuplicate(expert)}>
          复制专家
        </MenuItem>
        {expert.archived ? (
          showRestore ? (
            <MenuItem disabled={busy} onClick={() => onRestore(expert)}>
              恢复专家
            </MenuItem>
          ) : null
        ) : (
          <MenuItem variant="destructive" disabled={busy} onClick={() => onArchive(expert)}>
            归档专家
          </MenuItem>
        )}
        <MenuItem variant="destructive" disabled={busy} onClick={() => onDelete(expert)}>
          删除专家
        </MenuItem>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
