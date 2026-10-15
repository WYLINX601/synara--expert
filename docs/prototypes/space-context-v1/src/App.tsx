import { useRef, useState, useSyncExternalStore } from "react";
import {
  IconAdjustments,
  IconChevronDown,
  IconFolder,
  IconLayoutSidebar,
  IconPlus,
  IconDots,
  IconX,
} from "@tabler/icons-react";
import { Button } from "synara-ui/components/ui/button";
import { Textarea } from "synara-ui/components/ui/textarea";
import { Menu, MenuItem, MenuTrigger } from "synara-ui/components/ui/menu";
import { ComposerPickerMenuPopup as MenuPopup } from "synara-ui/components/chat/ComposerPickerMenuPopup";
import {
  Sheet,
  SheetTrigger,
  SheetPopup,
  SheetTitle,
  SheetDescription,
} from "synara-ui/components/ui/sheet";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "synara-ui/components/ui/dialog";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsiblePanel,
} from "synara-ui/components/ui/collapsible";
import { DisclosureChevron } from "synara-ui/components/ui/DisclosureChevron";
import { SpaceSwitcher } from "synara-ui/components/SpaceSwitcher";
import { SpaceEditorDialog, type SpaceEditorValue } from "synara-ui/components/SpaceEditorDialog";
import { SidebarThreadRowContent } from "synara-ui/components/SidebarThreadRowContent";
import { ChatComposerFooter } from "synara-ui/components/chat/ChatComposerFooter";
import { ComposerExtrasTrigger } from "synara-ui/components/chat/ComposerExtrasTrigger";
import { ComposerExtrasPanel } from "synara-ui/components/chat/ComposerExtrasPanel";
import {
  EnvironmentPanelTitle,
  EnvironmentSectionDivider,
} from "synara-ui/components/chat/environment/EnvironmentRow";
import {
  ENVIRONMENT_PANEL_SURFACE_CLASS_NAME,
  COMPOSER_INPUT_SURFACE_CLASS_NAME,
  COMPOSER_COMMAND_MENU_FLOATING_WRAPPER_CLASS_NAME,
} from "synara-ui/components/chat/composerPickerStyles";
import { DEFAULT_VOID_SPACE, toSpaceIconName } from "synara-ui/lib/spaceGrouping";
import type { Space, SidebarThreadSummary } from "synara-ui/types";
import {
  ContextDemoAdapter,
  type DemoProject,
  type DemoProvider,
  type DemoSpace,
  type DemoThread,
} from "./ContextDemoAdapter";
import { ProjectContextAutosave } from "./ProjectContextAutosave";
import { ProjectContextEditor, SpaceContextDialog, type EditorHandle } from "./ContextEditor";
import { ContextDetails } from "./ContextDetails";
import { MigrationDialog } from "./MigrationDialog";
import { useDemoAppearance } from "./appearance";
import { blockedRequests } from "./networkBoundary";

const adapter = new ContextDemoAdapter();
const IDLE_VOICE = {
  enabled: false,
  recording: false,
  transcribing: false,
  durationLabel: "",
  waveformLevels: [],
  onCancel: () => undefined,
  onSubmit: () => undefined,
  onToggle: () => undefined,
};

// The independent fixture supplies only presentation data to the native row.
function threadSummary(thread: DemoThread): SidebarThreadSummary {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: { provider: thread.provider, model: "demo" },
    session: null,
    latestTurn: null,
    archivedAt: null,
    parentThreadId: null,
    error: null,
  } as unknown as SidebarThreadSummary;
}

