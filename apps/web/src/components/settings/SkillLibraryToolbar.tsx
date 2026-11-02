import type { SkillLibraryQuery, SkillLibrarySourceFilter } from "@synara/contracts";
import { ArrowDownIcon, ArrowUpIcon, FilterIcon } from "~/lib/icons";
import {
  ComposerPickerMenuPopup,
  ComposerPickerMenuSubPopup,
} from "../chat/ComposerPickerMenuPopup";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsSelectPopup } from "./SettingsPanelPrimitives";

export interface SkillLibraryFilters {
  usage: "all" | "used" | "unused";
  sources: SkillLibrarySourceFilter[];
  expertIds: string[];
  tags: string[];
}

export interface SkillLibraryColumns {
  usage: boolean;
  source: boolean;
  updated: boolean;
  created: boolean;
}

export const DEFAULT_SKILL_LIBRARY_COLUMNS: SkillLibraryColumns = {
  usage: true,
  source: false,
  updated: true,
  created: false,
};

const SORT_OPTIONS = [
  { value: "name", label: "名称" },
  { value: "usedBy", label: "绑定专家数" },
  { value: "created", label: "创建时间" },
  { value: "updated", label: "更新时间" },
] as const;

const SOURCE_OPTIONS: readonly { value: SkillLibrarySourceFilter; label: string }[] = [
  { value: "manual", label: "手动创建" },
  { value: "github", label: "GitHub" },
  { value: "skills.sh", label: "skills.sh" },
  { value: "clawhub", label: "ClawHub" },
  { value: "local", label: "本地目录" },
  { value: "archive", label: "归档" },
  { value: "runtime", label: "运行时副本" },
];

const COLUMN_OPTIONS: readonly { value: keyof SkillLibraryColumns; label: string }[] = [
  { value: "usage", label: "被谁使用" },
  { value: "source", label: "来源" },
  { value: "updated", label: "更新时间" },
  { value: "created", label: "创建时间" },
];

function FilterChoices<Value extends string>({
  title,
  options,
  selected,
  onChange,
}: {
  title: string;
  options: readonly { value: Value; label: string }[];
  selected: readonly Value[];
  onChange: (values: Value[]) => void;
}) {
  return (
    <MenuSub>
      <MenuSubTrigger>
        {title}
        {selected.length ? (
          <span className="ml-auto text-ui-xs tabular-nums text-muted-foreground">
            {selected.length}
          </span>
        ) : null}
      </MenuSubTrigger>
      <ComposerPickerMenuSubPopup className="max-h-64 min-w-44 max-w-64 overflow-y-auto">
        {options.length ? (
          options.map((option) => (
            <MenuCheckboxItem
              key={option.value}
              variant="checkbox"
              closeOnClick={false}
              checked={selected.includes(option.value)}
              onCheckedChange={(checked) =>
                onChange(
                  checked
                    ? [...selected, option.value]
                    : selected.filter((value) => value !== option.value),
                )
              }
            >
              <span className="min-w-0 break-all">{option.label}</span>
            </MenuCheckboxItem>
          ))
        ) : (
          <MenuItem disabled>暂无可选项</MenuItem>
        )}
      </ComposerPickerMenuSubPopup>
    </MenuSub>
  );
}

