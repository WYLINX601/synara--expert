import { useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  SkillDefinition,
  SkillEvolutionPolicy,
  SkillLibraryResponse,
  SkillScope,
} from "@synara/contracts";
import { SKILL_DOWNLOAD_ROUTE_PATH, SKILL_UPLOAD_ROUTE_PATH } from "@synara/shared/binaryTransfer";
import { ensureExpertClient } from "~/workbench/host/expertClient";
import { useTheme } from "~/hooks/useTheme";
import { InfoIcon, PlusIcon, Trash2 } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { CodeEditorPane } from "../codeEditor/CodeEditorPane";
import type { CodeEditHistoryControls } from "../codeEditor/pierreEdit";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Badge } from "../ui/badge";
import { Select, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Alert, AlertDescription } from "../ui/alert";
import { Combobox, ComboboxChip, ComboboxChips, ComboboxChipsInput } from "../ui/combobox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { formatShortDateTimestamp } from "~/timestampFormat";
import { SkillResourceTree } from "./SkillResourceTree";
import { SkillMarkdownPreview } from "./SkillMarkdownPreview";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { SKILL_LIBRARY_QUERY_KEY, SkillBindingControls } from "./ExpertSkillBindingsEditor";
import { SettingsSelectPopup } from "./SettingsPanelPrimitives";
import { useSkillPackageConnection } from "./skillPackageSettingsQueries";
import { useExpertDraftGuard } from "./useExpertDraftGuard";
import { tagsFrom, errorText, transfer, resourceParams } from "./skillLibraryFiles";

