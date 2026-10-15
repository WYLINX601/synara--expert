import { useMemo, useState } from "react";
import { CircleAlertIcon, CircleCheckIcon, LoaderCircleIcon } from "~/lib/icons";
import { useQuery } from "@tanstack/react-query";
import type { ExpertDefinition, ExpertPreview, ExpertPreviewInput } from "@synara/contracts";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ensureExpertClient } from "~/workbench/host/expertClient";
import { expertPreviewQueryKey } from "./expertSettingsQueries";

function previewStatusLabel(status: ExpertPreview["status"]) {
  switch (status) {
    case "available":
      return "配置预检通过";
    case "partial":
    case "blocked":
    case "incompatible":
      return "存在问题";
  }
}

export function ExpertPreviewPopover({
  expert,
  provider,
  active,
  disabled = false,
}: {
  expert: ExpertDefinition | null;
  provider: ExpertPreviewInput["provider"];
  active: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [requestedKey, setRequestedKey] = useState<string | null>(null);
  const targetKey = useMemo(
    () => (expert ? `${expert.id}:${expert.revision}:${provider}` : null),
    [expert, provider],
  );
  const requested = targetKey !== null && requestedKey === targetKey;
  const query = useQuery({
    queryKey: expertPreviewQueryKey(expert?.id ?? "", expert?.revision ?? 0, provider),
    queryFn: () => ensureExpertClient().previewExpert({ expertId: expert?.id ?? "", provider }),
    enabled: Boolean(active && expert && requested),
    staleTime: 10_000,
  });
  const preview = query.data;
  const hasRevisionMismatch = Boolean(
    expert && preview && preview.definition.revision !== expert.revision,
  );
  const status = !expert
    ? "未检查"
    : query.isError
      ? "检查失败"
      : query.isFetching
        ? "检查中…"
        : hasRevisionMismatch
          ? "版本不一致"
          : preview
            ? previewStatusLabel(preview.status)
            : "未检查";
  const statusTone =
    status === "配置预检通过"
      ? "text-emerald-700 dark:text-emerald-300"
      : status === "存在问题" || status === "版本不一致" || status === "检查失败"
        ? "text-destructive"
        : "text-muted-foreground";

  const openPopover = () => {
    if (expert && !requested) setRequestedKey(targetKey);
    setOpen(true);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            size="sm"
            variant="outline"
            className="min-w-23"
            disabled={!expert || !active || disabled}
            aria-label={status === "未检查" ? "检查配置" : `检查配置：${status}`}
            aria-busy={query.isFetching}
            title={status === "未检查" ? undefined : status}
            onClick={openPopover}
          >
            {query.isFetching ? (
              <LoaderCircleIcon
                aria-hidden="true"
                className="size-3.5 animate-spin motion-reduce:animate-none"
              />
            ) : status === "配置预检通过" ? (
              <CircleCheckIcon aria-hidden="true" className={`size-3.5 ${statusTone}`} />
            ) : status !== "未检查" ? (
              <CircleAlertIcon aria-hidden="true" className={`size-3.5 ${statusTone}`} />
            ) : null}
            检查配置
          </Button>
        }
      />
      <PopoverPopup
        align="end"
        className="w-[min(26rem,calc(100vw-1rem))] p-0 [&_[data-slot=popover-viewport]]:p-0"
      >
        <div className="space-y-3 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-ui font-medium">保存版本配置检查</p>
              <p className="text-ui-sm text-muted-foreground">
                {expert ? `${expert.name} · v${expert.revision}` : "新专家需保存后才能检查。"}
              </p>
            </div>
            <Button
              size="xs"
              variant="outline"
              disabled={!expert || disabled || query.isFetching}
              onClick={() => {
                if (expert) setRequestedKey(targetKey);
                void query.refetch();
              }}
            >
              {query.isFetching ? "检查中…" : "重新检查"}
            </Button>
          </div>
          {!expert ? (
            <p className="text-ui-sm text-muted-foreground">
              保存专家后，可检查技能、连接和运行环境要求。
            </p>
          ) : query.isError ? (
            <p className="text-ui-sm text-destructive" role="alert">
              检查失败：{query.error instanceof Error ? query.error.message : "预检请求失败。"}
            </p>
          ) : query.isLoading || query.isFetching ? (
            <p className="text-ui-sm text-muted-foreground" role="status">
              正在检查保存版本…
            </p>
          ) : !preview ? (
            <p className="text-ui-sm text-muted-foreground">尚未请求预检。</p>
          ) : hasRevisionMismatch ? (
            <p className="text-ui-sm text-destructive" role="alert">
              服务返回版本 v{preview.definition.revision}，与请求的 v{expert.revision}{" "}
              不一致；此结果不能表示配置通过。
            </p>
          ) : (
            <div className="space-y-2" role="status">
              <p className={`text-ui font-medium ${statusTone}`}>
                {previewStatusLabel(preview.status)}
              </p>
              {preview.issues.length > 0 ? (
                <ul className="list-disc space-y-1 pl-5 text-ui-sm text-muted-foreground">
                  {preview.issues.map((issue, index) => (
                    <li key={`${index}:${issue}`}>{issue}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-ui-sm text-muted-foreground">
                  服务未返回问题项。预检不代表 Provider 已启动或 MCP 已联网。
                </p>
              )}
            </div>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
