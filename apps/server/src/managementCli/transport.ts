import type {
  SkillLibraryRequest,
  SkillManagementCredentialResult,
  SkillManagementFlavor,
  SkillManagementPairingExchangeInput,
} from "@synara/contracts";

import {
  discoverExternalMcpRuntime,
  verifyServerRuntime,
  type ExternalMcpFetch,
} from "../externalMcp/bridge";
import {
  isLoopbackHostname,
  readSkillManagementCredential,
  writeSkillManagementCredential,
} from "./credential";

export const SKILL_MANAGEMENT_PAIRING_ROUTE = "/api/skill-management/pairing";
export const SKILL_MANAGEMENT_EXCHANGE_ROUTE = "/api/skill-management/exchange";
export const SKILL_MANAGEMENT_COMMAND_ROUTE = "/api/skill-management/command";
export const SKILL_MANAGEMENT_SELF_REVOKE_ROUTE = "/api/skill-management/credential/revoke-self";

export class SkillManagementTransportError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(input: {
    readonly message: string;
    readonly status: number;
    readonly code?: string;
  }) {
    super(input.message);
    this.name = "SkillManagementTransportError";
    this.status = input.status;
    this.code = input.code;
  }
}

export interface LocalManagementRuntime {
  readonly endpoint: string;
  readonly fetch: ExternalMcpFetch;
}

export async function discoverLocalManagementRuntime(input: {
  readonly baseDir: string;
  readonly fetch?: ExternalMcpFetch;
}): Promise<LocalManagementRuntime> {
  const fetcher = input.fetch ?? globalThis.fetch;
  const runtime = discoverExternalMcpRuntime(input.baseDir);
  const origin = new URL(runtime.state.origin);
  if (origin.protocol !== "http:" || !isLoopbackHostname(origin.hostname)) {
    throw new SkillManagementTransportError({
      message: "Skill management only connects to a verified local Synara instance.",
      status: 403,
      code: "loopback_required",
    });
  }
  await verifyServerRuntime(runtime, fetcher);
  return {
    endpoint: origin.origin,
    fetch: fetcher,
  };
}

async function decodeJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

async function requestJson<T>(input: {
  readonly runtime: LocalManagementRuntime;
  readonly route: string;
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
  readonly credential?: string;
}): Promise<T> {
  const response = await input.runtime.fetch(new URL(input.route, input.runtime.endpoint), {
    method: input.method ?? "GET",
    headers: {
      ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(input.credential === undefined ? {} : { Authorization: `Bearer ${input.credential}` }),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    redirect: "error",
  });
  const payload = await decodeJson(response);
  if (!response.ok) {
    const error =
      payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    throw new SkillManagementTransportError({
      message:
        typeof error.error === "string"
          ? error.error
          : `Skill management request failed (${response.status}).`,
      status: response.status,
      ...(typeof error.code === "string" ? { code: error.code } : {}),
    });
  }
  return payload as T;
}

export async function exchangeSkillManagementPairing(input: {
  readonly baseDir: string;
  readonly code: string;
  readonly expectedInstanceId: string;
  readonly expectedFlavor: SkillManagementFlavor;
  readonly fetch?: ExternalMcpFetch;
}): Promise<{ readonly credential: SkillManagementCredentialResult; readonly filePath: string }> {
  const runtime = await discoverLocalManagementRuntime({
    baseDir: input.baseDir,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  const exchangeInput: SkillManagementPairingExchangeInput = {
    code: input.code,
    expectedInstanceId: input.expectedInstanceId,
    expectedFlavor: input.expectedFlavor,
  };
  const credential = await requestJson<SkillManagementCredentialResult>({
    runtime,
    route: SKILL_MANAGEMENT_EXCHANGE_ROUTE,
    method: "POST",
    body: exchangeInput,
  });
  if (
    credential.instanceId !== input.expectedInstanceId ||
    credential.flavor !== input.expectedFlavor
  ) {
    throw new SkillManagementTransportError({
      message: "The exchanged credential belongs to a different Synara instance or flavor.",
      status: 409,
      code: "instance_mismatch",
    });
  }
  const filePath = await writeSkillManagementCredential({
    baseDir: input.baseDir,
    endpoint: runtime.endpoint,
    result: credential,
  });
  return { credential, filePath };
}

export async function executeSkillManagementRequest(input: {
  readonly baseDir: string;
  readonly instanceId?: string;
  readonly flavor?: SkillManagementFlavor;
  readonly request: SkillLibraryRequest;
  readonly fetch?: ExternalMcpFetch;
}): Promise<unknown> {
  const runtime = await discoverLocalManagementRuntime({
    baseDir: input.baseDir,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  const credential = await readSkillManagementCredential({
    baseDir: input.baseDir,
    ...(input.instanceId === undefined ? {} : { instanceId: input.instanceId }),
    ...(input.flavor === undefined ? {} : { flavor: input.flavor }),
    endpoint: runtime.endpoint,
  });
  if (credential.endpoint !== runtime.endpoint) {
    throw new SkillManagementTransportError({
      message:
        "The stored Skill management credential points to a different local Synara instance. Pair again from Synara Settings.",
      status: 409,
      code: "instance_mismatch",
    });
  }
  return requestJson<unknown>({
    runtime,
    route: SKILL_MANAGEMENT_COMMAND_ROUTE,
    method: "POST",
    credential: credential.credential,
    body: { request: input.request },
  });
}

export async function revokeCurrentSkillManagementCredential(input: {
  readonly baseDir: string;
  readonly instanceId?: string;
  readonly flavor?: SkillManagementFlavor;
  readonly fetch?: ExternalMcpFetch;
}): Promise<{ readonly revoked: boolean }> {
  const runtime = await discoverLocalManagementRuntime({
    baseDir: input.baseDir,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  const credential = await readSkillManagementCredential({
    baseDir: input.baseDir,
    ...(input.instanceId === undefined ? {} : { instanceId: input.instanceId }),
    ...(input.flavor === undefined ? {} : { flavor: input.flavor }),
    endpoint: runtime.endpoint,
  });
  const result = await requestJson<{ readonly revoked: boolean }>({
    runtime,
    route: SKILL_MANAGEMENT_SELF_REVOKE_ROUTE,
    method: "POST",
    credential: credential.credential,
    body: {},
  });
  return result;
}
