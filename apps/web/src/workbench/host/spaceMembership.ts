// FILE: spaceMembership.ts
// Purpose: Read project membership from the native shell for Space receipt reconciliation.
// Layer: Web Workbench host integration

import type { ProjectId, SpaceId } from "@synara/contracts";
import { useStore } from "~/store";

/** No parallel project store: each read projects the current native shell. */
export function readProjectSpaceMembership(): ReadonlyMap<ProjectId, SpaceId | null> {
  return new Map(
    useStore.getState().projects.map((project) => [project.id, project.spaceId ?? null]),
  );
}
