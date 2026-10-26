import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { readPrivateJsonFile, writePrivateFileAtomically } from "../experts/ExpertMcpStorage";

import type {
  SkillManagementCapability,
  SkillManagementCredentialSummary,
  SkillManagementFlavor,
} from "@synara/contracts";
import {
  SYNARA_BETA_BUNDLE_ID,
  SYNARA_CANARY_BUNDLE_ID,
  SYNARA_CUA_BUNDLE_ID,
  SYNARA_DEVELOPMENT_BUNDLE_ID,
  SYNARA_PRODUCTION_BUNDLE_ID,
  SYNARA_WORKBENCH_BUNDLE_ID,
  SYNARA_WORKBENCH_PREVIEW_BUNDLE_ID,
} from "@synara/shared/desktopIdentity";

import { ensurePrivateDirectorySync, supportsPosixPermissions } from "../privatePathPermissions";

const STORE_FILE_NAME = "skill-management-auth.json";
const STORE_VERSION = 1;
export const SKILL_MANAGEMENT_PAIRING_TTL_MS = 5 * 60 * 1_000;
export const SKILL_MANAGEMENT_CREDENTIAL_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const SKILL_MANAGEMENT_CAPABILITIES = [
  "skill.manage",
  "expert.skillBindings.manage",
] as const satisfies ReadonlyArray<SkillManagementCapability>;

interface PairingRecord {
  readonly pairingId: string;
  readonly codeHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

interface CredentialRecord {
  readonly credentialId: string;
  readonly tokenHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly capabilities: ReadonlyArray<SkillManagementCapability>;
}

interface PersistedManagementAuth {
  readonly version: 1;
  readonly instanceId: string;
  readonly flavor: SkillManagementFlavor;
  readonly pairings: ReadonlyArray<PairingRecord>;
  readonly credentials: ReadonlyArray<CredentialRecord>;
}

export interface AuthorizedSkillManagementCredential {
  readonly credentialId: string;
  readonly instanceId: string;
  readonly flavor: SkillManagementFlavor;
  readonly capabilities: ReadonlyArray<SkillManagementCapability>;
}

export class SkillManagementAuthStoreError extends Error {
  readonly code:
    | "invalid_pairing"
    | "management_unauthorized"
    | "management_expired"
    | "management_revoked"
    | "instance_mismatch"
    | "flavor_mismatch";

  constructor(
    code: SkillManagementAuthStoreError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SkillManagementAuthStoreError";
    this.code = code;
  }
}

interface StoreIdentity {
  readonly instanceId: string;
  readonly flavor: SkillManagementFlavor;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function digestMatches(leftHex: string, rightHex: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(leftHex) || !/^[a-f0-9]{64}$/u.test(rightHex)) return false;
  return timingSafeEqual(Buffer.from(leftHex, "hex"), Buffer.from(rightHex, "hex"));
}

function assertStoreIdentity(
  value: unknown,
  identity: StoreIdentity,
): asserts value is PersistedManagementAuth {
  if (!value || typeof value !== "object") throw new Error("Invalid Skill management auth store.");
  const record = value as Partial<PersistedManagementAuth>;
  if (
    record.version !== STORE_VERSION ||
    typeof record.instanceId !== "string" ||
    typeof record.flavor !== "string" ||
    !Array.isArray(record.pairings) ||
    !Array.isArray(record.credentials)
  ) {
    throw new Error("Invalid Skill management auth store.");
  }
  if (record.instanceId !== identity.instanceId) {
    throw new SkillManagementAuthStoreError(
      "instance_mismatch",
      "The management credential store belongs to another Synara instance.",
    );
  }
  if (record.flavor !== identity.flavor) {
    throw new SkillManagementAuthStoreError(
      "flavor_mismatch",
      "The management credential store belongs to another Synara app flavor.",
    );
  }
  for (const pairing of record.pairings) {
    if (
      !pairing ||
      typeof pairing !== "object" ||
      typeof pairing.pairingId !== "string" ||
      typeof pairing.codeHash !== "string" ||
      typeof pairing.createdAt !== "string" ||
      typeof pairing.expiresAt !== "string"
    ) {
      throw new Error("Invalid Skill management auth pairing record.");
    }
  }
  for (const credential of record.credentials) {
    if (
      !credential ||
      typeof credential !== "object" ||
      typeof credential.credentialId !== "string" ||
      typeof credential.tokenHash !== "string" ||
      typeof credential.createdAt !== "string" ||
      typeof credential.expiresAt !== "string" ||
      !(credential.revokedAt === null || typeof credential.revokedAt === "string") ||
      !Array.isArray(credential.capabilities) ||
      credential.capabilities.some(
        (capability: SkillManagementCapability) =>
          !SKILL_MANAGEMENT_CAPABILITIES.includes(capability),
      )
    ) {
      throw new Error("Invalid Skill management auth credential record.");
    }
  }
}

function emptyStore(identity: StoreIdentity): PersistedManagementAuth {
  return {
    version: STORE_VERSION,
    instanceId: identity.instanceId,
    flavor: identity.flavor,
    pairings: [],
    credentials: [],
  };
}

async function assertPrivateStoreFile(filePath: string): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Refusing unsafe Skill management auth store path.");
  }
  if (supportsPosixPermissions() && (stat.mode & 0o077) !== 0) {
    throw new Error("Skill management auth store is accessible by other users.");
  }
}

