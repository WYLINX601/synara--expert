import { useQuery } from "@tanstack/react-query";
import type { ThreadId } from "@synara/contracts";
import { ensureExpertClient } from "~/workbench/host/expertClient";
import { suiteErrorText } from "../settings/SuiteSummary";
import { suiteQueryKey } from "../settings/expertSettingsQueries";
import { SuiteDisclosure } from "../settings/SuiteDisclosure";
import { Button } from "../ui/button";
import { useTranslation } from "~/i18n";

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
  const { t } = useTranslation();
  const suite = useQuery({
    queryKey: suiteQueryKey(prepared?.suite ?? null),
    queryFn: () => ensureExpertClient().readSuite(prepared!.suite!),
    enabled: Boolean(prepared?.suite),
  });
  return (
    <section className="space-y-2" aria-label={t("chat:suiteRunConfigAria")}>
      <h3 className="font-medium">{t("chat:suiteRunConfigTitle")}</h3>
      {rootRunId === null ? (
        <p className="text-ui-sm text-muted-foreground">{t("chat:suiteRunConfigNoReceipt")}</p>
      ) : configuration.isPending ? (
        <p role="status" className="text-ui-sm">
          {t("chat:suiteRunConfigLoading")}
        </p>
      ) : configuration.isError ? (
        <div role="alert" className="text-ui-sm">
          <p>{suiteErrorText(configuration.error)}</p>
          <Button variant="outline" onClick={() => void configuration.refetch()}>
            {t("chat:suiteRunConfigRetry")}
          </Button>
        </div>
      ) : configuration.data?.state === "not-prepared" ? (
        <p className="text-ui-sm text-muted-foreground">{t("chat:suiteRunConfigNotPrepared")}</p>
      ) : prepared ? (
        <>
          {prepared.suite ? (
            <p>
              {suite.data?.name ??
                (suite.isError ? t("chat:suiteNameUnavailable") : t("chat:suiteNameLoading"))}{" "}
              {t("chat:expertPickerSuiteRevision", { revision: prepared.suite.revision })}
            </p>
          ) : null}
          <dl className="grid gap-1 text-ui-sm">
            <div className="flex flex-wrap gap-x-2">
              <dt>{t("chat:suiteRunConfigLanguage")}</dt>
              <dd>{prepared.effectiveConfig.language ?? t("chat:suiteRunConfigUnspecified")}</dd>
            </div>
            <div className="flex flex-wrap gap-x-2">
              <dt>{t("chat:suiteRunConfigOutput")}</dt>
              <dd className="break-all">
                {prepared.effectiveConfig.outputDirectory ?? t("chat:suiteRunConfigUnspecified")}
              </dd>
            </div>
          </dl>
          <SuiteDisclosure label={t("chat:suiteRunConfigSources")}>
            <ul className="space-y-1 text-ui-sm text-muted-foreground">
              {prepared.effectiveConfig.provenance.map((source, index) => (
                <li key={index} className="break-all">
                  {source.field === "language"
                    ? t("chat:suiteRunConfigLanguage")
                    : t("chat:suiteRunConfigOutput")}{" "}
                  · {source.layer} · {source.sourceId}：{source.value}
                </li>
              ))}
            </ul>
            <p className="break-all text-ui-sm text-muted-foreground">
              {t("chat:suiteRunConfigAssembly", { assemblyId: prepared.assemblyId })}
            </p>
          </SuiteDisclosure>
          {prepared.effectiveConfig.issues.length ? (
            <ul className="space-y-1 text-ui-sm" aria-label={t("chat:suiteRunConfigIssuesAria")}>
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
