import type { ContextApi, ContextCommandResult, ProjectContextSettings } from "@synara/contracts";

import { newCommandId } from "~/lib/utils";

export interface ProjectContextFields {
  readonly projectGoal: string;
  readonly projectInstructions: string;
}

export type ProjectContextAutosaveStatus = "idle" | "dirty" | "saving" | "error" | "conflict";

export interface ProjectContextAutosaveError {
  readonly code: "conflict" | "validation" | "failure" | "pending";
  readonly message: string;
  readonly outcomeUncertain: boolean;
}

export interface ProjectContextAutosaveState {
  readonly projectId: ProjectContextSettings["projectId"];
  readonly base: ProjectContextSettings;
  readonly draft: ProjectContextFields;
  readonly status: ProjectContextAutosaveStatus;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly queued: boolean;
  readonly error: ProjectContextAutosaveError | null;
}

interface SaveAttempt {
  readonly commandId: ReturnType<typeof newCommandId>;
  readonly fields: ProjectContextFields;
  readonly base: ProjectContextSettings;
  readonly draftVersion: number;
}

function fieldsFrom(settings: ProjectContextSettings): ProjectContextFields {
  return {
    projectGoal: settings.projectGoal,
    projectInstructions: settings.projectInstructions,
  };
}

function copyFields(fields: ProjectContextFields): ProjectContextFields {
  return { projectGoal: fields.projectGoal, projectInstructions: fields.projectInstructions };
}

function sameFields(left: ProjectContextFields, right: ProjectContextFields): boolean {
  return (
    left.projectGoal === right.projectGoal && left.projectInstructions === right.projectInstructions
  );
}

function copySettings(settings: ProjectContextSettings): ProjectContextSettings {
  return {
    ...settings,
    inherited: settings.inherited ? { ...settings.inherited } : null,
    migration: settings.migration ? { ...settings.migration } : null,
  };
}

function isProjectSettings(
  value: ProjectContextSettings | undefined,
  expected: ProjectContextSettings,
): value is ProjectContextSettings {
  return (
    value !== undefined &&
    value.projectId === expected.projectId &&
    value.dataInstanceId === expected.dataInstanceId
  );
}

function asMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function makeError(
  code: ProjectContextAutosaveError["code"],
  message: string,
  outcomeUncertain = false,
): ProjectContextAutosaveError {
  return { code, message, outcomeUncertain };
}

/**
 * A serial latest-draft autosave queue for one (connection, data instance, project) tuple.
 * Confirmed values come only from the API. It intentionally outlives the editor pane so a
 * thread switch in the same project cannot abandon a debounced write.
 */
export class ProjectContextAutosave {
  readonly projectId: ProjectContextSettings["projectId"];

  private readonly api: ContextApi;
  private readonly debounceMs: number;
  private readonly listeners = new Set<() => void>();
  private base: ProjectContextSettings;
  private draft: ProjectContextFields;
  private draftVersion = 0;
  private errorValue: ProjectContextAutosaveError | null = null;
  private validationError: ProjectContextAutosaveError | null = null;
  private attempt: SaveAttempt | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private inFlightAttempt: SaveAttempt | null = null;
  private autoDue = false;
  private resolving = false;
  private snapshot: ProjectContextAutosaveState;

  constructor(input: {
    readonly api: ContextApi;
    readonly initial: ProjectContextSettings;
    readonly debounceMs?: number;
  }) {
    this.api = input.api;
    this.projectId = input.initial.projectId;
    this.base = copySettings(input.initial);
    this.draft = fieldsFrom(input.initial);
    this.debounceMs = Math.max(0, input.debounceMs ?? 500);
    this.snapshot = this.createState();
  }

  getState = (): ProjectContextAutosaveState => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setDraft(fields: ProjectContextFields): void {
    if (this.resolving) return;
    if (typeof fields.projectGoal !== "string" || typeof fields.projectInstructions !== "string") {
      return;
    }
    if (sameFields(this.draft, fields)) return;

    this.draft = copyFields(fields);
    this.draftVersion += 1;
    this.validationError = this.validateLength(fields);
    if (this.errorValue?.code === "validation" && !this.validationError) this.errorValue = null;
    if (!this.errorValue && !this.validationError && this.shouldSaveCurrentDraft()) this.schedule();
    else this.clearTimer();
    this.publish();
  }

  /** Cancel the debounce and await every serial write for this project's latest draft. */
  async flush(): Promise<boolean> {
    this.clearTimer();
    this.autoDue = false;
    for (;;) {
      if (this.inFlight) {
        await this.inFlight.catch(() => undefined);
        continue;
      }
      if (this.currentError()) return false;
      if (!this.isDirty()) return true;
      try {
        await this.startSave();
      } catch {
        return false;
      }
    }
  }

