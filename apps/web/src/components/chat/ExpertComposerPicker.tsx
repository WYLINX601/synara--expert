import {
  type ExpertDefinition,
  type ExpertPreview,
  type ProviderInstanceId,
  type ProviderKind,
} from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { isExpertProvider } from "@synara/shared/expertProviders";

import { ensureExpertClient } from "~/workbench/host/expertClient";
import { CheckIcon, ChevronDownIcon } from "~/lib/icons";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuTrigger } from "../ui/menu";
import { expertPreviewQueryKey } from "../settings/expertSettingsQueries";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
import { COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME } from "./composerPickerStyles";

const EXPERTS_QUERY_KEY = ["server", "experts"] as const;

export function useExpertComposerPreview(
  expertId: string | undefined,
  provider: ProviderKind,
  providerInstanceId: ProviderInstanceId | undefined,
  cwd: string | null | undefined,
  enabled: boolean,
) {
  const previewProvider = isExpertProvider(provider) ? provider : null;
  const query = useQuery({
    queryKey: expertPreviewQueryKey(expertId ?? "", 0, provider, providerInstanceId, cwd),
    queryFn: () =>
      ensureExpertClient().previewExpert({
        expertId: expertId ?? "",
        provider: previewProvider ?? "codex",
        ...(providerInstanceId ? { providerInstanceId } : {}),
        ...(cwd ? { cwd } : {}),
      }),
    enabled: Boolean(enabled && expertId && previewProvider),
    staleTime: 10_000,
  });

  return {
    preview: query.data,
    isFetching: query.isFetching,
    isError: query.isError,
    unsupportedProvider: !previewProvider,
  };
}

export function useExpertDefinitions(enabled: boolean) {
  return useQuery({
    queryKey: EXPERTS_QUERY_KEY,
    queryFn: () => ensureExpertClient().listExperts(),
    enabled,
    staleTime: 30_000,
  });
}

function statusLabel(status: ExpertPreview["status"]): string {
  switch (status) {
    case "available":
      return "可用";
    case "partial":
      return "部分可用";
    case "blocked":
      return "需连接";
    case "incompatible":
      return "不兼容";
  }
}

function statusTone(status: ExpertPreview["status"] | undefined): string {
  if (status === "blocked" || status === "incompatible") {
    return "text-[var(--color-text-destructive)]";
  }
  return "text-muted-foreground";
}

interface ExpertComposerSummaryProps {
  expertId: string | undefined;
  provider: ProviderKind;
  preview: ExpertPreview | undefined;
  previewFetching: boolean;
  previewError: boolean;
  unsupportedProvider: boolean;
}

export function ExpertComposerSummary({ expertId }: ExpertComposerSummaryProps) {
  const expertsQuery = useExpertDefinitions(Boolean(expertId));
  if (!expertId) return null;

  const expert = expertsQuery.data?.find((definition) => definition.id === expertId);
  const name = expert?.name ?? "已选专家";
  const description = expert?.description.trim() || expert?.useCases.trim() || "";

  return (
    <div
      className="mb-2 flex min-w-0 items-center gap-2 rounded-xl border border-border/60 bg-[var(--color-background-elevated-secondary)] px-3 py-2"
      role="status"
      aria-live="polite"
    >
      <span className="max-w-40 shrink-0 truncate text-ui-sm font-medium" title={name}>
        {name}
      </span>
      {description ? (
        <span
          className="min-w-0 flex-1 truncate text-ui-xs text-muted-foreground"
          title={description}
        >
          {description}
        </span>
      ) : null}
    </div>
  );
}

interface ExpertComposerPickerProps {
  expertId: string | undefined;
  provider: ProviderKind;
  preview: ExpertPreview | undefined;
  previewFetching: boolean;
  previewError: boolean;
  unsupportedProvider: boolean;
  onSelect: (expertId: string | undefined) => void;
  onSelectionCommitted?: () => void;
}

