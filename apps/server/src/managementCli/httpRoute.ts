import { isIP } from "node:net";

import {
  SkillManagementCommandInput,
  SkillManagementCredentialRevokeInput,
  SkillManagementPairingExchangeInput,
  type SkillLibraryRequest,
  type SkillManagementCapability,
} from "@synara/contracts";
import { SYNARA_DESKTOP_BUNDLE_ID_ENV } from "@synara/shared/desktopIdentity";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { createSkillLibraryStore } from "../experts/SkillLibraryStore";
import { SkillLibraryRequestIdConflict } from "../experts/SkillLibraryOperations";
import { authenticateSkillManagementHttpRequest } from "../workbench/host/skillManagementAuthorization";
import { ServerConfig } from "../config";
import { formatHostForUrl, isLoopbackHost, isWildcardHost } from "../startupAccess";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment";
import { shouldRejectAuthMutationOrigin } from "../trustedOrigins";
import {
  createSkillManagementAuthStore,
  managementCredentialFromAuthorizationHeader,
  SkillManagementAuthStoreError,
  skillManagementFlavorFromBundleId,
} from "./managementAuth";

export const SKILL_MANAGEMENT_MAX_JSON_BODY_BYTES = 32 * 1024 * 1024;
export const SKILL_MANAGEMENT_PAIRING_ROUTE = "/api/skill-management/pairing";
export const SKILL_MANAGEMENT_EXCHANGE_ROUTE = "/api/skill-management/exchange";
export const SKILL_MANAGEMENT_CREDENTIALS_ROUTE = "/api/skill-management/credentials";
export const SKILL_MANAGEMENT_CREDENTIAL_REVOKE_ROUTE = "/api/skill-management/credentials/revoke";
export const SKILL_MANAGEMENT_COMMAND_ROUTE = "/api/skill-management/command";
export const SKILL_MANAGEMENT_SELF_REVOKE_ROUTE = "/api/skill-management/credential/revoke-self";

const decodePairingExchange = Schema.decodeUnknownEffect(SkillManagementPairingExchangeInput);
const decodeCredentialRevoke = Schema.decodeUnknownEffect(SkillManagementCredentialRevokeInput);
const decodeCommandInput = Schema.decodeUnknownEffect(SkillManagementCommandInput);

type RouteError = {
  readonly message: string;
  readonly status: number;
  readonly code?: string;
  readonly cause?: unknown;
};

function responseError(error: RouteError) {
  return HttpServerResponse.jsonUnsafe(
    { error: error.message, ...(error.code ? { code: error.code } : {}) },
    { status: error.status },
  );
}

function loopbackAddress(value: string | null | undefined): boolean {
  if (!value) return false;
  let address = value.trim().toLowerCase();
  if (address.startsWith("[") && address.endsWith("]")) address = address.slice(1, -1);
  if (address.startsWith("::ffff:")) address = address.slice("::ffff:".length);
  const zoneIndex = address.indexOf("%");
  if (zoneIndex >= 0) address = address.slice(0, zoneIndex);
  if (address === "localhost" || address === "::1") return true;
  if (isIP(address) === 4) return address.startsWith("127.");
  return false;
}

function localInstanceEndpoint(config: {
  readonly host: string | undefined;
  readonly port: number;
}): string {
  const host = config.host && !isWildcardHost(config.host) ? config.host : "127.0.0.1";
  return `http://${formatHostForUrl(host)}:${config.port}`;
}

const routePrerequisite = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  const config = yield* ServerConfig;
  if (!url) return yield* Effect.fail({ message: "Bad Request", status: 400 } satisfies RouteError);
  if (
    !isLoopbackHost(config.host) ||
    config.publicUrl !== undefined ||
    !loopbackAddress(request.remoteAddress)
  ) {
    return yield* Effect.fail({
      message: "Skill management CLI access requires a loopback-only Synara instance.",
      status: 403,
      code: "loopback_required",
    } satisfies RouteError);
  }
  return { request, url, config };
});

function mapAuthStoreError(cause: unknown): RouteError {
  if (cause instanceof SkillManagementAuthStoreError) {
    const status =
      cause.code === "instance_mismatch" || cause.code === "flavor_mismatch" ? 409 : 401;
    return { message: cause.message, status, code: cause.code };
  }
  return {
    message: "Skill management authorization failed.",
    status: 401,
    code: "management_unauthorized",
    cause,
  };
}