  /** Query the original command before retrying; uncertain writes reuse its command id. */
  async retry(): Promise<boolean> {
    if (this.resolving) return false;
    if (this.currentError()?.code === "conflict" || this.validationError) return false;
    if (this.inFlight) {
      await this.inFlight.catch(() => undefined);
      if (this.currentError()) return false;
    }

    if (this.attempt) {
      this.resolving = true;
      this.publish();
      try {
        const result = await this.api.getCommandResult({ commandId: this.attempt.commandId });
        if (result.status === "unknown") {
          const replayed = await this.api.saveProject(this.toSaveInput(this.attempt));
          const finalResult =
            replayed.status === "unknown"
              ? await this.api.getCommandResult({ commandId: this.attempt.commandId })
              : replayed;
          const applied = await this.applyResult(this.attempt, finalResult);
          if (!applied) return false;
        } else {
          const applied = await this.applyResult(this.attempt, result);
          if (!applied) return false;
        }
      } catch (error) {
        this.errorValue = makeError(
          "failure",
          `Could not confirm the previous save: ${asMessage(error, "try again")}`,
          true,
        );
        return false;
      } finally {
        this.resolving = false;
        this.publish();
      }
    } else if (this.errorValue) {
      this.errorValue = null;
      this.publish();
    }
    return this.flush();
  }

  /** Adopt only a server-confirmed value, including after any already-sent write settles. */
  async acceptSaved(): Promise<boolean> {
    if (this.resolving) return false;
    this.resolving = true;
    this.clearTimer();
    this.autoDue = false;
    try {
      await this.waitForSentWrite();
      if (!(await this.confirmAttemptSettled())) return false;
      const latest = await this.readLatest();
      this.adopt(latest);
      return true;
    } catch (error) {
      this.errorValue = makeError(
        "failure",
        `Could not read the saved project context: ${asMessage(error, "try again")}`,
        true,
      );
      return false;
    } finally {
      this.resolving = false;
      this.publish();
    }
  }

  /** Rebase the current draft on the latest server revision, then explicitly save it. */
  async keepDraft(): Promise<boolean> {
    if (this.resolving) return false;
    this.resolving = true;
    this.clearTimer();
    this.autoDue = false;
    let valid = false;
    try {
      await this.waitForSentWrite();
      if (!(await this.confirmAttemptSettled())) return false;
      this.base = await this.readLatest();
      this.attempt = null;
      this.errorValue = null;
      this.validationError = this.validateLength(this.draft);
      valid = this.validationError === null;
    } catch (error) {
      this.errorValue = makeError(
        "failure",
        `Could not read the latest project context: ${asMessage(error, "try again")}`,
        true,
      );
    } finally {
      this.resolving = false;
      this.publish();
    }
    return valid ? this.flush() : false;
  }

  async discard(): Promise<boolean> {
    return this.acceptSaved();
  }

  /** Refresh from an API read without replacing an active draft or an in-flight write. */
  receiveConfirmed(settings: ProjectContextSettings): void {
    if (
      settings.dataInstanceId !== this.base.dataInstanceId ||
      settings.projectId !== this.projectId ||
      settings.revision < this.base.revision
    ) {
      return;
    }
    const sameRevisionChanged =
      settings.revision === this.base.revision &&
      !sameFields(fieldsFrom(settings), fieldsFrom(this.base));
    const revisionChanged = settings.revision > this.base.revision || sameRevisionChanged;
    if (!revisionChanged) return;

    if (this.inFlight) {
      const matchesInFlight =
        this.inFlightAttempt !== null &&
        sameFields(fieldsFrom(settings), this.inFlightAttempt.fields);
      this.adoptBase(settings);
      if (!matchesInFlight) {
        this.errorValue = makeError(
          "conflict",
          "Project context changed while a save was in progress. Compare the saved content with your draft.",
        );
        this.publish();
      }
      return;
    }

    if (this.attempt) {
      const draftWasDirty = this.isDirty();
      const matchesAttempt = sameFields(fieldsFrom(settings), this.attempt.fields);
      this.base = copySettings(settings);
      if (!draftWasDirty) this.draft = fieldsFrom(settings);
      this.validationError = this.validateLength(this.draft);
      if (!matchesAttempt) {
        this.errorValue = makeError(
          "conflict",
          "Project context changed while the previous save is unconfirmed. Confirm that save before resolving this draft.",
          true,
        );
      }
      this.publish();
      return;
    }

    if (!this.isDirty()) {
      this.adoptBase(settings);
      return;
    }

    if (this.isDirty()) {
      this.base = copySettings(settings);
      this.attempt = null;
      this.errorValue = makeError(
        "conflict",
        "Project context changed elsewhere. Compare the saved content with your draft.",
      );
      this.publish();
    }
  }

