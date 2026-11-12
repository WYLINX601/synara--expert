import { useQuery } from "@tanstack/react-query";
import type { SuiteRef } from "@synara/contracts";
import { ensureExpertClient } from "~/workbench/host/expertClient";
import { SettingsSelectControl } from "~/components/settings/SettingControls";
import { SuiteSummary, suiteErrorText } from "~/components/settings/SuiteSummary";
import { SUITES_QUERY_KEY, suiteQueryKey } from "~/components/settings/expertSettingsQueries";
import { SelectItem } from "~/components/ui/select";
import { Button } from "~/components/ui/button";

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
  return (
    <section className="space-y-3 text-ui" aria-label="Hub Suite">
      <h3 className="font-medium">Suite</h3>
      {!readonly ? (
        <SettingsSelectControl
          value={key}
          ariaLabel="选择 Suite"
          valueContent={suite ? (record.data?.name ?? "正在读取 Suite…") : "不使用 Suite"}
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
          <SelectItem value="none">不使用 Suite</SelectItem>
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
          <p>暂时无法读取 Suite 目录；仍可不使用 Suite 创建 Hub。{suiteErrorText(catalog.error)}</p>
          <Button variant="outline" onClick={() => void catalog.refetch()}>
            重试目录
          </Button>
        </div>
      ) : catalog.isPending && !readonly ? (
        <p role="status" className="text-ui-sm text-muted-foreground">
          正在读取 Suite 目录…
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
              重试读取
            </Button>
          </div>
        ) : (
          <p role="status">正在读取用途与成员…</p>
        )
      ) : null}
    </section>
  );
}
