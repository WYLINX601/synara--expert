import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { ThreadId, type ExpertAppliedRuntimeRecord } from "@synara/contracts";
import { Effect, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { connectExpertMcp } from "../experts/ExpertMcpClient.ts";
import { createWorkbenchExpertRuntime } from "./runtimeLayer.ts";

const temporaryRoots: string[] = [];

async function makeTempStateDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "synara-workbench-runtime-"));
  temporaryRoots.push(root);
  return path.join(root, "state");
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("createWorkbenchExpertRuntime", () => {
  it("tests a configured Expert connection with optional revision guarding", async () => {
    const stateDir = await makeTempStateDir();
    const client = {
      tools: [{ name: "search" }, { name: "read" }],
      close: vi.fn(async () => undefined),
    } as unknown as Awaited<ReturnType<typeof connectExpertMcp>>;
    const connect = vi.fn(async () => client);
    const runtime = createWorkbenchExpertRuntime({
      stateDir,
      expertAppliedRuntimeRepository: {
        getByThreadId: () => Effect.succeed(Option.none<ExpertAppliedRuntimeRecord>()),
      },
      connect,
    });

    const savedConnection = await runtime.connections.save({
      id: "research",
      name: "Research connection",
      transport: { type: "stdio", command: "fixture-mcp", args: [], envFromHost: [] },
    });

    await expect(runtime.testConnection({ id: "research" })).resolves.toEqual({
      tools: ["search", "read"],
      revision: savedConnection.revision,
    });
    await expect(
      runtime.testConnection({ id: "research", expectedRevision: savedConnection.revision + 1 }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect(connect).toHaveBeenCalledTimes(1);

    await expect(
      runtime.testConnection({ id: "research", expectedRevision: savedConnection.revision }),
    ).resolves.toEqual({ tools: ["search", "read"], revision: savedConnection.revision });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenNthCalledWith(2, savedConnection);
    expect(client.close).toHaveBeenCalledTimes(2);
  });

  it("delegates applied-runtime reads to the existing repository unchanged", async () => {
    const stateDir = await makeTempStateDir();
    const request = { threadId: ThreadId.makeUnsafe("thread-1") };
    const getByThreadId = vi.fn(() => Effect.succeed(Option.none<ExpertAppliedRuntimeRecord>()));
    const runtime = createWorkbenchExpertRuntime({
      stateDir,
      expertAppliedRuntimeRepository: { getByThreadId },
    });

    expect(Effect.runSync(runtime.readAppliedRuntime(request))).toEqual(Option.none());
    expect(getByThreadId).toHaveBeenCalledExactlyOnceWith(request);
  });

  it("wires local MCP discovery and import through the Workbench runtime", async () => {
    const stateDir = await makeTempStateDir();
    const sourcePath = path.join(path.dirname(stateDir), "mcp.json");
    await writeFile(sourcePath, JSON.stringify({ mcpServers: {} }), "utf8");
    const runtime = createWorkbenchExpertRuntime({
      stateDir,
      expertAppliedRuntimeRepository: {
        getByThreadId: () => Effect.succeed(Option.none<ExpertAppliedRuntimeRecord>()),
      },
    });

    const scan = await runtime.discoverMcpConnections({
      sources: [{ kind: "json", path: sourcePath }],
    });
    expect(scan).toMatchObject({
      scanId: expect.any(String),
      sources: [{ kind: "json", path: sourcePath, status: "ready" }],
      candidates: [],
    });
    await expect(runtime.importMcpConnections({ scanId: scan.scanId, items: [] })).resolves.toEqual(
      {
        scanId: scan.scanId,
        items: [],
      },
    );
  });
});