  private createState(): ProjectContextAutosaveState {
    const dirty = !sameFields(this.draft, fieldsFrom(this.base));
    const saving = this.inFlight !== null || this.resolving;
    const error = this.validationError ?? this.errorValue;
    const status: ProjectContextAutosaveStatus = saving
      ? "saving"
      : error?.code === "conflict"
        ? "conflict"
        : error
          ? "error"
          : dirty
            ? "dirty"
            : "idle";
    return {
      projectId: this.projectId,
      base: copySettings(this.base),
      draft: copyFields(this.draft),
      status,
      dirty,
      saving,
      queued: Boolean(this.inFlightAttempt && !sameFields(this.draft, this.inFlightAttempt.fields)),
      error,
    };
  }

  private publish(): void {
    this.snapshot = this.createState();
    for (const listener of this.listeners) listener();
  }

  private isDirty(): boolean {
    return !sameFields(this.draft, fieldsFrom(this.base));
  }

  private shouldSaveCurrentDraft(): boolean {
    return this.inFlightAttempt
      ? !sameFields(this.draft, this.inFlightAttempt.fields)
      : this.isDirty();
  }

  private currentError(): ProjectContextAutosaveError | null {
    return this.validationError ?? this.errorValue;
  }

  private validateLength(fields: ProjectContextFields): ProjectContextAutosaveError | null {
    if (fields.projectGoal.length > 4_096) {
      return makeError("validation", "Project goal must be 4,096 characters or fewer.");
    }
    if (fields.projectInstructions.length > 16_384) {
      return makeError("validation", "Project instructions must be 16,384 characters or fewer.");
    }
    return null;
  }

  private schedule(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.currentError()) return;
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
    if (this.inFlight) return this.inFlight;
    if (this.currentError()) throw new Error(this.currentError()?.message);
    if (!this.isDirty()) return;

    const attempt: SaveAttempt = {
      commandId: newCommandId(),
      fields: copyFields(this.draft),
      base: copySettings(this.base),
      draftVersion: this.draftVersion,
    };
    this.attempt = attempt;
    this.inFlightAttempt = attempt;
    this.autoDue = false;

