import { randomUUID } from "node:crypto";

import { LearningSessionContext } from "@synara/contracts";
import { Layer, Schema } from "effect";

import {
  AgentGatewaySessionRegistry,
  type AgentGatewayCapability,
  type AgentGatewaySessionIdentity,
  type AgentGatewaySessionRegistryShape,
  type AgentGatewayWriteAuthority,
} from "../Services/AgentGatewaySessionRegistry.ts";

const PROVIDER_SESSION_CAPABILITIES = [
  "thread:read",
  "thread:write",
  "automation:write",
  "diagnostics:read",
  "browser:control",
  "device:control",
] as const;
const LEARNING_PROVIDERS = new Set(["omp", "pi"]);
const NATIVE_SESSION_CAPABILITIES = ["thread:read", "browser:control", "device:control"] as const;

function trustedLearningSession(
  provider: string,
  value: unknown,
): AgentGatewaySessionIdentity["learningSession"] {
  if (!LEARNING_PROVIDERS.has(provider) || !Schema.is(LearningSessionContext)(value))
    return undefined;
  return Object.freeze({ ...value, scope: Object.freeze({ ...value.scope }) });
}

export function makeAgentGatewaySessionRegistry(options?: {
  readonly now?: () => number;
  readonly randomId?: () => string;
}): AgentGatewaySessionRegistryShape {
  const now = options?.now ?? Date.now;
  const randomId = options?.randomId ?? randomUUID;
  interface RegisteredSession {
    identity: AgentGatewaySessionIdentity;
    retiredWriteTurnId: string | undefined;
  }
  const sessions = new Map<string, RegisteredSession>();
  const sessionsByKey = new Map<string, RegisteredSession>();

  const disabledComputerThreads = new Set<string>();
  const visibleIdentity = (identity: AgentGatewaySessionIdentity): AgentGatewaySessionIdentity =>
    disabledComputerThreads.has(identity.threadId)
      ? {
          ...identity,
          capabilities: new Set(
            [...identity.capabilities].filter((capability) => capability !== "computer:control"),
          ),
        }
      : identity;
  return {
    setComputerControlEnabled: (threadId, enabled) => {
      if (enabled) disabledComputerThreads.delete(threadId);
      else {
        disabledComputerThreads.add(threadId);
        for (const row of sessionsByKey.values()) {
          if (row.identity.threadId !== threadId) continue;
          row.identity = {
            ...row.identity,
            capabilities: new Set(
              [...row.identity.capabilities].filter(
                (capability) => capability !== "computer:control",
              ),
            ),
          };
        }
      }
    },
    computerControlProvisioned: (threadId, provider) => {
      const candidates = [...sessionsByKey.values()].filter(
        (row) =>
          row.identity.threadId === threadId &&
          row.identity.provider === provider &&
          !row.identity.nativeExecution &&
          row.identity.expiresAt > now(),
      );
      return candidates.at(-1)?.identity.capabilities.has("computer:control") ?? false;
    },
    issue: (threadId, provider, issueOptions) => {
      // Every provider runtime owns an independent credential. Replacement
      // runtimes overlap their predecessor during startup, and the outgoing
      // runtime revokes its own token during teardown. Reusing a token here
      // would therefore let old-session cleanup invalidate the replacement.
      const issuedAt = now();
      const expiresAt = issueOptions?.expiresAt ?? Number.POSITIVE_INFINITY;
      if (
        (issueOptions?.expiresAt !== undefined && !Number.isFinite(expiresAt)) ||
        expiresAt <= issuedAt
      ) {
        throw new Error("Gateway session expiry must be a future absolute timestamp.");
      }
      const nativeExecution = issueOptions?.nativeExecution
        ? Object.freeze({
            executionBindingId: issueOptions.nativeExecution.executionBindingId,
            attemptId: issueOptions.nativeExecution.attemptId,
            capabilityBindingId: issueOptions.nativeExecution.capabilityBindingId,
            assemblyId: issueOptions.nativeExecution.assemblyId,
            parentRootRunId: issueOptions.nativeExecution.parentRootRunId,
          })
        : undefined;
      if (
        nativeExecution &&
        (!Number.isFinite(expiresAt) ||
          Object.values(nativeExecution).some(
            (value) => typeof value !== "string" || value.length === 0,
          ))
      ) {
        throw new Error("Native Gateway sessions require an execution scope and finite expiry.");
      }
      const sessionKey = `gateway-session:${randomId()}`;
      const token = `sagw_session_${randomId()}`;
      const learningSession = trustedLearningSession(provider, issueOptions?.learningSession);
      const additionalCapabilities = (issueOptions?.additionalCapabilities ?? []).filter(
        (capability) =>
          capability !== "learning:read" &&
          capability !== "learning:write" &&
          (capability !== "computer:control" || !disabledComputerThreads.has(threadId)) &&
          (!nativeExecution || capability === "computer:control"),
      );
      const identity: AgentGatewaySessionIdentity = {
        sessionKey,
        threadId,
        provider,
        issuedAt,
        expiresAt,
        ...(nativeExecution ? { nativeExecution } : {}),
        capabilities: new Set<AgentGatewayCapability>([
          ...(nativeExecution ? NATIVE_SESSION_CAPABILITIES : PROVIDER_SESSION_CAPABILITIES),
          ...additionalCapabilities,
          ...(learningSession && !nativeExecution
            ? [
                "learning:read" as const,
                ...(learningSession.learningEpoch === undefined ? [] : ["learning:write" as const]),
              ]
            : []),
        ]),
        ...(learningSession ? { learningSession } : {}),
      };
      const registered: RegisteredSession = {
        identity,
        retiredWriteTurnId: undefined,
      };
      sessions.set(token, registered);
      sessionsByKey.set(sessionKey, registered);
      return { token, ...identity };
    },
    verify: (token) => {
      const identity = sessions.get(token)?.identity;
      return identity && identity.expiresAt > now() ? visibleIdentity(identity) : null;
    },
    bindWriteAuthority: (token, turnId) => {
      const registered = sessions.get(token);
      if (
        !registered ||
        registered.identity.expiresAt <= now() ||
        registered.retiredWriteTurnId !== undefined
      )
        return null;
      const { identity } = registered;
      if (identity.nativeExecution && identity.nativeExecution.attemptId !== turnId) return null;
      return {
        sessionKey: identity.sessionKey,
        threadId: identity.threadId,
        provider: identity.provider,
        turnId,
      } satisfies AgentGatewayWriteAuthority;
    },
    verifyWriteAuthority: (authority) => {
      const registered = sessionsByKey.get(authority.sessionKey);
      const identity = registered?.identity;
      return (
        identity !== undefined &&
        identity.expiresAt > now() &&
        registered?.retiredWriteTurnId === undefined &&
        identity.threadId === authority.threadId &&
        identity.provider === authority.provider &&
        (!identity.nativeExecution || identity.nativeExecution.attemptId === authority.turnId)
      );
    },
    retireWriteAuthority: (token, turnId) => {
      const registered = sessions.get(token);
      if (!registered) return false;
      if (
        registered.identity.nativeExecution &&
        registered.identity.nativeExecution.attemptId !== turnId
      )
        return false;
      if (registered.retiredWriteTurnId !== undefined) {
        return registered.retiredWriteTurnId === turnId;
      }
      // Record A even when it never called a gateway tool. This is the
      // critical case: a detached request from A must not arrive during B and
      // become the first request to bind this credential.
      registered.retiredWriteTurnId = turnId;
      return true;
    },
    revoke: (token) => {
      const registered = sessions.get(token);
      if (!registered) return null;
      sessions.delete(token);
      sessionsByKey.delete(registered.identity.sessionKey);
      return registered.identity;
    },
    listRetiredWriteAuthorities: (threadId) => {
      const retired = [];
      for (const registered of sessionsByKey.values()) {
        if (registered.retiredWriteTurnId === undefined) continue;
        if (registered.identity.expiresAt <= now()) continue;
        if (registered.identity.threadId !== threadId) continue;
        retired.push({
          sessionKey: registered.identity.sessionKey,
          provider: registered.identity.provider,
          retiredTurnId: registered.retiredWriteTurnId,
          issuedAt: registered.identity.issuedAt,
        });
      }
      return retired;
    },
  };
}

export const AgentGatewaySessionRegistryLive = Layer.sync(
  AgentGatewaySessionRegistry,
  makeAgentGatewaySessionRegistry,
);
