import { useQuery } from "@tanstack/react-query";
import type { SuiteRef } from "@synara/contracts";
import { ensureExpertClient } from "~/workbench/host/expertClient";
import { suiteQueryKey } from "~/components/settings/expertSettingsQueries";

export function HubSuiteLabel({ suite }: { suite: SuiteRef | null | undefined }) {
  const record = useQuery({
    queryKey: suiteQueryKey(suite ?? null),
    queryFn: () => ensureExpertClient().readSuite(suite!),
    enabled: Boolean(suite),
  });
  if (!suite) return null;
  return (
    <span
      className="max-w-48 truncate rounded-md border border-border px-2 py-0.5 text-ui-sm font-normal text-muted-foreground"
      title={record.data?.name ?? (record.isError ? "Suite 名称暂不可读取" : "正在读取 Suite 名称")}
      aria-label={record.data ? `Suite · ${record.data.name}` : "Suite 名称暂不可读取"}
    >
      {record.data?.name ?? "Suite"}
    </span>
  );
}