function mapCommandError(cause: unknown): RouteError {
  if (cause instanceof SkillManagementAuthStoreError) return mapAuthStoreError(cause);
  if (cause instanceof SkillLibraryRequestIdConflict) {
    return { message: cause.message, status: 409, code: "conflict", cause };
  }
  if (cause && typeof cause === "object" && "status" in cause && typeof cause.status === "number") {
    const record = cause as {
      readonly message?: unknown;
      readonly status: number;
      readonly code?: unknown;
    };
    return {
      message: String(record.message ?? "Skill management operation failed."),
      status: record.status,
      ...(typeof record.code === "string" ? { code: record.code } : {}),
      cause,
    };
  }
  const message = cause instanceof Error ? cause.message : "Skill management operation failed.";
  const conflict = /revision|conflict|changed since|needs review/iu.test(message);
  return {
    message,
    status: conflict ? 409 : 400,
    ...(conflict ? { code: "conflict" } : { code: "invalid_request" }),
    cause,
  };
}

function currentStore(input: {
  readonly stateDir: string;
  readonly instanceId: string;
  readonly bundleId: string | undefined;
}) {
  return createSkillManagementAuthStore(input.stateDir, {
    instanceId: input.instanceId,
    flavor: skillManagementFlavorFromBundleId(input.bundleId),
  });
}

function ownerSession(mutation: boolean) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (!url)
      return yield* Effect.fail({ message: "Bad Request", status: 400 } satisfies RouteError);
    const config = yield* ServerConfig;
    const session = yield* authenticateSkillManagementHttpRequest;
    if (session.role !== "owner") {
      return yield* Effect.fail({
        message: "Only an authenticated owner can manage Skill CLI pairing.",
        status: 403,
        code: "owner_required",
      } satisfies RouteError);
    }
    if (
      mutation &&
      shouldRejectAuthMutationOrigin({
        rawOrigin: request.headers.origin,
        requestOrigin: url.origin,
        config,
        credentialSource: session.credentialSource,
      })
    ) {
      return yield* Effect.fail({
        message: "Trusted request origin required.",
        status: 403,
        code: "owner_required",
      } satisfies RouteError);
    }
    return { request, url, config, session };
  });
}

const pairingEffectRoute = HttpRouter.add(
  "POST",
  SKILL_MANAGEMENT_PAIRING_ROUTE,
  Effect.gen(function* () {
    const { config } = yield* routePrerequisite;
    yield* ownerSession(true);
    const environment = yield* ServerEnvironment;
    const descriptor = yield* environment.getDescriptor;
    const auth = currentStore({
      stateDir: config.stateDir,
      instanceId: descriptor.environmentId,
      bundleId: process.env[SYNARA_DESKTOP_BUNDLE_ID_ENV],
    });
    const pairing = yield* Effect.tryPromise({
      try: () => auth.createPairing(),
      catch: (cause) => ({
        message: "Could not create Skill management pairing.",
        status: 500,
        cause,
      }),
    });
    return HttpServerResponse.jsonUnsafe({
      ...pairing,
      endpoint: localInstanceEndpoint(config),
      homeDir: config.baseDir,
    });
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed(
        responseError(
          cause &&
            typeof cause === "object" &&
            "status" in cause &&
            typeof cause.status === "number"
            ? (cause as RouteError)
            : { message: "Could not create Skill management pairing.", status: 500, cause },
        ),
      ),
    ),
  ),
);

const credentialsEffectRoute = HttpRouter.add(
  "GET",
  SKILL_MANAGEMENT_CREDENTIALS_ROUTE,
  Effect.gen(function* () {
    const { config } = yield* routePrerequisite;
    yield* ownerSession(false);
    const environment = yield* ServerEnvironment;
    const descriptor = yield* environment.getDescriptor;
    const credentials = yield* Effect.tryPromise({
      try: () =>
        currentStore({
          stateDir: config.stateDir,
          instanceId: descriptor.environmentId,
          bundleId: process.env[SYNARA_DESKTOP_BUNDLE_ID_ENV],
        }).listCredentials(),
      catch: (cause) => ({
        message: "Could not list Skill management credentials.",
        status: 500,
        cause,
      }),
    });
    return HttpServerResponse.jsonUnsafe(credentials);
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed(
        responseError(
          cause &&
            typeof cause === "object" &&
            "status" in cause &&
            typeof cause.status === "number"
            ? (cause as RouteError)
            : { message: "Could not list Skill management credentials.", status: 500, cause },
        ),
      ),
    ),
  ),
);

