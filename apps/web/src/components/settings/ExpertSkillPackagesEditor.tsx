import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  ExpertDefinition,
  ExpertSkillSelection,
  ProviderSkillDescriptor,
  ProviderSkillReference,
} from "@synara/contracts";
import { ensureExpertClient } from "~/workbench/host/expertClient";
import { ChevronRightIcon, XIcon } from "~/lib/icons";
import { disclosureChevronClassName } from "~/lib/disclosureMotion";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Select, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsSectionShell, SettingsSelectPopup } from "./SettingsPanelPrimitives";
import { skillPackagesQueryKey, useSkillPackageConnection } from "./skillPackageSettingsQueries";
import {
  expertSkillSelectionKey,
  setExpertSkillSelectionActivation,
  switchExpertSkillEntryVersion,
} from "./expertSkillPackagesSettingsModel";
import { ExpertSkillsEditor } from "./ExpertSkillsEditor";
import { SkillPicker } from "./SkillPicker";
import type { ExpertDraftIssue } from "./expertSettingsModel";

export function ExpertSkillPackagesEditor({
  selections,
  legacySkills,
  expertName,
  experts,
  catalog,
  catalogLoading,
  catalogError,
  issues,
  disabled,
  onChange,
  onLegacyChange,
}: {
  selections: ReadonlyArray<ExpertSkillSelection> | undefined;
  legacySkills: ReadonlyArray<ProviderSkillReference>;
  expertName: string;
  experts: ReadonlyArray<ExpertDefinition>;
  catalog: ReadonlyArray<ProviderSkillDescriptor>;
  catalogLoading: boolean;
  catalogError: string | null;
  issues: ReadonlyArray<ExpertDraftIssue>;
  disabled: boolean;
  onChange: (selections: ExpertSkillSelection[]) => void;
  onLegacyChange: (skills: ProviderSkillReference[]) => void;
}) {
  const connection = useSkillPackageConnection();
  const packagesQuery = useQuery({
    queryKey: skillPackagesQueryKey(connection.generation),
    queryFn: () => ensureExpertClient().listSkillPackages(),
    enabled: connection.connected,
  });
  const packages = packagesQuery.data ?? [];
  const [expanded, setExpanded] = useState<string | null>(null);
  const picker = (
    <SkillPicker
      skills={legacySkills}
      selections={selections}
      expertName={expertName}
      experts={experts}
      packages={packages}
      catalog={catalog}
      catalogLoading={catalogLoading || packagesQuery.isFetching}
      catalogError={catalogError ?? (packagesQuery.isError ? "无法读取技能包，请重试。" : null)}
      disabled={disabled}
      onApply={onChange}
    />
  );
  if (selections === undefined)
    return (
      <ExpertSkillsEditor
        skills={legacySkills}
        issues={issues}
        catalog={catalog}
        disabled={disabled}
        action={picker}
        onChange={onLegacyChange}
      />
    );
  return (
    <SettingsSectionShell
      title="技能"
      count={selections.length}
      layout="compact"
      id="expert-skill-packages"
      action={picker}
    >
      {issues
        .filter((issue) => issue.field === "skills" || issue.field === "skillSelections")
        .map((issue) => (
          <p
            key={`${issue.code}:${issue.index}:${issue.message}`}
            className="pb-2 text-ui-sm text-destructive"
            role="alert"
          >
            {issue.message}
          </p>
        ))}
      {packagesQuery.isError ? (
        <p className="text-ui-sm text-destructive" role="alert">
          无法读取技能包，请重试。
        </p>
      ) : null}
      {selections.length ? (
        <ul className="divide-y divide-border border-t border-border" aria-label="已配置技能">
          {selections.map((selection) => {
            const key = expertSkillSelectionKey(selection),
              pkg = packages.find((item) => item.packageId === selection.packageId),
              entry = pkg?.entries.find((item) => item.entryPath === selection.entryPath),
              name = entry?.name ?? selection.entryPath,
              open = expanded === key;
            const versions = packages.flatMap((item) =>
              item.rootName === pkg?.rootName
                ? item.entries
                    .filter(
                      (candidate) =>
                        candidate.name.normalize("NFC").toLowerCase() ===
                        entry?.name.normalize("NFC").toLowerCase(),
                    )
                    .map((candidate) => ({ pkg: item, entry: candidate }))
                : [],
            );
            return (
              <li key={key}>
                <Collapsible open={open} onOpenChange={(next) => setExpanded(next ? key : null)}>
                  <div className="flex min-w-0 items-center gap-2 py-2">
                    <CollapsibleTrigger
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`查看技能 ${name}`}
                    >
                      <ChevronRightIcon className={disclosureChevronClassName(open)} />
                      <span className="truncate text-ui font-medium">{name}</span>
                    </CollapsibleTrigger>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      disabled={disabled}
                      aria-label={`移除技能 ${name}`}
                      onClick={() =>
                        onChange(selections.filter((item) => expertSkillSelectionKey(item) !== key))
                      }
                    >
                      <XIcon />
                    </Button>
                  </div>
                  <CollapsiblePanel>
                    <div className="space-y-2 pb-3 text-ui-sm">
                      {entry?.description ? (
                        <p className="text-muted-foreground">{entry.description}</p>
                      ) : null}
                      <p className="break-all text-ui-xs text-muted-foreground">
                        {pkg?.rootName ?? selection.packageId} / {selection.entryPath}
                      </p>
                      {!entry && !packagesQuery.isFetching ? (
                        <p role="alert" className="text-destructive">
                          无法读取此固定版本技能，可移除后重新添加。
                        </p>
                      ) : null}
                      {entry?.incompatibleReason ? (
                        <p role="alert" className="text-destructive">
                          {entry.incompatibleReason}
                        </p>
                      ) : null}
                      <div className="flex flex-wrap gap-3">
                        <label className="space-y-1">
                          <span className="block text-muted-foreground">加载方式</span>
                          <Select
                            value={selection.activation}
                            disabled={disabled || !entry || Boolean(entry.incompatibleReason)}
                            onValueChange={(value) => {
                              if (value !== "startup" && value !== "on-demand") return;
                              if (value === "startup" && entry?.disableModelInvocation) return;
                              onChange(
                                setExpertSkillSelectionActivation(selections, selection, value),
                              );
                            }}
                          >
                            <SelectTrigger
                              size="sm"
                              aria-label={`技能 ${name} 加载时机`}
                              className="w-28"
                            >
                              <SelectValue>
                                {selection.activation === "startup" ? "启动时" : "按需"}
                              </SelectValue>
                            </SelectTrigger>
                            <SettingsSelectPopup>
                              <SelectItem value="on-demand">按需</SelectItem>
                              <SelectItem
                                value="startup"
                                disabled={entry?.disableModelInvocation === true}
                              >
                                启动时
                              </SelectItem>
                            </SettingsSelectPopup>
                          </Select>
                        </label>
                        <label className="space-y-1">
                          <span className="block text-muted-foreground">版本</span>
                          <Select
                            value={key}
                            disabled={disabled || versions.length < 2}
                            onValueChange={(value) => {
                              const target = versions.find(
                                (item) =>
                                  expertSkillSelectionKey({
                                    packageId: item.pkg.packageId,
                                    entryPath: item.entry.entryPath,
                                    activation: "on-demand",
                                  }) === value,
                              );
                              if (!target || target.entry.incompatibleReason) return;
                              if (
                                selection.activation === "startup" &&
                                target.entry.disableModelInvocation
                              )
                                return;
                              onChange(
                                switchExpertSkillEntryVersion(
                                  selections,
                                  packages,
                                  target.pkg,
                                  target.entry.entryPath,
                                ),
                              );
                            }}
                          >
                            <SelectTrigger
                              size="sm"
                              aria-label={`技能 ${name} 版本`}
                              className="w-40"
                            >
                              <SelectValue>{selection.packageId.slice(4, 12)}</SelectValue>
                            </SelectTrigger>
                            <SettingsSelectPopup>
                              {versions.map((item) => (
                                <SelectItem
                                  key={`${item.pkg.packageId}:${item.entry.entryPath}`}
                                  value={expertSkillSelectionKey({
                                    packageId: item.pkg.packageId,
                                    entryPath: item.entry.entryPath,
                                    activation: "on-demand",
                                  })}
                                  disabled={
                                    Boolean(item.entry.incompatibleReason) ||
                                    (selection.activation === "startup" &&
                                      item.entry.disableModelInvocation === true)
                                  }
                                >
                                  {item.pkg.packageId.slice(4, 12)}
                                </SelectItem>
                              ))}
                            </SettingsSelectPopup>
                          </Select>
                        </label>
                      </div>
                    </div>
                  </CollapsiblePanel>
                </Collapsible>
              </li>
            );
          })}
        </ul>
      ) : null}
    </SettingsSectionShell>
  );
}
