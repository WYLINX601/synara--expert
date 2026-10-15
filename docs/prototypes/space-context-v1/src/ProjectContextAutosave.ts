import {
  DemoError,
  CONTEXT_GOAL_MAX_LENGTH,
  CONTEXT_INSTRUCTIONS_MAX_LENGTH,
  type ContextConfig,
  type ContextFields,
  type DemoErrorCode,
} from "./ContextDemoAdapter";

export type ProjectContextAutosaveStatus =
  | "idle"
  | "dirty"
  | "saving"
  | "error"
  | "conflict"
  | "disposed";

export type ProjectContextAutosaveError = {
  code: DemoErrorCode;
  message: string;
  outcomeUncertain: boolean;
};

export type ProjectContextAutosaveState = {
  projectId: string;
  /** The last server value confirmed by a save response or readback. */
  base: ContextConfig;
  /** Raw current editor values. Drafts are never trimmed or truncated. */
  draft: ContextFields;
  status: ProjectContextAutosaveStatus;
  dirty: boolean;
  saving: boolean;
  queued: boolean;
  error: ProjectContextAutosaveError | null;
};

export type ProjectContextAutosaveOptions = {
  projectId: string;
  initial: ContextConfig;
  save: (
    projectId: string,
    fields: ContextFields,
    expectedRevision: number,
  ) => Promise<ContextConfig>;
  read: (projectId: string) => ContextConfig | Promise<ContextConfig>;
  debounceMs?: number;
};

type SaveAttempt = {
  fields: ContextFields;
  base: ContextConfig;
  expectedRevision: number;
  draftVersion: number;
};

function copyFields(fields: ContextFields): ContextFields {
  return { goal: fields.goal, instructions: fields.instructions };
}

function copyConfig(config: ContextConfig): ContextConfig {
  return {
    revision: config.revision,
    goal: config.goal,
    instructions: config.instructions,
  };
}

function sameFields(left: ContextFields, right: ContextFields): boolean {
  return left.goal === right.goal && left.instructions === right.instructions;
}

function validateConfig(config: ContextConfig): void {
  if (
    !config ||
    !Number.isInteger(config.revision) ||
    config.revision < 0 ||
    typeof config.goal !== "string" ||
    typeof config.instructions !== "string"
  ) {
    throw new DemoError("validation", "项目上下文回读格式无效。");
  }
}

function asDemoError(error: unknown): DemoError {
  if (error instanceof DemoError) return error;
  if (error instanceof Error) return new DemoError("failure", error.message);
  return new DemoError("failure", "保存失败，请重试。");
}

function immutableState(state: ProjectContextAutosaveState): ProjectContextAutosaveState {
  return Object.freeze({
    ...state,
    base: Object.freeze(copyConfig(state.base)),
    draft: Object.freeze(copyFields(state.draft)),
    error: state.error ? Object.freeze({ ...state.error }) : null,
  });
}

/**
 * A controlled, in-memory autosave controller for a single project's two
 * context fields. It is an external store and can be read with
 * useSyncExternalStore. Call flush before closing or switching away; dispose
 * only cancels unsent debounce work and never starts a save.
 */
export class ProjectContextAutosave {
  readonly projectId: string;

  private readonly saveValue: ProjectContextAutosaveOptions["save"];
  private readonly readValue: ProjectContextAutosaveOptions["read"];
  private readonly debounceMs: number;
  private readonly listeners = new Set<() => void>();
  private base: ContextConfig;
  private draft: ContextFields;
  private draftVersion = 0;
  private blockedError: ProjectContextAutosaveError | null = null;
  private draftValidationError: string | null = null;
  private lastAttempt: SaveAttempt | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private inFlightAttempt: SaveAttempt | null = null;
  private autoDue = false;
  private resolving = false;
  private disposed = false;
  private snapshot: ProjectContextAutosaveState;

