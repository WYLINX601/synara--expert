import * as Http from "node:http";
import { setTimeout as delay } from "node:timers/promises";

export interface LinxBackendHealthEvidence {
  startupReady: boolean;
  projection: { state: string; inFlight: boolean };
  linxUpdate?: {
    pid: number;
    homePath: string;
    sourceCommit: string | null;
    clientConnected: boolean;
  };
}
export function isLinxBackendHealthReady(
  value: unknown,
  input: { pid: number; homePath: string; sourceCommit: string },
): boolean {
  if (typeof value !== "object" || value === null) return false;
  const health = value as Partial<LinxBackendHealthEvidence>;
  return (
    health.startupReady === true &&
    health.projection?.state === "healthy" &&
    health.projection.inFlight === false &&
    /^[a-f0-9]{40}$/.test(input.sourceCommit) &&
    health.linxUpdate?.pid === input.pid &&
    health.linxUpdate.homePath === input.homePath &&
    health.linxUpdate.sourceCommit === input.sourceCommit &&
    health.linxUpdate.clientConnected === true
  );
}
export function readLinxBackendHealth(baseUrl: string, token: string): Promise<unknown> {
  const url = new URL("/health", baseUrl);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    !token
  )
    return Promise.reject(new Error("Health proof requires authenticated loopback"));
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const request = Http.get(
    url,
    { agent: false, headers: { authorization: `Bearer ${token}` } },
    (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 64 * 1024) response.destroy(new Error("Health response too large"));
        else chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("end", () => {
        try {
          if (response.statusCode !== 200) throw new Error("Backend health refused");
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (error) {
          reject(error);
        }
      });
    },
  );
  request.setTimeout(5_000, () => request.destroy(new Error("Backend health timed out")));
  request.once("error", reject);
  return promise;
}
export async function waitForLinxBackendHealth(input: {
  baseUrl: string;
  token: string;
  pid: number;
  homePath: string;
  sourceCommit: string;
  isCurrent(): boolean;
  timeoutMs?: number;
  read?: () => Promise<unknown>;
}): Promise<void> {
  const deadline = Date.now() + (input.timeoutMs ?? 120_000);
  while (input.isCurrent()) {
    const value = await (
      input.read ? input.read() : readLinxBackendHealth(input.baseUrl, input.token)
    ).catch(() => null);
    if (input.isCurrent() && isLinxBackendHealthReady(value, input)) return;
    if (Date.now() >= deadline)
      throw new Error(
        "New backend and managed client health were not proven; retain recovery data",
      );
    await delay(100);
  }
  throw new Error("New backend exited or changed before update health proof");
}
