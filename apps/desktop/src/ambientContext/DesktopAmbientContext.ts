import { createHash, randomBytes } from "node:crypto";
import * as Fs from "node:fs/promises";
import * as Path from "node:path";
import {
  AMBIENT_CONTEXT_FRESHNESS_MS,
  AmbientContextSourcePolicy,
  type AmbientContextDesktopState,
  type AmbientContextCaptureRequestOptions,
  type AmbientContextSourcePolicy as SourcePolicy,
} from "@synara/contracts";
import { Schema } from "effect";
import { AmbientContextManager } from "./AmbientContextManager";
import {
  readObsidianVaultDiscoveries,
  readOrCreateInstanceId,
  removeConnectionGrant,
  removeInstanceDiscovery,
  writeConnectionGrant,
  writeInstanceDiscovery,
  writeJson,
  type ObsidianVaultDiscovery,
} from "./AmbientContextDiscovery";
import { OBSIDIAN_CONTEXT_MANIFEST, ObsidianSource } from "./ObsidianSource";

const DEFAULT_POLICY: SourcePolicy = { enabled: false, allowedTypes: [] };
const GRANT_FILE = "ambient-context-connections.json";
const RUNTIME_FILE = "ambient-context-runtime.json";
const MAX_CONNECTIONS = 32;
const CONNECTION_ID = /^[a-f0-9]{64}$/;
const CaptureSourceIds = Schema.Array(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
).check(Schema.isMaxLength(MAX_CONNECTIONS));
const CaptureOptions = Schema.Struct({
  includeFullTextSourceIds: Schema.optional(CaptureSourceIds),
});

interface StoredGrant {
  readonly id: string;
  readonly sourceId: string;
  readonly vaultId: string;
  readonly label: string;
  readonly token: string;
  readonly approvedAt: string;
}

interface ActiveConnection extends StoredGrant {
  readonly source: ObsidianSource;
  registered: boolean;
  revoking: boolean;
  persistedRevoked: boolean;
}

export interface DesktopAmbientContextOptions {
  /** Shared per-user app-data root used only for nonsecret discovery and plugin grants. */
  readonly sharedDataDirectory?: string;
  readonly instanceLabel?: string;
  readonly now?: () => number;
  /** @internal Deterministic lifecycle gate used to exercise delayed restoration. */
  readonly initializationBarrier?: Promise<void>;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
  );
}

function sourceIdFor(instanceId: string, vaultId: string): string {
  return createHash("sha256").update(`${instanceId}\0${vaultId}`).digest("hex");
}

function decodeGrant(value: unknown): StoredGrant | undefined {
  if (!value || typeof value !== "object") return undefined;
  const grant = value as Record<string, unknown>;
  if (
    !isUuid(grant.vaultId) ||
    typeof grant.id !== "string" ||
    !CONNECTION_ID.test(grant.id) ||
    grant.sourceId !== grant.id ||
    typeof grant.label !== "string" ||
    grant.label.length > 128 ||
    typeof grant.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(grant.token) ||
    typeof grant.approvedAt !== "string" ||
    !Number.isFinite(Date.parse(grant.approvedAt))
  )
    return undefined;
  return {
    id: grant.id,
    sourceId: grant.sourceId,
    vaultId: grant.vaultId,
    label: grant.label,
    token: grant.token,
    approvedAt: grant.approvedAt,
  };
}

export class AmbientContextCaptureUnavailableError extends Error {
  constructor(
    readonly sourceIds: readonly string[],
    reason: string,
  ) {
    super(`Selected Obsidian context is unavailable (${sourceIds.join(", ")}): ${reason}`);
    this.name = "AmbientContextCaptureUnavailableError";
  }
}

/** Per-profile policy and grants, with one isolated bridge/source per discovered Vault. */
export class DesktopAmbientContext {
  readonly manager: AmbientContextManager;
  readonly connections = new Map<string, ActiveConnection>();
  private readonly userDataDirectory: string;
  private readonly sharedDataDirectory: string;
  private readonly instanceLabel: string;
  private readonly now: () => number;
  private readonly ready: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly unsubscribe: () => void;
  private readonly pending = new Map<string, ObsidianVaultDiscovery>();
  private readonly dismissedRequests = new Map<string, string>();
  private refreshWork: Promise<void> = Promise.resolve();
  private settingsError: string | null = null;
  private stopped = false;
  private configurationRevision = 0;
  private instanceId = "";
  private policy: SourcePolicy = DEFAULT_POLICY;

