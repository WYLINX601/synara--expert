import type {
  ProviderKind,
  SkillEvolutionRequest,
  SkillEvolutionResponse,
} from "@synara/contracts";
import { useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { useAppSettings } from "~/appSettings";
import { Button } from "~/components/ui/button";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { Switch } from "~/components/ui/switch";
import { ensureExpertClient } from "~/workbench/host/expertClient";
import { skillEvolutionQueryKey } from "./model";

export const expertLearningQueryKey = (expertId: string) =>
  ["server", "expertLearning", expertId] as const;

/** Both placements read the same owner-scoped server state; no optimistic enable/disable. */
export function ExpertLearningControl({
  expertId,
  provider,
  active,
  disabled = false,
}: {
  expertId: string;
  provider?: ProviderKind | undefined;
  active: boolean;
  disabled?: boolean;
}) {
  const { settings } = useAppSettings();
  const queryClient = useQueryClient();
  const queryKey = expertLearningQueryKey(expertId);
  const mutationKey = [...queryKey, "set"];
  const selectedProvider = provider ?? settings.defaultProvider;
  const supported = selectedProvider === "pi" || selectedProvider === "omp";
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  const learning = useQuery({
    queryKey,
    queryFn: () => ensureExpertClient().skillEvolution({ action: "learningRead", expertId }),
    enabled: active,
    refetchInterval: active ? 5_000 : false,
    staleTime: 2_000,
  });
  const state = learning.data?.learningState;
  const enabled = state?.enabled ?? false;
  const latestMutation = useMutationState({
    filters: { mutationKey, exact: true },
    select: (mutation) => mutation.state.status,
  }).at(-1);
  const pending = latestMutation === "pending";
  const unconfirmed = latestMutation === "error";
  const mutation = useMutation({
    mutationKey,
    retry: false,
    mutationFn: async (request: Extract<SkillEvolutionRequest, { action: "learningSet" }>) => {
      const result = await ensureExpertClient().skillEvolution(request);
      if (!result.learningState || result.learningState.enabled !== request.enabled)
        throw new Error("Learning setting receipt is not confirmed.");
      return result;
    },
    onSuccess: (result) => queryClient.setQueryData<SkillEvolutionResponse>(queryKey, result),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  });
  // Refresh the existing projections without remounting either editor or its feedback drafts.
  useEffect(() => {
    if (!active || !learning.dataUpdatedAt) return;
    void queryClient.invalidateQueries({ queryKey: skillEvolutionQueryKey(expertId) });
    void queryClient.invalidateQueries({ queryKey: ["server", "experts"] });
  }, [active, expertId, learning.dataUpdatedAt, queryClient]);

  const status = pending
    ? "正在保存自学习设置…"
    : learning.isError
      ? "暂时无法确认自学习状态，请稍后重试。"
      : !learning.isSuccess
        ? "正在读取自学习状态…"
        : !enabled
          ? state?.revision
            ? "已关闭 · 技能与行为规则已固定"
            : "已关闭"
          : state?.status === "failed"
            ? "本轮暂未完成，后续任务不受影响。"
            : state?.status === "learning"
              ? "正在从工作经验中学习…"
              : state?.status === "queued"
                ? "等待后台学习，当前工作不受影响。"
                : "已开启 · 等待后续工作";
  return (
    <div className="min-w-0 space-y-1.5" aria-label="专家自学习设置">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1.5">
          <label htmlFor={`${detailsId}-switch`} className="text-ui-sm font-medium">
            自学习
          </label>
          <p className="text-ui-xs text-muted-foreground">
            从后续工作与反馈中自动更新技能和记忆；关闭后固定技能与行为规则。
          </p>
        </div>
        <Switch
          tone="neutral"
          id={`${detailsId}-switch`}
          aria-label="自学习"
          checked={enabled}
          disabled={
            disabled ||
            pending ||
            !learning.isSuccess ||
            learning.isError ||
            (!enabled && !supported)
          }
          onCheckedChange={(next) => {
            mutation.mutate({
              action: "learningSet",
              expertId,
              requestId: `expert-learning-${crypto.randomUUID()}`,
              expectedRevision: state?.revision ?? 0,
              enabled: next,
              ...(next && supported ? { harnessKind: selectedProvider } : {}),
            });
          }}
        />
      </div>
      <p role="status" className="text-ui-xs text-muted-foreground">
        {status}
      </p>
      {!supported ? (
        <p className="text-ui-xs text-muted-foreground">
          当前 Provider 暂不支持自学习；本期支持 Pi 和 Oh My Pi，手动提炼仍可使用。
        </p>
      ) : null}
      {unconfirmed ? (
        <p role="status" className="text-ui-xs text-muted-foreground">
          设置回执未确认。当前显示最近读取的状态，可稍后重试。
        </p>
      ) : null}
      {enabled && state?.status === "failed" && state.summary ? (
        <>
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={detailsOpen}
            aria-controls={detailsId}
            onClick={() => setDetailsOpen((open) => !open)}
          >
            查看学习详情 <DisclosureChevron open={detailsOpen} />
          </Button>
          <DisclosureRegion open={detailsOpen}>
            <p id={detailsId} className="break-words text-ui-xs text-muted-foreground">
              {state.summary}
            </p>
          </DisclosureRegion>
        </>
      ) : null}
    </div>
  );
}
