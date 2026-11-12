/**
 * AgentGatewayCredentialsLive - Live layer for agent gateway credentials.
 *
 * Issues opaque in-memory credentials. Tokens live for the provider session,
 * can be revoked independently, and intentionally do not survive a Synara
 * restart.
 *
 * @module agentGateway/Layers/AgentGatewayCredentials
 */
import { randomUUID } from "node:crypto";

import type { ProviderKind } from "@synara/contracts";
import { providerSupportsMcpConnectors } from "@synara/shared/mcpConnectors";
import { Effect, Layer } from "effect";

import { ServerConfig } from "../../config.ts";
import { formatHostForUrl, isWildcardHost } from "../../startupAccess.ts";
import {
  type AgentGatewayConnectorRegistration,
  AgentGatewayCredentials,
  type AgentGatewayCredentialsShape,
} from "../Services/AgentGatewayCredentials.ts";
import { AgentGatewaySessionRegistry } from "../Services/AgentGatewaySessionRegistry.ts";
import { makeAgentGatewayInFlightRequestRegistry } from "../inFlightRequestRegistry.ts";
import { ensureAgentGatewayStdioProxyScript } from "../stdioProxyScript.ts";
import { AgentGatewaySessionRegistryLive } from "./AgentGatewaySessionRegistry.ts";

export const AGENT_GATEWAY_MCP_PATH = "/mcp";
export const AGENT_GATEWAY_CONNECTORS_PATH = `${AGENT_GATEWAY_MCP_PATH}/connectors`;

export function agentGatewayConnectorUrl(mcpEndpointUrl: string, connectorId: string): string {
  return `${mcpEndpointUrl}/connectors/${encodeURIComponent(connectorId)}`;
}

interface AgentGatewayEndpoint {
  readonly url: string;
  readonly setListeningPort: (listeningPort: number) => void;
}

interface AgentGatewayStdioBootstrapRegistry {
  readonly issue: (sessionToken: string) => string | null;
  readonly exchange: (bootstrapToken: string) => string | null;
  readonly revokeSession: (sessionToken: string) => void;
}

const AGENT_GATEWAY_STDIO_BOOTSTRAP_TTL_MS = 30_000;

export function makeAgentGatewayStdioBootstrapRegistry(input: {
  readonly sessionIsActive: (sessionToken: string) => boolean;
  readonly randomId?: () => string;
  readonly now?: () => number;
  readonly ttlMs?: number;
}): AgentGatewayStdioBootstrapRegistry {
  const randomId = input.randomId ?? randomUUID;
  const now = input.now ?? Date.now;
  const ttlMs = Math.max(1, input.ttlMs ?? AGENT_GATEWAY_STDIO_BOOTSTRAP_TTL_MS);
  const tokens = new Map<string, { readonly sessionToken: string; readonly expiresAt: number }>();
  return {
    issue: (sessionToken) => {
      if (!input.sessionIsActive(sessionToken)) return null;
      const bootstrapToken = `sagw_bootstrap_${randomId()}`;
      tokens.set(bootstrapToken, { sessionToken, expiresAt: now() + ttlMs });
      return bootstrapToken;
    },
    exchange: (bootstrapToken) => {
      const bootstrap = tokens.get(bootstrapToken);
      if (bootstrap === undefined) return null;
      tokens.delete(bootstrapToken);
      if (bootstrap.expiresAt <= now()) return null;
      return input.sessionIsActive(bootstrap.sessionToken) ? bootstrap.sessionToken : null;
    },
    revokeSession: (sessionToken) => {
      for (const [bootstrapToken, owner] of tokens) {
        if (owner.sessionToken === sessionToken) tokens.delete(bootstrapToken);
      }
    },
  };
}

/**
 * Connectors published for new sessions, and the ids each bearer was issued
 * with: a session may only reach the connectors it received.
 */
