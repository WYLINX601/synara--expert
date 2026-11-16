import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectId, ThreadId } from "@synara/contracts";
import type { OrchestrationCommand, OrchestrationReadModel } from "@synara/contracts";
import type { OrchestrationEngineShape } from "./orchestration/Services/OrchestrationEngine";
import {
  assertLinxHomeMigrationReadyForDatabase,
  completeLinxHomeMigration,
  relocateLinxOwnedPath,
  repairLinxManagedWorktrees,
} from "./linxHomeMigration";
import { buildCodexProcessEnv } from "./codexProcessEnv";
import {
  createLinxUpdateRecoverySet,
  restoreLinxUpdateRecoverySetToEmptyTargets,
} from "@synara/shared/linxUpdateRecovery";
import { randomUUID } from "node:crypto";

const git = promisify(execFile);
const migrateProviderBindings = () => Effect.void;
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "linx-native-import-"));
  temporary.push(root);
  const sourceHomePath = path.join(root, ".synara-workbench");
  const homePath = path.join(root, ".linx");
  await fs.mkdir(path.join(sourceHomePath, "userdata"), { recursive: true, mode: 0o700 });
  await fs.mkdir(homePath);
  const receipt = {
    schemaVersion: 1,
    status: "paths-pending",
    sourceHomePath,
    homePath: await fs.realpath(homePath),
  };
  await fs.writeFile(path.join(homePath, "linx-home-migration.json"), JSON.stringify(receipt));
  await fs.writeFile(`${homePath}.linx-migration.json`, JSON.stringify(receipt));
  return { root, sourceHomePath, homePath };
}

