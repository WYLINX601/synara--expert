import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireLinxHomeOwnership,
  adoptLinxHomeOwnership,
  joinLinxHomeOwnershipForServer,
} from "./linxUpdateHomeOwnership";
import { LINX_HOME_OWNERSHIP_NONCE_ENV } from "@synara/contracts";

const temporary: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill();
      await exit;
    }
  }
  await Promise.all(
    temporary.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "linx-home-owner-"));
  temporary.push(root);
  const applicationPath = path.join(root, "Linx.app");
  await fs.mkdir(applicationPath, { mode: 0o755 });
  return {
    root,
    homePath: path.join(root, ".linx"),
    userDataPath: path.join(root, "profile"),
    applicationPath,
    version: "0.1.15",
  };
}
const recordPath = (homePath: string) => path.join(`${homePath}.linx-owner`, "owner.json");

describe("continuous Linx home/profile ownership", () => {
  it("exclusively owns both roots without populating empty migration targets or storing raw grants", async () => {
    const input = await fixture();
    const lease = await acquireLinxHomeOwnership(input);
    await expect(acquireLinxHomeOwnership(input)).rejects.toThrow("owner is live");
    const text = await fs.readFile(recordPath(input.homePath), "utf8");
    expect(text).not.toContain(lease.nonce);
    expect(JSON.parse(text)).toMatchObject({
      homePath: (await fs.realpath(input.root)) + "/.linx",
      adopted: true,
    });
    expect((await fs.stat(recordPath(input.homePath))).mode & 0o777).toBe(0o600);
    await expect(fs.stat(input.homePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(input.userDataPath)).rejects.toMatchObject({ code: "ENOENT" });
    await lease.release();
    await expect(
      joinLinxHomeOwnershipForServer({ homePath: input.homePath, parentPid: process.ppid }),
    ).rejects.toThrow("ephemeral");
    const next = await acquireLinxHomeOwnership(input);
    await next.release();
  });
  it("transfers a generation with no unlock window, adopts once, and invalidates the old release handle", async () => {
    const input = await fixture();
    const original = await acquireLinxHomeOwnership(input);
    const nonce = randomBytes(32).toString("hex");
    await original.transfer({ pid: process.pid, nonce, version: "0.1.16" });
    await expect(original.release()).rejects.toThrow("Stale");
    await expect(acquireLinxHomeOwnership({ ...input, version: "0.1.16" })).rejects.toThrow("live");
    await expect(
      adoptLinxHomeOwnership({
        ...input,
        version: "0.1.16",
        nonce: randomBytes(32).toString("hex"),
      }),
    ).rejects.toThrow("grant");
    const adopted = await adoptLinxHomeOwnership({ ...input, version: "0.1.16", nonce });
    await expect(adoptLinxHomeOwnership({ ...input, version: "0.1.16", nonce })).rejects.toThrow(
      "already adopted",
    );
    await adopted.release();
  });
  it("never lowers the version floor through a transfer and leaves the original handle usable after refusal", async () => {
    const input = await fixture();
    const original = await acquireLinxHomeOwnership({ ...input, version: "0.1.16-preview.10" });
    for (const version of ["0.1.16-preview.9", "0.1.15", "invalid"]) {
      await expect(
        original.transfer({ pid: process.pid, nonce: randomBytes(32).toString("hex"), version }),
      ).rejects.toThrow("version floor");
    }
    expect(JSON.parse(await fs.readFile(recordPath(input.homePath), "utf8")).version).toBe(
      "0.1.16-preview.10",
    );
    const nonce = randomBytes(32).toString("hex");
    await original.transfer({ pid: process.pid, nonce, version: "0.1.16" });
    const adopted = await adoptLinxHomeOwnership({ ...input, version: "0.1.16", nonce });
    await adopted.release();
    await expect(acquireLinxHomeOwnership(input)).rejects.toThrow("version floor");
  });
  it("preserves every live prior cohort across transfer, adoption and release", async () => {
    const input = await fixture();
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: "pipe" });
    children.push(child);
    await once(child, "spawn");
    const original = await acquireLinxHomeOwnership(input);
    const file = recordPath(input.homePath);
    const record = JSON.parse(await fs.readFile(file, "utf8"));
    const member = {
      id: randomUUID(),
      role: "cohort",
      process: { pid: child.pid, startedAt: "retained prior cohort" },
      joinedGeneration: record.generation,
    };
    await fs.writeFile(file, JSON.stringify({ ...record, members: [member] }));
    const nonce = randomBytes(32).toString("hex");
    await original.transfer({ pid: process.pid, nonce, version: input.version });
    const adopted = await adoptLinxHomeOwnership({ ...input, nonce });
    await adopted.release();
    expect(JSON.parse(await fs.readFile(file, "utf8")).members).toEqual([member]);
    await expect(acquireLinxHomeOwnership(input)).rejects.toThrow("cohort member");
    const exit = once(child, "exit");
    child.kill();
    await exit;
    const recovered = await acquireLinxHomeOwnership(input);
    await recovered.release();
  });
  it("rejects readable-by-others grant metadata without silently chmodding or replacing it", async () => {
    const input = await fixture();
    const original = await acquireLinxHomeOwnership(input);
    const file = recordPath(input.homePath);
    await fs.chmod(file, 0o644);
    await expect(original.release()).rejects.toThrow("must be private");
    expect((await fs.stat(file)).mode & 0o777).toBe(0o644);
    await fs.chmod(file, 0o600);
    await original.release();
  });
  it("binds adoption to exact roots, version, profile and application", async () => {
    const input = await fixture();
    const original = await acquireLinxHomeOwnership(input);
    const nonce = randomBytes(32).toString("hex");
    await original.transfer({ pid: process.pid, nonce, version: "0.1.16" });
    await expect(adoptLinxHomeOwnership({ ...input, nonce })).rejects.toThrow("binding mismatch");
    await expect(
      adoptLinxHomeOwnership({
        ...input,
        version: "0.1.16",
        userDataPath: path.join(input.root, "other-profile"),
        nonce,
      }),
    ).rejects.toThrow("binding mismatch");
    const adopted = await adoptLinxHomeOwnership({ ...input, version: "0.1.16", nonce });
    await adopted.release();
  });
  it("refuses PID-reuse-shaped records and dead owners with any live cohort", async () => {
    const input = await fixture();
    const lease = await acquireLinxHomeOwnership(input);
    const file = recordPath(input.homePath);
    const record = JSON.parse(await fs.readFile(file, "utf8"));
    await fs.writeFile(
      file,
      JSON.stringify({
        ...record,
        owner: { pid: process.pid, startedAt: "a different process start" },
      }),
    );
    await expect(acquireLinxHomeOwnership(input)).rejects.toThrow("live, reused-PID");
    await fs.writeFile(
      file,
      JSON.stringify({
        ...record,
        owner: null,
        nonceDigest: null,
        adopted: false,
        members: [
          {
            id: randomUUID(),
            role: "cohort",
            process: record.owner,
            joinedGeneration: record.generation,
          },
        ],
      }),
    );
    await expect(acquireLinxHomeOwnership(input)).rejects.toThrow("cohort member");
    await fs.writeFile(file, JSON.stringify(record));
    await lease.release();
  });
  it("recovers a dead owner only after its registered members are dead", async () => {
    const input = await fixture();
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: "pipe" });
    children.push(child);
    await once(child, "spawn");
    const original = await acquireLinxHomeOwnership(input);
    await original.transfer({
      pid: child.pid!,
      nonce: randomBytes(32).toString("hex"),
      version: "0.1.16",
    });
    const file = recordPath(input.homePath);
    const transferred = JSON.parse(await fs.readFile(file, "utf8"));
    const exit = once(child, "exit");
    child.kill();
    await exit;
    await expect(acquireLinxHomeOwnership({ ...input, version: "0.1.16" })).rejects.toThrow(
      "cohort member",
    );
    // Remove the now-explicitly-retired old owner cohort as an isolated recovery fixture.
    await fs.writeFile(file, JSON.stringify({ ...transferred, members: [] }));
    const recovered = await acquireLinxHomeOwnership({ ...input, version: "0.1.16" });
    await recovered.release();
  });
  it("rejects symlink/private-permission attacks and corrupt owner metadata", async () => {
    const input = await fixture();
    const alias = path.join(input.root, "alias");
    await fs.mkdir(input.homePath);
    await fs.symlink(input.homePath, alias);
    await expect(acquireLinxHomeOwnership({ ...input, homePath: alias })).rejects.toThrow(
      "real data directory",
    );
    await fs.chmod(input.homePath, 0o777);
    await expect(acquireLinxHomeOwnership(input)).rejects.toThrow("Unsafe ownership");
    await fs.chmod(input.homePath, 0o700);
    const lease = await acquireLinxHomeOwnership(input);
    const original = await fs.readFile(recordPath(input.homePath), "utf8");
    await fs.writeFile(recordPath(input.homePath), "{broken");
    await expect(lease.release()).rejects.toThrow();
    await fs.writeFile(recordPath(input.homePath), original);
    await lease.release();
  });
  it("preserves unguarded non-Linx CLI behavior but refuses first-use Linx and missing/mismatched grants", async () => {
    const input = await fixture();
    expect(
      await joinLinxHomeOwnershipForServer({
        homePath: path.join(input.root, "native-home"),
        parentPid: process.ppid,
      }),
    ).toBeNull();
    await expect(
      joinLinxHomeOwnershipForServer({ homePath: input.homePath, parentPid: process.ppid }),
    ).rejects.toThrow("before first use");
    const lease = await acquireLinxHomeOwnership(input);
    await expect(
      joinLinxHomeOwnershipForServer({ homePath: input.homePath, parentPid: process.ppid }),
    ).rejects.toThrow("ephemeral");
    await expect(
      joinLinxHomeOwnershipForServer({
        homePath: input.homePath,
        parentPid: process.ppid,
        nonce: randomBytes(32).toString("hex"),
      }),
    ).rejects.toThrow("mismatched");
    await lease.release();
  });
  it("registers a real granted backend process and prevents transfer until that member exits/releases", async () => {
    const input = await fixture();
    const lease = await acquireLinxHomeOwnership(input);
    const script = fileURLToPath(new URL("./fixtures/linxHomeOwnershipServer.ts", import.meta.url));
    const child = spawn("bun", [script, input.homePath], {
      stdio: "pipe",
      env: { ...process.env, [LINX_HOME_OWNERSHIP_NONCE_ENV]: lease.nonce },
    });
    children.push(child);
    let output = "";
    const joined = new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (output.includes("joined\n")) resolve();
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (!output.includes("joined\n")) reject(new Error(`Backend fixture exited ${code}`));
      });
    });
    await joined;
    expect(JSON.parse(await fs.readFile(recordPath(input.homePath), "utf8")).members).toHaveLength(
      1,
    );
    await expect(
      lease.transfer({
        pid: process.pid,
        nonce: randomBytes(32).toString("hex"),
        version: "0.1.16",
      }),
    ).rejects.toThrow("cohort member");
    const exit = once(child, "exit");
    child.stdin.end();
    await exit;
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(await fs.readFile(recordPath(input.homePath), "utf8")).members).toEqual([]);
    await lease.release();
  }, 30_000);
  it("preserves the recorded app-version floor across releases and Preview recovery", async () => {
    const input = await fixture();
    const lease = await acquireLinxHomeOwnership({ ...input, version: "0.1.0-preview.10" });
    await lease.release();
    await expect(
      acquireLinxHomeOwnership({ ...input, version: "0.1.0-preview.9" }),
    ).rejects.toThrow("version floor");
    const next = await acquireLinxHomeOwnership({ ...input, version: "0.1.0" });
    await next.release();
    await expect(
      acquireLinxHomeOwnership({ ...input, version: "0.1.0-preview.999" }),
    ).rejects.toThrow("version floor");
    const equal = await acquireLinxHomeOwnership({ ...input, version: "0.1.0" });
    await equal.release();
  });
});