  constructor(
    private readonly settingsPath: string,
    private readonly changed: () => void,
    options: DesktopAmbientContextOptions = {},
  ) {
    this.userDataDirectory = Path.dirname(settingsPath);
    this.sharedDataDirectory =
      options.sharedDataDirectory ?? Path.join(this.userDataDirectory, "ambient-context-discovery");
    this.instanceLabel = options.instanceLabel ?? "Synara";
    this.now = options.now ?? Date.now;
    this.manager = new AmbientContextManager({ now: this.now });
    this.unsubscribe = this.manager.subscribe(changed);
    this.ready = this.restore(options.initializationBarrier);
    void this.ready.catch(() => undefined);
    this.timer = setInterval(() => {
      if (this.stopped) return;
      void this.refreshDiscovery().catch(() => undefined);
      if (this.policy.enabled) this.changed();
    }, 1_000);
    this.timer.unref();
  }

  private async restore(initializationBarrier?: Promise<void>): Promise<void> {
    await initializationBarrier;
    await Fs.mkdir(this.userDataDirectory, { recursive: true, mode: 0o700 });
    this.instanceId = await readOrCreateInstanceId(this.userDataDirectory);
    try {
      const stat = await Fs.stat(this.settingsPath);
      if (stat.size > 8_192) throw new Error("Invalid context preferences.");
      this.policy = Schema.decodeUnknownSync(AmbientContextSourcePolicy)(
        JSON.parse(await Fs.readFile(this.settingsPath, "utf8")),
      );
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        this.settingsError = "Context preferences could not be loaded. Context remains disabled.";
        this.policy = DEFAULT_POLICY;
      }
    }

