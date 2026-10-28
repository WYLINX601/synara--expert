import { useQuery } from "@tanstack/react-query";

import { Button } from "~/components/ui/button";
import { SettingsCard, SettingsSectionShell } from "~/components/settings/SettingsPanelPrimitives";
import { HubTeamsSettingsPanel } from "~/features/hubCollaboration/HubTeamsSettingsPanel";
import { ensureExpertClient } from "~/workbench/host/expertClient";
import { EXPERTS_QUERY_KEY } from "./expertSettingsQueries";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请重试。";
}

/** Legacy Settings host: keep Hub Teams here and link personal Expert editing to its one owner. */
export function ExpertTeamsSettingsPanel(props: {
  readonly active?: boolean;
  readonly onOpenExperts: () => void;
}) {
  const active = props.active ?? true;
  const expertsQuery = useQuery({
    queryKey: EXPERTS_QUERY_KEY,
    queryFn: () => ensureExpertClient().listExperts(),
    enabled: active,
  });

  return (
    <div className="space-y-6">
      <SettingsSectionShell title="单个专家">
        <SettingsCard>
          <div className="flex flex-wrap items-center justify-between gap-3 p-4">
            <p className="min-w-0 flex-1 text-ui leading-relaxed text-muted-foreground">
              单个专家的创建和编辑已移至 Experts。
            </p>
            <Button size="sm" variant="outline" onClick={props.onOpenExperts}>
              打开 Experts
            </Button>
          </div>
        </SettingsCard>
      </SettingsSectionShell>
      <HubTeamsSettingsPanel
        active={active}
        experts={expertsQuery.data}
        expertsLoading={expertsQuery.isPending || expertsQuery.isFetching}
        expertsError={expertsQuery.error ? errorText(expertsQuery.error) : null}
      />
    </div>
  );
}
