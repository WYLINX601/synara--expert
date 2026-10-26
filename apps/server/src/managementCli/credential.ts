import * as fs from "node:fs/promises";
import path from "node:path";
import { readPrivateJsonFile, writePrivateFileAtomically } from "../experts/ExpertMcpStorage";

import type {
  SkillManagementCapability,
  SkillManagementCredentialResult,
  SkillManagementFlavor,
} from "@synara/contracts";

import { supportsPosixPermissions } from "../privatePathPermissions";

const STORE_VERSION = 1;
const STORE_DIRECTORY = path.join("management-cli", "credentials");

export interface StoredSkillManagementCredential {
  readonly version: 1;
  readonly credentialId: string;
  readonly credential: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly instanceId: string;
  readonly flavor: SkillManagementFlavor;
  readonly endpoint: string;
  readonly capabilities: ReadonlyArray<SkillManagementCapability>;
}

export class SkillManagementCredentialFileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SkillManagementCredentialFileError";
  }
}

function safeIdentityPart(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(value)) {
    throw new SkillManagementCredentialFileError("Invalid Skill management credential identity.");
  }
  return value;
}

export function skillManagementCredentialPath(input: {
  readonly baseDir: string;
  readonly instanceId: string;
  readonly flavor: SkillManagementFlavor;
}): string {
  const identity = `${input.flavor}-${safeIdentityPart(input.instanceId)}`;
  return path.join(input.baseDir, STORE_DIRECTORY, `${identity}.json`);
}

async function assertPrivateFile(filePath: string): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new SkillManagementCredentialFileError(
      "Refusing unsafe Skill management credential path.",
    );
  }
  if (supportsPosixPermissions() && (stat.mode & 0o077) !== 0) {
    throw new SkillManagementCredentialFileError(
      "Skill management credential is accessible by other users. Protect it with mode 0600 before retrying.",
    );
  }
}

function assertCredentialShape(value: unknown): asserts value is StoredSkillManagementCredential {
  if (!value || typeof value !== "object") {
    throw new SkillManagementCredentialFileError("Invalid Skill management credential file.");
  }
  const record = value as Partial<StoredSkillManagementCredential>;
  if (
    record.version !== STORE_VERSION ||
    typeof record.credentialId !== "string" ||
    typeof record.credential !== "string" ||
    typeof record.createdAt !== "string" ||
    typeof record.expiresAt !== "string" ||
    typeof record.instanceId !== "string" ||
    typeof record.flavor !== "string" ||
    typeof record.endpoint !== "string" ||
    !Array.isArray(record.capabilities) ||
    record.capabilities.some(
      (capability) => capability !== "skill.manage" && capability !== "expert.skillBindings.manage",
    )
  ) {
    throw new SkillManagementCredentialFileError("Invalid Skill management credential file.");
  }
}

export async function writeSkillManagementCredential(input: {
  readonly baseDir: string;
  readonly endpoint: string;
  readonly result: SkillManagementCredentialResult;
}): Promise<string> {
  const endpoint = new URL(input.endpoint);
  if (endpoint.protocol !== "http:" || !isLoopbackHostname(endpoint.hostname)) {
    throw new SkillManagementCredentialFileError(
      "Skill management credentials can only be stored for a local HTTP Synara instance.",
    );
  }
  const stored: StoredSkillManagementCredential = {
    version: STORE_VERSION,
    credentialId: input.result.credentialId,
    credential: input.result.credential,
    createdAt: input.result.createdAt,
    expiresAt: input.result.expiresAt,
    instanceId: input.result.instanceId,
    flavor: input.result.flavor,
    endpoint: endpoint.origin,
    capabilities: input.result.capabilities,
  };
  const filePath = skillManagementCredentialPath({
    baseDir: input.baseDir,
    instanceId: stored.instanceId,
    flavor: stored.flavor,
  });
  await writePrivateFileAtomically(filePath, JSON.stringify(stored, null, 2));
  return filePath;
}

export async function readSkillManagementCredential(input: {
  readonly baseDir: string;
  readonly instanceId?: string;
  readonly flavor?: SkillManagementFlavor;
  readonly endpoint?: string;
}): Promise<StoredSkillManagementCredential> {
  if ((input.instanceId === undefined) !== (input.flavor === undefined)) {
    throw new SkillManagementCredentialFileError(
      "Select both --instance-id and --flavor, or omit both to use the only matching local credential.",
    );
  }
  const candidates =
    input.instanceId !== undefined && input.flavor !== undefined
      ? [
          skillManagementCredentialPath({
            ...input,
            instanceId: input.instanceId,
            flavor: input.flavor,
          }),
        ]
      : await (async () => {
          const directory = path.join(input.baseDir, STORE_DIRECTORY);
          const entries = await fs
            .readdir(directory, { withFileTypes: true })
            .catch((cause: unknown) => {
              if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
              throw cause;
            });
          return entries
            .filter((entry) => entry.name.endsWith(".json"))
            .map((entry) => path.join(directory, entry.name));
        })();
  const matching: StoredSkillManagementCredential[] = [];
  try {
    for (const filePath of candidates) {
      await assertPrivateFile(filePath);
      const parsed = await readPrivateJsonFile(
        filePath,
        1024 * 1024,
        "Unsafe management credential.",
        false,
      );
      assertCredentialShape(parsed);
      if (input.instanceId !== undefined && parsed.instanceId !== input.instanceId) continue;
      if (input.flavor !== undefined && parsed.flavor !== input.flavor) continue;
      if (input.endpoint !== undefined && parsed.endpoint !== input.endpoint) continue;
      if (Date.parse(parsed.expiresAt) <= Date.now()) continue;
      const endpoint = new URL(parsed.endpoint);
      if (endpoint.protocol !== "http:" || !isLoopbackHostname(endpoint.hostname)) {
        throw new SkillManagementCredentialFileError(
          "The stored Skill management endpoint is not local.",
        );
      }
      matching.push(parsed);
    }
  } catch (cause) {
    if (cause instanceof SkillManagementCredentialFileError) throw cause;
    throw new SkillManagementCredentialFileError(
      "Could not read the local Skill management credential.",
      { cause },
    );
  }
  if (matching.length === 1) return matching[0]!;
  if (matching.length > 1) {
    throw new SkillManagementCredentialFileError(
      "Multiple matching Skill management credentials exist. Select one with --instance-id and --flavor.",
    );
  }
  throw new SkillManagementCredentialFileError(
    "No unexpired Skill management credential matches this local Synara instance. Pair from Synara Settings first.",
  );
}

export async function removeSkillManagementCredential(input: {
  readonly baseDir: string;
  readonly instanceId: string;
  readonly flavor: SkillManagementFlavor;
}): Promise<boolean> {
  const filePath = skillManagementCredentialPath(input);
  try {
    await assertPrivateFile(filePath);
    await fs.unlink(filePath);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1).toLowerCase()
      : hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}
