import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { ProjectId, ThreadId } from "@synara/contracts";
import type { ProjectAgentServiceShape } from "../projectAgent/Services/ProjectAgentService";
import { makeHubDeliverableTools } from "./hubDeliverableTools";
import type { ToolContext } from "./toolRuntime";

const context = { callerThreadId: "worker-a" } as ToolContext;
const principal = {
  kind: "worker" as const,
  projectId: ProjectId.makeUnsafe("hub-a"),
  threadId: ThreadId.makeUnsafe("worker-a"),
  taskId: null,
};
function setup(managed = true) {
  const list = vi.fn(() => Effect.succeed([]));
  const publish = vi.fn(() => Effect.succeed({}));
  const read = vi.fn(() => Effect.succeed({ content: { encoding: "base64", data: "AA==" } }));
  const service = {
    resolvePrincipalForThread: () =>
      Effect.succeed(managed ? principal : { ...principal, kind: "unmanaged" }),
    deliverables: { list, publish, read, withdraw: publish },
  } as unknown as ProjectAgentServiceShape;
  const tools = new Map(
    makeHubDeliverableTools(service).map((entry) => [entry.definition.name, entry]),
  );
  return { tools, list, publish, read };
}

describe("Hub deliverable Gateway scope", () => {
  it("derives the Hub from session identity while allowing another worker’s collection to be discovered", async () => {
    const { tools, list } = setup();
    const result = await Effect.runPromise(
      tools.get("synara_hub_list_deliverables")!.handler({ ownerThreadId: "worker-b" }, context),
    );
    expect(result.isError).not.toBe(true);
    expect(list).toHaveBeenCalledWith({ projectId: "hub-a", ownerThreadId: "worker-b" }, principal);
  });
  it("rejects forged Hub or Expert identity fields before invoking the service", async () => {
    const { tools, publish } = setup();
    const result = await Effect.runPromise(
      tools.get("synara_hub_publish_deliverables")!.handler(
        {
          requestId: "request",
          expectedRevision: 0,
          files: [{ path: "brief.md" }],
          projectId: "hub-b",
          expertId: "other",
        },
        context,
      ),
    );
    expect(result.isError).toBe(true);
    expect(publish).not.toHaveBeenCalled();
  });
  it("refuses unmanaged callers before reading any Hub collection", async () => {
    const { tools, list } = setup(false);
    const result = await Effect.runPromise(
      tools.get("synara_hub_list_deliverables")!.handler({}, context),
    );
    expect(result.isError).toBe(true);
    expect(list).not.toHaveBeenCalled();
  });
  it("reports binary files as unsupported by the text tool instead of sending base64 as document text", async () => {
    const { tools } = setup();
    const result = await Effect.runPromise(
      tools
        .get("synara_hub_read_deliverable")!
        .handler({ ownerThreadId: "worker-b", path: "brief.pdf" }, context),
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("binary");
    expect(JSON.stringify(result)).not.toContain("AA==");
  });
  it("forwards an explicit publication revision with the authenticated Hub identity", async () => {
    const { tools, read } = setup();
    await Effect.runPromise(
      tools
        .get("synara_hub_read_deliverable")!
        .handler({ ownerThreadId: "worker-b", path: "brief.md", revision: 1 }, context),
    );
    expect(read).toHaveBeenCalledWith(
      { projectId: "hub-a", ownerThreadId: "worker-b", path: "brief.md", revision: 1 },
      principal,
    );
  });
});
