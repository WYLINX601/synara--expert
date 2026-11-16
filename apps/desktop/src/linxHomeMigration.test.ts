import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireDatabaseLifecycleLock,
  releaseDatabaseLifecycleLock,
} from "@synara/shared/databaseLifecycleLock";
import { migrateLegacyLinxHome } from "./linxHomeMigration";
import { ServerSettings } from "@synara/contracts";
import {
  deriveProviderInstances,
  providerStartOptionsFromInstance,
} from "@synara/shared/providerInstances";
import {
  readSynaraStorageSnapshot,
  resolveSynaraStorageSnapshotPath,
} from "./desktopStorageMigration";
import { runLinxPlatformCommand } from "./linxUpdateHelperPlatform";
import {
  resolveCodexHomeOverlayAccountSegment,
  resolveSynaraCodexHomeOverlayPath,
} from "@synara/shared/codexHomeOverlayPaths";

vi.mock("electron", () => ({ BrowserWindow: vi.fn(), session: {} }));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

// Exercise the actual server preparer in its Bun runtime without importing
// server implementation files into the Desktop TypeScript project.
function callCodexRuntime<T>(
  method: "buildCodexProcessEnv" | "readCodexSharedContinuationGeneration",
  input: Record<string, unknown>,
): T {
  const moduleUrl = new URL("../../server/src/codexProcessEnv.ts", import.meta.url).href;
  const result =
    method === "buildCodexProcessEnv" ? "{ CODEX_HOME: result.CODEX_HOME }" : "result ?? null";
  return JSON.parse(
    runLinxPlatformCommand("bun", [
      "--eval",
      `
    const runtime = await import(${JSON.stringify(moduleUrl)});
    const result = await runtime.${method}(${JSON.stringify(input)});
    console.log(JSON.stringify(${result}));
  `,
    ]),
  ) as T;
}
function buildCodexProcessEnv(input: Record<string, unknown>) {
  return callCodexRuntime<Record<string, string | undefined>>("buildCodexProcessEnv", input);
}
function readCodexSharedContinuationGeneration(input: Record<string, unknown>) {
  return (
    callCodexRuntime<string | null>("readCodexSharedContinuationGeneration", input) ?? undefined
  );
}
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "linx-import-test-"));
  temporary.push(root);
  const sourceHomePath = path.join(root, ".synara-workbench");
  const sourceUserDataPath = path.join(root, "workbench");
  await fs.mkdir(path.join(sourceHomePath, "userdata", "secrets"), {
    recursive: true,
    mode: 0o700,
  });
  await fs.mkdir(sourceUserDataPath, { mode: 0o700 });
  await fs.writeFile(
    path.join(sourceHomePath, "userdata", "state.sqlite"),
    "historical ledger unchanged",
  );
  await fs.writeFile(
    path.join(sourceHomePath, "userdata", "secrets", "provider.bin"),
    "app-owned-secret",
    { mode: 0o600 },
  );
  await fs.mkdir(path.join(sourceHomePath, "experts"));
  await fs.writeFile(path.join(sourceHomePath, "experts", "expert.json"), "expert-data");
  await fs.mkdir(path.join(sourceUserDataPath, "IndexedDB"));
  await fs.writeFile(path.join(sourceUserDataPath, "IndexedDB", "blob"), "draft-image-bytes");
  const snapshot = {
    version: 1 as const,
    exportedAt: "2026-11-13T00:00:00.000Z",
    entries: {
      "synara:composer-drafts:v1": JSON.stringify({
        draftsByThreadId: {
          thread: { text: "unsent draft", persistedAttachments: [{ blobKey: "thread:image" }] },
        },
      }),
    },
  };
  const transferStorage = vi.fn(
    async (input: {
      isolatedSourceProfilePath: string;
      userDataPath: string;
      preview: boolean;
    }) => {
      expect(input.isolatedSourceProfilePath).not.toBe(sourceUserDataPath);
      expect(
        await fs.readFile(path.join(input.isolatedSourceProfilePath, "IndexedDB", "blob"), "utf8"),
      ).toBe("draft-image-bytes");
      return snapshot;
    },
  );
  return {
    root,
    snapshot,
    consent: true,
    sourceHomePath,
    sourceUserDataPath,
    homePath: path.join(root, ".linx"),
    userDataPath: path.join(root, "linx"),
    recoveryDirectoryPath: path.join(root, "recovery"),
    sourceVersion: "0.1.15",
    preview: false,
    transferStorage,
  };
}

