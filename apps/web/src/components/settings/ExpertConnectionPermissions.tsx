import type { ExpertConnectionConfig, ExpertSaveInput } from "@synara/contracts";
import { useQueries } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useState } from "react";
import { PlusIcon, XIcon } from "~/lib/icons";
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
import { SearchInput } from "../ui/search-input";
import { connectionStateQueryKey } from "./globalMcpSettingsModel";
import {
  SettingsEmptyState,
  SettingsListRow,
  SettingsSectionShell,
} from "./SettingsPanelPrimitives";

type ExpertConnectionBinding = ExpertSaveInput["connections"][number];

function BindingStatus({ label }: { label: string }) {
  return (
    <span className="rounded-md bg-foreground/5 px-1.5 py-0.5 text-ui-xs text-muted-foreground">
      {label}
    </span>
  );
}

export function ExpertConnectionPermissions({
  configurations,
  bindings,
  loading,
  error,
  disabled,
  onChange,
  onManage,
}: {
  configurations: ReadonlyArray<ExpertConnectionConfig>;
  bindings: ReadonlyArray<ExpertConnectionBinding>;
  loading: boolean;
  error: string | null;
  disabled: boolean;
  onChange: (connections: ExpertConnectionBinding[]) => void;
  onManage: () => void;
}) {
  const pickerId = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const stateResults = useQueries({
    queries: configurations.map((configuration) => ({
      queryKey: connectionStateQueryKey(configuration.id),
      queryFn: () => ensureExpertClient().getExpertConnectionState({ id: configuration.id }),
      retry: false,
    })),
  });
  const connectionStates = new Map(
    configurations.map((configuration, index) => [configuration.id, stateResults[index]]),
  );
  const configurationsById = new Map(
    configurations.map((configuration) => [configuration.id, configuration]),
  );
  const bindingsById = new Map(bindings.map((binding) => [binding.id, binding]));
  const missingBindings = bindings.filter((binding) => !configurationsById.has(binding.id));
  const visibleConfigurations = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return configurations;
    return configurations.filter(
      (configuration) =>
        configuration.name.toLocaleLowerCase().includes(query) ||
        configuration.id.toLocaleLowerCase().includes(query),
    );
  }, [configurations, search]);

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setSelectedIds(new Set(bindings.map((binding) => binding.id)));
  }, [bindings, open]);

  const applySelection = () => {
    if (disabled || loading || error) return;
    const next = bindings
      .filter((binding) => selectedIds.has(binding.id))
      .map((binding) => ({ ...binding, toolMode: "all" as const, tools: [] }));
    const existingIds = new Set(bindings.map((binding) => binding.id));
    for (const configuration of configurations) {
      if (selectedIds.has(configuration.id) && !existingIds.has(configuration.id)) {
        next.push({
          id: configuration.id,
          enabled: true,
          required: false,
          toolMode: "all",
          tools: [],
        });
      }
    }
    onChange(next);
    setOpen(false);
  };

  const connectionStatus = (id: string) => {
    const state = connectionStates.get(id);
    if (!state || state.isPending) return "状态未知";
    if (state.isError || !state.data) return "状态未知";
    if (state.data.status === "disabled") return "全局停用";
    if (state.data.status === "retired") return "已退役";
    return null;
  };

  return (
    <>
      <SettingsSectionShell
        title="MCP 工具"
        count={bindings.length}
        layout="compact"
        action={
          <Button
            size="sm"
            variant="ghost"
            aria-label="添加专家 MCP 连接"
            disabled={disabled}
            onClick={() => setOpen(true)}
          >
            <PlusIcon aria-hidden="true" className="size-3.5" />
            添加
          </Button>
        }
      >
        {error ? (
          <p className="px-3 py-1 text-ui-xs text-destructive" role="alert">
            无法读取专家 MCP 连接：{error}。连接状态未知。
          </p>
        ) : loading ? (
          <p className="px-3 py-1 text-ui-xs text-muted-foreground" role="status">
            正在读取连接配置…
          </p>
        ) : null}
        {bindings.length ? (
          <ul className="divide-y divide-border border-t border-border" aria-label="专家 MCP 连接">
            {bindings.map((binding) => {
              const configuration = configurationsById.get(binding.id);
              const name = configuration?.name ?? binding.id;
              const missing = !configuration;
              const authorization =
                binding.enabled === false
                  ? "已关闭"
                  : binding.toolMode === "all"
                    ? null
                    : "旧版权限";
              const status = connectionStatus(binding.id);
              return (
                <li key={binding.id}>
                  <SettingsListRow
                    layout="compact"
                    className="px-0 py-2"
                    title={<span title={name}>{name}</span>}
                    description={
                      <div className="flex flex-wrap items-center gap-1.5">
                        {authorization ? <BindingStatus label={authorization} /> : null}
                        {binding.required ? <BindingStatus label="必需" /> : null}
                        {missing ? <BindingStatus label="连接缺失" /> : null}
                        {status ? <BindingStatus label={status} /> : null}
                      </div>
                    }
                    actions={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`移除专家 MCP 连接 ${name}`}
                        title="从此专家移除"
                        disabled={disabled}
                        onClick={() => onChange(bindings.filter((item) => item.id !== binding.id))}
                      >
                        <XIcon aria-hidden="true" />
                      </Button>
                    }
                  />
                </li>
              );
            })}
          </ul>
        ) : loading || error ? null : (
          <p className="border-t border-border py-3 text-ui-sm text-muted-foreground">
            尚未添加 MCP 连接。
          </p>
        )}
      </SettingsSectionShell>

      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (nextOpen && disabled) return;
          setOpen(nextOpen);
        }}
      >
        <DialogPopup className="w-[min(38rem,calc(100vw-1.5rem))]">
          <DialogHeader>
            <DialogTitle>添加 MCP</DialogTitle>
            <DialogDescription>
              所选 MCP 将提供全部工具。应用选择会把当前勾选的连接设为全部工具授权。
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="max-h-[min(58vh,34rem)] space-y-3">
            <SearchInput
              aria-label="搜索 MCP 连接"
              placeholder="搜索 MCP 连接"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {error ? (
              <p className="text-ui-sm text-destructive" role="alert">
                无法读取 MCP 连接：{error}
              </p>
            ) : loading ? (
              <p className="py-2 text-ui-sm text-muted-foreground" role="status">
                正在读取 MCP 连接…
              </p>
            ) : null}
            {!loading && !error && visibleConfigurations.length ? (
              <ul className="divide-y divide-border" aria-label="可选 MCP 连接">
                {visibleConfigurations.map((configuration, index) => {
                  const id = `${pickerId}-connection-${index}`;
                  const checked = selectedIds.has(configuration.id);
                  const existingBinding = bindingsById.get(configuration.id);
                  const retired = connectionStatus(configuration.id) === "已退役";
                  return (
                    <li key={configuration.id} className="flex min-w-0 items-center gap-2 py-2">
                      <Checkbox
                        id={id}
                        checked={checked}
                        disabled={disabled || (retired && !existingBinding)}
                        onCheckedChange={(value) =>
                          setSelectedIds((current) => {
                            const next = new Set(current);
                            if (value === true) next.add(configuration.id);
                            else next.delete(configuration.id);
                            return next;
                          })
                        }
                      />
                      <label
                        htmlFor={id}
                        className="min-w-0 flex-1 cursor-pointer truncate text-ui"
                      >
                        {configuration.name}
                      </label>
                      {retired ? <BindingStatus label="已退役" /> : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
            {!loading && !error && missingBindings.length > 0 ? (
              <div className="space-y-1 border-t border-border pt-2">
                <p className="text-ui-xs text-muted-foreground">未找到的已添加连接</p>
                <ul className="divide-y divide-border" aria-label="缺失的已添加 MCP 连接">
                  {missingBindings.map((binding) => {
                    const id = `${pickerId}-missing-${encodeURIComponent(binding.id)}`;
                    return (
                      <li key={binding.id} className="flex min-w-0 items-center gap-2 py-2">
                        <Checkbox
                          id={id}
                          checked={selectedIds.has(binding.id)}
                          disabled={disabled}
                          onCheckedChange={(value) =>
                            setSelectedIds((current) => {
                              const next = new Set(current);
                              if (value === true) next.add(binding.id);
                              else next.delete(binding.id);
                              return next;
                            })
                          }
                        />
                        <label htmlFor={id} className="min-w-0 flex-1 truncate text-ui">
                          {binding.id}
                        </label>
                        <BindingStatus label="连接缺失" />
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
            {!loading && !error && visibleConfigurations.length === 0 ? (
              <div className="space-y-2 py-2">
                <p className="text-ui-sm text-muted-foreground">
                  {configurations.length === 0
                    ? "还没有可用的 MCP 连接。"
                    : "没有匹配的 MCP 连接。"}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setOpen(false);
                    onManage();
                  }}
                >
                  管理 MCP 连接
                </Button>
              </div>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button onClick={applySelection} disabled={disabled || loading || Boolean(error)}>
              应用选择
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