const lockTails = new Map<string, Promise<void>>();

async function withStoreLock<A>(storePath: string, operation: () => Promise<A> | A): Promise<A> {
  const previous = lockTails.get(storePath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  lockTails.set(storePath, current);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (lockTails.get(storePath) === current) lockTails.delete(storePath);
  }
}

async function readStore(
  filePath: string,
  identity: StoreIdentity,
): Promise<PersistedManagementAuth> {
  try {
    await assertPrivateStoreFile(filePath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return emptyStore(identity);
    throw cause;
  }
  const parsed = await readPrivateJsonFile(
    filePath,
    16 * 1024 * 1024,
    "Unsafe management auth store.",
    false,
  );
  assertStoreIdentity(parsed, identity);
  return parsed;
}

function createCredential(
  store: PersistedManagementAuth,
  now: Date,
): {
  readonly next: PersistedManagementAuth;
  readonly credential: string;
  readonly record: CredentialRecord;
} {
  const credential = randomBytes(32).toString("base64url");
  const record: CredentialRecord = {
    credentialId: randomUUID(),
    tokenHash: sha256(credential),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SKILL_MANAGEMENT_CREDENTIAL_TTL_MS).toISOString(),
    revokedAt: null,
    capabilities: SKILL_MANAGEMENT_CAPABILITIES,
  };
  return {
    next: { ...store, credentials: [...store.credentials, record] },
    credential,
    record,
  };
}

