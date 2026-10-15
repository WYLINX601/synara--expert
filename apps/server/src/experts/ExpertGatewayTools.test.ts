import { chmod, lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { ExpertConnectionConfig, ExpertSaveInput } from "@synara/contracts";
import { Effect, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startWorkbenchRuntimeMcpFixture } from "../../../../scripts/lib/workbench-runtime-mcp-fixture.ts";
import { createExpertConnectionStore } from "./ExpertConnectionStore.ts";
import { createExpertMcpCredentialStore } from "./ExpertMcpCredentials.ts";
import { connectExpertMcp } from "./ExpertMcpClient.ts";
import { createExpertStore } from "./ExpertStore.ts";
import { createWorkbenchExpertRuntime } from "../workbench/runtimeLayer.ts";
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
  const connectionStore = createExpertConnectionStore(stateDir);
  for (const id of configuredIds) {
    await connectionStore.save({
      id,
      name: `Connection ${id}`,
      transport: { type: "stdio", command: "fixture-mcp", args: [], envFromHost: [] },
    });
  }
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
    const missingStateDir = path.join(await makeTempRoot(), "state");
    const missingExperts = createExpertStore(missingStateDir);
    const missingDefinition = await missingExperts.save({
      id: "gateway-tools-test",
      name: "Missing required connection",
      description: "Test missing mandatory configuration.",
      useCases: "Test snapshot capture.",
      persona: "Use only configured connections.",
      outputRequirements: "Return concise results.",
      skills: [],
      references: [],
      connections: [{ id: "git", required: true, tools: ["review"] }],
    });
    await expect(missingExperts.prepareSnapshot(missingDefinition.id)).rejects.toThrow(
      /not configured/u,
    );

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

  it("does not grant a previously missing optional binding when config appears later", async () => {
    const { stateDir, snapshotId } = await makeScenario(
      [{ id: "later", required: false, tools: ["search"] }],
      [],
    );
    const expertStore = createExpertStore(stateDir);
    const snapshot = await expertStore.readSnapshot(snapshotId);
    expect(snapshot.mcpBinding?.servers).toEqual([
      { id: "later", required: false, tools: ["search"] },
    ]);

    await createExpertConnectionStore(stateDir).save({
      id: "later",
      name: "Added after snapshot",
      transport: { type: "stdio", command: "fixture-mcp", args: [], envFromHost: [] },
    });
    const connect = vi.fn(async () => fakeClient([fakeTool("search")]));
    const resolver = makeExpertGatewayToolResolver({
      stateDir,
      connect: connect as typeof connectExpertMcp,
    });
    await expect(resolver.resolve("session-late-config", snapshotId)).resolves.toEqual([]);
    expect(connect).not.toHaveBeenCalled();
    await resolver.closeAll();
  });

  it("does not inspect, connect, expose, or call tools from disabled required bindings", async () => {
    const { stateDir, snapshotId } = await makeScenario(
      [
        { id: "disabled", required: true, tools: ["publish"], enabled: false },
        { id: "active", required: true, tools: ["review"], enabled: true },
      ],
      ["active"],
    );
    const clientCallTool = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    const client = fakeClient([fakeTool("publish"), fakeTool("review")], clientCallTool);
    const connect = vi.fn(async () => client);
    const snapshot = await createExpertStore(stateDir).readSnapshot(snapshotId);

    await expect(
      preflightExpertConnections(snapshot, {
        stateDir,
        connect: connect as typeof connectExpertMcp,
      }),
    ).resolves.toEqual({ optionalIssues: [] });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ id: "active" }));

    connect.mockClear();
    const resolver = makeExpertGatewayToolResolver({
      stateDir,
      connect: connect as typeof connectExpertMcp,
    });
    const tools = await resolver.resolve("session-disabled-binding", snapshotId);
    expect(tools.map(({ definition }) => definition.name)).toEqual(["expert_active_review"]);
    await Effect.runPromise(tools[0]!.handler({}, {} as never));
    expect(clientCallTool).toHaveBeenCalledExactlyOnceWith("review", {}, expect.any(AbortSignal));
    expect(connect).toHaveBeenCalledTimes(1);
    await resolver.closeAll();
  });

  it("uses the immutable task snapshot through the production MCP connector", async () => {
    const root = await makeTempRoot();
    const fixture = await startWorkbenchRuntimeMcpFixture();
    const stateDir = path.join(root, "state");
    const experts = createExpertStore(stateDir);
    const connections = createExpertConnectionStore(stateDir);
    const originalBindings: ExpertSaveInput["connections"] = [
      {
        id: "legacy",
        required: true,
        tools: ["workbench_probe_echo"],
      },
      {
        id: "disabled",
        required: true,
        tools: ["workbench_probe_wait"],
        enabled: false,
      },
    ];
    let resolver: ReturnType<typeof makeExpertGatewayToolResolver> | undefined;

    try {
      for (const id of ["legacy", "disabled"]) {
        await connections.save({
          id,
          name: `Connection ${id}`,
          transport: { type: "http", url: fixture.url, headersFromHost: [] },
        });
      }
      const definition = await experts.save({
        id: "production-mcp-compatibility",
        name: "Production MCP compatibility",
        description: "Exercise the real MCP client and gateway resolver.",
        useCases: "Verify snapshot-bound tools.",
        persona: "Use only snapshot-authorized tools.",
        outputRequirements: "Return the fixture marker.",
        skills: [],
        references: [],
        connections: originalBindings,
      });
      const taskBinding = await experts.prepareSnapshot(definition.id);

      await experts.save({
        id: definition.id,
        expectedRevision: definition.revision,
        name: definition.name,
        description: definition.description,
        useCases: definition.useCases,
        persona: definition.persona,
        outputRequirements: definition.outputRequirements,
        skills: definition.skills,
        references: definition.references,
        connections: [
          { id: "legacy", required: true, tools: ["workbench_probe_wait"] },
          { id: "disabled", required: false, tools: ["workbench_probe_echo"], enabled: true },
        ],
      });

      const retainedSnapshot = await experts.readSnapshot(taskBinding.snapshotId);
      expect(retainedSnapshot.connections).toEqual(originalBindings);

      const connectedIds: string[] = [];
      const productionConnect: typeof connectExpertMcp = async (config) => {
        connectedIds.push(config.id);
        return connectExpertMcp(config);
      };
      const legacyConfig = await connections.read("legacy");
      if (!legacyConfig) throw new Error("Expected the saved legacy connection.");
      const runtime = createWorkbenchExpertRuntime({
        stateDir,
        expertAppliedRuntimeRepository: {
          getByThreadId: () => Effect.succeed(Option.none()),
        },
        connect: productionConnect,
      });
      await expect(
        runtime.testConnection({ id: "legacy", expectedRevision: legacyConfig.revision }),
      ).resolves.toEqual({
        tools: ["workbench_probe_echo", "workbench_probe_wait"],
        revision: legacyConfig.revision,
      });
      await expect(
        runtime.testConnection({ id: "legacy", expectedRevision: legacyConfig.revision + 1 }),
      ).rejects.toMatchObject({ code: "revision_conflict" });
      expect(connectedIds).toEqual(["legacy"]);

      await expect(
        preflightExpertConnections(retainedSnapshot, {
          stateDir,
          connect: productionConnect,
        }),
      ).resolves.toEqual({ optionalIssues: [] });
      expect(connectedIds).toEqual(["legacy", "legacy"]);

      resolver = makeExpertGatewayToolResolver({ stateDir, connect: productionConnect });
      const tools = await resolver.resolve("provider-session-1", taskBinding.snapshotId);
      expect(tools.map(({ definition: tool }) => tool.name)).toEqual([
        "expert_legacy_workbench_probe_echo",
      ]);
      expect(connectedIds).toEqual(["legacy", "legacy", "legacy"]);

      const result = await Effect.runPromise(
        tools[0]!.handler({ value: "snapshot-call" }, {} as never),
      );
      expect(result).toMatchObject({
        content: [{ type: "text", text: fixture.echoMarker }],
        structuredContent: { echoMarker: fixture.echoMarker, value: "snapshot-call" },
      });
      expect(fixture.stats()).toMatchObject({ echoCalls: 1, waitCalls: 0, activeWaits: 0 });
    } finally {
      const cleanupResults = await Promise.allSettled([
        ...(resolver ? [resolver.closeAll()] : []),
        fixture.close(),
      ]);
      const cleanupFailure = cleanupResults.find((result) => result.status === "rejected");
      if (cleanupFailure?.status === "rejected") throw cleanupFailure.reason;
    }
  });

  it("uses the pinned HTTP revision and revokes a live call after connection disable", async () => {
    const root = await makeTempRoot();
    const firstFixture = await startWorkbenchRuntimeMcpFixture();
    const secondFixture = await startWorkbenchRuntimeMcpFixture();
    const stateDir = path.join(root, "state");
    const experts = createExpertStore(stateDir);
    const connections = createExpertConnectionStore(stateDir);
    const credentials = createExpertMcpCredentialStore(stateDir);
    const credentialId = await credentials.create({
      env: {},
      headers: { "x-synara-fixture-token": "gateway-owned-secret" },
    });
    const secretTransport = (url: string) => ({
      type: "http" as const,
      url,
      headersFromHost: [],
      headersFromSecret: { credentialId, names: ["x-synara-fixture-token"] },
    });
    let resolver: ReturnType<typeof makeExpertGatewayToolResolver> | undefined;

    try {
      const firstConfig = await connections.save({
        id: "live-http",
        name: "Live HTTP MCP",
        transport: secretTransport(firstFixture.url),
      });
      const expert = await experts.save({
        id: "pinned-http-runtime",
        name: "Pinned HTTP runtime",
        description: "Verify immutable connection revisions and state revocation.",
        useCases: "Connect to a task-pinned MCP server.",
        persona: "Use only task-authorized tools.",
        outputRequirements: "Return the fixture marker.",
        skills: [],
        references: [],
        connections: [
          {
            id: "live-http",
            required: true,
            tools: ["workbench_probe_echo", "workbench_probe_wait"],
          },
        ],
      });
      const snapshot = await experts.prepareSnapshot(expert.id);
      await connections.save({
        id: "live-http",
        expectedRevision: firstConfig.revision,
        name: "Live HTTP MCP v2",
        transport: secretTransport(secondFixture.url),
      });

      await expect(
        preflightExpertConnections(await experts.readSnapshot(snapshot.snapshotId), { stateDir }),
      ).resolves.toEqual({ optionalIssues: [] });

      resolver = makeExpertGatewayToolResolver({ stateDir });
      const tools = await resolver.resolve("session-live-http", snapshot.snapshotId);
      const echo = tools.find(({ definition }) =>
        definition.name.endsWith("_workbench_probe_echo"),
      );
      const wait = tools.find(({ definition }) =>
        definition.name.endsWith("_workbench_probe_wait"),
      );
      if (!echo || !wait) throw new Error("Expected both live MCP fixture tools.");

      await expect(
        Effect.runPromise(echo.handler({ value: "pinned-r1" }, {} as never)),
      ).resolves.toMatchObject({
        content: [{ type: "text", text: firstFixture.echoMarker }],
        structuredContent: { echoMarker: firstFixture.echoMarker, value: "pinned-r1" },
      });
      expect(firstFixture.stats().echoCalls).toBe(1);
      expect(secondFixture.stats().echoCalls).toBe(0);

      const pendingCall = Effect.runPromise(wait.handler({}, {} as never));
      await firstFixture.waitForWaitStart(5_000);
      await connections.setState({
        id: "live-http",
        status: "disabled",
        expectedRevision: 1,
      });
      await firstFixture.waitForWaitAbort(5_000);
      await expect(pendingCall).resolves.toMatchObject({ isError: true });
      expect(firstFixture.stats()).toMatchObject({ activeWaits: 0, cancelledWaits: 1 });
      await expect(
        Effect.runPromise(echo.handler({ value: "after-disable" }, {} as never)),
      ).resolves.toMatchObject({ isError: true });
      expect(firstFixture.stats().echoCalls).toBe(1);
    } finally {
      const cleanupResults = await Promise.allSettled([
        ...(resolver ? [resolver.closeAll()] : []),
        firstFixture.close(),
        secondFixture.close(),
      ]);
      const cleanupFailure = cleanupResults.find((result) => result.status === "rejected");
      if (cleanupFailure?.status === "rejected") throw cleanupFailure.reason;
    }
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
    await expect(resolver.resolve("session-cache", snapshotId)).resolves.toEqual([]);
    expect(connect).toHaveBeenCalledOnce();
    await resolver.resolve("session-cache-next", snapshotId);
    expect(connect).toHaveBeenCalledTimes(2);
    await resolver.closeAll();
    expect(clients[1]?.close).toHaveBeenCalledOnce();
  });

  it("shares one in-flight catalog across concurrent resolves for the same snapshot", async () => {
    const { stateDir, snapshotId } = await makeScenario([
      { id: "git", required: true, tools: ["review"] },
    ]);
    const client = fakeClient([fakeTool("review")]);
    const connect = vi.fn(async () => client);
    const resolver = makeExpertGatewayToolResolver({
      stateDir,
      connect: connect as typeof connectExpertMcp,
    });

    const [first, second] = await Promise.all([
      resolver.resolve("session-concurrent", snapshotId),
      resolver.resolve("session-concurrent", snapshotId),
    ]);
    expect(first.map(({ definition }) => definition.name)).toEqual(["expert_git_review"]);
    expect(second.map(({ definition }) => definition.name)).toEqual(["expert_git_review"]);
    expect(connect).toHaveBeenCalledOnce();
    await resolver.closeAll();
    expect(client.close).toHaveBeenCalledOnce();
  });
});
