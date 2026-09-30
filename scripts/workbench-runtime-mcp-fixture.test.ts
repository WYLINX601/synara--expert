import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it } from "vitest";

import { startWorkbenchRuntimeMcpFixture } from "./lib/workbench-runtime-mcp-fixture.ts";

const fixtures: Array<Awaited<ReturnType<typeof startWorkbenchRuntimeMcpFixture>>> = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const fixture of fixtures.splice(0)) await fixture.close().catch(() => undefined);
});

async function connectFixtureClient(
  fixture: Awaited<ReturnType<typeof startWorkbenchRuntimeMcpFixture>>,
): Promise<Client> {
  const client = new Client({ name: "workbench-runtime-fixture-test", version: "1.0.0" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(fixture.url)) as unknown as Transport,
  );
  return client;
}

function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(true);
      },
    );
  });
}

describe("workbench runtime MCP fixture", () => {
  it("echoes its private marker and propagates real client cancellations through sequential waits", async () => {
    const fixture = await startWorkbenchRuntimeMcpFixture();
    fixtures.push(fixture);
    const client = await connectFixtureClient(fixture);

    const echo = await client.callTool({
      name: "workbench_probe_echo",
      arguments: { value: "provider supplied text" },
    });
    expect(echo).toMatchObject({
      content: [{ type: "text", text: fixture.echoMarker }],
      structuredContent: { echoMarker: fixture.echoMarker, value: "provider supplied text" },
    });
    expect(fixture.echoMarker).not.toBe("provider supplied text");
    expect(fixture.stats()).toMatchObject({ echoCalls: 1, waitCalls: 0, activeWaits: 0 });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const pending = client.callTool({ name: "workbench_probe_wait", arguments: {} }, undefined, {
        signal: controller.signal,
        timeout: 5_000,
        maxTotalTimeout: 5_000,
      });
      await fixture.waitForWaitStart(2_000);
      expect(fixture.stats().activeWaits).toBe(1);
      expect(() => fixture.resetWait()).toThrow("cannot-reset-mcp-wait-while-active");

      controller.abort();
      await expect(pending).rejects.toThrow();
      await fixture.waitForWaitAbort(2_000);
      expect(fixture.stats()).toMatchObject({
        waitCalls: 1,
        cancelledWaits: 1,
        activeWaits: 0,
      });
      if (attempt === 0) {
        fixture.resetWait();
        expect(fixture.stats()).toMatchObject({ waitCalls: 0, cancelledWaits: 0, activeWaits: 0 });
      }
    }
  });

  it("closes without hanging when a real MCP wait request is active", async () => {
    const fixture = await startWorkbenchRuntimeMcpFixture();
    fixtures.push(fixture);
    const client = await connectFixtureClient(fixture);
    const pending = client.callTool({ name: "workbench_probe_wait", arguments: {} }, undefined, {
      timeout: 5_000,
      maxTotalTimeout: 5_000,
    });
    await fixture.waitForWaitStart(2_000);

    await expect(fixture.close()).resolves.toBeUndefined();
    await fixture.waitForWaitAbort(2_000);
    expect(fixture.stats()).toMatchObject({ waitCalls: 1, cancelledWaits: 1, activeWaits: 0 });
    await expect(settlesWithin(pending, 2_000)).resolves.toBe(true);
    await expect(client.close()).resolves.toBeUndefined();
  });
});
