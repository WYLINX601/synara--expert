import type { ExpertDefinition } from "@synara/contracts";
import { useId, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import {
  SettingsCard,
  SettingsEmptyState,
  SettingsSectionShell,
} from "~/components/settings/SettingsPanelPrimitives";
import { XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

function expertSearchText(expert: ExpertDefinition): string {
  return `${expert.name} ${expert.description} ${expert.useCases}`.toLocaleLowerCase();
}

export function GroupExpertsSection(props: {
  readonly expertIds: ReadonlyArray<string>;
  readonly experts: ReadonlyArray<ExpertDefinition> | undefined;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onChange: (expertIds: ReadonlyArray<string>) => void;
}) {
  const [query, setQuery] = useState("");
  const idPrefix = useId().replaceAll(":", "");
  const expertsById = useMemo(
    () => new Map((props.experts ?? []).map((expert) => [expert.id, expert])),
    [props.experts],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const availableExperts = useMemo(
    () =>
      (props.experts ?? [])
        .filter((expert) => !expert.archived)
        .filter(
          (expert) =>
            normalizedQuery.length === 0 || expertSearchText(expert).includes(normalizedQuery),
        )
        .slice()
        .sort((left, right) => left.name.localeCompare(right.name)),
    [normalizedQuery, props.experts],
  );
  const selectedIds = [...new Set(props.expertIds)];
  const selected = new Set(selectedIds);

  const toggleExpert = (expertId: string, checked: boolean) => {
    props.onChange(
      checked
        ? [...selectedIds, expertId]
        : selectedIds.filter((selectedId) => selectedId !== expertId),
    );
  };

  return (
    <SettingsSectionShell title="参与专家" count={selectedIds.length}>
      <div className="space-y-3">
        <p className="text-ui-sm text-muted-foreground">未选择或没有匹配专家时，可使用普通线程</p>
        <div className="flex items-center justify-between gap-3">
          <p className="text-ui-sm font-medium">已选择 {selectedIds.length} 位专家</p>
          {selectedIds.length > 0 ? (
            <Button type="button" size="xs" variant="ghost" onClick={() => props.onChange([])}>
              清空
            </Button>
          ) : null}
        </div>
        {selectedIds.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5" aria-label="已选择的专家">
            {selectedIds.map((expertId) => {
              const expert = expertsById.get(expertId);
              const availability =
                props.experts === undefined
                  ? props.error
                    ? "无法验证，仍保留"
                    : "正在确认"
                  : props.error && !expert
                    ? "无法验证，仍保留"
                    : !expert
                      ? "不可用"
                      : expert.archived
                        ? "已归档，不可用于新线程"
                        : null;
              const label = expert?.name ?? expertId;
              return (
                <li
                  key={expertId}
                  className={cn(
                    "inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-foreground/[0.03] ps-2 text-ui-sm",
                    availability && "text-muted-foreground",
                  )}
                >
                  <span className="min-w-0 truncate" title={label}>
                    {label}
                    {availability ? ` · ${availability}` : ""}
                  </span>
                  <button
                    type="button"
                    aria-label={`移除专家 ${label}`}
                    title={`移除专家 ${label}`}
                    className="inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    onClick={() => toggleExpert(expertId, false)}
                  >
                    <XIcon className="size-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索专家"
          aria-label="搜索专家"
        />
        {props.error ? (
          <div
            className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-ui-sm text-destructive"
            role="alert"
          >
            无法读取专家：{props.error}
          </div>
        ) : null}
        {props.loading && props.experts === undefined ? (
          <SettingsEmptyState layout="status">正在读取专家…</SettingsEmptyState>
        ) : availableExperts.length > 0 ? (
          <SettingsCard className="max-h-80 overflow-y-auto px-3" divided={false}>
            <ul aria-label="可选择的专家" className="divide-y divide-border">
              {availableExperts.map((expert, index) => {
                const checkboxId = `${idPrefix}-expert-${index}`;
                const checked = selected.has(expert.id);
                return (
                  <li key={expert.id} className="flex min-w-0 items-start gap-2 py-2.5">
                    <Checkbox
                      id={checkboxId}
                      checked={checked}
                      aria-describedby={`${checkboxId}-description`}
                      onCheckedChange={(value) => toggleExpert(expert.id, value === true)}
                      className="mt-0.5"
                    />
                    <div className="min-w-0 flex-1">
                      <label
                        htmlFor={checkboxId}
                        className="block cursor-pointer truncate text-ui font-medium"
                      >
                        {expert.name}
                      </label>
                      <p
                        id={`${checkboxId}-description`}
                        className="line-clamp-2 text-ui-xs text-muted-foreground"
                      >
                        {expert.description || expert.useCases || "暂无说明"}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </SettingsCard>
        ) : props.experts?.length === 0 ? (
          <SettingsEmptyState layout="status">还没有可用专家。</SettingsEmptyState>
        ) : (
          <SettingsEmptyState layout="status">
            {normalizedQuery ? "没有符合搜索条件的专家。" : "没有可用专家。"}
          </SettingsEmptyState>
        )}
      </div>
    </SettingsSectionShell>
  );
}
