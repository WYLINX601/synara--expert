import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderStartOptions,
  ServerSettings,
  type ProviderInstanceConfig,
} from "@synara/contracts";
import { Effect, Schema } from "effect";
import {
  isProviderKind,
  mergeProviderStartOptions,
  providerStartOptionsFromInstance,
  resolveProviderInstance,
} from "@synara/shared/providerInstances";
import { isProviderDirectoryEnvironmentVariable } from "@synara/shared/providerDirectoryPaths";
import { expandProviderAccountHomePath } from "@synara/shared/providerAccountHomePath";
import {
  providerEnvironmentSecretName,
  readServerSecretFile,
  resolveServerSecretPath,
} from "@synara/shared/serverSecretFiles";
import { resolveBaseCodexHomePath } from "@synara/shared/codexHomeOverlayPaths";
import {
  parseCodexSharedContinuationMarker,
  SYNARA_SHARED_CONTINUATION_MARKER_FILE,
  LEGACY_SYNARA_SHARED_CONTINUATION_MARKER_FILE,
} from "@synara/shared/codexContinuationMarker";
import { resolveCodexPathIdentity } from "./codexPathIdentity";
import { resolveCodexProcessSourceEnvironment } from "./codexProcessEnv";
import {
  parseCodexSharedContinuationIdentity,
  prepareProviderContinuationIdentity,
  providerContinuationIdentity,
} from "./provider/continuationIdentity";
import {
  credentialsFingerprintForProvider,
  persistedContinuationMatchesLaunch,
  persistedLaunchMatchesExactly,
  readPersistedContinuationIdentity,
  readPersistedProviderOptions,
  redactProviderOptionsForPersistence,
  runtimePayloadRecord,
} from "./provider/continuationCompatibility";
import type { ProviderSessionDirectoryShape } from "./provider/Services/ProviderSessionDirectory";
import { createLinxLivePathRelocator, relocateLinxOwnedPath } from "./linxHomeMigration";
import {
  decodeSettingsFromJson,
  providerConfigSecretName,
  SERVER_SETTINGS_MIGRATION_VERSION,
  SENSITIVE_PROVIDER_INSTANCE_CONFIG_KEYS,
} from "./serverSettings";

/** Read the preserved source without starting settings services or writing migrations/secrets. */
async function readSourceSettings(sourceHomePath: string): Promise<ServerSettings> {
  const settingsPath = path.join(sourceHomePath, "userdata", "settings.json");
  // The shared reader rejects symlinks, oversized files and concurrent replacement.
  const bytes = await readServerSecretFile(settingsPath);
  if (bytes === null) return DEFAULT_SERVER_SETTINGS;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const raw = decoder.decode(bytes);
  const document: unknown = JSON.parse(raw);
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("Original settings document is not an object");
  }
  const envelope = "settings" in document ? document : undefined;
  if (envelope) {
    if (
      Object.keys(envelope).some(
        (key) => key !== "settings" && key !== "revision" && key !== "migrationVersion",
      ) ||
      ("revision" in envelope &&
        (!Number.isSafeInteger(envelope.revision) || Number(envelope.revision) < 0)) ||
      ("migrationVersion" in envelope &&
        (!Number.isSafeInteger(envelope.migrationVersion) ||
          Number(envelope.migrationVersion) < 0 ||
          Number(envelope.migrationVersion) > SERVER_SETTINGS_MIGRATION_VERSION))
    ) {
      throw new Error("Original settings envelope is unsupported");
    }
  }
  const settingsDocument = envelope?.settings ?? document;
  if (
    (envelope && envelope.settings === null) ||
    settingsDocument === null ||
    typeof settingsDocument !== "object" ||
    Array.isArray(settingsDocument) ||
    Object.keys(settingsDocument).some((key) => !Object.hasOwn(ServerSettings.fields, key))
  ) {
    throw new Error("Original settings shape is unsupported");
  }
  const decoded = decodeSettingsFromJson(settingsPath, raw);
  if (decoded._tag === "Failure") throw new Error("Original settings cannot be decoded");

  const secretsDirectory = path.join(sourceHomePath, "userdata", "secrets");
  const readOriginalSecret = async (name: string): Promise<string> => {
    const secret = await readServerSecretFile(resolveServerSecretPath(secretsDirectory, name));
    if (secret === null) throw new Error("Original settings reference a missing secret");
    return decoder.decode(secret);
  };
  const providerInstances: Record<string, ProviderInstanceConfig> = {
    ...decoded.value.providerInstances,
  };
  for (const [instanceId, instance] of Object.entries(decoded.value.providerInstances)) {
    let hydrated = instance;
    if (instance.environment) {
      const environment = [];
      for (const variable of instance.environment) {
        if (variable.valueRedacted !== true) {
          environment.push(variable);
          continue;
        }
        if (!variable.sensitive) throw new Error("Original environment redaction is unsupported");
        const { valueRedacted: _valueRedacted, ...original } = variable;
        environment.push({
          ...original,
          value: await readOriginalSecret(
            providerEnvironmentSecretName({ instanceId, name: variable.name }),
          ),
        });
      }
      hydrated = { ...hydrated, environment };
    }
    if (instance.config) {
      const config: Record<string, unknown> = { ...instance.config };
      for (const key of SENSITIVE_PROVIDER_INSTANCE_CONFIG_KEYS) {
        if (config[`${key}Redacted`] !== true) continue;
        config[key] = await readOriginalSecret(providerConfigSecretName({ instanceId, key }));
        delete config[`${key}Redacted`];
      }
      hydrated = { ...hydrated, config };
    }
    providerInstances[instanceId] = hydrated;
  }
  return { ...decoded.value, providerInstances };
}

