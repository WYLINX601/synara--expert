import "../../../index.css";

import {
  ProjectId,
  ThreadId,
  type ContextApi,
  type ContextCommandResult,
  type ContextMigrationRecord,
  type NativeApi,
  type ProjectContextSettings,
} from "@synara/contracts";
import { useState } from "react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const contextClientMocks = vi.hoisted(() => ({
  readContextClient: null as
    | null
    | (() => {
        capability: "supported" | "unsupported" | "unknown";
        supported: boolean;
        generation: string;
        connected: boolean;
        available: boolean;
        api: null;
      }),
}));
vi.mock("~/workbench/host/contextClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/workbench/host/contextClient")>();
  return {
    ...actual,
    readContextClient: () => contextClientMocks.readContextClient?.() ?? actual.readContextClient(),
  };
});

import { useProjectInstructionsStore } from "~/projectInstructionsStore";
import { useProjectContextMigration } from "./useProjectContextMigration";

const projectId = ProjectId.makeUnsafe("legacy-context-project");
const threadId = ThreadId.makeUnsafe("legacy-context-thread");
const switchedProjectId = ProjectId.makeUnsafe("legacy-context-switched-project");
const switchedThreadId = ThreadId.makeUnsafe("legacy-context-switched-thread");
const legacyInstructions = "  keep every byte\nincluding spacing  ";

function migrationRecord(overrides: Partial<ContextMigrationRecord> = {}): ContextMigrationRecord {
  return {
    projectId,
    sourceDigest: "",
    legacyInstructions,
    status: "pending",
    choice: null,
    updatedAt: "2026-10-14T00:00:00.000Z",
    ...overrides,
  };
}

function projectSettings(overrides: Partial<ProjectContextSettings> = {}): ProjectContextSettings {
  return {
    dataInstanceId: "data-instance-migration",
    projectId,
    title: "Current project",
    workspaceRoot: "/workspace/current",
    spaceId: null,
    projectGoal: "Preserve this goal",
    projectInstructions: "",
    revision: 0,
    inherited: null,
    migration: null,
    ...overrides,
  };
}

function setNativeApi(api: Partial<NativeApi>): () => void {
  const previous = Object.getOwnPropertyDescriptor(window, "nativeApi");
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: api,
  });
  return () => {
    if (previous) Object.defineProperty(window, "nativeApi", previous);
    else Reflect.deleteProperty(window, "nativeApi");
  };
}

function makeApi(overrides: Partial<ContextApi> = {}): ContextApi {
  return {
    getSpace: vi.fn(),
    getProject: vi.fn(async () => projectSettings()),
    getThread: vi.fn(),
    saveSpace: vi.fn(),
    saveProject: vi.fn(),
    getCommandResult: vi.fn(
      async ({ commandId }) => ({ commandId, status: "unknown" }) as ContextCommandResult,
    ),
    claimMigration: vi.fn(),
    resolveMigration: vi.fn(),
    retryLoad: vi.fn(),
    ...overrides,
  };
}

function MigrationHarness() {
  const migration = useProjectContextMigration({
    projectId,
    threadId,
    localProjectName: "Current project",
    localWorkspaceRoot: "/workspace/current",
    isLocalDraft: true,
  });
  const [sendResult, setSendResult] = useState("waiting");
  const startSend = async () => {
    const allowed = await migration.beforeFirstSend();
    setSendResult(allowed ? "sent" : "cancelled");
  };
  return (
    <>
      <button type="button" onClick={() => void startSend()}>
        Send
      </button>
      <p>{sendResult}</p>
      {migration.dialog}
    </>
  );
}

function PendingReadMigrationHarness() {
  const [target, setTarget] = useState({ projectId, threadId });
  const migration = useProjectContextMigration({
    projectId: target.projectId,
    threadId: target.threadId,
    localProjectName: target.projectId === projectId ? "Current project" : "Switched project",
    localWorkspaceRoot:
      target.projectId === projectId ? "/workspace/current" : "/workspace/switched",
    isLocalDraft: true,
  });
  const [sendResult, setSendResult] = useState("waiting");
  const startSend = async () => {
    const allowed = await migration.beforeFirstSend();
    setSendResult(allowed ? "sent" : "cancelled");
  };
  return (
    <>
      <button type="button" onClick={() => void startSend()}>
        Send
      </button>
      <button
        type="button"
        onClick={() => setTarget({ projectId: switchedProjectId, threadId: switchedThreadId })}
      >
        Switch project and thread
      </button>
      <p>{sendResult}</p>
      {migration.dialog}
    </>
  );
}

function digest(value: string): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(value))
    .then((buffer) =>
      Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
}

