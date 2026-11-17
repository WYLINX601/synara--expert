import { useQuery } from "@tanstack/react-query";
import type { SuiteRef } from "@synara/contracts";
import { ensureExpertClient } from "~/workbench/host/expertClient";
import { SettingsSelectControl } from "~/components/settings/SettingControls";
import { SuiteSummary, suiteErrorText } from "~/components/settings/SuiteSummary";
import { SUITES_QUERY_KEY, suiteQueryKey } from "~/components/settings/expertSettingsQueries";
import { SelectItem } from "~/components/ui/select";
import { Button } from "~/components/ui/button";
import { useTranslation } from "~/i18n";

export function GroupSuiteSection({
  suite,
  onChange,
  readonly = false,
}: {
  suite: SuiteRef | null;
  onChange?: (suite: SuiteRef | null) => void;
  readonly?: boolean;
}) {
  const catalog = useQuery({
    queryKey: SUITES_QUERY_KEY,
    queryFn: () => ensureExpertClient().listSuites(),
    enabled: !readonly,
  });
  const record = useQuery({
    queryKey: suiteQueryKey(suite),
    queryFn: () => ensureExpertClient().readSuite(suite!),
    enabled: suite !== null,
  });
  const key = suite ? `${suite.suiteId}:${suite.revision}` : "none";
  const { t } = useTranslation();
  return (
    <section className="space-y-3 text-ui" aria-label={t("chat:groupSuiteAria")}>
      <h3 className="font-medium">{t("common:suiteTerm")}</h3>
      {!readonly ? (
        <SettingsSelectControl
          value={key}
          ariaLabel={t("chat:groupSuiteSelectAria")}
          valueContent={
            suite ? (record.data?.name ?? t("chat:suiteLoading")) : t("chat:groupSuiteNone")
          }
          triggerClassName="w-full"
          onValueChange={(value) => {
            if (value === "none") onChange?.(null);
            else {
              const selected = catalog.data?.find(
                (entry) => `${entry.ref.suiteId}:${entry.ref.revision}` === value,
              );
              if (selected) onChange?.(selected.ref);
            }
          }}
        >
          <SelectItem value="none">{t("chat:groupSuiteNone")}</SelectItem>
          {catalog.data?.map((entry) => (
            <SelectItem
              key={`${entry.ref.suiteId}:${entry.ref.revision}`}
              value={`${entry.ref.suiteId}:${entry.ref.revision}`}
            >
              {entry.name}
            </SelectItem>
          ))}
        </SettingsSelectControl>
      ) : null}
      {catalog.isError && !readonly ? (
        <div role="alert" className="text-ui-sm">
          <p>
            {t("chat:groupSuiteCatalogUnavailable")}
            {suiteErrorText(catalog.error)}
          </p>
          <Button variant="outline" onClick={() => void catalog.refetch()}>
            {t("chat:groupSuiteRetryCatalog")}
          </Button>
        </div>
      ) : catalog.isPending && !readonly ? (
        <p role="status" className="text-ui-sm text-muted-foreground">
          {t("chat:groupSuiteLoadingCatalog")}
        </p>
      ) : null}
      {record.data ? (
        <>
          <p className="font-medium">{record.data.name}</p>
          <SuiteSummary suite={record.data} />
        </>
      ) : suite ? (
        record.isError ? (
          <div role="alert">
            <p>{suiteErrorText(record.error)}</p>
            <Button variant="outline" onClick={() => void record.refetch()}>
              {t("chat:groupSuiteRetryRead")}
            </Button>
          </div>
        ) : (
          <p role="status">{t("chat:groupSuiteLoadingMembers")}</p>
        )
      ) : null}
    </section>
  );
}
