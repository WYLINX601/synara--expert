import { useTranslation } from "~/i18n";
import { ambientConnectionPresentation } from "~/lib/ambientContextBinding";
import {
  useAmbientContextBindingStore,
  validAmbientBindingLimit,
  MAX_AMBIENT_BINDING_LIMIT,
} from "~/ambientContextBindingStore";
import type { AmbientContextSourcePolicy, AmbientContextType } from "@synara/contracts";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AMBIENT_CONTEXT_QUERY_KEY, useAmbientContext } from "~/hooks/useAmbientContext";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Checkbox } from "../ui/checkbox";
import { Menu, MenuItem, MenuTrigger } from "../ui/menu";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

export function AmbientContextSettingsPanel({ active }: { active: boolean }) {
  const { t } = useTranslation();
  const TYPE_LABELS: Record<AmbientContextType, string> = {
    "application.identity": t("settings:ambientTypeApplication"),
    "window.identity": t("settings:ambientTypeWindow"),
    "resource.identity": t("settings:ambientTypeResource"),
    "selection.text": t("settings:ambientTypeText"),
    "selection.location": t("settings:ambientTypeLocation"),
    "element.identity": t("settings:ambientTypeElement"),
    "resource.content": t("settings:ambientTypeContent"),
  };
  const { bridge, data, error } = useAmbientContext(active);
  const connectionPeers = [...(data?.connections ?? []), ...(data?.pendingConnections ?? [])];
  const presentConnection = (connection: { id: string; label: string }) =>
    ambientConnectionPresentation(connection, connectionPeers);
  const bindingLimit = useAmbientContextBindingStore((state) => state.maxBindings);
  const [limitDraft, setLimitDraft] = useState(String(bindingLimit));
  useEffect(() => setLimitDraft(String(bindingLimit)), [bindingLimit]);
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const pairingEpoch = useRef(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<{
    sourceId: string;
    label: string;
    endpoint: string;
    token: string;
  } | null>(null);
  useEffect(() => {
    if (!active) setPairing(null);
    return () => {
      pairingEpoch.current += 1;
    };
  }, [active]);
  if (!active) return null;
  if (!bridge)
    return (
      <p className="text-ui-sm text-muted-foreground">{t("settings:ambientDesktopRequired")}</p>
    );
  async function connectionAction(id: string, approve: boolean) {
    if (!bridge) return;
    const action = approve ? bridge.approveConnection : bridge.revokeConnection;
    if (!action) return;
    setBusy(true);
    setActionError(null);
    setPairing(null);
    pairingEpoch.current += 1;
    try {
      await action(id);
      await queryClient.invalidateQueries({ queryKey: AMBIENT_CONTEXT_QUERY_KEY });
    } catch {
      setActionError(t("settings:ambientConnectionUpdateFailed"));
    } finally {
      setBusy(false);
    }
  }
  async function showPairing(sourceId: string, label: string) {
    if (!bridge) return;
    setBusy(true);
    setActionError(null);
    setPairing(null);
    const requestEpoch = ++pairingEpoch.current;
    try {
      const details = await bridge.getPairing(sourceId);
      if (requestEpoch === pairingEpoch.current) setPairing({ sourceId, label, ...details });
    } catch {
      setActionError(t("settings:ambientPairingFailed"));
    } finally {
      setBusy(false);
    }
  }
  async function configure(sourceId: string, policy: AmbientContextSourcePolicy) {
    if (!bridge) return;
    setBusy(true);
    setActionError(null);
    setPairing(null);
    pairingEpoch.current += 1;
    try {
      const next = await bridge.configure(sourceId, policy);
      queryClient.setQueryData(AMBIENT_CONTEXT_QUERY_KEY, next);
      await queryClient.invalidateQueries({ queryKey: ["desktop", "ambient-resources"] });
    } catch {
      setActionError(t("settings:ambientSaveFailed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-6">
      <SettingsSection title={t("settings:ambientChatBindings")}>
        <SettingsRow
          title={t("settings:ambientVaultLimit")}
          description={t("settings:ambientVaultLimitDescription")}
        >
          <Input
            type="number"
            min={1}
            max={MAX_AMBIENT_BINDING_LIMIT}
            step={1}
            aria-label={t("settings:ambientVaultLimit")}
            className="w-20"
            value={limitDraft}
            aria-invalid={!validAmbientBindingLimit(Number(limitDraft))}
            onChange={(event) => {
              setLimitDraft(event.target.value);
              const value = Number(event.target.value);
              if (validAmbientBindingLimit(value))
                useAmbientContextBindingStore.getState().setMaxBindings(value);
            }}
            onBlur={() =>
              setLimitDraft(String(useAmbientContextBindingStore.getState().maxBindings))
            }
          />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title={t("settings:ambientConnectedVaults")}>
        {data?.connections?.length ? (
          data.connections.map((connection) => (
            <SettingsRow
              key={connection.id}
              title={
                <span title={presentConnection(connection).title}>
                  {presentConnection(connection).label}
                </span>
              }
              description={
                connection.error ??
                (connection.connected
                  ? t("settings:ambientBindViaMention")
                  : t("settings:ambientDisconnectedNoStale"))
              }
              status={
                connection.connected
                  ? t("settings:ambientConnected")
                  : t("settings:ambientUnavailable")
              }
            >
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      aria-label={t("settings:ambientConnectionOptionsLabel", {
                        label: presentConnection(connection).label,
                      })}
                      title={presentConnection(connection).title}
                    />
                  }
                >
                  {t("settings:ambientConnectionOptions")}
                </MenuTrigger>
                <ComposerPickerMenuPopup align="end" className="w-44 min-w-44">
                  <MenuItem
                    disabled={
                      !data.sources.some(
                        (source) => source.manifest.id === "obsidian" && source.policy.enabled,
                      )
                    }
                    onClick={() =>
                      void showPairing(connection.sourceId, presentConnection(connection).label)
                    }
                  >
                    {t("settings:ambientManualPairing")}
                  </MenuItem>
                  <MenuItem
                    variant="destructive"
                    disabled={!bridge.revokeConnection}
                    onClick={() => void connectionAction(connection.id, false)}
                  >
                    {t("settings:ambientRevoke")}
                  </MenuItem>
                </ComposerPickerMenuPopup>
              </Menu>
            </SettingsRow>
          ))
        ) : (
          <p className="px-4 py-3 text-ui-sm text-muted-foreground">
            {t("settings:ambientNoConnections")}
          </p>
        )}
        {pairing ? (
          <div className="space-y-2 px-4 py-3 text-ui-sm">
            <p className="text-muted-foreground">
              {t("settings:ambientCredentialsNotice", { label: pairing.label })}
            </p>
            <label className="block">
              {t("settings:ambientEndpoint")}
              <Input
                aria-label={t("settings:ambientEndpointLabel")}
                readOnly
                value={pairing.endpoint}
                className="mt-1 w-full rounded border bg-background px-2 py-1 text-ui-sm"
              />
            </label>
            <label className="block">
              {t("settings:ambientToken")}
              <Input
                aria-label={t("settings:ambientTokenLabel")}
                readOnly
                value={pairing.token}
                className="mt-1 w-full rounded border bg-background px-2 py-1 text-ui-sm"
              />
            </label>
            <Button type="button" size="xs" variant="ghost" onClick={() => setPairing(null)}>
              {t("settings:ambientHidePairing")}
            </Button>
          </div>
        ) : null}
      </SettingsSection>
      {data?.pendingConnections?.length ? (
        <SettingsSection title={t("settings:ambientPendingConnections")}>
          {data.pendingConnections.map((connection) => (
            <SettingsRow
              key={connection.id}
              title={
                <span title={presentConnection(connection).title}>
                  {presentConnection(connection).label}
                </span>
              }
              description={t("settings:ambientApprovalDescription")}
            >
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={busy || !bridge.revokeConnection}
                  onClick={() => void connectionAction(connection.id, false)}
                >
                  {t("settings:ambientIgnore")}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  disabled={busy || !bridge.approveConnection}
                  title={presentConnection(connection).title}
                  onClick={() => void connectionAction(connection.id, true)}
                >
                  {t("settings:ambientApprove")}
                </Button>
              </div>
            </SettingsRow>
          ))}
        </SettingsSection>
      ) : null}
      {data?.sources.map((source) => (
        <SettingsSection
          key={source.manifest.id}
          title={t("settings:ambientSourceTitle", { source: source.manifest.label })}
        >
          <SettingsRow
            title={t("settings:ambientEnableSource")}
            description={t("settings:ambientSourceDescription")}
            status={
              source.error
                ? t("settings:ambientSourceUnavailable")
                : source.connected
                  ? t("settings:ambientConnected")
                  : t("settings:ambientNotConnected")
            }
          >
            <Switch
              aria-label={t("settings:ambientEnableSourceLabel", { source: source.manifest.label })}
              checked={source.policy.enabled}
              disabled={busy}
              onCheckedChange={(enabled) =>
                void configure(source.manifest.id, {
                  ...source.policy,
                  enabled,
                  allowedTypes:
                    enabled && source.policy.allowedTypes.length === 0
                      ? [
                          "application.identity",
                          "resource.identity",
                          "selection.text",
                          "selection.location",
                        ]
                      : source.policy.allowedTypes,
                })
              }
            />
          </SettingsRow>
          {source.manifest.capabilities.map((capability) => (
            <SettingsRow
              key={capability.type}
              title={TYPE_LABELS[capability.type]}
              description={
                capability.type === "resource.content"
                  ? t("settings:ambientFullTextDescription")
                  : t("settings:ambientShareWhenEnabled")
              }
            >
              <Checkbox
                aria-label={TYPE_LABELS[capability.type]}
                checked={source.policy.allowedTypes.includes(capability.type)}
                disabled={busy || !source.policy.enabled}
                onCheckedChange={(checked) =>
                  void configure(source.manifest.id, {
                    ...source.policy,
                    allowedTypes: checked
                      ? [...source.policy.allowedTypes, capability.type]
                      : source.policy.allowedTypes.filter((type) => type !== capability.type),
                  })
                }
              />
            </SettingsRow>
          ))}
        </SettingsSection>
      ))}
      {actionError || error ? (
        <p role="status" className="text-ui-sm text-destructive">
          {actionError ?? t("settings:ambientSourcesUnavailable")}
        </p>
      ) : null}
    </div>
  );
}
