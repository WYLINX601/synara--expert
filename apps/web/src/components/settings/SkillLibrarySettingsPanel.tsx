import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  SkillDefinition,
  SkillImportChoice,
  SkillLibraryPreview,
  SkillLibraryRequest,
  SkillLibraryResponse,
} from "@synara/contracts";
import { SKILL_DOWNLOAD_ROUTE_PATH, SKILL_UPLOAD_ROUTE_PATH } from "@synara/shared/binaryTransfer";
import { ensureExpertClient } from "~/workbench/host/expertClient";
import { resolveWsHttpUrl } from "~/lib/wsHttpUrl";
import { skillsCatalogQueryOptions } from "~/lib/providerDiscoveryReactQuery";
import { useTheme } from "~/hooks/useTheme";
import { CodeEditorPane } from "../codeEditor/CodeEditorPane";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Select, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { SettingsSection, SettingsSelectPopup } from "./SettingsPanelPrimitives";
import { SKILL_LIBRARY_QUERY_KEY, SkillBindingControls } from "./ExpertSkillBindingsEditor";
import { useSkillPackageConnection } from "./skillPackageSettingsQueries";
import { useExpertDraftGuard } from "./useExpertDraftGuard";

const tagsFrom = (text: string) => [
  ...new Set(
    text
      .split(/[,，]/u)
      .map((tag) => tag.trim())
      .filter(Boolean),
  ),
];
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
async function transfer(route: string, options?: RequestInit): Promise<Response> {
  const response = await fetch(resolveWsHttpUrl(route), { credentials: "include", ...options });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `HTTP ${response.status}`);
  }
  return response;
}
const resourceParams = (skill: SkillDefinition, resourcePath: string) =>
  new URLSearchParams({
    skillId: skill.skillId,
    path: resourcePath,
    expectedRevision: String(skill.revision),
  });

