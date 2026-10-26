import { useState } from "react";
import { buildPathTree, type PathTreeNode } from "~/lib/pathTree";
import { FileEntryIcon } from "../chat/FileEntryIcon";
import { fileRowClassName, fileRowIndentStyle } from "../chat/fileRowStyles";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { DisclosureChevron } from "../ui/DisclosureChevron";

export function SkillResourceTree({
  paths,
  entryPath,
  selectedPath,
  disabled,
  theme,
  onSelect,
}: {
  paths: readonly string[];
  entryPath: string;
  selectedPath: string | null;
  disabled: boolean;
  theme: "light" | "dark";
  onSelect: (path: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const file = (path: string) => ({ kind: "file" as const, path, name: path.split("/").at(-1)! });
  const render = (nodes: readonly PathTreeNode[], depth: number) =>
    nodes.map((node) =>
      node.kind === "file" ? (
        <li key={`file:${node.path}`}>
          <button
            type="button"
            aria-label={node.path}
            aria-current={selectedPath === node.path ? "page" : undefined}
            title={node.path}
            disabled={disabled}
            className={fileRowClassName(
              selectedPath === node.path,
              "min-h-8 w-full py-1 text-ui-sm",
            )}
            style={fileRowIndentStyle(depth)}
            onClick={() => onSelect(node.path)}
          >
            <FileEntryIcon
              pathValue={node.path}
              kind="file"
              theme={theme}
              className="size-4 shrink-0"
            />
            <span className="min-w-0 truncate">{node.name}</span>
          </button>
        </li>
      ) : (
        <li key={`directory:${node.path}`}>
          <Collapsible
            open={!collapsed.includes(node.path)}
            onOpenChange={(open) =>
              setCollapsed((current) =>
                open ? current.filter((path) => path !== node.path) : [...current, node.path],
              )
            }
          >
            <CollapsibleTrigger
              render={
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-auto w-full justify-start py-1 text-ui-sm sm:h-auto"
                  style={fileRowIndentStyle(depth)}
                  aria-label={`文件夹 ${node.path}`}
                />
              }
            >
              <DisclosureChevron open={!collapsed.includes(node.path)} />
              <FileEntryIcon
                pathValue={node.path}
                kind="directory"
                theme={theme}
                className="size-4 shrink-0"
              />
              <span className="min-w-0 truncate">{node.name}</span>
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <ul>{render(node.children, depth + 1)}</ul>
            </CollapsiblePanel>
          </Collapsible>
        </li>
      ),
    );
  return (
    <nav aria-label="技能资源" className="min-w-0 space-y-4">
      <div>
        <p className="mb-1 px-2 text-ui-xs text-muted-foreground">主文件</p>
        <ul>{paths.includes(entryPath) ? render([file(entryPath)], 0) : null}</ul>
      </div>
      <div>
        <p className="mb-1 px-2 text-ui-xs text-muted-foreground">
          附属文件 {paths.filter((path) => path !== entryPath).length}
        </p>
        <ul>{render(buildPathTree(paths.filter((path) => path !== entryPath).map(file)), 0)}</ul>
      </div>
    </nav>
  );
}
