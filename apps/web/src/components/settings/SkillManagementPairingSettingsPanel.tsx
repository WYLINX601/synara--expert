import type { SkillManagementPairingResult } from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { ensureExpertClient } from "~/workbench/host/expertClient";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

const CREDENTIALS_QUERY_KEY = ["server", "skillManagementCredentials"] as const;

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function SkillManagementPairingSettingsPanel(props: { readonly active: boolean }) {
  const queryClient = useQueryClient();
  const [pairing, setPairing] = useState<SkillManagementPairingResult | null>(null);
  const accessQuery = useQuery({
    queryKey: ["server", "skillManagementAccess"],
    queryFn: () => ensureExpertClient().readSkillManagementAccess(),
    enabled: props.active,
    staleTime: 5_000,
  });
  const canManage = accessQuery.data?.canManage === true;
  const credentialsQuery = useQuery({
    queryKey: CREDENTIALS_QUERY_KEY,
    queryFn: () => ensureExpertClient().listSkillManagementCredentials(),
    enabled: props.active && canManage,
    staleTime: 5_000,
  });
  const createPairingMutation = useMutation({
    mutationFn: () => ensureExpertClient().createSkillManagementPairing(),
    onSuccess: (result) => {
      setPairing(result);
      toastManager.add({
        type: "success",
        title: "Local Skill CLI pairing ready",
        description: "This one-time code expires in five minutes.",
      });
    },
    onError: (error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Could not create CLI pairing",
        description: error instanceof Error ? error.message : "Skill CLI pairing failed.",
      }),
  });
  const revokeMutation = useMutation({
    mutationFn: (credentialId: string) =>
      ensureExpertClient().revokeSkillManagementCredential({ credentialId }),
    onSuccess: (_result, _credentialId) => {
      void queryClient.invalidateQueries({ queryKey: CREDENTIALS_QUERY_KEY });
      toastManager.add({ type: "success", title: "Management credential revoked" });
    },
    onError: (error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Could not revoke credential",
        description:
          error instanceof Error ? error.message : "Skill management credential revocation failed.",
      }),
  });

  if (!props.active || !canManage) return null;

  const pairCommand = pairing
    ? `synara skill auth pair --home-dir ${quoteShellArgument(pairing.homeDir)} --instance-id ${pairing.instanceId} --flavor ${pairing.flavor}`
    : null;

  return (
    <SettingsSection title="Local Skill CLI access">
      <SettingsRow
        title="Pair a local CLI"
        description="Authorize the Synara CLI for Skill and Expert Skill binding management on this app instance. The one-time code is bound to this instance and flavor."
        status={
          pairing ? (
            <div className="space-y-2">
              <div className="font-mono text-ui-lg text-foreground">{pairing.code}</div>
              <div className="text-ui-sm text-muted-foreground">
                Expires {formatDate(pairing.expiresAt)} · {pairing.flavor} · {pairing.instanceId}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    void copyTextToClipboard(pairing.code).then(
                      () => toastManager.add({ type: "success", title: "Pairing code copied" }),
                      () =>
                        toastManager.add({ type: "error", title: "Could not copy pairing code" }),
                    )
                  }
                >
                  Copy code
                </Button>
                <span className="text-ui-sm text-muted-foreground">Run in Terminal:</span>
                <code className="select-all break-all rounded bg-muted px-2 py-1 font-mono text-ui-sm text-foreground">
                  {pairCommand}
                </code>
              </div>
              <p className="text-ui-sm text-muted-foreground">
                Enter the code when prompted. The CLI stores its credential privately and does not
                print it.
              </p>
            </div>
          ) : (
            "Creates a short-lived code. Pairing does not start a server or grant general owner access."
          )
        }
        control={
          <Button
            size="xs"
            variant={pairing ? "outline" : "default"}
            disabled={createPairingMutation.isPending}
            onClick={() => createPairingMutation.mutate()}
          >
            {createPairingMutation.isPending
              ? "Creating..."
              : pairing
                ? "Create another code"
                : "Create pairing code"}
          </Button>
        }
      />
      <SettingsRow
        title="Paired CLI credentials"
        description="Each credential can read and manage Skills or Expert Skill bindings. Revoke one here to stop its access immediately."
        status={
          credentialsQuery.isPending ? (
            "Loading credentials..."
          ) : credentialsQuery.isError ? (
            credentialsQuery.error instanceof Error ? (
              credentialsQuery.error.message
            ) : (
              "Could not load management credentials."
            )
          ) : credentialsQuery.data?.length ? (
            <div className="space-y-2">
              {credentialsQuery.data.map((credential) => {
                const expired = Date.parse(credential.expiresAt) <= Date.now();
                const revoked = credential.revokedAt !== null;
                return (
                  <div
                    key={credential.credentialId}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/70 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="break-all font-mono text-ui-sm text-foreground">
                        {credential.credentialId}
                      </div>
                      <div className="text-ui-sm text-muted-foreground">
                        {revoked
                          ? `Revoked ${formatDate(credential.revokedAt!)}`
                          : expired
                            ? `Expired ${formatDate(credential.expiresAt)}`
                            : `Expires ${formatDate(credential.expiresAt)}`}
                      </div>
                    </div>
                    <Button
                      size="xs"
                      variant="destructive-outline"
                      disabled={revoked || revokeMutation.isPending}
                      onClick={() => revokeMutation.mutate(credential.credentialId)}
                    >
                      {revoked ? "Revoked" : "Revoke"}
                    </Button>
                  </div>
                );
              })}
            </div>
          ) : (
            "No active credentials."
          )
        }
        control={
          <Button
            size="xs"
            variant="outline"
            disabled={credentialsQuery.isFetching}
            onClick={() => void credentialsQuery.refetch()}
          >
            Refresh
          </Button>
        }
      />
    </SettingsSection>
  );
}
