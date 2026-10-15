import {
  ProjectId,
  type ContextApi,
  type ContextCommandResult,
  type ProjectContextSettings,
} from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getProjectContextAutosave, ProjectContextAutosave } from "./projectContextAutosave";

const projectId = ProjectId.makeUnsafe("project-context-autosave");

function settings(overrides: Partial<ProjectContextSettings> = {}): ProjectContextSettings {
  return {
    dataInstanceId: "data-instance-a",
    projectId,
    title: "Example project",
    workspaceRoot: "/workspace/example",
    spaceId: null,
    projectGoal: "saved goal",
    projectInstructions: "saved instructions",
    revision: 0,
    inherited: null,
    migration: null,
    ...overrides,
  };
}

function savedResult(
  commandId: ContextCommandResult["commandId"],
  project: ProjectContextSettings,
): ContextCommandResult {
  return { commandId, status: "saved", project };
}

function fakeApi(overrides: Partial<ContextApi> = {}): ContextApi {
  return {
    getSpace: vi.fn(),
    getProject: vi.fn(async () => settings()),
    getThread: vi.fn(),
    saveSpace: vi.fn(),
    saveProject: vi.fn(async (input) =>
      savedResult(
        input.commandId,
        settings({
          projectGoal: input.projectGoal,
          projectInstructions: input.projectInstructions,
          revision: input.expectedRevision + 1,
        }),
      ),
    ),
    getCommandResult: vi.fn(async ({ commandId }) => ({ commandId, status: "unknown" as const })),
    claimMigration: vi.fn(),
    resolveMigration: vi.fn(),
    retryLoad: vi.fn(),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ProjectContextAutosave", () => {
  it("debounces for 500ms and serializes the latest draft after an earlier save", async () => {
    vi.useFakeTimers();
    const first = deferred<ContextCommandResult>();
    const api = fakeApi({
      saveProject: vi
        .fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(async (input) =>
          savedResult(
            input.commandId,
            settings({
              projectGoal: input.projectGoal,
              projectInstructions: input.projectInstructions,
              revision: input.expectedRevision + 1,
            }),
          ),
        ),
    });
    const controller = new ProjectContextAutosave({ api, initial: settings() });

    controller.setDraft({ projectGoal: "first draft", projectInstructions: "saved instructions" });
    await vi.advanceTimersByTimeAsync(499);
    expect(api.saveProject).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    expect(api.saveProject).toHaveBeenCalledTimes(1);

    controller.setDraft({ projectGoal: "latest draft", projectInstructions: "saved instructions" });
    const flush = controller.flush();
    const firstInput = vi.mocked(api.saveProject).mock.calls[0]![0];
    first.resolve(
      savedResult(firstInput.commandId, settings({ projectGoal: "first draft", revision: 1 })),
    );

    await expect(flush).resolves.toBe(true);
    expect(api.saveProject).toHaveBeenCalledTimes(2);
    expect(api.saveProject).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expectedRevision: 1,
        projectGoal: "latest draft",
      }),
    );
    expect(controller.getState().base.projectGoal).toBe("latest draft");
  });

  it("queries an uncertain command and replays the same idempotency key", async () => {
    const api = fakeApi({
      saveProject: vi
        .fn()
        .mockRejectedValueOnce(new Error("connection dropped"))
        .mockImplementationOnce(async (input) =>
          savedResult(input.commandId, settings({ projectGoal: input.projectGoal, revision: 1 })),
        ),
    });
    const controller = new ProjectContextAutosave({ api, initial: settings() });
    controller.setDraft({ projectGoal: "recover me", projectInstructions: "saved instructions" });

    await expect(controller.flush()).resolves.toBe(true);

    const saves = vi.mocked(api.saveProject).mock.calls.map(([input]) => input.commandId);
    expect(saves).toHaveLength(2);
    expect(saves[0]).toBe(saves[1]);
    expect(api.getCommandResult).toHaveBeenCalledWith({ commandId: saves[0] });
  });

  it("keeps discard guarded while the original save receipt is pending", async () => {
    const api = fakeApi({
      saveProject: vi.fn(async ({ commandId }) => ({ commandId, status: "pending" as const })),
      getCommandResult: vi.fn(async ({ commandId }) => ({ commandId, status: "pending" as const })),
    });
    const controller = new ProjectContextAutosave({ api, initial: settings() });
    controller.setDraft({
      projectGoal: "pending draft",
      projectInstructions: "saved instructions",
    });
    await expect(controller.flush()).resolves.toBe(false);
    vi.mocked(api.getCommandResult).mockClear();
    vi.mocked(api.getProject).mockClear();

    await expect(controller.discard()).resolves.toBe(false);

    const commandId = vi.mocked(api.saveProject).mock.calls[0]![0].commandId;
    expect(api.getCommandResult).toHaveBeenCalledExactlyOnceWith({ commandId });
    expect(api.getProject).not.toHaveBeenCalled();
    expect(controller.getState().draft.projectGoal).toBe("pending draft");
    expect(controller.getState().dirty).toBe(true);
    expect(controller.getState().error?.code).toBe("pending");
  });

  it("does not discard after an exhausted lost-ack lookup returns unknown", async () => {
    const api = fakeApi({
      saveProject: vi.fn(async () => {
        throw new Error("connection dropped");
      }),
      getCommandResult: vi.fn(async ({ commandId }) => ({ commandId, status: "unknown" as const })),
    });
    const controller = new ProjectContextAutosave({ api, initial: settings() });
    controller.setDraft({
      projectGoal: "uncertain draft",
      projectInstructions: "saved instructions",
    });
    await expect(controller.flush()).resolves.toBe(false);
    controller.receiveConfirmed(settings({ projectGoal: "remote edit", revision: 1 }));
    vi.mocked(api.getCommandResult).mockClear();
    vi.mocked(api.getProject).mockClear();

    await expect(controller.acceptSaved()).resolves.toBe(false);

    const commandId = vi.mocked(api.saveProject).mock.calls[0]![0].commandId;
    expect(api.getCommandResult).toHaveBeenCalledExactlyOnceWith({ commandId });
    expect(api.getProject).not.toHaveBeenCalled();
    expect(controller.getState().draft.projectGoal).toBe("uncertain draft");
    expect(controller.getState().dirty).toBe(true);
    expect(controller.getState().base.projectGoal).toBe("remote edit");
    expect(controller.getState().error?.code).toBe("pending");
    expect(controller.getState().error?.outcomeUncertain).toBe(true);
  });

  it("retains the draft when the original command receipt cannot be read", async () => {
    const api = fakeApi({
      saveProject: vi.fn(async () => {
        throw new Error("connection dropped");
      }),
      getCommandResult: vi.fn(async () => {
        throw new Error("receipt lookup failed");
      }),
    });
    const controller = new ProjectContextAutosave({ api, initial: settings() });
    controller.setDraft({
      projectGoal: "unconfirmed draft",
      projectInstructions: "saved instructions",
    });
    await expect(controller.flush()).resolves.toBe(false);
    vi.mocked(api.getCommandResult).mockClear();
    vi.mocked(api.getProject).mockClear();

    await expect(controller.discard()).resolves.toBe(false);

    expect(api.getCommandResult).toHaveBeenCalledTimes(1);
    expect(api.getProject).not.toHaveBeenCalled();
    expect(controller.getState().draft.projectGoal).toBe("unconfirmed draft");
    expect(controller.getState().dirty).toBe(true);
    expect(controller.getState().error?.code).toBe("failure");
    expect(controller.getState().error?.outcomeUncertain).toBe(true);
  });

  it("discards a known conflict against the latest confirmed baseline", async () => {
    const remote = settings({ projectGoal: "remote goal", revision: 3 });
    const api = fakeApi({ getProject: vi.fn(async () => remote) });
    const controller = new ProjectContextAutosave({ api, initial: settings() });
    controller.setDraft({ projectGoal: "local draft", projectInstructions: "saved instructions" });
    controller.receiveConfirmed(remote);

    await expect(controller.discard()).resolves.toBe(true);

    expect(controller.getState().base.projectGoal).toBe("remote goal");
    expect(controller.getState().draft.projectGoal).toBe("remote goal");
    expect(controller.getState().dirty).toBe(false);
    expect(controller.getState().error).toBeNull();
    expect(api.getProject).toHaveBeenCalledWith({ projectId });
    expect(api.getCommandResult).not.toHaveBeenCalled();
  });

  it("keeps over-limit raw input and refuses to save it", async () => {
    const api = fakeApi();
    const controller = new ProjectContextAutosave({ api, initial: settings() });
    const rawGoal = "g".repeat(4_097);

    controller.setDraft({ projectGoal: rawGoal, projectInstructions: "saved instructions" });

    expect(controller.getState().draft.projectGoal).toBe(rawGoal);
    expect(controller.getState().error?.code).toBe("validation");
    await expect(controller.flush()).resolves.toBe(false);
    expect(api.saveProject).not.toHaveBeenCalled();
  });

  it("adopts a remote refresh into both baseline and draft when the controller is clean", async () => {
    const api = fakeApi();
    const controller = new ProjectContextAutosave({ api, initial: settings() });
    const remote = settings({ projectGoal: "remote goal", revision: 1 });

    controller.receiveConfirmed(remote);

    expect(controller.getState().base.projectGoal).toBe("remote goal");
    expect(controller.getState().draft.projectGoal).toBe("remote goal");
    expect(controller.getState().dirty).toBe(false);
    await expect(controller.flush()).resolves.toBe(true);
    expect(api.saveProject).not.toHaveBeenCalled();
  });

  it("preserves the latest draft and pauses on a remote refresh during an in-flight save", async () => {
    const first = deferred<ContextCommandResult>();
    const remote = settings({ projectGoal: "remote edit", revision: 2 });
    const api = fakeApi({
      getProject: vi.fn(async () => remote),
      saveProject: vi
        .fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(async (input) =>
          savedResult(
            input.commandId,
            settings({
              projectGoal: input.projectGoal,
              projectInstructions: input.projectInstructions,
              revision: input.expectedRevision + 1,
            }),
          ),
        ),
    });
    const controller = new ProjectContextAutosave({ api, initial: settings() });
    controller.setDraft({ projectGoal: "in flight", projectInstructions: "saved instructions" });
    const flush = controller.flush();
    await Promise.resolve();
    const commandId = vi.mocked(api.saveProject).mock.calls[0]![0].commandId;

    controller.setDraft({ projectGoal: "newer draft", projectInstructions: "saved instructions" });
    controller.receiveConfirmed(remote);
    expect(controller.getState().base.projectGoal).toBe("remote edit");
    expect(controller.getState().draft.projectGoal).toBe("newer draft");
    expect(controller.getState().error?.code).toBe("conflict");

    first.resolve(savedResult(commandId, settings({ projectGoal: "in flight", revision: 1 })));
    await expect(flush).resolves.toBe(false);

    expect(controller.getState().draft.projectGoal).toBe("newer draft");
    expect(controller.getState().base.projectGoal).toBe("remote edit");
    expect(controller.getState().error?.code).toBe("conflict");
    expect(api.saveProject).toHaveBeenCalledTimes(1);

    await expect(controller.keepDraft()).resolves.toBe(true);
    expect(api.saveProject).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedRevision: 2, projectGoal: "newer draft" }),
    );
    expect(controller.getState().base.projectGoal).toBe("newer draft");
  });

  it("does not report stale text as queued or overwrite a remote refresh during its save", async () => {
    const first = deferred<ContextCommandResult>();
    const remote = settings({ projectGoal: "remote edit", revision: 2 });
    const api = fakeApi({
      saveProject: vi.fn().mockImplementationOnce(() => first.promise),
    });
    const controller = new ProjectContextAutosave({ api, initial: settings() });
    controller.setDraft({ projectGoal: "in flight", projectInstructions: "saved instructions" });
    const flush = controller.flush();
    await Promise.resolve();
    const commandId = vi.mocked(api.saveProject).mock.calls[0]![0].commandId;

    controller.receiveConfirmed(remote);

    expect(controller.getState().draft.projectGoal).toBe("in flight");
    expect(controller.getState().queued).toBe(false);
    expect(controller.getState().error?.code).toBe("conflict");
    first.resolve(savedResult(commandId, settings({ projectGoal: "in flight", revision: 1 })));
    await expect(flush).resolves.toBe(false);
    expect(api.saveProject).toHaveBeenCalledTimes(1);
    expect(controller.getState().base.projectGoal).toBe("remote edit");
    expect(controller.getState().draft.projectGoal).toBe("in flight");
  });

  it("keeps one controller per API connection, data instance, and project", () => {
    const api = fakeApi();
    const initial = settings();
    const first = getProjectContextAutosave(api, initial);
    const same = getProjectContextAutosave(api, settings({ projectGoal: "stale read" }));
    const anotherProject = getProjectContextAutosave(
      api,
      settings({ projectId: ProjectId.makeUnsafe("project-context-autosave-b") }),
    );
    const otherApi = getProjectContextAutosave(fakeApi(), initial);

    expect(same).toBe(first);
    expect(anotherProject).not.toBe(first);
    expect(otherApi).not.toBe(first);
  });
});
