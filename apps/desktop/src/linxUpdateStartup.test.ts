import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinxUpdateHealthRequest, LinxUpdateInstallJournal } from "@synara/contracts";

const seams = vi.hoisted(() => ({ adopt: vi.fn(), spawn: vi.fn(), sync: vi.fn(), write: vi.fn() }));
vi.mock("@synara/shared/linxUpdateHomeOwnership", () => ({ adoptLinxHomeOwnership: seams.adopt }));
vi.mock("@synara/shared/processRuntime", () => ({
  spawnProcess: seams.spawn,
  spawnProcessSync: seams.sync,
}));
vi.mock("./linxUpdateController", () => ({ writeLinxPrivateJson: seams.write }));
import {
  claimLinxUpdateStartup,
  findLinxUpdateStartupAttempt,
  readLinxPrivateJson,
} from "./linxUpdateStartup";

const roots: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  seams.write.mockImplementation(async (file: string, value: unknown) => {
    await fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
  });
  seams.adopt.mockResolvedValue({ nonce: "b".repeat(64), transfer: vi.fn(), release: vi.fn() });
  vi.spyOn(process, "kill").mockImplementation(() => true);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "linx-startup-")));
  roots.push(root);
  await fs.chmod(root, 0o700);
  const attemptsPath = join(root, "attempts");
  await fs.mkdir(attemptsPath, { mode: 0o700 });
  const attemptId = randomUUID();
  const attemptPath = join(attemptsPath, attemptId);
  await fs.mkdir(attemptPath, { mode: 0o700 });
  const bindings = {
    homePath: join(root, "home"),
    userDataPath: join(root, "profile"),
    applicationPath: join(root, "Linx.app"),
    version: "0.1.16",
  };
  for (const directory of [bindings.homePath, bindings.userDataPath, bindings.applicationPath]) {
    await fs.mkdir(directory, { mode: 0o700 });
  }
  await fs.writeFile(join(bindings.homePath, "original-data"), "preserve all original bytes", {
    mode: 0o600,
  });
  const request: LinxUpdateHealthRequest = {
    schemaVersion: 1,
    attemptId,
    manifestDigest: "a".repeat(64),
    nonce: "b".repeat(64),
    helperPid: 919191,
    ...bindings,
    sourceCommit: "c".repeat(40),
    createdAt: new Date().toISOString(),
  };
  const journal: LinxUpdateInstallJournal = {
    schemaVersion: 1,
    attemptId,
    fromVersion: "0.1.15",
    toVersion: bindings.version,
    manifestDigest: request.manifestDigest,
    packageSha256: "d".repeat(64),
    applicationPath: bindings.applicationPath,
    homePath: bindings.homePath,
    userDataPath: bindings.userDataPath,
    retainedApplicationPath: join(root, `.linx-retained-${attemptId}.app`),
    recoveryDirectoryPath: join(attemptPath, "recovery"),
    phase: "awaiting-health",
    requestedAt: request.createdAt,
    updatedAt: request.createdAt,
    mayHaveWrittenData: true,
    message: null,
  };
  const journalPath = join(attemptPath, "linx-update-install.json");
  await fs.writeFile(journalPath, JSON.stringify(journal), { mode: 0o600 });
  seams.sync.mockImplementation((_command: string, args: string[]) => ({
    status: 0,
    error: undefined,
    stdout: args[0] === "--validate-startup" ? JSON.stringify({ request, journal }) : "",
  }));
  return { root, attemptsPath, attemptPath, bindings, request, journal, journalPath };
}

describe("pre-data durable journal/version-floor gate", () => {
  it("blocks an older binary even if a risky newer journal is terminal", async () => {
    const f = await fixture();
    await fs.writeFile(f.journalPath, JSON.stringify({ ...f.journal, phase: "healthy" }));
    await expect(
      findLinxUpdateStartupAttempt({
        ...f.bindings,
        version: "0.1.15",
        attemptsPath: f.attemptsPath,
        arguments: [],
      }),
    ).rejects.toThrow("newer application");
    expect(seams.adopt).not.toHaveBeenCalled();
  });
  it("selects only the same new version for independent helper-death recovery", async () => {
    const f = await fixture();
    await fs.writeFile(f.journalPath, JSON.stringify({ ...f.journal, phase: "recovery-required" }));
    await expect(
      findLinxUpdateStartupAttempt({ ...f.bindings, attemptsPath: f.attemptsPath, arguments: [] }),
    ).resolves.toBe(f.attemptPath);
    await expect(
      findLinxUpdateStartupAttempt({
        ...f.bindings,
        version: "0.1.17",
        attemptsPath: f.attemptsPath,
        arguments: [],
      }),
    ).rejects.toThrow("requires recovery");
  });
  it("rejects explicit foreign attempt arguments and unsafe attempt-root links", async () => {
    const f = await fixture();
    await expect(
      findLinxUpdateStartupAttempt({
        ...f.bindings,
        attemptsPath: f.attemptsPath,
        arguments: ["--linx-update-attempt", "/other"],
      }),
    ).rejects.toThrow("not the durable");
    const link = join(f.root, "attempt-link");
    await fs.symlink(f.attemptsPath, link);
    await expect(
      findLinxUpdateStartupAttempt({ ...f.bindings, attemptsPath: link, arguments: [] }),
    ).rejects.toThrow("Unsafe update attempt root");
  });
  it("refuses private-record symlinks and oversized bytes", async () => {
    const f = await fixture();
    const link = join(f.attemptPath, "linked.json");
    await fs.symlink(f.journalPath, link);
    await expect(readLinxPrivateJson(link)).rejects.toThrow("Unsafe private");
    await fs.writeFile(f.journalPath, "x".repeat(64 * 1024 + 1));
    await expect(readLinxPrivateJson(f.journalPath)).rejects.toThrow("Unsafe private");
  });
});