  constructor(options: ProjectContextAutosaveOptions) {
    if (typeof options.projectId !== "string" || options.projectId.length === 0) {
      throw new DemoError("validation", "项目 ID 不能为空。");
    }
    validateConfig(options.initial);
    this.projectId = options.projectId;
    this.saveValue = options.save;
    this.readValue = options.read;
    this.debounceMs =
      typeof options.debounceMs === "number" && Number.isFinite(options.debounceMs)
        ? Math.max(0, options.debounceMs)
        : 500;
    this.base = copyConfig(options.initial);
    this.draft = copyFields(options.initial);
    this.snapshot = immutableState(this.createState());
  }

  getState = (): ProjectContextAutosaveState => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Replace the complete raw draft. Both fields are saved together. */
  setDraft(fields: ContextFields): void {
    this.assertEditable();
    if (!fields || typeof fields.goal !== "string" || typeof fields.instructions !== "string") {
      throw new DemoError("validation", "目标和指令都必须是文本。");
    }
    if (sameFields(this.draft, fields)) return;

    this.draft = copyFields(fields);
    this.draftVersion += 1;
    this.draftValidationError = this.validateDraftLength(fields);
    if (!this.currentError() && this.shouldSaveCurrentDraft()) this.schedule();
    else this.clearTimer();
    this.publish();
  }

  /** Cancel the debounce and persist each latest draft in revision order. */
  async flush(): Promise<boolean> {
    if (this.disposed) return false;
    this.clearTimer();
    this.autoDue = false;

    try {
      for (;;) {
        this.assertLive();
        if (this.inFlight) {
          await this.inFlight;
          continue;
        }
        if (this.currentError()) return false;
        if (!this.isDirty()) {
          this.publish();
          return true;
        }
        await this.startSave();
      }
    } catch {
      return false;
    }
  }

  /** Retry a failed write after checking the current persisted revision. */
  async retry(): Promise<boolean> {
    if (this.disposed || this.resolving) return false;
    const activeError = this.currentError();
    if (!activeError) return this.flush();
    if (activeError.code === "conflict" || activeError.code === "validation") {
      return false;
    }

    this.resolving = true;
    this.clearTimer();
    this.autoDue = false;
    let readyToRetry = false;
    try {
      await this.waitForSentWrites();
      const latest = await this.readLatest();
      const matchesAttempt =
        this.lastAttempt !== null && sameFields(latest, this.lastAttempt.fields);
      const matchesDraft = sameFields(latest, this.draft);
      if (!matchesAttempt && !matchesDraft && latest.revision !== this.base.revision) {
        this.base = latest;
        this.blockedError = {
          code: "conflict",
          message: "项目内容已在另一处更新。请比较已保存内容与草稿。",
          outcomeUncertain: false,
        };
      } else {
        this.base = latest;
        this.blockedError = null;
        this.draftValidationError = null;
        this.lastAttempt = null;
        readyToRetry = true;
      }
    } catch (error) {
      this.blockReadError(error);
    } finally {
      this.resolving = false;
      this.publish();
    }
    return readyToRetry ? this.flush() : false;
  }

  /** Adopt the persisted value and discard the draft. */
  async useSaved(): Promise<boolean> {
    return this.adoptSavedValue();
  }

  /** Rebase the draft on the latest persisted revision, then resume autosave. */
  async keepDraft(): Promise<boolean> {
    if (this.disposed || this.resolving) return false;
    this.resolving = true;
    this.clearTimer();
    this.autoDue = false;
    let rebased = false;
    try {
      await this.waitForSentWrites();
      this.base = await this.readLatest();
      this.blockedError = null;
      this.lastAttempt = null;
      this.draftValidationError = this.validateDraftLength(this.draft);
      rebased = this.draftValidationError === null;
    } catch (error) {
      this.blockReadError(error);
    } finally {
      this.resolving = false;
      this.publish();
    }
    return rebased ? this.flush() : false;
  }

  /**
   * Drop only unsent work. Any already-sent write is settled and read back
   * first, so a committed value is never presented as if it had been undone.
   */
  async discard(): Promise<boolean> {
    return this.adoptSavedValue();
  }

  /** Cancel unsent work and subscriptions; never submit during disposal. */
  dispose(): void {
    if (this.disposed) return;
    this.clearTimer();
    this.autoDue = false;
    this.disposed = true;
    this.snapshot = immutableState(this.createState());
    this.listeners.clear();
  }

