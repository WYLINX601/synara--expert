import "../../../index.css";

import {
  ProjectId,
  SpaceId,
  ThreadId,
  WS_CONTEXT_V1_CAPABILITY,
  WS_METHODS,
  type ProjectContextSettings,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

// Exercise the existing nativeApi -> wsNativeApi capability event subscription. Only the
// transport boundary is simulated; consumers never receive a mocked boolean capability.
const transportHarness = vi.hoisted(() => ({
  capabilities: null as ReadonlyArray<string> | null,
  sessionVersion: 1,
  state: "open" as "open" | "connecting" | "closed",
  stateListeners: new Set<() => void>(),
  listeners: new Set<() => void>(),
  request: vi.fn(),
}));
vi.mock("~/wsTransport", () => ({
  WsTransport: class {
    private disposed = false;
    getCompatibility() {
      return transportHarness.capabilities === null
        ? null
        : { capabilities: transportHarness.capabilities };
    }
    onCompatibilityChange(listener: (value: unknown) => void) {
      const update = () => listener(this.getCompatibility());
      transportHarness.listeners.add(update);
      return () => transportHarness.listeners.delete(update);
    }
    request = transportHarness.request;
    getState() {
      return this.disposed ? "disposed" : transportHarness.state;
    }
    getSessionVersion() {
      return transportHarness.sessionVersion;
    }
    getLatestPush() {
      return null;
    }
    subscribe() {
      return () => undefined;
    }
    onStateChange(listener: (state: string) => void) {
      const update = () => listener(this.getState());
      transportHarness.stateListeners.add(update);
      return () => transportHarness.stateListeners.delete(update);
    }
    onCompatibilityIssue() {
      return () => undefined;
    }
    onShellStreamFailure() {
      return () => undefined;
    }
    onThreadStreamFailure() {
      return () => undefined;
    }
    dispose() {
      this.disposed = true;
    }
  },
}));

import { useSpacesController } from "~/components/useSpacesController";
import { SpaceContextFieldsEditor } from "~/components/SpaceContextFieldsEditor";
import { readNativeApi } from "~/nativeApi";
import { resetWsNativeApiForTest } from "~/wsNativeApi";
import { useProjectInstructionsStore } from "~/projectInstructionsStore";
import { useExpertDraftGuard } from "~/components/settings/useExpertDraftGuard";
import { EnvironmentProjectInstructionsSection } from "./EnvironmentProjectInstructionsSection";
import {
  useProjectContextAutosave,
  type ProjectContextController,
} from "./useProjectContextAutosave";
import { useProjectContextMigration } from "./useProjectContextMigration";

const projectId = ProjectId.makeUnsafe("capability-project");
const otherProjectId = ProjectId.makeUnsafe("capability-other-project");
const threadId = ThreadId.makeUnsafe("capability-thread");
let server = settings();
let current: ProjectContextController | null = null;
let readHold: Promise<ProjectContextSettings> | null = null;
let saveHold: Promise<void> | null = null;
const agentWrite = vi.fn();

function settings(overrides: Partial<ProjectContextSettings> = {}): ProjectContextSettings {
  return {
    dataInstanceId: "instance-a",
    projectId,
    title: "Project",
    workspaceRoot: "/project",
    spaceId: null,
    projectGoal: "saved goal",
    projectInstructions: "saved Context instructions",
    revision: 0,
    inherited: null,
    migration: null,
    ...overrides,
  };
}
function capabilities(value: ReadonlyArray<string> | null) {
  if (transportHarness.capabilities !== value) transportHarness.sessionVersion += 1;
  transportHarness.capabilities = value;
  for (const listener of transportHarness.listeners) listener();
}
function Harness() {
  const [target, setTarget] = useState(projectId);
  const context = useProjectContextAutosave(target, true);
  current = context;
  const guard = useExpertDraftGuard({
    isDirty: context.state?.pending ?? false,
    canSave: context.available,
    onSave: () => context.controller?.flush() ?? Promise.resolve(false),
    onDiscard: context.discard,
  });
  const migration = useProjectContextMigration({
    projectId: target,
    threadId,
    localProjectName: "Project",
    localWorkspaceRoot: "/project",
    isLocalDraft: true,
    hasPendingContextDraft: context.state?.pending ?? false,
    hasDetachedContextDraft: context.detached,
    contextDataInstanceId: context.state?.base.dataInstanceId ?? null,
  });
  const [sent, setSent] = useState("waiting");
  return (
    <>
      <p data-testid="context-owner">{context.ownsContext ? "Context owner" : "Agent owner"}</p>
      <p data-testid="dirty">{context.state?.dirty ? "dirty" : "clean"}</p>
      <button onClick={() => void guard.confirmLeave()}>Attempt leave</button>
      <button onClick={() => void context.discard()}>Discard Context</button>
      <button onClick={() => void context.reload()}>Reload Context</button>
      <button onClick={() => setTarget(otherProjectId)}>Switch project</button>
      <button
        onClick={() =>
          void migration.beforeFirstSend().then((allowed) => setSent(allowed ? "sent" : "blocked"))
        }
      >
        First send
      </button>
      <p>{sent}</p>
      <EnvironmentProjectInstructionsSection
        projectId={target}
        instructions="Agent document"
        threadNotes=""
        canCopyToThreadNotes
        onInstructionsChange={agentWrite}
        onCopyToThreadNotes={() => undefined}
        {...(context.ownsContext
          ? {
              controlledContext: {
                goal: context.state?.draft.projectGoal ?? "",
                instructions: context.state?.draft.projectInstructions ?? "",
                onGoalChange: (goal: string) =>
                  context.controller?.setDraft({
                    projectGoal: goal,
                    projectInstructions: context.state?.draft.projectInstructions ?? "",
                  }),
                onInstructionsChange: (instructions: string) =>
                  context.controller?.setDraft({
                    projectGoal: context.state?.draft.projectGoal ?? "",
                    projectInstructions: instructions,
                  }),
                disabled: !context.available || !context.state,
                copyDisabled: !context.available || !context.state || context.state.dirty,
              },
            }
          : {})}
      />
      {guard.dialog}
      {migration.dialog}
    </>
  );
}
async function mount(Component = Harness) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <Component />
        <button onClick={() => void router.navigate({ to: "/settings" })}>Route away</button>
        <Outlet />
      </QueryClientProvider>
    ),
  });
  const route = createRoute({ getParentRoute: () => root, path: "/", component: () => null });
  const next = createRoute({
    getParentRoute: () => root,
    path: "/settings",
    component: () => <p>Route destination</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([route, next]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = await render(<RouterProvider router={router} />);
  const trigger = Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent === "Project instructions",
  );
  if (trigger?.getAttribute("aria-expanded") === "false") {
    await page.getByRole("button", { name: "Project instructions", exact: true }).click();
  }
  return async () => {
    await view.unmount();
    await queryClient.cancelQueries();
    queryClient.clear();
  };
}
let close: (() => Promise<void>) | null = null;
beforeEach(async () => {
  Reflect.deleteProperty(window, "nativeApi");
  await resetWsNativeApiForTest();
  transportHarness.listeners.clear();
  transportHarness.capabilities = null;
  transportHarness.state = "open";
  transportHarness.sessionVersion = 1;
  transportHarness.stateListeners.clear();
  server = settings();
  readHold = null;
  saveHold = null;
  current = null;
  agentWrite.mockClear();
  useProjectInstructionsStore.getState().setInstructions(projectId, "legacy cache stays unchanged");
  transportHarness.request
    .mockReset()
    .mockImplementation(async (method: string, input: Record<string, unknown>) => {
      if (method === WS_METHODS.contextGetProject)
        return readHold ?? { ...server, projectId: input.projectId };
      if (method === WS_METHODS.contextSaveProject) {
        if (saveHold) await saveHold;
        const saved = {
          ...(server.dataInstanceId === input.dataInstanceId
            ? server
            : settings({ dataInstanceId: input.dataInstanceId as string })),
          projectId: input.projectId as typeof projectId,
          projectGoal: input.projectGoal as string,
          projectInstructions: input.projectInstructions as string,
          revision: (input.expectedRevision as number) + 1,
        };
        if (server.dataInstanceId === saved.dataInstanceId) server = saved;
        return { commandId: input.commandId, status: "saved", project: saved };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
});
afterEach(async () => {
  await close?.();
  close = null;
  await resetWsNativeApiForTest();
  transportHarness.listeners.clear();
  transportHarness.stateListeners.clear();
  useProjectInstructionsStore.getState().clearInstructions(projectId);
  document.body.innerHTML = "";
});

it("preserves the original API, dirty Context editor and guard through null negotiation and reconnect", async () => {
  capabilities([WS_CONTEXT_V1_CAPABILITY]);
  close = await mount();
  const field = page.getByLabelText("Project instructions", { exact: true });
  await expect.element(field).toHaveValue("saved Context instructions");
  const api = readNativeApi();
  const controller = current!.controller;
  await field.fill("unsaved Context draft");
  capabilities(null);
  await expect.element(field).toBeDisabled();
  await expect.element(field).toHaveValue("unsaved Context draft");
  await expect.element(page.getByTestId("context-owner")).toHaveTextContent("Context owner");
  expect(readNativeApi()).toBe(api);
  expect(current!.controller).toBe(controller);
  await page.getByRole("button", { name: "Attempt leave" }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "保存并继续" })).toBeDisabled();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await new Promise((resolve) => setTimeout(resolve, 650));
  expect(
    transportHarness.request.mock.calls.filter(
      ([method]) => method === WS_METHODS.contextSaveProject,
    ),
  ).toHaveLength(0);
  expect(agentWrite).not.toHaveBeenCalled();
  expect(useProjectInstructionsStore.getState().instructionsByProjectId[projectId]).toBe(
    "legacy cache stays unchanged",
  );
  capabilities([WS_CONTEXT_V1_CAPABILITY]);
  await expect.poll(() => server.projectInstructions).toBe("unsaved Context draft");
  expect(current!.controller).toBe(controller);
  expect(readNativeApi()).toBe(api);
});

it("blocks a fresh unknown first send and only enables fallback after explicit unsupported negotiation", async () => {
  close = await mount();
  await expect.element(page.getByTestId("context-owner")).toHaveTextContent("Context owner");
  await expect.element(page.getByLabelText("Project instructions", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "First send" }).click();
  await expect.element(page.getByText("blocked", { exact: true })).toBeVisible();
  expect(transportHarness.request).not.toHaveBeenCalled();
  expect(agentWrite).not.toHaveBeenCalled();
  capabilities([]);
  await expect.element(page.getByTestId("context-owner")).toHaveTextContent("Agent owner");
  await page.getByRole("button", { name: "First send" }).click();
  await expect.element(page.getByText("sent", { exact: true })).toBeVisible();
});

it("retains a dirty draft and guard on explicit unsupported until the user discards it", async () => {
  capabilities([WS_CONTEXT_V1_CAPABILITY]);
  close = await mount();
  const field = page.getByLabelText("Project instructions", { exact: true });
  await expect.element(field).toHaveValue("saved Context instructions");
  await field.fill("unsupported draft");
  capabilities([]);
  await expect.element(field).toBeDisabled();
  await expect.element(field).toHaveValue("unsupported draft");
  await page.getByRole("button", { name: "Attempt leave" }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "First send" }).click();
  await expect.element(page.getByText("blocked", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Discard Context", exact: true }).click();
  await expect.element(page.getByTestId("context-owner")).toHaveTextContent("Agent owner");
  expect(agentWrite).not.toHaveBeenCalled();
});

it("does not carry capability, query data or a dirty queue into a replacement API", async () => {
  capabilities([WS_CONTEXT_V1_CAPABILITY]);
  close = await mount();
  const field = page.getByLabelText("Project instructions", { exact: true });
  await expect.element(field).toHaveValue("saved Context instructions");
  await field.fill("old API draft");
  const original = current!.controller;
  const oldApi = readNativeApi();
  const oldListeners = [...transportHarness.listeners];
  await resetWsNativeApiForTest();
  transportHarness.capabilities = null;
  for (const listener of oldListeners) listener();
  await expect.poll(() => current!.detached).toBe(true);
  expect(current!.controller).toBe(original);
  await expect.element(field).toHaveValue("old API draft");
  await expect.element(field).toBeDisabled();
  await page.getByRole("button", { name: "Attempt leave" }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "Discard Context", exact: true }).click();
  await expect.poll(() => current!.controller).toBeNull();
  expect(readNativeApi()).not.toBe(oldApi);
  await expect.element(field).toHaveValue("");
  await expect.element(field).toBeDisabled();
  await expect(original!.flush()).resolves.toBe(false);
  server = settings({ dataInstanceId: "instance-b", projectInstructions: "new API Context" });
  capabilities([WS_CONTEXT_V1_CAPABILITY]);
  await expect.element(field).toHaveValue("new API Context");
  expect(current!.controller).not.toBe(original);
  expect(server.projectInstructions).toBe("new API Context");
});

it("separates a refreshed data instance and a different project from the previous draft", async () => {
  capabilities([WS_CONTEXT_V1_CAPABILITY]);
  close = await mount();
  const field = page.getByLabelText("Project instructions", { exact: true });
  await expect.element(field).toHaveValue("saved Context instructions");
  await field.fill("instance-a draft");
  const original = current!.controller;
  server = settings({ dataInstanceId: "instance-b", projectInstructions: "instance-b Context" });
  await page.getByRole("button", { name: "Reload Context" }).click();
  await expect.poll(() => current!.detached).toBe(true);
  await expect.element(field).toHaveValue("instance-a draft");
  await expect.element(field).toBeDisabled();
  expect(current!.controller).toBe(original);
  await page.getByRole("button", { name: "Attempt leave" }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "First send" }).click();
  await expect.element(page.getByText("blocked", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Discard Context", exact: true }).click();
  await expect.element(field).toHaveValue("instance-b Context");
  expect(current!.controller).not.toBe(original);
  await expect(original!.flush()).resolves.toBe(false);
  const second = current!.controller;
  await page.getByRole("button", { name: "Switch project" }).click();
  await expect.poll(() => current!.state?.projectId).toBe(otherProjectId);
  expect(current!.controller).not.toBe(second);
});

it("switches clean Context directly to a new instance or API without carrying a cache or queue", async () => {
  capabilities([WS_CONTEXT_V1_CAPABILITY]);
  close = await mount();
  const field = page.getByLabelText("Project instructions", { exact: true });
  await expect.element(field).toHaveValue("saved Context instructions");
  const first = current!.controller;
  server = settings({
    dataInstanceId: "clean-instance-b",
    projectInstructions: "clean instance-b Context",
  });
  await page.getByRole("button", { name: "Reload Context" }).click();
  await expect.element(field).toHaveValue("clean instance-b Context");
  expect(current!.controller).not.toBe(first);
  expect(current!.detached).toBe(false);
  const second = current!.controller;
  const secondApi = readNativeApi();
  const oldListeners = [...transportHarness.listeners];
  await resetWsNativeApiForTest();
  transportHarness.capabilities = null;
  for (const listener of oldListeners) listener();
  await expect.poll(() => current!.controller).toBeNull();
  await expect.element(field).toHaveValue("");
  expect(readNativeApi()).not.toBe(secondApi);
  server = settings({
    dataInstanceId: "clean-instance-c",
    projectInstructions: "clean API Context",
  });
  capabilities([WS_CONTEXT_V1_CAPABILITY]);
  await expect.element(field).toHaveValue("clean API Context");
  expect(current!.controller).not.toBe(second);
  expect(current!.detached).toBe(false);
  expect(
    transportHarness.request.mock.calls.filter(
      ([method]) => method === WS_METHODS.contextSaveProject,
    ),
  ).toHaveLength(0);
});

it("requires a fresh read before enabling a directly supported API or a previously cached API", async () => {
  capabilities([WS_CONTEXT_V1_CAPABILITY]);
  close = await mount();
  const field = page.getByLabelText("Project instructions", { exact: true });
  await expect.element(field).toHaveValue("saved Context instructions");
  const originalApi = readNativeApi()!;
  const originalController = current!.controller;
  let resolveRead!: (value: ProjectContextSettings) => void;
  readHold = new Promise((resolve) => {
    resolveRead = resolve;
  });
  const firstListeners = [...transportHarness.listeners];
  await resetWsNativeApiForTest();
  for (const listener of firstListeners) listener();
  await expect.poll(() => current!.api).not.toBe(originalApi.context);
  await expect.element(field).toBeDisabled();
  expect(current!.available).toBe(false);
  server = settings({ dataInstanceId: "supported-b", projectInstructions: "fresh supported B" });
  resolveRead(server);
  readHold = null;
  await expect.element(field).toHaveValue("fresh supported B");
  await expect.element(field).not.toBeDisabled();
  const secondListeners = [...transportHarness.listeners];
  readHold = new Promise((resolve) => {
    resolveRead = resolve;
  });
  Object.defineProperty(window, "nativeApi", { configurable: true, value: originalApi });
  for (const listener of secondListeners) listener();
  await expect.poll(() => current!.api).toBe(originalApi.context);
  await expect.element(field).toBeDisabled();
  expect(current!.available).toBe(false);
  await expect(originalController!.flush()).resolves.toBe(false);
  server = settings({ projectInstructions: "fresh confirmed A", revision: 1 });
  resolveRead(server);
  readHold = null;
  await expect.element(field).toHaveValue("fresh confirmed A");
  await expect.element(field).not.toBeDisabled();
  expect(current!.controller).toBe(originalController);
  expect(
    transportHarness.request.mock.calls.filter(
      ([method]) => method === WS_METHODS.contextSaveProject,
    ),
  ).toHaveLength(0);
});

it("preserves an unacknowledged save after text returns to base and never reactivates it across an instance change", async () => {
  capabilities([WS_CONTEXT_V1_CAPABILITY]);
  close = await mount();
  const field = page.getByLabelText("Project instructions", { exact: true });
  await expect.element(field).toHaveValue("saved Context instructions");
  const original = current!.controller;
  let releaseSave!: () => void;
  saveHold = new Promise((resolve) => {
    releaseSave = resolve;
  });
  await field.fill("sent but unacknowledged");
  await expect
    .poll(
      () =>
        transportHarness.request.mock.calls.filter(
          ([method]) => method === WS_METHODS.contextSaveProject,
        ).length,
    )
    .toBe(1);
  await field.fill("saved Context instructions");
  expect(current!.state?.dirty).toBe(false);
  expect(current!.state?.pending).toBe(true);
  server = settings({
    dataInstanceId: "pending-instance-b",
    projectInstructions: "pending instance-b Context",
  });
  await page.getByRole("button", { name: "Reload Context" }).click();
  await expect.poll(() => current!.detached).toBe(true);
  expect(current!.controller).toBe(original);
  await expect.element(field).toHaveValue("saved Context instructions");
  await expect.element(field).toBeDisabled();
  await page.getByRole("button", { name: "Attempt leave" }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "First send" }).click();
  await expect.element(page.getByText("blocked", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Discard Context", exact: true }).click();
  await expect.element(field).toHaveValue("pending instance-b Context");
  const replacement = current!.controller;
  expect(replacement).not.toBe(original);
  releaseSave();
  saveHold = null;
  await expect.poll(() => original!.getState().saving).toBe(false);
  expect(original!.getState().pending).toBe(false);
  expect(current!.controller).toBe(replacement);
  expect(server.projectInstructions).toBe("pending instance-b Context");
  expect(
    transportHarness.request.mock.calls.filter(
      ([method]) => method === WS_METHODS.contextSaveProject,
    ),
  ).toHaveLength(1);
});

it("makes every observer of a shared current-generation query available", async () => {
  capabilities([WS_CONTEXT_V1_CAPABILITY]);
  let first: ProjectContextController | null = null;
  let second: ProjectContextController | null = null;
  function TwoObservers() {
    first = useProjectContextAutosave(projectId, true);
    second = useProjectContextAutosave(projectId, true);
    return <p>Shared observers</p>;
  }
  close = await mount(TwoObservers);
  await expect.poll(() => first?.available).toBe(true);
  await expect.poll(() => second?.available).toBe(true);
  expect(first!.controller).toBe(second!.controller);
});

it("pauses immediately on connecting with unchanged capabilities and rejects the previous session read", async () => {
  capabilities([WS_CONTEXT_V1_CAPABILITY]);
  close = await mount();
  const field = page.getByLabelText("Project instructions", { exact: true });
  await expect.element(field).toHaveValue("saved Context instructions");
  let finishOldRead!: (value: ProjectContextSettings) => void;
  readHold = new Promise((resolve) => {
    finishOldRead = resolve;
  });
  await page.getByRole("button", { name: "Reload Context" }).click();
  transportHarness.sessionVersion += 1;
  transportHarness.state = "connecting";
  for (const listener of transportHarness.stateListeners) listener();
  await expect.poll(() => current!.available).toBe(false);
  await expect.element(field).toBeDisabled();
  finishOldRead(settings({ projectInstructions: "stale session response", revision: 8 }));
  readHold = null;
  server = settings({ projectInstructions: "fresh reconnected response", revision: 1 });
  transportHarness.state = "open";
  for (const listener of transportHarness.stateListeners) listener();
  await expect.element(field).toHaveValue("fresh reconnected response");
  await expect.element(field).not.toBeDisabled();
  expect(current!.state?.draft.projectInstructions).not.toBe("stale session response");
});

it("blocks a first-send read that discovers a different instance while the original owner is pending", async () => {
  useProjectInstructionsStore.getState().clearInstructions(projectId);
  capabilities([WS_CONTEXT_V1_CAPABILITY]);
  close = await mount();
  const field = page.getByLabelText("Project instructions", { exact: true });
  await expect.element(field).toHaveValue("saved Context instructions");
  await field.fill("pending owner A");
  let finishRead!: (settings: ProjectContextSettings) => void;
  readHold = new Promise((resolve) => {
    finishRead = resolve;
  });
  await page.getByRole("button", { name: "First send" }).click();
  server = settings({ dataInstanceId: "first-send-instance-b", projectInstructions: "instance B" });
  finishRead(server);
  readHold = null;
  await expect.element(page.getByText("blocked", { exact: true })).toBeVisible();
  expect(current!.state?.base.dataInstanceId).toBe("instance-a");
  expect(current!.state?.pending).toBe(true);
});

for (const replaceApi of [false, true]) {
  it(`preserves a Space draft across ${replaceApi ? "API replacement" : "data-instance replacement"} until explicit discard`, async () => {
    capabilities([WS_CONTEXT_V1_CAPABILITY]);
    const spaceId = SpaceId.makeUnsafe("retained-space");
    let saved = {
      dataInstanceId: "space-a",
      spaceId,
      name: "Space A",
      icon: "folder",
      directionGoal: "saved direction",
      sharedInstructions: "saved shared",
      revision: 0,
    };
    transportHarness.request.mockImplementation(async (method: string) => {
      if (method === WS_METHODS.contextGetSpace) return { ...saved };
      throw new Error(`Unexpected request: ${method}`);
    });
    let controller: ReturnType<typeof useSpacesController> | null = null;
    function SpaceHarness() {
      const spaces = useSpacesController({
        ordinarySpaceProjects: [],
        hubProjects: [],
        summariesByProjectId: new Map(),
        routeSpaceProject: null,
        projectById: new Map(),
        sidebarThreads: [],
        sidebarThreadSortOrder: "updated_at",
        sidebarThreadAttentionFirst: false,
        routeThreadId: null,
        routeProjectId: null,
        isOnKanban: false,
        activeRouteProject: null,
        activeRouteProjectId: null,
        activateThreadFromSidebarIntent: () => undefined,
        onCloseProjectContextMenu: () => undefined,
      });
      controller = spaces;
      const editor = spaces.spaceContextEditor;
      return (
        <>
          <button onClick={() => spaces.openSpaceEditor(spaceId)}>Open Space</button>
          <button onClick={() => void spaces.closeSpaceEditor()}>Close Space</button>
          {editor ? <SpaceContextFieldsEditor {...editor} /> : null}
          {spaces.spaceDraftGuardDialog}
        </>
      );
    }
    close = await mount(SpaceHarness);
    await page.getByRole("button", { name: "Open Space" }).click();
    const field = page.getByLabelText("Shared instructions", { exact: true });
    await expect.element(field).toHaveValue("saved shared");
    await field.fill("preserved Space draft");
    saved = {
      ...saved,
      dataInstanceId: "space-b",
      name: "Space B",
      sharedInstructions: "new owner shared",
    };
    if (replaceApi) {
      const oldListeners = [...transportHarness.listeners];
      await resetWsNativeApiForTest();
      for (const listener of oldListeners) listener();
    } else {
      controller!.spaceContextEditor!.onRetry();
    }
    await expect
      .element(page.getByText("Saved shared instructions", { exact: true }))
      .toBeVisible();
    await expect.element(field).toHaveValue("preserved Space draft");
    await expect.element(field).toBeDisabled();
    await expect
      .element(page.getByRole("button", { name: "Keep my edits", exact: true }))
      .toBeDisabled();
    await page.getByRole("button", { name: "Close Space", exact: true }).click();
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", { name: "Use saved values", exact: true }).click();
    await expect.element(field).toHaveValue("new owner shared");
    await expect.element(field).not.toBeDisabled();
    expect(controller!.spaceContextEditor!.metadataDraft?.name).toBe("Space B");
    expect(
      transportHarness.request.mock.calls.filter(
        ([method]) => method === WS_METHODS.contextSaveSpace,
      ),
    ).toHaveLength(0);
  });
}

it("guards the next Space draft after saving and continuing through the leave guard", async () => {
  capabilities([WS_CONTEXT_V1_CAPABILITY]);
  const spaceId = SpaceId.makeUnsafe("space-save-guard");
  let saved = {
    dataInstanceId: "space-guard-a",
    spaceId,
    name: "Space A",
    icon: "bag",
    directionGoal: "saved direction",
    sharedInstructions: "saved shared",
    revision: 0,
  };
  transportHarness.request.mockImplementation(
    async (method: string, input: Record<string, unknown>) => {
      if (method === WS_METHODS.contextGetSpace) return { ...saved };
      if (method === WS_METHODS.contextSaveSpace) {
        saved = {
          ...saved,
          name: String(input.name),
          icon: String(input.icon),
          directionGoal: String(input.directionGoal),
          sharedInstructions: String(input.sharedInstructions),
          revision: saved.revision + 1,
        };
        return { commandId: input.commandId, status: "saved", space: { ...saved } };
      }
      throw new Error(`Unexpected request: ${method}`);
    },
  );
  function SpaceHarness() {
    const spaces = useSpacesController({
      ordinarySpaceProjects: [],
      hubProjects: [],
      summariesByProjectId: new Map(),
      routeSpaceProject: null,
      projectById: new Map(),
      sidebarThreads: [],
      sidebarThreadSortOrder: "updated_at",
      sidebarThreadAttentionFirst: false,
      routeThreadId: null,
      routeProjectId: null,
      isOnKanban: false,
      activeRouteProject: null,
      activeRouteProjectId: null,
      activateThreadFromSidebarIntent: () => undefined,
      onCloseProjectContextMenu: () => undefined,
    });
    const editor = spaces.spaceContextEditor;
    return (
      <>
        <button onClick={() => spaces.openSpaceEditor(spaceId)}>Open Space</button>
        <button onClick={() => void spaces.closeSpaceEditor()}>Close Space</button>
        {editor ? <SpaceContextFieldsEditor {...editor} /> : null}
        {spaces.spaceDraftGuardDialog}
      </>
    );
  }
  close = await mount(SpaceHarness);
  await page.getByRole("button", { name: "Open Space" }).click();
  const field = page.getByLabelText("Shared instructions", { exact: true });
  await expect.element(field).toHaveValue("saved shared");
  await field.fill("first guarded edit");
  await page.getByRole("button", { name: "Close Space", exact: true }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "保存并继续", exact: true }).click();
  await expect.element(field).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Open Space" }).click();
  await expect.element(field).toHaveValue("first guarded edit");
  await field.fill("second guarded edit");
  await page.getByRole("button", { name: "Close Space", exact: true }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await expect.element(field).toHaveValue("second guarded edit");
  expect(saved.sharedInstructions).toBe("first guarded edit");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "Route away", exact: true }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "放弃更改", exact: true }).click();
  await expect.element(page.getByText("Route destination", { exact: true })).toBeVisible();
  await expect.element(field).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Open Space" }).click();
  await expect.element(field).toHaveValue("first guarded edit");
});
