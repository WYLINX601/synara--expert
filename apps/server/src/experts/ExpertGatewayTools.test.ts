import { chmod, lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { ExpertConnectionConfig, ExpertSaveInput } from "@synara/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createExpertConnectionStore } from "./ExpertConnectionStore.ts";
import { connectExpertMcp } from "./ExpertMcpClient.ts";
import { createExpertStore } from "./ExpertStore.ts";
import { makeExpertGatewayToolResolver, preflightExpertConnections } from "./ExpertGatewayTools.ts";

const temporaryRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "synara-expert-gateway-tools-"));
  temporaryRoots.push(root);
  return root;
}

async function unlockTree(entry: string): Promise<void> {
  await chmod(entry, 0o700).catch(() => undefined);
  for (const name of await readdir(entry).catch(() => [])) {
    const child = path.join(entry, name);
    const stat = await lstat(child);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) await unlockTree(child);
    else await chmod(child, 0o600).catch(() => undefined);
  }
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await unlockTree(root);
    await rm(root, { recursive: true, force: true });
  }
});

type FakeTool = Awaited<ReturnType<typeof connectExpertMcp>>["tools"][number];
type FakeCallTool = (
  name: string,
  args?: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

function fakeTool(name: string): FakeTool {
  return {
    name,
    description: `Description for ${name}`,
    inputSchema: { type: "object", properties: { value: { type: "string" } } },
    annotations: { readOnlyHint: true },
  };
}

function fakeClient<TCallTool extends FakeCallTool = FakeCallTool>(
  tools: ReadonlyArray<FakeTool>,
  callTool: TCallTool = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "ok" }],
  })) as unknown as TCallTool,
) {
  return {
    tools: [...tools],
    callTool,
    close: vi.fn(async () => undefined),
  };
}

async function makeScenario(
  connections: ExpertSaveInput["connections"],
  configuredIds: ReadonlyArray<string> = connections.map(({ id }) => id),
) {
  const root = await makeTempRoot();
  const stateDir = path.join(root, "state");
  const experts = createExpertStore(stateDir);
  const expert = await experts.save({
    id: "gateway-tools-test",
    name: "Gateway tools test",
    description: "Test expert tool isolation.",
    useCases: "Test Gateway MCP tool resolution.",
    persona: "Use only the configured tools.",
    outputRequirements: "Return concise results.",
    skills: [],
    references: [],
    connections,
  });
  const binding = await experts.prepareSnapshot(expert.id);
  const connectionStore = createExpertConnectionStore(stateDir);
  for (const id of configuredIds) {
    await connectionStore.save({
      id,
      name: `Connection ${id}`,
      transport: { type: "stdio", command: "fixture-mcp", args: [], envFromHost: [] },
    });
  }
  return { stateDir, snapshotId: binding.snapshotId };
}