export function ExpertComposerPicker({
  expertId,
  preview,
  previewFetching,
  previewError,
  unsupportedProvider,
  onSelect,
  onSelectionCommitted,
}: ExpertComposerPickerProps) {
  const expertsQuery = useExpertDefinitions(true);
  const experts = expertsQuery.data ?? [];
  const activeExperts = experts.filter((expert) => !expert.archived);
  const selectedExpert = activeExperts.find((expert) => expert.id === expertId);
  const selectedStatus = expertId
    ? unsupportedProvider
      ? "incompatible"
      : preview?.status
    : undefined;
  const triggerLabel = selectedExpert?.name ?? (expertId ? "已选专家" : "通用");
  const previewSummary = selectedStatus
    ? statusLabel(selectedStatus)
    : previewFetching
      ? "正在检查"
      : previewError
        ? "检查失败"
        : null;

  const commitSelection = (nextExpertId: string | undefined) => {
    onSelect(nextExpertId);
    onSelectionCommitted?.();
  };

  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            className={COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME}
            aria-label={selectedExpert ? `专家：${selectedExpert.name}` : "选择专家"}
            title={
              selectedStatus
                ? `${triggerLabel} · ${statusLabel(selectedStatus)}`
                : `${triggerLabel} · 选择要用于新任务的专家`
            }
          />
        }
      >
        <span className="max-w-28 truncate">{triggerLabel}</span>
        {previewSummary ? (
          <span
            className={`hidden max-w-20 truncate text-ui-xs sm:inline ${statusTone(selectedStatus)}`}
          >
            {previewSummary}
          </span>
        ) : null}
        <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
      </MenuTrigger>
      <ComposerPickerMenuPopup align="start" side="top" sideOffset={6} className="w-72">
        <MenuGroup>
          <MenuGroupLabel>任务专家</MenuGroupLabel>
          <MenuItem onClick={() => commitSelection(undefined)}>
            <span className="min-w-0 flex-1">通用</span>
            {!expertId ? (
              <CheckIcon className="size-3.5 shrink-0 text-[var(--color-text-foreground)]" />
            ) : null}
          </MenuItem>
          {expertsQuery.isLoading ? (
            <div className="px-2 py-1.5 text-ui-sm text-muted-foreground">正在读取专家…</div>
          ) : expertsQuery.isError ? (
            <div className="px-2 py-1.5 text-ui-sm text-[var(--color-text-destructive)]">
              无法读取专家列表。
            </div>
          ) : activeExperts.length === 0 ? (
            <div className="px-2 py-1.5 text-ui-sm text-muted-foreground">还没有可用的专家。</div>
          ) : (
            activeExperts.map((expert: ExpertDefinition) => (
              <MenuItem key={expert.id} onClick={() => commitSelection(expert.id)}>
                <span className="min-w-0 flex-1 truncate">{expert.name}</span>
                {expert.id === expertId ? (
                  <CheckIcon className="size-3.5 shrink-0 text-[var(--color-text-foreground)]" />
                ) : null}
              </MenuItem>
            ))
          )}
        </MenuGroup>
        {expertId ? (
          <div className="space-y-1.5 border-t border-border/60 px-2.5 py-2">
            <div className={`text-ui-sm font-medium ${statusTone(selectedStatus)}`}>
              {unsupportedProvider
                ? "当前 Provider 不支持专家"
                : (previewSummary ?? "等待预览结果")}
            </div>
            {preview?.issues.length ? (
              <ul className="list-disc space-y-1 pl-4 text-ui-xs text-muted-foreground">
                {preview.issues.slice(0, 4).map((issue, index) => (
                  <li key={`${index}:${issue}`} className="break-words">
                    {issue}
                  </li>
                ))}
              </ul>
            ) : previewError ? (
              <p className="text-ui-xs text-muted-foreground">预览检查失败，发送时会再次检查。</p>
            ) : null}
          </div>
        ) : null}
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
