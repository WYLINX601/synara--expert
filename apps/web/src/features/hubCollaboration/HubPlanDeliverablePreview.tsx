import type { HubDeliverableReadResult, HubDeliverableReferenceMetadata } from "@synara/contracts";
import { useEffect, useRef, useState } from "react";

import { WorkspaceFilePreview } from "~/components/WorkspaceFilePreview";
import { Button } from "~/components/ui/button";
import { readHubPlanDeliverable } from "~/workbench/host/hubPlanClient";

type PreviewState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly result: HubDeliverableReadResult };

export function HubPlanDeliverablePreview(props: {
  readonly reference: HubDeliverableReferenceMetadata;
}) {
  const { reference } = props;
  const [state, setState] = useState<PreviewState>({ status: "idle" });
  const [open, setOpen] = useState(false);
  const readGenerationRef = useRef(0);
  const versionKey = [
    reference.hubId,
    reference.workerThreadId,
    reference.revision,
    reference.commitSha,
    reference.file.path,
  ].join(":");

  useEffect(
    () => () => {
      readGenerationRef.current += 1;
    },
    [],
  );

  const openPreview = async () => {
    if (state.status === "ready") {
      setOpen((current) => !current);
      return;
    }
    if (state.status === "loading") return;
    const requestGeneration = ++readGenerationRef.current;
    setState({ status: "loading" });
    try {
      const result = await readHubPlanDeliverable(reference);
      if (readGenerationRef.current !== requestGeneration) return;
      setState({ status: "ready", result });
      setOpen(true);
    } catch (cause) {
      if (readGenerationRef.current !== requestGeneration) return;
      setState({
        status: "error",
        message: cause instanceof Error ? cause.message : "无法读取固定版本成果。",
      });
    }
  };

  return (
    <div className="min-w-0 rounded-md border border-border/60 bg-background/60 px-2.5 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 truncate text-ui-sm font-medium" title={reference.file.path}>
          {reference.file.name}
        </span>
        <span className="min-w-0 truncate font-mono text-ui-xs text-muted-foreground">
          {reference.file.path}
        </span>
        <span className="shrink-0 text-ui-xs text-muted-foreground">v{reference.revision}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-auto shrink-0"
          disabled={state.status === "loading"}
          onClick={() => void openPreview()}
        >
          {state.status === "loading"
            ? "读取中…"
            : state.status === "ready" && open
              ? "收起预览"
              : "查看固定版本"}
        </Button>
      </div>
      {reference.file.description ? (
        <p className="mt-1 text-ui-xs text-muted-foreground">{reference.file.description}</p>
      ) : null}
      {state.status === "error" ? (
        <p className="mt-2 text-ui-sm text-destructive" role="alert">
          {state.message}
        </p>
      ) : null}
      {state.status === "ready" && open ? (
        <div className="mt-2 h-[min(32rem,55vh)] min-h-48 overflow-hidden rounded-md border border-border/60">
          <WorkspaceFilePreview
            key={versionKey}
            workspaceRoot={null}
            filePath={reference.file.path}
            markdownPreviewDefault
            editable={false}
            pinnedContent={state.result.content}
            pinnedMediaType={state.result.file.mediaType}
            pinnedVersionKey={versionKey}
          />
        </div>
      ) : null}
    </div>
  );
}