const credentialRevokeEffectRoute = HttpRouter.add(
  "POST",
  SKILL_MANAGEMENT_CREDENTIAL_REVOKE_ROUTE,
  Effect.gen(function* () {
    const { config } = yield* routePrerequisite;
    yield* ownerSession(true);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const payload = yield* readManagementJson(request).pipe(
      Effect.flatMap(decodeCredentialRevoke),
      Effect.mapError(
        (cause) =>
          ({
            message: "Invalid Skill management revoke request.",
            status: 400,
            code: "invalid_request",
            cause,
          }) satisfies RouteError,
      ),
    );
    const environment = yield* ServerEnvironment;
    const descriptor = yield* environment.getDescriptor;
    const revoked = yield* Effect.tryPromise({
      try: () =>
        currentStore({
          stateDir: config.stateDir,
          instanceId: descriptor.environmentId,
          bundleId: process.env[SYNARA_DESKTOP_BUNDLE_ID_ENV],
        }).revokeCredential(payload.credentialId),
      catch: (cause) => ({
        message: "Could not revoke Skill management credential.",
        status: 500,
        cause,
      }),
    });
    return HttpServerResponse.jsonUnsafe({ revoked });
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed(
        responseError(
          cause &&
            typeof cause === "object" &&
            "status" in cause &&
            typeof cause.status === "number"
            ? (cause as RouteError)
            : { message: "Could not revoke Skill management credential.", status: 500, cause },
        ),
      ),
    ),
  ),
);

const exchangeEffectRoute = HttpRouter.add(
  "POST",
  SKILL_MANAGEMENT_EXCHANGE_ROUTE,
  Effect.gen(function* () {
    const { request, config } = yield* routePrerequisite;
    if (request.headers.origin) {
      return responseError({
        message: "The management exchange is a local CLI-only endpoint.",
        status: 403,
        code: "loopback_required",
      });
    }
    const payload = yield* readManagementJson(request).pipe(
      Effect.flatMap(decodePairingExchange),
      Effect.mapError(
        (cause) =>
          ({
            message: "Invalid Skill management pairing exchange request.",
            status: 400,
            code: "invalid_request",
            cause,
          }) satisfies RouteError,
      ),
    );
    const environment = yield* ServerEnvironment;
    const descriptor = yield* environment.getDescriptor;
    const auth = currentStore({
      stateDir: config.stateDir,
      instanceId: descriptor.environmentId,
      bundleId: process.env[SYNARA_DESKTOP_BUNDLE_ID_ENV],
    });
    const credential = yield* Effect.tryPromise({
      try: () => auth.exchangePairing(payload),
      catch: (cause) => mapAuthStoreError(cause),
    });
    return HttpServerResponse.jsonUnsafe(credential);
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed(
        responseError(
          cause &&
            typeof cause === "object" &&
            "status" in cause &&
            typeof cause.status === "number"
            ? (cause as RouteError)
            : { message: "Skill management pairing exchange failed.", status: 500, cause },
        ),
      ),
    ),
  ),
);

const commandEffectRoute = HttpRouter.add(
  "POST",
  SKILL_MANAGEMENT_COMMAND_ROUTE,
  Effect.gen(function* () {
    const { request, config } = yield* routePrerequisite;
    if (request.headers.origin) {
      return responseError({
        message: "The Skill management command endpoint is for the local CLI.",
        status: 403,
        code: "loopback_required",
      });
    }
    const token = managementCredentialFromAuthorizationHeader(request.headers.authorization);
    if (!token) {
      return responseError({
        message: "A valid Skill management credential is required.",
        status: 401,
        code: "management_unauthorized",
      });
    }
    const payload = yield* readManagementJson(request).pipe(
      Effect.flatMap(decodeCommandInput),
      Effect.mapError(
        (cause) =>
          ({
            message: "Invalid Skill management command payload.",
            status: 400,
            code: "invalid_request",
            cause,
          }) satisfies RouteError,
      ),
    );
    const environment = yield* ServerEnvironment;
    const descriptor = yield* environment.getDescriptor;
    const auth = currentStore({
      stateDir: config.stateDir,
      instanceId: descriptor.environmentId,
      bundleId: process.env[SYNARA_DESKTOP_BUNDLE_ID_ENV],
    });
    const firstPrincipal = yield* Effect.tryPromise({
      try: () => auth.authorize(token),
      catch: mapAuthStoreError,
    });
    const library = createSkillLibraryStore(config.stateDir);
    const requiredCapabilities = yield* Effect.tryPromise({
      try: () => requiredCapabilitiesForRequest({ request: payload.request, library }),
      catch: mapCommandError,
    });
    if (
      requiredCapabilities.some((capability) => !firstPrincipal.capabilities.includes(capability))
    ) {
      return responseError({
        message:
          "This management credential does not include all capabilities required by the requested Skill operation.",
        status: 403,
        code: "management_unauthorized",
      });
    }
    const beforeMutation = async (effect?: { readonly expertBindings?: boolean }) => {
      const principal = await auth.authorize(token);
      const mutationCapabilities = new Set(requiredCapabilities);
      if (effect?.expertBindings) mutationCapabilities.add("expert.skillBindings.manage");
      if (
        principal.credentialId !== firstPrincipal.credentialId ||
        principal.instanceId !== descriptor.environmentId ||
        principal.flavor !== firstPrincipal.flavor ||
        [...mutationCapabilities].some((capability) => !principal.capabilities.includes(capability))
      ) {
        throw Object.assign(
          new Error("Skill management authorization changed before the operation committed."),
          { status: 403 as const, code: "management_unauthorized" as const },
        );
      }
    };
    const result = yield* Effect.tryPromise({
      try: () =>
        library.execute(payload.request, {
          actor: `management-client:${firstPrincipal.credentialId}`,
          beforeMutation,
        }),
      catch: mapCommandError,
    });
    return HttpServerResponse.jsonUnsafe(result);
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed(
        responseError(
          cause &&
            typeof cause === "object" &&
            "status" in cause &&
            typeof cause.status === "number"
            ? (cause as RouteError)
            : cause instanceof SkillManagementAuthStoreError
              ? mapAuthStoreError(cause)
              : mapCommandError(cause),
        ),
      ),
    ),
  ),
);

