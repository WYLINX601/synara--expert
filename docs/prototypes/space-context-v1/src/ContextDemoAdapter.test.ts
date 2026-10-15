import { describe, expect, it } from "vitest";
import { ContextDemoAdapter, DemoError } from "./ContextDemoAdapter";

function findThread(adapter: ContextDemoAdapter, id: string) {
  const thread = adapter.getState().threads.find((item) => item.id === id);
  if (!thread) throw new Error(`Thread ${id} is missing`);
  return thread;
}

function findProject(adapter: ContextDemoAdapter, id: string) {
  const project = adapter.getState().projects.find((item) => item.id === id);
  if (!project) throw new Error(`Project ${id} is missing`);
  return project;
}

function findMigration(adapter: ContextDemoAdapter, id: string) {
  const migration = adapter.getState().migrations.find((item) => item.id === id);
  if (!migration) throw new Error(`Migration ${id} is missing`);
  return migration;
}

async function claimAndResolveThesis(
  adapter: ContextDemoAdapter,
  choice: "server" | "local" = "local",
) {
  await adapter.claimMigrations();
  await adapter.resolveMigration("migration-thesis", choice);
}

describe("ContextDemoAdapter", () => {
  it("publishes stable immutable state and keeps a thread's captured context independent", async () => {
    const adapter = new ContextDemoAdapter({ delayMs: 0 });
    const notifications: number[] = [];
    const unsubscribe = adapter.subscribe(() => notifications.push(notifications.length + 1));
    const initial = adapter.getState();

    expect(adapter.getState()).toBe(initial);
    expect(Object.isFrozen(initial)).toBe(true);
    expect(Object.isFrozen(initial.projects[0])).toBe(true);
    expect(() => {
      (initial.projects[0]!.context as { goal: string }).goal = "mutated";
    }).toThrow();

    await claimAndResolveThesis(adapter);
    const threadId = adapter.createThread("thesis");
    await adapter.send(threadId, "开始整理证据");
    const boundState = adapter.getState();
    const snapshot = findThread(adapter, threadId).snapshot;
    expect(snapshot).not.toBeNull();
    expect(adapter.isStale(threadId)).toBe(false);

    const thesis = findProject(adapter, "thesis");
    await adapter.saveContext(
      "project",
      thesis.id,
      { goal: "更新后的目标。", instructions: thesis.context.instructions },
      thesis.context.revision,
    );

    expect(adapter.getState()).not.toBe(boundState);
    expect(boundState.projects.find((item) => item.id === "thesis")?.context.goal).toBe(
      "建立景宁畲族传统民居风貌特征的证据链。",
    );
    expect(findThread(adapter, threadId).snapshot).toBe(snapshot);
    expect(findThread(adapter, threadId).snapshot?.project.goal).toBe(
      "建立景宁畲族传统民居风貌特征的证据链。",
    );
    expect(adapter.isStale(threadId)).toBe(true);
    expect(notifications.length).toBeGreaterThan(1);

    unsubscribe();
  });

  it("uses compare-and-swap saves, preserves drafts on failure, and commits a visible simulated conflict", async () => {
    const adapter = new ContextDemoAdapter({ delayMs: 0 });
    const project = findProject(adapter, "thesis");
    const unchanged = await adapter.saveContext(
      "project",
      project.id,
      { goal: project.context.goal, instructions: project.context.instructions },
      project.context.revision,
    );
    expect(unchanged.revision).toBe(project.context.revision);

    adapter.setNextSave("failure");
    await expect(
      adapter.saveContext(
        "project",
        project.id,
        { goal: "本地草稿不应覆盖已保存内容。", instructions: project.context.instructions },
        project.context.revision,
      ),
    ).rejects.toMatchObject({ code: "failure" });
    expect(findProject(adapter, "thesis").context).toEqual(project.context);
    expect(adapter.getState().nextSave).toBe("normal");

    adapter.setNextSave("conflict");
    await expect(
      adapter.saveContext(
        "project",
        project.id,
        { goal: "草稿", instructions: project.context.instructions },
        project.context.revision,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    const conflicted = findProject(adapter, "thesis").context;
    expect(conflicted.goal).toBe(`[另一处编辑] ${project.context.goal}`);
    expect(conflicted.revision).toBe(project.context.revision + 1);
    expect(conflicted.instructions).toBe(project.context.instructions);

    await expect(
      adapter.saveContext(
        "project",
        project.id,
        { goal: "stale write", instructions: "" },
        project.context.revision,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(findProject(adapter, "thesis").context).toEqual(conflicted);
  });

  it("holds the first message and snapshot across load failure, then retries once against that snapshot", async () => {
    const adapter = new ContextDemoAdapter({ delayMs: 0 });
    await claimAndResolveThesis(adapter);
    const threadId = adapter.createThread("thesis");
    const sourceBeforeSend = findProject(adapter, "thesis").context;
    adapter.setNextLoad("failure");

    await expect(adapter.send(threadId, "请总结已有证据")).rejects.toMatchObject({
      code: "failure",
    });
    const failed = findThread(adapter, threadId);
    const originalSnapshot = failed.snapshot;
    expect(failed.mode).toBe("bound");
    expect(failed.applied).toMatchObject({ status: "failed", generation: 1 });
    expect(failed.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "请总结已有证据"],
    ]);
    expect(originalSnapshot?.project).toEqual(sourceBeforeSend);

    const currentSource = findProject(adapter, "thesis").context;
    await adapter.saveContext(
      "project",
      "thesis",
      { goal: "源已经发生变化。", instructions: currentSource.instructions },
      currentSource.revision,
    );
    expect(adapter.isStale(threadId)).toBe(true);

    await adapter.retryLoad(threadId);
    const loaded = findThread(adapter, threadId);
    expect(loaded.snapshot).toBe(originalSnapshot);
    expect(loaded.applied).toMatchObject({ status: "loaded", generation: 2, error: null });
    expect(loaded.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(loaded.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
    await expect(adapter.retryLoad(threadId)).rejects.toMatchObject({ code: "validation" });
    expect(findThread(adapter, threadId).messages).toHaveLength(2);
  });

  it("rejects Claude before binding or adding a message when saved context is nonempty", async () => {
    const adapter = new ContextDemoAdapter({ delayMs: 0 });
    await claimAndResolveThesis(adapter);
    const selected = adapter.createThread("thesis", "claude");
    await expect(adapter.send(selected, "请分析")).rejects.toMatchObject({ code: "validation" });
    expect(findThread(adapter, selected)).toMatchObject({
      mode: "new",
      snapshot: null,
      messages: [],
      applied: { status: "idle", generation: 0, error: null },
    });

    const threadId = adapter.createThread("thesis");
    expect(() => adapter.setThreadProvider(threadId, "claude")).toThrow(DemoError);
    expect(findThread(adapter, threadId).provider).toBe("codex");

    const legacyId = "thread-thesis-legacy";
    await adapter.send(legacyId, "继续旧对话");
    const legacy = findThread(adapter, legacyId);
    expect(legacy).toMatchObject({ mode: "legacy", snapshot: null });
    const legacyReply = legacy.messages.at(-1)?.text ?? "";
    expect(legacyReply).toContain("未补入新的 Space/Project 上下文");
    expect(legacyReply).not.toContain("固定的上下文副本");
  });

  it("blocks only new threads with unresolved project migrations, then keeps resolved snapshots pinned", async () => {
    for (const choice of ["server", "local"] as const) {
      const adapter = new ContextDemoAdapter({ delayMs: 0 });
      const thesisThreadId = adapter.createThread("thesis");

      // Provider selection remains available before a first-send migration decision.
      adapter.setThreadProvider(thesisThreadId, "pi");
      await expect(adapter.send(thesisThreadId, "先处理迁移")).rejects.toMatchObject({
        code: "validation",
        message: expect.stringContaining("迁移"),
      });
      expect(findThread(adapter, thesisThreadId)).toMatchObject({
        provider: "pi",
        mode: "new",
        snapshot: null,
        messages: [],
      });

      const inboxThreadId = adapter.createThread("inbox");
      await adapter.send(inboxThreadId, "先探索自由项目");
      expect(findThread(adapter, inboxThreadId).applied.status).toBe("loaded");

      await adapter.claimMigrations();
      expect(findMigration(adapter, "migration-thesis").status).toBe("conflict");
      await expect(adapter.send(thesisThreadId, "再次尝试")).rejects.toMatchObject({
        code: "validation",
      });
      expect(findThread(adapter, thesisThreadId).messages).toHaveLength(0);

      await adapter.resolveMigration("migration-thesis", choice);
      const instructionsAtBinding = findProject(adapter, "thesis").context.instructions;
      await adapter.send(thesisThreadId, "迁移已确认，可以开始");
      const boundThread = findThread(adapter, thesisThreadId);
      const snapshot = boundThread.snapshot;
      expect(snapshot?.project.instructions).toBe(instructionsAtBinding);
      expect(boundThread.applied.status).toBe("loaded");

      const project = findProject(adapter, "thesis");
      await adapter.saveContext(
        "project",
        project.id,
        { goal: "迁移确认后的新目标。", instructions: project.context.instructions },
        project.context.revision,
      );
      await adapter.claimMigrations();
      await adapter.send(thesisThreadId, "继续使用已绑定的对话");

      expect(findMigration(adapter, "migration-thesis").status).toBe("completed");
      expect(findThread(adapter, thesisThreadId).snapshot).toBe(snapshot);
      expect(findThread(adapter, thesisThreadId).messages).toHaveLength(4);
      expect(adapter.isStale(thesisThreadId)).toBe(true);
    }
  });

  it("claims legacy instructions explicitly and resolves conflicts with revision checks and readback", async () => {
    const adapter = new ContextDemoAdapter({ delayMs: 0 });
    expect(adapter.getState().migrations.every((item) => item.status === "unclaimed")).toBe(true);

    await adapter.claimMigrations();
    const literature = findProject(adapter, "literature");
    expect(literature.context.goal).toBe("整理建筑与地域文化相关文献。");
    expect(literature.context.instructions).toBe(
      findMigration(adapter, "migration-literature").localInstructions,
    );
    expect(literature.context.revision).toBe(2);
    expect(findMigration(adapter, "migration-literature").status).toBe("completed");
    expect(findMigration(adapter, "migration-thesis").status).toBe("conflict");
    expect(findMigration(adapter, "migration-work").status).toBe("completed");
    expect(findProject(adapter, "work").context.revision).toBe(1);

    const thesis = findProject(adapter, "thesis");
    await adapter.saveContext(
      "project",
      thesis.id,
      { goal: "用户后来确认的新目标。", instructions: thesis.context.instructions },
      thesis.context.revision,
    );
    await expect(adapter.resolveMigration("migration-thesis", "local")).rejects.toMatchObject({
      code: "conflict",
    });
    expect(findMigration(adapter, "migration-thesis")).toMatchObject({
      status: "conflict",
      expectedRevision: 2,
    });

    await adapter.resolveMigration("migration-thesis", "local");
    expect(findProject(adapter, "thesis").context).toMatchObject({
      revision: 3,
      goal: "用户后来确认的新目标。",
      instructions: findMigration(adapter, "migration-thesis").localInstructions,
    });
    expect(findMigration(adapter, "migration-thesis")).toMatchObject({
      status: "completed",
      expectedRevision: 3,
    });
  });

  it("saves all Space fields atomically and increments context revision only for context edits", async () => {
    const adapter = new ContextDemoAdapter({ delayMs: 0 });
    const original = adapter.getState().spaces.find((item) => item.id === "research");
    if (!original) throw new Error("Research Space is missing");

    const saved = await adapter.saveSpace(
      original.id,
      {
        name: "研究空间",
        icon: "book",
        goal: "新的空间目标",
        instructions: "新的空间指令",
      },
      original.context.revision,
    );
    expect(saved).toMatchObject({
      name: "研究空间",
      icon: "book",
      context: { revision: 2, goal: "新的空间目标", instructions: "新的空间指令" },
    });

    const metadataOnly = await adapter.saveSpace(
      saved.id,
      {
        name: "研究空间二",
        icon: "notebook",
        goal: saved.context.goal,
        instructions: saved.context.instructions,
      },
      saved.context.revision,
    );
    expect(metadataOnly.name).toBe("研究空间二");
    expect(metadataOnly.icon).toBe("notebook");
    expect(metadataOnly.context.revision).toBe(saved.context.revision);

    const beforeFailure = adapter.getState().spaces.find((item) => item.id === saved.id);
    if (!beforeFailure) throw new Error("Saved Space is missing");
    adapter.setNextSave("failure");
    await expect(
      adapter.saveSpace(
        saved.id,
        { name: "失败名称", icon: "failure", goal: "失败目标", instructions: "失败指令" },
        beforeFailure.context.revision,
      ),
    ).rejects.toMatchObject({ code: "failure" });
    expect(adapter.getState().spaces.find((item) => item.id === saved.id)).toEqual(beforeFailure);

    adapter.setNextSave("conflict");
    await expect(
      adapter.saveSpace(
        saved.id,
        { name: "冲突名称", icon: "conflict", goal: "冲突目标", instructions: "冲突指令" },
        beforeFailure.context.revision,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(adapter.getState().spaces.find((item) => item.id === saved.id)).toMatchObject({
      name: beforeFailure.name,
      icon: beforeFailure.icon,
      context: {
        revision: beforeFailure.context.revision + 1,
        goal: `[另一处编辑] ${beforeFailure.context.goal}`,
        instructions: beforeFailure.context.instructions,
      },
    });
  });

  it("does not overwrite a concurrent Space metadata edit during an atomic save", async () => {
    const adapter = new ContextDemoAdapter({ delayMs: 10 });
    const before = adapter.getState().spaces.find((item) => item.id === "research");
    if (!before) throw new Error("Research Space is missing");
    const save = adapter.saveSpace(
      before.id,
      {
        name: "本地名称草稿",
        icon: "local-icon",
        goal: "本地目标草稿",
        instructions: "本地指令草稿",
      },
      before.context.revision,
    );
    adapter.renameSpace(before.id, "另一处名称", "other-icon");

    await expect(save).rejects.toMatchObject({ code: "conflict" });
    expect(adapter.getState().spaces.find((item) => item.id === before.id)).toMatchObject({
      name: "另一处名称",
      icon: "other-icon",
      context: before.context,
    });
  });

  it("rejects Space saves opened from metadata that changed before the save call", async () => {
    const adapter = new ContextDemoAdapter({ delayMs: 0 });
    const openedFrom = adapter.getState().spaces.find((item) => item.id === "research");
    if (!openedFrom) throw new Error("Research Space is missing");
    adapter.renameSpace(openedFrom.id, "其他位置的新名称", "book");

    await expect(
      adapter.saveSpace(
        openedFrom.id,
        {
          name: openedFrom.name,
          icon: openedFrom.icon,
          goal: "弹窗里的新目标",
          instructions: openedFrom.context.instructions,
        },
        openedFrom.context.revision,
        { name: openedFrom.name, icon: openedFrom.icon },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(adapter.getState().spaces.find((item) => item.id === openedFrom.id)).toMatchObject({
      name: "其他位置的新名称",
      icon: "book",
      context: openedFrom.context,
    });
  });

  it("reports a one-shot lost save acknowledgement only after committing the saved context", async () => {
    const adapter = new ContextDemoAdapter({ delayMs: 0 });
    const before = findProject(adapter, "thesis").context;
    adapter.setNextSaveAckLost(true);
    await expect(
      adapter.saveContext(
        "project",
        "thesis",
        { goal: "已提交但确认丢失", instructions: before.instructions },
        before.revision,
      ),
    ).rejects.toMatchObject({ code: "failure", outcomeUncertain: true });
    expect(findProject(adapter, "thesis").context).toMatchObject({
      revision: before.revision + 1,
      goal: "已提交但确认丢失",
    });
    expect(adapter.getState().nextSaveAckLost).toBe(false);
  });

  it("enforces hard field limits without truncating or changing the saved source", async () => {
    const adapter = new ContextDemoAdapter({ delayMs: 0 });
    const before = findProject(adapter, "thesis").context;
    await expect(
      adapter.saveContext(
        "project",
        "thesis",
        { goal: "x".repeat(4097), instructions: before.instructions },
        before.revision,
      ),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      adapter.saveContext(
        "project",
        "thesis",
        { goal: before.goal, instructions: "x".repeat(16385) },
        before.revision,
      ),
    ).rejects.toMatchObject({ code: "validation" });
    expect(findProject(adapter, "thesis").context).toEqual(before);

    const saved = await adapter.saveContext(
      "project",
      "thesis",
      { goal: "x".repeat(4096), instructions: "y".repeat(16384) },
      before.revision,
    );
    expect(saved.goal).toHaveLength(4096);
    expect(saved.instructions).toHaveLength(16384);
    expect(saved.revision).toBe(before.revision + 1);
  });
});
