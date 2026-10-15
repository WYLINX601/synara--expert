import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContextDemoAdapter,
  DemoError,
  type ContextConfig,
  type ContextFields,
} from "./ContextDemoAdapter";
import { ProjectContextAutosave } from "./ProjectContextAutosave";

function controllerFor(
  adapter: ContextDemoAdapter,
  projectId = "thesis",
  debounceMs?: number,
  save = (id: string, fields: ContextFields, revision: number) =>
    adapter.saveContext("project", id, fields, revision),
) {
  return new ProjectContextAutosave({
    projectId,
    initial: adapter.getProjectContext(projectId),
    save,
    read: (id) => adapter.getProjectContext(id),
    ...(debounceMs === undefined ? {} : { debounceMs }),
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await delay(0);
  }
  throw new Error("Condition did not become true in time");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("ProjectContextAutosave", () => {
  afterEach(() => vi.useRealTimers());

  it("waits 500ms, then submits both raw fields together", async () => {
    vi.useFakeTimers();
    const adapter = new ContextDemoAdapter({ delayMs: 0 });
    const initial = adapter.getProjectContext("thesis");
    const calls: Array<{ fields: ContextFields; expectedRevision: number }> = [];
    const controller = controllerFor(
      adapter,
      "thesis",
      undefined,
      async (_id, fields, revision) => {
        calls.push({ fields: { ...fields }, expectedRevision: revision });
        return {
          revision: revision + 1,
          goal: fields.goal,
          instructions: fields.instructions,
        };
      },
    );

    try {
      controller.setDraft({ goal: "  原样目标  ", instructions: initial.instructions });
      controller.setDraft({ goal: "  原样目标  ", instructions: "  原样指令\n" });
      await vi.advanceTimersByTimeAsync(499);
      expect(calls).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toEqual([
        {
          fields: { goal: "  原样目标  ", instructions: "  原样指令\n" },
          expectedRevision: initial.revision,
        },
      ]);
      expect(controller.getState()).toMatchObject({ status: "idle", dirty: false, saving: false });
    } finally {
      controller.dispose();
    }
  });

  it("serializes edits entered during a save and keeps the newer draft after the old acknowledgement", async () => {
    const adapter = new ContextDemoAdapter({ delayMs: 0 });
    const initial = adapter.getProjectContext("thesis");
    const pending: Array<{
      fields: ContextFields;
      revision: number;
      reply: ReturnType<typeof deferred<ContextConfig>>;
    }> = [];
    const controller = controllerFor(adapter, "thesis", 500, (_id, fields, revision) => {
      const reply = deferred<ContextConfig>();
      pending.push({ fields: { ...fields }, revision, reply });
      return reply.promise;
    });

    const firstDraft = { goal: "第一版草稿", instructions: "第一版指令" };
    const latestDraft = { goal: "最新草稿", instructions: "最新指令" };
    controller.setDraft(firstDraft);
    const flushPromise = controller.flush();
    await waitUntil(() => pending.length === 1);
    expect(controller.getState()).toMatchObject({ status: "saving", saving: true });

    controller.setDraft(latestDraft);
    expect(controller.getState()).toMatchObject({ queued: true, draft: latestDraft });
    pending[0]!.reply.resolve({ revision: initial.revision + 1, ...firstDraft });
    await waitUntil(() => pending.length === 2);
    expect(pending[1]).toMatchObject({ fields: latestDraft, revision: initial.revision + 1 });
    pending[1]!.reply.resolve({ revision: initial.revision + 2, ...latestDraft });

    expect(await flushPromise).toBe(true);
    expect(controller.getState()).toMatchObject({
      base: { revision: initial.revision + 2, ...latestDraft },
      draft: latestDraft,
      status: "idle",
      queued: false,
    });
    controller.dispose();
  });

  it("pauses after a definite failure, retains the draft, and retries only on request", async () => {
    const adapter = new ContextDemoAdapter({ delayMs: 0 });
    const calls: Array<{ fields: ContextFields; revision: number }> = [];
    const controller = controllerFor(adapter, "thesis", 10, (id, fields, revision) => {
      calls.push({ fields: { ...fields }, revision });
      return adapter.saveContext("project", id, fields, revision);
    });
    const draft = { goal: "保留的目标草稿", instructions: "保留的指令草稿" };
    adapter.setNextSave("failure");
    controller.setDraft(draft);

    expect(await controller.flush()).toBe(false);
    expect(controller.getState()).toMatchObject({
      status: "error",
      error: { code: "failure" },
      draft,
    });
    await delay(25);
    expect(calls).toHaveLength(1);

    expect(await controller.retry()).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.fields).toEqual(draft);
    expect(controller.getState()).toMatchObject({ status: "idle", base: draft, draft });
    controller.dispose();
  });

  it("reconciles CAS conflicts and makes keepDraft or useSaved an explicit decision", async () => {
    const adapter = new ContextDemoAdapter({ delayMs: 0 });
    const controller = controllerFor(adapter, "thesis", 10);
    const draft = { goal: "我的草稿目标", instructions: "我的草稿指令" };
    adapter.setNextSave("conflict");
    controller.setDraft(draft);

    expect(await controller.flush()).toBe(false);
    expect(controller.getState()).toMatchObject({
      status: "conflict",
      error: { code: "conflict" },
      base: { goal: expect.stringContaining("[另一处编辑]") },
      draft,
    });
    expect(await controller.keepDraft()).toBe(true);
    expect(controller.getState()).toMatchObject({ status: "idle", base: draft, draft });
    controller.dispose();

    const useSavedAdapter = new ContextDemoAdapter({ delayMs: 0 });
    const useSavedController = controllerFor(useSavedAdapter, "thesis");
    useSavedAdapter.setNextSave("conflict");
    useSavedController.setDraft(draft);
    expect(await useSavedController.flush()).toBe(false);
    const external = useSavedAdapter.getProjectContext("thesis");
    expect(await useSavedController.useSaved()).toBe(true);
    expect(useSavedController.getState()).toMatchObject({
      status: "idle",
      base: external,
      draft: { goal: external.goal, instructions: external.instructions },
    });
    useSavedController.dispose();
  });

  it("verifies a lost acknowledgement by reading the committed value instead of retrying", async () => {
    const adapter = new ContextDemoAdapter({ delayMs: 0 });
    let saveCalls = 0;
    const controller = controllerFor(adapter, "thesis", 10, (id, fields, revision) => {
      saveCalls += 1;
      return adapter.saveContext("project", id, fields, revision);
    });
    const draft = { goal: "已提交目标", instructions: "已提交指令" };
    adapter.setNextSaveAckLost(true);
    controller.setDraft(draft);

    expect(await controller.flush()).toBe(true);
    expect(saveCalls).toBe(1);
    expect(controller.getState()).toMatchObject({
      status: "idle",
      dirty: false,
      base: { revision: 2, ...draft },
      draft,
      error: null,
    });
    expect(adapter.getProjectContext("thesis")).toMatchObject({ revision: 2, ...draft });
    controller.dispose();
  });

  it("does not report flush complete before an in-flight write is reconciled", async () => {
    const adapter = new ContextDemoAdapter({ delayMs: 0 });
    const initial = adapter.getProjectContext("thesis");
    const request = deferred<ContextConfig>();
    const controller = controllerFor(adapter, "thesis", 500, () => request.promise);
    controller.setDraft({ goal: "正在发送的草稿", instructions: initial.instructions });
    const inFlight = controller.flush();
    await waitUntil(() => controller.getState().saving);
    controller.setDraft({ goal: "g".repeat(4097), instructions: "保留超限输入" });

    let settled = false;
    const closing = controller.flush().then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    request.resolve({
      revision: initial.revision + 1,
      goal: "正在发送的草稿",
      instructions: initial.instructions,
    });
    expect(await inFlight).toBe(false);
    expect(await closing).toBe(false);
    expect(controller.getState()).toMatchObject({
      base: { goal: "正在发送的草稿", revision: initial.revision + 1 },
      draft: { goal: "g".repeat(4097), instructions: "保留超限输入" },
      error: { code: "validation" },
    });
    controller.dispose();
  });

  it("keeps an unverified write blocked when readback fails and never retries by itself", async () => {
    let saveCalls = 0;
    let readCalls = 0;
    const initial = { revision: 1, goal: "初始", instructions: "初始指令" };
    const controller = new ProjectContextAutosave({
      projectId: "fixed-project",
      initial,
      debounceMs: 5,
      save: async () => {
        saveCalls += 1;
        throw new DemoError("failure", "确认响应不明确。", true);
      },
      read: () => {
        readCalls += 1;
        throw new Error("读回暂不可用");
      },
    });
    controller.setDraft({ goal: "可能已经提交", instructions: "先不要重发" });

    expect(await controller.flush()).toBe(false);
    expect(controller.getState()).toMatchObject({
      status: "error",
      error: { outcomeUncertain: true },
      draft: { goal: "可能已经提交", instructions: "先不要重发" },
    });
    await delay(20);
    expect(saveCalls).toBe(1);
    expect(readCalls).toBe(1);
    controller.dispose();
  });

  it("keeps over-limit text intact, pauses autosave, and resumes after the draft is corrected", async () => {
    const adapter = new ContextDemoAdapter({ delayMs: 0 });
    let saveCalls = 0;
    const controller = controllerFor(adapter, "thesis", 5, (id, fields, revision) => {
      saveCalls += 1;
      return adapter.saveContext("project", id, fields, revision);
    });
    const oversized = { goal: "g".repeat(4097), instructions: "draft" };
    controller.setDraft(oversized);
    expect(controller.getState()).toMatchObject({
      status: "error",
      error: { code: "validation" },
      draft: oversized,
    });
    expect(await controller.flush()).toBe(false);
    await delay(15);
    expect(saveCalls).toBe(0);

    const corrected = { goal: "g".repeat(4096), instructions: "draft" };
    controller.setDraft(corrected);
    expect(await controller.flush()).toBe(true);
    expect(saveCalls).toBe(1);
    expect(adapter.getProjectContext("thesis")).toMatchObject(corrected);
    controller.dispose();
  });

  it("flushes before switching fixed project targets", async () => {
    const adapter = new ContextDemoAdapter({ delayMs: 0 });
    const thesis = controllerFor(adapter, "thesis", 500);
    const thesisDraft = { goal: "论文目标", instructions: "论文指令" };
    thesis.setDraft(thesisDraft);
    expect(await thesis.flush()).toBe(true);
    thesis.dispose();

    const inbox = controllerFor(adapter, "inbox", 500);
    const inboxDraft = { goal: "自由项目目标", instructions: "自由项目指令" };
    inbox.setDraft(inboxDraft);
    expect(await inbox.flush()).toBe(true);
    expect(inbox.getState().projectId).toBe("inbox");
    expect(adapter.getProjectContext("thesis")).toMatchObject(thesisDraft);
    expect(adapter.getProjectContext("inbox")).toMatchObject(inboxDraft);
    inbox.dispose();
  });

  it("discards unsent drafts and reconciles a sent write before dropping a queued draft", async () => {
    const adapter = new ContextDemoAdapter({ delayMs: 0 });
    let unsentSaveCount = 0;
    const unsent = controllerFor(adapter, "thesis", 25, (id, fields, revision) => {
      unsentSaveCount += 1;
      return adapter.saveContext("project", id, fields, revision);
    });
    const original = adapter.getProjectContext("thesis");
    unsent.setDraft({ goal: "还没有发送的草稿", instructions: "也没有发送" });
    expect(await unsent.discard()).toBe(true);
    await delay(35);
    expect(unsentSaveCount).toBe(0);
    expect(unsent.getState()).toMatchObject({
      status: "idle",
      base: original,
      draft: { goal: original.goal, instructions: original.instructions },
    });
    unsent.dispose();

    const initial: ContextConfig = { revision: 1, goal: "初始", instructions: "初始指令" };
    let server = { ...initial };
    let saveCount = 0;
    const sent = new ProjectContextAutosave({
      projectId: "fixed-project",
      initial,
      debounceMs: 0,
      read: () => ({ ...server }),
      save: (_id, fields, revision) => {
        saveCount += 1;
        return new Promise((resolve) => {
          setTimeout(() => {
            server = { revision: revision + 1, ...fields };
            resolve({ ...server });
          }, 15);
        });
      },
    });
    sent.setDraft({ goal: "已经发送", instructions: "已经发送的指令" });
    await waitUntil(() => saveCount === 1);
    sent.setDraft({ goal: "尚未发送", instructions: "应随 discard 放弃" });
    const discardPromise = sent.discard();
    await Promise.resolve();
    expect(server.goal).toBe("初始");
    expect(await discardPromise).toBe(true);
    expect(server).toMatchObject({ revision: 2, goal: "已经发送", instructions: "已经发送的指令" });
    expect(saveCount).toBe(1);
    expect(sent.getState()).toMatchObject({
      base: server,
      draft: { goal: server.goal, instructions: server.instructions },
      status: "idle",
      queued: false,
    });
    sent.dispose();
  });

  it("dispose cancels an unsent debounce without submitting", async () => {
    const adapter = new ContextDemoAdapter({ delayMs: 0 });
    let saveCalls = 0;
    const controller = controllerFor(adapter, "thesis", 15, (id, fields, revision) => {
      saveCalls += 1;
      return adapter.saveContext("project", id, fields, revision);
    });
    controller.setDraft({ goal: "dispose 前草稿", instructions: "不要自动提交" });
    controller.dispose();
    await delay(25);
    expect(saveCalls).toBe(0);
    expect(controller.getState().status).toBe("disposed");
  });
});
