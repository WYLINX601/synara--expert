import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  ExpertDefinition,
  ExpertSkillSelection,
  ProviderSkillDescriptor,
  ProviderSkillReference,
  SkillPackage,
  SkillPackagePreview,
} from "@synara/contracts";
import { ChevronDownIcon, InfoIcon, PlusIcon } from "~/lib/icons";
import { ensureExpertClient } from "~/workbench/host/expertClient";
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
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SettingsSegmentedControl } from "./SettingControls";
import { SettingsSelectPopup } from "./SettingsPanelPrimitives";
import { skillDisplayName, skillOriginInfo } from "./skillsSettingsModel";
import {
  choiceKey,
  choicesForExpert,
  resolveSkillChoices,
  type SkillPickerChoice,
} from "./skillPickerModel";
import {
  SKILL_PACKAGES_QUERY_KEY,
  SKILL_PACKAGE_SOURCES_QUERY_KEY,
  useSkillPackageConnection,
} from "./skillPackageSettingsQueries";

type Candidate = {
  choice: SkillPickerChoice;
  name: string;
  description: string;
  fullDescription: string;
  source: string;
  path: string;
  issue?: string;
};
const EMPTY_EXPERTS: readonly ExpertDefinition[] = [];
const message = (error: unknown) => (error instanceof Error ? error.message : "操作失败，请重试。");