function SkillLibraryDetail({
  initial,
  onClose,
  onChanged,
}: {
  initial: SkillDefinition;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { resolvedTheme } = useTheme(),
    connection = useSkillPackageConnection();
  const acceptedBase = useRef(initial);
  const [base, setBase] = useState(initial),
    [name, setName] = useState(initial.name),
    [tags, setTags] = useState(initial.tags.join(", "));
  const [resourcePath, setResourcePath] = useState(initial.entryPath),
    [loadedPath, setLoadedPath] = useState<string | null>(null),
    [text, setText] = useState<string | null>(null),
    [savedText, setSavedText] = useState<string | null>(null),
    [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
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
  const dirty =
    name !== base.name ||
    JSON.stringify(tagsFrom(tags)) !== JSON.stringify(base.tags) ||
    text !== savedText;
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
  ) => {
    if (!result.skill) throw new Error("服务器未返回保存版本。");
    acceptedBase.current = result.skill;
    setBase(result.skill);
    setName(result.skill.name);
    setTags(result.skill.tags.join(", "));
    if (canonicalPath) {
      setText(null);
      setSavedText(null);
      try {
        const canonical = await readResource(result.skill, canonicalPath);
        setText(canonical);
        setSavedText(canonical);
        setVersion((current) => current + 1);
      } catch (cause) {
        setLoadedPath(null);
        throw cause;
      }
    }
    await onChanged();
  };
  const save = () =>
    run(async () => {
      let result: SkillLibraryResponse;
      const currentBase = acceptedBase.current;
      if (text !== savedText && text !== null && loadedPath) {
        const params = resourceParams(currentBase, loadedPath);
        params.set("name", loadedPath.split("/").at(-1)!);
        params.set("skillName", name);
        params.set("tags", JSON.stringify(tagsFrom(tags)));
        result = await checked(
          transfer(`${SKILL_UPLOAD_ROUTE_PATH}?${params}`, {
            method: "POST",
            body: new Blob([text]),
          }).then((response) => response.json() as Promise<SkillLibraryResponse>),
        );
      } else
        result = await checked(
          ensureExpertClient().skillLibrary({
            action: "save",
            skillId: currentBase.skillId,
            expectedRevision: currentBase.revision,
            name,
            tags: tagsFrom(tags),
            changes: [],
          }),
        );
      await accept(result);
    });
  const guard = useExpertDraftGuard({
    isDirty: dirty,
    canSave: !busy && connection.connected,
    onSave: save,
    onDiscard: () => {
      setName(base.name);
      setTags(base.tags.join(", "));
      setText(savedText);
    },
  });
  const load = async (file: string) => {
    if (!(await guard.confirmLeave())) return;
    await run(async () => {
      const value = await readResource(acceptedBase.current, file);
      setLoadedPath(file);
      setResourcePath(file);
      setText(value);
      setSavedText(value);
      setVersion((current) => current + 1);
    });
  };
  const close = () => {
    void guard.confirmLeave().then((allowed) => {
      if (allowed) onClose();
    });
  };
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogPopup className="w-[min(68rem,calc(100vw-1.5rem))] max-w-[68rem]">
          <DialogHeader>
            <DialogTitle>{base.name}</DialogTitle>
            <DialogDescription>
              编辑托管版本。来源保持只读；脚本与安装步骤不会自动执行。
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            {error ? (
              <p role="alert" className="text-ui-sm text-destructive">
                {error}
              </p>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-ui-sm">
                名称
                <Input
                  aria-label="技能名称"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={busy}
                />
              </label>
              <label className="space-y-1 text-ui-sm">
                标签
                <Input
                  aria-label="技能标签"
                  value={tags}
                  onChange={(event) => setTags(event.target.value)}
                  disabled={busy}
                  placeholder="用逗号分隔"
                />
              </label>
            </div>
            <p className="break-all text-ui-xs text-muted-foreground">
              {base.skillId} · r{base.revision} · {base.packageId}
              <br />
              来源：{base.source.kind} · {base.source.location || "手动创建"}
              {base.source.resolvedRevision ? ` · 来源版本 ${base.source.resolvedRevision}` : ""}
              {base.locallyModified ? " · 有本地编辑" : ""}
            </p>
            <p className="text-ui-sm text-muted-foreground">
              {pkg.isSuccess
                ? "包内容校验通过；运行依赖和原生装配在任务启动时验证。"
                : "正在校验包内容…"}
            </p>
            {pkg.isError ? (
              <p role="alert" className="text-ui-sm text-destructive">
                包内容无法读取或完整性校验失败。
              </p>
            ) : null}
            {pkg.data?.entries
              .find((entry) => entry.entryPath === base.entryPath)
              ?.issues.map((issue) => (
                <p key={issue} className="text-ui-sm text-muted-foreground">
                  {issue}
                </p>
              ))}
            <div className="grid gap-3 md:grid-cols-[14rem_minmax(0,1fr)]">
              <ul
                className="max-h-80 space-y-1 overflow-auto rounded-lg border border-border p-2"
                aria-label="技能资源"
              >
                {pkg.data?.resources
                  .filter((resource) => resource.kind === "file")
                  .map((resource) => {
                    const file = resource.path.slice("content/".length);
                    return (
                      <li key={resource.path}>
                        <Button
                          variant={file === loadedPath ? "secondary" : "ghost"}
                          size="sm"
                          className="h-auto w-full justify-start whitespace-normal break-all text-left"
                          disabled={busy}
                          onClick={() => void load(file)}
                        >
                          {file} · {resource.size.toLocaleString()} B
                        </Button>
                      </li>
                    );
                  })}
              </ul>
              <div className="min-w-0 space-y-2">
                <div className="flex gap-2">
                  <Input
                    aria-label="资源相对路径"
                    value={resourcePath}
                    onChange={(event) => setResourcePath(event.target.value)}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || dirty || !resourcePath}
                    onClick={() => {
                      setLoadedPath(resourcePath);
                      setText("");
                      setSavedText(null);
                      setVersion((current) => current + 1);
                    }}
                  >
                    新建文本
                  </Button>
                </div>
                {loadedPath && text !== null ? (
                  <div className="h-80 overflow-auto rounded-lg border border-border">
                    <CodeEditorPane
                      fileName={loadedPath}
                      value={text}
                      valueVersion={version}
                      resolvedTheme={resolvedTheme}
                      onChange={setText}
                      onSave={() => {
                        if (!busy) void save();
                      }}
                    />
                  </div>
                ) : (
                  <p className="py-8 text-ui-sm text-muted-foreground">
                    {loadedPath
                      ? "二进制资源可下载或上传替换。"
                      : "选择 SKILL.md 或支持文件进行编辑。"}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
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
            </div>
            <SettingsSection title="绑定专家">
              <ul className="divide-y divide-border">
                {experts.data
                  ?.filter((expert) => !expert.archived)
                  .map((expert) => (
                    <li
                      key={expert.id}
                      className="flex flex-wrap items-center justify-between gap-2 py-2"
                    >
                      <span className="text-ui">{expert.name}</span>
                      {expert.skillBindings === undefined &&
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
                              await checked(
                                ensureExpertClient().saveExpert({
                                  ...expert,
                                  expectedRevision: expert.revision,
                                  skillBindings,
                                  skills: [],
                                  skillSelections: [],
                                }),
                              );
                              await experts.refetch();
                              await onChanged();
                            })
                          }
                        />
                      )}
                    </li>
                  ))}
              </ul>
            </SettingsSection>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={close}>
              关闭
            </Button>
            <Button
              disabled={busy || !dirty || !connection.connected || !name.trim()}
              onClick={() => void save()}
            >
              保存新版本
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      {guard.dialog}
    </>
  );
}