export function SkillLibraryDetail({
  initial,
  onClose,
  onChanged,
  onDelete,
}: {
  initial: SkillDefinition;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onDelete: (skill: SkillDefinition) => void;
}) {
  const { resolvedTheme } = useTheme(),
    connection = useSkillPackageConnection();
  const acceptedBase = useRef(initial);
  const [base, setBase] = useState(initial),
    [name, setName] = useState(initial.name),
    [description, setDescription] = useState(initial.description),
    [tags, setTags] = useState(initial.tags.join(", ")),
    [evolutionPolicy, setEvolutionPolicy] = useState<SkillEvolutionPolicy>(
      initial.evolutionPolicy ?? "protected",
    ),
    [scope, setScope] = useState<SkillScope>(initial.scope ?? { kind: "shared" });
  const [resourcePath, setResourcePath] = useState(initial.entryPath),
    [loadedPath, setLoadedPath] = useState<string | null>(null),
    [text, setTextState] = useState<string | null>(null),
    [savedText, setSavedText] = useState<string | null>(null),
    [version, setVersion] = useState(0);
  const textRef = useRef<string | null>(null),
    textVersion = useRef(0);
  const setText = (value: string | null) => {
    textRef.current = value;
    setTextState(value);
  };
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"overview" | "files" | "evolution">("overview");
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [addExperts, setAddExperts] = useState(false);
  const [expertSearch, setExpertSearch] = useState("");
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [scopeConfirmationOpen, setScopeConfirmationOpen] = useState(false);
  const scopeConfirmationResolver = useRef<((confirmed: boolean) => void) | null>(null);
  const [tagInput, setTagInput] = useState("");
  const tagValues = tagsFrom(tags);
  const draftTags = tagsFrom([tags, tagInput].join(", "));
  const commitTags = () => {
    setTags(draftTags.join(", "));
    setTagInput("");
  };
  const detailId = useId();
  const editorControls = useRef<CodeEditHistoryControls | null>(null);
  const readDraftText = () => {
    const currentText = textRef.current;
    return tab === "files" && mode === "edit" && loadedPath && currentText !== null
      ? (editorControls.current?.getText?.() ?? currentText)
      : currentText;
  };
  const generation = useRef(connection.generation);
  generation.current = connection.generation;
  const pkg = useQuery({
    queryKey: [...SKILL_LIBRARY_QUERY_KEY, "package", base.packageId, connection.generation],
    queryFn: () => ensureExpertClient().readSkillPackage({ packageId: base.packageId }),
    enabled: connection.connected,
  });
  const experts = useQuery({
    queryKey: ["server", "experts", connection.generation],
    queryFn: () => ensureExpertClient().listExperts(),
    enabled: connection.connected,
  });
  const contentDirty =
    name !== base.name ||
    description !== base.description ||
    JSON.stringify(draftTags) !== JSON.stringify(base.tags) ||
    text !== savedText;
  const baseScope = base.scope ?? { kind: "shared" as const };
  const scopeChanged =
    scope.kind !== baseScope.kind ||
    (scope.kind === "expert" &&
      baseScope.kind === "expert" &&
      scope.expertId !== baseScope.expertId);
  const metadataDirty = evolutionPolicy !== (base.evolutionPolicy ?? "protected") || scopeChanged;
  const dirty = contentDirty || metadataDirty;
  const checked = async <T,>(operation: Promise<T>) => {
    const started = connection.generation,
      result = await operation;
    if (generation.current !== started) throw new Error("服务器连接已更改，请重新读取技能。");
    return result;
  };
  const run = async (operation: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      return true;
    } catch (cause) {
      setError(errorText(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const readResource = async (skill: SkillDefinition, file: string): Promise<string | null> => {
    const bytes = await checked(
      transfer(`${SKILL_DOWNLOAD_ROUTE_PATH}?${resourceParams(skill, file)}`).then((response) =>
        response.arrayBuffer(),
      ),
    );
    try {
      const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return value.includes("\0") ? null : value;
    } catch {
      return null;
    }
  };
  const accept = async (
    result: SkillLibraryResponse,
    canonicalPath: string | null = loadedPath,
    submittedText?: { value: string | null; version: number },
  ) => {
    if (!result.skill) throw new Error("服务器未返回保存版本。");
    acceptedBase.current = result.skill;
    setBase(result.skill);
    setName(result.skill.name);
    setDescription(result.skill.description);
    setTags(result.skill.tags.join(", "));
    setEvolutionPolicy(result.skill.evolutionPolicy ?? "protected");
    setScope(result.skill.scope ?? { kind: "shared" });
    setTagInput("");
    if (canonicalPath) {
      let canonicalText: string | null;
      try {
        canonicalText = await readResource(result.skill, canonicalPath);
      } catch (cause) {
        if (submittedText) {
          const preserveDraft = textVersion.current !== submittedText.version;
          const currentDraft = preserveDraft ? readDraftText() : submittedText.value;
          editorControls.current = null;
          setText(currentDraft);
          setSavedText(null);
          setVersion((current) => current + 1);
        } else {
          editorControls.current = null;
          setLoadedPath(null);
          setText(null);
          setSavedText(null);
        }
        await onChanged();
        throw cause;
      }
      const preserveDraft =
        submittedText !== undefined && textVersion.current !== submittedText.version;
      const currentDraft = preserveDraft ? readDraftText() : null;
      editorControls.current = null;
      const acceptedText = preserveDraft ? currentDraft : canonicalText;
      setText(acceptedText);
      setSavedText(canonicalText);
      setVersion((current) => current + 1);
    }
    await onChanged();
  };
  const confirmScopeChange = () =>
    new Promise<boolean>((resolve) => {
      scopeConfirmationResolver.current = resolve;
      setScopeConfirmationOpen(true);
    });
  const resolveScopeChange = (confirmed: boolean) => {
    setScopeConfirmationOpen(false);
    const resolve = scopeConfirmationResolver.current;
    scopeConfirmationResolver.current = null;
    resolve?.(confirmed);
  };
  const save = () => {
    const draftText = readDraftText();
    if (draftText !== text) setText(draftText);
    const submittedText = { value: draftText, version: textVersion.current };
    const submittedPolicy = evolutionPolicy;
    const submittedScope = scope;
    return run(async () => {
      let result: SkillLibraryResponse | null = null;
      const currentBase = acceptedBase.current;
      const contentDraftDirty =
        name !== currentBase.name ||
        description !== currentBase.description ||
        JSON.stringify(draftTags) !== JSON.stringify(currentBase.tags) ||
        draftText !== savedText;
      if (metadataDirty && evolutionPolicy === "shared" && scope.kind !== "shared") {
        throw new Error("共享进化策略要求共享可用范围，请调整策略或范围后再保存。");
      }
      if (metadataDirty && scopeChanged && !(await confirmScopeChange())) {
        throw new Error("已取消范围变更。");
      }
      if (contentDraftDirty && draftText !== savedText && draftText !== null && loadedPath) {
        const params = resourceParams(currentBase, loadedPath);
        params.set("name", loadedPath.split("/").at(-1)!);
        params.set("skillName", name);
        params.set("tags", JSON.stringify(draftTags));
        if (description !== currentBase.description) params.set("description", description);
        result = await checked(
          transfer(`${SKILL_UPLOAD_ROUTE_PATH}?${params}`, {
            method: "POST",
            body: new Blob([draftText]),
          }).then((response) => response.json() as Promise<SkillLibraryResponse>),
        );
      } else if (contentDraftDirty)
        result = await checked(
          ensureExpertClient().skillLibrary({
            action: "save",
            skillId: currentBase.skillId,
            expectedRevision: currentBase.revision,
            name,
            ...(description !== currentBase.description ? { description } : {}),
            tags: draftTags,
            changes: [],
          }),
        );
      if (result) {
        await accept(result, loadedPath, submittedText);
        if (metadataDirty) {
          setEvolutionPolicy(submittedPolicy);
          setScope(submittedScope);
        }
      }
      if (!metadataDirty) return;
      const nextBase = acceptedBase.current;
      const configured = await checked(
        ensureExpertClient().skillLibrary({
          action: "configureEvolution",
          skillId: nextBase.skillId,
          expectedRevision: nextBase.revision,
          requestId: globalThis.crypto.randomUUID(),
          evolutionPolicy: submittedPolicy,
          scope: submittedScope,
        }),
      );
      await accept(configured, null);
    });
  };
  const guard = useExpertDraftGuard({
    isDirty: dirty,
    canSave: !busy && connection.connected,
    onSave: save,
    onDiscard: () => {
      setName(base.name);
      setDescription(base.description);
      setTags(base.tags.join(", "));
      setTagInput("");
      setText(savedText);
      setEvolutionPolicy(base.evolutionPolicy ?? "protected");
      setScope(base.scope ?? { kind: "shared" });
    },
  });
  const load = async (file: string) => {
    if (file === loadedPath) return;
    if (!(await guard.confirmLeave())) return;
    await run(async () => {
      const value = await readResource(acceptedBase.current, file);
      editorControls.current = null;
      setLoadedPath(file);
      setResourcePath(file);
      setText(value);
      setSavedText(value);
      setMode(/\.(?:md|markdown)$/iu.test(file) ? "preview" : "edit");
      setVersion((current) => current + 1);
    });
  };
  const close = () => {
    if (busy) return;
    void guard.confirmLeave().then((allowed) => {
      if (allowed) onClose();
    });
  };
  const paths = (pkg.data?.resources ?? [])
    .filter((resource) => resource.kind === "file")
    .map((resource) => resource.path.slice("content/".length));
  const activeExperts = (experts.data ?? []).filter((expert) => !expert.archived);
  const boundExperts = activeExperts.filter((expert) =>
    expert.skillBindings?.some((binding) => binding.skillId === base.skillId),
  );
  const changeTab = (next: typeof tab) => {
    if (next === tab) return;
    if (tab === "files") {
      const draftText = readDraftText();
      if (draftText !== text) setText(draftText);
      editorControls.current = null;
    }
    if (next === "files") setVersion((current) => current + 1);
    setTab(next);
    if (next === "files" && !loadedPath) void load(acceptedBase.current.entryPath);
  };
  const bindings = (expert: (typeof activeExperts)[number]) =>
    expert.skillBindings === undefined &&
    (expert.skills.length || expert.skillSelections?.length) ? (
      <span className="text-ui-sm text-muted-foreground">
        仍使用原装配；请先在专家页“改用技能库装配”，确认替换后再绑定。
      </span>
    ) : (
      <SkillBindingControls
        skillId={base.skillId}
        bindings={expert.skillBindings ?? []}
        disabled={busy || !connection.connected}
        onChange={(skillBindings) =>
          void run(async () => {
            const result = await checked(
              ensureExpertClient().skillLibrary({
                action: "bindings",
                operation: "set",
                expertId: expert.id,
                expectedRevision: expert.revision,
                requestId: globalThis.crypto.randomUUID(),
                bindings: skillBindings,
              }),
            );
            if (
              result.bindingResult?.status &&
              !["applied", "unchanged"].includes(result.bindingResult.status)
            )
              throw new Error(result.bindingResult.error ?? "专家技能绑定未能保存。");
            await experts.refetch();
            await onChanged();
          })
        }
      />
    );
  const addExpertButton = (
    <Button
      variant="outline"
      size="sm"
      disabled={busy || !connection.connected}
      onClick={() => setAddExperts((value) => !value)}
    >
      <PlusIcon className="size-4" />
      添加到专家
    </Button>
  );
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogPopup
          id={`${detailId}-dialog`}
          initialFocus={() =>
            document
              .getElementById(`${detailId}-dialog`)
              ?.querySelector<HTMLButtonElement>('[aria-label="关闭技能详情"]') ?? true
          }
          closeButtonClassName="size-9 sm:size-9"
          closeButtonLabel="关闭技能详情"
          className="h-[min(48rem,calc(100dvh-5rem))] max-h-[85dvh] w-[calc(100vw-3rem)] max-w-[57.5rem] rounded-xl max-sm:h-[calc(100dvh-3rem)] max-sm:w-full max-sm:max-h-[calc(100dvh-3rem)]"
        >
          <DialogHeader className="shrink-0 gap-3 px-6 pt-5 pb-4 in-[[data-slot=dialog-popup]:has([data-slot=dialog-panel])]:pb-4">
            <DialogTitle className="break-words pr-8">{base.name}</DialogTitle>
            <DialogDescription className="flex flex-wrap items-center gap-x-2 gap-y-2 pr-7 text-ui-sm text-foreground/75">
              <Badge
                variant="secondary"
                className="h-auto rounded-full bg-muted px-2 py-0.5 text-ui-sm text-foreground/80 sm:h-auto sm:text-ui-sm"
              >
                {
                  (
                    {
                      manual: "手动创建",
                      local: "本地导入",
                      archive: "压缩包导入",
                      url: "URL 导入",
                      runtime: "运行时副本",
                    } as const
                  )[base.source.kind]
                }
              </Badge>
              {[
                pkg.data ? `${paths.length} 个文件` : "正在读取文件…",
                experts.data ? `${boundExperts.length} 个专家使用` : "正在读取专家…",
                `添加者：${base.createdBy ?? "未知"}`,
                `更新时间：${formatShortDateTimestamp(base.updatedAt, "locale")}`,
              ].map((item) => (
                <span key={item} className="inline-flex min-w-0 items-center gap-2">
                  <span aria-hidden="true" className="text-foreground/50">
                    ·
                  </span>
                  <span className="break-words">{item}</span>
                </span>
              ))}
            </DialogDescription>
          </DialogHeader>
          <div
            role="tablist"
            aria-label="技能详情页签"
            className="flex shrink-0 gap-6 border-b border-border px-6"
            onKeyDown={(event) => {
              if (busy) return;
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const tabs = ["overview", "files", "evolution"] as const;
              const currentIndex = tabs.indexOf(tab);
              const next =
                event.key === "Home"
                  ? tabs[0]!
                  : event.key === "End"
                    ? tabs[tabs.length - 1]!
                    : (tabs[
                        (currentIndex + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) %
                          tabs.length
                      ] ?? tab);
              changeTab(next);
              document.getElementById(`${detailId}-${next}-tab`)?.focus();
            }}
          >
            {(["overview", "files", "evolution"] as const).map((item) => (
              <Button
                key={item}
                id={`${detailId}-${item}-tab`}
                role="tab"
                disabled={busy}
                aria-selected={tab === item}
                aria-controls={`${detailId}-${item}-panel`}
                tabIndex={tab === item ? 0 : -1}
                size="sm"
                variant="ghost"
                className="h-auto gap-2 rounded-none px-0 py-0 text-foreground/75 hover:bg-transparent aria-selected:text-foreground sm:h-auto"
                onClick={() => changeTab(item)}
              >
                <span
                  className={cn(
                    "border-b-2 py-3",
                    tab === item ? "border-foreground" : "border-transparent",
                  )}
                >
                  {item === "overview" ? "概览" : item === "files" ? "文件" : "进化策略"}
                </span>
                {item === "files" && pkg.data ? (
                  <Badge
                    variant="secondary"
                    className="h-auto rounded-full bg-muted px-1.5 py-0.5 text-ui-sm text-foreground/80 sm:h-auto sm:text-ui-sm"
                  >
                    {paths.length}
                  </Badge>
                ) : null}
              </Button>
            ))}
          </div>
          {error || !connection.connected || pkg.isError ? (
            <p role="alert" className="shrink-0 px-4 py-2 text-ui-sm text-destructive">
              {error ??
                (!connection.connected
                  ? "服务器未连接，暂时无法保存。"
                  : "包内容无法读取或完整性校验失败。")}
            </p>
          ) : null}
          {tab === "overview" ? (
            <DialogPanel
              scrollFade={false}
              viewportTabIndex={-1}
              className="px-6 py-6 [&_[data-slot=textarea-control]]:min-h-0"
            >
              <section
                role="tabpanel"
                id={`${detailId}-overview-panel`}
                aria-labelledby={`${detailId}-overview-tab`}
                className="w-full space-y-7 py-6"
              >
                <div className="space-y-5">
                  <h2 className="text-ui-lg font-semibold">属性</h2>
                  <div className="space-y-5">
                    <label className="grid min-w-0 gap-2 sm:grid-cols-[5rem_minmax(0,1fr)] sm:gap-4">
                      <span className="pt-2 text-ui-sm font-medium text-foreground/80">名称</span>
                      <Input
                        aria-label="技能名称"
                        value={name}
                        disabled={busy}
                        onChange={(event) => setName(event.target.value)}
                      />
                    </label>
                    <label className="grid min-w-0 gap-2 sm:grid-cols-[5rem_minmax(0,1fr)] sm:gap-4">
                      <span className="pt-2 text-ui-sm font-medium text-foreground/80">描述</span>
                      <span className="grid min-w-0 gap-2">
                        <Textarea
                          aria-label="技能描述"
                          className="border-border bg-muted/20 [&_[data-slot=textarea]]:min-h-[4lh]"
                          size="compact"
                          value={description}
                          maxLength={20_000}
                          rows={3}
                          disabled={busy}
                          onChange={(event) => setDescription(event.target.value)}
                        />
                        <span className="flex flex-wrap justify-between gap-2 text-ui-sm text-foreground/75">
                          <span>专家依据描述判断何时使用这个技能。</span>
                          <span>{description.length} 个字符</span>
                        </span>
                      </span>
                    </label>
                    <div className="grid min-w-0 gap-2 sm:grid-cols-[5rem_minmax(0,1fr)] sm:gap-4">
                      <span
                        id={`${detailId}-tags-label`}
                        className="pt-2 text-ui-sm font-medium text-foreground/80"
                      >
                        标签
                      </span>
                      <Combobox
                        multiple
                        value={tagValues}
                        inputValue={tagInput}
                        open={false}
                        disabled={busy}
                        onValueChange={(values) => setTags(values.join(", "))}
                        onInputValueChange={setTagInput}
                      >
                        <ComboboxChips
                          aria-labelledby={`${detailId}-tags-label`}
                          className="min-w-0 border-border"
                        >
                          {tagValues.map((tag) => (
                            <ComboboxChip
                              key={tag}
                              className="max-w-full min-w-0 rounded-full"
                              removeButtonProps={{
                                "aria-label": `移除标签 ${tag}`,
                                className:
                                  "min-h-6 min-w-6 rounded-full focus-visible:outline-2 focus-visible:outline-ring",
                              }}
                            >
                              <span className="min-w-0 break-all">{tag}</span>
                            </ComboboxChip>
                          ))}
                          <ComboboxChipsInput
                            aria-label="技能标签"
                            placeholder="添加标签…"
                            className="min-w-24 placeholder:text-foreground/65"
                            onBlur={commitTags}
                            onKeyDown={(event) => {
                              if (event.nativeEvent.isComposing) return;
                              if (
                                event.key === "Enter" ||
                                event.key === "," ||
                                event.key === "，"
                              ) {
                                event.preventDefault();
                                commitTags();
                              }
                            }}
                          />
                        </ComboboxChips>
                      </Combobox>
                    </div>
                  </div>
                </div>
                <section className="space-y-3" aria-label="绑定专家">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-ui-lg font-semibold">
                      被 {boundExperts.length} 个专家使用
                    </h2>
                    {boundExperts.length > 0 ? addExpertButton : null}
                  </div>
                  {experts.isPending ? (
                    <p role="status" className="text-ui-sm text-muted-foreground">
                      正在读取专家…
                    </p>
                  ) : experts.isError ? (
                    <p role="alert" className="text-ui-sm text-destructive">
                      无法读取专家，请重新打开详情。
                    </p>
                  ) : !boundExperts.length ? (
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-border bg-muted/40 p-4 text-ui-sm text-foreground/75">
                      <p>尚未绑定专家。</p>
                      {addExpertButton}
                    </div>
                  ) : (
                    <ul className="divide-y divide-border rounded-xl border border-border px-4">
                      {boundExperts.map((expert) => (
                        <li
                          key={expert.id}
                          className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-3"
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block break-words text-ui font-medium">
                              {expert.name}
                            </span>
                            <span className="block break-words text-ui-sm text-foreground/75">
                              {expert.description}
                            </span>
                          </span>
                          {bindings(expert)}
                        </li>
                      ))}
                    </ul>
                  )}
                  {addExperts ? (
                    <div className="space-y-3 rounded-xl border border-border p-4">
                      <Input
                        aria-label="搜索待绑定专家"
                        placeholder="搜索专家"
                        value={expertSearch}
                        onChange={(event) => setExpertSearch(event.target.value)}
                      />
                      <ul className="max-h-64 divide-y divide-border overflow-auto">
                        {activeExperts
                          .filter(
                            (expert) =>
                              !boundExperts.some((bound) => bound.id === expert.id) &&
                              `${expert.name} ${expert.description}`
                                .toLocaleLowerCase()
                                .includes(expertSearch.toLocaleLowerCase()),
                          )
                          .map((expert) => (
                            <li
                              key={expert.id}
                              className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-3"
                            >
                              <span className="min-w-0 flex-1 break-words text-ui">
                                {expert.name}
                              </span>
                              {bindings(expert)}
                            </li>
                          ))}
                      </ul>
                      <Button size="sm" variant="ghost" onClick={() => setAddExperts(false)}>
                        收起专家选择
                      </Button>
                    </div>
                  ) : null}
                </section>
                <div className="space-y-3">
                  <Collapsible open={sourceOpen} onOpenChange={setSourceOpen}>
                    <CollapsibleTrigger
                      render={
                        <Button variant="ghost" size="sm" className="px-0 text-foreground/75" />
                      }
                    >
                      <DisclosureChevron open={sourceOpen} />
                      来源与版本
                    </CollapsibleTrigger>
                    <CollapsiblePanel>
                      <div className="space-y-2 break-all rounded-lg bg-muted p-4 text-ui-sm text-foreground/75">
                        <p>来源：{base.source.location || "手动创建"}</p>
                        {base.source.resolvedRevision ? (
                          <p>来源版本：{base.source.resolvedRevision}</p>
                        ) : null}
                        <p>
                          技能：{base.skillId} · r{base.revision}
                        </p>
                        <p>内容包：{base.packageId}</p>
                        <p>
                          {base.locallyModified ? "有本地编辑。" : ""}{" "}
                          {pkg.isSuccess
                            ? "包内容校验通过；运行依赖和原生装配在任务启动时验证。"
                            : "正在校验包内容…"}
                        </p>
                        {pkg.data?.entries
                          .find((entry) => entry.entryPath === base.entryPath)
                          ?.issues.map((issue) => (
                            <p key={issue}>{issue}</p>
                          ))}
                      </div>
                    </CollapsiblePanel>
                  </Collapsible>
                  <Alert
                    role="note"
                    aria-label="技能更新说明"
                    className="border-0 border-l-2 border-l-border bg-muted/40 text-ui-sm [&>svg]:text-foreground/75"
                  >
                    <InfoIcon aria-hidden="true" />
                    <AlertDescription className="text-foreground/75">
                      修改在专家下一次运行时生效，当前运行及其恢复仍使用原版本。来源保持只读，脚本和安装步骤不会自动执行。
                    </AlertDescription>
                  </Alert>
                </div>
              </section>
            </DialogPanel>
          ) : tab === "files" ? (
            <section
              role="tabpanel"
              id={`${detailId}-files-panel`}
              aria-labelledby={`${detailId}-files-tab`}
              className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[14rem_minmax(0,1fr)] md:grid-rows-1"
            >
              <aside className="min-h-0 min-w-0 overflow-y-auto border-b border-border p-3 max-md:max-h-44 md:border-r md:border-b-0">
                <SkillResourceTree
                  paths={paths}
                  entryPath={base.entryPath}
                  selectedPath={loadedPath}
                  disabled={busy}
                  theme={resolvedTheme}
                  onSelect={(file) => void load(file)}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-3"
                  disabled={busy || dirty || !connection.connected}
                  onClick={() => {
                    setNewFileOpen(true);
                    setResourcePath("");
                  }}
                >
                  ＋ 新建文件
                </Button>
              </aside>
              <div className="flex min-h-0 min-w-0 flex-col">
                <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
                  <span className="min-w-0 flex-1 break-all text-ui-sm text-muted-foreground">
                    {loadedPath || "选择一个文件"}
                  </span>
                  <div role="group" aria-label="文件查看模式" className="flex gap-1">
                    <Button
                      variant={mode === "preview" ? "secondary" : "ghost"}
                      size="sm"
                      aria-pressed={mode === "preview"}
                      onClick={() => {
                        const draftText = readDraftText();
                        if (draftText !== text) setText(draftText);
                        editorControls.current = null;
                        setMode("preview");
                      }}
                    >
                      预览
                    </Button>
                    <Button
                      variant={mode === "edit" ? "secondary" : "ghost"}
                      size="sm"
                      aria-pressed={mode === "edit"}
                      disabled={text === null}
                      onClick={() => {
                        if (mode !== "edit") {
                          editorControls.current = null;
                          setVersion((current) => current + 1);
                        }
                        setMode("edit");
                      }}
                    >
                      编辑
                    </Button>
                  </div>
                </div>
                {newFileOpen ? (
                  <div className="flex shrink-0 flex-wrap gap-2 border-b border-border p-3">
                    <Input
                      aria-label="资源相对路径"
                      className="min-w-0 flex-1 basis-48"
                      placeholder="例如 references/notes.md"
                      value={resourcePath}
                      onChange={(event) => setResourcePath(event.target.value)}
                    />
                    <Button
                      size="sm"
                      disabled={
                        busy || dirty || !resourcePath.trim() || paths.includes(resourcePath.trim())
                      }
                      onClick={() => {
                        setLoadedPath(resourcePath.trim());
                        // Seed one empty line so the virtual editor has a render row.
                        setText("\n");
                        editorControls.current = null;
                        setSavedText(null);
                        setMode("edit");
                        setNewFileOpen(false);
                        setVersion((current) => current + 1);
                      }}
                    >
                      新建文本
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setNewFileOpen(false)}>
                      取消新建
                    </Button>
                  </div>
                ) : null}
                <div className="min-h-0 flex-1 overflow-auto" aria-label="文件内容">
                  {loadedPath && text !== null ? (
                    mode === "edit" ? (
                      <div className="h-full min-h-64">
                        <CodeEditorPane
                          key={`${loadedPath}:${version}`}
                          cacheKeyPrefix={`skill:${base.skillId}:${detailId}`}
                          historyControlsRef={editorControls}
                          fileName={loadedPath}
                          value={text}
                          valueVersion={version}
                          resolvedTheme={resolvedTheme}
                          onChange={(value) => {
                            textVersion.current += 1;
                            setText(value);
                          }}
                          onSave={() => {
                            if (!busy) void save();
                          }}
                        />
                      </div>
                    ) : /\.(?:md|markdown)$/iu.test(loadedPath) ? (
                      <div className="mx-auto max-w-4xl p-5 md:p-8">
                        <SkillMarkdownPreview
                          text={text}
                          currentPath={loadedPath}
                          paths={paths}
                          onOpenResource={(file) => void load(file)}
                        />
                      </div>
                    ) : (
                      <pre className="min-w-0 whitespace-pre p-5 text-ui-sm">
                        <code>{text}</code>
                      </pre>
                    )
                  ) : (
                    <p className="p-8 text-ui-sm text-muted-foreground">
                      {busy
                        ? "正在读取文件…"
                        : loadedPath
                          ? "二进制资源可下载或上传替换。"
                          : "选择主文件或附属文件进行预览和编辑。"}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-4 py-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !loadedPath}
                    onClick={() =>
                      void run(async () => {
                        const blob = await checked(
                          transfer(
                            `${SKILL_DOWNLOAD_ROUTE_PATH}?${resourceParams(base, loadedPath!)}`,
                          ).then((response) => response.blob()),
                        );
                        const url = URL.createObjectURL(blob),
                          link = document.createElement("a");
                        link.href = url;
                        link.download = loadedPath!.split("/").at(-1)!;
                        link.click();
                        URL.revokeObjectURL(url);
                      })
                    }
                  >
                    下载资源
                  </Button>
                  <label className="inline-flex cursor-pointer items-center rounded-md border border-border px-3 py-1 text-ui-sm">
                    上传／替换资源
                    <Input
                      className="hidden"
                      type="file"
                      aria-label="上传技能资源"
                      disabled={busy || dirty || !connection.connected}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (!file) return;
                        void run(async () => {
                          const params = resourceParams(base, resourcePath || file.name);
                          params.set("name", file.name);
                          const result = await checked(
                            transfer(`${SKILL_UPLOAD_ROUTE_PATH}?${params}`, {
                              method: "POST",
                              body: file,
                            }).then((response) => response.json() as Promise<SkillLibraryResponse>),
                          );
                          await accept(result, null);
                          setLoadedPath(null);
                          setText(null);
                          setSavedText(null);
                        });
                        event.target.value = "";
                      }}
                    />
                  </label>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || dirty || !loadedPath || loadedPath === base.entryPath}
                    onClick={() =>
                      void run(async () => {
                        await accept(
                          await checked(
                            ensureExpertClient().skillLibrary({
                              action: "save",
                              skillId: base.skillId,
                              expectedRevision: base.revision,
                              name: base.name,
                              tags: base.tags,
                              changes: [{ path: loadedPath! }],
                            }),
                          ),
                          null,
                        );
                        setLoadedPath(null);
                        setText(null);
                        setSavedText(null);
                      })
                    }
                  >
                    删除资源
                  </Button>
                </div>
              </div>
            </section>
          ) : (
            <DialogPanel
              scrollFade={false}
              viewportTabIndex={-1}
              className="px-6 py-6 [&_[data-slot=textarea-control]]:min-h-0"
            >
              <section
                role="tabpanel"
                id={`${detailId}-evolution-panel`}
                aria-labelledby={`${detailId}-evolution-tab`}
                className="mx-auto w-full max-w-3xl space-y-6 py-6"
              >
                <div className="space-y-2">
                  <h2 className="text-ui-lg font-semibold">进化策略与可用范围</h2>
                  <p className="text-ui-sm text-muted-foreground">
                    历史 Skill
                    缺省为受保护、共享可用。策略与范围只由用户保存；提炼候选不能替你修改这些设置。
                  </p>
                </div>
                <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                  <label className="grid min-w-0 gap-2 text-ui-sm">
                    <span className="font-medium">进化策略</span>
                    <Select
                      value={evolutionPolicy}
                      disabled={busy || !connection.connected}
                      onValueChange={(value) => {
                        if (value === "protected" || value === "shared" || value === "independent")
                          setEvolutionPolicy(value);
                      }}
                    >
                      <SelectTrigger aria-label="Skill 进化策略" className="w-full">
                        <SelectValue>
                          {evolutionPolicy === "protected"
                            ? "受保护"
                            : evolutionPolicy === "shared"
                              ? "共享进化"
                              : "独立进化"}
                        </SelectValue>
                      </SelectTrigger>
                      <SettingsSelectPopup>
                        <SelectItem value="protected">受保护</SelectItem>
                        <SelectItem value="shared">共享进化</SelectItem>
                        <SelectItem value="independent">独立进化</SelectItem>
                      </SettingsSelectPopup>
                    </Select>
                  </label>
                  <label className="grid min-w-0 gap-2 text-ui-sm">
                    <span className="font-medium">可用范围</span>
                    <Select
                      value={scope.kind === "shared" ? "shared" : scope.expertId}
                      disabled={busy || !connection.connected}
                      onValueChange={(value) => {
                        if (value === null) return;
                        setScope(
                          value === "shared"
                            ? { kind: "shared" }
                            : { kind: "expert", expertId: value },
                        );
                      }}
                    >
                      <SelectTrigger aria-label="Skill 可用范围" className="w-full">
                        <SelectValue>
                          {scope.kind === "shared"
                            ? "共享可用"
                            : `仅限 ${activeExperts.find((expert) => expert.id === scope.expertId)?.name ?? scope.expertId}`}
                        </SelectValue>
                      </SelectTrigger>
                      <SettingsSelectPopup>
                        <SelectItem value="shared">共享可用</SelectItem>
                        {scope.kind === "expert" &&
                        !activeExperts.some((expert) => expert.id === scope.expertId) ? (
                          <SelectItem value={scope.expertId}>
                            {scope.expertId} · 当前归属
                          </SelectItem>
                        ) : null}
                        {activeExperts.map((expert) => (
                          <SelectItem key={expert.id} value={expert.id}>
                            {expert.name}
                          </SelectItem>
                        ))}
                      </SettingsSelectPopup>
                    </Select>
                    {scope.kind === "expert" ? (
                      <span className="text-ui-xs text-muted-foreground">
                        专用范围只允许所选专家装配此 Skill；其他专家不会自动绑定。
                      </span>
                    ) : null}
                  </label>
                </div>
                <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-4 text-ui-sm">
                  <p>
                    <strong>受保护：</strong>采用前需要对本次准确差异明确认可。
                  </p>
                  <p>
                    <strong>共享进化：</strong>
                    只接受通用方法；共享版本更新会影响所有引用专家的下一次独立运行。
                  </p>
                  <p>
                    <strong>独立进化：</strong>
                    共享来源保持共享；每个专家首次采用时创建自己的完整副本，之后只更新自己的副本。
                  </p>
                  {base.derivedFrom ? (
                    <p className="break-all text-ui-xs text-muted-foreground">
                      派生来源：{base.derivedFrom.skillId} · v{base.derivedFrom.revision} ·{" "}
                      {base.derivedFrom.packageId}
                    </p>
                  ) : null}
                  {scopeChanged ? (
                    <p className="border-t border-border pt-2 text-ui-sm" role="status">
                      范围变更会影响 Skill 的读取与装配资格；当前 {boundExperts.length} 个专家引用此
                      Skill。保存时将再次展示确认，且不会自动绑定其他专家。
                    </p>
                  ) : null}
                  {evolutionPolicy === "shared" && scope.kind !== "shared" ? (
                    <p className="text-ui-sm text-destructive" role="alert">
                      共享进化要求“共享可用”范围。
                    </p>
                  ) : null}
                  {evolutionPolicy !== (base.evolutionPolicy ?? "protected") || scopeChanged ? (
                    <p className="text-ui-xs text-muted-foreground">策略或范围尚未保存。</p>
                  ) : null}
                </div>
              </section>
            </DialogPanel>
          )}
          <DialogFooter className="shrink-0 flex-row flex-wrap items-center border-t border-border px-6">
            <div className="mr-auto flex min-w-0 flex-wrap items-center gap-2">
              {tab === "overview" ? (
                <Button
                  variant="ghost"
                  className="text-destructive hover:bg-destructive/10"
                  disabled={busy || !connection.connected}
                  onClick={() =>
                    void guard.confirmLeave().then((allowed) => {
                      if (allowed) onDelete(acceptedBase.current);
                    })
                  }
                >
                  <Trash2 className="size-4" />
                  删除技能
                </Button>
              ) : null}
              {dirty ? (
                <span role="status" className="text-ui-sm text-foreground/75">
                  有未保存的更改
                </span>
              ) : null}
            </div>
            <Button variant="outline" disabled={busy} onClick={close}>
              关闭
            </Button>
            <Button
              className="disabled:pointer-events-auto disabled:cursor-not-allowed disabled:opacity-50"
              disabled={busy || !dirty || !connection.connected || !name.trim()}
              onClick={() => void save()}
            >
              {metadataDirty && !contentDirty ? "保存进化策略" : "保存更改"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={scopeConfirmationOpen}
        onOpenChange={(open) => {
          if (!open) resolveScopeChange(false);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>确认更改 Skill 可用范围</DialogTitle>
            <DialogDescription>
              范围将从{" "}
              {baseScope.kind === "shared" ? "共享可用" : `专家专用（${baseScope.expertId}）`} 改为{" "}
              {scope.kind === "shared" ? "共享可用" : `专家专用（${scope.expertId}）`}。 当前有{" "}
              {boundExperts.length} 个专家引用此
              Skill。保存会重新校验其读取和装配资格，不会自动绑定其他专家，也不会覆盖上游 Skill。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => resolveScopeChange(false)}>
              取消
            </Button>
            <Button onClick={() => resolveScopeChange(true)}>确认并保存范围</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      {guard.dialog}
    </>
  );
}
