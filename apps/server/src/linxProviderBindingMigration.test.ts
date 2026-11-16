import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ThreadId,
  type ProviderKind,
  type ServerSettings,
} from "@synara/contracts";
import {
  providerStartOptionsFromInstance,
  resolveProviderInstance,
} from "@synara/shared/providerInstances";
import { migrateLinxProviderBindings } from "./linxProviderBindingMigration";
import {
  credentialsFingerprintForProvider,
  persistedContinuationMatchesLaunch,
  redactProviderOptionsForPersistence,
} from "./provider/continuationCompatibility";
import { providerContinuationIdentity } from "./provider/continuationIdentity";
import type {
  ProviderRuntimeBinding,
  ProviderSessionDirectoryShape,
} from "./provider/Services/ProviderSessionDirectory";
import { buildCodexProcessEnv } from "./codexProcessEnv";
import {
  providerEnvironmentSecretName,
  resolveServerSecretPath,
} from "@synara/shared/serverSecretFiles";
import { redactServerSettingsForClient } from "./serverSettings";

const roots: string[] = [];
const key = new Uint8Array(32).fill(7);
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(
  provider: ProviderKind = "claudeAgent",
  environmentOnly = false,
  spelling: { tilde?: boolean; sensitiveDirectory?: boolean; aliasedHome?: boolean } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "linx-binding-"));
  roots.push(root);
  const userHome = spelling.aliasedHome ? path.join(root, "home-alias") : root;
  if (spelling.aliasedHome)
    await fs.symlink(root, userHome, process.platform === "win32" ? "junction" : "dir");
  // os.homedir() and native provider path expansion see only this synthetic home.
  vi.stubEnv("HOME", userHome);
  vi.stubEnv("USERPROFILE", userHome);
  const sourceHomePath = path.join(userHome, "old");
  const homePath = path.join(userHome, "new");
  const oldStore = path.join(sourceHomePath, "provider");
  const newStore = path.join(homePath, "provider");
  await fs.mkdir(path.join(oldStore, ".claude"), { recursive: true });
  await fs.mkdir(path.join(newStore, ".claude"), { recursive: true });
  const instanceId = ProviderInstanceId.makeUnsafe("work");
  const settingsAt = (store: string): ServerSettings => ({
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      work: {
        driver: provider,
        enabled: true,
        config: {
          binaryPath: "/fixture/provider",
          ...(environmentOnly ? {} : { homePath: store }),
        },
        environment: [
          { name: "API_KEY", value: "synthetic-credential", sensitive: true },
          ...(environmentOnly ? [{ name: "CODEX_HOME", value: store, sensitive: true }] : []),
        ],
      },
    },
  });
  const originalStoreSpelling = spelling.tilde ? "~/old/provider" : oldStore;
  const oldSettings = settingsAt(originalStoreSpelling);
  if (environmentOnly && spelling.sensitiveDirectory === false) {
    const variable = oldSettings.providerInstances.work!.environment!.find(
      (entry) => entry.name === "CODEX_HOME",
    )!;
    Object.assign(variable, { sensitive: false });
  }
  const settings = settingsAt(spelling.aliasedHome ? await fs.realpath(newStore) : newStore);
  if (environmentOnly && spelling.sensitiveDirectory === false) {
    const variable = settings.providerInstances.work!.environment!.find(
      (entry) => entry.name === "CODEX_HOME",
    )!;
    Object.assign(variable, { sensitive: false });
  }
  const sourceSettingsPath = path.join(sourceHomePath, "userdata", "settings.json");
  const sourceSecretsDirectory = path.join(sourceHomePath, "userdata", "secrets");
  await fs.mkdir(sourceSecretsDirectory, { recursive: true });
  const sourceSecretPaths: string[] = [];
  for (const variable of oldSettings.providerInstances.work!.environment ?? []) {
    if (!variable.sensitive || !variable.value) continue;
    const secretPath = resolveServerSecretPath(
      sourceSecretsDirectory,
      providerEnvironmentSecretName({ instanceId: "work", name: variable.name }),
    );
    await fs.writeFile(secretPath, variable.value, { mode: 0o600 });
    sourceSecretPaths.push(secretPath);
  }
  await fs.writeFile(
    sourceSettingsPath,
    JSON.stringify({
      revision: 12,
      migrationVersion: 3,
      settings: redactServerSettingsForClient(oldSettings),
    }),
  );
  const optionsAt = (value: ServerSettings) =>
    providerStartOptionsFromInstance(resolveProviderInstance(value, { instanceId })!);
  const oldOptions = optionsAt(oldSettings);
  if (provider === "codex") {
    vi.stubEnv("LINX_HOME", sourceHomePath);
    await fs.writeFile(path.join(oldStore, "config.toml"), "");
    await buildCodexProcessEnv({
      env: { ...process.env, ...oldOptions?.codex?.environment },
      ...(oldOptions?.codex?.homePath ? { homePath: oldOptions.codex.homePath } : {}),
      ...(oldOptions?.codex?.accountId ? { accountId: oldOptions.codex.accountId } : {}),
    });
  }
  const original: ProviderRuntimeBinding = {
    threadId: ThreadId.makeUnsafe("thread"),
    provider,
    providerInstanceId: instanceId,
    adapterKey: "native",
    status: "stopped",
    lifecycleGeneration: "generation",
    runtimeMode: "full-access",
    resumeCursor: { sessionId: "resume-me", offset: 13 },
    runtimePayload: {
      providerOptions: redactProviderOptionsForPersistence(oldOptions),
      providerOptionsCredentialsFingerprint: credentialsFingerprintForProvider(
        provider,
        oldOptions,
        key,
      ),
      continuationIdentity: providerContinuationIdentity(provider, oldOptions),
      modelSelection: { provider, instanceId, model: "unchanged-model" },
      expertSession: { snapshot: "immutable-old-home-evidence", home: sourceHomePath },
      cwd: path.join(sourceHomePath, "worktrees", "thread"),
      additionalDirectories: [path.join(sourceHomePath, "extra"), "/external"],
    },
  };
  if (provider === "codex") {
    await fs.cp(oldStore, newStore, { recursive: true });
    const markerPath = path.join(newStore, "synara-shared-continuation-v2.json");
    const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
    await fs.writeFile(
      markerPath,
      JSON.stringify({ ...marker, sourceHomeIdentity: await fs.realpath(newStore) }),
    );
    vi.stubEnv("LINX_HOME", homePath);
    // Recovery omits generated aliases. The migration must use the normal
    // continuation preparation path before accepting the copied generation.
  }
  let binding = original;
  const upsert = vi.fn((next: ProviderRuntimeBinding) =>
    Effect.sync(() => {
      binding = next;
    }),
  );
  const directory = {
    listBindings: () => Effect.succeed([binding]),
    upsert,
  } as unknown as ProviderSessionDirectoryShape;
  const input = { sourceHomePath, homePath, settings, directory, credentialsFingerprintKey: key };
  const compatible = () =>
    persistedContinuationMatchesLaunch({
      binding,
      provider,
      providerInstanceId: instanceId,
      providerOptions: optionsAt(settings),
      credentialsFingerprintKey: key,
      currentIdentity: providerContinuationIdentity(provider, optionsAt(settings)),
    });
  return {
    input,
    original,
    current: () => binding,
    compatible,
    upsert,
    oldStore,
    newStore,
    sourceSettingsPath,
    sourceSecretsDirectory,
    sourceSecretPaths,
    oldSettings,
  };
}

