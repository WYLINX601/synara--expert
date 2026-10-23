import type { HubCollaborationSettings, HubTeamPreset, HubTeamSaveInput } from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { Input } from "~/components/ui/input";
import { SelectItem } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import {
  SettingsCard,
  SettingsEmptyState,
  SettingsSectionShell,
} from "~/components/settings/SettingsPanelPrimitives";
import {
  SettingsSegmentedControl,
  SettingsSelectControl,
} from "~/components/settings/SettingControls";
import { hubTeamsQueryKey } from "~/features/hubCollaboration/HubTeamsSettingsPanel";
import { useNativeApiServerCapabilitySnapshot } from "~/hooks/useNativeApiServerCapability";
import { ensureHubTeamsClient } from "~/workbench/host/hubCollaborationClient";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "保存失败，请重试。";
}

const EMPTY_TEAM_PRESETS: ReadonlyArray<HubTeamPreset> = [];

function copyPreset(preset: HubTeamPreset): HubCollaborationSettings {
  return {
    schemaVersion: 1,
    mode: "expert-team",
    ...(preset.coordinatorInstructions?.trim()
      ? { coordinatorInstructions: preset.coordinatorInstructions }
      : {}),
    ...(preset.collaborationPreferences?.trim()
      ? { collaborationPreferences: preset.collaborationPreferences }
      : {}),
    presetSource: { id: preset.id, revision: preset.revision },
  };
}

function TeamSaveAsDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly initialName: string;
  readonly expertIds: ReadonlyArray<string>;
  readonly collaboration: HubCollaborationSettings | undefined;
  readonly purpose: string;
  readonly onSaved: (team: HubTeamPreset) => void;
}) {
  const queryClient = useQueryClient();
  const { generation } = useNativeApiServerCapabilitySnapshot("hubCollaboration.team.presets");
  const [name, setName] = useState(props.initialName);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openedGenerationRef = useRef(generation);
  const generationRef = useRef(generation);
  const previousGenerationRef = useRef(generation);
  generationRef.current = generation;
  useEffect(() => {
    if (!props.open) return;
    openedGenerationRef.current = generationRef.current;
    setName(props.initialName);
    setError(null);
  }, [props.initialName, props.open]);
  useEffect(() => {
    if (previousGenerationRef.current === generation) return;
    previousGenerationRef.current = generation;
    if (pending) setPending(false);
    if (props.open) setError("服务连接已变化，请关闭后重新打开此对话框。");
  }, [generation, pending, props.open]);

  const save = async () => {
    if (!name.trim()) {
      setError("请填写专家团名称。");
      return;
    }
    if (props.expertIds.length === 0) {
      setError("至少选择一位专家。");
      return;
    }
    const requestGeneration = generation;
    if (openedGenerationRef.current !== requestGeneration) {
      setError("服务连接已变化，请关闭后重新打开此对话框。");
      return;
    }
    const input: HubTeamSaveInput = {
      id: `team-${crypto.randomUUID()}`,
      name: name.trim(),
      purpose: props.purpose,
      expertIds: [...new Set(props.expertIds)],
      ...(props.collaboration?.coordinatorInstructions?.trim()
        ? { coordinatorInstructions: props.collaboration.coordinatorInstructions }
        : {}),
      ...(props.collaboration?.collaborationPreferences?.trim()
        ? { collaborationPreferences: props.collaboration.collaborationPreferences }
        : {}),
      expectedRevision: null,
      requestId: crypto.randomUUID(),
    };
    setPending(true);
    setError(null);
    try {
      const team = await ensureHubTeamsClient().save(input);
      queryClient.setQueryData<ReadonlyArray<HubTeamPreset>>(
        hubTeamsQueryKey(requestGeneration),
        (current) => [team, ...(current ?? [])],
      );
      void queryClient.invalidateQueries({ queryKey: hubTeamsQueryKey(requestGeneration) });
      if (requestGeneration !== generation) return;
      props.onSaved(team);
      props.onOpenChange(false);
    } catch (cause) {
      if (requestGeneration === generation) setError(errorText(cause));
      void queryClient.invalidateQueries({ queryKey: hubTeamsQueryKey(requestGeneration) });
    } finally {
      if (requestGeneration === generation) setPending(false);
    }
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!pending) props.onOpenChange(open);
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>另存为专家团</DialogTitle>
          <DialogDescription>
            仅保存成员、用途与协作配置；不会复制 Hub 对话、资料或授权。
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="px-5 text-ui-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <label className="space-y-1.5 px-5 text-ui-sm font-medium">
          专家团名称
          <Input
            value={name}
            maxLength={160}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
            aria-label="另存专家团名称"
          />
        </label>
        <DialogFooter>
          <Button variant="ghost" disabled={pending} onClick={() => props.onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={pending} onClick={() => void save()}>
            {pending ? "保存中…" : "保存专家团"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function HubCollaborationSection(props: {
  readonly active: boolean;
  readonly hubName: string;
  readonly purpose: string;
  readonly collaboration: HubCollaborationSettings | undefined;
  readonly expertIds: ReadonlyArray<string>;
  readonly onChange: (patch: {
    readonly collaboration?: HubCollaborationSettings;
    readonly expertIds?: ReadonlyArray<string>;
    readonly goal?: string;
  }) => void;
}) {
  const { generation } = useNativeApiServerCapabilitySnapshot("hubCollaboration.team.presets");
  const presetsQuery = useQuery({
    queryKey: hubTeamsQueryKey(generation),
    queryFn: () => ensureHubTeamsClient().list(),
    enabled: props.active,
  });
  const presets = presetsQuery.data ?? EMPTY_TEAM_PRESETS;
  const mode = props.collaboration?.mode ?? "standard";
  const [coordinatorOpen, setCoordinatorOpen] = useState(false);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [savedTeamNotice, setSavedTeamNotice] = useState<string | null>(null);
  const activePresets = useMemo(
    () => presets.filter((preset) => preset.archivedAt === null),
    [presets],
  );
  const source = props.collaboration?.presetSource;
  const sourcePreset = source ? presets.find((preset) => preset.id === source.id) : undefined;

  const updateCollaboration = (patch: Partial<HubCollaborationSettings>) => {
    props.onChange({
      collaboration: {
        schemaVersion: 1,
        mode,
        ...props.collaboration,
        ...patch,
      },
    });
    setSavedTeamNotice(null);
  };
  const changeMode = (next: HubCollaborationSettings["mode"]) => {
    if (next === mode && props.collaboration) return;
    props.onChange({
      collaboration: {
        schemaVersion: 1,
        mode: next,
        ...(props.collaboration?.coordinatorInstructions
          ? { coordinatorInstructions: props.collaboration.coordinatorInstructions }
          : {}),
        ...(props.collaboration?.collaborationPreferences
          ? { collaborationPreferences: props.collaboration.collaborationPreferences }
          : {}),
        ...(props.collaboration?.presetSource
          ? { presetSource: props.collaboration.presetSource }
          : {}),
      },
    });
    setSavedTeamNotice(null);
  };
  const applyPreset = (presetId: string) => {
    const preset = activePresets.find((item) => item.id === presetId);
    if (!preset) return;
    props.onChange({
      goal: preset.purpose,
      expertIds: [...preset.expertIds],
      collaboration: copyPreset(preset),
    });
    setSavedTeamNotice(null);
  };

  const saveAsDialog = (
    <TeamSaveAsDialog
      open={saveAsOpen}
      onOpenChange={setSaveAsOpen}
      initialName={`${props.hubName.trim() || "Hub"} 配置`}
      expertIds={props.expertIds}
      collaboration={props.collaboration}
      purpose={props.purpose}
      onSaved={(team) => setSavedTeamNotice(`已另存为专家团“${team.name}” v${team.revision}。`)}
    />
  );

  return (
    <div className="space-y-6">
      <SettingsSectionShell title="协作模式">
        <SettingsCard divided={false} className="space-y-3 px-4 py-3">
          <SettingsSegmentedControl
            value={mode}
            onValueChange={changeMode}
            ariaLabel="Hub 协作模式"
            options={[
              { value: "standard", label: "标准模式" },
              { value: "expert-team", label: "专家团模式" },
            ]}
          />
          {mode === "expert-team" ? (
            <div className="space-y-2">
              <SettingsSelectControl
                value={sourcePreset?.archivedAt === null ? sourcePreset.id : null}
                onValueChange={applyPreset}
                ariaLabel="从专家团预设采用副本"
                valueContent={
                  sourcePreset ? `${sourcePreset.name} · v${source?.revision}` : "选择专家团预设"
                }
                disabled={presetsQuery.isError || activePresets.length === 0}
              >
                {activePresets.map((preset) => (
                  <SelectItem key={preset.id} value={preset.id}>
                    {preset.name} · v{preset.revision}
                  </SelectItem>
                ))}
              </SettingsSelectControl>
              {presetsQuery.isPending && !presetsQuery.data ? (
                <SettingsEmptyState layout="status">正在读取专家团…</SettingsEmptyState>
              ) : null}
              {presetsQuery.isError ? (
                <p className="text-ui-sm text-destructive" role="alert">
                  无法读取专家团：{errorText(presetsQuery.error)}
                </p>
              ) : null}
              {source ? (
                <p className="text-ui-sm text-muted-foreground" role="status">
                  来源：{sourcePreset?.name ?? source.id} v{source.revision}
                  {sourcePreset?.revision && sourcePreset.revision > source.revision
                    ? ` · 预设已有 v${sourcePreset.revision}，当前 Hub 仍使用已保存的副本`
                    : ""}
                  {sourcePreset?.archivedAt ? " · 来源预设已归档" : ""}
                  {!sourcePreset && presetsQuery.data !== undefined && !presetsQuery.isError
                    ? " · 来源预设不可用，当前副本仍保留"
                    : ""}
                </p>
              ) : null}
            </div>
          ) : null}
        </SettingsCard>
      </SettingsSectionShell>

      {mode === "expert-team" ? (
        <>
          <SettingsSectionShell title="协调者">
            <SettingsCard divided={false} className="px-4 py-3">
              <Collapsible open={coordinatorOpen} onOpenChange={setCoordinatorOpen}>
                <CollapsibleTrigger className="flex w-full items-center gap-2 py-1 text-left text-ui font-medium">
                  <DisclosureChevron open={coordinatorOpen} className="size-4 shrink-0" />
                  <span>角色与协调方式</span>
                  <span className="text-ui-sm font-normal text-muted-foreground">
                    ·{" "}
                    {props.collaboration?.coordinatorInstructions?.trim()
                      ? "已自定义"
                      : "默认协调方式"}
                  </span>
                </CollapsibleTrigger>
                <CollapsiblePanel>
                  <div className="space-y-2 pt-3">
                    <Textarea
                      value={props.collaboration?.coordinatorInstructions ?? ""}
                      maxLength={8000}
                      onChange={(event) =>
                        updateCollaboration({
                          coordinatorInstructions: event.target.value || undefined,
                        })
                      }
                      placeholder="可选。留空时使用默认协调方式。"
                      aria-label="协调者角色与协调方式"
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => updateCollaboration({ coordinatorInstructions: undefined })}
                    >
                      恢复默认
                    </Button>
                  </div>
                </CollapsiblePanel>
              </Collapsible>
            </SettingsCard>
          </SettingsSectionShell>
          <SettingsSectionShell title="协作偏好">
            <SettingsCard divided={false} className="space-y-2 px-4 py-3">
              <Textarea
                value={props.collaboration?.collaborationPreferences ?? ""}
                maxLength={8000}
                onChange={(event) =>
                  updateCollaboration({ collaborationPreferences: event.target.value || undefined })
                }
                placeholder="可选。留空时按任务需要安排协作。"
                aria-label="协作偏好"
              />
            </SettingsCard>
          </SettingsSectionShell>
          <div className="space-y-1">
            <Button
              size="sm"
              variant="outline"
              disabled={props.expertIds.length === 0}
              onClick={() => setSaveAsOpen(true)}
            >
              另存为专家团
            </Button>
            {savedTeamNotice ? (
              <p className="text-ui-sm text-muted-foreground" role="status">
                {savedTeamNotice}
              </p>
            ) : null}
          </div>
        </>
      ) : null}
      {saveAsDialog}
    </div>
  );
}