const selfRevokeEffectRoute = HttpRouter.add(
  "POST",
  SKILL_MANAGEMENT_SELF_REVOKE_ROUTE,
  Effect.gen(function* () {
    const { request, config } = yield* routePrerequisite;
    if (request.headers.origin) {
      return responseError({
        message: "The Skill management credential endpoint is for the local CLI.",
        status: 403,
        code: "loopback_required",
      });
    }
    const token = managementCredentialFromAuthorizationHeader(request.headers.authorization);
    if (!token) {
      return responseError({
        message: "A valid Skill management credential is required.",
        status: 401,
        code: "management_unauthorized",
      });
    }
    const environment = yield* ServerEnvironment;
    const descriptor = yield* environment.getDescriptor;
    const auth = currentStore({
      stateDir: config.stateDir,
      instanceId: descriptor.environmentId,
      bundleId: process.env[SYNARA_DESKTOP_BUNDLE_ID_ENV],
    });
    const principal = yield* Effect.tryPromise({
      try: () => auth.authorize(token),
      catch: mapAuthStoreError,
    });
    const revoked = yield* Effect.tryPromise({
      try: () => auth.revokeCredential(principal.credentialId),
      catch: (cause) => ({
        message: "Could not revoke Skill management credential.",
        status: 500,
        cause,
      }),
    });
    return HttpServerResponse.jsonUnsafe({ revoked });
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed(
        responseError(
          cause &&
            typeof cause === "object" &&
            "status" in cause &&
            typeof cause.status === "number"
            ? (cause as RouteError)
            : mapAuthStoreError(cause),
        ),
      ),
    ),
  ),
);

async function requiredCapabilitiesForRequest(input: {
  readonly request: SkillLibraryRequest;
  readonly library: ReturnType<typeof createSkillLibraryStore>;
}): Promise<ReadonlyArray<SkillManagementCapability>> {
  if (input.request.action === "bindings" || input.request.action === "bindExperts") {
    return ["expert.skillBindings.manage"];
  }
  const capabilities = new Set<SkillManagementCapability>(["skill.manage"]);
  const deleteSkillIds =
    input.request.action === "delete"
      ? [input.request.skillId]
      : input.request.action === "batch"
        ? input.request.items
            .filter((item) => item.operation === "delete")
            .map((item) => item.skillId)
        : [];
  for (const skillId of deleteSkillIds) {
    try {
      const preview = await input.library.execute({ action: "previewDelete", skillId });
      if (preview.expertIds?.length) capabilities.add("expert.skillBindings.manage");
    } catch (cause) {
      if (cause instanceof Error && cause.message === `Skill not found or deleted: ${skillId}`) {
        // A retry after a completed delete reaches this preflight before the durable receipt.
        continue;
      }
      throw cause;
    }
  }
  return [...capabilities];
}

function readManagementJson(request: HttpServerRequest.HttpServerRequest) {
  const declaredLength = Number(request.headers["content-length"] ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > SKILL_MANAGEMENT_MAX_JSON_BODY_BYTES) {
    return Effect.fail({ message: "Request body too large.", status: 413 } satisfies RouteError);
  }
  return request.json.pipe(
    Effect.provideService(
      HttpServerRequest.MaxBodySize,
      FileSystem.Size(SKILL_MANAGEMENT_MAX_JSON_BODY_BYTES),
    ),
    Effect.mapError(
      (cause) =>
        ({
          message: "Invalid Skill management JSON payload.",
          status: 400,
          cause,
        }) satisfies RouteError,
    ),
  );
}

export const skillManagementCliEffectRouteLayer = Layer.mergeAll(
  pairingEffectRoute,
  credentialsEffectRoute,
  credentialRevokeEffectRoute,
  exchangeEffectRoute,
  commandEffectRoute,
  selfRevokeEffectRoute,
);
