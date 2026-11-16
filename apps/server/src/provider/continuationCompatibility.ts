// Pure persisted-launch compatibility, shared by runtime admission and verified home relocation.
import { createHmac } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  ModelSelection,
  ProviderStartOptions,
  type ProviderKind,
  type ProviderInstanceId,
} from "@synara/contracts";
import { resolveModelSelectionInstanceId } from "@synara/shared/providerInstances";
import { Option, Schema } from "effect";
import type { ProviderRuntimeBinding } from "./Services/ProviderSessionDirectory";
import {
  codexSharedContinuationIdentityIsSafeMigration,
  parseCodexSharedContinuationIdentity,
} from "./continuationIdentity";

export const PROVIDER_OPTIONS_FINGERPRINT_HMAC_SECRET = "provider-options-fingerprint-hmac-key";

export function redactProviderOptionsForPersistence(value: unknown): unknown {
  if (!Schema.is(ProviderStartOptions)(value)) {
    return value;
  }
  return {
    ...value,
    ...(value.codex ? { codex: redactRuntimeEnvironment(value.codex) } : {}),
    ...(value.claudeAgent ? { claudeAgent: redactRuntimeEnvironment(value.claudeAgent) } : {}),
    ...(value.cursor ? { cursor: redactRuntimeEnvironment(value.cursor) } : {}),
    ...(value.devin ? { devin: redactRuntimeEnvironment(value.devin) } : {}),
    ...(value.antigravity ? { antigravity: redactRuntimeEnvironment(value.antigravity) } : {}),
    ...(value.grok ? { grok: redactRuntimeEnvironment(value.grok) } : {}),
    ...(value.droid ? { droid: redactRuntimeEnvironment(value.droid) } : {}),
    ...(value.opencode
      ? { opencode: withoutServerPassword(redactRuntimeEnvironment(value.opencode)) }
      : {}),
    ...(value.pi ? { pi: redactRuntimeEnvironment(value.pi) } : {}),
    ...(value.omp ? { omp: redactRuntimeEnvironment(value.omp) } : {}),
  } satisfies ProviderStartOptions;
}

function redactRuntimeEnvironment<T extends { readonly environment?: unknown }>(
  value: T,
): Omit<T, "environment"> & { readonly environment?: Record<string, never> } {
  if (!Object.hasOwn(value, "environment")) {
    return value as Omit<T, "environment"> & { readonly environment?: Record<string, never> };
  }
  return { ...value, environment: {} };
}

function withoutServerPassword<T extends { readonly serverPassword?: string | undefined }>(
  value: T,
): Omit<T, "serverPassword"> {
  const { serverPassword: _serverPassword, ...rest } = value;
  return rest;
}

export function readPersistedModelSelection(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): ModelSelection | undefined {
  const raw = runtimePayloadRecord(runtimePayload).modelSelection;
  return Option.getOrUndefined(Schema.decodeUnknownOption(ModelSelection)(raw));
}

export function readPersistedProviderOptions(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): ProviderStartOptions | undefined {
  const raw = runtimePayloadRecord(runtimePayload).providerOptions;
  return Option.getOrUndefined(Schema.decodeUnknownOption(ProviderStartOptions)(raw));
}

// Fingerprints the credential inputs that persistence strips (environment,
// server passwords) so resume decisions can notice account/credential changes
// without ever persisting the secrets themselves.
export function credentialsFingerprintForProvider(
  provider: ProviderKind,
  options: ProviderStartOptions | undefined,
  key: Uint8Array,
): string | undefined {
  const providerOptions = options?.[provider];
  if (!providerOptions || typeof providerOptions !== "object") {
    return undefined;
  }
  const environment = "environment" in providerOptions ? providerOptions.environment : undefined;
  const serverPassword =
    "serverPassword" in providerOptions ? providerOptions.serverPassword : undefined;
  const environmentEntries =
    environment && typeof environment === "object" && !Array.isArray(environment)
      ? Object.entries(environment as Record<string, unknown>).toSorted(([left], [right]) =>
          left.localeCompare(right),
        )
      : [];
  const password = typeof serverPassword === "string" && serverPassword ? serverPassword : null;
  if (environmentEntries.length === 0 && password === null) {
    return undefined;
  }
  return createHmac("sha256", key)
    .update(JSON.stringify({ environment: environmentEntries, serverPassword: password }))
    .digest("hex");
}

