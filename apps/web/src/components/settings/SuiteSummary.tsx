import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ExpertDraftSelection, SuiteComposition, SuiteRef } from "@synara/contracts";
import { ensureExpertClient } from "~/workbench/host/expertClient";
import { Button } from "../ui/button";
import { EXPERTS_QUERY_KEY } from "./expertSettingsQueries";
import { SuiteDisclosure } from "./SuiteDisclosure";

export const suiteErrorText = (error: unknown) =>
  error instanceof Error ? error.message : "读取失败，请重试。";

export function SuiteSummary({
  suite,
  onUseExpert,
}: {
  suite: SuiteComposition;
  onUseExpert?: (selection: ExpertDraftSelection) => Promise<void>;
}) {
  const experts = useQuery({
    queryKey: EXPERTS_QUERY_KEY,
    queryFn: () => ensureExpertClient().listExperts(),
  });
  return (
    <div className="space-y-3 text-ui">
      <p className="whitespace-pre-wrap text-muted-foreground">{suite.description}</p>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {suite.members.map((member) => {
          const expert = experts.data?.find((candidate) => candidate.id === member.expertId);
          const resources = suite.resources.filter(
            (resource) =>
              resource.audience === "shared" ||
              (typeof resource.audience === "object" && resource.audience.expertKey === member.key),
          );
          return (
            <li key={member.key} className="p-3">
              <SuiteDisclosure
                label={<span className="font-medium">{expert?.name ?? member.key}</span>}
              >
                {expert ? (
                  <>
                    <p className="whitespace-pre-wrap text-ui-sm">{expert.description}</p>
                    <p className="whitespace-pre-wrap text-ui-sm text-muted-foreground">
                      {expert.useCases}
                    </p>
                  </>
                ) : (
                  <p className="text-ui-sm" role="status">
                    {experts.isPending
                      ? "正在读取职责…"
                      : experts.error
                        ? suiteErrorText(experts.error)
                        : "该成员当前不可读取。"}
                  </p>
                )}
                {resources.length ? (
                  <ul className="space-y-1 text-ui-sm text-muted-foreground" aria-label="主要能力">
                    {resources.map((resource) => (
                      <li key={resource.key}>
                        {resource.key}
                        {resource.purpose ? ` · ${resource.purpose}` : ""}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {onUseExpert ? (
                  <SuiteMemberUse
                    expertId={member.expertId}
                    suite={suite.ref}
                    disabled={!expert || expert.archived}
                    onUse={onUseExpert}
                  />
                ) : null}
                {expert?.skills.length ? (
                  <p className="text-ui-sm text-muted-foreground">
                    自身 Skills：{expert.skills.map((skill) => skill.name).join("、")}
                  </p>
                ) : null}
              </SuiteDisclosure>
            </li>
          );
        })}
      </ul>
      {experts.isError ? (
        <Button variant="outline" onClick={() => void experts.refetch()}>
          重试读取成员
        </Button>
      ) : null}
      <SuiteDisclosure label="来源">
        <p className="break-all text-ui-sm text-muted-foreground">
          {suite.source.kind === "github"
            ? `${suite.source.repository}/${suite.source.subdirectory} · ${suite.source.resolvedCommit}`
            : "本地文件夹内容基线"}
        </p>
        <p className="break-all text-ui-sm text-muted-foreground">{suite.source.contentHash}</p>
      </SuiteDisclosure>
    </div>
  );
}

function SuiteMemberUse({
  expertId,
  suite,
  disabled,
  onUse,
}: {
  expertId: string;
  suite: SuiteRef;
  disabled: boolean;
  onUse: (selection: ExpertDraftSelection) => Promise<void>;
}) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button
        disabled={disabled || busy}
        onClick={() => {
          if (pending.current) return;
          pending.current = true;
          setBusy(true);
          setError(null);
          void onUse({ expertId, suite })
            .catch((cause: unknown) => setError(suiteErrorText(cause)))
            .finally(() => {
              pending.current = false;
              setBusy(false);
            });
        }}
      >
        {busy ? "正在打开…" : "使用此 Expert"}
      </Button>
      {error ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {error}
        </p>
      ) : null}
    </>
  );
}
