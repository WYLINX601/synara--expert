import { useQuery } from "@tanstack/react-query";
import type { SuiteRef } from "@synara/contracts";
import { ensureExpertClient } from "~/workbench/host/expertClient";
import { suiteQueryKey } from "~/components/settings/expertSettingsQueries";
import { useTranslation } from "~/i18n";

export function HubSuiteLabel({ suite }: { suite: SuiteRef | null | undefined }) {
  const record = useQuery({
    queryKey: suiteQueryKey(suite ?? null),
    queryFn: () => ensureExpertClient().readSuite(suite!),
    enabled: Boolean(suite),
  });
  const { t } = useTranslation();
  if (!suite) return null;
  return (
    <span
      className="max-w-48 truncate rounded-md border border-border px-2 py-0.5 text-ui-sm font-normal text-muted-foreground"
      title={
        record.data?.name ??
        (record.isError ? t("chat:suiteNameUnavailable") : t("chat:suiteNameLoading"))
      }
      aria-label={
        record.data
          ? t("chat:hubSuiteAria", { name: record.data.name })
          : t("chat:suiteNameUnavailable")
      }
    >
      {record.data?.name ?? t("common:suiteTerm")}
    </span>
  );
}
