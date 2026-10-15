export type ContextFields = {
  goal: string;
  instructions: string;
};

export type ContextConfig = ContextFields & {
  revision: number;
};

export type SpaceContextSaveFields = ContextFields & {
  name: string;
  icon: string;
};

export type DemoSpace = {
  id: string;
  name: string;
  icon: string;
  sortOrder: number;
  context: ContextConfig;
};

export type DemoProject = {
  id: string;
  name: string;
  spaceId: string | null;
  context: ContextConfig;
};

export type DemoProvider = "codex" | "pi" | "claude";

export type ContextSnapshot = {
  id: string;
  projectId: string;
  projectName: string;
  spaceId: string | null;
  spaceName: string | null;
  space: ContextConfig | null;
  project: ContextConfig;
  hash: string;
  createdAt: string;
};

export type DemoMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

export type DemoThread = {
  id: string;
  projectId: string;
  title: string;
  provider: DemoProvider;
  mode: "new" | "bound" | "legacy";
  snapshot: ContextSnapshot | null;
  applied: {
    status: "idle" | "loading" | "loaded" | "failed";
    generation: number;
    error: string | null;
  };
  messages: DemoMessage[];
};

export type DemoMigration = {
  id: string;
  projectId: string;
  localInstructions: string;
  status: "unclaimed" | "pending" | "conflict" | "completed";
  expectedRevision: number | null;
};

export type DemoState = {
  spaces: DemoSpace[];
  projects: DemoProject[];
  threads: DemoThread[];
  migrations: DemoMigration[];
  nextSave: "normal" | "failure" | "conflict";
  nextSaveAckLost: boolean;
  nextLoad: "normal" | "failure";
};

export type DemoErrorCode = "failure" | "conflict" | "validation";

export class DemoError extends Error {
  readonly code: DemoErrorCode;
  readonly outcomeUncertain: boolean;

  constructor(code: DemoErrorCode, message: string, outcomeUncertain = false) {
    super(message);
    this.name = "DemoError";
    this.code = code;
    this.outcomeUncertain = outcomeUncertain;
  }
}

type ContextKind = "space" | "project";
type SaveMode = DemoState["nextSave"];
type LoadMode = DemoState["nextLoad"];

type PendingMessage = {
  messageId: string;
  text: string;
};

type AdapterOptions = {
  delayMs?: number;
};

export const CONTEXT_GOAL_MAX_LENGTH = 4096;
export const CONTEXT_INSTRUCTIONS_MAX_LENGTH = 16384;
const SAVE_DELAY_MS = 250;
const LOAD_DELAY_MS = 400;
const CONFLICT_PREFIX = "[另一处编辑] ";

function context(revision: number, goal: string, instructions: string): ContextConfig {
  return { revision, goal, instructions };
}

