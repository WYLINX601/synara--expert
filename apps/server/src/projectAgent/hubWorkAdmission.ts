import type { HubWorkRecord, ThreadId } from "@synara/contracts";
import { Effect } from "effect";

import type { HubWorkRepositoryShape } from "../persistence/Services/HubWorkRepository.ts";

/**
 * Reserve native HubWork capacity for one deterministic follow-up command.
 * The receipt is deliberately shared by ordinary directed replies and the
 * worker-health ladder so both paths use the same atomic slot reservation.
 */
export const reserveHubWorkAdmission = (
  repository: HubWorkRepositoryShape,
  input: { readonly threadId: ThreadId; readonly commandId: string; readonly messageId: string },
) =>
  Effect.gen(function* () {
    const current = yield* repository.findByWorker(input.threadId);
    if (!current) return null;
    if (current.admissionCommandId === input.commandId) {
      return current.admissionMessageId === input.messageId ? current : null;
    }
    const reserved = yield* repository.reserveWorker(input);
    if (reserved) return reserved;
    const replay = yield* repository.get(current.id);
    return replay?.admissionCommandId === input.commandId &&
      replay.admissionMessageId === input.messageId
      ? replay
      : null;
  });

/** Roll back an unaccepted reservation while retaining its previous native state. */
export const rollbackHubWorkAdmission = (
  repository: HubWorkRepositoryShape,
  record: HubWorkRecord,
) =>
  repository.save({
    record: {
      ...record,
      state: record.admissionPreviousState ?? "idle",
      slotHeld: record.admissionPreviousSlotHeld,
      admittedAt: null,
      admissionCommandId: null,
      admissionMessageId: null,
      admissionPreviousState: null,
      admissionPreviousSlotHeld: false,
      revision: record.revision + 1,
      updatedAt: new Date().toISOString(),
    },
    expectedRevision: record.revision,
  });
