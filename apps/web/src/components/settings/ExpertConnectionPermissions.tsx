import type { ExpertConnectionConfig, ExpertSaveInput } from "@synara/contracts";
import { useQueries } from "@tanstack/react-query";
import { useId } from "react";
import { PlusIcon } from "~/lib/icons";
import { ensureExpertClient } from "~/workbench/host/expertClient";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { connectionStateQueryKey } from "./globalMcpSettingsModel";
import { SettingsListRow, SettingsSectionShell } from "./SettingsPanelPrimitives";

type ExpertConnectionBinding = ExpertSaveInput["connections"][number];

function ConnectionInfoLabel({ label, detail }: { label: string; detail: string }) {
  const detailId = useId();
  return (
    <Tooltip>
      <TooltipTrigger
        aria-describedby={detailId}
        className="rounded-md bg-foreground/5 px-1.5 py-0.5 text-ui-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-border-focus)]"
      >
        {label}
      </TooltipTrigger>
      <TooltipPopup
        id={detailId}
        role="tooltip"
        side="top"
        align="start"
        className="max-w-72 whitespace-normal"
      >
        {detail}
      </TooltipPopup>
    </Tooltip>
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
  onManage: (connectionId?: string) => void;
}) {
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
  const configurationIds = new Set(configurations.map((configuration) => configuration.id));
  const orphanedBindings = bindings.filter((binding) => !configurationIds.has(binding.id));
  const selectedToolCount = bindings.reduce((total, binding) => total + binding.tools.length, 0);

  return (
    <SettingsSectionShell
      title="MCP 工具"
      count={selectedToolCount}
      layout="compact"
      action={
        <Button
          size="sm"
          variant="ghost"
          aria-label="添加专家 MCP 连接"
          disabled={disabled}
          onClick={() => onManage()}
        >
          <PlusIcon aria-hidden="true" className="size-3.5" />
          添加连接
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
      ) : configurations.length > 0 ? (
        <ul className="divide-y divide-border border-t border-border" aria-label="专家 MCP 连接">
          {configurations.map((configuration) => {
            const binding = bindings.find((item) => item.id === configuration.id);
            const tools = binding?.tools ?? [];
            const enabled = Boolean(binding && binding.enabled !== false && tools.length > 0);
            const state = connectionStates.get(configuration.id);
            const availability =
              !state || state.isPending
                ? {
                    label: "状态未知",
                    detail: "正在读取全局状态；当前可用性未知。",
                  }
                : state.isError || !state.data
                  ? {
                      label: "状态未知",
                      detail: "无法读取全局状态；当前可用性未知。",
                    }
                  : state.data.status === "disabled"
                    ? {
                        label: "全局停用",
                        detail: "已全局停用；专家授权和工具白名单保留，但当前不可调用。",
                      }
                    : state.data.status === "retired"
                      ? {
                          label: "已退役",
                          detail: "此连接已退役，当前不可调用。",
                        }
                      : null;
            const authorization =
              binding?.enabled === false
                ? {
                    label: `${tools.length} 项工具`,
                    detail: `此专家已关闭该连接；保留 ${tools.length} 项工具白名单，但不会授权调用。`,
                  }
                : enabled
                  ? {
                      label: `${tools.length} 项工具`,
                      detail: `此专家已获准使用所选的 ${tools.length} 项工具；${binding?.required ? "连接不可用时阻止启动任务。" : "连接不可用时可继续启动任务。"}`,
                    }
                  : {
                      label: `${tools.length} 项工具`,
                      detail: "尚未选择工具；此连接不会被授权调用。",
                    };

            return (
              <li key={configuration.id}>
                <SettingsListRow
                  layout="compact"
                  className="px-0 py-2"
                  title={<span title={configuration.name}>{configuration.name}</span>}
                  description={
                    <div className="flex flex-wrap items-center gap-1.5">
                      <ConnectionInfoLabel {...authorization} />
                      {binding?.required ? (
                        <ConnectionInfoLabel
                          label="必需"
                          detail="启用此连接时，连接不可用会阻止启动任务；关闭后不参与依赖检查。"
                        />
                      ) : null}
                      {availability ? (
                        <span role="status">
                          <ConnectionInfoLabel {...availability} />
                        </span>
                      ) : null}
                    </div>
                  }
                  actions={
                    <>
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={disabled}
                        onClick={() => onManage(configuration.id)}
                      >
                        {tools.length > 0 ? "管理工具" : "选择工具"}
                      </Button>
                      {tools.length > 0 ? (
                        <Switch
                          aria-label={`允许使用 ${configuration.name}`}
                          checked={enabled}
                          disabled={disabled}
                          onCheckedChange={(next) =>
                            onChange(
                              bindings.map((item) =>
                                item.id === configuration.id ? { ...item, enabled: next } : item,
                              ),
                            )
                          }
                        />
                      ) : null}
                    </>
                  }
                />
              </li>
            );
          })}
        </ul>
      ) : null}
      {orphanedBindings.map((binding) => (
        <p key={binding.id} className="text-ui-xs text-muted-foreground" role="status">
          {binding.id} 已不在当前连接目录中；保留 {binding.tools.length} 项工具白名单与原状态。
        </p>
      ))}
    </SettingsSectionShell>
  );
}