describe("authenticated bootstrap ownership and durable health", () => {
  it("adopts only an exact private grant and waits for the helper's durable healthy journal", async () => {
    const f = await fixture();
    await fs.writeFile(join(f.attemptPath, "health-ownership.json"), JSON.stringify(f.request), {
      mode: 0o600,
    });
    const health = await claimLinxUpdateStartup({
      ...f.bindings,
      attemptPath: f.attemptPath,
      sourceCommit: f.request.sourceCommit,
      helperPath: "/fixture/helper",
    });
    expect(seams.adopt).toHaveBeenCalledWith({ ...f.bindings, nonce: f.request.nonce });
    expect(seams.spawn).not.toHaveBeenCalled();
    await expect(
      health.complete({
        backendReady: true,
        clientConnected: false,
        homePath: f.bindings.homePath,
        sourceCommit: f.request.sourceCommit,
      }),
    ).rejects.toThrow("not proven");
    await fs.writeFile(f.journalPath, JSON.stringify({ ...f.journal, phase: "healthy" }));
    await expect(
      health.complete({
        backendReady: true,
        clientConnected: true,
        homePath: f.bindings.homePath,
        sourceCommit: f.request.sourceCommit,
      }),
    ).resolves.toBeUndefined();
    expect(await readLinxPrivateJson(join(f.attemptPath, "health-proof.json"))).toMatchObject({
      phase: "healthy",
      pid: process.pid,
      nonce: f.request.nonce,
    });
  });

  it("rejects an ownership file from another nonce before any home adoption", async () => {
    const f = await fixture();
    await fs.writeFile(
      join(f.attemptPath, "health-ownership.json"),
      JSON.stringify({ ...f.request, nonce: "e".repeat(64) }),
      { mode: 0o600 },
    );
    await expect(
      claimLinxUpdateStartup({
        ...f.bindings,
        attemptPath: f.attemptPath,
        sourceCommit: f.request.sourceCommit,
        helperPath: "/fixture/helper",
      }),
    ).rejects.toThrow("does not match");
    expect(seams.adopt).not.toHaveBeenCalled();
  });

  it("requests a long-lived recovery helper with fresh nonce after proven old-helper death", async () => {
    const f = await fixture();
    const fresh = { ...f.request, nonce: "e".repeat(64), helperPid: 929292 };
    vi.mocked(process.kill).mockImplementation(((pid: number) => {
      if (pid === f.request.helperPid) throw Object.assign(new Error("dead"), { code: "ESRCH" });
      return true;
    }) as typeof process.kill);
    seams.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        pid: fresh.helperPid,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      queueMicrotask(() => {
        void fs
          .writeFile(join(f.attemptPath, "health-ownership.json"), JSON.stringify(fresh), {
            mode: 0o600,
          })
          .then(() => {
            child.stdout.write(`${JSON.stringify({ request: fresh, journal: f.journal })}\n`);
          });
      });
      return child;
    });
    await claimLinxUpdateStartup({
      ...f.bindings,
      attemptPath: f.attemptPath,
      sourceCommit: fresh.sourceCommit,
      helperPath: "/fixture/helper",
    });
    expect(seams.spawn).toHaveBeenCalledWith(
      "/fixture/helper",
      ["--resume-startup", f.attemptPath, String(process.pid)],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(seams.adopt).toHaveBeenCalledWith({ ...f.bindings, nonce: fresh.nonce });
  });

  it("preserves original data and refuses optimistic completion if the helper dies after adoption", async () => {
    const f = await fixture();
    await fs.writeFile(join(f.attemptPath, "health-ownership.json"), JSON.stringify(f.request), {
      mode: 0o600,
    });
    const health = await claimLinxUpdateStartup({
      ...f.bindings,
      attemptPath: f.attemptPath,
      sourceCommit: f.request.sourceCommit,
      helperPath: "/fixture/helper",
    });
    vi.mocked(process.kill).mockImplementation(() => {
      throw Object.assign(new Error("dead"), { code: "ESRCH" });
    });
    await expect(
      health.complete({
        backendReady: true,
        clientConnected: true,
        homePath: f.bindings.homePath,
        sourceCommit: f.request.sourceCommit,
      }),
    ).rejects.toThrow("durably acknowledge");
    expect(await fs.readFile(join(f.bindings.homePath, "original-data"), "utf8")).toBe(
      "preserve all original bytes",
    );
    expect(await readLinxPrivateJson(f.journalPath)).toMatchObject({
      phase: "awaiting-health",
      mayHaveWrittenData: true,
    });
    expect(seams.spawn).not.toHaveBeenCalled();
  });

  it("never resumes or steals ownership when helper death is uncertain", async () => {
    const f = await fixture();
    vi.mocked(process.kill).mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    await expect(
      claimLinxUpdateStartup({
        ...f.bindings,
        attemptPath: f.attemptPath,
        sourceCommit: f.request.sourceCommit,
        helperPath: "/fixture/helper",
      }),
    ).rejects.toThrow("liveness is unknown");
    expect(seams.spawn).not.toHaveBeenCalled();
    expect(seams.adopt).not.toHaveBeenCalled();
  });
});