  private createState(): ProjectContextAutosaveState {
    const dirty = !sameFields(this.draft, this.base);
    const saving = this.inFlight !== null;
    const status: ProjectContextAutosaveStatus = this.disposed
      ? "disposed"
      : saving
        ? "saving"
        : this.currentError()
          ? this.currentError()?.code === "conflict"
            ? "conflict"
            : "error"
          : dirty
            ? "dirty"
            : "idle";
    return {
      projectId: this.projectId,
      base: this.base,
      draft: this.draft,
      status,
      dirty,
      saving,
      queued: Boolean(this.inFlightAttempt && !sameFields(this.draft, this.inFlightAttempt.fields)),
      error: this.currentError(),
    };
  }

  private publish(): void {
    this.snapshot = immutableState(this.createState());
    if (this.disposed) return;
    for (const listener of this.listeners) listener();
  }

  private assertLive(): void {
    if (this.disposed) throw new DemoError("validation", "自动保存控制器已关闭。");
  }

  private assertEditable(): void {
    this.assertLive();
    if (this.resolving) {
      throw new DemoError("validation", "正在核对已保存内容，请稍后编辑。");
    }
  }

  private isDirty(): boolean {
    return !sameFields(this.draft, this.base);
  }

  private shouldSaveCurrentDraft(): boolean {
    if (this.inFlightAttempt) {
      return !sameFields(this.draft, this.inFlightAttempt.fields);
    }
    return this.isDirty();
  }