export function SkillPicker({
  skills,
  selections,
  expertName,
  experts = EMPTY_EXPERTS,
  packages,
  catalog,
  catalogError,
  catalogLoading,
  disabled,
  onApply,
}: {
  skills: ReadonlyArray<ProviderSkillReference>;
  selections: ReadonlyArray<ExpertSkillSelection> | undefined;
  expertName: string;
  experts?: ReadonlyArray<ExpertDefinition>;
  packages: ReadonlyArray<SkillPackage>;
  catalog: ReadonlyArray<ProviderSkillDescriptor>;
  catalogError: string | null;
  catalogLoading: boolean;
  disabled: boolean;
  onApply: (selections: ExpertSkillSelection[]) => void;
}) {
  const connection = useSkillPackageConnection();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"catalog" | "path">("catalog");
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [onlySelected, setOnlySelected] = useState(false);
  const [pending, setPending] = useState<SkillPickerChoice[]>([]);
  const [topKeys, setTopKeys] = useState<ReadonlySet<string>>(new Set());
  const [previews, setPreviews] = useState<ReadonlyMap<string, SkillPackagePreview>>(new Map());
  const [manualPath, setManualPath] = useState("");
  const [expertSearch, setExpertSearch] = useState("");
  const [expertMenu, setExpertMenu] = useState(false);
  const [undo, setUndo] = useState<{
    choices: SkillPickerChoice[];
    topKeys: ReadonlySet<string>;
    search: string;
    source: string;
    only: boolean;
    name: string;
    count: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const requestId = useRef(0);
  const live = useRef({
    generation: connection.generation,
    connected: connection.connected,
    open,
    disabled,
  });
  live.current = {
    generation: connection.generation,
    connected: connection.connected,
    open,
    disabled,
  };
  useEffect(
    () => () => {
      requestId.current += 1;
    },
    [],
  );
  useEffect(() => {
    requestId.current += 1;
    setBusy(false);
    setPreviews(new Map());
    setExpertMenu(false);
    setOpen(false);
  }, [connection.generation, connection.connected]);

  const changeOpen = (next: boolean) => {
    requestId.current += 1;
    setBusy(false);
    setError(null);
    setExpertMenu(false);
    if (next) {
      const choices = choicesForExpert({
        skills,
        ...(selections === undefined ? {} : { skillSelections: selections }),
      });
      setPending(choices);
      setTopKeys(new Set(choices.map(choiceKey)));
      setSearch("");
      setSourceFilter("all");
      setOnlySelected(false);
      setManualPath("");
      setExpertSearch("");
      setPreviews(new Map());
      setUndo(null);
      setMode("catalog");
    }
    setOpen(next);
  };
  const startRequest = () => {
    const id = ++requestId.current,
      generation = connection.generation;
    setBusy(true);
    setError(null);
    return () =>
      id === requestId.current &&
      live.current.open &&
      !live.current.disabled &&
      live.current.connected &&
      live.current.generation === generation;
  };
  const availableExperts = experts.filter((expert) => !expert.archived);
  const packageMap = useMemo(
    () =>
      new Map(
        [...packages, ...[...previews.values()].map((item) => item.package)].map((item) => [
          item.packageId,
          item,
        ]),
      ),
    [packages, previews],
  );
  const candidates = useMemo(() => {
    const map = new Map<string, Candidate>();
    const descriptorsByKey = new Map<string, ProviderSkillDescriptor>();
    for (const descriptor of catalog) {
      const key = choiceKey({
        kind: "path",
        reference: { name: descriptor.name, path: descriptor.path },
      });
      if (!descriptorsByKey.has(key)) descriptorsByKey.set(key, descriptor);
    }
    const entriesByPackage = new Map<string, Map<string, SkillPackage["entries"][number]>>();
    for (const pkg of packageMap.values()) {
      entriesByPackage.set(
        pkg.packageId,
        new Map(pkg.entries.map((entry) => [entry.entryPath, entry])),
      );
    }
    const describe = (choice: SkillPickerChoice): Candidate => {
      if (choice.kind === "path") {
        const descriptor = descriptorsByKey.get(choiceKey(choice));
        return {
          choice,
          name: descriptor ? skillDisplayName(descriptor) : choice.reference.name,
          description: descriptor?.interface?.shortDescription ?? descriptor?.description ?? "",
          fullDescription: descriptor?.description ?? descriptor?.interface?.shortDescription ?? "",
          source: descriptor ? skillOriginInfo(descriptor.scope).label : "按路径",
          path: choice.reference.path,
        };
      }
      const pkg = packageMap.get(choice.selection.packageId),
        entry = entriesByPackage.get(choice.selection.packageId)?.get(choice.selection.entryPath);
      return {
        choice,
        name: entry?.name ?? choice.selection.entryPath,
        description: entry?.description ?? "",
        fullDescription: entry?.description ?? "",
        source: "版本包",
        path: `${pkg?.rootName ?? choice.selection.packageId} / ${choice.selection.entryPath}\n${choice.selection.packageId}`,
        ...(entry?.incompatibleReason ? { issue: entry.incompatibleReason } : {}),
      };
    };
    for (const item of catalog) {
      const choice: SkillPickerChoice = {
        kind: "path",
        reference: { name: item.name, path: item.path },
      };
      map.set(choiceKey(choice), describe(choice));
    }
    for (const pkg of packageMap.values())
      for (const entry of pkg.entries) {
        const choice: SkillPickerChoice = {
          kind: "package",
          selection: {
            packageId: pkg.packageId,
            entryPath: entry.entryPath,
            activation: "on-demand",
          },
        };
        map.set(choiceKey(choice), describe(choice));
      }
    // Retain every selection, including unavailable paths and fixed versions absent from discovery.
    for (const choice of pending) map.set(choiceKey(choice), describe(choice));
    return [...map.values()].toSorted(
      (a, b) => Number(topKeys.has(choiceKey(b.choice))) - Number(topKeys.has(choiceKey(a.choice))),
    );
  }, [catalog, packageMap, pending, topKeys]);
  const selectedKeys = new Set(pending.map(choiceKey));
  const sourceOptions = [...new Set(candidates.map((item) => item.source))].toSorted();
  const query = search.trim().toLocaleLowerCase();
  const visible = candidates.filter(
    (item) =>
      (sourceFilter === "all" || item.source === sourceFilter) &&
      (!onlySelected || selectedKeys.has(choiceKey(item.choice))) &&
      (!query ||
        `${item.name} ${item.description} ${item.fullDescription} ${item.path}`
          .toLocaleLowerCase()
          .includes(query)),
  );
  const reuse = (expert: ExpertDefinition) => {
    const choices = choicesForExpert(expert);
    if (!choices.length) return;
    setUndo({
      choices: pending,
      topKeys,
      search,
      source: sourceFilter,
      only: onlySelected,
      name: expert.name,
      count: choices.length,
    });
    setPending(choices);
    setTopKeys(new Set(choices.map(choiceKey)));
    setSearch("");
    setSourceFilter("all");
    setOnlySelected(false);
    setError(null);
    setMode("catalog");
    setExpertMenu(false);
    listRef.current?.scrollTo({ top: 0 });
  };
  const previewPath = async () => {
    if (busy || disabled || !connection.connected || !manualPath.trim()) return;
    const current = startRequest();
    try {
      const preview = await ensureExpertClient().previewSkillPackage({ path: manualPath.trim() });
      if (!current()) return;
      setPreviews((items) => new Map(items).set(preview.package.packageId, preview));
      const isSkillFile = manualPath.trim().replaceAll("\\", "/").split("/").at(-1) === "SKILL.md";
      const compatible = preview.package.entries.filter(
        (entry) => !entry.incompatibleReason && (!isSkillFile || entry.entryPath === "SKILL.md"),
      );
      if (!compatible.length) throw new Error("该路径没有可用技能入口。");
      const next = [...pending];
      for (const entry of compatible) {
        const choice: SkillPickerChoice = {
          kind: "package",
          selection: {
            packageId: preview.package.packageId,
            entryPath: entry.entryPath,
            activation: "on-demand",
          },
        };
        if (!next.some((item) => choiceKey(item) === choiceKey(choice))) next.push(choice);
      }
      setPending(next);
      setTopKeys(new Set(next.map(choiceKey)));
      setUndo(null);
      setMode("catalog");
      setSearch("");
      setSourceFilter("all");
      setOnlySelected(true);
      listRef.current?.scrollTo({ top: 0 });
    } catch (cause) {
      if (current()) setError(message(cause));
    } finally {
      if (current()) setBusy(false);
    }
  };
  const apply = async () => {
    if (busy || disabled || !connection.connected) return;
    const current = startRequest();
    try {
      const result = await resolveSkillChoices(pending, ensureExpertClient(), previews, current);
      if (!current()) return;
      onApply(result);
      changeOpen(false);
    } catch (cause) {
      if (current()) setError(message(cause));
    } finally {
      if (current()) setBusy(false);
      void queryClient.invalidateQueries({ queryKey: SKILL_PACKAGES_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: SKILL_PACKAGE_SOURCES_QUERY_KEY });
    }
  };
  const controlsDisabled = disabled || busy || !connection.connected;
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        aria-label="添加技能"
        onClick={() => changeOpen(true)}
      >
        <PlusIcon />
        添加
      </Button>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogPopup className="w-[min(54rem,calc(100vw-1.5rem))] max-w-none">
          <DialogHeader>
            <DialogTitle>添加技能至 · {expertName.trim() || "未命名专家"}</DialogTitle>
            <DialogDescription className="sr-only">
              选择技能，或复用专家的技能配置。应用后写入当前草稿。
            </DialogDescription>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SettingsSegmentedControl
                ariaLabel="技能添加方式"
                value={mode}
                onValueChange={setMode}
                options={[
                  { value: "catalog", label: "已发现" },
                  { value: "path", label: "按路径" },
                ]}
              />
              <Popover open={expertMenu} onOpenChange={setExpertMenu}>
                <PopoverTrigger
                  render={
                    <Button size="sm" variant="secondary" disabled={controlsDisabled}>
                      从专家复用技能
                      <ChevronDownIcon />
                    </Button>
                  }
                />
                <PopoverPopup align="end" className="w-72">
                  <div className="space-y-1" aria-label="选择来源专家">
                    {availableExperts.length > 8 ? (
                      <SearchInput
                        aria-label="搜索专家名称"
                        placeholder="搜索专家名称…"
                        value={expertSearch}
                        onChange={(event) => setExpertSearch(event.target.value)}
                      />
                    ) : null}
                    <div className="max-h-64 overflow-y-auto">
                      {availableExperts
                        .filter((expert) =>
                          expert.name
                            .toLocaleLowerCase()
                            .includes(expertSearch.trim().toLocaleLowerCase()),
                        )
                        .map((expert) => {
                          const choices = choicesForExpert(expert);
                          return (
                            <Button
                              key={expert.id}
                              size="sm"
                              variant="ghost"
                              className="w-full justify-between"
                              disabled={!choices.length || controlsDisabled}
                              onClick={() => reuse(expert)}
                              title={choices
                                .map((choice) =>
                                  choice.kind === "path"
                                    ? choice.reference.name
                                    : choice.selection.entryPath,
                                )
                                .join("、")}
                            >
                              <span className="truncate">{expert.name}</span>
                              <span className="shrink-0 text-ui-xs text-muted-foreground">
                                {choices.length ? `${choices.length} 项` : "暂无技能"}
                              </span>
                            </Button>
                          );
                        })}
                      {!availableExperts.some((expert) =>
                        expert.name
                          .toLocaleLowerCase()
                          .includes(expertSearch.trim().toLocaleLowerCase()),
                      ) ? (
                        <p className="py-2 text-ui-sm text-muted-foreground">没有匹配的专家</p>
                      ) : null}
                    </div>
                  </div>
                </PopoverPopup>
              </Popover>
            </div>
            {undo ? (
              <div
                role="status"
                className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted px-3 py-2 text-ui-sm"
              >
                <span>
                  已选择「{undo.name}」的{undo.count}项技能
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={controlsDisabled}
                  onClick={() => {
                    setPending(undo.choices);
                    setTopKeys(undo.topKeys);
                    setSearch(undo.search);
                    setSourceFilter(undo.source);
                    setOnlySelected(undo.only);
                    setUndo(null);
                    setError(null);
                  }}
                >
                  撤销此次覆盖
                </Button>
              </div>
            ) : null}
          </DialogHeader>
          <DialogPanel className="space-y-3">
            {error ? (
              <p className="text-ui-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
            {!connection.connected ? (
              <p className="text-ui-sm text-destructive" role="alert">
                服务器未连接，请连接后重试。
              </p>
            ) : null}
            {mode === "path" ? (
              <form
                id={formId}
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void previewPath();
                }}
              >
                <label className="block space-y-1 text-ui-sm">
                  <span>技能路径</span>
                  <Input
                    aria-label="新技能路径"
                    disabled={controlsDisabled}
                    placeholder="技能目录或 SKILL.md 路径"
                    value={manualPath}
                    onChange={(event) => setManualPath(event.target.value)}
                  />
                </label>
                <p className="text-ui-xs text-muted-foreground">
                  读取后在技能列表中选择。路径位于当前连接的服务器。
                </p>
              </form>
            ) : (
              <>
                <div className="flex gap-2">
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
                    <SelectTrigger aria-label="按技能来源筛选" className="w-32 shrink-0 sm:w-44">
                      <SelectValue>
                        {sourceFilter === "all" ? "全部来源" : sourceFilter}
                      </SelectValue>
                    </SelectTrigger>
                    <SettingsSelectPopup>
                      <SelectItem value="all">全部来源</SelectItem>
                      {sourceOptions.map((source) => (
                        <SelectItem key={source} value={source}>
                          {source}
                        </SelectItem>
                      ))}
                    </SettingsSelectPopup>
                  </Select>
                </div>
                <div className="flex items-center justify-between border-b border-border pb-2 text-ui-sm">
                  <span className="text-muted-foreground">已选 {pending.length} 项</span>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant={onlySelected ? "secondary" : "ghost"}
                      aria-pressed={onlySelected}
                      onClick={() => setOnlySelected(!onlySelected)}
                    >
                      仅看已选
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={controlsDisabled || !pending.length}
                      onClick={() => {
                        setPending([]);
                        setUndo(null);
                        setError(null);
                      }}
                    >
                      清空已选
                    </Button>
                  </div>
                </div>
                {catalogError ? (
                  <p className="text-ui-sm text-destructive" role="alert">
                    无法读取技能目录：{catalogError}
                  </p>
                ) : null}
                {catalogLoading ? (
                  <p className="text-ui-sm text-muted-foreground" role="status">
                    正在读取技能…
                  </p>
                ) : null}
                <div ref={listRef} className="max-h-[min(45vh,28rem)] overflow-y-auto">
                  {visible.length === 0 ? (
                    <p className="py-3 text-ui-sm text-muted-foreground">
                      {onlySelected ? "当前筛选下没有已选技能" : "无匹配技能"}
                    </p>
                  ) : (
                    <ul className="divide-y divide-border" aria-label="可选技能">
                      {visible.map((item, index) => {
                        const key = choiceKey(item.choice),
                          checked = selectedKeys.has(key),
                          id = `${formId}-skill-${index}`;
                        return (
                          <li key={key} className="flex min-w-0 items-center gap-3 py-3">
                            <Checkbox
                              id={id}
                              checked={checked}
                              disabled={controlsDisabled || (!checked && Boolean(item.issue))}
                              aria-label={`选择技能 ${item.name}`}
                              onCheckedChange={(value) => {
                                setPending((current) =>
                                  value === true
                                    ? [...current, item.choice]
                                    : current.filter((choice) => choiceKey(choice) !== key),
                                );
                                setUndo(null);
                                setError(null);
                              }}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex min-w-0 items-center gap-2">
                                <label
                                  htmlFor={id}
                                  className="cursor-pointer truncate text-ui font-medium"
                                >
                                  {item.name}
                                </label>
                                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-ui-xs text-muted-foreground">
                                  {item.source}
                                </span>
                              </div>
                              {item.description ? (
                                <p className="mt-1 truncate text-ui-sm text-muted-foreground">
                                  {item.description}
                                </p>
                              ) : null}
                              {item.issue ? (
                                <p className="text-ui-xs text-destructive">{item.issue}</p>
                              ) : null}
                            </div>
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <Button
                                    size="icon-sm"
                                    variant="ghost"
                                    aria-label={`查看技能路径 ${item.name}`}
                                  >
                                    <InfoIcon />
                                  </Button>
                                }
                              />
                              <TooltipPopup className="max-w-[min(32rem,calc(100vw-2rem))] whitespace-pre-wrap break-all text-ui-sm">
                                {item.fullDescription}
                                {"\n\n"}ID：
                                {item.choice.kind === "path"
                                  ? item.choice.reference.name
                                  : item.choice.selection.entryPath}
                                {"\n"}来源：{item.source}
                                {"\n"}
                                {item.path}
                              </TooltipPopup>
                            </Tooltip>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" onClick={() => changeOpen(false)}>
              取消
            </Button>
            {mode === "path" ? (
              <Button type="submit" form={formId} disabled={controlsDisabled || !manualPath.trim()}>
                {busy ? "正在读取…" : "读取技能"}
              </Button>
            ) : (
              <Button onClick={() => void apply()} disabled={controlsDisabled}>
                {busy ? "正在应用…" : `应用选择（${pending.length}）`}
              </Button>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
