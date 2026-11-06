import { randomUUID } from "node:crypto";
import {
  AMBIENT_CONTEXT_FRESHNESS_MS,
  AMBIENT_CONTEXT_SNAPSHOT_LIMIT_ERROR,
  AmbientContextPublication,
  AmbientContextSnapshot,
  AmbientContextSourceManifest,
  AmbientContextSourcePolicy,
  type AmbientContextDesktopState,
  type AmbientContextObservation as Observation,
  type AmbientContextSnapshot as Snapshot,
  type AmbientContextSourceManifest as SourceManifest,
  type AmbientContextSourcePolicy as SourcePolicy,
  type ResolvedAmbientContextItem,
} from "@synara/contracts";
import { resolveAmbientContext } from "@synara/shared/ambientContext";
import { Schema } from "effect";
import type { AmbientContextSource } from "./ContextSource";

const PermissionList = Schema.Array(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
).check(Schema.isMaxLength(64));

export interface AmbientContextManagerOptions {
  readonly now?: () => number;
}

export interface AmbientContextSourceStatus {
  readonly sourceId: string;
  readonly enabled: boolean;
  readonly state: "disabled" | "reconfiguring" | "starting" | "running" | "failed";
  readonly policy: SourcePolicy;
  readonly permissions: readonly string[];
  readonly error?: string;
}

export interface AmbientContextCaptureOptions {
  readonly id?: string;
  readonly capturedAt?: string;
  /** Filter before resolver correlation. An explicit empty list captures nothing. */
  readonly sourceIds?: readonly string[];
  /** The body type is removed before resolution for every source not listed here. */
  readonly includeFullTextSourceIds?: readonly string[];
}

