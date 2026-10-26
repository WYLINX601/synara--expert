import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  getOrCreateManagementRequestEnvelope,
  ManagementCliRequestIdConflictError,
} from "./requestEnvelope";

const roots: string[] = [];

async function makeBaseDir(): Promise<string> {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "synara-management-envelope-"));
  roots.push(baseDir);
  await fs.mkdir(path.join(baseDir, "management-cli"), { mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(path.join(baseDir, "management-cli"), 0o700);
  return baseDir;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.chmod(path.join(root, "management-cli"), 0o700).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("management CLI request envelopes", () => {
  it("persists the original CAS request and returns it unchanged on retry", async () => {
    const baseDir = await makeBaseDir();
    const scope = {
      credentialId: "credential-test",
      instanceId: "instance-test",
      flavor: "development" as const,
    };
    let builds = 0;
    const first = await getOrCreateManagementRequestEnvelope({
      baseDir,
      scope,
      requestId: "stable-request",
      intentHash: "a".repeat(64),
      buildRequest: async () => {
        builds += 1;
        return {
          action: "save",
          skillId: "skl_0123456789abcdef0123456789abcdef",
          expectedRevision: 4,
          name: "stable",
          tags: [],
          changes: [{ path: "SKILL.md", content: "SGVsbG8=" }],
          requestId: "stable-request",
        };
      },
    });
    const retry = await getOrCreateManagementRequestEnvelope({
      baseDir,
      scope,
      requestId: "stable-request",
      intentHash: "a".repeat(64),
      buildRequest: async () => {
        builds += 1;
        return {
          action: "save",
          skillId: "skl_0123456789abcdef0123456789abcdef",
          expectedRevision: 5,
          name: "stable",
          tags: [],
          changes: [{ path: "SKILL.md", content: "SGVsbG8=" }],
          requestId: "stable-request",
        };
      },
    });
    expect(retry).toEqual(first);
    expect(retry).toMatchObject({ expectedRevision: 4 });
    expect(builds).toBe(1);
  });

  it("rejects reuse with changed command intent and serializes concurrent preparation", async () => {
    const baseDir = await makeBaseDir();
    const scope = {
      credentialId: "credential-test",
      instanceId: "instance-test",
      flavor: "development" as const,
    };
    let builds = 0;
    const buildRequest = async () => {
      builds += 1;
      return {
        action: "create",
        name: "one-skill",
        body: "---\nname: one-skill\n---\nBody\n",
        tags: [],
        requestId: "concurrent-request",
      };
    };
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        getOrCreateManagementRequestEnvelope({
          baseDir,
          scope,
          requestId: "concurrent-request",
          intentHash: "b".repeat(64),
          buildRequest,
        }),
      ),
    );
    expect(results[0]).toEqual(results[1]);
    expect(results[1]).toEqual(results[2]);
    expect(builds).toBe(1);

    await expect(
      getOrCreateManagementRequestEnvelope({
        baseDir,
        scope,
        requestId: "concurrent-request",
        intentHash: "c".repeat(64),
        buildRequest,
      }),
    ).rejects.toBeInstanceOf(ManagementCliRequestIdConflictError);
    expect(builds).toBe(1);
  });
});
