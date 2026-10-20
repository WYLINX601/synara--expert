import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  SkillPackage,
  SkillPackagePreview,
  SkillPackageRemovalPreview,
  SkillPackageUpdatePreview,
} from "@synara/contracts";
import { ensureExpertClient } from "~/workbench/host/expertClient";
import { Button } from "../ui/button";
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
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { ChevronRightIcon } from "~/lib/icons";
import { disclosureChevronClassName } from "~/lib/disclosureMotion";
import { SettingsCard, SettingsSectionShell } from "./SettingsPanelPrimitives";
import {
  SKILL_PACKAGES_QUERY_KEY,
  SKILL_PACKAGE_SOURCES_QUERY_KEY,
  skillPackageDetailQueryKey,
  skillPackageSourcesQueryKey,
  skillPackagesQueryKey,
  useSkillPackageConnection,
} from "./skillPackageSettingsQueries";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请重试。";
}

function packageVersionLabel(skillPackage: SkillPackage): string {
  return skillPackage.packageId.slice(4, 12);
}

function EntryList({ entries }: { entries: SkillPackagePreview["package"]["entries"] }) {
  return entries.length === 0 ? (
    <p className="text-ui-sm text-muted-foreground">没有可用技能入口。</p>
  ) : (
    <ul className="space-y-2">
      {entries.map((entry) => (
        <li key={entry.entryPath} className="min-w-0">
          <p className="truncate text-ui font-medium">{entry.name}</p>
          <p className="break-all text-ui-xs text-muted-foreground">{entry.entryPath}</p>
          {entry.description ? (
            <p className="mt-0.5 text-ui-sm text-muted-foreground">{entry.description}</p>
          ) : null}
          {entry.issues.length > 0 ? (
            <ul className="mt-1 list-disc pl-5 text-ui-xs text-amber-700 dark:text-amber-300">
              {entry.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function ResourceDisclosure({ resources }: { resources: SkillPackage["resources"] }) {
  const [open, setOpen] = useState(false);
  const fileCount = resources.filter((resource) => resource.kind === "file").length;
  const directoryCount = resources.length - fileCount;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-lg border border-border p-3">
        <CollapsibleTrigger className="flex w-full items-center gap-2 text-left text-ui-sm font-medium">
          <ChevronRightIcon className={disclosureChevronClassName(open)} />
          包内资源（{fileCount} 个文件 · {directoryCount} 个目录）
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <ul className="mt-2 max-h-52 space-y-1 overflow-auto text-ui-xs">
            {resources.map((resource) => (
              <li key={resource.path} className="break-all">
                {resource.kind === "file" ? "文件" : "目录"} · {resource.path}
                {resource.kind === "file" ? ` · ${resource.size.toLocaleString()} 字节` : ""}
                {resource.executable ? " · 可执行位" : ""}
              </li>
            ))}
          </ul>
        </CollapsiblePanel>
      </div>
    </Collapsible>
  );
}

function EntryChanges({
  added,
  changed,
  removed,
}: {
  added: ReadonlyArray<string>;
  changed: ReadonlyArray<string>;
  removed: ReadonlyArray<string>;
}) {
  const groups = [
    { label: "新增入口", paths: added },
    { label: "变更入口", paths: changed },
    { label: "移除入口", paths: removed },
  ].filter((group) => group.paths.length > 0);
  if (groups.length === 0) {
    return <p className="text-ui-sm text-muted-foreground">入口没有变化。</p>;
  }
  return (
    <ul className="max-h-40 space-y-2 overflow-auto rounded-lg border border-border p-2 text-ui-xs">
      {groups.flatMap((group) =>
        group.paths.map((path) => (
          <li key={`${group.label}:${path}`} className="break-all">
            {group.label} · {path}
          </li>
        )),
      )}
    </ul>
  );
}

export function SkillPackagesSettingsPanel() {
  const queryClient = useQueryClient();
  const connection = useSkillPackageConnection();
  const connectionRef = useRef(connection.generation);
  const importRequestId = useRef(0);
  const updateRequestId = useRef(0);
  const removalRequestId = useRef(0);
  const packagesQuery = useQuery({
    queryKey: skillPackagesQueryKey(connection.generation),
    queryFn: () => ensureExpertClient().listSkillPackages(),
    enabled: connection.connected,
  });
  const sourcesQuery = useQuery({
    queryKey: skillPackageSourcesQueryKey(connection.generation),
    queryFn: () => ensureExpertClient().listSkillPackageSources(),
    enabled: connection.connected,
  });
  const [detailPackageId, setDetailPackageId] = useState<string | null>(null);
  const detailQuery = useQuery({
    queryKey: skillPackageDetailQueryKey(detailPackageId, connection.generation),
    queryFn: () => ensureExpertClient().readSkillPackage({ packageId: detailPackageId! }),
    enabled: detailPackageId !== null && connection.connected,
  });

  const [importOpen, setImportOpen] = useState(false);
  const [importPath, setImportPath] = useState("");
  const [importPreview, setImportPreview] = useState<SkillPackagePreview | null>(null);
  const [updatePreview, setUpdatePreview] = useState<SkillPackageUpdatePreview | null>(null);
  const [removalPreview, setRemovalPreview] = useState<SkillPackageRemovalPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (connectionRef.current !== connection.generation) {
    connectionRef.current = connection.generation;
    importRequestId.current += 1;
    updateRequestId.current += 1;
    removalRequestId.current += 1;
  }

  useEffect(() => {
    setPending(false);
    setImportPreview(null);
    setUpdatePreview(null);
    setRemovalPreview(null);
    setError(connection.connected ? "服务器连接已更改，请重新预览此操作。" : null);
    setNotice(null);
  }, [connection.connected, connection.generation]);

  const packages = packagesQuery.data ?? [];
  const sources = sourcesQuery.data ?? [];
  const sourcesByPackage = new Map<string, typeof sources>();
  for (const source of sources) {
    const existing = sourcesByPackage.get(source.packageId) ?? [];
    sourcesByPackage.set(source.packageId, [...existing, source]);
  }

  const openImporter = () => {
    if (!connection.connected) return;
    importRequestId.current += 1;
    setImportPath("");
    setImportPreview(null);
    setError(null);
    setImportOpen(true);
  };

  const previewImport = async () => {
    const path = importPath.trim();
    if (!path || pending || !connection.connected) return;
    const requestId = ++importRequestId.current;
    const requestGeneration = connection.generation;
    const isCurrentRequest = () =>
      requestId === importRequestId.current && connectionRef.current === requestGeneration;
    setPending(true);
    setError(null);
    setImportPreview(null);
    try {
      const result = await ensureExpertClient().previewSkillPackage({ path });
      if (isCurrentRequest() && importOpen) setImportPreview(result);
    } catch (cause) {
      if (isCurrentRequest() && importOpen) setError(errorText(cause));
    } finally {
      if (isCurrentRequest()) setPending(false);
    }
  };

  const confirmImport = async () => {
    if (!importPreview || pending || !connection.connected) return;
    const requestId = importRequestId.current;
    const requestGeneration = connection.generation;
    const isCurrentRequest = () =>
      requestId === importRequestId.current && connectionRef.current === requestGeneration;
    setPending(true);
    setError(null);
    try {
      const result = await ensureExpertClient().importSkillPackage({
        previewId: importPreview.previewId,
        idempotencyKey: importPreview.previewId,
      });
      if (!isCurrentRequest() || !importOpen) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: SKILL_PACKAGES_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: SKILL_PACKAGE_SOURCES_QUERY_KEY }),
      ]);
      setNotice(
        `${result.reused ? "已复用" : "已导入"} ${result.package.rootName}，专家当前选择未改变。`,
      );
      setImportOpen(false);
      setImportPreview(null);
      setImportPath("");
    } catch (cause) {
      if (isCurrentRequest()) setError(errorText(cause));
    } finally {
      if (isCurrentRequest()) setPending(false);
    }
  };

  const previewUpdate = async (sourceId: string, expectedRevision: number, packageId: string) => {
    if (pending || !connection.connected) return;
    const requestId = ++updateRequestId.current;
    const requestGeneration = connection.generation;
    const isCurrentRequest = () =>
      requestId === updateRequestId.current && connectionRef.current === requestGeneration;
    setPending(true);
    setError(null);
    setUpdatePreview(null);
    try {
      const result = await ensureExpertClient().previewSkillPackageUpdate({
        sourceId,
        expectedRevision,
      });
      if (isCurrentRequest()) {
        if (result.previousPackageId === packageId) {
          setUpdatePreview(result);
        } else {
          setError("来源当前指向另一个版本，请刷新列表后重新检查。");
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: SKILL_PACKAGES_QUERY_KEY }),
            queryClient.invalidateQueries({ queryKey: SKILL_PACKAGE_SOURCES_QUERY_KEY }),
          ]);
        }
      }
    } catch (cause) {
      if (isCurrentRequest()) setError(errorText(cause));
    } finally {
      if (isCurrentRequest()) setPending(false);
    }
  };

  const confirmUpdate = async () => {
    if (!updatePreview || pending || !connection.connected) return;
    const requestId = updateRequestId.current;
    const requestGeneration = connection.generation;
    const isCurrentRequest = () =>
      requestId === updateRequestId.current && connectionRef.current === requestGeneration;
    setPending(true);
    setError(null);
    try {
      const result = await ensureExpertClient().importSkillPackage({
        previewId: updatePreview.previewId,
        idempotencyKey: updatePreview.previewId,
      });
      if (!isCurrentRequest()) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: SKILL_PACKAGES_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: SKILL_PACKAGE_SOURCES_QUERY_KEY }),
      ]);
      setNotice(`已导入新版本 ${result.package.rootName}，不会更改专家当前选择。`);
      setUpdatePreview(null);
    } catch (cause) {
      if (isCurrentRequest()) setError(errorText(cause));
    } finally {
      if (isCurrentRequest()) setPending(false);
    }
  };

  const previewRemoval = async (packageId: string) => {
    if (!connection.connected || pending) return;
    const requestId = ++removalRequestId.current;
    const requestGeneration = connection.generation;
    const isCurrentRequest = () =>
      requestId === removalRequestId.current && connectionRef.current === requestGeneration;
    setPending(true);
    setError(null);
    setRemovalPreview(null);
    try {
      const result = await ensureExpertClient().previewSkillPackageRemoval({ packageId });
      if (isCurrentRequest() && result.packageId === packageId) {
        setRemovalPreview(result);
      }
    } catch (cause) {
      if (isCurrentRequest()) setError(errorText(cause));
    } finally {
      if (isCurrentRequest()) setPending(false);
    }
  };

  const confirmRemoval = async () => {
    if (!removalPreview || removalPreview.references.length > 0 || pending || !connection.connected)
      return;
    const requestId = removalRequestId.current;
    const requestGeneration = connection.generation;
    const isCurrentRequest = () =>
      requestId === removalRequestId.current && connectionRef.current === requestGeneration;
    setPending(true);
    setError(null);
    try {
      await ensureExpertClient().removeSkillPackage({ packageId: removalPreview.packageId });
      if (!isCurrentRequest()) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: SKILL_PACKAGES_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: SKILL_PACKAGE_SOURCES_QUERY_KEY }),
      ]);
      setNotice("已删除未被引用的技能包版本；来源目录未修改。");
      setRemovalPreview(null);
    } catch (cause) {
      if (isCurrentRequest()) setError(errorText(cause));
    } finally {
      if (isCurrentRequest()) setPending(false);
    }
  };

  return (
    <div className="space-y-4">
      <SettingsSectionShell
        title="受管理资源包"
        count={packages.length}
        layout="compact"
        action={
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !connection.connected}
            onClick={openImporter}
          >
            导入技能包
          </Button>
        }
      >
        <p className="pb-2 text-ui-sm text-muted-foreground">
          版本包由服务器保存为只读内容。导入和更新只增加可选版本，不会更改任何专家的当前选择。
        </p>
        {error ? (
          <p className="pb-2 text-ui-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="pb-2 text-ui-sm text-muted-foreground" role="status">
            {notice}
          </p>
        ) : null}
        {sourcesQuery.isError ? (
          <p className="pb-2 text-ui-sm text-destructive" role="alert">
            无法读取技能包来源，更新操作暂时不可用：{errorText(sourcesQuery.error)}
          </p>
        ) : null}
        {packagesQuery.isPending && !packagesQuery.data ? (
          <p className="py-3 text-ui-sm text-muted-foreground" role="status">
            正在读取技能包…
          </p>
        ) : !connection.connected ? (
          <p className="py-3 text-ui-sm text-muted-foreground" role="status">
            服务器未连接，暂时无法管理技能包。
          </p>
        ) : packagesQuery.isError ? (
          <p className="py-3 text-ui-sm text-destructive" role="alert">
            无法读取技能包：{errorText(packagesQuery.error)}
          </p>
        ) : packages.length === 0 ? (
          <p className="py-3 text-ui-sm text-muted-foreground">尚未导入技能包。</p>
        ) : (
          <SettingsCard className="px-3" divided={false}>
            <ul className="divide-y divide-border">
              {packages.map((skillPackage) => {
                const packageSources = sourcesByPackage.get(skillPackage.packageId) ?? [];
                return (
                  <li
                    key={skillPackage.packageId}
                    className="flex min-w-0 flex-wrap items-center gap-2 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-ui font-medium">{skillPackage.rootName}</p>
                      <p className="text-ui-xs text-muted-foreground">
                        {skillPackage.entries.length} 个入口 · {skillPackage.fileCount} 个文件 ·
                        版本 {packageVersionLabel(skillPackage)}
                      </p>
                      {packageSources.map((source) => (
                        <code
                          key={source.sourceId}
                          className="block truncate text-ui-xs text-muted-foreground"
                          title={source.sourcePath}
                        >
                          {source.sourcePath} · 来源 v{source.revision}
                        </code>
                      ))}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDetailPackageId(skillPackage.packageId)}
                      >
                        查看资源
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending || !connection.connected}
                        onClick={() => void previewRemoval(skillPackage.packageId)}
                      >
                        删除
                      </Button>
                    </div>
                    {packageSources.length > 0 ? (
                      <div className="flex w-full flex-wrap justify-end gap-1">
                        {packageSources.map((source) => (
                          <Button
                            key={source.sourceId}
                            size="sm"
                            variant="ghost"
                            disabled={pending || !connection.connected || sourcesQuery.isError}
                            onClick={() =>
                              void previewUpdate(
                                source.sourceId,
                                source.revision,
                                skillPackage.packageId,
                              )
                            }
                          >
                            检查来源更新 · v{source.revision}
                          </Button>
                        ))}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </SettingsCard>
        )}
      </SettingsSectionShell>

      <Dialog
        open={importOpen}
        onOpenChange={(open) => {
          if (pending) return;
          if (!open) importRequestId.current += 1;
          setImportOpen(open);
        }}
      >
        <DialogPopup className="w-[min(44rem,calc(100vw-1.5rem))]">
          <DialogHeader>
            <DialogTitle>导入技能包</DialogTitle>
            <DialogDescription>
              输入本机的 SKILL.md 路径或资源目录。预览确认后，服务端会重新校验来源并保存固定版本。
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="max-h-[min(58vh,34rem)] space-y-3">
            <label className="block space-y-1 text-ui-sm">
              <span className="font-medium">技能文件或目录路径</span>
              <Input
                aria-label="技能文件或目录路径"
                size="sm"
                value={importPath}
                disabled={pending}
                placeholder="/path/to/SKILL.md 或 /path/to/skills"
                onChange={(event) => {
                  importRequestId.current += 1;
                  setImportPath(event.target.value);
                  setImportPreview(null);
                  setError(null);
                }}
              />
            </label>
            {importPreview ? (
              <div className="space-y-3 rounded-lg border border-border p-3">
                <div>
                  <p className="text-ui font-medium">{importPreview.package.rootName}</p>
                  <p className="break-all text-ui-xs text-muted-foreground">
                    真实目录：{importPreview.realRoot}
                  </p>
                  <p className="text-ui-sm text-muted-foreground">
                    {importPreview.package.entries.length} 个入口 ·{" "}
                    {importPreview.package.fileCount} 个文件 ·{" "}
                    {importPreview.package.totalBytes.toLocaleString()} 字节
                  </p>
                </div>
                <EntryList entries={importPreview.package.entries} />
                <ResourceDisclosure resources={importPreview.package.resources} />
                {importPreview.issues.length > 0 ? (
                  <ul className="list-disc space-y-1 pl-5 text-ui-sm text-amber-700 dark:text-amber-300">
                    {importPreview.issues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            {error ? (
              <p className="text-ui-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => {
                importRequestId.current += 1;
                setImportOpen(false);
                setImportPreview(null);
              }}
            >
              取消
            </Button>
            {importPreview ? (
              <Button disabled={pending} onClick={() => void confirmImport()}>
                {pending ? "正在导入…" : "确认导入"}
              </Button>
            ) : (
              <Button disabled={pending || !importPath.trim()} onClick={() => void previewImport()}>
                {pending ? "正在预览…" : "预览"}
              </Button>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={updatePreview !== null}
        onOpenChange={(open) => {
          if (pending) return;
          if (!open) updateRequestId.current += 1;
          if (!open) {
            setUpdatePreview(null);
          }
        }}
      >
        <DialogPopup className="w-[min(44rem,calc(100vw-1.5rem))]">
          <DialogHeader>
            <DialogTitle>预览技能包更新</DialogTitle>
            <DialogDescription>
              确认后会导入新的不可变版本。原版本和专家当前选择都会保留。
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="max-h-[min(58vh,34rem)] space-y-3">
            {updatePreview ? (
              <>
                <p className="text-ui-sm">
                  {updatePreview.package.rootName} · {packageVersionLabel(updatePreview.package)}
                </p>
                <div className="grid gap-2 text-ui-sm sm:grid-cols-3">
                  <p>新增入口：{updatePreview.addedEntries.length}</p>
                  <p>变更入口：{updatePreview.changedEntries.length}</p>
                  <p>移除入口：{updatePreview.removedEntries.length}</p>
                  <p className="sm:col-span-3">资源变化：{updatePreview.resourceChanges.length}</p>
                </div>
                <EntryList entries={updatePreview.package.entries} />
                <EntryChanges
                  added={updatePreview.addedEntries}
                  changed={updatePreview.changedEntries}
                  removed={updatePreview.removedEntries}
                />
                <ResourceDisclosure resources={updatePreview.package.resources} />
                {updatePreview.resourceChanges.length > 0 ? (
                  <ul className="max-h-40 space-y-1 overflow-auto rounded-lg border border-border p-2 text-ui-xs">
                    {updatePreview.resourceChanges.map((change) => (
                      <li key={change.path} className="break-all">
                        {change.change} · {change.path}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-ui-sm text-muted-foreground">资源内容没有变化。</p>
                )}
              </>
            ) : null}
            {error ? (
              <p className="text-ui-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => {
                updateRequestId.current += 1;
                setUpdatePreview(null);
              }}
            >
              取消
            </Button>
            <Button disabled={pending || !updatePreview} onClick={() => void confirmUpdate()}>
              {pending ? "正在导入…" : "确认导入新版本"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={removalPreview !== null}
        onOpenChange={(open) => {
          if (pending) return;
          if (!open) removalRequestId.current += 1;
          if (!open) setRemovalPreview(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>删除技能包版本？</DialogTitle>
            <DialogDescription>
              只删除服务器保存的包版本和指向它的来源记录，不会改动原来源目录。
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {removalPreview?.references.length ? (
              <div className="space-y-2 text-ui-sm">
                <p>该版本仍被引用，暂时不能删除：</p>
                <ul className="list-disc space-y-1 pl-5">
                  {removalPreview.references.map((reference) => (
                    <li key={reference}>{reference}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-ui-sm text-muted-foreground">
                没有发现已保存的引用。确认时服务端仍会再次检查。
              </p>
            )}
            {error ? (
              <p className="mt-2 text-ui-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" disabled={pending} onClick={() => setRemovalPreview(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={pending || !removalPreview || removalPreview.references.length > 0}
              onClick={() => void confirmRemoval()}
            >
              {pending ? "正在删除…" : "确认删除"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={detailPackageId !== null}
        onOpenChange={(open) => {
          if (!open) setDetailPackageId(null);
        }}
      >
        <DialogPopup className="w-[min(44rem,calc(100vw-1.5rem))]">
          <DialogHeader>
            <DialogTitle>{detailQuery.data?.rootName ?? "技能包资源"}</DialogTitle>
            <DialogDescription>
              包内资源按固定版本保存。只有技能入口会作为专家技能展示。
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="max-h-[min(58vh,34rem)] space-y-3">
            {detailQuery.isPending ? (
              <p className="text-ui-sm text-muted-foreground">正在读取技能包…</p>
            ) : null}
            {!connection.connected ? (
              <p className="text-ui-sm text-muted-foreground">服务器未连接，无法读取资源。</p>
            ) : null}
            {detailQuery.isError ? (
              <p className="text-ui-sm text-destructive" role="alert">
                无法读取技能包：{errorText(detailQuery.error)}
              </p>
            ) : null}
            {detailQuery.data ? (
              <>
                <EntryList entries={detailQuery.data.entries} />
                <ResourceDisclosure resources={detailQuery.data.resources} />
              </>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDetailPackageId(null)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
