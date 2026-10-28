import { Button } from "~/components/ui/button";
import { SettingsCard, SettingsSectionShell } from "~/components/settings/SettingsPanelPrimitives";

/** Legacy Settings host: keep navigation to the Experts page while its former editors move there. */
export function ExpertTeamsSettingsPanel(props: {
  readonly onOpenExperts: (kind?: "teams" | "skills") => void;
}) {
  return (
    <div className="space-y-6">
      <SettingsSectionShell title="单个专家">
        <SettingsCard>
          <div className="flex flex-wrap items-center justify-between gap-3 p-4">
            <p className="min-w-0 flex-1 text-ui leading-relaxed text-muted-foreground">
              个人专家的创建和编辑已移至 Experts 页面。
            </p>
            <Button size="sm" variant="outline" onClick={() => props.onOpenExperts()}>
              打开专家
            </Button>
          </div>
        </SettingsCard>
      </SettingsSectionShell>
      <SettingsSectionShell title="专家团">
        <SettingsCard>
          <div className="flex flex-wrap items-center justify-between gap-3 p-4">
            <p className="min-w-0 flex-1 text-ui leading-relaxed text-muted-foreground">
              专家团的创建和管理已移至 Experts 页面。
            </p>
            <Button size="sm" variant="outline" onClick={() => props.onOpenExperts("teams")}>
              打开专家团
            </Button>
          </div>
        </SettingsCard>
      </SettingsSectionShell>
      <SettingsSectionShell title="技能">
        <SettingsCard>
          <div className="flex flex-wrap items-center justify-between gap-3 p-4">
            <p className="min-w-0 flex-1 text-ui leading-relaxed text-muted-foreground">
              技能库的管理已移至 Experts 页面。
            </p>
            <Button size="sm" variant="outline" onClick={() => props.onOpenExperts("skills")}>
              打开技能
            </Button>
          </div>
        </SettingsCard>
      </SettingsSectionShell>
    </div>
  );
}