    const grants = await this.readStoredGrants();
    for (const grant of grants) {
      if (grant.id !== sourceIdFor(this.instanceId, grant.vaultId)) continue;
      const source = new ObsidianSource(this.changed, grant.sourceId, grant.label, grant.token);
      this.manager.registerSource(source);
      const active: ActiveConnection = {
        ...grant,
        source,
        registered: true,
        revoking: false,
        persistedRevoked: false,
      };
      this.connections.set(grant.id, active);
      await this.manager.setPolicy(grant.sourceId, this.policy);
      await writeConnectionGrant(
        this.sharedDataDirectory,
        this.instanceId,
        grant.vaultId,
        grant.sourceId,
        grant.token,
      );
    }
    await this.refreshDiscovery(true);
    await this.writeRuntimeDiscovery();
  }

  private async readStoredGrants(): Promise<readonly StoredGrant[]> {
    const path = Path.join(this.userDataDirectory, GRANT_FILE);
    try {
      const stat = await Fs.stat(path);
      if (stat.size > 65_536) throw new Error("Saved Obsidian connections are invalid.");
      const value = JSON.parse(await Fs.readFile(path, "utf8")) as unknown;
      if (!Array.isArray(value)) throw new Error("Saved Obsidian connections are invalid.");
      return value.flatMap((item) => {
        const grant = decodeGrant(item);
        return grant ? [grant] : [];
      });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return [];
      }
      this.settingsError = "Saved Obsidian connections could not be loaded.";
      return [];
    }
  }

  private async persistGrants(): Promise<void> {
    const grants = [...this.connections.values()]
      .filter((connection) => !connection.revoking)
      .map(({ id, sourceId, vaultId, label, token, approvedAt }) => ({
        id,
        sourceId,
        vaultId,
        label,
        token,
        approvedAt,
      }));
    await writeJson(Path.join(this.userDataDirectory, GRANT_FILE), grants);
  }

  private refreshDiscovery(restoring = false): Promise<void> {
    if (restoring) return this.performRefreshDiscovery();
    const afterReady = this.ready
      .catch(() => undefined)
      .then(() => {
        if (this.stopped) return;
        return this.enqueueDiscoveryRefresh();
      });
    return afterReady;
  }

  private enqueueDiscoveryRefresh(): Promise<void> {
    const operation = this.refreshWork.then(
      () => this.performRefreshDiscovery(),
      () => this.performRefreshDiscovery(),
    );
    this.refreshWork = operation.catch(() => undefined);
    return operation;
  }

  private async performRefreshDiscovery(): Promise<void> {
    if (this.stopped) return;
    if (!this.instanceId || this.stopped) return;
    const vaults = await readObsidianVaultDiscoveries(
      Path.join(this.sharedDataDirectory, "vaults"),
      this.now(),
    );
    this.pending.clear();
    for (const vault of vaults) {
      const id = sourceIdFor(this.instanceId, vault.vaultId);
      if (this.dismissedRequests.get(id) === vault.requestId) continue;
      this.dismissedRequests.delete(id);
      if (!this.connections.has(id)) this.pending.set(id, vault);
    }
    if (this.stopped) return;
    await this.writeRuntimeDiscovery();
    this.changed();
  }

  private async writeRuntimeDiscovery(): Promise<void> {
    if (!this.instanceId || this.stopped) return;
    const activeConnections = [...this.connections.values()]
      .filter((connection) => !connection.revoking)
      .flatMap((connection) => {
        try {
          const { endpoint } = connection.source.pairing();
          return [
            {
              id: connection.id,
              sourceId: connection.sourceId,
              vaultId: connection.vaultId,
              label: connection.label,
              endpoint,
            },
          ];
        } catch {
          return [];
        }
      });
    const record = {
      schemaVersion: 1 as const,
      instanceId: this.instanceId,
      label: this.instanceLabel,
      updatedAt: new Date(this.now()).toISOString(),
      connections: activeConnections,
    };
    await writeJson(Path.join(this.userDataDirectory, RUNTIME_FILE), record).catch(() => undefined);
    await writeInstanceDiscovery(this.sharedDataDirectory, record).catch(() => undefined);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(operation, operation);
    this.writes = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async getState(): Promise<AmbientContextDesktopState> {
    await this.ready;
    const sourceStatuses = [...this.connections.values()].map((connection) => ({
      connection,
      status: this.manager.getSourceStatus(connection.sourceId),
    }));
    const connectionState = sourceStatuses.map(({ connection, status }) => ({
      id: connection.id,
      sourceId: connection.sourceId,
      label: connection.label,
      connected: status.state === "running" && connection.source.connected,
      error:
        (connection.revoking
          ? "Revocation is incomplete; retry it to finish disconnecting this Vault."
          : status.error) ??
        (status.state === "disabled" && this.policy.enabled
          ? "Connection is disabled."
          : this.manager.hasExpiredObservations(connection.sourceId, this.now())
            ? `The latest context expired after ${AMBIENT_CONTEXT_FRESHNESS_MS / 1_000} seconds.`
            : null),
    }));
    return {
      sources: [
        {
          manifest: OBSIDIAN_CONTEXT_MANIFEST,
          policy: this.policy,
          connected: sourceStatuses.some(
            ({ status, connection }) => status.state === "running" && connection.source.connected,
          ),
          error: this.settingsError,
        },
      ],
      items: this.manager.resolve(),
      connections: connectionState,
      pendingConnections: [...this.pending].map(([id, vault]) => ({ id, label: vault.label })),
    };
  }

  async configure(sourceId: unknown, value: unknown): Promise<AmbientContextDesktopState> {
    if (this.stopped) throw new Error("Context service is stopped.");
    if (sourceId !== "obsidian") throw new Error("Unknown context source.");
    const policy = Schema.decodeUnknownSync(AmbientContextSourcePolicy)(value);
    this.configurationRevision += 1;
    await this.enqueue(async () => {
      await this.ready;
      if (this.stopped) throw new Error("Context service is stopped.");
      this.policy = policy;
      for (const connection of this.connections.values()) {
        await this.manager.setPolicy(
          connection.sourceId,
          connection.revoking ? DEFAULT_POLICY : policy,
        );
      }
      try {
        await Fs.mkdir(Path.dirname(this.settingsPath), { recursive: true, mode: 0o700 });
        await writeJson(this.settingsPath, policy);
        this.settingsError = null;
      } catch {
        this.settingsError =
          "Context preferences could not be saved. The current session was updated.";
        throw new Error(this.settingsError);
      }
      await this.writeRuntimeDiscovery();
    });
    return this.getState();
  }

  async approveConnection(id: unknown): Promise<AmbientContextDesktopState> {
    if (typeof id !== "string") throw new Error("Unknown Obsidian connection.");
    await this.ready;
    return this.enqueue(async () => {
      if (this.stopped) throw new Error("Context service is stopped.");
      const existing = this.connections.get(id);
      if (existing) {
        if (existing.revoking) throw new Error("Finish revoking this Obsidian connection first.");
        await this.persistGrants();
        await writeConnectionGrant(
          this.sharedDataDirectory,
          this.instanceId,
          existing.vaultId,
          existing.sourceId,
          existing.token,
        );
        await this.manager.setPolicy(existing.sourceId, this.policy);
        await this.writeRuntimeDiscovery();
        return this.getState();
      }
      const vault = this.pending.get(id);
      if (!vault) throw new Error("Unknown or expired Obsidian discovery request.");
      if (this.connections.size >= MAX_CONNECTIONS) throw new Error("Too many Obsidian Vaults.");
      const sourceId = sourceIdFor(this.instanceId, vault.vaultId);
      if (id !== sourceId) throw new Error("Invalid Obsidian connection identity.");
      const grant: StoredGrant = {
        id,
        sourceId,
        vaultId: vault.vaultId,
        label: vault.label,
        token: randomBytes(32).toString("hex"),
        approvedAt: new Date(this.now()).toISOString(),
      };
      let source: ObsidianSource;
      source = new ObsidianSource(this.changed, sourceId, vault.label, grant.token);
      this.manager.registerSource(source);
      this.connections.set(id, {
        ...grant,
        source,
        registered: true,
        revoking: false,
        persistedRevoked: false,
      });
      try {
        await this.persistGrants();
        await writeConnectionGrant(
          this.sharedDataDirectory,
          this.instanceId,
          grant.vaultId,
          grant.sourceId,
          grant.token,
        );
        await this.manager.setPolicy(sourceId, this.policy);
        await this.writeRuntimeDiscovery();
      } catch (error) {
        try {
          await this.manager.unregisterSource(sourceId);
          source.clearCredential();
          this.connections.delete(id);
        } catch {
          // Keep a tracked record if cleanup could not stop the listener.
        }
        await this.persistGrants().catch(() => undefined);
        await removeConnectionGrant(this.sharedDataDirectory, this.instanceId, grant.vaultId);
        throw error;
      }
      this.pending.delete(id);
      this.changed();
      return this.getState();
    });
  }

  async revokeConnection(id: unknown): Promise<AmbientContextDesktopState> {
    if (typeof id !== "string") throw new Error("Unknown Obsidian connection.");
    await this.ready;
    return this.enqueue(async () => {
      if (this.stopped) throw new Error("Context service is stopped.");
      const connection = this.connections.get(id);
      if (!connection) {
        const pending = this.pending.get(id);
        if (!pending) throw new Error("Unknown Obsidian connection.");
        this.dismissedRequests.set(id, pending.requestId);
        this.pending.delete(id);
        this.changed();
        return this.getState();
      }
      connection.revoking = true;
      this.configurationRevision += 1;
      await this.writeRuntimeDiscovery();
      try {
        if (connection.registered) await this.manager.disconnectSource(connection.sourceId);
        if (!connection.persistedRevoked) {
          await this.persistGrants();
          connection.persistedRevoked = true;
        }
        await removeConnectionGrant(this.sharedDataDirectory, this.instanceId, connection.vaultId);
        if (connection.registered) {
          await this.manager.unregisterSource(connection.sourceId);
          connection.registered = false;
        }
        connection.source.clearCredential();
        this.connections.delete(id);
        await this.writeRuntimeDiscovery();
        this.changed();
      } catch (error) {
        await this.writeRuntimeDiscovery();
        this.changed();
        throw error;
      }
      return this.getState();
    });
  }

  async pairing(sourceId: unknown): Promise<{ endpoint: string; token: string }> {
    await this.ready;
    if (typeof sourceId !== "string") throw new Error("Unknown context source.");
    if (sourceId === "obsidian") {
      if (this.connections.size !== 1) {
        throw new Error("Select a specific Obsidian Vault connection for pairing.");
      }
      return [...this.connections.values()][0]!.source.pairing();
    }
    const connection = this.connections.get(sourceId);
    if (!connection) throw new Error("Unknown context source.");
    return connection.source.pairing();
  }

  async capture(sourceIds?: readonly string[], options: AmbientContextCaptureRequestOptions = {}) {
    await this.ready;
    if (this.stopped) throw new Error("Context service is stopped.");
    const selectedIds =
      sourceIds === undefined ? [] : Schema.decodeUnknownSync(CaptureSourceIds)(sourceIds);
    const decodedOptions = Schema.decodeUnknownSync(CaptureOptions)(options);
    const fullTextIds = decodedOptions.includeFullTextSourceIds ?? [];
    if (
      new Set(selectedIds).size !== selectedIds.length ||
      new Set(fullTextIds).size !== fullTextIds.length ||
      fullTextIds.some((sourceId) => !selectedIds.includes(sourceId))
    ) {
      throw new Error("Invalid full-text context selection.");
    }
    if (selectedIds.length === 0) {
      return this.manager.capture({ sourceIds: [] });
    }
    const unavailable = new Set<string>();
    for (const sourceId of selectedIds) {
      const connection = this.connections.get(sourceId);
      if (!connection) {
        unavailable.add(sourceId);
        continue;
      }
      const status = this.manager.getSourceStatus(sourceId);
      if (
        connection.revoking ||
        status.state !== "running" ||
        !connection.source.connected ||
        this.manager.hasExpiredObservations(sourceId, this.now())
      ) {
        unavailable.add(sourceId);
      }
      if (
        fullTextIds.includes(sourceId) &&
        !status.policy.allowedTypes.includes("resource.content")
      ) {
        unavailable.add(sourceId);
      }
    }
    if (unavailable.size > 0) {
      throw new AmbientContextCaptureUnavailableError(
        [...unavailable],
        "the Vault is disconnected, disabled, or has no fresh context",
      );
    }
    const snapshot = this.manager.capture({
      sourceIds: selectedIds,
      includeFullTextSourceIds: fullTextIds,
    });
    const activeSourceIds = new Set(
      snapshot.items.flatMap((item) => item.provenance.map((p) => p.sourceId)),
    );
    const missing = selectedIds.filter((sourceId) => !activeSourceIds.has(sourceId));
    if (missing.length > 0) {
      throw new AmbientContextCaptureUnavailableError(
        missing,
        "the latest context expired during capture",
      );
    }
    return snapshot;
  }

  async searchResources(query: unknown) {
    await this.ready;
    if (typeof query !== "string" || query.length > 256)
      throw new Error("Invalid resource search.");
    if (
      this.stopped ||
      !this.policy.enabled ||
      !this.policy.allowedTypes.includes("resource.identity")
    ) {
      return [];
    }
    const revision = this.configurationRevision;
    const results = await Promise.all(
      [...this.connections.values()].map(async (connection) => {
        if (connection.revoking || !connection.registered) return [];
        const status = this.manager.getSourceStatus(connection.sourceId);
        if (status.state !== "running") return [];
        try {
          return await connection.source.searchResources(query);
        } catch {
          return [];
        }
      }),
    );
    return !this.stopped && revision === this.configurationRevision
      ? results.flat().slice(0, 30)
      : [];
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.configurationRevision += 1;
    clearInterval(this.timer);
    this.unsubscribe();
    const settled = await Promise.allSettled([this.ready, this.writes, this.refreshWork]);
    const failureResult = settled.find((result) => result.status === "rejected");
    let failure: unknown = failureResult?.status === "rejected" ? failureResult.reason : undefined;
    try {
      await this.manager.stop();
    } catch (error) {
      failure ??= error;
    } finally {
      await removeInstanceDiscovery(this.sharedDataDirectory, this.instanceId).catch(
        () => undefined,
      );
      await Fs.rm(Path.join(this.userDataDirectory, RUNTIME_FILE), { force: true }).catch(
        () => undefined,
      );
    }
    if (failure) throw failure;
  }
}