export function createSkillManagementAuthStore(stateDir: string, identity: StoreIdentity) {
  const storePath = path.join(stateDir, STORE_FILE_NAME);

  const mutate = <A>(
    operation: (store: PersistedManagementAuth) => {
      readonly next: PersistedManagementAuth;
      readonly value: A;
    },
  ): Promise<A> =>
    withStoreLock(storePath, async () => {
      ensurePrivateDirectorySync(stateDir);
      const current = await readStore(storePath, identity);
      const result = operation(current);
      await writePrivateFileAtomically(storePath, JSON.stringify(result.next));
      return result.value;
    });

  return {
    readonlyPath: storePath,

    createPairing: async (now = new Date()) =>
      mutate((store) => {
        const code = randomBytes(12).toString("base64url");
        const pairing: PairingRecord = {
          pairingId: randomUUID(),
          codeHash: sha256(code),
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + SKILL_MANAGEMENT_PAIRING_TTL_MS).toISOString(),
        };
        return {
          next: { ...store, pairings: [pairing] },
          value: {
            code,
            expiresAt: pairing.expiresAt,
            instanceId: identity.instanceId,
            flavor: identity.flavor,
          },
        };
      }),

    exchangePairing: async (input: {
      readonly code: string;
      readonly expectedInstanceId: string;
      readonly expectedFlavor: SkillManagementFlavor;
      readonly now?: Date;
    }) => {
      const now = input.now ?? new Date();
      if (input.expectedInstanceId !== identity.instanceId) {
        throw new SkillManagementAuthStoreError(
          "instance_mismatch",
          "The pairing code belongs to another Synara instance.",
        );
      }
      if (input.expectedFlavor !== identity.flavor) {
        throw new SkillManagementAuthStoreError(
          "flavor_mismatch",
          "The pairing code belongs to another Synara app flavor.",
        );
      }
      return mutate((store) => {
        const codeHash = sha256(input.code);
        const index = store.pairings.findIndex((pairing) =>
          digestMatches(pairing.codeHash, codeHash),
        );
        if (index < 0) {
          throw new SkillManagementAuthStoreError(
            "invalid_pairing",
            "The Skill management pairing code is invalid, expired, or already used.",
          );
        }
        const pairing = store.pairings[index]!;
        if (Date.parse(pairing.expiresAt) <= now.getTime()) {
          throw new SkillManagementAuthStoreError(
            "invalid_pairing",
            "The Skill management pairing code is invalid, expired, or already used.",
          );
        }
        const { next, credential, record } = createCredential(store, now);
        return {
          next: {
            ...next,
            pairings: store.pairings.filter((_, currentIndex) => currentIndex !== index),
          },
          value: {
            credentialId: record.credentialId,
            credential,
            createdAt: record.createdAt,
            expiresAt: record.expiresAt,
            instanceId: identity.instanceId,
            flavor: identity.flavor,
            capabilities: record.capabilities,
          },
        };
      });
    },

    authorize: async (
      credential: string,
      now = new Date(),
    ): Promise<AuthorizedSkillManagementCredential> =>
      withStoreLock(storePath, async () => {
        const store = await readStore(storePath, identity);
        const tokenHash = sha256(credential);
        const record = store.credentials.find((candidate) =>
          digestMatches(candidate.tokenHash, tokenHash),
        );
        if (!record) {
          throw new SkillManagementAuthStoreError(
            "management_unauthorized",
            "A valid Skill management credential is required.",
          );
        }
        if (record.revokedAt) {
          throw new SkillManagementAuthStoreError(
            "management_revoked",
            "This Skill management credential was revoked.",
          );
        }
        if (Date.parse(record.expiresAt) <= now.getTime()) {
          throw new SkillManagementAuthStoreError(
            "management_expired",
            "This Skill management credential has expired.",
          );
        }
        return {
          credentialId: record.credentialId,
          instanceId: identity.instanceId,
          flavor: identity.flavor,
          capabilities: record.capabilities,
        };
      }),

    listCredentials: async (
      now = new Date(),
    ): Promise<ReadonlyArray<SkillManagementCredentialSummary>> =>
      withStoreLock(storePath, async () =>
        (await readStore(storePath, identity)).credentials
          .map((credential) => ({
            credentialId: credential.credentialId,
            createdAt: credential.createdAt,
            expiresAt: credential.expiresAt,
            revokedAt: credential.revokedAt,
            capabilities: credential.capabilities,
          }))
          .filter(
            (credential) =>
              Date.parse(credential.expiresAt) > now.getTime() || credential.revokedAt !== null,
          ),
      ),

    revokeCredential: async (credentialId: string, now = new Date()) =>
      mutate((store) => {
        let revoked = false;
        const credentials = store.credentials.map((credential) => {
          if (credential.credentialId !== credentialId || credential.revokedAt !== null)
            return credential;
          revoked = true;
          return { ...credential, revokedAt: now.toISOString() };
        });
        return { next: { ...store, credentials }, value: revoked };
      }),
  };
}

export function skillManagementFlavorFromBundleId(
  bundleId: string | undefined,
): SkillManagementFlavor {
  switch (bundleId) {
    case SYNARA_BETA_BUNDLE_ID:
      return "beta";
    case SYNARA_CANARY_BUNDLE_ID:
      return "canary";
    case SYNARA_CUA_BUNDLE_ID:
      return "cua";
    case SYNARA_WORKBENCH_BUNDLE_ID:
      return "workbench";
    case SYNARA_WORKBENCH_PREVIEW_BUNDLE_ID:
      return "workbench-preview";
    case SYNARA_DEVELOPMENT_BUNDLE_ID:
      return "development";
    case SYNARA_PRODUCTION_BUNDLE_ID:
      return "production";
    case undefined:
      return process.env.NODE_ENV === "production" ? "production" : "development";
    default:
      return "development";
  }
}

export function managementCredentialFromAuthorizationHeader(
  value: string | undefined,
): string | null {
  if (!value) return null;
  const match = /^Bearer ([A-Za-z0-9_-]{40,128})$/u.exec(value);
  return match?.[1] ?? null;
}
