import {
  type ProjectId,
  type ThreadContextDetails as ThreadContextDetailsDto,
  type ThreadId,
} from "@synara/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";

import { newCommandId } from "~/lib/utils";
import { useContextClient } from "~/workbench/host/contextClient";
import { Button } from "~/components/ui/button";
import { EnvironmentCollapsibleSection } from "./environment/EnvironmentRow";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";

export function ContextDetailsDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly threadId: ThreadId | null;
  readonly projectId: ProjectId | null;
  readonly isLocalDraft: boolean;
  readonly onNewThread: () => void;
}) {
  const contextClient = useContextClient();
  const contextApi = contextClient.supported ? contextClient.api : null;
  const detailsQuery = useQuery({
    queryKey: ["context", "thread", props.threadId],
    enabled: Boolean(props.open && !props.isLocalDraft && props.threadId && contextApi),
    queryFn: () => {
      if (!props.threadId || !contextApi) throw new Error("Thread Context is unavailable.");
      return contextApi.getThread({ threadId: props.threadId });
    },
    refetchInterval: props.open && !props.isLocalDraft ? 2_000 : false,
    refetchIntervalInBackground: false,
    staleTime: 0,
  });

  const retry = useMutation({
    mutationFn: async (details: ThreadContextDetailsDto) => {
      if (!contextApi || !props.threadId || !details.retry) return;
      const result = await contextApi.retryLoad({
        commandId: newCommandId(),
        threadId: props.threadId,
        eventSequence: details.retry.eventSequence,
      });
      if (result.status !== "saved")
        throw new Error(result.message ?? "Context retry was not accepted.");
    },
    retry: false,
    onSettled: () => detailsQuery.refetch(),
  });

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) retry.reset();
        props.onOpenChange(open);
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Context details</DialogTitle>
          <DialogDescription>
            The Context snapshot and load state recorded for this chat.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="max-h-[65vh] space-y-4 overflow-y-auto text-ui">
          {!contextClient.supported ? (
            <p className="text-ui-sm text-muted-foreground">
              Context is unavailable on this server.
            </p>
          ) : !contextApi ? (
            <p className="text-ui-sm text-muted-foreground">
              Context is temporarily unavailable. Reconnect and try again.
            </p>
          ) : props.isLocalDraft ? (
            <p className="text-ui-sm text-muted-foreground">
              This chat has not been created on the server yet. Context will be bound when you first
              send.
            </p>
          ) : detailsQuery.isPending ? (
            <p className="text-ui-sm text-muted-foreground">Loading Context details…</p>
          ) : detailsQuery.error ? (
            <div className="space-y-2">
              <p role="alert" className="text-ui-sm text-destructive">
                {detailsQuery.error instanceof Error
                  ? detailsQuery.error.message
                  : "Unable to load Context details."}
              </p>
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => void detailsQuery.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : detailsQuery.data ? (
            <ThreadDetails
              details={detailsQuery.data}
              onRetry={() => retry.mutate(detailsQuery.data!)}
              retryPending={retry.isPending}
            />
          ) : null}
          {retry.error ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {retry.error.message}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {props.projectId ? (
            <Button
              type="button"
              variant="outline"
              onClick={props.onNewThread}
              disabled={!contextClient.supported || !contextApi}
            >
              Start a new chat with current Context
            </Button>
          ) : null}
          <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ThreadDetails({
  details,
  onRetry,
  retryPending,
}: {
  details: ThreadContextDetailsDto;
  onRetry: () => void;
  retryPending: boolean;
}) {
  return (
    <>
      <dl className="grid gap-2 rounded-lg border border-[color:var(--color-border-light)] p-3">
        <Detail
          label="Context"
          value={
            details.mode === "bound"
              ? "Fixed for this chat"
              : details.mode === "legacy"
                ? "Historical chat"
                : "Not bound yet"
          }
        />
        <Detail label="Current load" value={loadLabel[details.loadStatus]} />
      </dl>
      {details.error ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {details.error}
        </p>
      ) : null}
      {details.loadStatus === "failed" && details.retry ? (
        <Button type="button" variant="outline" size="xs" onClick={onRetry} disabled={retryPending}>
          Retry Context load
        </Button>
      ) : null}
      {details.hasNewVersion ? (
        <p className="text-ui-sm text-muted-foreground">
          Saved Context has changed since this chat was created. A new chat will use the current
          version.
        </p>
      ) : null}
      {details.preview ? (
        <section className="space-y-2">
          <h3 className="text-ui-lg font-medium">Current project preview</h3>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[color:var(--color-border-light)] p-3 text-ui-sm">
            {details.preview.text || "No Context content"}
          </pre>
        </section>
      ) : null}
      {details.snapshot ? (
        <section className="space-y-2">
          <h3 className="text-ui-lg font-medium">Bound snapshot</h3>
          <p className="text-ui-sm text-muted-foreground">
            {details.snapshot.space ? `${details.snapshot.space.name} → ` : ""}
            {details.snapshot.project.title}
          </p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[color:var(--color-border-light)] p-3 text-ui-sm">
            {details.snapshot.text || "No Context content"}
          </pre>
        </section>
      ) : null}
      {details.mode === "unbound" && !details.preview ? (
        <p className="text-ui-sm text-muted-foreground">No Context preview is available.</p>
      ) : null}
      {details.mode === "legacy" ? (
        <p className="text-ui-sm text-muted-foreground">
          This chat keeps its historical instructions and notes. Start a new chat to use saved
          Context.
        </p>
      ) : null}
      <p className="text-ui-xs text-muted-foreground">Provider file instructions may also apply.</p>
      <EnvironmentCollapsibleSection label="Technical details" defaultOpen={false}>
        <dl className="grid gap-2 p-2">
          <Detail label="Binding" value={details.mode} />
          <Detail label="Load state" value={details.loadStatus} />
          {details.snapshot ? (
            <>
              <Detail label="Snapshot ID" value={details.snapshot.snapshotId} />
              <Detail label="Snapshot hash" value={details.snapshot.snapshotHash} />
              <Detail label="Bound at" value={details.snapshot.createdAt} />
              {details.snapshot.space ? (
                <Detail label="Space revision" value={String(details.snapshot.space.revision)} />
              ) : null}
              <Detail label="Project revision" value={String(details.snapshot.project.revision)} />
            </>
          ) : null}
          {details.preview ? (
            <Detail label="Preview hash" value={details.preview.snapshotHash} />
          ) : null}
          {details.applied ? (
            <>
              <Detail label="Applied provider" value={details.applied.provider} />
              <Detail label="Applied at" value={details.applied.appliedAt} />
              <Detail
                label="Session generation"
                value={String(details.applied.lifecycleGeneration)}
              />
              <Detail label="Base instructions hash" value={details.applied.baseInstructionsHash} />
            </>
          ) : null}
        </dl>
      </EnvironmentCollapsibleSection>
    </>
  );
}

const loadLabel: Record<ThreadContextDetailsDto["loadStatus"], string> = {
  absent: "No additional Context",
  pending: "Waiting to load",
  loaded: "Loaded",
  stopped: "Last loaded; runtime stopped",
  failed: "Loading failed",
  uncertain: "Execution needs confirmation",
};

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[12rem_minmax(0,1fr)]">
      <dt className="text-ui-sm text-muted-foreground">{label}</dt>
      <dd className="break-all text-ui-sm">{value}</dd>
    </div>
  );
}
