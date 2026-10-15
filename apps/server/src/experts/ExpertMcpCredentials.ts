import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ExpertConnectionTransport } from "@synara/contracts";
import { Effect } from "effect";

import { makeServerSecretStoreAt } from "../auth/Layers/ServerSecretStore.ts";
import type { ServerSecretStoreShape } from "../auth/Services/ServerSecretStore.ts";
import { ensurePrivateDirectorySync } from "../privatePathPermissions.ts";
import { assertPrivateDirectory } from "./ExpertMcpStorage.ts";
import { readMcpConfigSourceValues } from "./McpConfigSource.ts";

const MAX_CREDENTIAL_BYTES = 1024 * 1024;
const MAX_CREDENTIAL_VALUE_BYTES = 64 * 1024;
const MAX_CREDENTIAL_NAMES = 128;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

export type ExpertMcpCredentialValues = {
  readonly env: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
};

export interface ExpertMcpCredentialStore {
  create(values: ExpertMcpCredentialValues): Promise<string>;
  read(credentialId: string): Promise<ExpertMcpCredentialValues>;
  remove(credentialId: string): Promise<void>;
}

type SecretStoreReader = Pick<ExpertMcpCredentialStore, "read">;

function invalidCredential(): Error {
  return new Error("Expert MCP credential is unavailable or invalid.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkCredentialValues(value: unknown): ExpertMcpCredentialValues {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "env" && key !== "headers")) {
    throw invalidCredential();
  }
  const env = checkValueMap(value.env, "env");
  const headers = checkValueMap(value.headers, "headers");
  const serialized = JSON.stringify({ env, headers });
  if (Buffer.byteLength(serialized, "utf8") > MAX_CREDENTIAL_BYTES) throw invalidCredential();
  return Object.freeze({ env: Object.freeze(env), headers: Object.freeze(headers) });
}

function checkValueMap(value: unknown, section: "env" | "headers"): Record<string, string> {
  if (!isRecord(value)) throw invalidCredential();
  const entries = Object.entries(value);
  if (entries.length > MAX_CREDENTIAL_NAMES) throw invalidCredential();
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  const seen = new Set<string>();
  for (const [name, rawValue] of entries) {
    const key = section === "headers" ? name.toLowerCase() : name;
    const validName =
      section === "headers" ? HEADER_NAME_PATTERN.test(name) : ENV_NAME_PATTERN.test(name);
    if (!validName || seen.has(key) || typeof rawValue !== "string") throw invalidCredential();
    if (
      Buffer.byteLength(rawValue, "utf8") > MAX_CREDENTIAL_VALUE_BYTES ||
      rawValue.includes("\0") ||
      (section === "headers" && /[\r\n]/u.test(rawValue))
    ) {
      throw invalidCredential();
    }
    seen.add(key);
    result[name] = rawValue;
  }
  return result;
}

function assertCredentialId(credentialId: string): void {
  if (!UUID_PATTERN.test(credentialId)) throw invalidCredential();
}

function credentialName(credentialId: string): string {
  assertCredentialId(credentialId);
  return `mcp-${credentialId}`;
}

function parseCredentialBytes(bytes: Uint8Array): ExpertMcpCredentialValues {
  if (bytes.byteLength > MAX_CREDENTIAL_BYTES) throw invalidCredential();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    throw invalidCredential();
  }
  try {
    return checkCredentialValues(parsed);
  } catch {
    throw invalidCredential();
  }
}