export function SkillLibraryToolbar({
  search,
  onSearchChange,
  filters,
  onFiltersChange,
  experts,
  tags,
  sort,
  onSortChange,
  columns,
  onColumnsChange,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  filters: SkillLibraryFilters;
  onFiltersChange: (value: SkillLibraryFilters) => void;
  experts: readonly { id: string; name: string }[];
  tags: readonly string[];
  sort: NonNullable<SkillLibraryQuery["sort"]>;
  onSortChange: (value: NonNullable<SkillLibraryQuery["sort"]>) => void;
  columns: SkillLibraryColumns;
  onColumnsChange: (value: SkillLibraryColumns) => void;
}) {
  const filterCount =
    Number(filters.usage !== "all") +
    filters.sources.length +
    filters.expertIds.length +
    filters.tags.length;
  const sortLabel = SORT_OPTIONS.find((option) => option.value === sort.field)!.label;
  const DirectionIcon = sort.direction === "asc" ? ArrowUpIcon : ArrowDownIcon;
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-2"
      role="group"
      aria-label="技能筛选与排序"
    >
      <Input
        className="min-w-0 flex-1 basis-64"
        aria-label="搜索技能"
        placeholder="搜索名称、说明或标签"
        value={search}
        onChange={(event) => onSearchChange(event.target.value)}
      />
      <div className="flex shrink-0 items-center gap-2">
        <Menu>
          <MenuTrigger render={<Button size="sm" variant="outline" aria-label="筛选条件" />}>
            <FilterIcon aria-hidden className="size-3.5" />
            筛选
            {filterCount ? <span className="text-ui-xs tabular-nums">{filterCount}</span> : null}
          </MenuTrigger>
          <ComposerPickerMenuPopup align="end" className="min-w-48">
            <MenuGroup>
              <MenuGroupLabel>筛选条件</MenuGroupLabel>
              <MenuSub>
                <MenuSubTrigger>使用状态</MenuSubTrigger>
                <ComposerPickerMenuSubPopup className="min-w-40">
                  <MenuRadioGroup
                    value={filters.usage}
                    onValueChange={(value) => {
                      if (value === "all" || value === "used" || value === "unused")
                        onFiltersChange({ ...filters, usage: value });
                    }}
                  >
                    <MenuRadioItem value="all" closeOnClick={false}>
                      全部使用状态
                    </MenuRadioItem>
                    <MenuRadioItem value="used" closeOnClick={false}>
                      已绑定
                    </MenuRadioItem>
                    <MenuRadioItem value="unused" closeOnClick={false}>
                      未绑定
                    </MenuRadioItem>
                  </MenuRadioGroup>
                </ComposerPickerMenuSubPopup>
              </MenuSub>
              <FilterChoices
                title="来源"
                options={SOURCE_OPTIONS}
                selected={filters.sources}
                onChange={(sources) => onFiltersChange({ ...filters, sources })}
              />
              <FilterChoices
                title="专家"
                options={experts.map((expert) => ({ value: expert.id, label: expert.name }))}
                selected={filters.expertIds}
                onChange={(expertIds) => onFiltersChange({ ...filters, expertIds })}
              />
              <FilterChoices
                title="标签"
                options={tags.map((tag) => ({ value: tag, label: tag }))}
                selected={filters.tags}
                onChange={(nextTags) => onFiltersChange({ ...filters, tags: nextTags })}
              />
            </MenuGroup>
            {filterCount ? (
              <>
                <MenuSeparator />
                <MenuItem
                  onClick={() =>
                    onFiltersChange({
                      usage: "all",
                      sources: [],
                      expertIds: [],
                      tags: [],
                    })
                  }
                >
                  清除筛选
                </MenuItem>
              </>
            ) : null}
          </ComposerPickerMenuPopup>
        </Menu>
        <Popover>
          <PopoverTrigger render={<Button size="sm" variant="outline" aria-label="排序与显示" />}>
            <DirectionIcon aria-hidden className="size-3.5" />
            {sortLabel}
          </PopoverTrigger>
          <PopoverPopup align="end" className="w-64 text-ui-sm">
            <div className="space-y-3">
              <PopoverTitle className="text-ui-sm font-normal text-muted-foreground">
                排序
              </PopoverTitle>
              <div className="flex min-w-0 items-center gap-2">
                <Select
                  value={sort.field}
                  onValueChange={(value) => {
                    if (SORT_OPTIONS.some((option) => option.value === value))
                      onSortChange({ ...sort, field: value as typeof sort.field });
                  }}
                >
                  <SelectTrigger size="sm" aria-label="排序字段" className="min-w-0 flex-1">
                    <SelectValue>{sortLabel}</SelectValue>
                  </SelectTrigger>
                  <SettingsSelectPopup>
                    {SORT_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SettingsSelectPopup>
                </Select>
                <Button
                  size="sm"
                  variant="outline"
                  className="px-2"
                  aria-label={sort.direction === "asc" ? "升序，切换为降序" : "降序，切换为升序"}
                  onClick={() =>
                    onSortChange({ ...sort, direction: sort.direction === "asc" ? "desc" : "asc" })
                  }
                >
                  <DirectionIcon aria-hidden className="size-4" />
                </Button>
              </div>
              <div
                role="group"
                aria-label="显示信息"
                className="space-y-2 border-t border-border pt-3"
              >
                <p className="text-ui-xs text-muted-foreground">显示信息</p>
                {COLUMN_OPTIONS.map((option) => (
                  <label
                    key={option.value}
                    className="flex items-center justify-between gap-4 text-ui-sm"
                  >
                    {option.label}
                    <Switch
                      checked={columns[option.value]}
                      onCheckedChange={(checked) =>
                        onColumnsChange({ ...columns, [option.value]: checked })
                      }
                    />
                  </label>
                ))}
              </div>
            </div>
          </PopoverPopup>
        </Popover>
      </div>
    </div>
  );
}
