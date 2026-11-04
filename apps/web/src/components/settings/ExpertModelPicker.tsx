import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { EXPERT_PROVIDER_KINDS, type ExpertSaveInput } from "@synara/contracts";
import { isExpertProvider } from "@synara/shared/expertProviders";

import {
  getProviderInstanceOptions,
  resolveDefaultProviderInstanceId,
  useAppSettings,
} from "~/appSettings";
import { useProviderModelCatalog } from "~/hooks/useProviderModelCatalog";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import { resolveProviderDiscoveryCwd } from "~/lib/providerDiscovery";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { buildModelSelection } from "~/providerModelOptions";
import { ComposerModelPicker } from "../chat/ComposerModelPicker";
import { resolveRuntimeModelDescriptor } from "../chat/runtimeModelCapabilities";
import { SettingsRow } from "./SettingsPanelPrimitives";

type ExpertDefaultSelection = NonNullable<ExpertSaveInput["defaultModelSelection"]>;

export function ExpertModelPicker(props: {
  readonly draft: ExpertSaveInput;
  readonly disabled: boolean;
  readonly onChange: (patch: Partial<ExpertSaveInput>) => void;
}) {
  const { settings } = useAppSettings();
  const statuses = useProviderStatusesForLocalConfig();
  const config = useQuery(serverConfigQueryOptions());
  const [open, setOpen] = useState(false);
  const selection = props.draft.defaultModelSelection;
  const provider =
    selection?.provider ??
    props.draft.preferredProvider ??
    (isExpertProvider(settings.defaultProvider) ? settings.defaultProvider : "codex");
  const instanceId = selection?.instanceId ?? resolveDefaultProviderInstanceId(settings, provider);
  const instances = useMemo(() => getProviderInstanceOptions(settings), [settings]);
  const catalog = useProviderModelCatalog({
    selectedProvider: provider,
    selectedProviderInstanceId: instanceId,
    discoveryEnabled: open,
    prefetchProviders: open ? EXPERT_PROVIDER_KINDS : [provider],
    cwd: resolveProviderDiscoveryCwd({
      activeThreadWorktreePath: null,
      activeProjectCwd: null,
      serverCwd: config.data?.cwd ?? null,
    }),
    modelHintByProvider: { [provider]: selection?.model ?? null },
  });

  return (
    <SettingsRow
      title="默认 harness 和模型"
      description="用于新任务；派发时可覆盖，不影响已开始的任务。"
      control={
        <ComposerModelPicker
          provider={provider}
          model={selection?.model ?? ""}
          placeholder="选择 harness 和模型"
          lockedProvider={null}
          allowedProviders={EXPERT_PROVIDER_KINDS}
          providers={statuses}
          providerInstances={instances}
          selectedProviderInstanceId={instanceId}
          modelOptionsByProvider={catalog.modelOptionsByProvider}
          modelOptionsByProviderInstance={catalog.modelOptionsByProviderInstance}
          loadingModelProviders={catalog.loadingModelProviders}
          discoveryErrorsByProvider={catalog.discoveryErrorsByProvider}
          onRefreshModels={catalog.refreshModels}
          runtimeModel={catalog.selectedRuntimeModel}
          runtimeModelsByProvider={catalog.runtimeModelsByProvider}
          runtimeAgents={catalog.selectedRuntimeAgents}
          hiddenProviders={settings.hiddenProviders}
          providerOrder={settings.providerOrder}
          modelOptions={selection?.options}
          prompt=""
          effortControl="slider"
          disabled={props.disabled}
          open={open}
          onOpenChange={setOpen}
          onProviderModelChange={(nextProvider, model, options) => {
            if (!isExpertProvider(nextProvider)) throw new Error("Unsupported Expert harness.");
            const nextInstanceId = options?.instanceId ?? nextProvider;
            const runtimeModel = resolveRuntimeModelDescriptor({
              provider: nextProvider,
              model,
              runtimeModels:
                catalog.runtimeModelsByProviderInstance[nextInstanceId] ??
                catalog.runtimeModelsByProvider[nextProvider],
            });
            const next = buildModelSelection(
              nextProvider,
              model,
              options?.modelOptions,
              runtimeModel?.supportsAutoMode,
              { instanceId: nextInstanceId },
            ) as ExpertDefaultSelection;
            props.onChange({ preferredProvider: nextProvider, defaultModelSelection: next });
          }}
          onModelOptionsChange={(options) => {
            if (!selection)
              throw new Error("Select an Expert model before configuring its options.");
            props.onChange({
              defaultModelSelection: { ...selection, options } as ExpertDefaultSelection,
            });
          }}
          resetSelection={{
            label: "不指定默认模型",
            onReset: () =>
              props.onChange({
                preferredProvider: undefined,
                defaultModelSelection: undefined,
              }),
          }}
        />
      }
    />
  );
}