describe("Linx live provider binding relocation", () => {
  it.each(["codex", "claudeAgent"] as const)(
    "relocates native-owned %s cwd and additional directories from aliases with a canonical source receipt",
    async (provider) => {
      const f = await fixture(provider, provider === "codex", { tilde: true, aliasedHome: true });
      const sourceAlias = f.input.sourceHomePath;
      f.input.sourceHomePath = await fs.realpath(sourceAlias);
      const external = path.join(path.dirname(f.input.sourceHomePath), "external");
      await fs.mkdir(external);
      await fs.mkdir(path.join(sourceAlias, "existing"));
      const escape = path.join(sourceAlias, "escape");
      const danglingEscape = path.join(sourceAlias, "dangling-escape");
      await fs.symlink(external, escape, process.platform === "win32" ? "junction" : "dir");
      await fs.symlink(
        path.join(external, "missing"),
        danglingEscape,
        process.platform === "win32" ? "junction" : "dir",
      );
      const payload = f.original.runtimePayload as Record<string, unknown>;
      Object.assign(payload, {
        cwd: path.join(sourceAlias, "existing"),
        additionalDirectories: [
          path.join(sourceAlias, "existing", "missing", "child"),
          path.join(sourceAlias, "extra"),
          path.join(escape, "missing-child"),
          path.join(danglingEscape, "child"),
          external,
        ],
      });
      const originalEvidence = structuredClone(f.original);
      const evidencePaths = [f.sourceSettingsPath, ...f.sourceSecretPaths];
      const sourceBefore = await Promise.all(evidencePaths.map((file) => fs.readFile(file)));
      await Effect.runPromise(migrateLinxProviderBindings(f.input));
      expect(f.compatible()).toBe(true);
      expect(f.current()).toMatchObject({
        resumeCursor: originalEvidence.resumeCursor,
        lifecycleGeneration: originalEvidence.lifecycleGeneration,
        runtimePayload: {
          cwd: path.join(f.input.homePath, "existing"),
          additionalDirectories: [
            path.join(f.input.homePath, "existing", "missing", "child"),
            path.join(f.input.homePath, "extra"),
            path.join(escape, "missing-child"),
            path.join(danglingEscape, "child"),
            external,
          ],
          modelSelection: payload.modelSelection,
          expertSession: payload.expertSession,
        },
      });
      expect(f.original).toEqual(originalEvidence);
      expect(await Promise.all(evidencePaths.map((file) => fs.readFile(file)))).toEqual(
        sourceBefore,
      );
      await Effect.runPromise(migrateLinxProviderBindings(f.input));
      expect(f.upsert).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["codex", "claudeAgent"] as const)(
    "proves copied canonical %s paths when the original home has an alias",
    async (provider) => {
      const f = await fixture(provider, provider === "codex", { tilde: true, aliasedHome: true });
      expect(f.compatible()).toBe(false);
      await Effect.runPromise(migrateLinxProviderBindings(f.input));
      expect(f.compatible()).toBe(true);
      expect(f.current().resumeCursor).toEqual(f.original.resumeCursor);
      const payload = f.current().runtimePayload as Record<string, unknown>;
      expect(payload.cwd).toBe(path.join(f.input.homePath, "worktrees", "thread"));
      await Effect.runPromise(migrateLinxProviderBindings(f.input));
      expect(f.upsert).toHaveBeenCalledTimes(1);
    },
  );
  it("refuses another copied directory rather than accepting any path under the new home", async () => {
    const f = await fixture("claudeAgent", false, { tilde: true, aliasedHome: true });
    const differentStore = path.join(await fs.realpath(f.input.homePath), "different-account");
    await fs.mkdir(differentStore);
    Object.assign(f.input.settings.providerInstances.work!.config!, { homePath: differentStore });
    await expect(Effect.runPromise(migrateLinxProviderBindings(f.input))).rejects.toThrow(
      "Cannot prove",
    );
    expect(f.upsert).not.toHaveBeenCalled();
    expect(f.current()).toEqual(f.original);
  });
  it.each([
    { provider: "claudeAgent" as const, environmentOnly: false, sensitiveDirectory: false },
    { provider: "codex" as const, environmentOnly: false, sensitiveDirectory: false },
    { provider: "codex" as const, environmentOnly: true, sensitiveDirectory: false },
    { provider: "codex" as const, environmentOnly: true, sensitiveDirectory: true },
  ])(
    "proves exact tilde source launch spelling for $provider (environment: $environmentOnly; sensitive: $sensitiveDirectory)",
    async (entry) => {
      const f = await fixture(entry.provider, entry.environmentOnly, {
        tilde: true,
        sensitiveDirectory: entry.sensitiveDirectory,
      });
      const evidencePaths = [f.sourceSettingsPath, ...f.sourceSecretPaths];
      const sourceBefore = await Promise.all(evidencePaths.map((file) => fs.readFile(file)));
      const originalPayload = f.original.runtimePayload as Record<string, unknown>;
      expect(f.compatible()).toBe(false);
      await Effect.runPromise(migrateLinxProviderBindings(f.input));
      expect(f.compatible()).toBe(true);
      expect(f.current().resumeCursor).toEqual(f.original.resumeCursor);
      const migrated = f.current().runtimePayload as Record<string, unknown>;
      expect(migrated.modelSelection).toEqual(originalPayload.modelSelection);
      expect(migrated.expertSession).toEqual(originalPayload.expertSession);
      if (entry.environmentOnly) {
        expect(migrated.providerOptionsCredentialsFingerprint).not.toBe(
          originalPayload.providerOptionsCredentialsFingerprint,
        );
      }
      expect(JSON.stringify(migrated)).not.toContain("synthetic-credential");
      expect(await Promise.all(evidencePaths.map((file) => fs.readFile(file)))).toEqual(
        sourceBefore,
      );
    },
  );

  it.each(["config", "secret"])(
    "refuses stale original source %s even when copied settings match the old binding",
    async (kind) => {
      const f = await fixture("codex", true);
      if (kind === "config") {
        const document = JSON.parse(await fs.readFile(f.sourceSettingsPath, "utf8"));
        document.settings.providerInstances.work.config.binaryPath = "/stale/source-provider";
        await fs.writeFile(f.sourceSettingsPath, JSON.stringify(document));
      } else {
        const secretPath = resolveServerSecretPath(
          f.sourceSecretsDirectory,
          providerEnvironmentSecretName({ instanceId: "work", name: "API_KEY" }),
        );
        await fs.writeFile(secretPath, "stale-source-credential");
      }
      const sourceBefore = await fs.readFile(f.sourceSettingsPath);
      await expect(Effect.runPromise(migrateLinxProviderBindings(f.input))).rejects.toThrow(
        "Cannot prove",
      );
      expect(f.upsert).not.toHaveBeenCalled();
      expect(f.current().resumeCursor).toEqual(f.original.resumeCursor);
      expect(await fs.readFile(f.sourceSettingsPath)).toEqual(sourceBefore);
    },
  );

  it.each([
    "{broken",
    JSON.stringify({ settings: null, migrationVersion: 3 }),
    JSON.stringify({ revision: 1, migrationVersion: 999, settings: {} }),
    JSON.stringify({ notASettingsDocument: true }),
  ])(
    "fails closed on malformed or unsupported source settings without quarantining or rewriting them",
    async (contents) => {
      const f = await fixture();
      await fs.writeFile(f.sourceSettingsPath, contents);
      await expect(Effect.runPromise(migrateLinxProviderBindings(f.input))).rejects.toThrow(
        "Cannot prove",
      );
      expect(f.upsert).not.toHaveBeenCalled();
      expect(await fs.readFile(f.sourceSettingsPath, "utf8")).toBe(contents);
      expect(await fs.readdir(path.dirname(f.sourceSettingsPath))).toEqual(
        expect.arrayContaining(["settings.json", "secrets"]),
      );
    },
  );

  it("does not replace a missing original secret with the copied credential", async () => {
    const f = await fixture("codex", true);
    await fs.rm(
      resolveServerSecretPath(
        f.sourceSecretsDirectory,
        providerEnvironmentSecretName({ instanceId: "work", name: "CODEX_HOME" }),
      ),
    );
    await expect(Effect.runPromise(migrateLinxProviderBindings(f.input))).rejects.toThrow(
      "Cannot prove",
    );
    expect(f.upsert).not.toHaveBeenCalled();
    expect(f.current().resumeCursor).toEqual(f.original.resumeCursor);
  });
  it("rejects copied credential drift even when the original source still proves the persisted launch", async () => {
    const f = await fixture("codex", true);
    const variable = f.input.settings.providerInstances.work!.environment!.find(
      (entry) => entry.name === "API_KEY",
    )!;
    Object.assign(variable, { value: "different-copied-credential" });
    await expect(Effect.runPromise(migrateLinxProviderBindings(f.input))).rejects.toThrow(
      "Cannot prove",
    );
    expect(f.upsert).not.toHaveBeenCalled();
  });

  it("uses native defaults for legitimately absent source settings while retaining legacy launch options", async () => {
    const f = await fixture();
    await fs.rm(f.sourceSettingsPath);
    const instanceId = ProviderInstanceId.makeUnsafe("claudeAgent");
    let binding: ProviderRuntimeBinding = {
      ...f.original,
      providerInstanceId: instanceId,
      runtimePayload: {
        ...(f.original.runtimePayload as Record<string, unknown>),
        modelSelection: { provider: "claudeAgent", instanceId, model: "unchanged-model" },
        providerOptions: { claudeAgent: { homePath: f.oldStore } },
        providerOptionsCredentialsFingerprint: undefined,
      },
    };
    const originalCursor = binding.resumeCursor;
    const directory = {
      listBindings: () => Effect.succeed([binding]),
      upsert: (next: ProviderRuntimeBinding) =>
        Effect.sync(() => {
          binding = next;
        }),
    } as unknown as ProviderSessionDirectoryShape;
    await Effect.runPromise(
      migrateLinxProviderBindings({
        ...f.input,
        settings: DEFAULT_SERVER_SETTINGS,
        directory,
      }),
    );
    const options = { claudeAgent: { homePath: f.newStore } };
    expect(
      persistedContinuationMatchesLaunch({
        binding,
        provider: "claudeAgent",
        providerInstanceId: instanceId,
        providerOptions: options,
        credentialsFingerprintKey: key,
        currentIdentity: providerContinuationIdentity("claudeAgent", options),
      }),
    ).toBe(true);
    expect(binding.resumeCursor).toEqual(originalCursor);
    await expect(fs.stat(f.sourceSettingsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("makes Claude's actual identity-and-options predicate pass without changing cursors, model or fixed expert evidence", async () => {
    const f = await fixture();
    expect(f.compatible()).toBe(false);
    await Effect.runPromise(migrateLinxProviderBindings(f.input));
    expect(f.compatible()).toBe(true);
    expect(f.current().resumeCursor).toEqual(f.original.resumeCursor);
    expect(f.current()).toMatchObject({
      provider: f.original.provider,
      providerInstanceId: f.original.providerInstanceId,
      lifecycleGeneration: "generation",
      status: "stopped",
    });
    const oldPayload = f.original.runtimePayload as Record<string, unknown>;
    const payload = f.current().runtimePayload as Record<string, unknown>;
    expect(payload.modelSelection).toEqual(oldPayload.modelSelection);
    expect(payload.expertSession).toEqual(oldPayload.expertSession);
    expect(payload.cwd).toBe(path.join(f.input.homePath, "worktrees", "thread"));
    expect(payload.additionalDirectories).toEqual([
      path.join(f.input.homePath, "extra"),
      "/external",
    ]);
    expect(JSON.stringify(payload)).not.toContain("synthetic-credential");
    await Effect.runPromise(migrateLinxProviderBindings(f.input));
    expect(f.upsert).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "preserves Codex source generation and recomputes a sensitive CODEX_HOME fingerprint (environment only: %s)",
    async (environmentOnly) => {
      const f = await fixture("codex", environmentOnly);
      expect(f.compatible()).toBe(false);
      await Effect.runPromise(migrateLinxProviderBindings(f.input));
      expect(f.compatible()).toBe(true);
      const before = f.original.runtimePayload as Record<string, unknown>;
      const after = f.current().runtimePayload as Record<string, unknown>;
      expect(String(after.continuationIdentity)).toBe(
        String(before.continuationIdentity).replace(f.oldStore, f.newStore),
      );
      expect(f.current().resumeCursor).toEqual(f.original.resumeCursor);
      if (environmentOnly)
        expect(after.providerOptionsCredentialsFingerprint).not.toBe(
          before.providerOptionsCredentialsFingerprint,
        );
      expect(JSON.stringify(after)).not.toContain("synthetic-credential");
    },
  );

  it.each(["credential", "identity", "options"])(
    "refuses preexisting incompatible %s instead of blessing current settings",
    async (kind) => {
      const f = await fixture();
      const payload = f.original.runtimePayload as Record<string, unknown>;
      if (kind === "credential")
        payload.providerOptionsCredentialsFingerprint = "not-the-copied-credential";
      if (kind === "identity") payload.continuationIdentity = "claudeAgent:/unrelated/native-store";
      if (kind === "options")
        payload.providerOptions = {
          claudeAgent: { homePath: f.oldStore, binaryPath: "/different/claude", environment: {} },
        };
      await expect(Effect.runPromise(migrateLinxProviderBindings(f.input))).rejects.toThrow(
        "Cannot prove",
      );
      expect(f.upsert).not.toHaveBeenCalled();
      expect(f.current().resumeCursor).toEqual(f.original.resumeCursor);
    },
  );

  it("refuses a replaced copied Codex generation", async () => {
    const f = await fixture("codex");
    const markerPath = path.join(f.newStore, "synara-shared-continuation-v2.json");
    const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
    await fs.writeFile(
      markerPath,
      JSON.stringify({ ...marker, generation: "123e4567-e89b-42d3-a456-426614174000" }),
    );
    await expect(Effect.runPromise(migrateLinxProviderBindings(f.input))).rejects.toThrow(
      "Cannot prove",
    );
    expect(f.upsert).not.toHaveBeenCalled();
  });
  it("refuses missing copied native state without clearing the cursor", async () => {
    const f = await fixture("codex");
    await fs.rm(path.join(f.newStore, "session_index.jsonl"));
    await expect(Effect.runPromise(migrateLinxProviderBindings(f.input))).rejects.toThrow(
      "Cannot prove",
    );
    expect(f.upsert).not.toHaveBeenCalled();
    expect(f.current().resumeCursor).toEqual(f.original.resumeCursor);
  });
  it("retries partially written bindings without rewriting successful rows or mutating the source store", async () => {
    const f = await fixture();
    const historyPath = path.join(f.oldStore, ".claude", "history.jsonl");
    await fs.writeFile(historyPath, "preserved native history\n");
    const rows = [
      f.original,
      {
        ...f.original,
        threadId: ThreadId.makeUnsafe("second"),
        resumeCursor: { sessionId: "second-cursor" },
      },
    ];
    let interrupt = true;
    const writes: string[] = [];
    const directory = {
      listBindings: () => Effect.succeed(rows),
      upsert: (next: ProviderRuntimeBinding) => {
        if (next.threadId === "second" && interrupt) {
          interrupt = false;
          return Effect.fail(new Error("interrupted repository write"));
        }
        return Effect.sync(() => {
          writes.push(next.threadId);
          rows[rows.findIndex((row) => row.threadId === next.threadId)] = next;
        });
      },
    } as unknown as ProviderSessionDirectoryShape;
    await expect(
      Effect.runPromise(migrateLinxProviderBindings({ ...f.input, directory })),
    ).rejects.toThrow("interrupted repository write");
    await Effect.runPromise(migrateLinxProviderBindings({ ...f.input, directory }));
    expect(writes).toEqual(["thread", "second"]);
    expect(rows[1]!.resumeCursor).toEqual({ sessionId: "second-cursor" });
    expect(await fs.readFile(historyPath, "utf8")).toBe("preserved native history\n");
  });

  it("leaves unrelated external provider bindings unchanged", async () => {
    const f = await fixture();
    const payload = f.original.runtimePayload as Record<string, unknown>;
    payload.cwd = "/external/project";
    payload.additionalDirectories = ["/external"];
    const externalHome = path.join(path.dirname(f.input.homePath), "external-provider");
    const settings: ServerSettings = {
      ...f.input.settings,
      providerInstances: { work: { driver: "claudeAgent", config: { homePath: externalHome } } },
    };
    await fs.writeFile(f.sourceSettingsPath, JSON.stringify(settings));
    const options = providerStartOptionsFromInstance(
      resolveProviderInstance(settings, { instanceId: f.original.providerInstanceId })!,
    );
    payload.providerOptions = redactProviderOptionsForPersistence(options);
    payload.providerOptionsCredentialsFingerprint = credentialsFingerprintForProvider(
      "claudeAgent",
      options,
      key,
    );
    payload.continuationIdentity = providerContinuationIdentity("claudeAgent", options);
    await Effect.runPromise(migrateLinxProviderBindings({ ...f.input, settings }));
    expect(f.upsert).not.toHaveBeenCalled();
    expect(f.current()).toBe(f.original);
  });
});