export function SkillLibrarySettingsPanel() {
  const cache = useQueryClient(),
    connection = useSkillPackageConnection();
  const activePreviewRequest = useRef<string | null>(null);
  const activePreviewId = useRef<string | null>(null);
  const query = useQuery({
    queryKey: [...SKILL_LIBRARY_QUERY_KEY, connection.generation],
    queryFn: () => ensureExpertClient().skillLibrary({ action: "list" }),
    enabled: connection.connected,
    refetchOnWindowFocus: false,
  });
  const [cwd, setCwd] = useState("");
  const inventory = useQuery(skillsCatalogQueryOptions({ cwd, enabled: connection.connected }));
  const skills = query.data?.skills ?? [];
  const [search, setSearch] = useState(""),
    [tag, setTag] = useState(""),
    [source, setSource] = useState("all"),
    [selected, setSelected] = useState<string[]>([]),
    [batchTags, setBatchTags] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null),
    [createOpen, setCreateOpen] = useState(false),
    [newName, setNewName] = useState("new-skill"),
    [newBody, setNewBody] = useState(
      "---\nname: new-skill\ndescription: Describe when to use this skill.\n---\n\nWrite the skill instructions here.\n",
    );
  const [importOpen, setImportOpen] = useState(false),
    [location, setLocation] = useState(""),
    [kind, setKind] = useState<"local" | "url" | "runtime">("local"),
    [preview, setPreview] = useState<SkillLibraryPreview | null>(null),
    [choices, setChoices] = useState<SkillImportChoice[]>([]),
    [refresh, setRefresh] = useState<SkillDefinition | null>(null);
  const [deletions, setDeletions] = useState<
      { skill: SkillDefinition; expertIds: readonly string[] }[] | null
    >(null),
    [results, setResults] = useState<SkillLibraryResponse["results"]>([]),
    [refreshBases, setRefreshBases] = useState<SkillDefinition[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const generation = useRef(connection.generation);
  generation.current = connection.generation;
  useEffect(() => {
    activePreviewRequest.current = null;
    activePreviewId.current = null;
    setPreview(null);
    setChoices([]);
    setImportOpen(false);
    setDeletions(null);
    setSelected([]);
    setResults([]);
    setRefreshBases([]);
  }, [connection.generation]);
  const checked = async <T,>(operation: Promise<T>) => {
    const started = connection.generation,
      result = await operation;
    if (generation.current !== started) throw new Error("服务器连接已更改，请重新预览操作。");
    return result;
  };
  const call = (request: SkillLibraryRequest) =>
    checked(ensureExpertClient().skillLibrary(request));
  const reload = async () => {
    await Promise.all([
      cache.invalidateQueries({ queryKey: SKILL_LIBRARY_QUERY_KEY }),
      cache.invalidateQueries({ queryKey: ["server", "experts"] }),
      cache.invalidateQueries({ queryKey: ["server", "skillPackages"] }),
    ]);
  };
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await operation();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const clearPreviewOwnership = (cancel = true) => {
    const id = activePreviewId.current ?? activePreviewRequest.current;
    activePreviewRequest.current = null;
    activePreviewId.current = null;
    if (cancel && id) void call({ action: "cancel", previewId: id }).catch(() => undefined);
  };
  const beginPreview = () => {
    clearPreviewOwnership();
    const id = globalThis.crypto.randomUUID();
    activePreviewRequest.current = id;
    setPreview(null);
    return id;
  };
  const adoptPreview = (id: string, result: SkillLibraryResponse) => {
    if (activePreviewRequest.current !== id) {
      if (result.preview)
        void call({ action: "cancel", previewId: result.preview.previewId }).catch(() => undefined);
      return;
    }
    activePreviewId.current = result.preview?.previewId ?? null;
    setPreview(result.preview ?? null);
  };
  const openRefresh = (skill: SkillDefinition) => {
    const id = beginPreview();
    setRefresh(skill);
    setChoices([]);
    setImportOpen(true);
    return run(async () => {
      const result = await call({
        action: "previewRefresh",
        skillId: skill.skillId,
        expectedRevision: skill.revision,
      });
      adoptPreview(id, result);
    });
  };
  const openImport = async (value: string, mode: typeof kind) => {
    const requestId = beginPreview();
    setImportOpen(true);
    setLocation(value);
    setKind(mode);
    setRefresh(null);
    setChoices([]);
    setPreview(null);
    await run(async () => {
      const result = await call({
        action: "previewImport",
        location: value,
        kind: mode,
        requestId,
      });
      adoptPreview(requestId, result);
    });
  };
  const cancelImport = () => {
    clearPreviewOwnership();
    setImportOpen(false);
    setPreview(null);
    setRefresh(null);
    setChoices([]);
  };
  const prepareDelete = (items: SkillDefinition[]) =>
    run(async () => {
      const prepared = [];
      for (const skill of items)
        prepared.push({
          skill,
          expertIds:
            (await call({ action: "previewDelete", skillId: skill.skillId })).expertIds ?? [],
        });
      setDeletions(prepared);
    });
  const selectedItems = skills.filter((skill) => selected.includes(skill.skillId)),
    visible = skills.filter(
      (skill) =>
        `${skill.name} ${skill.description} ${skill.tags.join(" ")}`
          .toLocaleLowerCase()
          .includes(search.toLocaleLowerCase()) &&
        (!tag || skill.tags.includes(tag)) &&
        (source === "all" || skill.source.kind === source),
    );
  const detail = skills.find((skill) => skill.skillId === detailId);
  const updateChoice = (entryPath: string, patch: Partial<SkillImportChoice>) =>
    setChoices((current) =>
      current.map((choice) => (choice.entryPath === entryPath ? { ...choice, ...patch } : choice)),
    );
  return (
    <div className="space-y-6">
      <SettingsSection title="技能库">
        <div className="space-y-3">
          <p className="text-ui-sm text-muted-foreground">
            保存或来源更新影响绑定专家的新任务；已接受任务保留固定内容。包保存成功与运行就绪分别验证。
          </p>
          {!connection.connected ? (
            <p role="status" className="text-ui-sm text-muted-foreground">
              服务器未连接，管理操作已暂停。
            </p>
          ) : null}
          {query.isError ? (
            <p role="alert" className="text-ui-sm text-destructive">
              技能库读取失败，请重试。
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="whitespace-pre-wrap text-ui-sm text-destructive">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p role="status" className="text-ui-sm">
              {notice}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy || !connection.connected}
              onClick={() => setCreateOpen(true)}
            >
              新建技能
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !connection.connected}
              onClick={() => {
                clearPreviewOwnership();
                setImportOpen(true);
                setPreview(null);
                setRefresh(null);
                setChoices([]);
              }}
            >
              导入技能
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>
              刷新列表
            </Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <Input
              aria-label="搜索技能"
              placeholder="搜索名称、说明或标签"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <Input
              aria-label="按标签过滤"
              placeholder="按完整标签过滤"
              value={tag}
              onChange={(event) => setTag(event.target.value)}
            />
            <Select
              value={source}
              onValueChange={(value) => {
                if (value) setSource(value);
              }}
            >
              <SelectTrigger size="sm" aria-label="按来源过滤">
                <SelectValue>{source === "all" ? "全部来源" : source}</SelectValue>
              </SelectTrigger>
              <SettingsSelectPopup>
                {["all", "manual", "local", "archive", "url", "runtime"].map((value) => (
                  <SelectItem key={value} value={value}>
                    {value === "all" ? "全部来源" : value}
                  </SelectItem>
                ))}
              </SettingsSelectPopup>
            </Select>
          </div>
          <ul className="divide-y divide-border" aria-label="托管技能">
            {visible.map((skill) => (
              <li key={skill.skillId} className="flex flex-wrap items-center gap-2 py-3">
                <Checkbox
                  aria-label={`选择 ${skill.name}`}
                  checked={selected.includes(skill.skillId)}
                  onCheckedChange={(checked) =>
                    setSelected((current) =>
                      checked
                        ? [...current, skill.skillId]
                        : current.filter((id) => id !== skill.skillId),
                    )
                  }
                />
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => setDetailId(skill.skillId)}
                >
                  <span className="block text-ui font-medium">{skill.name}</span>
                  <span className="block text-ui-sm text-muted-foreground">
                    {skill.description}
                  </span>
                  <span className="block text-ui-xs text-muted-foreground">
                    {skill.tags.join(" · ")} · {skill.source.kind} · r{skill.revision} ·{" "}
                    {skill.packageId.slice(4, 16)}
                    {skill.locallyModified ? " · 有本地编辑" : ""} · 待任务运行验证
                  </span>
                </button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    busy ||
                    !connection.connected ||
                    skill.source.kind === "manual" ||
                    (skill.source.kind === "archive" && !skill.source.location.startsWith("/"))
                  }
                  onClick={() => void openRefresh(skill)}
                >
                  预览来源更新
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || !connection.connected}
                  onClick={() => void prepareDelete([skill])}
                >
                  删除
                </Button>
              </li>
            ))}
          </ul>
          {!visible.length && !query.isLoading ? (
            <p className="text-ui-sm text-muted-foreground">没有匹配的托管技能。</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <span className="text-ui-sm">已选 {selectedItems.length} 项</span>
            <Input
              className="w-48"
              aria-label="批量设置标签"
              value={batchTags}
              onChange={(event) => setBatchTags(event.target.value)}
              placeholder="批量标签，用逗号分隔"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !selectedItems.length || !connection.connected}
              onClick={() =>
                void run(async () => {
                  setResults(
                    (
                      await call({
                        action: "batch",
                        items: selectedItems.map((skill) => ({
                          skillId: skill.skillId,
                          expectedRevision: skill.revision,
                          operation: "tags",
                          tags: tagsFrom(batchTags),
                        })),
                      })
                    ).results,
                  );
                  await reload();
                })
              }
            >
              应用标签
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !selectedItems.length || !connection.connected}
              onClick={() =>
                void run(async () => {
                  setRefreshBases(selectedItems);
                  setResults(
                    (
                      await call({
                        action: "batch",
                        items: selectedItems.map((skill) => ({
                          skillId: skill.skillId,
                          expectedRevision: skill.revision,
                          operation: "previewRefresh",
                        })),
                      })
                    ).results,
                  );
                })
              }
            >
              批量预览更新
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !selectedItems.length || !connection.connected}
              onClick={() => void prepareDelete(selectedItems)}
            >
              批量删除
            </Button>
          </div>
          {results?.length ? (
            <div className="space-y-2 rounded-lg border border-border p-3">
              <ul className="space-y-2 text-ui-sm" aria-label="批量操作结果">
                {results.map((result, index) => (
                  <li
                    key={`${result.skillId}:${index}`}
                    className={result.success ? "" : "text-destructive"}
                  >
                    {skills.find((skill) => skill.skillId === result.skillId)?.name ??
                      result.skillId}{" "}
                    · {result.success ? "成功" : "失败"} · {result.message}
                    {result.preview ? (
                      <>
                        <p className="text-ui-xs">
                          {result.preview.overwritesLocalEdits ? "将覆盖本地编辑。" : ""}新包{" "}
                          {result.preview.package.packageId.slice(4, 16)}
                        </p>
                        <ul className="max-h-24 overflow-auto text-ui-xs">
                          {result.preview.resourceChanges.map((file) => (
                            <li key={file}>{file}</li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
              {results.some((result) => result.preview) ? (
                <Button
                  size="sm"
                  disabled={busy || !connection.connected}
                  onClick={() =>
                    void run(async () => {
                      const items = results
                        .filter((result) => result.success && result.preview)
                        .map((result) => ({
                          skillId: result.skillId,
                          expectedRevision: refreshBases.find(
                            (skill) => skill.skillId === result.skillId,
                          )!.revision,
                          operation: "refresh" as const,
                          previewId: result.preview!.previewId,
                        }));
                      setResults((await call({ action: "batch", items })).results);
                      await reload();
                    })
                  }
                >
                  确认上述来源替换
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </SettingsSection>
      <SettingsSection title="运行时与项目技能">
        <div className="space-y-3">
          <p className="text-ui-sm text-muted-foreground">
            外部技能保持只读，复制后成为托管版本。普通任务继续使用原生技能行为。
          </p>
          <Input
            aria-label="扫描项目目录"
            placeholder="项目绝对路径（可选）"
            value={cwd}
            onChange={(event) => setCwd(event.target.value)}
          />
          {inventory.isError ? (
            <p role="alert" className="text-ui-sm text-destructive">
              无法扫描运行时技能。
            </p>
          ) : null}
          <ul className="max-h-80 divide-y divide-border overflow-auto">
            {inventory.data?.skills
              .filter((skill) =>
                `${skill.name} ${skill.description ?? ""} ${skill.path}`
                  .toLocaleLowerCase()
                  .includes(search.toLocaleLowerCase()),
              )
              .map((skill) => (
                <li
                  key={`${skill.scope}:${skill.path}`}
                  className="flex items-center justify-between gap-2 py-2"
                >
                  <div className="min-w-0">
                    <p className="text-ui font-medium">{skill.name}</p>
                    <p className="break-all text-ui-xs text-muted-foreground">
                      {skill.scope} · {skill.path}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !connection.connected}
                    onClick={() => void openImport(skill.path, "runtime")}
                  >
                    复制到技能库
                  </Button>
                </li>
              ))}
          </ul>
        </div>
      </SettingsSection>
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogPopup className="w-[min(44rem,calc(100vw-1.5rem))]">
          <DialogHeader>
            <DialogTitle>新建技能</DialogTitle>
            <DialogDescription>保存为托管 SKILL.md，不会执行其中的脚本。</DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <Input
              aria-label="新技能名称"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
            <Textarea
              aria-label="新技能 SKILL.md"
              rows={15}
              value={newBody}
              onChange={(event) => setNewBody(event.target.value)}
            />
            {error ? (
              <p role="alert" className="text-ui-sm text-destructive">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button
              disabled={busy || !connection.connected || !newName.trim()}
              onClick={() =>
                void run(async () => {
                  const result = await call({
                    action: "create",
                    name: newName,
                    body: newBody,
                    tags: [],
                  });
                  await reload();
                  setCreateOpen(false);
                  setDetailId(result.skill?.skillId ?? null);
                })
              }
            >
              创建
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={importOpen}
        onOpenChange={(open) => {
          if (!open) cancelImport();
        }}
      >
        <DialogPopup className="w-[min(48rem,calc(100vw-1.5rem))]">
          <DialogHeader>
            <DialogTitle>{refresh ? "确认来源更新" : "导入技能"}</DialogTitle>
            <DialogDescription>
              保留完整包目录，只登记选中的 SKILL.md 入口。来源文件保持只读。
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            {!refresh ? (
              <>
                <div className="flex gap-2">
                  <Select
                    value={kind}
                    onValueChange={(value) => {
                      if (value === "local" || value === "url" || value === "runtime")
                        setKind(value);
                    }}
                  >
                    <SelectTrigger size="sm" aria-label="导入来源类型" className="w-32">
                      <SelectValue>{kind}</SelectValue>
                    </SelectTrigger>
                    <SettingsSelectPopup>
                      <SelectItem value="local">本机路径</SelectItem>
                      <SelectItem value="url">来源网址</SelectItem>
                      <SelectItem value="runtime">运行时副本</SelectItem>
                    </SettingsSelectPopup>
                  </Select>
                  <Input
                    aria-label="技能导入来源"
                    value={location}
                    onChange={(event) => setLocation(event.target.value)}
                    placeholder="文件夹、SKILL.md、.zip/.skill 路径或 GitHub / Skills.sh / ClawHub URL"
                  />
                  <Button
                    size="sm"
                    disabled={busy || !location.trim() || !connection.connected}
                    onClick={() => void openImport(location, kind)}
                  >
                    预览
                  </Button>
                </div>
                <label className="block space-y-1 text-ui-sm">
                  上传 .zip / .skill
                  <Input
                    aria-label="上传技能压缩包"
                    type="file"
                    accept=".zip,.skill"
                    disabled={busy || !connection.connected}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (!file) return;
                      const uploadId = beginPreview();
                      setChoices([]);
                      void run(async () => {
                        const result = await checked(
                          transfer(
                            `${SKILL_UPLOAD_ROUTE_PATH}?${new URLSearchParams({ name: file.name })}`,
                            { method: "POST", body: file },
                          ).then((response) => response.json() as Promise<SkillLibraryResponse>),
                        );
                        adoptPreview(uploadId, result);
                      });
                      event.target.value = "";
                    }}
                  />
                </label>
              </>
            ) : null}
            {error ? (
              <p role="alert" className="text-ui-sm text-destructive">
                {error}
              </p>
            ) : null}
            {preview ? (
              <>
                <p className="break-all text-ui-xs text-muted-foreground">
                  {preview.package.rootName} · {preview.package.fileCount} 文件 ·{" "}
                  {preview.package.totalBytes.toLocaleString()} B · {preview.package.packageId}
                </p>
                {preview.overwritesLocalEdits ? (
                  <p role="alert" className="text-ui-sm text-destructive">
                    来源更新会覆盖本地编辑。技能身份和专家绑定保留，已接受任务的固定内容不变。
                  </p>
                ) : null}
                {refresh ? (
                  <ul className="max-h-52 overflow-auto text-ui-sm">
                    {preview.resourceChanges.map((file) => (
                      <li key={file}>{file}</li>
                    ))}
                  </ul>
                ) : (
                  <ul className="max-h-80 space-y-3 overflow-auto">
                    {preview.package.entries
                      .filter(
                        (entry) =>
                          !preview.selectedEntryPaths ||
                          preview.selectedEntryPaths.includes(entry.entryPath),
                      )
                      .map((entry) => {
                        const choice = choices.find((item) => item.entryPath === entry.entryPath);
                        return (
                          <li
                            key={entry.entryPath}
                            className="space-y-2 rounded-lg border border-border p-2"
                          >
                            <label className="flex items-center gap-2 text-ui-sm">
                              <Checkbox
                                checked={!!choice}
                                aria-label={`导入 ${entry.entryPath}`}
                                onCheckedChange={(checked) =>
                                  setChoices((current) =>
                                    checked
                                      ? [
                                          ...current,
                                          { entryPath: entry.entryPath, duplicate: "skip" },
                                        ]
                                      : current.filter(
                                          (item) => item.entryPath !== entry.entryPath,
                                        ),
                                  )
                                }
                              />
                              {entry.name} · {entry.entryPath}
                            </label>
                            <p className="text-ui-sm text-muted-foreground">{entry.description}</p>
                            {choice ? (
                              <div className="flex flex-wrap gap-2">
                                <Select
                                  value={choice.duplicate}
                                  onValueChange={(value) => {
                                    if (
                                      value === "skip" ||
                                      value === "rename" ||
                                      value === "replace"
                                    )
                                      updateChoice(entry.entryPath, { duplicate: value });
                                  }}
                                >
                                  <SelectTrigger
                                    size="sm"
                                    className="w-36"
                                    aria-label={`重复处理 ${entry.entryPath}`}
                                  >
                                    <SelectValue>
                                      {choice.duplicate === "skip"
                                        ? "同名跳过"
                                        : choice.duplicate === "rename"
                                          ? "重命名"
                                          : "替换已有"}
                                    </SelectValue>
                                  </SelectTrigger>
                                  <SettingsSelectPopup>
                                    <SelectItem value="skip">同名跳过</SelectItem>
                                    <SelectItem value="rename">重命名</SelectItem>
                                    <SelectItem value="replace">替换已有</SelectItem>
                                  </SettingsSelectPopup>
                                </Select>
                                {choice.duplicate === "rename" ? (
                                  <Input
                                    aria-label={`重命名 ${entry.entryPath}`}
                                    value={choice.name ?? entry.name}
                                    onChange={(event) =>
                                      updateChoice(entry.entryPath, { name: event.target.value })
                                    }
                                  />
                                ) : choice.duplicate === "replace" ? (
                                  <Select
                                    value={choice.replaceSkillId ?? ""}
                                    onValueChange={(id) => {
                                      const skill = skills.find((item) => item.skillId === id);
                                      if (skill)
                                        updateChoice(entry.entryPath, {
                                          replaceSkillId: skill.skillId,
                                          expectedRevision: skill.revision,
                                        });
                                    }}
                                  >
                                    <SelectTrigger
                                      size="sm"
                                      className="w-48"
                                      aria-label={`替换目标 ${entry.entryPath}`}
                                    >
                                      <SelectValue placeholder="选择替换目标">
                                        {
                                          skills.find(
                                            (item) => item.skillId === choice.replaceSkillId,
                                          )?.name
                                        }
                                      </SelectValue>
                                    </SelectTrigger>
                                    <SettingsSelectPopup>
                                      {skills.map((skill) => (
                                        <SelectItem key={skill.skillId} value={skill.skillId}>
                                          {skill.name} · r{skill.revision}
                                        </SelectItem>
                                      ))}
                                    </SettingsSelectPopup>
                                  </Select>
                                ) : null}
                              </div>
                            ) : null}
                            {entry.issues.map((issue) => (
                              <p key={issue} className="text-ui-xs text-muted-foreground">
                                {issue}
                              </p>
                            ))}
                          </li>
                        );
                      })}
                  </ul>
                )}
              </>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={cancelImport}>
              取消
            </Button>
            <Button
              disabled={busy || !connection.connected || !preview || (!refresh && !choices.length)}
              onClick={() =>
                void run(async () => {
                  if (!preview) return;
                  const result = refresh
                    ? await call({
                        action: "refresh",
                        skillId: refresh.skillId,
                        expectedRevision: refresh.revision,
                        previewId: preview.previewId,
                      })
                    : await call({ action: "import", previewId: preview.previewId, choices });
                  clearPreviewOwnership(false);
                  await reload();
                  setNotice(
                    refresh
                      ? "来源已更新，专家绑定保持不变。"
                      : `已导入 ${result.skills?.length ?? 0} 个选中入口。`,
                  );
                  setImportOpen(false);
                  setPreview(null);
                  setRefresh(null);
                })
              }
            >
              {refresh ? "确认替换托管版本" : "导入选中入口"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={deletions !== null}
        onOpenChange={(open) => {
          if (!open) setDeletions(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>删除技能</DialogTitle>
            <DialogDescription>
              先解除以下专家绑定，再逻辑删除技能。任务固定包与历史数据保留。
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <ul className="space-y-2 text-ui-sm">
              {deletions?.map(({ skill, expertIds }) => (
                <li key={skill.skillId}>
                  {skill.name} ·{" "}
                  {expertIds.length
                    ? `影响 ${expertIds.length} 个专家：${expertIds.join("、")}`
                    : "没有专家绑定"}
                </li>
              ))}
            </ul>
            {error ? (
              <p role="alert" className="text-ui-sm text-destructive">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setDeletions(null)}>
              取消
            </Button>
            <Button
              disabled={busy || !connection.connected}
              onClick={() =>
                void run(async () => {
                  setResults(
                    (
                      await call({
                        action: "batch",
                        items: (deletions ?? []).map(({ skill, expertIds }) => ({
                          skillId: skill.skillId,
                          expectedRevision: skill.revision,
                          operation: "delete",
                          confirmExpertIds: expertIds,
                        })),
                      })
                    ).results,
                  );
                  setDeletions(null);
                  setSelected([]);
                  await reload();
                })
              }
            >
              确认解绑并删除
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      {detail ? (
        <SkillLibraryDetail
          key={`${detail.skillId}:${connection.generation}`}
          initial={detail}
          onClose={() => setDetailId(null)}
          onChanged={reload}
        />
      ) : null}
    </div>
  );
}
