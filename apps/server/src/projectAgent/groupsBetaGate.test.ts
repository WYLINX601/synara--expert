import { ProjectId, ThreadId } from "@synara/contracts";
import { Effect, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  GROUPS_BETA_ONLY_MESSAGE,
  gateProjectAgentServiceForStable,
  isGroupProjectCommand,
} from "./groupsBetaGate";
import type { ProjectAgentServiceShape } from "./Services/ProjectAgentService";

const PROJECT_ID = ProjectId.makeUnsafe("project-group");
const THREAD_ID = ThreadId.makeUnsafe("thread-coordinator");

function gatedService(
  getMaintenanceActivity: ProjectAgentServiceShape["getMaintenanceActivity"] = Effect.die(
    "Activity observer not configured in this test",
  ),
) {
  const onProjectDeleted = vi.fn(() => Effect.void);
  const service = { onProjectDeleted, getMaintenanceActivity };
  return { gated: gateProjectAgentServiceForStable(service), onProjectDeleted };
}

describe("gateProjectAgentServiceForStable", () => {
  it("refuses hub APIs when the feature is disabled", async () => {
    const { gated } = gatedService();
    const error = await Effect.runPromise(
      Effect.flip(gated.getOverview({ projectId: PROJECT_ID }, { kind: "user" })),
    );
    expect(error.message).toBe(GROUPS_BETA_ONLY_MESSAGE);
    expect(error.code).toBe("forbidden");
  });

  it("answers the lists and streams the web reads everywhere with nothing", async () => {
    const { gated } = gatedService();
    await expect(Effect.runPromise(gated.listSummaries({}, { kind: "user" }))).resolves.toEqual({
      summaries: [],
    });
    const events = await Effect.runPromise(
      Stream.runCollect(gated.streamEvents({ projectId: PROJECT_ID })),
    );
    expect(Array.from(events)).toEqual([]);
  });

  it("treats a hub thread's turn like any other thread's", async () => {
    const { gated } = gatedService();
    await expect(Effect.runPromise(gated.formatContextPacketForTurn(THREAD_ID))).resolves.toEqual({
      text: "",
    });
    await expect(
      Effect.runPromise(gated.assertGroupCoordinatorTurnAllowed({ threadId: THREAD_ID })),
    ).resolves.toBeUndefined();
  });

  it("still cleans up hub data when a project is deleted", async () => {
    const { gated, onProjectDeleted } = gatedService();
    await Effect.runPromise(gated.onProjectDeleted(PROJECT_ID));
    expect(onProjectDeleted).toHaveBeenCalledWith(PROJECT_ID);
  });

  it("preserves live ownership observations when group APIs are disabled", async () => {
    let digestGenerations = 1;
    const observer = Effect.sync(() => ({ digestGenerations }));
    const { gated } = gatedService(observer);
    expect(gated.getMaintenanceActivity).toBe(observer);
    expect(await Effect.runPromise(gated.getMaintenanceActivity)).toEqual({ digestGenerations: 1 });
    digestGenerations = 0;
    expect(await Effect.runPromise(gated.getMaintenanceActivity)).toEqual({ digestGenerations: 0 });
  });

  it("preserves observation defects instead of manufacturing idle activity", async () => {
    const observer = Effect.die(new Error("Digest ownership unavailable"));
    const { gated } = gatedService(observer);
    expect(gated.getMaintenanceActivity).toBe(observer);
    await expect(Effect.runPromise(gated.getMaintenanceActivity)).rejects.toThrow(
      "Digest ownership unavailable",
    );
  });
});

describe("isGroupProjectCommand", () => {
  it("matches only commands that create or re-kind a hub", () => {
    expect(isGroupProjectCommand({ type: "project.create", kind: "group" })).toBe(true);
    expect(isGroupProjectCommand({ type: "project.meta.update", kind: "group" })).toBe(true);
    expect(isGroupProjectCommand({ type: "project.create", kind: "project" })).toBe(false);
    expect(isGroupProjectCommand({ type: "thread.create", kind: "group" })).toBe(false);
  });
});
