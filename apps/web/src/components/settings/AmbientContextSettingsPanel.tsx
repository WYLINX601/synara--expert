import type { AmbientContextSourcePolicy, AmbientContextType } from "@synara/contracts";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AMBIENT_CONTEXT_QUERY_KEY, useAmbientContext } from "~/hooks/useAmbientContext";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Checkbox } from "../ui/checkbox";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

const TYPE_LABELS: Record<AmbientContextType, string> = {
  "application.identity": "Application identity",
  "window.identity": "Window title",
  "resource.identity": "File identity and resource search",
  "selection.text": "Selected text",
  "selection.location": "Selection location",
  "element.identity": "Element identity",
  "resource.content": "Document content",
};

export function AmbientContextSettingsPanel({ active }: { active: boolean }) {
  const { bridge, data, error } = useAmbientContext(active);
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const pairingEpoch = useRef(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<{
    sourceId: string;
    endpoint: string;
    token: string;
  } | null>(null);
  useEffect(() => {
    if (!active) setPairing(null);
    return () => {
      pairingEpoch.current += 1;
    };
  }, [active]);
  if (!active || !bridge) return null;
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
      setActionError("Could not save the context source settings. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-6">
      {data?.sources.map((source) => (
        <SettingsSection key={source.manifest.id} title={`${source.manifest.label} context`}>
          <SettingsRow
            title="Enable context source"
            description="Choose which information this app can share. Attach context explicitly in a chat to send it."
            status={
              source.error
                ? "Source connection unavailable"
                : source.connected
                  ? "Connected"
                  : "Not connected"
            }
          >
            <Switch
              aria-label={`Enable ${source.manifest.label} context`}
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
                  ? "Includes document text when you attach context. Off by default."
                  : "Shared only when this source is enabled."
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
          <SettingsRow
            title="Connect Obsidian"
            description="Enter the endpoint and token in the Obsidian companion plugin. Changing these permissions or restarting Synara requires pairing again."
          >
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={busy || !source.policy.enabled}
              onClick={async () => {
                setBusy(true);
                setActionError(null);
                const requestEpoch = ++pairingEpoch.current;
                try {
                  const details = await bridge.getPairing(source.manifest.id);
                  if (requestEpoch === pairingEpoch.current) {
                    setPairing({ sourceId: source.manifest.id, ...details });
                  }
                } catch {
                  setActionError("Could not create pairing credentials. Try again.");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Show pairing details
            </Button>
          </SettingsRow>
          {pairing?.sourceId === source.manifest.id ? (
            <div className="space-y-2 px-4 py-3 text-ui-sm">
              <p className="text-muted-foreground">Session credentials — keep them private.</p>
              <label className="block">
                Endpoint
                <Input
                  aria-label="Obsidian endpoint"
                  readOnly
                  value={pairing.endpoint}
                  className="mt-1 w-full rounded border bg-background px-2 py-1 text-ui-sm"
                />
              </label>
              <label className="block">
                Token
                <Input
                  aria-label="Obsidian pairing token"
                  readOnly
                  value={pairing.token}
                  className="mt-1 w-full rounded border bg-background px-2 py-1 text-ui-sm"
                />
              </label>
              <Button type="button" size="xs" variant="ghost" onClick={() => setPairing(null)}>
                Hide pairing details
              </Button>
            </div>
          ) : null}
        </SettingsSection>
      ))}
      {actionError || error ? (
        <p role="status" className="text-ui-sm text-destructive">
          {actionError ?? "Context sources are unavailable."}
        </p>
      ) : null}
    </div>
  );
}