export function makeAgentGatewayConnectorRegistry(input: {
  readonly sessionIsActive: (token: string) => boolean;
}) {
  let registrations: ReadonlyArray<AgentGatewayConnectorRegistration> = [];
  const grants = new Map<string, ReadonlySet<string>>();
  return {
    set: (next: ReadonlyArray<AgentGatewayConnectorRegistration>) => {
      registrations = [...next];
    },
    /** The connectors a new bearer receives; Pi, Devin, and Antigravity get none. */
    grant: (
      token: string,
      provider: ProviderKind,
    ): ReadonlyArray<AgentGatewayConnectorRegistration> => {
      const granted = providerSupportsMcpConnectors(provider) ? registrations : [];
      if (granted.length > 0) {
        grants.set(token, new Set(granted.map((registration) => registration.connectorId)));
      }
      return granted;
    },
    canUse: (token: string, connectorId: string): boolean =>
      input.sessionIsActive(token) && (grants.get(token)?.has(connectorId) ?? false),
    revokeSession: (token: string) => {
      grants.delete(token);
    },
  };
}

// Providers run as local child processes, so they must target a host the HTTP
// server actually listens on. Wildcard binds cover loopback; an explicit host
// (e.g. `::1` or a LAN address) does not, so reuse it verbatim.
export function resolveAgentGatewayEndpointHost(configHost: string | undefined): string {
  if (configHost === undefined || isWildcardHost(configHost)) {
    return "127.0.0.1";
  }
  return formatHostForUrl(configHost);
}

export function makeAgentGatewayEndpoint(
  configHost: string | undefined,
  initialPort: number,
): AgentGatewayEndpoint {
  const endpointHost = resolveAgentGatewayEndpointHost(configHost);
  let port = initialPort;
  return {
    get url() {
      return `http://${endpointHost}:${port}${AGENT_GATEWAY_MCP_PATH}`;
    },
    setListeningPort: (listeningPort: number) => {
      port = listeningPort;
    },
  };
}