export function App() {
  const state = useSyncExternalStore(adapter.subscribe, adapter.getState);
  const appearance = useDemoAppearance();
  const [spaceId, setSpaceId] = useState<string | null>("research");
  const [projectId, setProjectId] = useState<string | null>("thesis");
  const [threadId, setThreadId] = useState("thread-thesis-new");
  const [expandedProjects, setExpandedProjects] = useState(
    new Set(state.projects.map((item) => item.id)),
  );
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  const [extrasOpen, setExtrasOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [migrationOpen, setMigrationOpen] = useState(false);
  const [editSpaceId, setEditSpaceId] = useState<string | null>(null);
  const [metadataEditor, setMetadataEditor] = useState<"create" | "void" | null>(null);
  const [deleteSpace, setDeleteSpace] = useState<DemoSpace | null>(null);
  const [voidSpace, setVoidSpace] = useState(DEFAULT_VOID_SPACE);
  const [prompt, setPrompt] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const controllers = useRef(new Map<string, ProjectContextAutosave>());
  const rememberedSpaces = useRef(
    new Map<string | null, { projectId: string; threadId: string }>(),
  );
  const rememberedThreads = useRef(new Map<string, string>());
  const projectEditor = useRef<EditorHandle>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const composerControls = useRef<HTMLDivElement>(null);
  const environmentTrigger = useRef<HTMLButtonElement>(null);
  const mobileNavFocus = useRef<HTMLButtonElement>(null);
  const migrationFocus = useRef<HTMLButtonElement | null>(null);
  const spaceFocus = useRef<HTMLElement | null>(null);
  const currentSpace = state.spaces.find((item) => item.id === spaceId);
  const project = state.projects.find((item) => item.id === projectId);
  const projectSpace = state.spaces.find((item) => item.id === project?.spaceId);
  const thread = state.threads.find((item) => item.id === threadId && item.projectId === projectId);
  const editedSpace = state.spaces.find((item) => item.id === editSpaceId);
  const shownProjects = state.projects.filter((item) => item.spaceId === spaceId);
  const migrationPending = state.migrations.some(
    (item) => item.projectId === projectId && item.status !== "completed",
  );
  const failed = thread?.applied.status === "failed";
  const stale = thread ? adapter.isStale(thread.id) : false;
  const controllerFor = (item: DemoProject) => {
    let controller = controllers.current.get(item.id);
    if (!controller) {
      controller = new ProjectContextAutosave({
        projectId: item.id,
        initial: item.context,
        save: (id, fields, revision) => adapter.saveContext("project", id, fields, revision),
        read: (id) => adapter.getProjectContext(id),
      });
      controllers.current.set(item.id, controller);
    }
    return controller;
  };
  const canLeave = async () => {
    if (transitioning || sending || editSpaceId) return false;
    setTransitioning(true);
    try {
      return await (projectEditor.current?.confirmLeave() ?? Promise.resolve(true));
    } finally {
      setTransitioning(false);
    }
  };
  const rememberCurrent = () => {
    if (!project || !thread) return;
    rememberedSpaces.current.set(spaceId, { projectId: project.id, threadId: thread.id });
    rememberedThreads.current.set(project.id, thread.id);
  };
  const activateProject = (item: DemoProject, preferredThread?: string) => {
    const remembered =
      preferredThread ??
      (item.id === projectId ? threadId : rememberedThreads.current.get(item.id));
    setProjectId(item.id);
    setSpaceId(item.spaceId);
    setThreadId(
      state.threads.find((value) => value.projectId === item.id && value.id === remembered)?.id ??
        state.threads.find((value) => value.projectId === item.id)?.id ??
        adapter.createThread(item.id),
    );
    setExpandedProjects((previous) => new Set([...previous, item.id]));
    setPrompt("");
    setNotice(null);
    setExtrasOpen(false);
    setDetailsOpen(false);
    setMobileNav(false);
  };
  const selectProject = async (item: DemoProject, selectedThread?: string) => {
    if (item.id === projectId) {
      if (transitioning || sending || editSpaceId) return;
    } else if (!(await canLeave())) return;
    rememberCurrent();
    activateProject(item, selectedThread);
  };
  const selectSpace = async (id: string | null) => {
    if (id === spaceId || !(await canLeave())) return;
    rememberCurrent();
    const remembered = rememberedSpaces.current.get(id);
    const item =
      state.projects.find((value) => value.spaceId === id && value.id === remembered?.projectId) ??
      state.projects.find((value) => value.spaceId === id);
    if (item) activateProject(item, remembered?.threadId);
    else {
      setSpaceId(id);
      setProjectId(null);
      setThreadId("");
      setPrompt("");
      setNotice(null);
      setEnvironmentOpen(false);
      setMobileNav(false);
    }
  };
  const newThread = async (item = project) => {
    if (!item) return;
    if (item.id === projectId) {
      if (transitioning || sending || editSpaceId) return;
    } else if (!(await canLeave())) return;
    rememberCurrent();
    const id = adapter.createThread(item.id, thread?.provider === "pi" ? "pi" : "codex");
    setSpaceId(item.spaceId);
    setProjectId(item.id);
    setThreadId(id);
    setExpandedProjects((previous) => new Set([...previous, item.id]));
    setPrompt("");
    setNotice(null);
    setDetailsOpen(false);
    setExtrasOpen(false);
    setMobileNav(false);
    requestAnimationFrame(() => composer.current?.focus());
  };
  const toggleEnvironment = async () => {
    if (environmentOpen && !(await canLeave())) return;
    setEnvironmentOpen(!environmentOpen);
  };
  const send = async () => {
    if (!thread || !prompt.trim() || sending || extrasOpen || failed) return;
    const id = thread.id;
    const value = prompt;
    setSending(true);
    setNotice(null);
    try {
      await adapter.send(id, value);
      setPrompt("");
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "发送未完成。");
      if (adapter.getState().threads.find((item) => item.id === id)?.mode === "bound")
        setPrompt("");
    } finally {
      setSending(false);
    }
  };
  const retry = async () => {
    if (!thread || sending) return;
    setSending(true);
    setNotice(null);
    try {
      await adapter.retryLoad(thread.id);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "加载未完成。");
    } finally {
      setSending(false);
    }
  };
  const showMigration = (element: HTMLButtonElement) => {
    migrationFocus.current = mobileNav ? mobileNavFocus.current : element;
    setMobileNav(false);
    setMigrationOpen(true);
  };
  const reset = async () => {
    if (!(await canLeave())) return;
    for (const controller of controllers.current.values()) controller.dispose();
    controllers.current.clear();
    rememberedSpaces.current.clear();
    rememberedThreads.current.clear();
    adapter.reset();
    setSpaceId("research");
    setProjectId("thesis");
    setThreadId("thread-thesis-new");
    setExpandedProjects(new Set(adapter.getState().projects.map((item) => item.id)));
    setEnvironmentOpen(false);
    setPrompt("");
    setNotice(null);
    setExtrasOpen(false);
    setDetailsOpen(false);
    setResetKey((value) => value + 1);
  };
  const uiSpaces: Space[] = state.spaces.map((item) => ({
    id: item.id as Space["id"],
    name: item.name,
    icon: item.icon as Space["icon"],
    sortOrder: item.sortOrder,
    createdAt: "2026-10-13T00:00:00.000Z",
    updatedAt: "2026-10-13T00:00:00.000Z",
  }));
  const metadataSubmit = async (value: SpaceEditorValue) => {
    if (metadataEditor === "void") setVoidSpace({ name: value.name, icon: value.icon });
    else {
      if (!(await canLeave())) throw new Error("项目更改尚未确认，请保留或处理草稿后继续。");
      const id = adapter.createSpace(value.name, toSpaceIconName(value.icon));
      rememberCurrent();
      setSpaceId(id);
      setProjectId(null);
      setThreadId("");
      setEnvironmentOpen(false);
    }
  };
  const returnToPlus = () =>
    composerControls.current?.querySelector<HTMLButtonElement>("[data-composer-extras-trigger]") ??
    null;
  const returnToSpace = () =>
    spaceFocus.current?.isConnected
      ? spaceFocus.current
      : environmentOpen
        ? (document.querySelector<HTMLButtonElement>("[data-edit-space]") ??
          environmentTrigger.current)
        : window.matchMedia("(max-width: 720px)").matches
          ? mobileNavFocus.current
          : document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
  const changeProvider = (provider: DemoProvider) => {
    if (!thread) return;
    try {
      adapter.setThreadProvider(thread.id, provider);
      setNotice(null);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "无法切换运行配置。");
    }
  };

  const sidebar = (
    <div className="demo-sidebar-content flex h-full min-h-0 flex-col" aria-label="工作区导航">
      <div className="flex items-center gap-2 px-3 pt-4 pb-3">
        <img src="/synara-logo.svg" alt="Synara" className="size-5" />
        <span className="flex-1 text-ui font-semibold">Synara</span>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="新建对话"
          disabled={!project || transitioning}
          onClick={() => void newThread()}
        >
          <IconPlus className="size-4" />
        </Button>
      </div>
      <div className="px-2">
        <SpaceSwitcher
          spaces={uiSpaces}
          activeSpaceId={spaceId as Space["id"] | null}
          activityBySpaceId={new Map()}
          voidSpace={voidSpace}
          onSelect={(id) => void selectSpace(id)}
          onCreate={() =>
            void (async () => {
              if (await canLeave()) setMetadataEditor("create");
            })()
          }
          onEdit={(item) => {
            spaceFocus.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
            setEditSpaceId(item.id);
            setMobileNav(false);
          }}
          onDelete={(item) =>
            setDeleteSpace(state.spaces.find((value) => value.id === item.id) ?? null)
          }
          onReorder={(ids) => adapter.reorderSpaces([...ids])}
          onRenameSpace={(item, name) => adapter.renameSpace(item.id, name)}
          onEditVoid={() => setMetadataEditor("void")}
          onRenameVoid={(name) => setVoidSpace((value) => ({ ...value, name }))}
          onResetVoid={() => setVoidSpace(DEFAULT_VOID_SPACE)}
          onDropProject={() => undefined}
        />
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pt-3" aria-label="项目与对话">
        {shownProjects.map((item) => (
          <Collapsible
            key={item.id}
            open={expandedProjects.has(item.id)}
            onOpenChange={(open) =>
              setExpandedProjects((previous) => {
                const value = new Set(previous);
                if (open) value.add(item.id);
                else value.delete(item.id);
                return value;
              })
            }
            className="mb-1"
          >
            <div className="group flex h-8 items-center gap-1 rounded-lg px-1">
              <CollapsibleTrigger
                className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground"
                aria-label={`${expandedProjects.has(item.id) ? "收起" : "展开"}${item.name}`}
              >
                <DisclosureChevron open={expandedProjects.has(item.id)} className="size-3" />
              </CollapsibleTrigger>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="min-w-0 flex-1 justify-start gap-2 px-1 font-normal text-ui"
                onClick={() => void selectProject(item)}
              >
                <IconFolder className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{item.name}</span>
              </Button>
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`${item.name}操作`}
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    />
                  }
                >
                  <IconDots className="size-3.5" />
                </MenuTrigger>
                <MenuPopup>
                  <MenuItem onClick={() => void newThread(item)}>新建对话</MenuItem>
                </MenuPopup>
              </Menu>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={`在${item.name}新建对话`}
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                onClick={() => void newThread(item)}
              >
                <IconPlus className="size-3.5" />
              </Button>
            </div>
            <CollapsiblePanel>
              <div className="space-y-0.5 pb-1 pl-5">
                {state.threads
                  .filter((value) => value.projectId === item.id)
                  .toReversed()
                  .map((value) => (
                    <Button
                      key={value.id}
                      type="button"
                      size="sm"
                      variant="ghost"
                      className={`w-full justify-start gap-1.5 px-2 font-normal ${threadId === value.id ? "bg-sidebar-selected" : ""}`}
                      aria-label={value.title}
                      aria-current={threadId === value.id ? "page" : undefined}
                      onClick={() => void selectProject(item, value.id)}
                    >
                      <SidebarThreadRowContent
                        thread={threadSummary(value)}
                        terminalEntryPoint={false}
                        terminalStatus={null}
                        terminalCount={0}
                        isActive={threadId === value.id}
                        variant="standard"
                      />
                    </Button>
                  ))}
              </div>
            </CollapsiblePanel>
          </Collapsible>
        ))}
        {!shownProjects.length && (
          <p className="px-3 py-3 text-ui-sm text-muted-foreground">这个 Space 还没有项目。</p>
        )}
      </nav>
      <div className="border-t border-border/60 p-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full justify-start text-ui-sm text-muted-foreground"
          aria-expanded={reviewOpen}
          onClick={() => setReviewOpen((value) => !value)}
        >
          <IconAdjustments className="size-4" />
          审核工具
        </Button>
        <p className="px-2 pt-1 text-ui-xs text-muted-foreground">交互原型 · 演示数据</p>
      </div>
    </div>
  );

  return (
    <div className="demo-app text-ui">
      <aside className="demo-sidebar border-r border-border bg-sidebar text-sidebar-foreground">
        {sidebar}
      </aside>
      <main className="demo-main min-w-0">
        <header className="demo-header flex min-w-0 items-center gap-2 px-4">
          <Sheet open={mobileNav} onOpenChange={setMobileNav}>
            <SheetTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className="demo-mobile-nav"
                  ref={mobileNavFocus}
                  aria-label="展开导航"
                />
              }
            >
              <IconLayoutSidebar className="size-4" />
            </SheetTrigger>
            <SheetPopup side="left" className="max-w-xs p-0" showCloseButton={false}>
              <SheetTitle className="sr-only">工作区导航</SheetTitle>
              <SheetDescription className="sr-only">切换 Space、项目和对话。</SheetDescription>
              {sidebar}
            </SheetPopup>
          </Sheet>
          <span className="min-w-0 flex-1 truncate text-ui text-muted-foreground">
            {thread?.title ?? currentSpace?.name ?? voidSpace.name}
          </span>
          {project && (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              ref={environmentTrigger}
              aria-label="Environment"
              aria-expanded={environmentOpen}
              onClick={() => void toggleEnvironment()}
            >
              <IconFolder className="size-4" />
            </Button>
          )}
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="demo-mobile-review"
            aria-label="审核工具"
            onClick={() => setReviewOpen((value) => !value)}
          >
            <IconAdjustments className="size-4" />
          </Button>
        </header>
        <div className="demo-chat-layout">
          <div className="demo-chat-content min-w-0">
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6" aria-label="对话内容">
              <div className="mx-auto max-w-[var(--app-chat-max-width,46rem)]">
                {thread?.messages.length ? (
                  <div className="space-y-6">
                    {thread.messages.map((message) => (
                      <div
                        key={message.id}
                        className={message.role === "user" ? "flex justify-end" : ""}
                      >
                        <div
                          className={
                            message.role === "user"
                              ? "max-w-[85%] rounded-2xl bg-[var(--app-user-message-background)] px-4 py-2.5"
                              : ""
                          }
                        >
                          <p className="whitespace-pre-wrap break-words text-chat leading-relaxed">
                            {message.text}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="demo-empty flex items-center justify-center">
                    <span className="text-ui-lg text-muted-foreground/65">
                      {project ? "开始一个新对话" : "选择项目，开始工作"}
                    </span>
                  </div>
                )}
              </div>
            </div>
            {thread && project && (
              <div className="px-4 pb-5 sm:px-6">
                <div className="relative mx-auto max-w-[var(--app-chat-max-width,46rem)]">
                  {(failed || notice) && (
                    <div
                      role="alert"
                      className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-destructive/20 px-3 py-2 text-ui-sm"
                      data-testid="conversation-error"
                    >
                      <span className="min-w-0 flex-1 text-destructive">
                        {failed ? "上下文加载失败，消息尚未执行。" : notice}
                      </span>
                      {failed ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={sending}
                          onClick={() => void retry()}
                        >
                          按原上下文重试
                        </Button>
                      ) : migrationPending ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          onClick={(event) => showMigration(event.currentTarget)}
                        >
                          处理旧指令
                        </Button>
                      ) : null}
                    </div>
                  )}
                  {extrasOpen && (
                    <div className={COMPOSER_COMMAND_MENU_FLOATING_WRAPPER_CLASS_NAME}>
                      <ComposerExtrasPanel
                        panelId="prototype-composer-extras"
                        interactionMode="default"
                        supportsFastMode={false}
                        fastModeEnabled={false}
                        onAddAttachments={() =>
                          setNotice("此原型只演示 Context 交互，附件未发送。")
                        }
                        onToggleFastMode={() => undefined}
                        onInteractionModeChange={() => setNotice("演示中保持当前运行方式。")}
                        onInsertGoal={() => {
                          setPrompt("/goal ");
                          composer.current?.focus();
                        }}
                        onClose={() => setExtrasOpen(false)}
                        onViewContext={() => setDetailsOpen(true)}
                      />
                    </div>
                  )}
                  <form
                    className={`${COMPOSER_INPUT_SURFACE_CLASS_NAME} rounded-2xl p-3`}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void send();
                    }}
                  >
                    <Textarea
                      ref={composer}
                      unstyled
                      rows={3}
                      value={prompt}
                      aria-label="输入消息"
                      placeholder="输入消息…"
                      className="w-full resize-none text-chat leading-relaxed"
                      disabled={sending || failed}
                      onChange={(event) => setPrompt(event.target.value)}
                      onKeyDown={(event) => {
                        if (
                          event.key === "Enter" &&
                          !event.shiftKey &&
                          !event.nativeEvent.isComposing &&
                          !extrasOpen
                        ) {
                          event.preventDefault();
                          void send();
                        }
                      }}
                    />
                    <div ref={composerControls}>
                      <ChatComposerFooter
                        isComposerFooterCompact
                        leadingControls={
                          <ComposerExtrasTrigger
                            open={extrasOpen}
                            panelId="prototype-composer-extras"
                            onToggle={() => setExtrasOpen((value) => !value)}
                          />
                        }
                        contextMeter={null}
                        composerPickerControls={
                          <Menu>
                            <MenuTrigger
                              render={
                                <Button
                                  type="button"
                                  size="chip"
                                  variant="ghost"
                                  aria-label="选择提供方"
                                  disabled={thread.mode !== "new"}
                                />
                              }
                            >
                              <span>
                                {thread.provider === "pi"
                                  ? "Pi"
                                  : thread.provider === "claude"
                                    ? "Claude"
                                    : "Codex"}
                              </span>
                              <IconChevronDown className="size-3 text-muted-foreground" />
                            </MenuTrigger>
                            <MenuPopup>
                              {(["codex", "pi", "claude"] as const).map((provider) => (
                                <MenuItem key={provider} onClick={() => changeProvider(provider)}>
                                  {provider === "pi"
                                    ? "Pi"
                                    : provider === "claude"
                                      ? "Claude"
                                      : "Codex"}
                                </MenuItem>
                              ))}
                            </MenuPopup>
                          </Menu>
                        }
                        interactionMode="default"
                        resetInteractionMode={() => undefined}
                        sidebarAction={null}
                        voice={IDLE_VOICE}
                        pendingInput={null}
                        submission={{
                          phase: "ready",
                          busy: sending,
                          connecting: false,
                          expired: false,
                          preparingImages: false,
                          preparingWorktree: false,
                          hasContent: !!prompt.trim(),
                          hasPendingUserInputs: false,
                          showPlanFollowUp: false,
                          hasPrompt: !!prompt.trim(),
                          onInterrupt: () => undefined,
                          onImplementInNewThread: () => undefined,
                        }}
                      />
                    </div>
                  </form>
                </div>
              </div>
            )}
          </div>
          {project && (
            <aside
              className={`demo-environment ${ENVIRONMENT_PANEL_SURFACE_CLASS_NAME}`}
              data-open={environmentOpen}
              aria-label="Environment 面板"
            >
              <div className="flex items-center justify-between px-3 pt-2">
                <EnvironmentPanelTitle>Environment</EnvironmentPanelTitle>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label="关闭 Environment"
                  onClick={() => void toggleEnvironment()}
                >
                  <IconX className="size-3.5" />
                </Button>
              </div>
              <div className="px-2 pb-3">
                <div className="px-2 py-2 text-ui-sm text-muted-foreground">{project.name}</div>
                <EnvironmentSectionDivider />
                <ProjectContextEditor
                  key={`${resetKey}:${project.id}`}
                  ref={projectEditor}
                  controller={controllerFor(project)}
                  project={project}
                  space={projectSpace}
                  onEditSpace={(element) => {
                    if (projectSpace) {
                      spaceFocus.current = element;
                      setEditSpaceId(projectSpace.id);
                    }
                  }}
                />
                {migrationPending && (
                  <div className="mt-2 border-t border-border/60 px-2 pt-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="-ml-1"
                      onClick={(event) => showMigration(event.currentTarget)}
                    >
                      处理旧项目指令
                    </Button>
                  </div>
                )}
              </div>
            </aside>
          )}
        </div>
      </main>
      {editedSpace && (
        <SpaceContextDialog
          key={editedSpace.id}
          adapter={adapter}
          space={editedSpace}
          open
          finalFocus={returnToSpace}
          onOpenChange={(open) => {
            if (!open) setEditSpaceId(null);
          }}
          existingNames={[
            voidSpace.name,
            ...state.spaces.filter((item) => item.id !== editedSpace.id).map((item) => item.name),
          ]}
        />
      )}
      <SpaceEditorDialog
        open={metadataEditor !== null}
        mode={metadataEditor ?? "create"}
        initialValue={metadataEditor === "void" ? voidSpace : undefined}
        existingNames={[
          ...(metadataEditor === "void" ? [] : [voidSpace.name]),
          ...state.spaces.map((item) => item.name),
        ]}
        onOpenChange={(open) => {
          if (!open) setMetadataEditor(null);
        }}
        onSubmit={metadataSubmit}
      />
      <Dialog
        open={deleteSpace !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteSpace(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>删除 {deleteSpace?.name}？</DialogTitle>
            <DialogDescription>项目回到未归档分组，已有对话保留原上下文。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setDeleteSpace(null)}>
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                if (!deleteSpace) return;
                const id = deleteSpace.id;
                adapter.deleteSpace(id);
                setDeleteSpace(null);
                if (id === spaceId) {
                  setSpaceId(null);
                  if (!project) {
                    setProjectId(null);
                    setThreadId("");
                  }
                }
              }}
            >
              删除 Space
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      {thread && project && (
        <ContextDetails
          open={detailsOpen}
          onOpenChange={setDetailsOpen}
          thread={thread}
          project={project}
          space={projectSpace}
          stale={stale}
          onNewThread={() => void newThread()}
          onRetry={() => void retry()}
          onReturnFocus={returnToPlus}
        />
      )}
      <MigrationDialog
        adapter={adapter}
        state={state}
        open={migrationOpen}
        onOpenChange={(open) => {
          if (!open && !migrationPending && notice?.includes("旧指令迁移")) setNotice(null);
          if (!open && !migrationFocus.current?.isConnected)
            migrationFocus.current = environmentOpen ? environmentTrigger.current : returnToPlus();
          setMigrationOpen(open);
        }}
        finalFocus={migrationFocus}
      />
      <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
        <DialogPopup className="max-w-md" data-testid="review-tools">
          <DialogHeader>
            <DialogTitle>审核工具</DialogTitle>
            <DialogDescription>仅调整演示条件，刷新可重置。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 px-5 pb-4">
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" onClick={appearance.toggleTheme}>
                {appearance.theme === "light" ? "深色主题" : "浅色主题"}
              </Button>
              {[11, 13, 16, 18].map((size) => (
                <Button
                  type="button"
                  key={size}
                  size="sm"
                  variant={appearance.fontSize === size ? "outline" : "ghost"}
                  aria-pressed={appearance.fontSize === size}
                  onClick={() => appearance.setFontSize(size)}
                >
                  {size}px
                </Button>
              ))}
            </div>
            <fieldset className="space-y-2">
              <legend className="text-ui-sm">下次保存</legend>
              <div className="flex flex-wrap gap-2">
                {(["normal", "failure", "conflict"] as const).map((mode) => (
                  <Button
                    type="button"
                    key={mode}
                    size="sm"
                    variant={state.nextSave === mode ? "outline" : "ghost"}
                    aria-pressed={state.nextSave === mode}
                    onClick={() => adapter.setNextSave(mode)}
                  >
                    {mode === "normal" ? "正常" : mode === "failure" ? "保存失败" : "版本冲突"}
                  </Button>
                ))}
              </div>
              <Button
                type="button"
                size="sm"
                variant={state.nextSaveAckLost ? "outline" : "ghost"}
                aria-pressed={state.nextSaveAckLost}
                onClick={() => adapter.setNextSaveAckLost(!state.nextSaveAckLost)}
              >
                保存响应丢失
              </Button>
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="text-ui-sm">下次加载</legend>
              <div className="flex gap-2">
                {(["normal", "failure"] as const).map((mode) => (
                  <Button
                    type="button"
                    key={mode}
                    size="sm"
                    variant={state.nextLoad === mode ? "outline" : "ghost"}
                    aria-pressed={state.nextLoad === mode}
                    onClick={() => adapter.setNextLoad(mode)}
                  >
                    {mode === "normal" ? "正常加载" : "加载失败"}
                  </Button>
                ))}
              </div>
            </fieldset>
            <p className="text-ui-xs text-muted-foreground">
              被阻止的业务请求：{blockedRequests.length}。所有配置和回复均为演示数据。
            </p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={sending}
              onClick={() => void reset()}
            >
              重置演示
            </Button>
            <Button type="button" size="sm" onClick={() => setReviewOpen(false)}>
              完成
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