function initialState(): DemoState {
  const spaces: DemoSpace[] = [
    {
      id: "research",
      name: "学术研究",
      icon: "bag",
      sortOrder: 0,
      context: context(
        1,
        "梳理景宁畲族传统民居的空间、构造与风貌特征。",
        "优先标注材料来源、案例地点与证据页码；区分文献陈述和研究者判断。",
      ),
    },
    {
      id: "product",
      name: "产品工作",
      icon: "bag",
      sortOrder: 1,
      context: context(
        1,
        "形成可验证、可交付的产品方案。",
        "先写清目标用户、触发场景与成功指标；方案需要标注假设和待验证项。",
      ),
    },
  ];

  const projects: DemoProject[] = [
    {
      id: "thesis",
      name: "硕士论文",
      spaceId: "research",
      context: context(
        1,
        "建立景宁畲族传统民居风貌特征的证据链。",
        "围绕村落—聚落—建筑三个尺度组织材料；避免把单个案例结论扩大为县域或族群普遍特征。",
      ),
    },
    {
      id: "literature",
      name: "文献整理",
      spaceId: "research",
      context: context(1, "整理建筑与地域文化相关文献。", ""),
    },
    {
      id: "work",
      name: "产品方案",
      spaceId: "product",
      context: context(
        1,
        "梳理一个可落地的 AI 产品方案。",
        "每个建议明确用户问题、使用场景、关键流程和衡量指标。",
      ),
    },
    {
      id: "inbox",
      name: "自由探索",
      spaceId: null,
      context: context(1, "快速收集尚未归类的想法。", ""),
    },
  ];

  const threads: DemoThread[] = [
    {
      id: "thread-thesis-new",
      projectId: "thesis",
      title: "新对话",
      provider: "codex",
      mode: "new",
      snapshot: null,
      applied: { status: "idle", generation: 0, error: null },
      messages: [],
    },
    {
      id: "thread-thesis-legacy",
      projectId: "thesis",
      title: "旧对话示例",
      provider: "codex",
      mode: "legacy",
      snapshot: null,
      applied: { status: "idle", generation: 0, error: null },
      messages: [
        {
          id: "legacy-user-1",
          role: "user",
          text: "这段旧对话会自动继承新的项目上下文吗？",
        },
        {
          id: "legacy-assistant-1",
          role: "assistant",
          text: "旧对话保留原有内容；新上下文从新建对话开始生效。",
        },
      ],
    },
  ];

  const migrations: DemoMigration[] = [
    {
      id: "migration-literature",
      projectId: "literature",
      localInstructions:
        "为每篇文献记录研究问题、方法、主要证据与页码，并写明与本研究的关联及适用边界。",
      status: "unclaimed",
      expectedRevision: null,
    },
    {
      id: "migration-thesis",
      projectId: "thesis",
      localInstructions: "突出地方特色，尽量形成鲜明的畲族建筑特征。",
      status: "unclaimed",
      expectedRevision: null,
    },
    {
      id: "migration-work",
      projectId: "work",
      localInstructions: "每个建议明确用户问题、使用场景、关键流程和衡量指标。",
      status: "unclaimed",
      expectedRevision: null,
    },
  ];

  return {
    spaces,
    projects,
    threads,
    migrations,
    nextSave: "normal",
    nextSaveAckLost: false,
    nextLoad: "normal",
  };
}

function freezeTree<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      freezeTree(child);
    }
    Object.freeze(value);
  }
  return value;
}

function copyContext(value: ContextConfig): ContextConfig {
  return { revision: value.revision, goal: value.goal, instructions: value.instructions };
}

function validateFields(fields: ContextFields): void {
  if (!fields || typeof fields.goal !== "string" || typeof fields.instructions !== "string") {
    throw new DemoError("validation", "目标和指令都必须是文本。");
  }
  if (fields.goal.length > CONTEXT_GOAL_MAX_LENGTH) {
    throw new DemoError("validation", `目标最多 ${CONTEXT_GOAL_MAX_LENGTH} 个字符。`);
  }
  if (fields.instructions.length > CONTEXT_INSTRUCTIONS_MAX_LENGTH) {
    throw new DemoError("validation", `指令最多 ${CONTEXT_INSTRUCTIONS_MAX_LENGTH} 个字符。`);
  }
}

