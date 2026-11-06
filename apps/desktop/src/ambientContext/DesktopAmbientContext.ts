import * as Fs from "node:fs/promises";
import * as Path from "node:path";
import { AmbientContextSourcePolicy, type AmbientContextDesktopState } from "@synara/contracts";
import { Schema } from "effect";
import { AmbientContextManager } from "./AmbientContextManager";
import { ObsidianSource } from "./ObsidianSource";

/** App-identity-scoped settings; neither credentials nor observations are persisted here. */
export class DesktopAmbientContext {
  readonly manager = new AmbientContextManager();
  readonly obsidian: ObsidianSource;
  private readonly ready: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly unsubscribe: () => void;
  private settingsError: string | null = null;
  private stopped = false;
  private configurationRevision = 0;

  constructor(
    private readonly settingsPath: string,
    changed: () => void,
  ) {
    this.obsidian = new ObsidianSource(changed);
    this.manager.registerSource(this.obsidian);
    this.unsubscribe = this.manager.subscribe(changed);
    this.ready = this.restore();
    this.timer = setInterval(() => {
      if (this.manager.getSourceStatus("obsidian").policy.enabled) changed();
    }, 1_000);
    this.timer.unref();
  }

  private async restore(): Promise<void> {
    try {
      const stat = await Fs.stat(this.settingsPath);
      if (stat.size > 8_192) throw new Error("Invalid context preferences.");
      const policy = Schema.decodeUnknownSync(AmbientContextSourcePolicy)(
        JSON.parse(await Fs.readFile(this.settingsPath, "utf8")),
      );
      await this.manager.setPolicy("obsidian", policy);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        this.settingsError = "Context preferences could not be loaded. Context remains disabled.";
      }
    }
  }

  async getState(): Promise<AmbientContextDesktopState> {
    await this.ready;
    const state = this.manager.getDesktopState();
    return {
      ...state,
      sources: state.sources.map((source) => ({
        ...source,
        connected: source.manifest.id === "obsidian" && this.obsidian.connected,
        error: source.error ?? this.settingsError,
      })),
    };
  }

  async configure(sourceId: unknown, value: unknown): Promise<AmbientContextDesktopState> {
    if (this.stopped) throw new Error("Context service is stopped.");
    if (sourceId !== "obsidian") throw new Error("Unknown context source.");
    const policy = Schema.decodeUnknownSync(AmbientContextSourcePolicy)(value);
    this.configurationRevision += 1;
    const operation = this.writes.then(async () => {
      await this.ready;
      if (this.stopped) throw new Error("Context service is stopped.");
      await this.manager.setPolicy(sourceId, policy);
      try {
        await Fs.mkdir(Path.dirname(this.settingsPath), { recursive: true });
        const temporary = `${this.settingsPath}.tmp`;
        await Fs.writeFile(temporary, JSON.stringify(policy), { mode: 0o600 });
        await Fs.rename(temporary, this.settingsPath);
        this.settingsError = null;
      } catch {
        this.settingsError =
          "Context preferences could not be saved. The current session was updated.";
        throw new Error(this.settingsError);
      }
    });
    this.writes = operation.catch(() => undefined);
    await operation;
    return this.getState();
  }

  async pairing(sourceId: unknown): Promise<{ endpoint: string; token: string }> {
    await this.ready;
    if (sourceId !== "obsidian") throw new Error("Unknown context source.");
    return this.obsidian.pairing();
  }

  async capture() {
    await this.ready;
    return this.manager.capture();
  }

  async searchResources(query: unknown) {
    await this.ready;
    if (typeof query !== "string" || query.length > 256)
      throw new Error("Invalid resource search.");
    const status = this.manager.getSourceStatus("obsidian");
    if (
      this.stopped ||
      status.state !== "running" ||
      !status.policy.allowedTypes.includes("resource.identity")
    )
      return [];
    const revision = this.configurationRevision;
    const resources = await this.obsidian.searchResources(query);
    return !this.stopped && revision === this.configurationRevision ? resources : [];
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.configurationRevision += 1;
    clearInterval(this.timer);
    this.unsubscribe();
    await this.ready;
    await this.writes;
    await this.manager.stop();
  }
}
