import {
  type ContextApi,
  type ContextCommandResult,
  type ContextMigrationRecord,
  type ProjectContextSettings,
  type ProjectId,
  type ThreadId,
} from "@synara/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { newCommandId } from "~/lib/utils";
import {
  contextApiQueryIdentity,
  readContextClient,
  readLegacyProjectInstructions,
  useContextClient,
} from "~/workbench/host/contextClient";
import { toastManager } from "~/components/ui/toast";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";

interface MigrationRequest {
  readonly api: ContextApi;
  readonly hostGeneration: string | null;
  readonly phase: "ownership" | "resolve";
  readonly settings: ProjectContextSettings;
  readonly migration: ContextMigrationRecord | null;
  readonly sourceDigest: string;
  readonly legacyInstructions: string;
  readonly localProjectName: string;
  readonly localWorkspaceRoot: string;
  readonly generation: number;
  readonly error: string | null;
}

interface PendingSend {
  readonly generation: number;
  readonly promise: Promise<boolean>;
  readonly resolve: (continueSend: boolean) => void;
}

interface CommandAttempt {
  readonly commandId: ReturnType<typeof newCommandId>;
  readonly key: string;
}

async function sha256Utf8(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Secure SHA-256 is unavailable in this browser.");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function runIdempotentCommand(
  api: ContextApi,
  attempt: CommandAttempt,
  input: { readonly commandId: CommandAttempt["commandId"] },
  run: () => Promise<ContextCommandResult>,
  retryExisting: boolean,
  stillCurrent: () => boolean,
): Promise<ContextCommandResult> {
  const requireCurrentApi = () => {
    const client = readContextClient();
    if (!client.available || client.api !== api || !stillCurrent())
      throw new Error("Context is disconnected. Reconnect before retrying.");
  };
  let result: ContextCommandResult | null = null;
  if (retryExisting) {
    try {
      requireCurrentApi();
      result = await api.getCommandResult({ commandId: attempt.commandId });
      requireCurrentApi();
    } catch {
      // The original command may still be queryable after a reconnect; continue below.
    }
  }
  if (!result || result.status === "unknown" || result.status === "pending") {
    try {
      requireCurrentApi();
      result = await run();
      requireCurrentApi();
    } catch {
      try {
        requireCurrentApi();
        result = await api.getCommandResult({ commandId: attempt.commandId });
        requireCurrentApi();
      } catch {
        result = null;
      }
    }
  }
  if (result?.status === "unknown") {
    try {
      requireCurrentApi();
      result = await run();
      requireCurrentApi();
    } catch {
      try {
        requireCurrentApi();
        result = await api.getCommandResult({ commandId: attempt.commandId });
        requireCurrentApi();
      } catch {
        result = null;
      }
    }
  }
  if (!result) {
    return {
      commandId: input.commandId,
      status: "unknown",
      message: "Could not confirm this command.",
    };
  }
  return result;
}

