import {
  WsRpcError,
  WS_METHODS,
  type SkillManagementCredentialRevokeInput,
} from "@synara/contracts";
import { SYNARA_DESKTOP_BUNDLE_ID_ENV } from "@synara/shared/desktopIdentity";
import { Effect } from "effect";

import type { ServerConfigShape } from "../../config.ts";
import {
  createSkillManagementAuthStore,
  skillManagementFlavorFromBundleId,
} from "../../managementCli/managementAuth.ts";
import { CurrentWsSessionRole } from "../../wsConnectionSessions.ts";
import { formatHostForUrl, isLoopbackHost, isWildcardHost } from "../../startupAccess.ts";

function localEndpoint(config: Pick<ServerConfigShape, "host" | "port">): string {
  const host = config.host && !isWildcardHost(config.host) ? config.host : "127.0.0.1";
  return `http://${formatHostForUrl(host)}:${config.port}`;
}

/** Narrow, local-owner-only access to the existing Skill CLI pairing store. */
export function makeSkillManagementRpcHandlers<R>(input: {
  readonly config: ServerConfigShape;
  readonly instanceId: Effect.Effect<string>;
  readonly requireSkillOwner: Effect.Effect<void, WsRpcError, R>;
}) {
  const flavor = skillManagementFlavorFromBundleId(process.env[SYNARA_DESKTOP_BUNDLE_ID_ENV]);
  const authStore = (instanceId: string) =>
    createSkillManagementAuthStore(input.config.stateDir, { instanceId, flavor });
  const canUseLocalManagement =
    isLoopbackHost(input.config.host) && input.config.publicUrl === undefined;

  const mapFailure = (cause: unknown, message: string) =>
    new WsRpcError({
      message: cause instanceof Error ? cause.message : message,
      code: "skill-management-auth-error",
      retryable: false,
    });

  return {
    [WS_METHODS.serverReadSkillManagementAccess]: () =>
      Effect.gen(function* () {
        if ((yield* CurrentWsSessionRole) !== "owner" || !canUseLocalManagement)
          return { canManage: false } as const;
        const instanceId = yield* input.instanceId;
        return {
          canManage: true,
          instanceId,
          flavor,
          endpoint: localEndpoint(input.config),
          homeDir: input.config.baseDir,
        } as const;
      }),

    [WS_METHODS.serverCreateSkillManagementPairing]: () =>
      Effect.gen(function* () {
        yield* input.requireSkillOwner;
        const instanceId = yield* input.instanceId;
        const pairing = yield* Effect.tryPromise({
          try: () => authStore(instanceId).createPairing(),
          catch: (cause) => mapFailure(cause, "Could not create Skill CLI pairing."),
        });
        return {
          ...pairing,
          endpoint: localEndpoint(input.config),
          homeDir: input.config.baseDir,
        };
      }),

    [WS_METHODS.serverListSkillManagementCredentials]: () =>
      Effect.gen(function* () {
        yield* input.requireSkillOwner;
        const instanceId = yield* input.instanceId;
        return yield* Effect.tryPromise({
          try: () => authStore(instanceId).listCredentials(),
          catch: (cause) => mapFailure(cause, "Could not list Skill CLI credentials."),
        });
      }),

    [WS_METHODS.serverRevokeSkillManagementCredential]: (
      request: SkillManagementCredentialRevokeInput,
    ) =>
      Effect.gen(function* () {
        yield* input.requireSkillOwner;
        const instanceId = yield* input.instanceId;
        const revoked = yield* Effect.tryPromise({
          try: () => authStore(instanceId).revokeCredential(request.credentialId),
          catch: (cause) => mapFailure(cause, "Could not revoke Skill CLI credential."),
        });
        return { revoked };
      }),
  };
}
