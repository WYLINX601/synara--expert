import { mkdtemp, rm } from "node:fs/promises";
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
  it("exposes the configured Expert connection's tool names and closes its client", async () => {
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

    await runtime.connections.save({
      id: "research",
      name: "Research connection",
      transport: { type: "stdio", command: "fixture-mcp", args: [], envFromHost: [] },
    });

    await expect(runtime.testConnection("research")).resolves.toEqual({
      tools: ["search", "read"],
    });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(client.close).toHaveBeenCalledTimes(1);
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
});