describe("one-way Linx legacy import", () => {
  it.each([
    "basic",
    "literal",
    "multiline",
    "multiline-literal",
    "nested-instructions",
    "sqlite-alias",
  ])(
    "relocates real native aliases and only the owned root sqlite_home (%s)",
    async (style) => {
      const input = await fixture();
      const source = path.join(await fs.realpath(input.sourceHomePath), "codex-source");
      await fs.mkdir(source);
      const sqliteHome = style === "sqlite-alias" ? path.join(input.root, "sqlite-alias") : source;
      if (style === "sqlite-alias") await fs.symlink(source, sqliteHome);
      const value =
        style === "literal"
          ? `'${sqliteHome}'`
          : style === "multiline"
            ? `"""${sqliteHome}"""`
            : style === "multiline-literal"
              ? `'''${sqliteHome}'''`
              : JSON.stringify(sqliteHome);
      const key =
        style === "literal"
          ? "'sqlite_home'"
          : style === "multiline"
            ? "sqlite_home"
            : style === "multiline-literal"
              ? '"sqlite\\u005fhome"'
              : '"sqlite_home"';
      const rootAssignment = `  ${key} = ${value} # owned database location`;
      const originalConfig = [
        "# Keep formatting and unrelated paths.",
        ...(style === "nested-instructions"
          ? ["developer_instructions = '''", '"example" = """', "'''"]
          : []),
        rootAssignment,
        'model = "unchanged-model"',
        "instructions = '''",
        `sqlite_home = "${source}"`,
        "'''",
        ...(style === "nested-instructions"
          ? ['experimental_instructions = """', "keep", '"""']
          : []),
        "[profiles.work]",
        `sqlite_home = ${JSON.stringify(source)}`,
        "",
      ].join("\n");
      if (style === "multiline-literal") {
        await fs.writeFile(
          path.join(input.sourceHomePath, "userdata", "native-config.toml"),
          originalConfig,
          { mode: 0o600 },
        );
        await fs.symlink("../userdata/native-config.toml", path.join(source, "config.toml"));
      } else {
        await fs.writeFile(path.join(source, "config.toml"), originalConfig, { mode: 0o600 });
      }
      await fs.writeFile(
        path.join(input.sourceHomePath, "userdata", "settings.json"),
        JSON.stringify({
          providerInstances: {
            work: { driver: "codex", environment: [{ name: "CODEX_HOME", value: source }] },
          },
        }),
      );
      const env = { SYNARA_HOME: await fs.realpath(input.sourceHomePath), CODEX_HOME: source };
      const prepared = buildCodexProcessEnv({ env, accountId: "work" });
      const overlay = prepared.CODEX_HOME!;
      expect((await fs.lstat(path.join(overlay, "sessions"))).isSymbolicLink()).toBe(true);
      await fs.writeFile(path.join(overlay, "auth.json"), "private-native-auth", { mode: 0o600 });
      await fs.writeFile(path.join(overlay, "unique.bin"), "unique-native-state");
      await fs.symlink("unique.bin", path.join(overlay, "unique-alias"));
      await fs.symlink(
        path.join(overlay, "auth.json"),
        path.join(input.sourceHomePath, "userdata", "native-auth-alias"),
      );
      await fs.writeFile(path.join(source, "history.jsonl"), "historical-cursor\n");
      const fixed = buildCodexProcessEnv({
        env,
        accountId: "work",
        fixedExpertNativeDiscovery: true,
      });
      const generation = readCodexSharedContinuationGeneration({ env, accountId: "work" });
      const originalSessionsLink = await fs.readlink(path.join(overlay, "sessions"));
      await migrateLegacyLinxHome(input);
      const destination = path.join(await fs.realpath(input.homePath), "codex-source");
      const newEnv = { SYNARA_HOME: await fs.realpath(input.homePath), CODEX_HOME: destination };
      const newOverlay = resolveSynaraCodexHomeOverlayPath(
        newEnv,
        destination,
        resolveCodexHomeOverlayAccountSegment({ homePath: destination, accountId: "work" }),
      );
      expect(await fs.realpath(path.join(newOverlay, "sessions"))).toBe(
        path.join(destination, "sessions"),
      );
      expect(await fs.readFile(path.join(newOverlay, "history.jsonl"), "utf8")).toBe(
        "historical-cursor\n",
      );
      expect(await fs.readFile(path.join(newOverlay, "unique-alias"), "utf8")).toBe(
        "unique-native-state",
      );
      expect(await fs.readFile(path.join(newOverlay, "auth.json"), "utf8")).toBe(
        "private-native-auth",
      );
      expect(
        await fs.readFile(path.join(input.homePath, "userdata", "native-auth-alias"), "utf8"),
      ).toBe("private-native-auth");
      expect(await fs.realpath(path.join(newOverlay, "fixed-expert-native", "sessions"))).toBe(
        path.join(destination, "sessions"),
      );
      expect(await fs.readFile(path.join(destination, "config.toml"), "utf8")).toBe(
        originalConfig.replace(
          rootAssignment,
          `  ${key} = ${JSON.stringify(destination)} # owned database location`,
        ),
      );
      expect((await fs.lstat(path.join(destination, "config.toml"))).isSymbolicLink()).toBe(
        style === "multiline-literal",
      );
      for (const home of [input.sourceHomePath, path.join(input.recoveryDirectoryPath, "home")]) {
        expect(await fs.readFile(path.join(home, "codex-source", "config.toml"), "utf8")).toBe(
          originalConfig,
        );
        expect(
          await fs.readFile(
            path.join(home, path.relative(env.SYNARA_HOME, overlay), "auth.json"),
            "utf8",
          ),
        ).toBe("private-native-auth");
      }
      expect(await fs.readlink(path.join(overlay, "sessions"))).toBe(originalSessionsLink);
      expect(await fs.realpath(path.join(fixed.CODEX_HOME!, "sessions"))).toBe(
        path.join(source, "sessions"),
      );
      buildCodexProcessEnv({
        env: newEnv,
        accountId: "work",
        expectedSharedContinuationGeneration: generation,
      });
      expect(readCodexSharedContinuationGeneration({ env: newEnv, accountId: "work" })).toBe(
        generation,
      );
    },
    // Each case starts several real Bun processes and copies a recovery set.
    30_000,
  );

  it.each([false, true])(
    "preserves external sqlite configuration state (external home=%s)",
    async (external) => {
      const input = await fixture();
      const source = path.join(external ? input.root : input.sourceHomePath, "codex-source");
      await fs.mkdir(source);
      const config = `sqlite_home = "/external/native-sqlite" # do not adopt\nmodel = "unchanged"\n`;
      await fs.writeFile(path.join(source, "config.toml"), config);
      await fs.writeFile(
        path.join(input.sourceHomePath, "userdata", "settings.json"),
        JSON.stringify({ providers: { codex: { homePath: source } } }),
      );
      await migrateLegacyLinxHome(input);
      expect(await fs.readFile(path.join(source, "config.toml"), "utf8")).toBe(config);
      if (!external) {
        expect(
          await fs.readFile(path.join(input.homePath, "codex-source", "config.toml"), "utf8"),
        ).toBe(config);
      }
    },
  );

  it("rejects unknown escaping account aliases without touching the external target", async () => {
    const input = await fixture();
    const source = path.join(await fs.realpath(input.sourceHomePath), "codex-source");
    await fs.mkdir(source);
    const env = { SYNARA_HOME: await fs.realpath(input.sourceHomePath), CODEX_HOME: source };
    await fs.writeFile(
      path.join(input.sourceHomePath, "userdata", "settings.json"),
      JSON.stringify({
        providerInstances: {
          work: { driver: "codex", environment: [{ name: "CODEX_HOME", value: source }] },
        },
      }),
    );
    const prepared = buildCodexProcessEnv({ env, accountId: "work" });
    const external = path.join(input.root, "external-private");
    await fs.writeFile(external, "external-original");
    await fs.symlink(external, path.join(prepared.CODEX_HOME!, "unrecognized-alias"));
    await expect(migrateLegacyLinxHome(input)).rejects.toThrow(/escaping.*link/i);
    expect(await fs.readFile(external, "utf8")).toBe("external-original");
    expect(await fs.readlink(path.join(prepared.CODEX_HOME!, "unrecognized-alias"))).toBe(external);
  });

  it.each([
    { external: false, sensitive: false },
    { external: false, sensitive: true },
    { external: true, sensitive: false },
    { external: true, sensitive: true },
  ])(
    "rebinds prepared markers and private account state ($external, $sensitive)",
    async ({ external, sensitive }) => {
      const input = await fixture();
      const source = path.join(external ? input.root : input.sourceHomePath, "codex-source");
      await fs.mkdir(source);
      await fs.writeFile(path.join(source, "auth.json"), "default-account-auth");
      const environment = [
        {
          name: "CODEX_HOME",
          value: sensitive ? "" : source,
          ...(sensitive ? { sensitive: true, valueRedacted: true } : {}),
        },
      ];
      if (sensitive)
        await fs.writeFile(
          path.join(
            input.sourceHomePath,
            "userdata",
            "secrets",
            "provider-env-d29yaw-Q09ERVhfSE9NRQ.bin",
          ),
          source,
          { mode: 0o600 },
        );
      await fs.writeFile(
        path.join(input.sourceHomePath, "userdata", "settings.json"),
        JSON.stringify({ providerInstances: { work: { driver: "codex", environment } } }),
      );
      const env = { SYNARA_HOME: input.sourceHomePath, CODEX_HOME: source };
      const prepared = await buildCodexProcessEnv({ env, accountId: "work", platform: "win32" });
      const oldOverlay = prepared.CODEX_HOME!;
      await fs.writeFile(path.join(oldOverlay, "auth.json"), "private-account-auth", {
        mode: 0o600,
      });
      await fs.writeFile(path.join(oldOverlay, "unique.bin"), "unique-overlay-data");
      await fs.mkdir(path.join(oldOverlay, "fixed-expert-native"), { recursive: true });
      await fs.writeFile(path.join(oldOverlay, "fixed-expert-native", "unique.bin"), "fixed-data");
      const markerPath = path.join(source, "synara-shared-continuation-v2.json");
      const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
      marker.migratedFromVersion = 1;
      await fs.writeFile(markerPath, JSON.stringify(marker));
      const original = await fs.readFile(markerPath, "utf8");
      await migrateLegacyLinxHome(input);
      const newSource = external
        ? source
        : path.join(await fs.realpath(input.homePath), "codex-source");
      const newEnv = { SYNARA_HOME: await fs.realpath(input.homePath), CODEX_HOME: newSource };
      const segment = resolveCodexHomeOverlayAccountSegment({
        homePath: newSource,
        accountId: "work",
      });
      const newOverlay = resolveSynaraCodexHomeOverlayPath(newEnv, newSource, segment);
      expect(await fs.readFile(path.join(newOverlay, "auth.json"), "utf8")).toBe(
        "private-account-auth",
      );
      expect(await fs.readFile(path.join(newOverlay, "unique.bin"), "utf8")).toBe(
        "unique-overlay-data",
      );
      expect(
        await fs.readFile(path.join(newOverlay, "fixed-expert-native", "unique.bin"), "utf8"),
      ).toBe("fixed-data");
      expect(await fs.readFile(markerPath, "utf8")).toBe(original);
      expect(
        JSON.parse(
          await fs.readFile(path.join(newSource, "synara-shared-continuation-v2.json"), "utf8"),
        ),
      ).toMatchObject({
        generation: marker.generation,
        migratedFromVersion: 1,
        sourceHomeIdentity: await fs.realpath(newSource),
      });
      // Recovery omits generated aliases. Normal preparation must recreate them,
      // not copy an alias that could still write through to the legacy source.
      await expect(fs.lstat(path.join(newOverlay, "sessions"))).rejects.toThrow();
      const launched = await buildCodexProcessEnv({
        env: newEnv,
        accountId: "work",
        platform: "win32",
        expectedSharedContinuationGeneration: marker.generation,
      });
      expect(await fs.readFile(path.join(launched.CODEX_HOME!, "auth.json"), "utf8")).toBe(
        "private-account-auth",
      );
      expect(readCodexSharedContinuationGeneration({ env: newEnv, accountId: "work" })).toBe(
        marker.generation,
      );
      expect(await fs.readFile(path.join(source, "auth.json"), "utf8")).toBe(
        "default-account-auth",
      );
      expect((await fs.stat(path.join(newOverlay, "auth.json"))).mode & 0o777).toBe(0o600);
    },
  );

  it.each(["corrupt", "wrong-source", "unknown-version"])(
    "rejects copied %s continuation markers",
    async (kind) => {
      const input = await fixture();
      const source = path.join(input.sourceHomePath, "codex-source");
      await fs.mkdir(source);
      await fs.writeFile(
        path.join(input.sourceHomePath, "userdata", "settings.json"),
        JSON.stringify({ providers: { codex: { homePath: source } } }),
      );
      const content =
        kind === "corrupt"
          ? "{"
          : JSON.stringify({
              version: kind === "unknown-version" ? 3 : 2,
              sourceHomeIdentity: "/another-source",
              generation: "123e4567-e89b-42d3-a456-426614174000",
            });
      const marker = path.join(source, "synara-shared-continuation-v2.json");
      await fs.writeFile(marker, content);
      await expect(migrateLegacyLinxHome(input)).rejects.toThrow(/marker/i);
      expect(await fs.readFile(marker, "utf8")).toBe(content);
      await expect(
        fs.access(path.join(input.homePath, "linx-home-migration.json")),
      ).rejects.toThrow();
    },
  );

  it("fails closed on private overlay collisions without overwriting either credential", async () => {
    const input = await fixture();
    const source = path.join(input.sourceHomePath, "codex-source");
    const destination = path.join(await fs.realpath(input.root), ".linx", "codex-source");
    await fs.mkdir(source);
    await fs.writeFile(
      path.join(input.sourceHomePath, "userdata", "settings.json"),
      JSON.stringify({
        providerInstances: {
          work: { driver: "codex", environment: [{ name: "CODEX_HOME", value: source }] },
        },
      }),
    );
    const overlay = (homePath: string) =>
      resolveSynaraCodexHomeOverlayPath(
        { SYNARA_HOME: input.sourceHomePath },
        homePath,
        resolveCodexHomeOverlayAccountSegment({ homePath, accountId: "work" }),
      );
    for (const [home, secret] of [
      [source, "original"],
      [destination, "collision"],
    ] as const) {
      await fs.mkdir(overlay(home), { recursive: true });
      await fs.writeFile(path.join(overlay(home), "auth.json"), secret);
    }
    await expect(migrateLegacyLinxHome(input)).rejects.toThrow(/collision/i);
    for (const [home, secret] of [
      [source, "original"],
      [destination, "collision"],
    ] as const) {
      expect(
        await fs.readFile(
          path.join(
            input.homePath,
            path.relative(input.sourceHomePath, overlay(home)),
            "auth.json",
          ),
          "utf8",
        ),
      ).toBe(secret);
    }
  });

  it("merges disjoint copied account files without losing existing destination state", async () => {
    const input = await fixture();
    const source = path.join(input.sourceHomePath, "codex-source");
    const destination = path.join(await fs.realpath(input.root), ".linx", "codex-source");
    await fs.mkdir(source);
    await fs.writeFile(
      path.join(input.sourceHomePath, "userdata", "settings.json"),
      JSON.stringify({
        providerInstances: {
          work: { driver: "codex", environment: [{ name: "CODEX_HOME", value: source }] },
        },
      }),
    );
    const oldOverlay = resolveSynaraCodexHomeOverlayPath(
      { SYNARA_HOME: input.sourceHomePath },
      source,
      resolveCodexHomeOverlayAccountSegment({ homePath: source, accountId: "work" }),
    );
    const newSegment = resolveCodexHomeOverlayAccountSegment({
      homePath: destination,
      accountId: "work",
    });
    const copiedDestination = resolveSynaraCodexHomeOverlayPath(
      { SYNARA_HOME: input.sourceHomePath },
      destination,
      newSegment,
    );
    await fs.mkdir(oldOverlay, { recursive: true });
    await fs.mkdir(copiedDestination, { recursive: true });
    await fs.writeFile(path.join(oldOverlay, "auth.json"), "private-auth");
    await fs.writeFile(path.join(copiedDestination, "existing.bin"), "destination-state");
    await migrateLegacyLinxHome(input);
    const migrated = resolveSynaraCodexHomeOverlayPath(
      { SYNARA_HOME: input.homePath },
      destination,
      newSegment,
    );
    expect(await fs.readFile(path.join(migrated, "auth.json"), "utf8")).toBe("private-auth");
    expect(await fs.readFile(path.join(migrated, "existing.bin"), "utf8")).toBe(
      "destination-state",
    );
    await expect(
      fs.access(path.join(input.homePath, path.relative(input.sourceHomePath, oldOverlay))),
    ).rejects.toThrow();
    expect(await fs.readFile(path.join(oldOverlay, "auth.json"), "utf8")).toBe("private-auth");
  });

  it("preserves a real v2 generation when the explicit Codex home is relocated", async () => {
    const input = await fixture();
    const source = path.join(input.sourceHomePath, "codex-source");
    await fs.mkdir(source);
    await fs.writeFile(
      path.join(input.sourceHomePath, "userdata", "settings.json"),
      JSON.stringify({ providers: { codex: { homePath: source } } }),
    );
    await buildCodexProcessEnv({
      env: { SYNARA_HOME: input.sourceHomePath },
      homePath: source,
      platform: "win32",
    });
    const generation = readCodexSharedContinuationGeneration({
      env: { SYNARA_HOME: input.sourceHomePath },
      homePath: source,
    });
    expect(generation).toBeDefined();
    await migrateLegacyLinxHome(input);
    const destination = path.join(await fs.realpath(input.homePath), "codex-source");
    await buildCodexProcessEnv({
      env: { SYNARA_HOME: input.homePath },
      homePath: destination,
      platform: "win32",
      expectedSharedContinuationGeneration: generation!,
    });
    expect(
      readCodexSharedContinuationGeneration({
        env: { SYNARA_HOME: input.homePath },
        homePath: destination,
      }),
    ).toBe(generation);
  });

  it("does not inspect or rewrite externally owned corrupt markers", async () => {
    const input = await fixture();
    const source = path.join(input.root, "external-codex");
    await fs.mkdir(source);
    const marker = path.join(source, "synara-shared-continuation-v2.json");
    await fs.writeFile(marker, "external-corrupt-marker");
    await fs.writeFile(
      path.join(input.sourceHomePath, "userdata", "settings.json"),
      JSON.stringify({ providers: { codex: { homePath: source } } }),
    );
    await migrateLegacyLinxHome(input);
    expect(await fs.readFile(marker, "utf8")).toBe("external-corrupt-marker");
  });

  it("rebinds known v1 state without assigning a replacement generation", async () => {
    const input = await fixture();
    const source = path.join(input.sourceHomePath, "codex-source");
    await fs.mkdir(source);
    await fs.writeFile(
      path.join(input.sourceHomePath, "userdata", "settings.json"),
      JSON.stringify({ providers: { codex: { homePath: source } } }),
    );
    await buildCodexProcessEnv({
      env: { SYNARA_HOME: input.sourceHomePath },
      homePath: source,
      platform: "win32",
    });
    await fs.unlink(path.join(source, "synara-shared-continuation-v2.json"));
    const original = JSON.stringify({
      version: 1,
      sourceHomeIdentity: await fs.realpath(source),
      extra: "retained",
    });
    await fs.writeFile(path.join(source, "synara-shared-continuation-v1.json"), original);
    await migrateLegacyLinxHome(input);
    const destination = path.join(await fs.realpath(input.homePath), "codex-source");
    expect(
      JSON.parse(
        await fs.readFile(path.join(destination, "synara-shared-continuation-v1.json"), "utf8"),
      ),
    ).toEqual({ version: 1, sourceHomeIdentity: destination, extra: "retained" });
    await expect(
      fs.access(path.join(destination, "synara-shared-continuation-v2.json")),
    ).rejects.toThrow();
    expect(await fs.readFile(path.join(source, "synara-shared-continuation-v1.json"), "utf8")).toBe(
      original,
    );
    await buildCodexProcessEnv({
      env: { SYNARA_HOME: input.homePath },
      homePath: destination,
      platform: "win32",
    });
    expect(
      JSON.parse(
        await fs.readFile(path.join(destination, "synara-shared-continuation-v2.json"), "utf8"),
      ),
    ).toMatchObject({ version: 2, sourceHomeIdentity: destination, migratedFromVersion: 1 });
  });

  it("retains recoverable private state and blocks publication when an overlay move is interrupted", async () => {
    const input = await fixture();
    const source = path.join(input.sourceHomePath, "codex-source");
    await fs.mkdir(source);
    await fs.writeFile(
      path.join(input.sourceHomePath, "userdata", "settings.json"),
      JSON.stringify({
        providerInstances: {
          work: { driver: "codex", environment: [{ name: "CODEX_HOME", value: source }] },
        },
      }),
    );
    const prepared = await buildCodexProcessEnv({
      env: { SYNARA_HOME: input.sourceHomePath, CODEX_HOME: source },
      accountId: "work",
      platform: "win32",
    });
    await fs.writeFile(path.join(prepared.CODEX_HOME!, "auth.json"), "private-account-auth");
    const link = fs.link;
    const interrupted = vi.spyOn(fs, "link").mockImplementation(async (from, to) => {
      if (
        String(to).startsWith(await fs.realpath(input.homePath)) &&
        path.basename(String(to)) === "auth.json"
      ) {
        await link(from, to);
        throw new Error("interrupted overlay publication");
      }
      return link(from, to);
    });
    try {
      await expect(migrateLegacyLinxHome(input)).rejects.toThrow("interrupted overlay publication");
    } finally {
      interrupted.mockRestore();
    }
    const relative = path.relative(input.sourceHomePath, prepared.CODEX_HOME!);
    for (const home of [
      input.sourceHomePath,
      path.join(input.recoveryDirectoryPath, "home"),
      input.homePath,
    ]) {
      expect(await fs.readFile(path.join(home, relative, "auth.json"), "utf8")).toBe(
        "private-account-auth",
      );
    }
    await expect(
      fs.access(path.join(input.homePath, "linx-home-migration.json")),
    ).rejects.toThrow();
    expect(
      JSON.parse(await fs.readFile(`${input.homePath}.linx-migration.json`, "utf8")).status,
    ).toBe("importing");
  });

  it.each([
    { sensitive: false, external: false },
    { sensitive: true, external: false },
    { sensitive: false, external: true },
    { sensitive: true, external: true },
  ])(
    "preserves effective Codex home ownership ($sensitive, $external)",
    async ({ sensitive, external }) => {
      const input = await fixture();
      const source = path.join(external ? input.root : input.sourceHomePath, "codex-source");
      const destination = external
        ? source
        : path.join(await fs.realpath(input.root), ".linx", "codex-source");
      await fs.mkdir(source);
      await fs.writeFile(path.join(source, "auth.json"), "account-credential", { mode: 0o600 });
      const environment = [
        {
          name: "CODEX_HOME",
          value: sensitive ? "" : source,
          sensitive,
          ...(sensitive ? { valueRedacted: true } : {}),
        },
        { name: "API_KEY", value: source, sensitive: false },
        { name: "CUSTOM_HOME", value: source, sensitive: false },
      ];
      const settings = {
        providerInstances: {
          codex: { driver: "codex", environment, config: { customModels: [source] } },
          future: { driver: "future", environment: [{ name: "CODEX_HOME", value: source }] },
        },
      };
      const original = JSON.stringify({ revision: 29, migrationVersion: 3, settings });
      const settingsPath = path.join(input.sourceHomePath, "userdata", "settings.json");
      await fs.writeFile(settingsPath, original, { mode: 0o600 });
      const secretName = "provider-env-Y29kZXg-Q09ERVhfSE9NRQ.bin";
      if (sensitive) {
        await fs.writeFile(
          path.join(input.sourceHomePath, "userdata", "secrets", secretName),
          source,
          { mode: 0o600 },
        );
      }
      await migrateLegacyLinxHome(input);
      const copiedText = await fs.readFile(
        path.join(input.homePath, "userdata", "settings.json"),
        "utf8",
      );
      const copied = JSON.parse(copiedText);
      expect(copied).toMatchObject({ revision: 29, migrationVersion: 3 });
      expect(copied.settings.providerInstances.future).toEqual(settings.providerInstances.future);
      expect(copied.settings.providerInstances.codex.config).toEqual(
        settings.providerInstances.codex.config,
      );
      expect(copied.settings.providerInstances.codex.environment.slice(1)).toEqual(
        environment.slice(1),
      );
      const selected = copied.settings.providerInstances.codex.environment[0];
      if (sensitive) {
        expect(selected).toEqual(environment[0]);
        const secretPath = path.join(input.homePath, "userdata", "secrets", secretName);
        expect(await fs.readFile(secretPath, "utf8")).toBe(destination);
        expect((await fs.stat(secretPath)).mode & 0o777).toBe(0o600);
        expect(
          await fs.readFile(
            path.join(input.sourceHomePath, "userdata", "secrets", secretName),
            "utf8",
          ),
        ).toBe(source);
        expect(
          await fs.readFile(
            path.join(input.recoveryDirectoryPath, "home", "userdata", "secrets", secretName),
            "utf8",
          ),
        ).toBe(source);
        selected.value = await fs.readFile(secretPath, "utf8");
        delete selected.valueRedacted;
      }
      const runtime = deriveProviderInstances(
        Schema.decodeUnknownSync(ServerSettings)(copied.settings),
      ).find((instance) => instance.instanceId === "codex")!;
      expect(providerStartOptionsFromInstance(runtime)?.codex?.environment?.CODEX_HOME).toBe(
        destination,
      );
      expect(await fs.readFile(path.join(destination, "auth.json"), "utf8")).toBe(
        "account-credential",
      );
      expect(await fs.readFile(settingsPath, "utf8")).toBe(original);
      expect(
        (await fs.stat(path.join(input.homePath, "userdata", "settings.json"))).mode & 0o777,
      ).toBe(0o600);
      expect(
        await fs.readFile(path.join(input.homePath, "linx-home-migration.json"), "utf8"),
      ).not.toContain(source);
    },
  );
  it("relocates only recognized provider directory environment slots", async () => {
    const input = await fixture();
    const owned = path.join(input.sourceHomePath, "owned");
    const moved = path.join(await fs.realpath(input.root), ".linx", "owned");
    const slots: Record<string, string[]> = {
      codex: ["CODEX_HOME", "CODEX_SQLITE_HOME"],
      claudeAgent: ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"],
      cursor: ["CURSOR_CONFIG_DIR"],
      grok: ["GROK_HOME"],
      pi: ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"],
      omp: ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"],
    };
    const providerInstances = Object.fromEntries(
      Object.entries(slots).map(([driver, names]) => [
        driver,
        {
          driver,
          environment: [...names, "HOME", "XDG_CONFIG_HOME", "TOKEN", "UNRECOGNIZED_DIR"].map(
            (name) => ({ name, value: owned }),
          ),
        },
      ]),
    );
    await fs.writeFile(
      path.join(input.sourceHomePath, "userdata", "settings.json"),
      JSON.stringify({ providerInstances }),
    );
    await migrateLegacyLinxHome(input);
    const copied = JSON.parse(
      await fs.readFile(path.join(input.homePath, "userdata", "settings.json"), "utf8"),
    );
    for (const [driver, names] of Object.entries(slots)) {
      expect(copied.providerInstances[driver].environment).toEqual(
        [...names, "HOME", "XDG_CONFIG_HOME", "TOKEN", "UNRECOGNIZED_DIR"].map((name) => ({
          name,
          value: name === "TOKEN" || name === "UNRECOGNIZED_DIR" ? owned : moved,
        })),
      );
    }
  });
  it.each([false, true])(
    "relocates only persisted provider directory fields before startup (envelope=%s)",
    async (envelope) => {
      const input = await fixture();
      const owned = path.join(input.sourceHomePath, "userdata", "provider-homes");
      const moved = path.join(await fs.realpath(input.root), ".linx", "userdata", "provider-homes");
      const settings = {
        providers: {
          codex: {
            homePath: owned,
            selectedAccountId: "work",
            customModels: [owned],
            accounts: [{ id: "work", homePath: `${owned}/work`, shadowHomePath: `${owned}/auth` }],
          },
          claudeAgent: { homePath: "/external/claude", launchArgs: owned },
          pi: { agentDir: `${owned}/pi` },
        },
        providerInstances: {
          work: {
            driver: "codex",
            config: { homePath: owned, shadowHomePath: `${owned}/auth`, apiKey: owned },
          },
          claude: {
            driver: "claudeAgent",
            config: { configDir: `${owned}/claude`, secureStorageDir: `${owned}/secure` },
          },
          external: {
            driver: "codex",
            config: { homePath: `${input.sourceHomePath}-other`, shadowHomePath: "/external/auth" },
          },
          future: { driver: "future", config: { homePath: owned } },
        },
        textGenerationModelSelection: { provider: "codex", model: owned },
      };
      const document = envelope ? { revision: 17, migrationVersion: 2, settings } : settings;
      const original = JSON.stringify(document);
      await fs.writeFile(path.join(input.sourceHomePath, "userdata", "settings.json"), original, {
        mode: 0o600,
      });
      await migrateLegacyLinxHome(input);
      const copied = JSON.parse(
        await fs.readFile(path.join(input.homePath, "userdata", "settings.json"), "utf8"),
      );
      const migrated = envelope ? copied.settings : copied;
      expect(migrated.providers.codex.homePath).toBe(moved);
      expect(migrated.providers.codex.accounts).toEqual([
        { id: "work", homePath: `${moved}/work`, shadowHomePath: `${moved}/auth` },
      ]);
      expect(migrated.providers.pi.agentDir).toBe(`${moved}/pi`);
      expect(migrated.providerInstances.work.config).toEqual({
        homePath: moved,
        shadowHomePath: `${moved}/auth`,
        apiKey: owned,
      });
      expect(migrated.providerInstances.claude.config).toEqual({
        configDir: `${moved}/claude`,
        secureStorageDir: `${moved}/secure`,
      });
      expect(migrated.providerInstances.external).toEqual(settings.providerInstances.external);
      expect(migrated.providerInstances.future).toEqual(settings.providerInstances.future);
      expect(migrated.providers.claudeAgent).toEqual(settings.providers.claudeAgent);
      expect(migrated.providers.codex.customModels).toEqual([owned]);
      expect(migrated.providers.codex.selectedAccountId).toBe("work");
      expect(migrated.textGenerationModelSelection).toEqual(settings.textGenerationModelSelection);
      if (envelope) expect(copied).toMatchObject({ revision: 17, migrationVersion: 2 });
      expect(
        await fs.readFile(path.join(input.sourceHomePath, "userdata", "settings.json"), "utf8"),
      ).toBe(original);
      expect(
        await fs.readFile(
          path.join(input.recoveryDirectoryPath, "home", "userdata", "settings.json"),
          "utf8",
        ),
      ).toBe(original);
      await expect(migrateLegacyLinxHome(input)).rejects.toThrow("not empty");
      expect(
        JSON.parse(
          await fs.readFile(path.join(input.homePath, "userdata", "settings.json"), "utf8"),
        ),
      ).toEqual(copied);
    },
  );
  it("preserves app data, secrets and bounded draft handoff without changing historical ledger bytes", async () => {
    const input = await fixture();
    const result = await migrateLegacyLinxHome(input);
    expect(result.reauthenticationNotice).toContain("Third-party Keychain");
    expect(
      await fs.readFile(path.join(input.sourceHomePath, "userdata", "state.sqlite"), "utf8"),
    ).toBe("historical ledger unchanged");
    expect(await fs.readFile(path.join(input.homePath, "userdata", "state.sqlite"), "utf8")).toBe(
      "historical ledger unchanged",
    );
    expect(
      await fs.readFile(path.join(input.homePath, "userdata", "secrets", "provider.bin"), "utf8"),
    ).toBe("app-owned-secret");
    expect(readSynaraStorageSnapshot(resolveSynaraStorageSnapshotPath(input.userDataPath))).toEqual(
      input.snapshot,
    );
    expect(
      JSON.parse(await fs.readFile(path.join(input.homePath, "linx-home-migration.json"), "utf8"))
        .status,
    ).toBe("paths-pending");
    await expect(
      fs.lstat(path.join(input.sourceUserDataPath, "SingletonLock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("requires explicit consent before any recovery or target write", async () => {
    const input = await fixture();
    await expect(migrateLegacyLinxHome({ ...input, consent: false })).rejects.toThrow(
      "explicit consent",
    );
    await expect(fs.stat(input.homePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(input.transferStorage).not.toHaveBeenCalled();
  });
  it("refuses a live source backend under the native lifecycle lock", async () => {
    const input = await fixture();
    const lock = await Effect.runPromise(
      acquireDatabaseLifecycleLock(path.join(input.sourceHomePath, "userdata", "state.sqlite")),
    );
    try {
      await expect(migrateLegacyLinxHome(input)).rejects.toThrow("is live");
    } finally {
      await Effect.runPromise(releaseDatabaseLifecycleLock(lock));
    }
    await expect(fs.stat(input.homePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses a live or unknown legacy profile owner", async () => {
    const input = await fixture();
    const singleton = path.join(input.sourceUserDataPath, "SingletonLock");
    await fs.symlink(`${os.hostname()}-${process.pid}`, singleton);
    await expect(migrateLegacyLinxHome(input)).rejects.toThrow("still running");
    await fs.unlink(singleton);
    await fs.symlink("another-host-17", singleton);
    await expect(migrateLegacyLinxHome(input)).rejects.toThrow("unknown");
  });
  it("never overwrites a populated new identity or silently replays an import", async () => {
    const input = await fixture();
    await migrateLegacyLinxHome(input);
    await fs.writeFile(path.join(input.homePath, "newer-data"), "new work");
    await expect(migrateLegacyLinxHome(input)).rejects.toThrow("not empty");
    expect(await fs.readFile(path.join(input.homePath, "newer-data"), "utf8")).toBe("new work");
  });
  it("refuses escape links before copying unrelated workspace data", async () => {
    const input = await fixture();
    await fs.symlink(input.root, path.join(input.sourceHomePath, "unrelated-workspace"));
    await expect(migrateLegacyLinxHome(input)).rejects.toThrow("Escaping recovery link");
    await expect(fs.stat(input.homePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("leaves durable blocking evidence and a verified recovery source on extraction failure", async () => {
    const input = await fixture();
    input.transferStorage.mockRejectedValue(new Error("corrupt draft blob"));
    await expect(migrateLegacyLinxHome(input)).rejects.toThrow("corrupt draft blob");
    expect(
      JSON.parse(await fs.readFile(`${input.homePath}.linx-migration.json`, "utf8")).status,
    ).toBe("importing");
    expect(
      await fs.readFile(
        path.join(input.recoveryDirectoryPath, "home", "userdata", "state.sqlite"),
        "utf8",
      ),
    ).toBe("historical ledger unchanged");
    const lock = await Effect.runPromise(
      acquireDatabaseLifecycleLock(path.join(input.sourceHomePath, "userdata", "state.sqlite")),
    );
    await Effect.runPromise(releaseDatabaseLifecycleLock(lock));
  });
  it("refuses silent conflict with a previous old-origin handoff", async () => {
    const input = await fixture();
    await fs.writeFile(
      resolveSynaraStorageSnapshotPath(input.sourceUserDataPath),
      JSON.stringify({
        ...input.snapshot,
        entries: { "synara:composer-drafts:v1": "different newer draft" },
      }),
    );
    await expect(migrateLegacyLinxHome(input)).rejects.toThrow(
      "Conflicting legacy browser handoff",
    );
  });
  it("requires portable protection for an old-identity OS-only browser vault without accessing Keychain", async () => {
    const input = await fixture();
    const directory = path.join(input.sourceHomePath, "browser-vault", "vault");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, "key-protection.json"),
      JSON.stringify({ version: 1, os: "wrapped", master: null }),
    );
    await expect(migrateLegacyLinxHome(input)).rejects.toThrow("master-password protection");
    await expect(fs.stat(input.homePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses OS-only remembered-session recovery before copying any target data", async () => {
    const input = await fixture();
    const directory = path.join(input.sourceHomePath, "browser-session-restore");
    await fs.mkdir(directory);
    await fs.writeFile(
      path.join(directory, "key-protection.json"),
      JSON.stringify({ version: 1, os: "old-identity", master: null }),
    );
    await fs.writeFile(
      path.join(directory, "sessions.enc"),
      "unique encrypted remembered-session bytes",
    );
    await expect(migrateLegacyLinxHome(input)).rejects.toThrow("cannot be imported offline");
    await expect(fs.stat(input.homePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(directory, "sessions.enc"), "utf8")).toBe(
      "unique encrypted remembered-session bytes",
    );
  });
  it("does not mistake a malformed master envelope for portable vault protection", async () => {
    const input = await fixture();
    const directory = path.join(input.sourceHomePath, "browser-vault", "vault");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, "key-protection.json"),
      JSON.stringify({ version: 1, os: "wrapped", master: {} }),
    );
    await expect(migrateLegacyLinxHome(input)).rejects.toThrow(
      "master-password envelope is corrupt",
    );
    await expect(fs.stat(input.homePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("preserves a structurally portable master-wrapped vault without requesting its password or OS key", async () => {
    const input = await fixture();
    const directory = path.join(input.sourceHomePath, "browser-vault", "vault");
    await fs.mkdir(directory, { recursive: true });
    const envelope = JSON.stringify({
      version: 1,
      os: "wrapped",
      master: {
        salt: Buffer.alloc(16, 1).toString("base64"),
        iv: Buffer.alloc(12, 2).toString("base64"),
        tag: Buffer.alloc(16, 3).toString("base64"),
        data: Buffer.alloc(32, 4).toString("base64"),
      },
    });
    await fs.writeFile(path.join(directory, "key-protection.json"), envelope, { mode: 0o600 });
    await migrateLegacyLinxHome(input);
    expect(
      await fs.readFile(
        path.join(input.homePath, "browser-vault", "vault", "key-protection.json"),
        "utf8",
      ),
    ).toBe(envelope);
  });
  it.each(["browser-vault/vault", "browser-session-restore"])(
    "refuses encrypted %s data with a missing protection key instead of replacing it",
    async (relative) => {
      const input = await fixture();
      const directory = path.join(input.sourceHomePath, relative);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(
        path.join(directory, relative === "browser-session-restore" ? "sessions.enc" : "vault.enc"),
        "irreplaceable encrypted bytes",
      );
      await expect(migrateLegacyLinxHome(input)).rejects.toThrow("recovery key is missing");
      await expect(fs.stat(input.homePath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});
