import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ExpertSkillSelection, ProviderSkillReference, SkillPackage } from "@synara/contracts";
import { ensureExpertClient } from "~/workbench/host/expertClient";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsCard, SettingsSectionShell, SettingsSelectPopup } from "./SettingsPanelPrimitives";
import { skillPackagesQueryKey, useSkillPackageConnection } from "./skillPackageSettingsQueries";
import {
  expertSkillSelectionKey,
  setExpertSkillSelectionActivation,
  switchExpertSkillEntryVersion,
  toggleExpertSkillSelection,
} from "./expertSkillPackagesSettingsModel";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请重试。";
}

function entryNameKey(name: string): string {
  return name.normalize("NFC").toLocaleLowerCase();
}

export function ExpertSkillPackagesEditor({
  selections,
  legacySkills,
  disabled,
  onChange,
  onSwitchToPackages,
  onSwitchToLegacy,
}: {
  selections: ReadonlyArray<ExpertSkillSelection> | undefined;
  legacySkills: ReadonlyArray<ProviderSkillReference>;
  disabled: boolean;
  onChange: (selections: ExpertSkillSelection[]) => void;
  onSwitchToPackages: () => void;
  onSwitchToLegacy: () => void;
}) {
  const connection = useSkillPackageConnection();
  const packagesQuery = useQuery({
    queryKey: skillPackagesQueryKey(connection.generation),
    queryFn: () => ensureExpertClient().listSkillPackages(),
    enabled: connection.connected,
  });
  const packages = packagesQuery.data ?? [];
  const packagesById = new Map(
    packages.map((skillPackage) => [skillPackage.packageId, skillPackage]),
  );
  const selected = selections ?? [];
  const [modeChange, setModeChange] = useState<"packages" | "legacy" | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);

  const switchEntryVersion = (target: SkillPackage, entryPath: string) => {
    const next = switchExpertSkillEntryVersion(selected, packages, target, entryPath);
    if (JSON.stringify(next) !== JSON.stringify(selected)) {
      setSelectionError(null);
      onChange(next);
    }
  };

  return (
    <>
      <SettingsSectionShell
        title="版本包技能"
        {...(selections === undefined ? {} : { count: selected.length })}
        layout="compact"
        id="expert-skill-packages"
        action={
          selections === undefined ? (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || packages.length === 0}
              onClick={() => setModeChange("packages")}
            >
              改用版本包
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => setModeChange("legacy")}
            >
              改用路径技能
            </Button>
          )
        }
      >
        {selections === undefined ? (
          <div className="space-y-2 pb-2">
            <p className="text-ui-sm text-muted-foreground">
              当前 Expert
              使用下方仍可编辑的旧路径技能配置。版本包导入后也会保留旧列表，只有确认切换时才会替换它。
            </p>
            {legacySkills.length > 0 ? (
              <p className="text-ui-xs text-muted-foreground">
                当前有 {legacySkills.length} 条路径技能。可先在“设置 →
                技能”中按原路径导入，再选择包内入口。
              </p>
            ) : null}
          </div>
        ) : (
          <p className="pb-2 text-ui-xs text-muted-foreground">
            一个启动入口会在 Expert
            启动时加载；其余技能按需使用。将入口改为启动时，会把原启动入口改为按需。
          </p>
        )}

        {packagesQuery.isPending && !packagesQuery.data ? (
          <p className="py-2 text-ui-sm text-muted-foreground" role="status">
            正在读取技能包…
          </p>
        ) : !connection.connected ? (
          <p className="py-2 text-ui-sm text-muted-foreground" role="status">
            服务器未连接，暂时无法读取技能包。
          </p>
        ) : packagesQuery.isError ? (
          <p className="py-2 text-ui-sm text-destructive" role="alert">
            无法读取技能包：{errorText(packagesQuery.error)}
          </p>
        ) : packages.length === 0 ? (
          <p className="py-2 text-ui-sm text-muted-foreground">请先在“设置 → 技能”导入技能包。</p>
        ) : selections === undefined ? null : (
          <div className="space-y-3">
            {selectionError ? (
              <p className="text-ui-sm text-destructive" role="alert">
                {selectionError}
              </p>
            ) : null}
            {selected.length === 0 ? (
              <p className="text-ui-sm text-muted-foreground">尚未选择技能入口。</p>
            ) : (
              <p className="text-ui-sm text-muted-foreground">
                已选择 {selected.length} 个固定版本入口。
              </p>
            )}
            {packages.map((skillPackage) => (
              <SettingsCard key={skillPackage.packageId} className="px-3" divided={false}>
                <div className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-ui font-medium">{skillPackage.rootName}</p>
                    <p className="text-ui-xs text-muted-foreground">
                      版本 {skillPackage.packageId.slice(4, 12)} · {skillPackage.entries.length}{" "}
                      个入口
                    </p>
                  </div>
                  <span className="text-ui-xs text-muted-foreground">
                    {skillPackage.resources.filter((resource) => resource.kind === "file").length}{" "}
                    个资源文件
                  </span>
                </div>
                <ul className="divide-y divide-border border-t border-border">
                  {skillPackage.entries.map((entry, index) => {
                    const selection: ExpertSkillSelection = {
                      packageId: skillPackage.packageId,
                      entryPath: entry.entryPath,
                      activation: "on-demand",
                    };
                    const key = expertSkillSelectionKey(selection);
                    const current = selected.find((item) => expertSkillSelectionKey(item) === key);
                    const incompatible = Boolean(entry.incompatibleReason);
                    const cannotAdd = incompatible;
                    const sameNameSelected = selected.some((item) => {
                      if (
                        item.packageId === skillPackage.packageId &&
                        item.entryPath === entry.entryPath
                      )
                        return false;
                      const chosenPackage = packagesById.get(item.packageId);
                      const chosenEntry = chosenPackage?.entries.find(
                        (candidate) => candidate.entryPath === item.entryPath,
                      );
                      return (
                        chosenEntry !== undefined &&
                        entryNameKey(chosenEntry.name) === entryNameKey(entry.name)
                      );
                    });
                    const previousVersionSelected = selected.some((item) => {
                      if (item.packageId === skillPackage.packageId) return false;
                      const oldPackage = packagesById.get(item.packageId);
                      const oldEntry = oldPackage?.entries.find(
                        (candidate) => candidate.entryPath === item.entryPath,
                      );
                      return (
                        oldPackage?.rootName === skillPackage.rootName &&
                        oldEntry !== undefined &&
                        entryNameKey(oldEntry.name) === entryNameKey(entry.name)
                      );
                    });
                    const checkboxId = `expert-skill-${skillPackage.packageId}-${index}`;
                    return (
                      <li key={entry.entryPath} className="flex min-w-0 items-start gap-2 py-2">
                        <Checkbox
                          id={checkboxId}
                          aria-label={`选择技能 ${entry.name}`}
                          checked={current !== undefined}
                          disabled={
                            disabled || (current === undefined && (cannotAdd || sameNameSelected))
                          }
                          onCheckedChange={(checked) => {
                            const nextChecked = checked === true;
                            if (nextChecked && sameNameSelected) {
                              setSelectionError(
                                "同名技能已在其他包版本中选择。请使用“切换所选版本”，或先移除已有入口。",
                              );
                              return;
                            }
                            setSelectionError(null);
                            onChange(toggleExpertSkillSelection(selected, selection, nextChecked));
                          }}
                        />
                        <div className="min-w-0 flex-1">
                          <label
                            htmlFor={checkboxId}
                            className="block cursor-pointer truncate text-ui font-medium"
                          >
                            {entry.name}
                          </label>
                          <p className="break-all text-ui-xs text-muted-foreground">
                            {entry.entryPath}
                          </p>
                          {entry.description ? (
                            <p className="mt-0.5 text-ui-sm text-muted-foreground">
                              {entry.description}
                            </p>
                          ) : null}
                          {entry.incompatibleReason ? (
                            <p className="mt-1 text-ui-xs text-destructive">
                              不兼容：{entry.incompatibleReason}
                            </p>
                          ) : null}
                          {entry.userInvocable === false ? (
                            <p className="mt-1 text-ui-xs text-muted-foreground">
                              此入口不用于 Composer 显式调用；Expert 仍可按需发现或启动加载。
                            </p>
                          ) : null}
                          {entry.disableModelInvocation === true ? (
                            <p className="mt-1 text-ui-xs text-muted-foreground">
                              此入口不允许设为启动技能。
                            </p>
                          ) : null}
                        </div>
                        {previousVersionSelected && !current ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={disabled || cannotAdd}
                            onClick={() => switchEntryVersion(skillPackage, entry.entryPath)}
                          >
                            切换所选版本
                          </Button>
                        ) : current ? (
                          <Select
                            value={current.activation}
                            onValueChange={(value) => {
                              if (value !== "startup" && value !== "on-demand") return;
                              if (value === "startup" && entry.disableModelInvocation) return;
                              onChange(setExpertSkillSelectionActivation(selected, current, value));
                            }}
                            disabled={disabled || incompatible}
                          >
                            <SelectTrigger
                              size="sm"
                              aria-label={`技能 ${entry.name} 加载时机`}
                              className="w-28"
                            >
                              <SelectValue>
                                {current.activation === "startup" ? "启动时" : "按需"}
                              </SelectValue>
                            </SelectTrigger>
                            <SettingsSelectPopup>
                              <SelectItem
                                value="startup"
                                hideIndicator
                                disabled={entry.disableModelInvocation === true}
                              >
                                启动时
                              </SelectItem>
                              <SelectItem value="on-demand" hideIndicator>
                                按需
                              </SelectItem>
                            </SettingsSelectPopup>
                          </Select>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </SettingsCard>
            ))}
          </div>
        )}
      </SettingsSectionShell>

      <Dialog open={modeChange !== null} onOpenChange={(open) => !open && setModeChange(null)}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {modeChange === "packages" ? "改用版本包技能？" : "改用路径技能？"}
            </DialogTitle>
            <DialogDescription>
              {modeChange === "packages"
                ? `此操作会清除当前 Expert 中的 ${legacySkills.length} 条旧路径技能。已有路径条目不会自动导入；请先在设置的技能页导入目录并确认预览。`
                : `此操作会清除当前 Expert 中的 ${selected.length} 个固定版本入口，并切回空的路径技能配置。`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" disabled={disabled} onClick={() => setModeChange(null)}>
              取消
            </Button>
            <Button
              disabled={disabled}
              onClick={() => {
                if (modeChange === "packages") onSwitchToPackages();
                else onSwitchToLegacy();
                setModeChange(null);
                setSelectionError(null);
              }}
            >
              确认切换
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