describe("legacy Project Instructions migration gate", () => {
  let restoreNativeApi: (() => void) | null = null;
  let restoreContextClient: (() => void) | null = null;

  afterEach(() => {
    restoreNativeApi?.();
    restoreNativeApi = null;
    restoreContextClient?.();
    restoreContextClient = null;
    contextClientMocks.readContextClient = null;
    useProjectInstructionsStore.getState().clearInstructions(projectId);
    document.body.innerHTML = "";
  });

  it("requires workspace ownership, resolves the exact source, preserves the goal, and keeps the old cache", async () => {
    const hash = await digest(legacyInstructions);
    const initial = projectSettings();
    const claimed = projectSettings({ migration: migrationRecord({ sourceDigest: hash }) });
    const completedRecord = migrationRecord({
      sourceDigest: hash,
      status: "completed",
      choice: "use_legacy",
    });
    const migrated = projectSettings({
      projectInstructions: legacyInstructions,
      revision: 1,
      migration: completedRecord,
    });
    const claim = vi.fn<ContextApi["claimMigration"]>();
    claim.mockRejectedValueOnce(new Error("reply lost"));
    claim.mockImplementation(async (input) => ({
      commandId: input.commandId,
      status: "saved",
      project: claimed,
      migration: claimed.migration ?? undefined,
    }));
    const api = makeApi({
      getProject: vi.fn(async () => initial),
      claimMigration: claim,
      resolveMigration: vi.fn<ContextApi["resolveMigration"]>(async (input) => ({
        commandId: input.commandId,
        status: "saved",
        project: migrated,
        migration: completedRecord,
      })),
    });
    restoreNativeApi = setNativeApi({ context: api });
    useProjectInstructionsStore.getState().setInstructions(projectId, legacyInstructions);
    await render(<MigrationHarness />);

    await page.getByRole("button", { name: "Send" }).click();
    await expect
      .element(page.getByRole("heading", { name: "Confirm legacy instructions ownership" }))
      .toBeVisible();
    expect(document.body.textContent).toContain("/workspace/current");
    expect(api.claimMigration).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "Confirm ownership and compare" }).click();
    await expect
      .element(page.getByRole("button", { name: "Use legacy instructions" }))
      .toBeVisible();
    expect(claim).toHaveBeenCalledTimes(2);
    expect(claim.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        expectedWorkspaceRoot: "/workspace/current",
        sourceDigest: hash,
        legacyInstructions,
      }),
    );
    expect(claim.mock.calls[0]?.[0].commandId).toBe(claim.mock.calls[1]?.[0].commandId);

    await page.getByRole("button", { name: "Use legacy instructions" }).click();
    await expect.element(page.getByText("sent", { exact: true })).toBeVisible();
    expect(api.resolveMigration).toHaveBeenCalledWith(
      expect.objectContaining({
        choice: "use_legacy",
        expectedRevision: 0,
        instructions: legacyInstructions,
      }),
    );
    expect(migrated.projectGoal).toBe("Preserve this goal");
    expect(useProjectInstructionsStore.getState().instructionsByProjectId[projectId]).toBe(
      legacyInstructions,
    );
  });

  it("cancels the first send without claiming or changing legacy storage", async () => {
    const api = makeApi();
    restoreNativeApi = setNativeApi({ context: api });
    useProjectInstructionsStore.getState().setInstructions(projectId, legacyInstructions);
    await render(<MigrationHarness />);

    await page.getByRole("button", { name: "Send" }).click();
    await page.getByRole("button", { name: "Cancel send" }).click();

    await expect.element(page.getByText("cancelled", { exact: true })).toBeVisible();
    expect(api.claimMigration).not.toHaveBeenCalled();
    expect(api.resolveMigration).not.toHaveBeenCalled();
    expect(useProjectInstructionsStore.getState().instructionsByProjectId[projectId]).toBe(
      legacyInstructions,
    );
  });

  it("continues the first send when the server does not support Context v1", async () => {
    restoreNativeApi = setNativeApi({});
    useProjectInstructionsStore.getState().setInstructions(projectId, legacyInstructions);
    await render(<MigrationHarness />);

    await page.getByRole("button", { name: "Send" }).click();

    await expect.element(page.getByText("sent", { exact: true })).toBeVisible();
    expect(useProjectInstructionsStore.getState().instructionsByProjectId[projectId]).toBe(
      legacyInstructions,
    );
  });

  it("blocks the first send when Context is supported but its API is unavailable", async () => {
    restoreNativeApi = setNativeApi({});
    useProjectInstructionsStore.getState().setInstructions(projectId, legacyInstructions);
    contextClientMocks.readContextClient = () => ({
      capability: "supported",
      supported: true,
      generation: "unavailable:1",
      connected: true,
      available: false,
      api: null,
    });
    restoreContextClient = () => {
      contextClientMocks.readContextClient = null;
    };
    await render(<MigrationHarness />);

    await page.getByRole("button", { name: "Send" }).click();

    await expect.element(page.getByText("cancelled", { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain("Confirm legacy instructions ownership");
    expect(useProjectInstructionsStore.getState().instructionsByProjectId[projectId]).toBe(
      legacyInstructions,
    );
  });

  it("blocks the first send when a supported Context connection is temporarily offline", async () => {
    const api = makeApi({ getProject: vi.fn().mockRejectedValue(new Error("connection closed")) });
    restoreNativeApi = setNativeApi({ context: api });
    await render(<MigrationHarness />);

    await page.getByRole("button", { name: "Send" }).click();

    await expect.element(page.getByText("cancelled", { exact: true })).toBeVisible();
    expect(api.getProject).toHaveBeenCalledOnce();
  });

  it("cancels a first-send migration read when the active project and thread change", async () => {
    let resolveRead!: (value: ProjectContextSettings) => void;
    const delayedRead = new Promise<ProjectContextSettings>((resolve) => {
      resolveRead = resolve;
    });
    const api = makeApi({ getProject: vi.fn(() => delayedRead) });
    restoreNativeApi = setNativeApi({ context: api });
    useProjectInstructionsStore.getState().setInstructions(projectId, legacyInstructions);
    await render(<PendingReadMigrationHarness />);

    await page.getByRole("button", { name: "Send" }).click();
    await page.getByRole("button", { name: "Switch project and thread" }).click();
    resolveRead(projectSettings());

    await expect.element(page.getByText("cancelled", { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain("Confirm legacy instructions ownership");
    expect(api.claimMigration).not.toHaveBeenCalled();
  });
});