function relocateDirectoryValue(
  value: string,
  source: string,
  destination: string,
  copiedSpelling?: string,
): string {
  // Original launch equality/HMAC still use untouched inputs. Only a moved
  // directory may adopt the copied spelling of the exact same native location.
  if (!value.trim()) return value;
  const expanded = expandProviderAccountHomePath(value.trim());
  let relocated = relocateLinxOwnedPath(expanded, source, destination);
  if (relocated === expanded) {
    const canonical = resolveCodexPathIdentity(expanded);
    const canonicalRelocated = relocateLinxOwnedPath(
      canonical,
      resolveCodexPathIdentity(source),
      resolveCodexPathIdentity(destination),
    );
    relocated = canonicalRelocated !== canonical ? canonicalRelocated : value;
  }
  if (
    relocated !== value &&
    copiedSpelling?.trim() &&
    copiedSpelling !== relocated &&
    resolveCodexPathIdentity(expandProviderAccountHomePath(copiedSpelling)) ===
      resolveCodexPathIdentity(relocated)
  )
    return copiedSpelling;
  return relocated;
}

function relocateOptions(
  options: ProviderStartOptions | undefined,
  source: string,
  destination: string,
  copiedOptions?: ProviderStartOptions,
): ProviderStartOptions | undefined {
  if (!options) return options;
  const result: Record<string, unknown> = {};
  for (const [provider, value] of Object.entries(options)) {
    if (!value) continue;
    const copied = isProviderKind(provider) ? copiedOptions?.[provider] : undefined;
    const next = { ...value } as Record<string, unknown>;
    for (const field of ["homePath", "shadowHomePath", "agentDir"]) {
      if (typeof next[field] === "string") {
        const copiedValue: unknown = copied ? Reflect.get(copied, field) : undefined;
        next[field] = relocateDirectoryValue(
          next[field],
          source,
          destination,
          typeof copiedValue === "string" ? copiedValue : undefined,
        );
      }
    }
    if (value.environment) {
      next.environment = Object.fromEntries(
        Object.entries(value.environment).map(([name, value]) => [
          name,
          isProviderDirectoryEnvironmentVariable(provider, name)
            ? relocateDirectoryValue(value, source, destination, copied?.environment?.[name])
            : value,
        ]),
      );
    }
    result[provider] = next;
  }
  return Schema.decodeUnknownSync(ProviderStartOptions)(result);
}