function hashContext(value: unknown): string {
  const serialized = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `demo-fnv1a-v1-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function pause(durationMs: number): Promise<void> {
  if (durationMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function requireName(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DemoError("validation", `${label}不能为空。`);
  }
}

/**
 * An in-memory adapter for the interactive Space Context V1 prototype.
 * State snapshots are immutable and retain object identity until a publish,
 * so they are safe to pass directly to useSyncExternalStore.
 */
export class ContextDemoAdapter {
  private state: DemoState;
  private readonly listeners = new Set<() => void>();
  private readonly pendingMessages = new Map<string, PendingMessage>();
  private readonly activeOperations = new Map<string, object>();
  private readonly delayOverrideMs: number | null;
  private nextThreadNumber = 1;
  private nextMessageNumber = 1;
  private nextSnapshotNumber = 1;
  private nextSpaceNumber = 1;
  private epoch = 0;

  constructor(options: AdapterOptions = {}) {
    this.delayOverrideMs =
      typeof options.delayMs === "number" && Number.isFinite(options.delayMs)
        ? Math.max(0, options.delayMs)
        : null;
    this.state = freezeTree(initialState());
  }

  getState = (): DemoState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  setNextSave(mode: SaveMode): void {
    this.replaceState({ ...this.state, nextSave: mode });
  }

  setNextLoad(mode: LoadMode): void {
    this.replaceState({ ...this.state, nextLoad: mode });
  }

  setNextSaveAckLost(enabled: boolean): void {
    if (this.state.nextSaveAckLost === enabled) return;
    this.replaceState({ ...this.state, nextSaveAckLost: enabled });
  }

  getProjectContext(projectId: string): ContextConfig {
    return copyContext(this.requireProject(projectId).context);
  }

  async saveContext(
    kind: ContextKind,
    id: string,
    fields: ContextFields,
    expectedRevision: number,
  ): Promise<ContextConfig> {
    validateFields(fields);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new DemoError("validation", "保存版本无效。刷新后重试。");
    }
    this.readContext(kind, id);
    const saveMode = this.takeNextSave();
    await pause(this.delayOverrideMs ?? SAVE_DELAY_MS);

    const latest = this.readContext(kind, id);
    if (saveMode === "failure") {
      throw new DemoError("failure", "模拟保存失败。草稿仍保留在编辑器中。");
    }
    if (saveMode === "conflict") {
      const external: ContextConfig = {
        revision: latest.revision + 1,
        goal: `${CONFLICT_PREFIX}${latest.goal}`,
        instructions: latest.instructions,
      };
      this.writeContext(kind, id, external);
      throw new DemoError("conflict", "检测到另一处编辑，已保留最新版本。请比较后重试。");
    }
    if (latest.revision !== expectedRevision) {
      throw new DemoError("conflict", "内容已在另一处更新。请刷新后重试。");
    }
    if (latest.goal === fields.goal && latest.instructions === fields.instructions) {
      return copyContext(latest);
    }

    const saved = {
      revision: latest.revision + 1,
      goal: fields.goal,
      instructions: fields.instructions,
    };
    const ackLost = this.state.nextSaveAckLost;
    this.writeContext(kind, id, saved, ackLost);
    if (ackLost) {
      throw new DemoError("failure", "保存已完成，但确认响应丢失。请核对当前已保存内容。", true);
    }
    return copyContext(saved);
  }

  async saveSpace(
    id: string,
    fields: SpaceContextSaveFields,
    expectedRevision: number,
    expectedMetadata?: Pick<DemoSpace, "name" | "icon">,
  ): Promise<DemoSpace> {
    requireName(fields.name, "空间名称");
    requireName(fields.icon, "空间图标");
    validateFields(fields);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new DemoError("validation", "保存版本无效。刷新后重试。");
    }
    const currentSpace = this.state.spaces.find((space) => space.id === id);
    if (!currentSpace) throw new DemoError("validation", "找不到这个空间。");
    const metadataBaseline = expectedMetadata
      ? { name: expectedMetadata.name, icon: expectedMetadata.icon }
      : { name: currentSpace.name, icon: currentSpace.icon };
    requireName(metadataBaseline.name, "已保存的空间名称");
    requireName(metadataBaseline.icon, "已保存的空间图标");
    if (
      currentSpace.name !== metadataBaseline.name ||
      currentSpace.icon !== metadataBaseline.icon
    ) {
      throw new DemoError("conflict", "空间名称或图标已在另一处更新。请比较后重试。");
    }
    const saveMode = this.takeNextSave();
    await pause(this.delayOverrideMs ?? SAVE_DELAY_MS);

    const latest = this.state.spaces.find((space) => space.id === id);
    if (!latest) throw new DemoError("validation", "找不到这个空间。");
    if (latest.name !== metadataBaseline.name || latest.icon !== metadataBaseline.icon) {
      throw new DemoError("conflict", "空间名称或图标已在另一处更新。请比较后重试。");
    }
    if (saveMode === "failure") {
      throw new DemoError("failure", "模拟保存失败。空间草稿仍保留在编辑器中。");
    }
    if (saveMode === "conflict") {
      this.writeContext("space", id, {
        revision: latest.context.revision + 1,
        goal: `${CONFLICT_PREFIX}${latest.context.goal}`,
        instructions: latest.context.instructions,
      });
      throw new DemoError("conflict", "检测到另一处编辑，已保留最新版本。请比较后重试。");
    }
    if (latest.context.revision !== expectedRevision) {
      throw new DemoError("conflict", "空间内容已在另一处更新。请刷新后重试。");
    }
    const contextChanged =
      latest.context.goal !== fields.goal || latest.context.instructions !== fields.instructions;
    const metadataChanged = latest.name !== fields.name || latest.icon !== fields.icon;
    if (!contextChanged && !metadataChanged) return this.copySpace(latest);

    const saved: DemoSpace = {
      ...latest,
      name: fields.name,
      icon: fields.icon,
      context: contextChanged
        ? {
            revision: latest.context.revision + 1,
            goal: fields.goal,
            instructions: fields.instructions,
          }
        : latest.context,
    };
    const ackLost = this.state.nextSaveAckLost;
    this.writeSpace(saved, ackLost);
    if (ackLost) {
      throw new DemoError(
        "failure",
        "空间保存已完成，但确认响应丢失。请核对当前已保存内容。",
        true,
      );
    }
    return this.copySpace(saved);
  }

  createThread(projectId: string, provider: DemoProvider = "codex"): string {
    const project = this.state.projects.find((item) => item.id === projectId);
    if (!project) throw new DemoError("validation", "找不到这个项目。");
    const id = `thread-demo-${this.nextThreadNumber++}`;
    const thread: DemoThread = {
      id,
      projectId,
      title: "新对话",
      provider,
      mode: "new",
      snapshot: null,
      applied: { status: "idle", generation: 0, error: null },
      messages: [],
    };
    this.replaceState({ ...this.state, threads: [...this.state.threads, thread] });
    return id;
  }

  createLegacyThread(projectId: string): string {
    const project = this.state.projects.find((item) => item.id === projectId);
    if (!project) throw new DemoError("validation", "找不到这个项目。");
    const id = `thread-demo-${this.nextThreadNumber++}`;
    const thread: DemoThread = {
      id,
      projectId,
      title: "历史对话示例",
      provider: "codex",
      mode: "legacy",
      snapshot: null,
      applied: { status: "idle", generation: 0, error: null },
      messages: [
        {
          id: this.createMessageId(),
          role: "user",
          text: "这里展示迁移前已经存在的对话。",
        },
        {
          id: this.createMessageId(),
          role: "assistant",
          text: "历史对话保留原样，不会自动添加新的上下文。",
        },
      ],
    };
    this.replaceState({ ...this.state, threads: [...this.state.threads, thread] });
    return id;
  }

  setThreadProvider(id: string, provider: DemoProvider): void {
    const thread = this.requireThread(id);
    if (thread.mode === "legacy") {
      throw new DemoError("validation", "历史对话的提供方不可更改。");
    }
    if (thread.applied.status === "loading" || thread.applied.status === "loaded") {
      throw new DemoError("validation", "上下文加载开始后，提供方不可更改。");
    }
    if (provider === "claude" && this.hasNonemptyContext(thread.projectId, thread.snapshot)) {
      throw new DemoError("validation", "当前演示不支持 Claude 使用非空上下文。");
    }
    this.updateThread(id, (current) => ({ ...current, provider }));
  }

  async send(id: string, text: string): Promise<void> {
    if (typeof text !== "string") throw new DemoError("validation", "消息必须是文本。");
    if (text.trim().length === 0) return;
    this.assertOperationAvailable(id);
    const thread = this.requireThread(id);

    if (thread.mode === "legacy") {
      this.appendMockExchange(id, text);
      return;
    }
    if (thread.applied.status === "failed" && this.pendingMessages.has(id)) {
      throw new DemoError("validation", "请先重试这条消息的上下文加载。");
    }

    if (thread.mode === "new") {
      const project = this.requireProject(thread.projectId);
      const unclaimedMigration = this.state.migrations.find(
        (migration) => migration.projectId === project.id && migration.status !== "completed",
      );
      if (unclaimedMigration) {
        throw new DemoError(
          "validation",
          "请先确认本项目的旧指令迁移（保留当前指令或导入旧指令），再发送第一条消息。",
        );
      }
      const space = project.spaceId
        ? (this.state.spaces.find((item) => item.id === project.spaceId) ?? null)
        : null;
      if (thread.provider === "claude" && this.hasNonemptySource(project, space)) {
        throw new DemoError("validation", "当前演示不支持 Claude 使用非空上下文。");
      }
      const snapshot = this.createSnapshot(project, space);
      const messageId = this.createMessageId();
      this.pendingMessages.set(id, { messageId, text });
      this.updateThread(id, (current) => ({
        ...current,
        title: text.trim().slice(0, 24),
        mode: "bound",
        snapshot,
        messages: [...current.messages, { id: messageId, role: "user", text }],
      }));
      await this.loadSnapshot(id, snapshot, messageId);
      return;
    }

    if (thread.applied.status !== "loaded" || !thread.snapshot) {
      throw new DemoError("validation", "当前对话尚未加载上下文，请重试或新建对话。");
    }
    this.appendMockExchange(id, text);
  }

  async retryLoad(id: string): Promise<void> {
    this.assertOperationAvailable(id);
    const thread = this.requireThread(id);
    const pending = this.pendingMessages.get(id);
    if (
      thread.mode !== "bound" ||
      thread.applied.status !== "failed" ||
      !thread.snapshot ||
      !pending
    ) {
      throw new DemoError("validation", "没有等待重试的上下文加载。");
    }
    await this.loadSnapshot(id, thread.snapshot, pending.messageId);
  }

  isStale(threadId: string): boolean {
    const thread = this.state.threads.find((item) => item.id === threadId);
    if (!thread || !thread.snapshot) return false;
    if (thread.projectId !== thread.snapshot.projectId) return true;
    const project = this.state.projects.find((item) => item.id === thread.snapshot?.projectId);
    if (!project || project.id !== thread.snapshot.projectId) return true;
    if (project.spaceId !== thread.snapshot.spaceId) return true;

    const liveSpace = project.spaceId
      ? (this.state.spaces.find((item) => item.id === project.spaceId) ?? null)
      : null;
    if (thread.snapshot.spaceId && !liveSpace) return true;

    const snapshotSpace = thread.snapshot.space;
    if (!!snapshotSpace !== !!liveSpace) return true;
    if (
      snapshotSpace &&
      liveSpace &&
      (snapshotSpace.goal !== liveSpace.context.goal ||
        snapshotSpace.instructions !== liveSpace.context.instructions)
    ) {
      return true;
    }
    return (
      thread.snapshot.project.goal !== project.context.goal ||
      thread.snapshot.project.instructions !== project.context.instructions
    );
  }

  async claimMigrations(): Promise<void> {
    const eligible = this.state.migrations.filter(
      (migration) => migration.status === "unclaimed" || migration.status === "pending",
    );
    if (eligible.length === 0) return;

    const revisions = new Map(
      eligible.map((migration) => [
        migration.id,
        this.state.projects.find((project) => project.id === migration.projectId)?.context
          .revision ?? null,
      ]),
    );
    this.replaceState({
      ...this.state,
      migrations: this.state.migrations.map((migration) =>
        eligible.some((candidate) => candidate.id === migration.id)
          ? {
              ...migration,
              status: "pending",
              expectedRevision: revisions.get(migration.id) ?? null,
            }
          : migration,
      ),
    });

    let firstError: DemoError | null = null;
    for (const migration of eligible) {
      const currentMigration = this.state.migrations.find((item) => item.id === migration.id);
      if (!currentMigration || currentMigration.status !== "pending") continue;
      const project = this.state.projects.find((item) => item.id === currentMigration.projectId);
      if (!project) {
        this.updateMigration(currentMigration.id, (item) => ({
          ...item,
          status: "conflict",
          expectedRevision: null,
        }));
        continue;
      }

      const source = project.context;
      if (source.instructions === currentMigration.localInstructions) {
        this.updateMigration(currentMigration.id, (item) => ({
          ...item,
          status: "completed",
          expectedRevision: source.revision,
        }));
        continue;
      }
      if (source.instructions !== "" || currentMigration.localInstructions === "") {
        this.updateMigration(currentMigration.id, (item) => ({
          ...item,
          status: "conflict",
          expectedRevision: source.revision,
        }));
        continue;
      }

      try {
        await this.saveContext(
          "project",
          project.id,
          { goal: source.goal, instructions: currentMigration.localInstructions },
          source.revision,
        );
        const readback = this.state.projects.find((item) => item.id === project.id)?.context;
        if (
          readback?.goal === source.goal &&
          readback.instructions === currentMigration.localInstructions
        ) {
          this.updateMigration(currentMigration.id, (item) => ({
            ...item,
            status: "completed",
            expectedRevision: readback.revision,
          }));
        } else {
          this.updateMigration(currentMigration.id, (item) => ({
            ...item,
            status: "conflict",
            expectedRevision: readback?.revision ?? null,
          }));
        }
      } catch (error) {
        const latestRevision =
          this.state.projects.find((item) => item.id === project.id)?.context.revision ?? null;
        if (error instanceof DemoError && error.code === "conflict") {
          this.updateMigration(currentMigration.id, (item) => ({
            ...item,
            status: "conflict",
            expectedRevision: latestRevision,
          }));
        } else {
          this.updateMigration(currentMigration.id, (item) => ({
            ...item,
            status: "pending",
            expectedRevision: latestRevision,
          }));
        }
        if (!firstError) {
          firstError =
            error instanceof DemoError ? error : new DemoError("failure", "迁移未能完成，请重试。");
        }
      }
    }
    if (firstError) throw firstError;
  }

  async resolveMigration(id: string, choice: "server" | "local"): Promise<void> {
    const migration = this.state.migrations.find((item) => item.id === id);
    if (!migration || migration.status !== "conflict") {
      throw new DemoError("validation", "只能处理待确认的迁移冲突。");
    }
    const project = this.state.projects.find((item) => item.id === migration.projectId);
    if (!project) throw new DemoError("validation", "找不到迁移对应的项目。");
    if (
      migration.expectedRevision === null ||
      project.context.revision !== migration.expectedRevision
    ) {
      this.updateMigration(id, (item) => ({
        ...item,
        expectedRevision: project.context.revision,
      }));
      throw new DemoError("conflict", "项目内容已更新。请重新比较当前版本后再选择。");
    }

    const goalAtChoice = project.context.goal;
    const chosenInstructions =
      choice === "local" ? migration.localInstructions : project.context.instructions;
    if (choice === "local") {
      try {
        await this.saveContext(
          "project",
          project.id,
          { goal: goalAtChoice, instructions: chosenInstructions },
          migration.expectedRevision,
        );
      } catch (error) {
        if (error instanceof DemoError && error.code === "conflict") {
          const latestRevision =
            this.state.projects.find((item) => item.id === project.id)?.context.revision ?? null;
          this.updateMigration(id, (item) => ({ ...item, expectedRevision: latestRevision }));
        }
        throw error;
      }
    }

    const readback = this.state.projects.find((item) => item.id === project.id)?.context;
    if (
      !readback ||
      readback.goal !== goalAtChoice ||
      readback.instructions !== chosenInstructions
    ) {
      if (readback) {
        this.updateMigration(id, (item) => ({ ...item, expectedRevision: readback.revision }));
      }
      throw new DemoError("conflict", "回读结果与选择不一致，冲突仍待处理。");
    }
    this.updateMigration(id, (item) => ({
      ...item,
      status: "completed",
      expectedRevision: readback.revision,
    }));
  }

  renameSpace(id: string, name: string, icon?: string): void {
    requireName(name, "空间名称");
    if (icon !== undefined) requireName(icon, "空间图标");
    const exists = this.state.spaces.some((space) => space.id === id);
    if (!exists) throw new DemoError("validation", "找不到这个空间。");
    this.replaceState({
      ...this.state,
      spaces: this.state.spaces.map((space) =>
        space.id === id ? { ...space, name, ...(icon === undefined ? {} : { icon }) } : space,
      ),
    });
  }

  createSpace(name: string, icon: string): string {
    requireName(name, "空间名称");
    requireName(icon, "空间图标");
    const id = `space-demo-${this.nextSpaceNumber++}`;
    const sortOrder =
      this.state.spaces.reduce((max, space) => Math.max(max, space.sortOrder), -1) + 1;
    const space: DemoSpace = {
      id,
      name,
      icon,
      sortOrder,
      context: context(1, "", ""),
    };
    this.replaceState({ ...this.state, spaces: [...this.state.spaces, space] });
    return id;
  }

  deleteSpace(id: string): void {
    if (!this.state.spaces.some((space) => space.id === id)) {
      throw new DemoError("validation", "找不到这个空间。");
    }
    this.replaceState({
      ...this.state,
      spaces: this.state.spaces.filter((space) => space.id !== id),
      projects: this.state.projects.map((project) =>
        project.spaceId === id ? { ...project, spaceId: null } : project,
      ),
    });
  }

  reorderSpaces(ids: string[]): void {
    const currentIds = new Set(this.state.spaces.map((space) => space.id));
    if (
      ids.length !== this.state.spaces.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !currentIds.has(id))
    ) {
      throw new DemoError("validation", "排序必须包含每个空间且不能重复。");
    }
    const byId = new Map(this.state.spaces.map((space) => [space.id, space]));
    this.replaceState({
      ...this.state,
      spaces: ids.map((id, sortOrder) => ({ ...byId.get(id)!, sortOrder })),
    });
  }

  reset(): void {
    this.epoch += 1;
    this.pendingMessages.clear();
    this.activeOperations.clear();
    this.nextThreadNumber = 1;
    this.nextMessageNumber = 1;
    this.nextSnapshotNumber = 1;
    this.nextSpaceNumber = 1;
    this.replaceState(initialState());
  }

  private replaceState(nextState: DemoState): void {
    this.state = freezeTree(nextState);
    for (const listener of this.listeners) listener();
  }

  private readContext(kind: ContextKind, id: string): ContextConfig {
    const target =
      kind === "space"
        ? this.state.spaces.find((space) => space.id === id)
        : this.state.projects.find((project) => project.id === id);
    if (!target)
      throw new DemoError("validation", `找不到这个${kind === "space" ? "空间" : "项目"}。`);
    return target.context;
  }

  private writeContext(
    kind: ContextKind,
    id: string,
    saved: ContextConfig,
    consumeSaveAckLost = false,
  ): void {
    if (kind === "space") {
      this.replaceState({
        ...this.state,
        nextSaveAckLost: consumeSaveAckLost ? false : this.state.nextSaveAckLost,
        spaces: this.state.spaces.map((space) =>
          space.id === id ? { ...space, context: saved } : space,
        ),
      });
    } else {
      this.replaceState({
        ...this.state,
        nextSaveAckLost: consumeSaveAckLost ? false : this.state.nextSaveAckLost,
        projects: this.state.projects.map((project) =>
          project.id === id ? { ...project, context: saved } : project,
        ),
      });
    }
  }

  private writeSpace(space: DemoSpace, consumeSaveAckLost = false): void {
    this.replaceState({
      ...this.state,
      nextSaveAckLost: consumeSaveAckLost ? false : this.state.nextSaveAckLost,
      spaces: this.state.spaces.map((item) => (item.id === space.id ? space : item)),
    });
  }

  private copySpace(space: DemoSpace): DemoSpace {
    return { ...space, context: copyContext(space.context) };
  }

  private takeNextSave(): SaveMode {
    const mode = this.state.nextSave;
    if (mode !== "normal") this.replaceState({ ...this.state, nextSave: "normal" });
    return mode;
  }

  private takeNextLoad(): LoadMode {
    const mode = this.state.nextLoad;
    if (mode !== "normal") this.replaceState({ ...this.state, nextLoad: "normal" });
    return mode;
  }

  private requireThread(id: string): DemoThread {
    const thread = this.state.threads.find((item) => item.id === id);
    if (!thread) throw new DemoError("validation", "找不到这个对话。");
    return thread;
  }

  private requireProject(id: string): DemoProject {
    const project = this.state.projects.find((item) => item.id === id);
    if (!project) throw new DemoError("validation", "找不到这个项目。");
    return project;
  }

  private updateThread(id: string, update: (thread: DemoThread) => DemoThread): void {
    const found = this.state.threads.some((thread) => thread.id === id);
    if (!found) throw new DemoError("validation", "找不到这个对话。");
    this.replaceState({
      ...this.state,
      threads: this.state.threads.map((thread) => (thread.id === id ? update(thread) : thread)),
    });
  }

  private updateMigration(id: string, update: (migration: DemoMigration) => DemoMigration): void {
    this.replaceState({
      ...this.state,
      migrations: this.state.migrations.map((migration) =>
        migration.id === id ? update(migration) : migration,
      ),
    });
  }

  private createMessageId(): string {
    return `message-demo-${this.nextMessageNumber++}`;
  }

  private createSnapshot(project: DemoProject, space: DemoSpace | null): ContextSnapshot {
    const projectCopy = copyContext(project.context);
    const spaceCopy = space ? copyContext(space.context) : null;
    const identity = [
      project.id,
      project.spaceId,
      spaceCopy?.goal ?? null,
      spaceCopy?.instructions ?? null,
      projectCopy.goal,
      projectCopy.instructions,
    ];
    return freezeTree({
      id: `snapshot-demo-${this.nextSnapshotNumber++}`,
      projectId: project.id,
      projectName: project.name,
      spaceId: project.spaceId,
      spaceName: space?.name ?? null,
      space: spaceCopy,
      project: projectCopy,
      hash: hashContext(identity),
      createdAt: new Date().toISOString(),
    });
  }

  private hasNonemptyContext(projectId: string, snapshot: ContextSnapshot | null): boolean {
    if (snapshot) return this.hasNonemptySnapshot(snapshot);
    const project = this.state.projects.find((item) => item.id === projectId);
    if (!project) return false;
    const space = project.spaceId
      ? (this.state.spaces.find((item) => item.id === project.spaceId) ?? null)
      : null;
    return this.hasNonemptySource(project, space);
  }

  private hasNonemptySource(project: DemoProject, space: DemoSpace | null): boolean {
    return Boolean(
      project.context.goal ||
      project.context.instructions ||
      space?.context.goal ||
      space?.context.instructions,
    );
  }

  private hasNonemptySnapshot(snapshot: ContextSnapshot): boolean {
    return Boolean(
      snapshot.project.goal ||
      snapshot.project.instructions ||
      snapshot.space?.goal ||
      snapshot.space?.instructions,
    );
  }

  private assertOperationAvailable(id: string): void {
    if (this.activeOperations.has(id)) {
      throw new DemoError("validation", "这条对话仍在处理中，请稍后重试。");
    }
  }

  private async loadSnapshot(
    id: string,
    snapshot: ContextSnapshot,
    messageId: string,
  ): Promise<void> {
    this.assertOperationAvailable(id);
    const thread = this.requireThread(id);
    const operation = {};
    const operationEpoch = this.epoch;
    const loadMode = this.takeNextLoad();
    const generation = thread.applied.generation + 1;
    this.activeOperations.set(id, operation);
    this.updateThread(id, (current) => ({
      ...current,
      mode: "bound",
      snapshot,
      applied: { status: "loading", generation, error: null },
    }));

    try {
      await pause(this.delayOverrideMs ?? LOAD_DELAY_MS);
      if (operationEpoch !== this.epoch) {
        throw new DemoError("failure", "演示已重置，已取消这次加载。");
      }
      if (loadMode === "failure") {
        this.updateThread(id, (current) => ({
          ...current,
          applied: { status: "failed", generation, error: "模拟上下文加载失败。" },
        }));
        throw new DemoError("failure", "模拟上下文加载失败，请重试。原始消息和上下文版本已保留。");
      }

      const pending = this.pendingMessages.get(id);
      const assistant =
        pending?.messageId === messageId ? this.makeAssistantMessage(pending.text) : null;
      this.updateThread(id, (current) => ({
        ...current,
        applied: { status: "loaded", generation, error: null },
        messages:
          assistant && !current.messages.some((message) => message.id === assistant.id)
            ? [...current.messages, assistant]
            : current.messages,
      }));
      if (pending?.messageId === messageId) this.pendingMessages.delete(id);
    } finally {
      if (this.activeOperations.get(id) === operation) this.activeOperations.delete(id);
    }
  }

  private makeAssistantMessage(userText: string): DemoMessage {
    return {
      id: this.createMessageId(),
      role: "assistant",
      text: `已收到「${userText}」，本次对话使用固定的上下文副本。`,
    };
  }

  private appendMockExchange(id: string, text: string): void {
    const thread = this.requireThread(id);
    const userMessage: DemoMessage = { id: this.createMessageId(), role: "user", text };
    const assistantMessage: DemoMessage =
      thread.mode === "legacy"
        ? {
            id: this.createMessageId(),
            role: "assistant",
            text: "旧对话沿用原有内容，未补入新的 Space/Project 上下文。",
          }
        : this.makeAssistantMessage(text);
    this.updateThread(id, (thread) => ({
      ...thread,
      messages: [...thread.messages, userMessage, assistantMessage],
    }));
  }
}
