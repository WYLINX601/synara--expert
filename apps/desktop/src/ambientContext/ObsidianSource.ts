import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  AmbientContextPublication,
  AmbientResourceReference,
  type AmbientContextSourceManifest,
  type AmbientContextSourcePolicy,
} from "@synara/contracts";
import { Schema } from "effect";
import { WebSocket, WebSocketServer } from "ws";

export const OBSIDIAN_CONTEXT_MANIFEST: AmbientContextSourceManifest = {
  id: "obsidian",
  label: "Obsidian",
  kind: "application",
  capabilities: [
    "application.identity",
    "resource.identity",
    "selection.text",
    "selection.location",
    "resource.content",
  ].map((type) => ({
    type: type as AmbientContextSourceManifest["capabilities"][number]["type"],
    captureMode: "event",
    precision: "exact",
    requiredPermissions: [],
  })),
};

const SearchResults = Schema.Array(AmbientResourceReference).check(Schema.isMaxLength(30));
const MAX_FRAME_BYTES = 262_144;
const SEARCH_TIMEOUT_MS = 3_000;

/** A session-paired data-only bridge. It has no filesystem or task execution API. */
export class ObsidianSource {
  readonly manifest = OBSIDIAN_CONTEXT_MANIFEST;
  private server: WebSocketServer | undefined;
  private peer: WebSocket | undefined;
  private token = "";
  private endpoint = "";
  private publicationSequence = 0;
  private policy: AmbientContextSourcePolicy = { enabled: false, allowedTypes: [] };
  private emit: ((publication: AmbientContextPublication) => void) | undefined;
  private readonly searches = new Map<
    string,
    {
      resolve: (resources: readonly AmbientResourceReference[]) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(private readonly changed: () => void = () => {}) {}

  get connected(): boolean {
    return this.peer?.readyState === WebSocket.OPEN;
  }

  pairing(): { endpoint: string; token: string } {
    if (!this.server || !this.endpoint || !this.policy.enabled) {
      throw new Error("Enable Obsidian context before pairing.");
    }
    return { endpoint: this.endpoint, token: this.token };
  }

  async start(
    policy: AmbientContextSourcePolicy,
    emit: (publication: AmbientContextPublication) => void,
  ): Promise<void> {
    if (this.server) throw new Error("Obsidian source is already running.");
    this.policy = policy;
    this.emit = emit;
    this.publicationSequence = 0;
    this.token = randomBytes(32).toString("hex");
    const server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      maxPayload: MAX_FRAME_BYTES,
      perMessageDeflate: false,
      // Credentials are sent in the first frame, never in URL/query/logs.
      verifyClient: ({ origin, req }: { origin: string; req: IncomingMessage }) =>
        (req.socket.remoteAddress === "127.0.0.1" ||
          req.socket.remoteAddress === "::ffff:127.0.0.1") &&
        (!origin || origin === "app://obsidian.md"),
    });
    this.server = server;
    server.on("connection", (peer) => this.accept(peer));
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    server.on("error", () => {
      this.peer?.terminate();
      this.changed();
    });
    const address = server.address();
    if (typeof address === "string" || !address) throw new Error("Context bridge has no address.");
    this.endpoint = `ws://127.0.0.1:${address.port}`;
  }

  private accept(peer: WebSocket): void {
    if (!this.policy.enabled || (this.server?.clients.size ?? 0) > 4) {
      peer.close(1008);
      return;
    }
    let authenticated = false;
    let sequence = -1;
    let windowStart = Date.now();
    let messages = 0;
    const authTimeout = setTimeout(() => peer.terminate(), 3_000);
    peer.on("error", () => peer.terminate());
    peer.on("message", (data, binary) => {
      try {
        if (binary) throw new Error("Text frames required.");
        if (Date.now() - windowStart >= 1_000) {
          windowStart = Date.now();
          messages = 0;
        }
        if (++messages > 30) throw new Error("Context rate limit exceeded.");
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (!message || typeof message !== "object") throw new Error("Invalid frame.");
        if (!authenticated) {
          if (message.kind !== "pair" || typeof message.token !== "string")
            throw new Error("Pair first.");
          const token = Buffer.from(message.token);
          const expected = Buffer.from(this.token);
          if (
            !expected.length ||
            token.length !== expected.length ||
            !timingSafeEqual(token, expected)
          ) {
            throw new Error("Invalid pairing.");
          }
          // A second Vault cannot silently replace the currently paired Vault.
          if (this.peer) throw new Error("Another Obsidian connection is active.");
          authenticated = true;
          clearTimeout(authTimeout);
          this.peer = peer;
          peer.send(JSON.stringify({ kind: "policy", policy: this.policy }));
          this.changed();
          return;
        }
        if (peer !== this.peer || !this.policy.enabled) throw new Error("Connection revoked.");
        if (message.kind === "publish") {
          const publication = Schema.decodeUnknownSync(AmbientContextPublication)(
            message.publication,
          );
          if (publication.sequence <= sequence) return;
          sequence = publication.sequence;
          this.emit?.({ ...publication, sequence: this.publicationSequence++ });
          this.changed();
        } else if (message.kind === "search-result") {
          if (typeof message.requestId !== "string") throw new Error("Invalid search response.");
          const pending = this.searches.get(message.requestId);
          if (!pending) return;
          const results = Schema.decodeUnknownSync(SearchResults)(message.resources);
          if (results.some((resource) => resource.sourceId !== this.manifest.id)) {
            throw new Error("Invalid resource source.");
          }
          clearTimeout(pending.timer);
          this.searches.delete(message.requestId);
          pending.resolve(results);
        } else throw new Error("Unsupported context message.");
      } catch {
        // Never echo untrusted content or pairing credentials in an error.
        peer.close(1008, "Invalid or unauthorized context message");
      }
    });
    peer.on("close", () => {
      clearTimeout(authTimeout);
      if (this.peer !== peer) return;
      this.peer = undefined;
      // Clear the active batch immediately; reconnect sequences begin at zero.
      this.emit?.({ sequence: this.publicationSequence++, observations: [] });
      this.rejectSearches();
      this.changed();
    });
  }

  async searchResources(query: string): Promise<readonly AmbientResourceReference[]> {
    const peer = this.peer;
    if (!this.policy.allowedTypes.includes("resource.identity") || !this.policy.enabled) return [];
    if (!peer || peer.readyState !== WebSocket.OPEN) throw new Error("Obsidian is not connected.");
    if (query.length > 256 || this.searches.size >= 8 || peer.bufferedAmount > MAX_FRAME_BYTES) {
      throw new Error("Context search limit exceeded.");
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.searches.delete(requestId);
        reject(new Error("Obsidian resource search timed out."));
      }, SEARCH_TIMEOUT_MS);
      this.searches.set(requestId, { resolve, reject, timer });
      peer.send(JSON.stringify({ kind: "search", requestId, query }));
    });
  }

  private rejectSearches(): void {
    for (const pending of this.searches.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Obsidian connection closed."));
    }
    this.searches.clear();
  }

  async stop(): Promise<void> {
    this.policy = { enabled: false, allowedTypes: [] };
    this.token = "";
    this.endpoint = "";
    this.emit = undefined;
    this.peer = undefined;
    this.rejectSearches();
    const server = this.server;
    this.server = undefined;
    if (server) {
      for (const peer of server.clients) peer.terminate();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    this.changed();
  }
}
