import type { ExpertConnectionConfig, ExpertSaveInput } from "@synara/contracts";
import type { KeyboardEvent, ReactNode } from "react";
import type { ExpertDraftIssue, ExpertDraftField } from "./expertSettingsModel";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { ExpertConnectionPermissions } from "./ExpertConnectionPermissions";
import { ExpertReferencesEditor } from "./ExpertReferencesEditor";
import { ExpertSkillsEditor } from "./ExpertSkillsEditor";
import { SettingsCard, SettingsSectionShell, SettingsSelectPopup } from "./SettingsPanelPrimitives";

export type ExpertEditorTab = "capabilities" | "settings";

export function ExpertEditor({
  header,
  status,
  draft,
  issues,
  tab,
  readonly,
  connections,
  connectionsLoading,
  connectionsError,
  catalog,
  catalogLoading,
  catalogError,
  onTabChange,
  onChange,
  onOpenConnections,
}: {
  header: ReactNode;
  status?: ReactNode;
  draft: ExpertSaveInput;
  issues: ReadonlyArray<ExpertDraftIssue>;
  tab: ExpertEditorTab;
  readonly: boolean;
  connections: ReadonlyArray<ExpertConnectionConfig>;
  connectionsLoading: boolean;
  connectionsError: string | null;
  catalog: Parameters<typeof ExpertSkillsEditor>[0]["catalog"];
  catalogLoading: boolean;
  catalogError: string | null;
  onTabChange: (tab: ExpertEditorTab) => void;
  onChange: (patch: Partial<ExpertSaveInput>) => void;
  onOpenConnections: () => void;
}) {
  const fieldIssue = (field: ExpertDraftField) =>
    issues.find((issue) => issue.field === field && issue.index === undefined);
  const textField = (
    field: "name" | "description" | "useCases" | "persona" | "outputRequirements",
  ) => fieldIssue(field);
  const setTabByKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "Home" &&
      event.key !== "End"
    )
      return;
    event.preventDefault();
    const tabs: ExpertEditorTab[] = ["capabilities", "settings"];
    const currentIndex = tabs.indexOf(tab);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : event.key === "ArrowRight"
            ? (currentIndex + 1) % tabs.length
            : (currentIndex - 1 + tabs.length) % tabs.length;
    const nextTab = tabs[nextIndex]!;
    onTabChange(nextTab);
    queueMicrotask(() => document.getElementById(`expert-tab-${nextTab}`)?.focus());
  };

  return (
    <div className="space-y-5">
      <header className="space-y-2 border-b border-border pb-3">
        {header}

        <div
          className="flex w-fit max-w-full gap-1 rounded-xl border border-border bg-foreground/2 p-1"
          role="tablist"
          aria-label="专家配置页签"
          onKeyDown={setTabByKey}
        >
          <button
            id="expert-tab-capabilities"
            type="button"
            role="tab"
            aria-selected={tab === "capabilities"}
            aria-controls="expert-panel-capabilities"
            tabIndex={tab === "capabilities" ? 0 : -1}
            className="rounded-lg px-3 py-1.5 text-ui-sm outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-border-focus)] aria-selected:bg-background aria-selected:text-foreground aria-selected:shadow-sm"
            onClick={() => onTabChange("capabilities")}
          >
            能力
          </button>
          <button
            id="expert-tab-settings"
            type="button"
            role="tab"
            aria-selected={tab === "settings"}
            aria-controls="expert-panel-settings"
            tabIndex={tab === "settings" ? 0 : -1}
            className="rounded-lg px-3 py-1.5 text-ui-sm outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-border-focus)] aria-selected:bg-background aria-selected:text-foreground aria-selected:shadow-sm"
            onClick={() => onTabChange("settings")}
          >
            设置
          </button>
        </div>
      </header>
      {status}

      {tab === "settings" ? (
        <div
          id="expert-panel-settings"
          role="tabpanel"
          aria-labelledby="expert-tab-settings"
          tabIndex={-1}
          className="space-y-4"
        >
          <SettingsCard divided={false} className="px-4 pb-4">
            <SettingsSectionShell title="基本信息" layout="compact">
              <div className="space-y-3">
                <label className="block space-y-1.5 text-ui-sm">
                  <span className="font-medium">
                    名称 <span className="text-destructive">*</span>
                  </span>
                  <Input
                    size="sm"
                    aria-label="专家名称"
                    aria-invalid={Boolean(textField("name"))}
                    maxLength={200}
                    disabled={readonly}
                    value={draft.name}
                    onChange={(event) => onChange({ name: event.target.value })}
                    placeholder="例如：技术方案评审专家"
                  />
                  {textField("name") ? (
                    <span className="block text-ui-xs text-destructive" role="alert">
                      {textField("name")?.message}
                    </span>
                  ) : null}
                </label>
                <label className="block space-y-1.5 text-ui-sm">
                  <span className="font-medium">简介</span>
                  <Textarea
                    size="compact"
                    rows={2}
                    aria-label="专家描述"
                    aria-invalid={Boolean(textField("description"))}
                    maxLength={4_000}
                    disabled={readonly}
                    value={draft.description}
                    onChange={(event) => onChange({ description: event.target.value })}
                    placeholder="简要介绍专家职责"
                  />
                  {textField("description") ? (
                    <span className="block text-ui-xs text-destructive" role="alert">
                      {textField("description")?.message}
                    </span>
                  ) : null}
                </label>
                <label className="block space-y-1.5 text-ui-sm">
                  <span className="font-medium">适用任务</span>
                  <Textarea
                    size="compact"
                    rows={2}
                    aria-label="专家使用场景"
                    aria-invalid={Boolean(textField("useCases"))}
                    disabled={readonly}
                    value={draft.useCases}
                    onChange={(event) => onChange({ useCases: event.target.value })}
                    placeholder="例如：需求澄清、方案比较、PRD 撰写"
                  />
                  {textField("useCases") ? (
                    <span className="block text-ui-xs text-destructive" role="alert">
                      {textField("useCases")?.message}
                    </span>
                  ) : null}
                </label>
              </div>
            </SettingsSectionShell>
          </SettingsCard>
          <SettingsCard divided={false} className="px-4 pb-3">
            <SettingsSectionShell title="运行配置" layout="compact">
              <div className="flex flex-wrap items-center justify-between gap-2 text-ui-sm">
                <span className="font-medium">首选 Provider</span>
                <Select
                  value={draft.preferredProvider ?? "unspecified"}
                  onValueChange={(value) =>
                    onChange({
                      preferredProvider: value === "codex" || value === "pi" ? value : undefined,
                    })
                  }
                  disabled={readonly}
                >
                  <SelectTrigger
                    size="sm"
                    aria-label="专家首选 Provider"
                    className="w-full sm:w-48"
                  >
                    <SelectValue>
                      {draft.preferredProvider === "codex"
                        ? "Codex"
                        : draft.preferredProvider === "pi"
                          ? "Pi"
                          : "不指定"}
                    </SelectValue>
                  </SelectTrigger>
                  <SettingsSelectPopup>
                    <SelectItem value="unspecified" hideIndicator>
                      不指定
                    </SelectItem>
                    <SelectItem value="codex" hideIndicator>
                      Codex
                    </SelectItem>
                    <SelectItem value="pi" hideIndicator>
                      Pi
                    </SelectItem>
                  </SettingsSelectPopup>
                </Select>
              </div>
            </SettingsSectionShell>
          </SettingsCard>
        </div>
      ) : (
        <div
          id="expert-panel-capabilities"
          role="tabpanel"
          aria-labelledby="expert-tab-capabilities"
          tabIndex={-1}
          className="space-y-4"
        >
          <SettingsCard divided={false} className="px-4 pb-4">
            <SettingsSectionShell title="行为指令" layout="compact">
              <div className="space-y-3">
                <label className="block space-y-1.5 text-ui-sm">
                  <span className="font-medium">工作方式</span>
                  <Textarea
                    size="compact"
                    rows={2}
                    aria-label="专家角色与工作方式"
                    aria-invalid={Boolean(textField("persona"))}
                    disabled={readonly}
                    value={draft.persona}
                    onChange={(event) => onChange({ persona: event.target.value })}
                    placeholder="描述专家的职责、方法和需要遵守的边界。"
                  />
                  {textField("persona") ? (
                    <span className="block text-ui-xs text-destructive" role="alert">
                      {textField("persona")?.message}
                    </span>
                  ) : null}
                </label>
                <label className="block space-y-1.5 text-ui-sm">
                  <span className="font-medium">输出要求</span>
                  <Textarea
                    size="compact"
                    rows={2}
                    aria-label="专家输出要求"
                    aria-invalid={Boolean(textField("outputRequirements"))}
                    disabled={readonly}
                    value={draft.outputRequirements}
                    onChange={(event) => onChange({ outputRequirements: event.target.value })}
                    placeholder="描述输出结构、证据要求或语言风格。"
                  />
                  {textField("outputRequirements") ? (
                    <span className="block text-ui-xs text-destructive" role="alert">
                      {textField("outputRequirements")?.message}
                    </span>
                  ) : null}
                </label>
              </div>
            </SettingsSectionShell>
          </SettingsCard>
          <SettingsCard className="px-4">
            <ExpertSkillsEditor
              skills={draft.skills}
              issues={issues}
              catalog={catalog}
              catalogLoading={catalogLoading}
              catalogError={catalogError}
              disabled={readonly}
              onChange={(skills) => onChange({ skills })}
            />
            <ExpertReferencesEditor
              references={draft.references}
              issues={issues}
              disabled={readonly}
              onChange={(references) => onChange({ references })}
            />
          </SettingsCard>
          <SettingsCard className="px-4" divided={false}>
            <ExpertConnectionPermissions
              configurations={connections}
              bindings={draft.connections}
              loading={connectionsLoading}
              error={connectionsError}
              disabled={readonly}
              onChange={(connections) => onChange({ connections })}
              onManage={onOpenConnections}
            />
          </SettingsCard>
        </div>
      )}
    </div>
  );
}
