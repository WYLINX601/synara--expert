// Host adapter: Expert starts a native draft; only the original composer can send it.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { ThreadId, type ProjectId } from "@synara/contracts";
import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useStore } from "~/store";
import { resolveInheritedThreadContext } from "~/lib/threadBootstrap";
import { ProjectMenuPicker } from "~/components/ProjectMenuPicker";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "~/components/ui/dialog";
import { ensureExpertClient } from "./expertClient";

export function useExpertTaskActions(projectContext?: string, sourceThreadId?: string) {
  const router = useRouter();
  const native = useHandleNewThread();
  const [choosing, setChoosing] = useState(false);
  const choiceRef = useRef<((projectId: ProjectId | null) => void) | null>(null);
  const requestRef = useRef<Promise<void> | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      choiceRef.current?.(null);
      choiceRef.current = null;
    };
  }, []);
  const choose = (projectId: ProjectId | null) => {
    choiceRef.current?.(projectId);
    choiceRef.current = null;
    setChoosing(false);
  };
  const startExpertDraft = (expertId: string): Promise<void> => {
    if (requestRef.current) return requestRef.current;
    const pathname = router.state.location.pathname;
    const locationKey = router.state.location.href;
    const operation = (async () => {
      if (!useStore.getState().threadsHydrated) throw new Error("任务信息尚未就绪，请稍后重试。");
      const projects = useStore.getState().projects;
      let projectId =
        projects.find((project) => project.id === projectContext)?.id ?? native.activeProjectId;
      if (!projectId) {
        if (!projects.length) throw new Error("请先创建项目，再使用此专家。");
        projectId = await new Promise<ProjectId | null>((resolve) => {
          choiceRef.current = resolve;
          setChoosing(true);
        });
      }
      if (!projectId || router.state.location.href !== locationKey) return;
      const client = ensureExpertClient();
      const expert = await client.readExpert({ id: expertId });
      if (client !== ensureExpertClient() || router.state.location.href !== locationKey) return;
      if (!expert || expert.archived) throw new Error("该专家已归档或不可用，请刷新后重试。");
      if (!useStore.getState().projects.some((project) => project.id === projectId))
        throw new Error("项目已不可用，请重新选择。");
      const sourceId = sourceThreadId ? ThreadId.makeUnsafe(sourceThreadId) : null;
      const sourceDraft = sourceId
        ? useComposerDraftStore.getState().getDraftThread(sourceId)
        : null;
      const sourceThread = sourceId ? useStore.getState().threadShellById?.[sourceId] : null;
      const inherited =
        sourceDraft?.projectId === projectId
          ? resolveInheritedThreadContext({ activeDraftThread: sourceDraft, activeThread: null })
          : sourceThread?.projectId === projectId
            ? resolveInheritedThreadContext({ activeDraftThread: null, activeThread: sourceThread })
            : native.activeProjectId === projectId
              ? resolveInheritedThreadContext(native)
              : {};
      const threadId = await native.handleNewThread(
        projectId,
        { ...inherited, standalone: true, expertId },
        {
          isCurrent: () =>
            mountedRef.current &&
            client === ensureExpertClient() &&
            router.state.location.href === locationKey,
        },
      );
      if (!threadId && router.state.location.pathname === pathname)
        throw new Error("未能打开任务草稿，请重试。");
    })();
    requestRef.current = operation;
    void operation.then(
      () => {
        requestRef.current = null;
      },
      () => {
        requestRef.current = null;
      },
    );
    return operation;
  };
  return {
    startExpertDraft,
    projectPicker: (
      <Dialog
        open={choosing}
        onOpenChange={(open) => {
          if (!open) choose(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>选择任务项目</DialogTitle>
            <DialogDescription>选定项目后进入原有任务草稿，发送消息才开始执行。</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <ProjectMenuPicker
              projectOptions={native.projects}
              selectedProjectId={null}
              onProjectIdChange={choose}
              trigger={<Button variant="outline" aria-label="选择任务项目" />}
            >
              选择项目
            </ProjectMenuPicker>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    ),
  };
}