export const makeAgentGatewayCredentials = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const sessionRegistry = yield* AgentGatewaySessionRegistry;
  const inFlightRequests = makeAgentGatewayInFlightRequestRegistry();
  const revokedListeners = new Set<(sessionKey: string) => void | Promise<void>>();
  const expiryTimers = new Map<string, NodeJS.Timeout>();
  // Cleanup barriers only, never an authorization source. Retain a drain after
  // expiry removes authentication so host cancellation can still await it.
  const revocations = new Map<string, Promise<void>>();

  const endpoint = makeAgentGatewayEndpoint(config.host, config.port);
  const stdioProxyScriptPath = yield* ensureAgentGatewayStdioProxyScript(config.stateDir);
  const stdioBootstraps = makeAgentGatewayStdioBootstrapRegistry({
    sessionIsActive: (token) => sessionRegistry.verify(token) !== null,
  });

  const connectors = makeAgentGatewayConnectorRegistry({
    sessionIsActive: (token) => sessionRegistry.verify(token) !== null,
  });

  const issueSessionToken: AgentGatewayCredentialsShape["issueSessionToken"] = (
    threadId,
    provider,
    options,
  ) => {
    const session = sessionRegistry.issue(threadId, provider, options);
    if (Number.isFinite(session.expiresAt)) {
      const scheduleExpiry = () => {
        const remaining = session.expiresAt - Date.now();
        if (remaining <= 0) {
          revokeSessionToken(session.token);
          return;
        }
        const timer = setTimeout(scheduleExpiry, Math.min(remaining, 2_147_483_647));
        timer.unref();
        expiryTimers.set(session.token, timer);
      };
      scheduleExpiry();
    }
    return session.token;
  };

  const verifySession: AgentGatewayCredentialsShape["verifySession"] = (token) => {
    const session = sessionRegistry.verify(token);
    if (!session) revokeSessionToken(token);
    return session;
  };
  const verifySessionToken: AgentGatewayCredentialsShape["verifySessionToken"] = (token) =>
    verifySession(token)?.threadId ?? null;

  const revokeAndDrain = (token: string): Promise<void> => {
    const pending = revocations.get(token);
    if (pending) return pending;
    const session = sessionRegistry.revoke(token);
    clearTimeout(expiryTimers.get(token));
    expiryTimers.delete(token);
    connectors.revokeSession(token);
    stdioBootstraps.revokeSession(token);
    if (!session) return Promise.resolve();
    const drained = inFlightRequests
      .revokeSession(session.sessionKey)
      .settled.then(async () => {
        await Promise.allSettled(
          [...revokedListeners].map(async (listener) => listener(session.sessionKey)),
        );
      })
      .finally(() => {
        revocations.delete(token);
      });
    revocations.set(token, drained);
    return drained;
  };
  const revokeSessionToken = (token: string): void => {
    void revokeAndDrain(token);
  };

  const issueStdioBootstrapToken: AgentGatewayCredentialsShape["issueStdioBootstrapToken"] = (
    sessionToken,
  ) => {
    return stdioBootstraps.issue(sessionToken);
  };

  const exchangeStdioBootstrapToken: AgentGatewayCredentialsShape["exchangeStdioBootstrapToken"] = (
    bootstrapToken,
  ) => {
    return stdioBootstraps.exchange(bootstrapToken);
  };

  const cancelSessionTurnRequests: AgentGatewayCredentialsShape["cancelSessionTurnRequests"] = (
    token,
    turnId,
  ) => {
    const session = sessionRegistry.verify(token);
    if (!session) return revokeAndDrain(token);
    return inFlightRequests.cancelTurn(session.sessionKey, turnId).settled;
  };

  const retireSessionTurn: AgentGatewayCredentialsShape["retireSessionTurn"] = (token, turnId) => {
    const session = sessionRegistry.verify(token);
    if (!session) return revokeAndDrain(token);
    // Retire synchronously before exposing the asynchronous drain barrier.
    // Requests racing the terminal event can no longer bind this bearer to B.
    sessionRegistry.retireWriteAuthority(token, turnId);
    return inFlightRequests.cancelTurn(session.sessionKey, turnId).settled;
  };

  return {
    get mcpEndpointUrl() {
      return endpoint.url;
    },
    setListeningPort: endpoint.setListeningPort,
    issueSessionToken,
    verifySessionToken,
    verifySession,
    issueStdioBootstrapToken,
    exchangeStdioBootstrapToken,
    bindWriteAuthority: sessionRegistry.bindWriteAuthority,
    verifyWriteAuthority: sessionRegistry.verifyWriteAuthority,
    registerInFlightRequest: inFlightRequests.register,
    cancelInFlightRequests: inFlightRequests.cancel,
    cancelSessionTurnRequests,
    retireSessionTurn,
    listRetiredWriteAuthorities: sessionRegistry.listRetiredWriteAuthorities,
    revokeSessionToken,
    onSessionRevoked: (listener) => {
      revokedListeners.add(listener);
      return () => revokedListeners.delete(listener);
    },
    connectionForThread: (threadId, provider, options) => {
      const bearerToken = issueSessionToken(threadId, provider, options);
      // Native leases never inherit global connector grants, even if a caller
      // uses the convenience API rather than the host's issue-only path.
      const granted = options?.nativeExecution
        ? []
        : connectors.grant(bearerToken, provider).map((registration) => ({
            name: registration.name,
            url: agentGatewayConnectorUrl(endpoint.url, registration.connectorId),
          }));
      return {
        url: endpoint.url,
        bearerToken,
        ...(granted.length > 0 ? { connectors: granted } : {}),
      };
    },
    stdioProxy: {
      command: process.execPath,
      args: [stdioProxyScriptPath],
    },
    setConnectorServers: connectors.set,
    canUseConnector: connectors.canUse,
  } satisfies AgentGatewayCredentialsShape;
});

export const AgentGatewayCredentialsLive = Layer.effect(
  AgentGatewayCredentials,
  makeAgentGatewayCredentials,
).pipe(Layer.provide(AgentGatewaySessionRegistryLive));

// Single shared composition so every consumer (HTTP gateway, provider
// adapters) reuses the same memoized in-memory session registry.
export const AgentGatewayCredentialsWithSecretsLive = AgentGatewayCredentialsLive.pipe(Layer.orDie);
