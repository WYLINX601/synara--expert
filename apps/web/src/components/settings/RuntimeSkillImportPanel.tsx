import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ProviderKind, ProviderSkillDescriptor } from "@synara/contracts";
import { skillsCatalogQueryOptions } from "~/lib/providerDiscoveryReactQuery";
import { ensureExpertClient } from "~/workbench/host/expertClient";
import { ProviderIcon } from "../ProviderIcon";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { DialogFooter, DialogPanel } from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsEmptyState, SettingsSelectPopup } from "./SettingsPanelPrimitives";
import { useSkillPackageConnection } from "./skillPackageSettingsQueries";

const RUNTIMES = [
  { value: "codex", label: "Codex" },
  { value: "claudeAgent", label: "Claude Code" },
  { value: "pi", label: "Pi" },
  { value: "omp", label: "Oh My Pi" },
] as const satisfies readonly { value: ProviderKind; label: string }[];
type Runtime = (typeof RUNTIMES)[number]["value"];
type CopyResult = {
  path: string;
  name: string;
  status: "imported" | "skipped" | "failed";
  error?: string;
};
const canCopy = (skill: ProviderSkillDescriptor) => /(?:^|[/\\])SKILL\.md$/u.test(skill.path);

export function RuntimeSkillImportPanel({
  onChanged,
  onClose,
  onBusyChange,
}: {
  onChanged: () => Promise<void>;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const connection = useSkillPackageConnection();
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<CopyResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const generation = useRef(connection.generation);
  generation.current = connection.generation;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const options = skillsCatalogQueryOptions({
    provider: runtime,
    enabled: connection.connected && runtime !== null,
    forceReload: true,
    connectionGeneration: connection.generation,
  });
  const inventory = useQuery({
    ...options,
    placeholderData: () => undefined,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const skills = [
    ...new Map((inventory.data?.skills ?? []).map((skill) => [skill.path, skill])).values(),
  ];
  useEffect(() => {
    if (!inventory.data) return;
    const paths = new Set(inventory.data.skills.map((skill) => skill.path));
    setSelected((current) => current.filter((path) => paths.has(path)));
  }, [inventory.data]);
  const needle = search.trim().toLocaleLowerCase();
  const visible = skills.filter((skill) =>
    `${skill.name} ${skill.description ?? ""} ${skill.path}`.toLocaleLowerCase().includes(needle),
  );
  const selectable = visible.filter(canCopy);
  const allChecked =
    selectable.length > 0 && selectable.every((skill) => selected.includes(skill.path));
  const hiddenSelected = selected.filter(
    (path) => !visible.some((skill) => skill.path === path),
  ).length;
  const label = RUNTIMES.find((item) => item.value === runtime)?.label;
  const resultSummary = results.length
    ? `已导入 ${results.filter((item) => item.status === "imported").length} 个，已跳过 ${results.filter((item) => item.status === "skipped").length} 个${results.some((item) => item.status === "failed") ? `，${results.filter((item) => item.status === "failed").length} 个失败` : ""}。`
    : null;
  const importing = async () => {
    if (inFlight.current || !connection.connected || !runtime || !selected.length) return;
    const items = skills.filter((skill) => selected.includes(skill.path) && canCopy(skill));
    if (!items.length) return;
    inFlight.current = true;
    setBusy(true);
    onBusyChange(true);
    setResults([]);
    setError(null);
    const started = connection.generation;
    const current = () => mounted.current && generation.current === started;
    const client = ensureExpertClient();
    const copied: CopyResult[] = [];
    try {
      for (const skill of items) {
        if (!current()) break;
        let previewId: string | null = globalThis.crypto.randomUUID();
        try {
          const response = await client.skillLibrary({
            action: "previewImport",
            kind: "runtime",
            location: skill.path,
            requestId: previewId,
          });
          if (!current()) break;
          const preview = response.preview;
          if (!preview) throw new Error("无法读取这个技能，请重新发现后重试。");
          previewId = preview.previewId;
          // A discovered SKILL.md denotes this entry only, even if the complete
          // resource package contains additional, nested Skill entrypoints.
          const entry = preview.package.entries.find((entry) => entry.entryPath === "SKILL.md");
          if (
            !entry ||
            (preview.selectedEntryPaths && !preview.selectedEntryPaths.includes(entry.entryPath))
          )
            throw new Error("这个技能的入口已变化，请重新发现后重试。");
          if (entry.incompatibleReason) throw new Error(entry.incompatibleReason);
          const result = await client.skillLibrary({
            action: "import",
            previewId,
            requestId: globalThis.crypto.randomUUID(),
            choices: [{ entryPath: entry.entryPath, duplicate: "skip" }],
          });
          if (!result.skills) throw new Error("未收到导入结果，请刷新技能库后重试。");
          previewId = null;
          if (!current()) break;
          copied.push({
            path: skill.path,
            name: skill.name,
            status: result.skills?.length ? "imported" : "skipped",
          });
        } catch (cause) {
          if (!current()) break;
          copied.push({
            path: skill.path,
            name: skill.name,
            status: "failed",
            error: cause instanceof Error ? cause.message : String(cause),
          });
        } finally {
          if (previewId && generation.current === started)
            await client.skillLibrary({ action: "cancel", previewId }).catch(() => undefined);
        }
        if (current()) setResults([...copied]);
      }
      if (!current()) return;
      const completed = new Set(
        copied.filter((item) => item.status !== "failed").map((item) => item.path),
      );
      setSelected((value) => value.filter((path) => !completed.has(path)));
      if (copied.some((item) => item.status === "imported")) {
        try {
          await onChanged();
        } catch {
          if (current()) setError("技能已保存，但列表刷新失败，请稍后刷新技能库。");
        }
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
      onBusyChange(false);
    }
  };
  return (
    <>
      <DialogPanel className="space-y-4">
        <label className="block space-y-2 text-ui-sm">
          <span>运行时</span>
          <Select
            value={runtime}
            onValueChange={(value) => {
              if (!RUNTIMES.some((item) => item.value === value)) return;
              setRuntime(value as Runtime);
              setSelected([]);
              setSearch("");
              setResults([]);
              setError(null);
            }}
          >
            <SelectTrigger
              aria-label="选择运行时"
              disabled={busy || !connection.connected}
              className="w-full"
            >
              <SelectValue placeholder="选择运行时">{label}</SelectValue>
            </SelectTrigger>
            <SettingsSelectPopup>
              {RUNTIMES.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  <ProviderIcon provider={item.value} className="size-4" />
                  {item.label}
                </SelectItem>
              ))}
            </SettingsSelectPopup>
          </Select>
        </label>
        {!connection.connected ? (
          <p role="alert" className="text-ui-sm text-destructive">
            服务器未连接，暂时无法发现或导入技能。
          </p>
        ) : null}
        {runtime ? (
          <>
            <div className="flex min-w-0 items-center gap-2">
              <Input
                aria-label="搜索运行时技能"
                placeholder="搜索本地技能"
                value={search}
                disabled={busy}
                onChange={(event) => setSearch(event.target.value)}
              />
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || !connection.connected || inventory.isFetching}
                onClick={() => void inventory.refetch()}
              >
                重新发现
              </Button>
            </div>
            {inventory.isFetching ? (
              <p role="status" className="text-ui-sm text-muted-foreground">
                正在发现 {label} 的本机技能…
              </p>
            ) : null}
            {inventory.isError ? (
              <p role="alert" className="text-ui-sm text-destructive">
                无法发现运行时技能，请重试。
              </p>
            ) : null}
            {!inventory.isFetching &&
            !inventory.isError &&
            connection.connected &&
            !visible.length ? (
              <SettingsEmptyState layout="status">
                {needle ? "没有匹配的运行时技能。" : `未发现 ${label} 的本机技能。`}
              </SettingsEmptyState>
            ) : null}
            {visible.length > 0 ? (
              <>
                <label className="flex items-center gap-2 text-ui-sm">
                  <Checkbox
                    aria-label="全选当前运行时技能"
                    disabled={busy || inventory.isFetching || !selectable.length}
                    checked={allChecked}
                    indeterminate={
                      !allChecked && selectable.some((skill) => selected.includes(skill.path))
                    }
                    onCheckedChange={(checked) =>
                      setSelected((current) =>
                        checked
                          ? [...new Set([...current, ...selectable.map((skill) => skill.path)])]
                          : current.filter(
                              (path) => !selectable.some((skill) => skill.path === path),
                            ),
                      )
                    }
                  />
                  全选（{selectable.length}）
                </label>
                <ul
                  className="space-y-2"
                  aria-label="可复制的运行时技能"
                  aria-busy={busy || inventory.isFetching}
                >
                  {visible.map((skill) => (
                    <li key={skill.path} className="rounded-xl border border-border p-3">
                      <div className="flex min-w-0 items-start gap-3">
                        <Checkbox
                          aria-label={`复制 ${skill.name}`}
                          disabled={busy || inventory.isFetching || !canCopy(skill)}
                          checked={selected.includes(skill.path)}
                          onCheckedChange={(checked) =>
                            setSelected((current) =>
                              checked
                                ? [...new Set([...current, skill.path])]
                                : current.filter((path) => path !== skill.path),
                            )
                          }
                        />
                        <span className="min-w-0 flex-1 space-y-1">
                          <span className="block break-words text-ui font-medium">
                            {skill.name}
                          </span>
                          {skill.description ? (
                            <span className="line-clamp-2 break-words text-ui-sm text-muted-foreground">
                              {skill.description}
                            </span>
                          ) : null}
                          <span className="block break-all text-ui-xs text-muted-foreground">
                            {skill.scope} · {skill.path}
                          </span>
                          {!canCopy(skill) ? (
                            <span className="block text-ui-xs text-muted-foreground">
                              此技能格式暂不支持复制。
                            </span>
                          ) : null}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </>
        ) : (
          <SettingsEmptyState layout="status">
            选择一个运行时后发现已安装的技能。
          </SettingsEmptyState>
        )}
        <p className="text-ui-xs text-muted-foreground">
          复制完整技能包，保留原文件。同名技能将跳过，不覆盖技能库中的已有内容。
        </p>
        {results.some((item) => item.status === "failed") ? (
          <div role="alert" className="space-y-2 text-ui-sm">
            {results
              .filter((item) => item.status === "failed")
              .map((item) => (
                <p key={item.path} className="break-words text-destructive">
                  {item.name}：{item.error}
                </p>
              ))}
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-ui-sm text-destructive">
            {error}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <p
          role={results.length ? "status" : undefined}
          className="mr-auto min-w-0 self-center text-ui-xs text-muted-foreground"
        >
          {resultSummary ??
            `已选择 ${selected.length} 个${hiddenSelected ? `（${hiddenSelected} 个不在当前搜索中）` : ""}`}
        </p>
        <Button variant="outline" disabled={busy} onClick={onClose}>
          {results.length ? "完成" : "取消"}
        </Button>
        <Button
          disabled={
            busy ||
            !connection.connected ||
            inventory.isFetching ||
            inventory.isError ||
            !selected.length
          }
          onClick={() => void importing()}
        >
          {busy ? "正在导入…" : "导入选中技能"}
        </Button>
      </DialogFooter>
    </>
  );
}
