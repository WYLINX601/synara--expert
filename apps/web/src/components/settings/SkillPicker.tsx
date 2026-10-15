import { useEffect, useId, useMemo, useState } from "react";
import type { ProviderSkillDescriptor, ProviderSkillReference } from "@synara/contracts";
import { InfoIcon, PlusIcon } from "~/lib/icons";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { SearchInput } from "../ui/search-input";
import { Select, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsSegmentedControl } from "./SettingControls";
import { SettingsSelectPopup } from "./SettingsPanelPrimitives";
import { addExpertSkillReference, expertSkillPathKey } from "./expertSkillsSettingsModel";
import { skillDisplayName, skillOriginInfo } from "./skillsSettingsModel";

export function SkillPicker({
  skills,
  catalog,
  catalogError,
  catalogLoading,
  disabled,
  onApply,
}: {
  skills: ReadonlyArray<ProviderSkillReference>;
  catalog: ReadonlyArray<ProviderSkillDescriptor>;
  catalogError: string | null;
  catalogLoading: boolean;
  disabled: boolean;
  onApply: (skills: ProviderSkillReference[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"catalog" | "path">("catalog");
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [selectedPathKeys, setSelectedPathKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [manualName, setManualName] = useState("");
  const [manualPath, setManualPath] = useState("");
  const formId = useId();

  useEffect(() => {
    if (!open) return;
    setMode("catalog");
    setSearch("");
    setSourceFilter("all");
    setManualName("");
    setManualPath("");
    setSelectedPathKeys(new Set(skills.map((skill) => expertSkillPathKey(skill.path))));
  }, [open, skills]);

  const sourceOptions = useMemo(() => {
    const sources = [...new Set(catalog.map((skill) => skill.scope ?? "personal"))].toSorted();
    return sources.map((source) => ({ value: source, label: skillOriginInfo(source).label }));
  }, [catalog]);

  const visibleSkills = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return catalog.filter((skill) => {
      const source = skill.scope ?? "personal";
      if (sourceFilter !== "all" && source !== sourceFilter) return false;
      return (
        query.length === 0 ||
        skillDisplayName(skill).toLocaleLowerCase().includes(query) ||
        skill.name.toLocaleLowerCase().includes(query) ||
        skill.path.toLocaleLowerCase().includes(query) ||
        (skill.description ?? "").toLocaleLowerCase().includes(query)
      );
    });
  }, [catalog, search, sourceFilter]);

  const catalogPathKeys = new Set(catalog.map((skill) => expertSkillPathKey(skill.path)));
  const originalPathKeys = new Set(skills.map((skill) => expertSkillPathKey(skill.path)));
  const hasSelectionChanges = catalog.some((skill) => {
    const key = expertSkillPathKey(skill.path);
    return selectedPathKeys.has(key) !== originalPathKeys.has(key);
  });
  const selectedCount = [...selectedPathKeys].filter((key) => catalogPathKeys.has(key)).length;
  const manualPathKey = expertSkillPathKey(manualPath);
  const manualDuplicate = manualPathKey.length > 0 && originalPathKeys.has(manualPathKey);

  const apply = () => {
    if (disabled || catalogLoading || !hasSelectionChanges) return;
    let next = skills.filter((skill) => {
      const path = expertSkillPathKey(skill.path);
      return !catalogPathKeys.has(path) || selectedPathKeys.has(path);
    });
    for (const skill of catalog) {
      const path = expertSkillPathKey(skill.path);
      if (selectedPathKeys.has(path)) {
        next = addExpertSkillReference(next, { name: skill.name, path: skill.path });
      }
    }
    onApply(next);
    setOpen(false);
  };

  const addManual = () => {
    if (disabled || !manualName.trim() || !manualPath.trim() || manualDuplicate) return;
    onApply(addExpertSkillReference(skills, { name: manualName.trim(), path: manualPath.trim() }));
    setOpen(false);
  };

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        aria-label="添加技能"
        onClick={() => setOpen(true)}
      >
        <PlusIcon />
        添加
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="w-[min(44rem,calc(100vw-1.5rem))]">
          <DialogHeader>
            <DialogTitle>添加技能</DialogTitle>
            <DialogDescription className="sr-only">选择本机技能或按路径添加。</DialogDescription>
            <SettingsSegmentedControl
              ariaLabel="技能添加方式"
              value={mode}
              onValueChange={setMode}
              options={[
                { value: "catalog", label: "已发现" },
                { value: "path", label: "按路径" },
              ]}
            />
          </DialogHeader>
          <DialogPanel className="max-h-[min(58vh,34rem)] space-y-3">
            {mode === "path" ? (
              <form
                id={formId}
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  addManual();
                }}
              >
                <label className="block space-y-1 text-ui-sm">
                  <span className="font-medium">名称</span>
                  <Input
                    aria-label="新技能名称"
                    disabled={disabled}
                    maxLength={200}
                    value={manualName}
                    onChange={(event) => setManualName(event.target.value)}
                  />
                </label>
                <label className="block space-y-1 text-ui-sm">
                  <span className="font-medium">技能入口路径</span>
                  <Input
                    aria-label="新技能路径"
                    aria-invalid={manualDuplicate}
                    disabled={disabled}
                    placeholder="/path/to/SKILL.md"
                    value={manualPath}
                    onChange={(event) => setManualPath(event.target.value)}
                  />
                </label>
                {manualDuplicate ? (
                  <p className="text-ui-sm text-destructive" role="alert">
                    该路径已添加。
                  </p>
                ) : null}
              </form>
            ) : (
              <>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <div className="min-w-0 flex-1">
                    <SearchInput
                      aria-label="搜索技能"
                      placeholder="搜索技能"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                  </div>
                  <Select
                    value={sourceFilter}
                    onValueChange={(value) => setSourceFilter(value ?? "all")}
                  >
                    <SelectTrigger aria-label="按技能来源筛选" className="w-full sm:w-44">
                      <SelectValue>
                        {sourceFilter === "all"
                          ? "全部来源"
                          : (sourceOptions.find((source) => source.value === sourceFilter)?.label ??
                            "全部来源")}
                      </SelectValue>
                    </SelectTrigger>
                    <SettingsSelectPopup>
                      <SelectItem value="all" hideIndicator>
                        全部来源
                      </SelectItem>
                      {sourceOptions.map((source) => (
                        <SelectItem key={source.value} value={source.value} hideIndicator>
                          {source.label}
                        </SelectItem>
                      ))}
                    </SettingsSelectPopup>
                  </Select>
                </div>
                {catalogError ? (
                  <p className="text-ui-sm text-destructive" role="alert">
                    无法读取技能目录：{catalogError}
                  </p>
                ) : null}
                {catalogLoading ? (
                  <p className="py-2 text-ui-sm text-muted-foreground" role="status">
                    正在读取技能…
                  </p>
                ) : visibleSkills.length === 0 ? (
                  <p className="py-2 text-ui-sm text-muted-foreground">
                    {catalog.length === 0 ? "未发现技能" : "无匹配技能"}
                  </p>
                ) : (
                  <ul className="divide-y divide-border" aria-label="可选技能">
                    {visibleSkills.map((skill) => {
                      const pathKey = expertSkillPathKey(skill.path);
                      const checkboxId = `${formId}-skill-${catalog.indexOf(skill)}`;
                      const checked = selectedPathKeys.has(pathKey);
                      const description = skill.interface?.shortDescription ?? skill.description;
                      return (
                        <li key={pathKey} className="flex min-w-0 items-center gap-2 py-2">
                          <Checkbox
                            id={checkboxId}
                            checked={checked}
                            disabled={disabled}
                            aria-describedby={description ? `${checkboxId}-description` : undefined}
                            onCheckedChange={(value) => {
                              setSelectedPathKeys((current) => {
                                const next = new Set(current);
                                if (value === true) next.add(pathKey);
                                else next.delete(pathKey);
                                return next;
                              });
                            }}
                            className="mt-0.5"
                          />
                          <div className="min-w-0 flex-1">
                            <label
                              htmlFor={checkboxId}
                              className="block cursor-pointer truncate text-ui font-medium"
                            >
                              {skillDisplayName(skill)}
                            </label>
                            {description ? (
                              <span
                                id={`${checkboxId}-description`}
                                className="mt-0.5 line-clamp-1 text-ui-sm text-muted-foreground"
                                title={description}
                              >
                                {description}
                              </span>
                            ) : null}
                          </div>
                          <span className="max-w-28 shrink-0 truncate text-ui-xs text-muted-foreground">
                            {skillOriginInfo(skill.scope).label}
                          </span>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  size="icon-sm"
                                  variant="ghost"
                                  aria-label={`查看技能路径 ${skillDisplayName(skill)}`}
                                >
                                  <InfoIcon />
                                </Button>
                              }
                            />
                            <TooltipPopup className="max-w-[min(32rem,calc(100vw-2rem))] break-all">
                              {skill.path}
                            </TooltipPopup>
                          </Tooltip>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              取消
            </Button>
            {mode === "path" ? (
              <Button
                type="submit"
                form={formId}
                disabled={disabled || !manualName.trim() || !manualPath.trim() || manualDuplicate}
              >
                添加技能
              </Button>
            ) : (
              <Button onClick={apply} disabled={disabled || catalogLoading || !hasSelectionChanges}>
                应用选择（{selectedCount}）
              </Button>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