interface RegisteredSource {
  readonly source: AmbientContextSource;
  readonly manifest: SourceManifest;
  policy: SourcePolicy;
  permissions: readonly string[];
  generation: number;
  lastSequence: number;
  observations: readonly Observation[];
  state: AmbientContextSourceStatus["state"];
  error: string | undefined;
  needsStop: boolean;
  lifecycle: Promise<void>;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const key of Reflect.ownKeys(object)) {
    deepFreeze((object as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

function cloneFrozen<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1_000) || "Ambient context source failed.";
}

function validateManifest(source: AmbientContextSource): SourceManifest {
  const manifest = Schema.decodeUnknownSync(AmbientContextSourceManifest)(source.manifest);
  const capabilityTypes = new Set<string>();
  for (const capability of manifest.capabilities) {
    if (capabilityTypes.has(capability.type)) {
      throw new Error(
        `Ambient context source ${manifest.id} has duplicate capability ${capability.type}.`,
      );
    }
    capabilityTypes.add(capability.type);
    if (new Set(capability.requiredPermissions).size !== capability.requiredPermissions.length) {
      throw new Error(
        `Ambient context source ${manifest.id} has duplicate permissions for ${capability.type}.`,
      );
    }
  }
  return cloneFrozen(manifest);
}

function validatePolicy(policy: unknown, manifest: SourceManifest): SourcePolicy {
  const decoded = Schema.decodeUnknownSync(AmbientContextSourcePolicy)(policy);
  const seen = new Set<string>();
  const capabilityTypes = new Set(manifest.capabilities.map(({ type }) => type));
  for (const type of decoded.allowedTypes) {
    if (seen.has(type)) throw new Error(`Ambient context policy contains duplicate type ${type}.`);
    if (!capabilityTypes.has(type)) {
      throw new Error(`Ambient context source ${manifest.id} does not provide ${type}.`);
    }
    seen.add(type);
  }
  return cloneFrozen(decoded);
}

function validatePermissions(permissions: unknown): readonly string[] {
  const decoded = Schema.decodeUnknownSync(PermissionList)(permissions);
  if (new Set(decoded).size !== decoded.length) {
    throw new Error("Ambient context permission grants must not contain duplicates.");
  }
  return cloneFrozen([...decoded].sort());
}

function effectivePolicy(
  entry: RegisteredSource,
  policy = entry.policy,
  permissions = entry.permissions,
): SourcePolicy {
  const allowedTypes = policy.allowedTypes.filter((type) => {
    const capability = entry.manifest.capabilities.find((candidate) => candidate.type === type);
    return (
      capability?.requiredPermissions.every((permission) => permissions.includes(permission)) ??
      false
    );
  });
  return cloneFrozen({ enabled: policy.enabled && allowedTypes.length > 0, allowedTypes });
}

function isAllowedObservation(
  entry: RegisteredSource,
  observation: Observation,
  policy: SourcePolicy,
): boolean {
  if (!policy.enabled || !policy.allowedTypes.includes(observation.type)) return false;
  const capability = entry.manifest.capabilities.find(({ type }) => type === observation.type);
  return (
    capability?.requiredPermissions.every((permission) => entry.permissions.includes(permission)) ??
    false
  );
}

/**
 * Owns only each source's latest active batch. It does not persist observations
 * or retain any capture history.
 */
export class AmbientContextManager {
  private readonly sources = new Map<string, RegisteredSource>();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;

  constructor(options: AmbientContextManagerOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  registerSource(source: AmbientContextSource): void {
    const manifest = validateManifest(source);
    if (this.sources.has(manifest.id)) {
      throw new Error(`Ambient context source ${manifest.id} is already registered.`);
    }
    if (this.sources.size >= 32) {
      throw new Error("Ambient context manager supports at most 32 sources.");
    }
    this.sources.set(manifest.id, {
      source,
      manifest,
      policy: cloneFrozen({ enabled: false, allowedTypes: [] }),
      permissions: cloneFrozen([]),
      generation: 0,
      lastSequence: -1,
      observations: cloneFrozen([]),
      state: "disabled",
      error: undefined,
      needsStop: false,
      lifecycle: Promise.resolve(),
    });
    this.notifyChanged();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSourceStatuses(): readonly AmbientContextSourceStatus[] {
    return cloneFrozen([...this.sources.keys()].map((sourceId) => this.getSourceStatus(sourceId)));
  }

  getDesktopState(): AmbientContextDesktopState {
    return cloneFrozen({
      sources: [...this.sources.values()].map((entry) => ({
        manifest: entry.manifest,
        policy: entry.policy,
        connected: entry.state === "running",
        error: entry.error ?? null,
      })),
      items: this.resolve(),
    });
  }

  getSourceStatus(sourceId: string): AmbientContextSourceStatus {
    const entry = this.requireSource(sourceId);
    return cloneFrozen({
      sourceId,
      enabled: entry.state === "running",
      state: entry.state,
      policy: entry.policy,
      permissions: entry.permissions,
      ...(entry.error ? { error: entry.error } : {}),
    });
  }

  setPolicy(sourceId: string, policy: SourcePolicy): Promise<void> {
    const entry = this.requireSource(sourceId);
    entry.policy = validatePolicy(policy, entry.manifest);
    return this.reconfigure(entry);
  }

  setPermissions(sourceId: string, permissions: readonly string[]): Promise<void> {
    const entry = this.requireSource(sourceId);
    entry.permissions = validatePermissions(permissions);
    return this.reconfigure(entry);
  }

  /** A disconnected source is stopped, disabled, cleared, and starts a new sequence on reconnect. */
  disconnectSource(sourceId: string): Promise<void> {
    const entry = this.requireSource(sourceId);
    entry.policy = cloneFrozen({ enabled: false, allowedTypes: [] });
    entry.lastSequence = -1;
    return this.reconfigure(entry);
  }

  /** Stop and forget a dynamic source. A failed stop keeps it registered for recovery. */
  unregisterSource(sourceId: string): Promise<void> {
    const entry = this.requireSource(sourceId);
    entry.policy = cloneFrozen({ enabled: false, allowedTypes: [] });
    const generation = this.invalidate(entry);
    return this.enqueue(entry, async () => {
      await this.reconcile(entry, generation);
      if (entry.generation !== generation) {
        throw new Error(`Ambient context source ${sourceId} changed during unregister.`);
      }
      if (entry.needsStop || entry.state === "failed") {
        throw new Error(`Could not stop ambient context source ${sourceId}.`);
      }
      this.sources.delete(sourceId);
      this.notifyChanged();
    });
  }

  /** Disable and clear every source immediately, then serialize resource cleanup. */
  stop(): Promise<void> {
    const pending = [...this.sources.values()].map((entry) => {
      entry.policy = cloneFrozen({ enabled: false, allowedTypes: [] });
      entry.lastSequence = -1;
      return [entry, this.invalidate(entry)] as const;
    });
    return Promise.all(
      pending.map(([entry, generation]) =>
        this.enqueue(entry, async () => {
          await this.reconcile(entry, generation);
          return entry.generation === generation && (entry.needsStop || entry.state === "failed");
        }),
      ),
    ).then((cleanupFailed) => {
      const failedSources = pending
        .filter((_, index) => cleanupFailed[index])
        .map(([entry]) => entry.manifest.id);
      if (failedSources.length > 0) {
        throw new Error(`Ambient context cleanup failed for sources: ${failedSources.join(", ")}.`);
      }
    });
  }

  resolveActive(
    now = this.now(),
    sourceIds?: readonly string[],
    includeFullTextSourceIds?: readonly string[],
  ): readonly ResolvedAmbientContextItem[] {
    const selected = sourceIds === undefined ? undefined : new Set(sourceIds);
    if (selected && selected.size !== sourceIds?.length) {
      throw new Error("Ambient context source IDs must be unique.");
    }
    for (const sourceId of selected ?? []) this.requireSource(sourceId);
    const fullTextSources =
      includeFullTextSourceIds === undefined ? undefined : new Set(includeFullTextSourceIds);
    if (fullTextSources && fullTextSources.size !== includeFullTextSourceIds?.length) {
      throw new Error("Full-text context source IDs must be unique.");
    }
    for (const sourceId of fullTextSources ?? []) {
      this.requireSource(sourceId);
      if (selected && !selected.has(sourceId)) {
        throw new Error("Full-text sources must be selected context sources.");
      }
    }
    const inputs = [...this.sources.values()]
      .filter(
        (entry) => entry.state === "running" && (!selected || selected.has(entry.manifest.id)),
      )
      .map((entry) => ({
        sourceId: entry.manifest.id,
        manifest: entry.manifest,
        policy: effectivePolicy(entry),
        permissions: entry.permissions,
        observations:
          fullTextSources === undefined || fullTextSources.has(entry.manifest.id)
            ? entry.observations
            : entry.observations.filter((observation) => observation.type !== "resource.content"),
      }));
    return cloneFrozen(resolveAmbientContext(inputs, now));
  }

  resolve(now = this.now()): readonly ResolvedAmbientContextItem[] {
    return this.resolveActive(now);
  }

  /** True when this source has a prior non-empty batch, but every item has expired. */
  hasExpiredObservations(sourceId: string, now = this.now()): boolean {
    const entry = this.requireSource(sourceId);
    if (entry.observations.length === 0) return false;
    return !entry.observations.some((observation) => {
      const age = now - Date.parse(observation.capturedAt);
      return age <= AMBIENT_CONTEXT_FRESHNESS_MS && age >= -5_000;
    });
  }

  capture(options: AmbientContextCaptureOptions = {}): Snapshot {
    const now = this.now();
    const capturedAt = options.capturedAt ?? new Date(now).toISOString();
    const candidate = {
      schemaVersion: 1,
      id: options.id ?? randomUUID(),
      capturedAt,
      items: this.resolveActive(now, options.sourceIds, options.includeFullTextSourceIds ?? []),
    };
    const snapshot = Schema.decodeUnknownOption(AmbientContextSnapshot)(candidate);
    if (snapshot._tag === "None") {
      // Effect parse errors can include offending data; keep external text out of errors.
      throw new Error(AMBIENT_CONTEXT_SNAPSHOT_LIMIT_ERROR);
    }
    return cloneFrozen(snapshot.value);
  }

  private requireSource(sourceId: string): RegisteredSource {
    const entry = this.sources.get(sourceId);
    if (!entry) throw new Error(`Unknown ambient context source ${sourceId}.`);
    return entry;
  }

  private invalidate(entry: RegisteredSource): number {
    entry.generation += 1;
    entry.observations = cloneFrozen([]);
    entry.error = undefined;
    entry.state = "reconfiguring";
    this.notifyChanged();
    return entry.generation;
  }

  private reconfigure(entry: RegisteredSource): Promise<void> {
    const generation = this.invalidate(entry);
    return this.enqueue(entry, () => this.reconcile(entry, generation));
  }

  private enqueue<T>(entry: RegisteredSource, operation: () => Promise<T>): Promise<T> {
    const result = entry.lifecycle.then(operation, operation);
    entry.lifecycle = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async reconcile(entry: RegisteredSource, generation: number): Promise<void> {
    if (entry.generation !== generation) return;
    if (entry.needsStop) {
      try {
        await entry.source.stop();
        entry.needsStop = false;
      } catch (error) {
        if (entry.generation === generation) {
          entry.state = "failed";
          entry.error = `Could not stop source: ${errorMessage(error)}`;
          this.notifyChanged();
        }
        return;
      }
    }
    if (entry.generation !== generation) return;

    const policy = effectivePolicy(entry);
    if (!policy.enabled) {
      entry.state = "disabled";
      entry.error = undefined;
      this.notifyChanged();
      return;
    }

    entry.lastSequence = -1;
    entry.state = "starting";
    entry.error = undefined;
    this.notifyChanged();
    const emit = (publication: unknown): void => {
      if (
        entry.generation !== generation ||
        (entry.state !== "starting" && entry.state !== "running")
      )
        return;
      try {
        const decoded = Schema.decodeUnknownSync(AmbientContextPublication)(publication);
        if (decoded.sequence <= entry.lastSequence) return;
        const observations = decoded.observations.filter((item) =>
          isAllowedObservation(entry, item, policy),
        );
        entry.observations = cloneFrozen(observations);
        entry.lastSequence = decoded.sequence;
        entry.error = undefined;
        this.notifyChanged();
      } catch {
        entry.observations = cloneFrozen([]);
        entry.error = "Invalid publication.";
        this.notifyChanged();
      }
    };

    entry.needsStop = true;
    try {
      await entry.source.start(policy, emit);
    } catch (startError) {
      let cleanupError: string | undefined;
      try {
        await entry.source.stop();
        entry.needsStop = false;
      } catch (error) {
        cleanupError = ` Cleanup also failed: ${errorMessage(error)}`;
      }
      entry.observations = cloneFrozen([]);
      if (entry.generation === generation) {
        entry.state = "failed";
        entry.error = `Could not start source: ${errorMessage(startError)}${cleanupError ?? ""}`;
        this.notifyChanged();
      }
      return;
    }

    if (entry.generation !== generation) {
      try {
        await entry.source.stop();
        entry.needsStop = false;
      } catch (error) {
        entry.error = `Could not stop stale source: ${errorMessage(error)}`;
      }
      entry.observations = cloneFrozen([]);
      this.notifyChanged();
      return;
    }
    entry.state = "running";
    this.notifyChanged();
    // A malformed publication is visible as an error while the source remains
    // running; start/cleanup failures always leave enabled false.
  }

  private notifyChanged(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // Subscribers are observers. A broken observer cannot interrupt source cleanup.
      }
    }
  }
}