    let operation: Promise<void>;
    operation = Promise.resolve()
      .then(async () => {
        const result = await this.sendAndReconcile(attempt);
        const applied = await this.applyResult(attempt, result);
        if (!applied) throw new Error(this.currentError()?.message ?? "Save did not complete.");
      })
      .then(
        () => this.finishSave(operation),
        (error: unknown) => {
          this.finishSave(operation);
          throw error;
        },
      );
    this.inFlight = operation;
    this.publish();
    return operation;
  }

  private async sendAndReconcile(attempt: SaveAttempt): Promise<ContextCommandResult> {
    let initialError: unknown = null;
    try {
      const result = await this.api.saveProject(this.toSaveInput(attempt));
      if (result.status !== "unknown") return result;
    } catch (error) {
      initialError = error;
    }

    try {
      const result = await this.api.getCommandResult({ commandId: attempt.commandId });
      if (result.status !== "unknown") return result;
    } catch (error) {
      initialError = error;
    }

    // The original command is unknown, so replay the exact request with the same idempotency key.
    try {
      const replayed = await this.api.saveProject(this.toSaveInput(attempt));
      if (replayed.status !== "unknown") return replayed;
    } catch (error) {
      initialError = error;
    }
    try {
      const result = await this.api.getCommandResult({ commandId: attempt.commandId });
      if (result.status !== "unknown") return result;
    } catch (error) {
      initialError = error;
    }
    this.errorValue = makeError(
      "failure",
      `Save confirmation is still unavailable: ${asMessage(initialError, "retry to check the original command")}`,
      true,
    );
    throw new Error(this.errorValue.message);
  }

  private toSaveInput(attempt: SaveAttempt) {
    return {
      commandId: attempt.commandId,
      dataInstanceId: attempt.base.dataInstanceId,
      projectId: this.projectId,
      expectedRevision: attempt.base.revision,
      projectGoal: attempt.fields.projectGoal,
      projectInstructions: attempt.fields.projectInstructions,
    };
  }

  private async applyResult(attempt: SaveAttempt, result: ContextCommandResult): Promise<boolean> {
    if (result.status === "saved") {
      let saved = result.project;
      if (!isProjectSettings(saved, attempt.base)) {
        try {
          saved = await this.readLatest();
        } catch (error) {
          this.errorValue = makeError(
            "failure",
            `The save completed but could not be read back: ${asMessage(error, "try again")}`,
            true,
          );
          return false;
        }
      }
      if (!isProjectSettings(saved, attempt.base)) {
        this.errorValue = makeError("failure", "The save response belongs to a different project.");
        return false;
      }
      if (!sameFields(fieldsFrom(saved), attempt.fields)) {
        if (saved.revision >= this.base.revision) this.base = copySettings(saved);
        this.attempt = null;
        this.errorValue = makeError(
          "conflict",
          "The saved project context differs from this draft. Compare the current values.",
        );
        return false;
      }
      const baselineIsNewer =
        this.base.revision > saved.revision ||
        (this.base.revision === saved.revision &&
          !sameFields(fieldsFrom(this.base), fieldsFrom(saved)));
      if (baselineIsNewer && !sameFields(fieldsFrom(this.base), attempt.fields)) {
        this.attempt = null;
        this.errorValue = makeError(
          "conflict",
          "Project context changed while this save was completing. Compare the saved content with your draft.",
        );
        return false;
      }
      // A late acknowledgement may not replace a newer confirmed baseline.
      if (saved.revision >= this.base.revision) this.base = copySettings(saved);
      this.attempt = null;
      this.errorValue = null;
      this.validationError = this.validateLength(this.draft);
      return true;
    }

    if (result.status === "conflict") {
      const latest = isProjectSettings(result.project, attempt.base)
        ? result.project
        : await this.readLatest().catch(() => null);
      if (latest) this.base = copySettings(latest);
      this.attempt = null;
      this.errorValue = makeError(
        "conflict",
        result.message ??
          "Project context changed elsewhere. Compare the saved content with your draft.",
      );
      return false;
    }

    if (result.status === "rejected") {
      this.attempt = null;
      if (this.errorValue?.code !== "conflict") {
        this.errorValue = makeError(
          "failure",
          result.message ?? "The server rejected this project context save.",
        );
      }
      return false;
    }

    this.errorValue = makeError(
      "pending",
      result.message ?? "The save is still being processed. Retry to check its status.",
      true,
    );
    return false;
  }

  private async readLatest(): Promise<ProjectContextSettings> {
    const latest = await this.api.getProject({ projectId: this.projectId });
    if (!isProjectSettings(latest, this.base))
      throw new Error("The server returned another project.");
    return copySettings(latest);
  }

  private adopt(settings: ProjectContextSettings): void {
    this.base = copySettings(settings);
    this.draft = fieldsFrom(settings);
    this.draftVersion += 1;
    this.attempt = null;
    this.errorValue = null;
    this.validationError = null;
  }

  private adoptBase(settings: ProjectContextSettings): void {
    const draftWasDirty = this.isDirty();
    const writeWasInFlight = this.inFlight !== null;
    this.base = copySettings(settings);
    if (!draftWasDirty && !writeWasInFlight) this.draft = fieldsFrom(settings);
    this.errorValue = null;
    this.validationError = this.validateLength(this.draft);
    this.publish();
  }

  private async waitForSentWrite(): Promise<void> {
    while (this.inFlight) await this.inFlight.catch(() => undefined);
  }

  /**
   * A project read cannot prove that an earlier write has stopped processing. Before
   * discarding or rebasing, require the original command receipt to be terminal.
   */
  private async confirmAttemptSettled(): Promise<boolean> {
    const attempt = this.attempt;
    if (!attempt) return true;
    try {
      const result = await this.api.getCommandResult({ commandId: attempt.commandId });
      if (result.status === "pending" || result.status === "unknown") {
        this.errorValue = makeError(
          "pending",
          result.message ??
            "The previous save is not confirmed yet. Retry after its status is known.",
          true,
        );
        return false;
      }
      return true;
    } catch (error) {
      this.errorValue = makeError(
        "failure",
        `Could not confirm the previous save: ${asMessage(error, "retry to check the original command")}`,
        true,
      );
      return false;
    }
  }

  private finishSave(operation: Promise<void>): void {
    if (this.inFlight !== operation) return;
    this.inFlight = null;
    this.inFlightAttempt = null;
    this.publish();
    if (this.autoDue && !this.currentError() && this.isDirty()) {
      this.autoDue = false;
      queueMicrotask(() => {
        if (!this.currentError() && !this.inFlight && this.isDirty()) {
          void this.startSave().catch(() => undefined);
        }
      });
    }
  }
}

const controllersByApi = new WeakMap<ContextApi, Map<string, ProjectContextAutosave>>();

export function getProjectContextAutosave(
  api: ContextApi,
  initial: ProjectContextSettings,
): ProjectContextAutosave {
  let controllers = controllersByApi.get(api);
  if (!controllers) {
    controllers = new Map();
    controllersByApi.set(api, controllers);
  }
  const key = `${initial.dataInstanceId}\u0000${initial.projectId}`;
  const existing = controllers.get(key);
  if (existing) return existing;
  const created = new ProjectContextAutosave({ api, initial });
  controllers.set(key, created);
  return created;
}