  private schedule(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.disposed || this.currentError()) return;
      if (this.inFlight) {
        this.autoDue = true;
        this.publish();
        return;
      }
      if (this.isDirty()) void this.startSave().catch(() => undefined);
    }, this.debounceMs);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private async startSave(): Promise<void> {
    this.assertLive();
    if (this.currentError()) throw this.blockedAsError();
    if (this.inFlight) return this.inFlight;
    if (!this.isDirty()) return;

    const attempt: SaveAttempt = {
      fields: copyFields(this.draft),
      base: copyConfig(this.base),
      expectedRevision: this.base.revision,
      draftVersion: this.draftVersion,
    };
    this.lastAttempt = attempt;
    this.inFlightAttempt = attempt;
    this.autoDue = false;

    let operation: Promise<void>;
    operation = Promise.resolve()
      .then(() => this.performSave(attempt))
      .then(
        () => this.finishSave(operation),
        (error: unknown) => {
          this.finishSave(operation);
          throw asDemoError(error);
        },
      );
    this.inFlight = operation;
    this.publish();
    return operation;
  }

  private async performSave(attempt: SaveAttempt): Promise<void> {
    try {
      const saved = await this.saveValue(
        this.projectId,
        copyFields(attempt.fields),
        attempt.expectedRevision,
      );
      try {
        validateConfig(saved);
      } catch {
        throw new DemoError("failure", "保存响应无效，正在核对当前值。", true);
      }
      if (
        saved.goal !== attempt.fields.goal ||
        saved.instructions !== attempt.fields.instructions ||
        saved.revision < attempt.expectedRevision
      ) {
        throw new DemoError("failure", "保存响应与提交内容不一致，正在核对当前值。", true);
      }
      this.base = copyConfig(saved);
      this.blockedError = null;
      if (this.draftVersion === attempt.draftVersion) this.draftValidationError = null;
      this.lastAttempt = null;
    } catch (caught) {
      const error = asDemoError(caught);
      if (error.outcomeUncertain) {
        const confirmed = await this.reconcileUncertainWrite(attempt, error);
        if (confirmed) return;
        throw this.blockedAsError();
      }
      if (error.code === "conflict") {
        try {
          this.base = await this.readLatest();
        } catch {
          // Keep the last confirmed base; the conflict still blocks autosave.
        }
        this.blockedError = {
          code: "conflict",
          message: error.message,
          outcomeUncertain: false,
        };
      } else {
        this.blockedError = {
          code: error.code,
          message: error.message,
          outcomeUncertain: false,
        };
      }
      throw this.blockedAsError();
    }
  }

  private async reconcileUncertainWrite(
    attempt: SaveAttempt,
    originalError: DemoError,
  ): Promise<boolean> {
    let latest: ContextConfig;
    try {
      latest = await this.readLatest();
    } catch {
      this.blockedError = {
        code: "failure",
        message: `${originalError.message} 回读也未成功；请核对后再重试。`,
        outcomeUncertain: true,
      };
      return false;
    }

    if (sameFields(latest, attempt.fields)) {
      this.base = latest;
      this.blockedError = null;
      if (this.draftVersion === attempt.draftVersion) this.draftValidationError = null;
      this.lastAttempt = null;
      return true;
    }
    this.base = latest;
    if (latest.revision !== attempt.expectedRevision) {
      this.blockedError = {
        code: "conflict",
        message: "保存确认丢失，回读发现项目已变更。请比较已保存内容与草稿。",
        outcomeUncertain: false,
      };
    } else {
      this.blockedError = {
        code: "failure",
        message: "回读未发现本次草稿已保存。可显式重试或放弃草稿。",
        outcomeUncertain: false,
      };
    }
    return false;
  }

  private finishSave(operation: Promise<void>): void {
    if (this.inFlight !== operation) return;
    this.inFlight = null;
    this.inFlightAttempt = null;
    if (this.disposed) {
      this.snapshot = immutableState(this.createState());
      return;
    }
    this.publish();
    if (this.autoDue && !this.currentError() && this.isDirty()) {
      this.autoDue = false;
      queueMicrotask(() => {
        if (!this.disposed && !this.currentError() && !this.inFlight && this.isDirty()) {
          void this.startSave().catch(() => undefined);
        }
      });
    }
  }

  private async readLatest(): Promise<ContextConfig> {
    const latest = await this.readValue(this.projectId);
    validateConfig(latest);
    return copyConfig(latest);
  }

  private async waitForSentWrites(): Promise<void> {
    while (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        // Errors are reflected in blockedError; callers choose how to resolve.
      }
    }
  }

  private async adoptSavedValue(): Promise<boolean> {
    if (this.disposed || this.resolving) return false;
    this.resolving = true;
    this.clearTimer();
    this.autoDue = false;
    let adopted = false;
    try {
      await this.waitForSentWrites();
      this.base = await this.readLatest();
      this.draft = copyFields(this.base);
      this.draftVersion += 1;
      this.blockedError = null;
      this.draftValidationError = null;
      this.lastAttempt = null;
      adopted = true;
    } catch (error) {
      this.blockReadError(error);
    } finally {
      this.resolving = false;
      this.clearTimer();
      this.autoDue = false;
      this.publish();
    }
    return adopted;
  }

  private validateDraftLength(fields: ContextFields): string | null {
    if (fields.goal.length > CONTEXT_GOAL_MAX_LENGTH) {
      return `目标最多 ${CONTEXT_GOAL_MAX_LENGTH} 个字符。`;
    }
    if (fields.instructions.length > CONTEXT_INSTRUCTIONS_MAX_LENGTH) {
      return `指令最多 ${CONTEXT_INSTRUCTIONS_MAX_LENGTH} 个字符。`;
    }
    return null;
  }

  private blockReadError(error: unknown): void {
    if (this.blockedError?.code === "conflict") return;
    const demoError = asDemoError(error);
    this.draftValidationError = null;
    this.blockedError = {
      code: demoError.code === "validation" ? "failure" : demoError.code,
      message: `无法核对项目当前值：${demoError.message}`,
      outcomeUncertain: true,
    };
  }

  private blockedAsError(message?: string): DemoError {
    const error = this.currentError();
    if (!error) return new DemoError("failure", "自动保存失败，请重试。");
    return new DemoError(error.code, message ?? error.message, error.outcomeUncertain);
  }

  private currentError(): ProjectContextAutosaveError | null {
    if (this.draftValidationError) {
      return {
        code: "validation",
        message: this.draftValidationError,
        outcomeUncertain: false,
      };
    }
    return this.blockedError;
  }
}
