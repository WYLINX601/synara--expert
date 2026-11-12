import { useQuery } from "@tanstack/react-query";
import type { ThreadId } from "@synara/contracts";
import { ensureExpertClient } from "~/workbench/host/expertClient";
import { suiteErrorText } from "../settings/SuiteSummary";
import { suiteQueryKey } from "../settings/expertSettingsQueries";
import { SuiteDisclosure } from "../settings/SuiteDisclosure";
import { Button } from "../ui/button";

export function SuiteRunConfigurationDetails({
  threadId,
  rootRunId,
}: {
  threadId: ThreadId;
  rootRunId: string | null;
}) {
  const configuration = useQuery({
    queryKey: ["server", "suiteRunConfiguration", threadId, rootRunId],
    queryFn: () =>
      ensureExpertClient().readSuiteRunConfiguration({ threadId, rootRunId: rootRunId! }),
    enabled: rootRunId !== null,
  });
  const prepared = configuration.data?.state === "prepared" ? configuration.data : null;
  const suite = useQuery({
    queryKey: suiteQueryKey(prepared?.suite ?? null),
    queryFn: () => ensureExpertClient().readSuite(prepared!.suite!),
    enabled: Boolean(prepared?.suite),
  });
  return (
    <section className="space-y-2" aria-label="本次运行配置">
      <h3 className="font-medium">本次运行配置与来源</h3>
      {rootRunId === null ? (
        <p className="text-ui-sm text-muted-foreground">
          尚未取得已应用的运行装配回执，不能推算当前配置。
        </p>
      ) : configuration.isPending ? (
        <p role="status" className="text-ui-sm">
          正在读取固定配置…
        </p>
      ) : configuration.isError ? (
        <div role="alert" className="text-ui-sm">
          <p>{suiteErrorText(configuration.error)}</p>
          <Button variant="outline" onClick={() => void configuration.refetch()}>
            重试读取
          </Button>
        </div>
      ) : configuration.data?.state === "not-prepared" ? (
        <p className="text-ui-sm text-muted-foreground">本次运行尚未准备配置。</p>
      ) : prepared ? (
        <>
          {prepared.suite ? (
            <p>
              {suite.data?.name ??
                (suite.isError ? "Suite 名称暂不可读取" : "正在读取 Suite 名称…")}{" "}
              · r{prepared.suite.revision}
            </p>
          ) : null}
          <dl className="grid gap-1 text-ui-sm">
            <div className="flex flex-wrap gap-x-2">
              <dt>语言</dt>
              <dd>{prepared.effectiveConfig.language ?? "未指定"}</dd>
            </div>
            <div className="flex flex-wrap gap-x-2">
              <dt>输出位置</dt>
              <dd className="break-all">{prepared.effectiveConfig.outputDirectory ?? "未指定"}</dd>
            </div>
          </dl>
          <SuiteDisclosure label="配置来源">
            <ul className="space-y-1 text-ui-sm text-muted-foreground">
              {prepared.effectiveConfig.provenance.map((source, index) => (
                <li key={index} className="break-all">
                  {source.field === "language" ? "语言" : "输出位置"} · {source.layer} ·{" "}
                  {source.sourceId}：{source.value}
                </li>
              ))}
            </ul>
            <p className="break-all text-ui-sm text-muted-foreground">装配 {prepared.assemblyId}</p>
          </SuiteDisclosure>
          {prepared.effectiveConfig.issues.length ? (
            <ul className="space-y-1 text-ui-sm" aria-label="运行能力问题">
              {prepared.effectiveConfig.issues.map((issue, index) => (
                <li key={index}>
                  {issue.subject.id} · {issue.message}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