async function proveCopiedDirectory(
  oldPath: string,
  newPath: string,
  source: string,
  destination: string,
): Promise<void> {
  if (oldPath === newPath) return;
  const expandedOld = expandProviderAccountHomePath(oldPath.trim());
  const expandedNew = expandProviderAccountHomePath(newPath.trim());
  const [oldDirectory, newDirectory, sourceDirectory, destinationDirectory] = await Promise.all([
    fs.realpath(expandedOld),
    fs.realpath(expandedNew),
    fs.realpath(source),
    fs.realpath(destination),
  ]);
  const oldRelative = path.relative(sourceDirectory, oldDirectory);
  const newRelative = path.relative(destinationDirectory, newDirectory);
  // Contained aliases are legitimate, but must still name the same copied
  // directory. A symlink escaping either owned home cannot authorize a cursor.
  for (const relative of [oldRelative, newRelative]) {
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
      throw new Error("Provider directory escapes the copied home");
    }
  }
  if (oldRelative !== newRelative)
    throw new Error("Provider directory is not the same copied path");
  for (const directory of [oldDirectory, newDirectory]) {
    if (!(await fs.stat(directory)).isDirectory()) {
      throw new Error("Provider directory is not a copied directory");
    }
  }
}

/** Repairs live routing only. Historical events and fixed Expert snapshots remain immutable. */
export function migrateLinxProviderBindings(input: {
  sourceHomePath: string;
  homePath: string;
  settings: ServerSettings;
  directory: ProviderSessionDirectoryShape;
  credentialsFingerprintKey: Uint8Array;
}) {
  return Effect.gen(function* () {
    const [canonicalSourceHome, canonicalHome] = yield* Effect.tryPromise({
      try: () => Promise.all([fs.realpath(input.sourceHomePath), fs.realpath(input.homePath)]),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    });
    const relocateLivePath = yield* Effect.tryPromise({
      try: () => createLinxLivePathRelocator(input.sourceHomePath, input.homePath),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    });
    const bindings = yield* input.directory.listBindings();
    const sourceSettings = yield* Effect.tryPromise({
      try: () => readSourceSettings(input.sourceHomePath),
      catch: (cause) =>
        new Error("Cannot prove Linx provider relocation from original settings", {
          cause,
        }),
    });
    for (const binding of bindings) {
      const payload = runtimePayloadRecord(binding.runtimePayload);
      const persistedOptions = readPersistedProviderOptions(binding.runtimePayload);
      const persistedIdentity = readPersistedContinuationIdentity(binding.runtimePayload);
      const relocatedOptions = relocateOptions(
        persistedOptions,
        input.sourceHomePath,
        input.homePath,
      );
      const livePayload = yield* Effect.tryPromise({
        try: async () => {
          const relocated = { ...payload };
          if (typeof payload.cwd === "string") {
            relocated.cwd = await relocateLivePath(payload.cwd);
          }
          if (Array.isArray(payload.additionalDirectories)) {
            relocated.additionalDirectories = await Promise.all(
              payload.additionalDirectories.map((value) =>
                typeof value === "string" ? relocateLivePath(value) : value,
              ),
            );
          }
          return relocated;
        },
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      });
      const provider = binding.provider;
      if (!isProviderKind(provider)) {
        if (!isDeepStrictEqual(payload, livePayload)) {
          throw new Error(
            `Cannot prove Linx provider relocation for '${binding.threadId}': unsupported driver`,
          );
        }
        continue;
      }
      const instance = resolveProviderInstance(input.settings, {
        instanceId: binding.providerInstanceId,
        provider,
      });
      const instanceOptions = instance ? providerStartOptionsFromInstance(instance) : undefined;
      const sourceInstance = resolveProviderInstance(sourceSettings, {
        instanceId: binding.providerInstanceId,
        provider,
      });
      const oldInstanceOptions = sourceInstance
        ? providerStartOptionsFromInstance(sourceInstance)
        : undefined;
      const relocatedSourceOptions = relocateOptions(
        oldInstanceOptions,
        input.sourceHomePath,
        input.homePath,
      );
      const parsed = parseCodexSharedContinuationIdentity(persistedIdentity);
      const identityPath =
        parsed?.sourceIdentity ??
        (persistedIdentity?.startsWith("claudeAgent:")
          ? persistedIdentity.slice("claudeAgent:".length)
          : persistedIdentity?.startsWith("codex:overlay-v1:")
            ? persistedIdentity.slice("codex:overlay-v1:".length)
            : undefined);
      const identityMoved =
        identityPath !== undefined &&
        relocateLinxOwnedPath(identityPath, canonicalSourceHome, canonicalHome) !== identityPath;
      const routingAffected =
        identityMoved ||
        !isDeepStrictEqual(persistedOptions, relocatedOptions) ||
        !isDeepStrictEqual(oldInstanceOptions, relocatedSourceOptions);
      // Moving a working directory alone must not mutate an external native
      // store, upgrade its markers, or authorize an already incompatible cursor.
      if (!routingAffected) {
        if (!isDeepStrictEqual(payload, livePayload)) {
          yield* input.directory.upsert({ ...binding, runtimePayload: livePayload });
        }
        continue;
      }
      const fail = () =>
        new Error(
          `Cannot prove Linx provider relocation for '${binding.threadId}'; preserve its native resume cursor and restore the original provider settings`,
        );
      if (
        !instance ||
        !sourceInstance ||
        (payload.providerOptions !== undefined &&
          !Schema.is(ProviderStartOptions)(payload.providerOptions))
      ) {
        throw fail();
      }
      const currentOptions = mergeProviderStartOptions(relocatedOptions, instanceOptions);
      const currentIdentity = providerContinuationIdentity(provider, currentOptions);
      const currentInput = {
        binding,
        provider,
        providerInstanceId: binding.providerInstanceId,
        providerOptions: currentOptions,
        credentialsFingerprintKey: input.credentialsFingerprintKey,
        currentIdentity,
      };
      // A durable row may already be repaired when a later row or receipt write failed.
      if (
        persistedLaunchMatchesExactly(currentInput) &&
        persistedContinuationMatchesLaunch(currentInput) &&
        !identityMoved &&
        isDeepStrictEqual(persistedOptions, relocatedOptions)
      ) {
        if (!isDeepStrictEqual(payload, livePayload)) {
          yield* input.directory.upsert({ ...binding, runtimePayload: livePayload });
        }
        continue;
      }
      const oldOptions = mergeProviderStartOptions(persistedOptions, oldInstanceOptions);
      const oldInput = { ...currentInput, providerOptions: oldOptions };
      if (!persistedLaunchMatchesExactly(oldInput)) throw fail();
      // Source evidence proves the old account; independently prove the copied
      // launch differs only by owned directory relocation, never new credentials.
      const expectedOptions = relocateOptions(
        oldOptions,
        input.sourceHomePath,
        input.homePath,
        currentOptions,
      );
      const relocatedSourceBinding = {
        ...binding,
        runtimePayload: {
          ...payload,
          providerOptions: redactProviderOptionsForPersistence(expectedOptions),
          providerOptionsCredentialsFingerprint: credentialsFingerprintForProvider(
            provider,
            expectedOptions,
            input.credentialsFingerprintKey,
          ),
        },
      };
      if (
        !persistedLaunchMatchesExactly({
          ...currentInput,
          binding: relocatedSourceBinding,
        })
      ) {
        throw fail();
      }
      const nextIdentity = yield* Effect.tryPromise({
        try: async () => {
          // Prove every moved launch directory exists in both preserved source and copied home.
          const oldProvider = oldOptions?.[provider];
          const newProvider = currentOptions?.[provider];
          if (oldProvider && newProvider) {
            const oldRecord = oldProvider as Record<string, unknown>;
            const newRecord = newProvider as Record<string, unknown>;
            for (const field of ["homePath", "shadowHomePath", "agentDir"]) {
              if (typeof oldRecord[field] === "string" && typeof newRecord[field] === "string") {
                await proveCopiedDirectory(
                  oldRecord[field],
                  newRecord[field],
                  input.sourceHomePath,
                  input.homePath,
                );
              }
            }
            for (const [name, value] of Object.entries(oldProvider.environment ?? {})) {
              const next = newProvider.environment?.[name];
              if (next !== undefined && isProviderDirectoryEnvironmentVariable(provider, name)) {
                await proveCopiedDirectory(value, next, input.sourceHomePath, input.homePath);
              }
            }
          }
          let expectedIdentity = persistedIdentity;
          if (parsed) {
            const codex = oldOptions?.codex;
            const sourceEnvironment = resolveCodexProcessSourceEnvironment({
              env: { ...process.env, ...codex?.environment },
              ...(codex?.environment ? { explicitProviderEnvironment: codex.environment } : {}),
              ...(codex?.homePath ? { homePath: codex.homePath } : {}),
            });
            if (
              resolveCodexPathIdentity(
                resolveBaseCodexHomePath(sourceEnvironment, codex?.homePath),
              ) !== parsed.sourceIdentity
            ) {
              throw fail();
            }
            const markerPath = path.join(
              parsed.sourceIdentity,
              parsed.version === 2
                ? SYNARA_SHARED_CONTINUATION_MARKER_FILE
                : LEGACY_SYNARA_SHARED_CONTINUATION_MARKER_FILE,
            );
            const markerStat = await fs.lstat(markerPath);
            if (
              !markerStat.isFile() ||
              markerStat.isSymbolicLink() ||
              markerStat.size > 1024 * 1024
            ) {
              throw fail();
            }
            const marker = parseCodexSharedContinuationMarker(
              await fs.readFile(markerPath, "utf8"),
              parsed.sourceIdentity,
              parsed.version,
            );
            if (
              parsed.version === 2 &&
              (marker.version !== 2 || marker.generation !== parsed.generation)
            ) {
              throw fail();
            }
            const nextPath = relocateLinxOwnedPath(
              parsed.sourceIdentity,
              canonicalSourceHome,
              canonicalHome,
            );
            await proveCopiedDirectory(
              parsed.sourceIdentity,
              nextPath,
              canonicalSourceHome,
              canonicalHome,
            );
            // A v1 upgrade may write native markers only in the copied home.
            if (
              parsed.version === 1 &&
              !identityMoved &&
              parseCodexSharedContinuationIdentity(currentIdentity)?.version !== 2
            ) {
              throw fail();
            }
            expectedIdentity =
              parsed.version === 2
                ? `codex:shared-v2:${parsed.generation}:${nextPath}`
                : `codex:shared-v1:${nextPath}`;
          } else {
            const oldIdentity = providerContinuationIdentity(provider, oldOptions);
            if (
              !persistedContinuationMatchesLaunch({ ...oldInput, currentIdentity: oldIdentity })
            ) {
              throw fail();
            }
            if (identityPath) {
              const nextPath = relocateLinxOwnedPath(
                identityPath,
                canonicalSourceHome,
                canonicalHome,
              );
              await proveCopiedDirectory(
                identityPath,
                nextPath,
                canonicalSourceHome,
                canonicalHome,
              );
              expectedIdentity =
                persistedIdentity!.slice(0, persistedIdentity!.length - identityPath.length) +
                nextPath;
            }
          }
          const next = await prepareProviderContinuationIdentity(
            provider,
            currentOptions,
            expectedIdentity,
          );
          const candidate = {
            ...binding,
            runtimePayload: {
              ...payload,
              providerOptions: redactProviderOptionsForPersistence(currentOptions),
              providerOptionsCredentialsFingerprint: credentialsFingerprintForProvider(
                provider,
                currentOptions,
                input.credentialsFingerprintKey,
              ),
              continuationIdentity: expectedIdentity,
            },
          };
          if (
            !persistedContinuationMatchesLaunch({
              ...currentInput,
              binding: candidate,
              currentIdentity: next,
            })
          ) {
            throw fail();
          }
          return next;
        },
        catch: () => fail(),
      });
      yield* input.directory.upsert({
        ...binding,
        runtimePayload: {
          ...livePayload,
          providerOptions: redactProviderOptionsForPersistence(currentOptions) ?? null,
          providerOptionsCredentialsFingerprint:
            credentialsFingerprintForProvider(
              provider,
              currentOptions,
              input.credentialsFingerprintKey,
            ) ?? null,
          continuationIdentity: nextIdentity ?? null,
        },
      });
    }
  });
}