export function readPersistedCredentialsFingerprint(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw =
    "providerOptionsCredentialsFingerprint" in runtimePayload
      ? runtimePayload.providerOptionsCredentialsFingerprint
      : undefined;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

export function readPersistedContinuationIdentity(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  const raw = runtimePayloadRecord(runtimePayload).continuationIdentity;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

// Claude launch options that only change how the runtime behaves. They never
// decide which native session store or account owns a resume cursor, so
// changing one in Settings (Artifacts, for example) must keep existing threads
// resumable. Home, binary, and environment still have to match.
function continuationOwningProviderOptions(
  provider: ProviderKind,
  options: ProviderStartOptions | undefined,
): unknown {
  if (provider !== "claudeAgent" || options?.claudeAgent === undefined) {
    return options?.[provider];
  }
  const {
    enableArtifacts: _enableArtifacts,
    maxThinkingTokens: _maxThinkingTokens,
    permissionMode: _permissionMode,
    ...owning
  } = options.claudeAgent;
  return Object.keys(owning).length > 0 ? owning : undefined;
}

function providerStartOptionsEqualForProvider(
  provider: ProviderKind,
  credentialsFingerprintKey: Uint8Array,
  persisted: {
    readonly options: ProviderStartOptions | undefined;
    readonly credentialsFingerprint: string | undefined;
  },
  current: ProviderStartOptions | undefined,
): boolean {
  const persistedOptions = redactProviderOptionsForPersistence(persisted.options) as
    | ProviderStartOptions
    | undefined;
  const currentOptions = redactProviderOptionsForPersistence(current) as
    | ProviderStartOptions
    | undefined;
  return (
    isDeepStrictEqual(
      continuationOwningProviderOptions(provider, persistedOptions),
      continuationOwningProviderOptions(provider, currentOptions),
    ) &&
    persisted.credentialsFingerprint ===
      credentialsFingerprintForProvider(provider, current, credentialsFingerprintKey)
  );
}

export function persistedLaunchMatchesExactly(input: {
  readonly binding: ProviderRuntimeBinding;
  readonly provider: ProviderKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerOptions: ProviderStartOptions | undefined;
  readonly credentialsFingerprintKey: Uint8Array;
}): boolean {
  return (
    input.binding.provider === input.provider &&
    providerInstanceIdFromBinding(input.binding) === input.providerInstanceId &&
    providerStartOptionsEqualForProvider(
      input.provider,
      input.credentialsFingerprintKey,
      {
        options: readPersistedProviderOptions(input.binding.runtimePayload),
        credentialsFingerprint: readPersistedCredentialsFingerprint(input.binding.runtimePayload),
      },
      input.providerOptions,
    )
  );
}

export function persistedContinuationMatchesLaunch(input: {
  readonly binding: ProviderRuntimeBinding;
  readonly provider: ProviderKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerOptions: ProviderStartOptions | undefined;
  readonly credentialsFingerprintKey: Uint8Array;
  readonly currentIdentity: string | undefined;
}): boolean {
  if (input.binding.provider !== input.provider) {
    return false;
  }
  const persistedIdentity = readPersistedContinuationIdentity(input.binding.runtimePayload);
  if (persistedIdentity !== undefined) {
    if (persistedIdentity === input.currentIdentity) {
      return input.provider !== "claudeAgent" || persistedLaunchMatchesExactly(input);
    }
    return (
      input.provider === "codex" &&
      codexSharedContinuationIdentityIsSafeMigration({
        persistedIdentity,
        currentIdentity: input.currentIdentity,
      })
    );
  }
  if (
    input.provider === "codex" &&
    parseCodexSharedContinuationIdentity(input.currentIdentity) !== undefined
  ) {
    return false;
  }
  return persistedLaunchMatchesExactly(input);
}

export function readPersistedProviderInstanceId(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw =
    "providerInstanceId" in runtimePayload ? runtimePayload.providerInstanceId : undefined;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

export function providerInstanceIdFromBinding(binding: ProviderRuntimeBinding): ProviderInstanceId {
  const persistedModelSelection = readPersistedModelSelection(binding.runtimePayload);
  return (
    binding.providerInstanceId ??
    readPersistedProviderInstanceId(binding.runtimePayload) ??
    (persistedModelSelection
      ? resolveModelSelectionInstanceId(persistedModelSelection)
      : binding.provider)
  );
}

export function runtimePayloadRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
