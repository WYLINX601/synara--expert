import { useMemo, useState, type ReactNode } from "react";
import type { ExpertDefinition } from "@synara/contracts";
import { Button } from "../ui/button";
import { SearchInput } from "../ui/search-input";
import { ExpertActionsMenu } from "./ExpertActionsMenu";

export type ExpertListFilter = "active" | "archived";

export function ExpertList({
  experts,
  selectedId,
  busy,
  onSelect,
  onNew,
  onDuplicate,
  onArchive,
  onRestore,
  onDelete,
  status,
}: {
  experts: ReadonlyArray<ExpertDefinition>;
  selectedId: string | null;
  busy: boolean;
  onSelect: (expert: ExpertDefinition) => void;
  onNew: () => void;
  onDuplicate: (expert: ExpertDefinition) => void;
  onArchive: (expert: ExpertDefinition) => void;
  onRestore: (expert: ExpertDefinition) => void;
  onDelete: (expert: ExpertDefinition) => void;
  status?: ReactNode;
}) {
  const [filter, setFilter] = useState<ExpertListFilter>("active");
  const [search, setSearch] = useState("");
  const visibleExperts = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return experts.filter((expert) => {
      if (expert.archived !== (filter === "archived")) return false;
      return (
        query.length === 0 ||
        expert.name.toLocaleLowerCase().includes(query) ||
        expert.description.toLocaleLowerCase().includes(query) ||
        expert.useCases.toLocaleLowerCase().includes(query)
      );
    });
  }, [experts, filter, search]);

  return (
    <section aria-label="专家列表" className="space-y-3">
      <header className="flex min-h-8 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="text-ui-lg font-semibold">专家</h1>
          <span className="text-ui-xs tabular-nums text-muted-foreground" aria-label="专家总数">
            {experts.length}
          </span>
        </div>
        <Button size="sm" onClick={onNew} disabled={busy}>
          新建专家
        </Button>
      </header>

      {status}

      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-48 flex-1">
          <SearchInput
            aria-label="搜索专家"
            placeholder="搜索名称、描述或使用场景"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div
          className="inline-flex rounded-lg border border-border p-0.5"
          role="group"
          aria-label="专家状态"
        >
          {(
            [
              ["active", "使用中"],
              ["archived", "已归档"],
            ] as const
          ).map(([id, label]) => (
            <Button
              key={id}
              type="button"
              size="xs"
              variant={filter === id ? "secondary" : "ghost"}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>

      {visibleExperts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-ui text-muted-foreground">
          {search.trim()
            ? "没有符合搜索条件的专家。"
            : filter === "archived"
              ? "还没有已归档的专家。"
              : "还没有专家，创建一个开始配置。"}
        </div>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" aria-label="专家">
          {visibleExperts.map((expert) => {
            const selected = expert.id === selectedId;
            const summary = expert.description.trim() || expert.useCases.trim();
            return (
              <li
                key={expert.id}
                className={[
                  "relative min-w-0 rounded-xl border transition-colors",
                  selected
                    ? "border-accent/60 bg-accent/8 hover:bg-accent/12"
                    : "border-border bg-background hover:bg-foreground/3",
                  expert.archived ? "text-muted-foreground" : "text-foreground",
                ].join(" ")}
              >
                <button
                  type="button"
                  className={[
                    "flex min-h-full w-full min-w-0 flex-col gap-1.5 rounded-xl p-3 pr-12 text-left outline-none",
                    "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--color-border-focus)]",
                  ].join(" ")}
                  aria-current={selected ? "true" : undefined}
                  aria-label={"编辑专家 " + expert.name}
                  disabled={busy}
                  onClick={() => onSelect(expert)}
                >
                  <span className="block min-w-0 w-full truncate text-ui font-medium">
                    {expert.name}
                  </span>
                  {summary ? (
                    <span
                      className="block min-w-0 w-full truncate text-ui-sm text-muted-foreground"
                      title={summary}
                    >
                      {summary}
                    </span>
                  ) : null}
                </button>
                <div className="absolute end-2 top-2">
                  <ExpertActionsMenu
                    expert={expert}
                    busy={busy}
                    onDuplicate={onDuplicate}
                    onArchive={onArchive}
                    onRestore={onRestore}
                    onDelete={onDelete}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
