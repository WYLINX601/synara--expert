import type { ExpertDefinition } from "@synara/contracts";
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
};

export function ExpertActionsMenu({
  expert,
  busy,
  onDuplicate,
  onArchive,
  onRestore,
  onDelete,
}: ExpertActionsMenuProps) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
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
        <MenuItem disabled={busy} onClick={() => onDuplicate(expert)}>
          复制专家
        </MenuItem>
        {expert.archived ? (
          <MenuItem disabled={busy} onClick={() => onRestore(expert)}>
            恢复专家
          </MenuItem>
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
