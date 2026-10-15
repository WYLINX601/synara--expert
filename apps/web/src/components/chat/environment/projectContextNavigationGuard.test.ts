import { ProjectId, ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { shouldGuardProjectContextNavigation } from "./projectContextNavigationGuard";

const activeProjectId = ProjectId.makeUnsafe("active-project");
const otherProjectId = ProjectId.makeUnsafe("other-project");
const sameProjectThreadId = ThreadId.makeUnsafe("same-project-thread");
const otherProjectThreadId = ThreadId.makeUnsafe("other-project-thread");

describe("shouldGuardProjectContextNavigation", () => {
  it("guards when leaving a Project for a top-level application route", () => {
    for (const route of [
      "/settings",
      "/automations",
      "/plugins",
      "/pull-requests",
      "/studio",
      "/kanban",
    ]) {
      expect(
        shouldGuardProjectContextNavigation({
          activeProjectId,
          currentPathname: "/current-thread",
          nextPathname: route,
          projectIdForThread: () => null,
        }),
      ).toBe(true);
    }
  });

  it("allows same-Project thread changes and local draft promotion", () => {
    expect(
      shouldGuardProjectContextNavigation({
        activeProjectId,
        currentPathname: "/current-thread",
        nextPathname: `/${sameProjectThreadId}`,
        projectIdForThread: () => activeProjectId,
      }),
    ).toBe(false);
    expect(
      shouldGuardProjectContextNavigation({
        activeProjectId,
        currentPathname: "/current-thread",
        nextPathname: "/unknown-draft-promotion",
        projectIdForThread: () => null,
      }),
    ).toBe(false);
  });

  it("guards different Project routes while allowing the current Kanban route", () => {
    const projectIdForThread = (threadId: ThreadId) =>
      threadId === otherProjectThreadId ? otherProjectId : activeProjectId;
    expect(
      shouldGuardProjectContextNavigation({
        activeProjectId,
        currentPathname: "/current-thread",
        nextPathname: `/${otherProjectThreadId}`,
        projectIdForThread,
      }),
    ).toBe(true);
    expect(
      shouldGuardProjectContextNavigation({
        activeProjectId,
        currentPathname: "/current-thread",
        nextPathname: `/kanban/${activeProjectId}`,
        projectIdForThread,
      }),
    ).toBe(false);
    expect(
      shouldGuardProjectContextNavigation({
        activeProjectId,
        currentPathname: "/current-thread",
        nextPathname: `/kanban/${otherProjectId}`,
        projectIdForThread,
      }),
    ).toBe(true);
  });
});