export function createExpertMcpCredentialStore(stateDir: string): ExpertMcpCredentialStore {
  if (!path.isAbsolute(stateDir) || stateDir.includes("\0")) throw invalidCredential();
  const stateRoot = path.resolve(stateDir);
  const secretsDir = path.join(stateRoot, "secrets");
  try {
    ensurePrivateDirectorySync(stateRoot);
    ensurePrivateDirectorySync(secretsDir);
  } catch {
    throw invalidCredential();
  }
  let backingStore: Promise<ServerSecretStoreShape> | undefined;

  const requirePrivateSecretsDirectory = async (): Promise<void> => {
    try {
      await assertPrivateDirectory(stateRoot, "MCP credential storage is unavailable.", false);
      await assertPrivateDirectory(secretsDir, "MCP credential storage is unavailable.", false);
    } catch {
      throw invalidCredential();
    }
  };

  const getBackingStore = (): Promise<ServerSecretStoreShape> => {
    backingStore ??= Effect.runPromise(
      makeServerSecretStoreAt(secretsDir).pipe(Effect.provide(NodeServices.layer)),
    ).catch(() => {
      backingStore = undefined;
      throw invalidCredential();
    });
    return backingStore;
  };

  return {
    async create(rawValues) {
      let values: ExpertMcpCredentialValues;
      let contents: Uint8Array;
      try {
        values = checkCredentialValues(rawValues);
        contents = Buffer.from(JSON.stringify(values), "utf8");
      } catch {
        throw invalidCredential();
      }

      const store = await getBackingStore();
      await requirePrivateSecretsDirectory();
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const credentialId = randomUUID();
        const name = credentialName(credentialId);
        let existing: Uint8Array | null;
        try {
          existing = await Effect.runPromise(store.get(name));
        } catch {
          throw invalidCredential();
        }
        if (existing !== null) continue;
        try {
          await Effect.runPromise(store.set(name, contents));
          return credentialId;
        } catch {
          throw invalidCredential();
        }
      }
      throw invalidCredential();
    },

    async read(credentialId) {
      const name = credentialName(credentialId);
      const store = await getBackingStore();
      await requirePrivateSecretsDirectory();
      try {
        const bytes = await Effect.runPromise(store.get(name));
        if (bytes === null) throw invalidCredential();
        return parseCredentialBytes(bytes);
      } catch {
        throw invalidCredential();
      }
    },

    async remove(credentialId) {
      const name = credentialName(credentialId);
      const store = await getBackingStore();
      await requirePrivateSecretsDirectory();
      const filePath = path.join(secretsDir, `${name}.bin`);
      try {
        const file = await fs.lstat(filePath).catch((cause: unknown) => {
          if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw cause;
        });
        if (file && (!file.isFile() || file.isSymbolicLink())) throw invalidCredential();
        await Effect.runPromise(store.remove(name));
      } catch {
        throw invalidCredential();
      }
    },
  };
}

function assertValue(value: string, section: "env" | "headers"): void {
  if (value.includes("\0") || (section === "headers" && /[\r\n]/u.test(value))) {
    throw invalidCredential();
  }
}

function addValue(
  target: Record<string, string>,
  seen: Set<string>,
  name: string,
  value: string,
  section: "env" | "headers",
): void {
  const normalizedName = section === "headers" ? name.toLowerCase() : name;
  if (seen.has(normalizedName)) throw invalidCredential();
  assertValue(value, section);
  seen.add(normalizedName);
  target[name] = value;
}

/** Resolves host, legacy source, and Synara-owned credential references for a connection. */
export async function resolveExpertMcpCredentialValues(
  transport: ExpertConnectionTransport,
  credentials?: SecretStoreReader,
): Promise<ExpertMcpCredentialValues> {
  const env: Record<string, string> = Object.create(null) as Record<string, string>;
  const headers: Record<string, string> = Object.create(null) as Record<string, string>;
  const envNames = new Set<string>();
  const headerNames = new Set<string>();

  if (transport.type === "stdio") {
    for (const mapping of transport.envFromHost) {
      const value = process.env[mapping.envVar];
      if (value === undefined) throw invalidCredential();
      addValue(env, envNames, mapping.name, value, "env");
    }
    if (transport.envFromSource) {
      let values: Record<string, string>;
      try {
        values = await readMcpConfigSourceValues({
          source: transport.envFromSource.source,
          section: "env",
          names: transport.envFromSource.names,
        });
      } catch {
        throw invalidCredential();
      }
      for (const [name, value] of Object.entries(values)) {
        addValue(env, envNames, name, value, "env");
      }
    }
    if (transport.envFromSecret) {
      if (!credentials) throw invalidCredential();
      let values: ExpertMcpCredentialValues;
      try {
        values = await credentials.read(transport.envFromSecret.credentialId);
      } catch {
        throw invalidCredential();
      }
      for (const name of transport.envFromSecret.names) {
        const value = values.env[name];
        if (value === undefined) throw invalidCredential();
        addValue(env, envNames, name, value, "env");
      }
    }
  } else {
    for (const mapping of transport.headersFromHost) {
      const value = process.env[mapping.envVar];
      if (value === undefined) throw invalidCredential();
      addValue(headers, headerNames, mapping.name, `${mapping.prefix ?? ""}${value}`, "headers");
    }
    if (transport.headersFromSource) {
      let values: Record<string, string>;
      try {
        values = await readMcpConfigSourceValues({
          source: transport.headersFromSource.source,
          section: "headers",
          names: transport.headersFromSource.names,
        });
      } catch {
        throw invalidCredential();
      }
      for (const [name, value] of Object.entries(values)) {
        addValue(headers, headerNames, name, value, "headers");
      }
    }
    if (transport.headersFromSecret) {
      if (!credentials) throw invalidCredential();
      let values: ExpertMcpCredentialValues;
      try {
        values = await credentials.read(transport.headersFromSecret.credentialId);
      } catch {
        throw invalidCredential();
      }
      for (const name of transport.headersFromSecret.names) {
        const value = values.headers[name];
        if (value === undefined) throw invalidCredential();
        addValue(headers, headerNames, name, value, "headers");
      }
    }
  }

  return checkCredentialValues({ env, headers });
}