describe("native Linx home relocation", () => {
  it("recovers real generated Codex overlays and reconstructs aliases without copying external state", async () => {
    const input = await fixture();
    const external = path.join(input.root, "external-codex");
    const profile = path.join(input.root, "profile");
    await fs.mkdir(external);
    await fs.mkdir(profile);
    await fs.writeFile(path.join(external, "config.toml"), "");
    await fs.writeFile(path.join(external, "auth.json"), "external-auth");
    await fs.writeFile(
      path.join(input.sourceHomePath, "userdata", "settings.json"),
      JSON.stringify({ providers: { codex: { homePath: external } } }),
    );
    const prepared = await buildCodexProcessEnv({
      env: { SYNARA_HOME: input.sourceHomePath },
      homePath: external,
      platform: "win32",
    });
    const overlay = prepared.CODEX_HOME!;
    await fs.writeFile(path.join(overlay, "unique.txt"), "unique overlay bytes");
    const recoveryDirectoryPath = path.join(input.root, "overlay-recovery");
    const manifest = await createLinxUpdateRecoverySet({
      recoveryDirectoryPath,
      homePath: input.sourceHomePath,
      userDataPath: profile,
      attemptId: randomUUID(),
      sourceVersion: "0.1.15",
    });
    expect(manifest.entries.some((entry) => entry.path.endsWith("/auth.json"))).toBe(false);
    const restoredHome = path.join(input.root, "restored-home");
    await restoreLinxUpdateRecoverySetToEmptyTargets({
      recoveryDirectoryPath,
      homePath: restoredHome,
      userDataPath: path.join(input.root, "restored-profile"),
    });
    const rebuilt = await buildCodexProcessEnv({
      env: { SYNARA_HOME: restoredHome },
      homePath: external,
      platform: "win32",
    });
    expect(await fs.readlink(path.join(rebuilt.CODEX_HOME!, "auth.json"))).toBe(
      path.join(external, "auth.json"),
    );
    expect(await fs.readFile(path.join(rebuilt.CODEX_HOME!, "unique.txt"), "utf8")).toBe(
      "unique overlay bytes",
    );
    expect(await fs.readFile(path.join(external, "auth.json"), "utf8")).toBe("external-auth");
  });
  it("relocates only whole path prefixes and never unrelated workspace paths", () => {
    expect(relocateLinxOwnedPath("/old/worktrees/a", "/old", "/new")).toBe("/new/worktrees/a");
    expect(relocateLinxOwnedPath("/older/repo", "/old", "/new")).toBe("/older/repo");
    expect(relocateLinxOwnedPath("/workspace/project", "/old", "/new")).toBe("/workspace/project");
  });
  it("blocks incomplete filesystem imports before opening the database", async () => {
    const input = await fixture();
    await fs.writeFile(
      `${input.homePath}.linx-migration.json`,
      JSON.stringify({
        schemaVersion: 1,
        homePath: await fs.realpath(input.homePath),
        status: "importing",
      }),
    );
    await expect(assertLinxHomeMigrationReadyForDatabase(input.homePath)).rejects.toThrow(
      "incomplete",
    );
  });
  it("appends native metadata commands, preserves history bytes and deduplicates completed replay", async () => {
    const input = await fixture();
    const history = path.join(input.homePath, "historical-ledger.fixture");
    await fs.writeFile(history, `historical path ${input.sourceHomePath}`);
    const commands: OrchestrationCommand[] = [];
    const model = {
      projects: [
        {
          id: ProjectId.makeUnsafe("managed"),
          workspaceRoot: path.join(input.sourceHomePath, "projects", "managed"),
          additionalFolders: [path.join(input.sourceHomePath, "extra"), "/external/extra"],
        },
        {
          id: ProjectId.makeUnsafe("external"),
          workspaceRoot: "/unrelated/workspace",
          additionalFolders: [],
        },
      ],
      threads: [
        {
          id: ThreadId.makeUnsafe("thread"),
          worktreePath: path.join(input.sourceHomePath, "worktrees", "a"),
          workingDirectory: "/unrelated/workspace",
          associatedWorktreePath: path.join(input.sourceHomePath, "worktrees", "a"),
        },
      ],
    } as unknown as OrchestrationReadModel;
    const engine = {
      getProjectionCatchUpStatus: Effect.succeed({ state: "healthy", inFlight: false }),
      getReadModel: () => Effect.succeed(model),
      drain: Effect.void,
      dispatch: vi.fn((command: OrchestrationCommand) => {
        commands.push(command);
        return Effect.succeed({ sequence: commands.length });
      }),
    } as unknown as OrchestrationEngineShape;
    await Effect.runPromise(
      completeLinxHomeMigration({
        homePath: input.homePath,
        engine,
        migrateProviderBindings,
        settleOrphanedActivity: () => Effect.void,
      }),
    );
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject({
      type: "project.meta.update",
      workspaceRoot: path.join(input.homePath, "projects", "managed"),
      additionalFolders: [path.join(input.homePath, "extra"), "/external/extra"],
    });
    expect(commands[1]).toMatchObject({
      type: "thread.meta.update",
      worktreePath: path.join(input.homePath, "worktrees", "a"),
      associatedWorktreePath: path.join(input.homePath, "worktrees", "a"),
    });
    expect(commands[1]).not.toHaveProperty("workingDirectory");
    expect(await fs.readFile(history, "utf8")).toBe(`historical path ${input.sourceHomePath}`);
    await Effect.runPromise(
      completeLinxHomeMigration({
        homePath: input.homePath,
        engine,
        migrateProviderBindings,
        settleOrphanedActivity: () => Effect.void,
      }),
    );
    expect(commands).toHaveLength(2);
  });
  it("relocates native-owned live aliases against a canonical receipt without rewriting historical evidence or symlink escapes", async () => {
    const input = await fixture();
    const sourceHomePath = await fs.realpath(input.sourceHomePath);
    const alias = path.join(input.root, "old-home-alias");
    const external = path.join(input.root, "external");
    await fs.mkdir(external);
    await fs.mkdir(path.join(sourceHomePath, "projects"));
    await fs.symlink(sourceHomePath, alias, process.platform === "win32" ? "junction" : "dir");
    const escape = path.join(sourceHomePath, "escape");
    const danglingEscape = path.join(sourceHomePath, "dangling-escape");
    await fs.symlink(external, escape, process.platform === "win32" ? "junction" : "dir");
    await fs.symlink(
      path.join(external, "missing"),
      danglingEscape,
      process.platform === "win32" ? "junction" : "dir",
    );
    const receiptPath = path.join(input.homePath, "linx-home-migration.json");
    const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
    await fs.writeFile(receiptPath, JSON.stringify({ ...receipt, sourceHomePath }));
    const historicalEvidence = JSON.stringify({
      workspaceRoot: path.join(alias, "projects"),
      fixedExpert: { home: alias },
    });
    const historyPath = path.join(input.homePath, "historical-ledger.fixture");
    await fs.writeFile(historyPath, historicalEvidence);
    const commands: OrchestrationCommand[] = [];
    const engine = {
      getProjectionCatchUpStatus: Effect.succeed({ state: "healthy", inFlight: false }),
      getReadModel: () =>
        Effect.succeed({
          projects: [
            {
              id: ProjectId.makeUnsafe("aliased"),
              workspaceRoot: path.join(alias, "projects"),
              additionalFolders: [
                path.join(alias, "projects", "not-created", "child"),
                path.join(input.sourceHomePath, "future"),
                path.join(escape, "missing-child"),
                path.join(danglingEscape, "child"),
                external,
              ],
            },
          ],
          threads: [
            {
              id: ThreadId.makeUnsafe("aliased-thread"),
              worktreePath: path.join(alias, "worktrees", "thread"),
              workingDirectory: path.join(alias, "projects", "missing"),
              associatedWorktreePath: path.join(escape, "thread"),
            },
          ],
        }),
      drain: Effect.void,
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: commands.length };
        }),
    } as unknown as OrchestrationEngineShape;
    await Effect.runPromise(
      completeLinxHomeMigration({
        homePath: input.homePath,
        engine,
        migrateProviderBindings,
        settleOrphanedActivity: () => Effect.void,
      }),
    );
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject({
      type: "project.meta.update",
      workspaceRoot: path.join(input.homePath, "projects"),
      additionalFolders: [
        path.join(input.homePath, "projects", "not-created", "child"),
        path.join(input.homePath, "future"),
        path.join(escape, "missing-child"),
        path.join(danglingEscape, "child"),
        external,
      ],
    });
    expect(commands[1]).toMatchObject({
      type: "thread.meta.update",
      worktreePath: path.join(input.homePath, "worktrees", "thread"),
      workingDirectory: path.join(input.homePath, "projects", "missing"),
    });
    expect(commands[1]).not.toHaveProperty("associatedWorktreePath");
    expect(await fs.readFile(historyPath, "utf8")).toBe(historicalEvidence);
    expect(JSON.parse(await fs.readFile(receiptPath, "utf8")).status).toBe("complete");
    expect(await fs.realpath(alias)).toBe(sourceHomePath);
    expect(await fs.realpath(escape)).toBe(await fs.realpath(external));
  });
  it("keeps native-owned paths pending when the copied destination escapes through a symlink", async () => {
    const input = await fixture();
    const external = path.join(input.root, "external-destination");
    await fs.mkdir(external);
    await fs.symlink(
      external,
      path.join(input.homePath, "projects"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const engine = {
      getProjectionCatchUpStatus: Effect.succeed({ state: "healthy", inFlight: false }),
      getReadModel: () =>
        Effect.succeed({
          projects: [
            {
              id: ProjectId.makeUnsafe("escaped-copy"),
              workspaceRoot: path.join(input.sourceHomePath, "projects", "missing"),
              additionalFolders: [],
            },
          ],
          threads: [],
        }),
      drain: Effect.void,
      dispatch: vi.fn(),
    } as unknown as OrchestrationEngineShape;
    await expect(
      Effect.runPromise(
        completeLinxHomeMigration({
          homePath: input.homePath,
          engine,
          migrateProviderBindings,
          settleOrphanedActivity: () => Effect.void,
        }),
      ),
    ).rejects.toThrow("escapes the copied Linx home");
    expect(engine.dispatch).not.toHaveBeenCalled();
    expect(
      JSON.parse(await fs.readFile(path.join(input.homePath, "linx-home-migration.json"), "utf8"))
        .status,
    ).toBe("paths-pending");
    expect(await fs.readdir(external)).toEqual([]);
  });
  it.each(["missing", "invalid", "complete"] as const)(
    "does not settle native startup activity for a %s receipt",
    async (state) => {
      const input = await fixture();
      const receiptPath = path.join(input.homePath, "linx-home-migration.json");
      if (state === "missing") {
        await fs.rm(receiptPath);
        await fs.rm(`${input.homePath}.linx-migration.json`);
      } else {
        const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
        await fs.writeFile(
          receiptPath,
          JSON.stringify(
            state === "complete"
              ? { ...receipt, status: "complete" }
              : { ...receipt, sourceHomePath: null },
          ),
        );
      }
      const migrate = vi.fn(() => Effect.void);
      const settle = vi.fn(() => Effect.void);
      const result = Effect.runPromise(
        completeLinxHomeMigration({
          homePath: input.homePath,
          engine: {} as OrchestrationEngineShape,
          migrateProviderBindings: migrate,
          settleOrphanedActivity: settle,
        }),
      );
      if (state === "invalid")
        await expect(result).rejects.toThrow("Invalid Linx migration receipt");
      else await result;
      expect(migrate).not.toHaveBeenCalled();
      expect(settle).not.toHaveBeenCalled();
    },
  );
  it("replays after an interrupted durable receipt write without treating stale temporary evidence as authority", async () => {
    const input = await fixture();
    const receiptPath = path.join(input.homePath, "linx-home-migration.json");
    await fs.writeFile(`${receiptPath}.completing`, '{"status":"complete","truncated":');
    const engine = {
      getProjectionCatchUpStatus: Effect.succeed({ state: "healthy", inFlight: false }),
      getReadModel: () => Effect.succeed({ projects: [], threads: [] }),
      drain: Effect.void,
      dispatch: vi.fn(),
    } as unknown as OrchestrationEngineShape;
    await Effect.runPromise(
      completeLinxHomeMigration({
        homePath: input.homePath,
        engine,
        migrateProviderBindings,
        settleOrphanedActivity: () => Effect.void,
      }),
    );
    expect(JSON.parse(await fs.readFile(receiptPath, "utf8")).status).toBe("complete");
    expect(await fs.readFile(`${receiptPath}.completing`, "utf8")).toContain("truncated");
  });
  it("replays only remaining native path commands after a partial dispatch interruption", async () => {
    const input = await fixture();
    const project = {
      id: ProjectId.makeUnsafe("managed"),
      workspaceRoot: "/external/primary",
      additionalFolders: [path.join(input.sourceHomePath, "extra"), "/external/extra"],
    };
    const thread = {
      id: ThreadId.makeUnsafe("thread"),
      worktreePath: path.join(input.sourceHomePath, "worktrees", "a"),
    };
    const model = { projects: [project], threads: [thread] } as unknown as OrchestrationReadModel;
    const commands: OrchestrationCommand[] = [];
    let interrupt = true;
    const engine = {
      getProjectionCatchUpStatus: Effect.succeed({ state: "healthy", inFlight: false }),
      getReadModel: () => Effect.succeed(model),
      drain: Effect.void,
      dispatch: (command: OrchestrationCommand) => {
        commands.push(command);
        if (command.type === "thread.meta.update" && interrupt) {
          interrupt = false;
          return Effect.fail(new Error("interrupted before thread command"));
        }
        if (command.type === "project.meta.update" && command.workspaceRoot)
          project.workspaceRoot = command.workspaceRoot;
        if (command.type === "project.meta.update" && command.additionalFolders)
          project.additionalFolders = [...command.additionalFolders];
        if (command.type === "thread.meta.update" && command.worktreePath)
          thread.worktreePath = command.worktreePath;
        return Effect.succeed({ sequence: commands.length });
      },
    } as unknown as OrchestrationEngineShape;
    await expect(
      Effect.runPromise(
        completeLinxHomeMigration({
          homePath: input.homePath,
          engine,
          migrateProviderBindings,
          settleOrphanedActivity: () => Effect.void,
        }),
      ),
    ).rejects.toThrow("interrupted");
    expect(
      JSON.parse(await fs.readFile(path.join(input.homePath, "linx-home-migration.json"), "utf8"))
        .status,
    ).toBe("paths-pending");
    await Effect.runPromise(
      completeLinxHomeMigration({
        homePath: input.homePath,
        engine,
        migrateProviderBindings,
        settleOrphanedActivity: () => Effect.void,
      }),
    );
    expect(commands.map((command) => command.type)).toEqual([
      "project.meta.update",
      "thread.meta.update",
      "thread.meta.update",
    ]);
    expect(commands[1]!.commandId).toBe(commands[2]!.commandId);
    expect(thread.worktreePath).toBe(path.join(input.homePath, "worktrees", "a"));
    expect(project.workspaceRoot).toBe("/external/primary");
    expect(project.additionalFolders).toEqual([
      path.join(input.homePath, "extra"),
      "/external/extra",
    ]);
  });
  it("does not mark unknown projection health complete", async () => {
    const input = await fixture();
    const engine = {
      getProjectionCatchUpStatus: Effect.succeed({ state: "unknown", inFlight: false }),
    } as unknown as OrchestrationEngineShape;
    await expect(
      Effect.runPromise(
        completeLinxHomeMigration({
          homePath: input.homePath,
          engine,
          migrateProviderBindings,
          settleOrphanedActivity: () => Effect.void,
        }),
      ),
    ).rejects.toThrow("healthy");
    expect(
      JSON.parse(await fs.readFile(path.join(input.homePath, "linx-home-migration.json"), "utf8"))
        .status,
    ).toBe("paths-pending");
  });
  it("keeps the receipt pending and producers unpublished until live continuation writes succeed", async () => {
    const input = await fixture();
    const engine = {
      getProjectionCatchUpStatus: Effect.succeed({ state: "healthy", inFlight: false }),
      getReadModel: () => Effect.succeed({ projects: [], threads: [] }),
      drain: Effect.void,
      dispatch: vi.fn(),
    } as unknown as OrchestrationEngineShape;
    const migrate = vi.fn(() => Effect.fail(new Error("binding write interrupted")));
    await expect(
      Effect.runPromise(
        completeLinxHomeMigration({
          homePath: input.homePath,
          engine,
          migrateProviderBindings: migrate,
          settleOrphanedActivity: () => Effect.void,
        }),
      ),
    ).rejects.toThrow("binding write interrupted");
    expect(
      JSON.parse(await fs.readFile(path.join(input.homePath, "linx-home-migration.json"), "utf8"))
        .status,
    ).toBe("paths-pending");
    expect(engine.dispatch).not.toHaveBeenCalled();
    expect(migrate).toHaveBeenCalledWith({
      sourceHomePath: input.sourceHomePath,
      homePath: input.homePath,
    });
    await Effect.runPromise(
      completeLinxHomeMigration({
        homePath: input.homePath,
        engine,
        migrateProviderBindings,
        settleOrphanedActivity: () => Effect.void,
      }),
    );
    expect(
      JSON.parse(await fs.readFile(path.join(input.homePath, "linx-home-migration.json"), "utf8"))
        .status,
    ).toBe("complete");
  });
  it("settles orphaned activity after binding repair and before reading the live model", async () => {
    const input = await fixture();
    const order: string[] = [];
    const engine = {
      getProjectionCatchUpStatus: Effect.succeed({ state: "healthy", inFlight: false }),
      getReadModel: () =>
        Effect.sync(() => {
          order.push("read");
          return { projects: [], threads: [] };
        }),
      drain: Effect.sync(() => {
        order.push("drain");
      }),
      dispatch: vi.fn(),
    } as unknown as OrchestrationEngineShape;
    const settleOrphanedActivity = vi.fn((paths: { sourceHomePath: string; homePath: string }) =>
      Effect.sync(() => {
        expect(paths).toEqual({
          sourceHomePath: input.sourceHomePath,
          homePath: input.homePath,
        });
        order.push("settle");
      }),
    );
    const complete = completeLinxHomeMigration({
      homePath: input.homePath,
      engine,
      migrateProviderBindings: () =>
        Effect.sync(() => {
          order.push("bindings");
        }),
      settleOrphanedActivity,
    });
    await Effect.runPromise(complete);
    expect(order).toEqual(["bindings", "settle", "drain", "read", "drain"]);
    await Effect.runPromise(complete);
    expect(settleOrphanedActivity).toHaveBeenCalledTimes(1);
  });
  it("keeps the receipt pending when orphan settlement fails, then retries before metadata admission", async () => {
    const input = await fixture();
    const receiptPath = path.join(input.homePath, "linx-home-migration.json");
    const engine = {
      getProjectionCatchUpStatus: Effect.succeed({ state: "healthy", inFlight: false }),
      getReadModel: vi.fn(() => Effect.succeed({ projects: [], threads: [] })),
      drain: Effect.void,
      dispatch: vi.fn(),
    } as unknown as OrchestrationEngineShape;
    const settleOrphanedActivity = vi.fn(() => Effect.fail(new Error("restart interrupted")));
    await expect(
      Effect.runPromise(
        completeLinxHomeMigration({
          homePath: input.homePath,
          engine,
          migrateProviderBindings,
          settleOrphanedActivity,
        }),
      ),
    ).rejects.toThrow("restart interrupted");
    expect(engine.getReadModel).not.toHaveBeenCalled();
    expect(engine.dispatch).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(receiptPath, "utf8")).status).toBe("paths-pending");
    await Effect.runPromise(
      completeLinxHomeMigration({
        homePath: input.homePath,
        engine,
        migrateProviderBindings,
        settleOrphanedActivity: () => Effect.void,
      }),
    );
    expect(JSON.parse(await fs.readFile(receiptPath, "utf8")).status).toBe("complete");
  });
  it("repairs native Git linked-worktree registrations while preserving ignored and staged files", async () => {
    const input = await fixture();
    const repository = path.join(input.root, "external-project");
    await fs.mkdir(repository);
    const run = async (cwd: string, args: string[]) =>
      (await git("git", ["-C", cwd, ...args], { timeout: 30_000 })).stdout.trim();
    await run(repository, ["init", "-b", "main"]);
    await run(repository, ["config", "user.name", "Fixture"]);
    await run(repository, ["config", "user.email", "fixture@example.invalid"]);
    await fs.writeFile(path.join(repository, "tracked"), "base");
    await run(repository, ["add", "tracked"]);
    await run(repository, ["commit", "-m", "fixture"]);
    const oldWorktree = path.join(input.sourceHomePath, "worktrees", "thread");
    await run(repository, ["worktree", "add", "-b", "fixture-thread", oldWorktree]);
    await fs.writeFile(path.join(oldWorktree, "tracked"), "staged unique data");
    await run(oldWorktree, ["add", "tracked"]);
    await fs.writeFile(path.join(oldWorktree, ".gitignore"), "ignored.secret\n");
    await fs.writeFile(path.join(oldWorktree, "ignored.secret"), "unique ignored data");
    await fs.cp(
      path.join(input.sourceHomePath, "worktrees"),
      path.join(input.homePath, "worktrees"),
      { recursive: true },
    );
    await repairLinxManagedWorktrees(input);
    const newWorktree = path.join(input.homePath, "worktrees", "thread");
    expect(await run(newWorktree, ["rev-parse", "--show-toplevel"])).toBe(
      await fs.realpath(newWorktree),
    );
    expect(await run(newWorktree, ["show", ":tracked"])).toBe("staged unique data");
    expect(await fs.readFile(path.join(newWorktree, "ignored.secret"), "utf8")).toBe(
      "unique ignored data",
    );
    const registrations = await run(repository, ["worktree", "list", "--porcelain"]);
    expect(registrations).toContain(`worktree ${await fs.realpath(newWorktree)}`);
    expect(registrations).not.toContain(`worktree ${await fs.realpath(oldWorktree)}`);
    expect(await fs.readFile(path.join(repository, "tracked"), "utf8")).toBe("base");
    await repairLinxManagedWorktrees(input); // Idempotent after interruption.
  });
  it("refuses forged worktree pointers instead of repairing an unrelated registration", async () => {
    const input = await fixture();
    const worktree = path.join(input.homePath, "worktrees", "forged");
    await fs.mkdir(worktree, { recursive: true });
    await fs.writeFile(path.join(worktree, ".git"), "gitdir: /unrelated/metadata\n");
    await expect(repairLinxManagedWorktrees(input)).rejects.toThrow();
  });
});