export function useProjectContextMigration(input: {
  readonly projectId: ProjectId | null;
  readonly threadId: ThreadId | null;
  readonly localProjectName: string;
  readonly localWorkspaceRoot: string;
  readonly isLocalDraft: boolean;
  readonly hasPendingContextDraft?: boolean;
  readonly hasDetachedContextDraft?: boolean;
  readonly contextDataInstanceId?: string | null;
}): { readonly beforeFirstSend: () => Promise<boolean>; readonly dialog: ReactNode } {
  const contextClient = useContextClient();
  const latestInput = useRef(input);
  useLayoutEffect(() => {
    latestInput.current = input;
  }, [input]);
  const isCurrentContext = useCallback(
    (api: ContextApi, hostGeneration: string | null, dataInstanceId?: string) => {
      const client = readContextClient();
      const latest = latestInput.current;
      return (
        client.api === api &&
        client.generation === hostGeneration &&
        client.available &&
        !(latest.hasPendingContextDraft && latest.hasDetachedContextDraft) &&
        (!dataInstanceId ||
          !latest.contextDataInstanceId ||
          latest.contextDataInstanceId === dataInstanceId)
      );
    },
    [],
  );
  const [request, setRequest] = useState<MigrationRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const pendingSendRef = useRef<PendingSend | null>(null);
  const claimAttemptRef = useRef<CommandAttempt | null>(null);
  const resolveAttemptRef = useRef<CommandAttempt | null>(null);
  const identityKey = JSON.stringify([
    contextApiQueryIdentity(contextClient.api),
    contextClient.generation,
    input.projectId,
    input.threadId,
    input.isLocalDraft,
    input.localProjectName,
    input.localWorkspaceRoot,
  ]);
  const identityKeyRef = useRef(identityKey);
  const generationRef = useRef(0);

  useLayoutEffect(() => {
    if (identityKeyRef.current === identityKey) return;
    identityKeyRef.current = identityKey;
    generationRef.current += 1;
    const pending = pendingSendRef.current;
    if (pending && pending.generation !== generationRef.current) {
      pendingSendRef.current = null;
      pending.resolve(false);
    }
    setRequest((current) => (current?.generation === generationRef.current ? current : null));
    setBusy(false);
    claimAttemptRef.current = null;
    resolveAttemptRef.current = null;
  }, [identityKey]);

  const settleSend = useCallback((continueSend: boolean, generation?: number) => {
    const pending = pendingSendRef.current;
    if (!pending || (generation !== undefined && pending.generation !== generation)) return;
    pendingSendRef.current = null;
    pending.resolve(continueSend);
    setRequest(null);
    setBusy(false);
    claimAttemptRef.current = null;
    resolveAttemptRef.current = null;
  }, []);

  useEffect(
    () => () => {
      generationRef.current += 1;
      pendingSendRef.current?.resolve(false);
      pendingSendRef.current = null;
    },
    [],
  );

  const beforeFirstSend = useCallback(async (): Promise<boolean> => {
    if (!input.isLocalDraft || !input.projectId) return true;
    if (input.hasDetachedContextDraft && input.hasPendingContextDraft) {
      toastManager.add({
        type: "error",
        title: "Previous Context draft is not resolved",
        description: "Discard the preserved draft before starting a chat on this connection.",
      });
      return false;
    }
    const contextClient = readContextClient();
    if (contextClient.capability === "unsupported") {
      if (!input.hasPendingContextDraft) return true;
      toastManager.add({
        type: "error",
        title: "Project context is not saved",
        description:
          "Resolve or discard the Context draft before using this server without Context support.",
      });
      return false;
    }
    const generation = generationRef.current;
    const hostGeneration = contextClient.generation;
    if (pendingSendRef.current) return pendingSendRef.current.promise;
    const api = contextClient.api;
    if (!api || !contextClient.available) {
      toastManager.add({
        type: "error",
        title: "Project context is unavailable",
        description: "The first send was not started. Reconnect and try again.",
      });
      return false;
    }

    const legacyInstructions = readLegacyProjectInstructions(input.projectId);

    let settings: ProjectContextSettings;
    try {
      settings = await api.getProject({ projectId: input.projectId });
    } catch (error) {
      if (generationRef.current !== generation) return false;
      toastManager.add({
        type: "error",
        title: "Could not read project context",
        description: error instanceof Error ? error.message : "The first send was not started.",
      });
      return false;
    }
    if (
      generationRef.current !== generation ||
      !isCurrentContext(api, hostGeneration, settings.dataInstanceId)
    )
      return false;
    if (settings.migration?.status === "completed") return true;
    if (!settings.migration && legacyInstructions.length === 0) return true;

    const migration = settings.migration;
    const capturedLegacyInstructions = migration?.legacyInstructions ?? legacyInstructions;
    let sourceDigest = migration?.sourceDigest;
    try {
      sourceDigest ??= await sha256Utf8(capturedLegacyInstructions);
    } catch (error) {
      if (generationRef.current !== generation) return false;
      toastManager.add({
        type: "error",
        title: "Could not prepare legacy context",
        description: error instanceof Error ? error.message : "The first send was not started.",
      });
      return false;
    }
    if (
      generationRef.current !== generation ||
      !isCurrentContext(api, hostGeneration, settings.dataInstanceId)
    )
      return false;
    const nextRequest: MigrationRequest = {
      api,
      hostGeneration,
      phase: migration ? "resolve" : "ownership",
      settings,
      migration,
      sourceDigest,
      legacyInstructions: capturedLegacyInstructions,
      localProjectName: input.localProjectName,
      localWorkspaceRoot: input.localWorkspaceRoot,
      generation,
      error: null,
    };
    setRequest(nextRequest);
    let resolvePending!: (continueSend: boolean) => void;
    const promise = new Promise<boolean>((resolve) => {
      resolvePending = resolve;
    });
    pendingSendRef.current = { generation, promise, resolve: resolvePending };
    return promise;
  }, [
    input.isLocalDraft,
    input.localProjectName,
    input.localWorkspaceRoot,
    input.projectId,
    input.hasPendingContextDraft,
    input.hasDetachedContextDraft,
    input.contextDataInstanceId,
    isCurrentContext,
  ]);

  const claim = useCallback(async () => {
    if (
      !request ||
      request.generation !== generationRef.current ||
      request.phase !== "ownership" ||
      !input.projectId
    )
      return;
    const generation = request.generation;
    const currentClient = readContextClient();
    const api = currentClient.api;
    if (
      !api ||
      !isCurrentContext(api, request.hostGeneration, request.settings.dataInstanceId) ||
      api !== request.api
    ) {
      setRequest({ ...request, error: "Context is unavailable on this connection." });
      return;
    }
    const key = `${request.settings.dataInstanceId}\u0000${input.projectId}\u0000${request.sourceDigest}`;
    const previousAttempt = claimAttemptRef.current;
    const retryExisting = previousAttempt?.key === key;
    const attempt =
      retryExisting && previousAttempt ? previousAttempt : { commandId: newCommandId(), key };
    claimAttemptRef.current = attempt;
    setBusy(true);
    try {
      const commandInput = {
        commandId: attempt.commandId,
        dataInstanceId: request.settings.dataInstanceId,
        projectId: input.projectId,
        expectedWorkspaceRoot: request.settings.workspaceRoot,
        sourceDigest: request.sourceDigest,
        legacyInstructions: request.legacyInstructions,
      };
      const result = await runIdempotentCommand(
        api,
        attempt,
        commandInput,
        () => api.claimMigration(commandInput),
        retryExisting,
        () => isCurrentContext(api, request.hostGeneration, request.settings.dataInstanceId),
      );
      if (
        generationRef.current !== generation ||
        !isCurrentContext(api, request.hostGeneration, request.settings.dataInstanceId)
      )
        return;
      if (result.status === "saved") {
        const latest = result.project ?? (await api.getProject({ projectId: input.projectId }));
        if (
          generationRef.current !== generation ||
          !isCurrentContext(api, request.hostGeneration, request.settings.dataInstanceId)
        )
          return;
        const savedMigration = result.migration ?? latest.migration;
        if (!savedMigration || savedMigration.sourceDigest !== request.sourceDigest) {
          throw new Error("The claimed legacy source could not be confirmed.");
        }
        claimAttemptRef.current = null;
        setRequest({
          ...request,
          phase: "resolve",
          settings: latest,
          migration: savedMigration,
          error: null,
        });
        return;
      }
      if (result.status === "conflict") {
        const latest = result.project ?? (await api.getProject({ projectId: input.projectId }));
        if (
          generationRef.current !== generation ||
          !isCurrentContext(api, request.hostGeneration, request.settings.dataInstanceId)
        )
          return;
        const serverMigration = result.migration ?? latest.migration;
        if (serverMigration?.sourceDigest === request.sourceDigest) {
          claimAttemptRef.current = null;
          setRequest({
            ...request,
            phase: "resolve",
            settings: latest,
            migration: serverMigration,
            error: result.message ?? null,
          });
          return;
        }
        throw new Error(
          result.message ?? "A different legacy source is already registered for this project.",
        );
      }
      if (result.status === "rejected") {
        claimAttemptRef.current = null;
        throw new Error(result.message ?? "The server rejected this legacy context claim.");
      }
      throw new Error(
        result.message ??
          "The claim is still being processed. Retry to confirm the original command.",
      );
    } catch (error) {
      if (
        generationRef.current !== generation ||
        !isCurrentContext(api, request.hostGeneration, request.settings.dataInstanceId)
      )
        return;
      const message = error instanceof Error ? error.message : "Unable to claim legacy context.";
      setRequest((current) => (current ? { ...current, error: message } : current));
    } finally {
      if (generationRef.current === generation) setBusy(false);
    }
  }, [input.projectId, request, isCurrentContext]);

  const resolve = useCallback(
    async (choice: "keep_saved" | "use_legacy") => {
      if (
        !request ||
        request.generation !== generationRef.current ||
        request.phase !== "resolve" ||
        !request.migration ||
        !input.projectId
      )
        return;
      const generation = request.generation;
      const currentClient = readContextClient();
      const api = currentClient.api;
      if (
        !api ||
        !isCurrentContext(api, request.hostGeneration, request.settings.dataInstanceId) ||
        api !== request.api
      ) {
        setRequest({ ...request, error: "Context is unavailable on this connection." });
        return;
      }
      const key = `${request.settings.dataInstanceId}\u0000${input.projectId}\u0000${request.sourceDigest}\u0000${request.settings.revision}\u0000${choice}`;
      const previousAttempt = resolveAttemptRef.current;
      const retryExisting = previousAttempt?.key === key;
      const attempt =
        retryExisting && previousAttempt ? previousAttempt : { commandId: newCommandId(), key };
      resolveAttemptRef.current = attempt;
      setBusy(true);
      try {
        const commandInput = {
          commandId: attempt.commandId,
          dataInstanceId: request.settings.dataInstanceId,
          projectId: input.projectId,
          sourceDigest: request.sourceDigest,
          expectedRevision: request.settings.revision,
          choice,
          ...(choice === "use_legacy" ? { instructions: request.legacyInstructions } : {}),
        };
        const result = await runIdempotentCommand(
          api,
          attempt,
          commandInput,
          () => api.resolveMigration(commandInput),
          retryExisting,
          () => isCurrentContext(api, request.hostGeneration, request.settings.dataInstanceId),
        );
        if (
          generationRef.current !== generation ||
          !isCurrentContext(api, request.hostGeneration, request.settings.dataInstanceId)
        )
          return;
        if (result.status === "saved") {
          const saved = result.project ?? (await api.getProject({ projectId: input.projectId }));
          if (
            generationRef.current !== generation ||
            !isCurrentContext(api, request.hostGeneration, request.settings.dataInstanceId)
          )
            return;
          const savedMigration = result.migration ?? saved.migration;
          const expectedInstructions =
            choice === "use_legacy"
              ? request.legacyInstructions
              : request.settings.projectInstructions;
          if (
            savedMigration?.status !== "completed" ||
            savedMigration.choice !== choice ||
            saved.projectGoal !== request.settings.projectGoal ||
            saved.projectInstructions !== expectedInstructions
          ) {
            throw new Error(
              "Migration completed without matching project values. Read back and retry.",
            );
          }
          settleSend(
            isCurrentContext(api, request.hostGeneration, request.settings.dataInstanceId),
            generation,
          );
          return;
        }
        if (result.status === "conflict") {
          const latest = result.project ?? (await api.getProject({ projectId: input.projectId }));
          if (
            generationRef.current !== generation ||
            !isCurrentContext(api, request.hostGeneration, request.settings.dataInstanceId)
          )
            return;
          const savedMigration = result.migration ?? latest.migration ?? request.migration;
          resolveAttemptRef.current = null;
          setRequest({
            ...request,
            settings: latest,
            migration: savedMigration,
            error:
              result.message ??
              "Project context changed. Compare again and choose how to resolve it.",
          });
          return;
        }
        if (result.status === "rejected") {
          resolveAttemptRef.current = null;
          throw new Error(result.message ?? "The server rejected this migration choice.");
        }
        throw new Error(
          result.message ??
            "The migration is still processing. Retry to confirm the original command.",
        );
      } catch (error) {
        if (
          generationRef.current !== generation ||
          !isCurrentContext(api, request.hostGeneration, request.settings.dataInstanceId)
        )
          return;
        const message =
          error instanceof Error ? error.message : "Unable to resolve legacy context.";
        setRequest((current) => (current ? { ...current, error: message } : current));
      } finally {
        if (generationRef.current === generation) setBusy(false);
      }
    },
    [input.projectId, request, settleSend, isCurrentContext],
  );

  const dialog = request ? (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) settleSend(false, request.generation);
      }}
    >
      <DialogPopup showCloseButton={!busy} className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {request.phase === "ownership"
              ? "Confirm legacy instructions ownership"
              : "Resolve legacy instructions"}
          </DialogTitle>
          <DialogDescription>
            {request.phase === "ownership"
              ? "This browser entry is keyed only by project ID. Confirm the project and workspace before the server records it."
              : "Compare the saved project instructions with the exact legacy text, then choose what to keep."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="max-h-[60vh] space-y-3 overflow-y-auto text-ui">
          <dl className="grid gap-2 rounded-lg border border-[color:var(--color-border-light)] p-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
            <dt className="text-ui-sm text-muted-foreground">Project name</dt>
            <dd className="break-words text-ui-sm">{request.settings.title}</dd>
            <dt className="text-ui-sm text-muted-foreground">Project ID</dt>
            <dd className="break-all text-ui-sm">{request.settings.projectId}</dd>
            <dt className="text-ui-sm text-muted-foreground">Server workspace root</dt>
            <dd className="break-all text-ui-sm">{request.settings.workspaceRoot}</dd>
            <dt className="text-ui-sm text-muted-foreground">Current client project</dt>
            <dd className="break-words text-ui-sm">{request.localProjectName}</dd>
            <dt className="text-ui-sm text-muted-foreground">Current client workspace</dt>
            <dd className="break-all text-ui-sm">{request.localWorkspaceRoot}</dd>
          </dl>
          {request.phase === "resolve" ? (
            <>
              <TextCompare
                label="Saved project instructions"
                value={request.settings.projectInstructions}
              />
              <TextCompare label="Legacy browser instructions" value={request.legacyInstructions} />
              <p className="text-ui-xs text-muted-foreground">
                Project goal is preserved. Source digest: {request.sourceDigest}
              </p>
            </>
          ) : (
            <TextCompare label="Legacy browser instructions" value={request.legacyInstructions} />
          )}
          {request.error ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {request.error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => settleSend(false, request.generation)}
          >
            Cancel send
          </Button>
          {request.phase === "ownership" ? (
            <Button type="button" disabled={busy} onClick={() => void claim()}>
              {busy ? "Claiming…" : "Confirm ownership and compare"}
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void resolve("keep_saved")}
              >
                Keep saved context
              </Button>
              <Button type="button" disabled={busy} onClick={() => void resolve("use_legacy")}>
                Use legacy instructions
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  ) : null;

  return { beforeFirstSend, dialog };
}

function TextCompare({ label, value }: { label: string; value: string }) {
  return (
    <section className="space-y-1">
      <h3 className="text-ui-sm font-medium">{label}</h3>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[color:var(--color-border-light)] p-3 text-ui-sm">
        {value || "Empty"}
      </pre>
    </section>
  );
}