describe("ExpertGatewayTools", () => {
  it("exposes only the snapshot allowlist and forwards calls with cancellation", async () => {
    const { stateDir, snapshotId } = await makeScenario([
      { id: "git", required: true, tools: ["review"] },
    ]);
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => (notifyStarted = resolve));
    let notifyCancelled!: () => void;
    const cancelled = new Promise<void>((resolve) => (notifyCancelled = resolve));
    const callTool = vi.fn(
      (_name: string, _args?: Record<string, unknown>, signal?: AbortSignal) =>
        new Promise<{ content: [{ type: "text"; text: string }] }>((resolve) => {
          notifyStarted();
          signal?.addEventListener(
            "abort",
            () => {
              notifyCancelled();
              resolve({ content: [{ type: "text", text: "cancelled" }] });
            },
            { once: true },
          );
        }),
    );
    const client = fakeClient([fakeTool("review"), fakeTool("push")], callTool);
    const resolver = makeExpertGatewayToolResolver({
      stateDir,
      connect: vi.fn(async () => client) as typeof connectExpertMcp,
    });

    const tools = await resolver.resolve("session-1", snapshotId);
    expect(tools.map(({ definition }) => definition.name)).toEqual(["expert_git_review"]);
    expect(tools[0]?.definition).toMatchObject({
      description: "Description for review",
      annotations: { readOnlyHint: true },
    });

    const controller = new AbortController();
    const pending = Effect.runPromise(tools[0]!.handler({ value: "diff" }, {} as never), {
      signal: controller.signal,
    });
    await started;
    expect(callTool).toHaveBeenCalledWith("review", { value: "diff" }, expect.any(AbortSignal));
    controller.abort();
    await cancelled;
    await expect(pending).rejects.toThrow();
    await resolver.closeAll();
  });

  it("fails preflight for a missing required connection or required tool", async () => {
    const missingConfig = await makeScenario(
      [{ id: "git", required: true, tools: ["review"] }],
      [],
    );
    await expect(
      preflightExpertConnections(
        await createExpertStore(missingConfig.stateDir).readSnapshot(missingConfig.snapshotId),
        { stateDir: missingConfig.stateDir, connect: vi.fn() as typeof connectExpertMcp },
      ),
    ).rejects.toThrow(/未配置/u);

    const missingTool = await makeScenario([{ id: "git", required: true, tools: ["review"] }]);
    const client = fakeClient([fakeTool("search")]);
    await expect(
      preflightExpertConnections(
        await createExpertStore(missingTool.stateDir).readSnapshot(missingTool.snapshotId),
        {
          stateDir: missingTool.stateDir,
          connect: vi.fn(async () => client) as typeof connectExpertMcp,
        },
      ),
    ).rejects.toThrow(/不可用/u);
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("reports optional connection failures while still resolving other tools", async () => {
    const { stateDir, snapshotId } = await makeScenario([
      { id: "required", required: true, tools: ["review"] },
      { id: "optional", required: false, tools: ["search"] },
    ]);
    const expertStore = createExpertStore(stateDir);
    const snapshot = await expertStore.readSnapshot(snapshotId);
    const requiredClient = fakeClient([fakeTool("review")]);
    const connect = vi.fn(async (config: ExpertConnectionConfig) => {
      if (config.id === "optional") throw new Error("fixture unavailable");
      return requiredClient;
    });

    const preflight = await preflightExpertConnections(snapshot, {
      stateDir,
      connect: connect as typeof connectExpertMcp,
    });
    expect(preflight.optionalIssues).toEqual(["可选连接“optional”当前不可用。"]);

    const resolver = makeExpertGatewayToolResolver({
      stateDir,
      connect: connect as typeof connectExpertMcp,
    });
    const tools = await resolver.resolve("session-optional", snapshotId);
    expect(tools.map(({ definition }) => definition.name)).toEqual(["expert_required_review"]);
    await resolver.closeAll();
  });

  it("returns a tool error when the downstream call fails", async () => {
    const { stateDir, snapshotId } = await makeScenario([
      { id: "git", required: true, tools: ["review"] },
    ]);
    const client = fakeClient(
      [fakeTool("review")],
      vi.fn(async () => {
        throw new Error("fixture failed");
      }),
    );
    const resolver = makeExpertGatewayToolResolver({
      stateDir,
      connect: vi.fn(async () => client) as typeof connectExpertMcp,
    });

    const tools = await resolver.resolve("session-error", snapshotId);
    await expect(
      Effect.runPromise(tools[0]!.handler({ value: "diff" }, {} as never)),
    ).resolves.toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Expert tool expert_git_review failed." }],
    });
    await resolver.closeAll();
  });

  it("caches a session catalog and closes then reconnects after revocation", async () => {
    const { stateDir, snapshotId } = await makeScenario([
      { id: "git", required: true, tools: ["review"] },
    ]);
    const clients = [fakeClient([fakeTool("review")]), fakeClient([fakeTool("review")])];
    let connectionIndex = 0;
    const connect = vi.fn(async () => clients[connectionIndex++]!);
    const resolver = makeExpertGatewayToolResolver({
      stateDir,
      connect: connect as typeof connectExpertMcp,
    });

    await resolver.resolve("session-cache", snapshotId);
    await resolver.resolve("session-cache", snapshotId);
    expect(connect).toHaveBeenCalledOnce();

    await resolver.closeSession("session-cache");
    expect(clients[0]?.close).toHaveBeenCalledOnce();
    await resolver.resolve("session-cache", snapshotId);
    expect(connect).toHaveBeenCalledTimes(2);
    await resolver.closeAll();
    expect(clients[1]?.close).toHaveBeenCalledOnce();
  });
});
