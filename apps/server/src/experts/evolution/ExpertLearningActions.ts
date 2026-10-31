import type {
  ExpertLearningEvidence,
  LearningChangeSet,
  LearningCommitInput,
  LearningMemoryDraft,
  LearningReadInput,
  LearningRevertInput,
  LearningSessionContext,
  SkillEvolutionEvidence,
  LearningSkillChangeDetail,
  SpaceMemoryEntry,
} from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

/** Scope comes from the authenticated Gateway lease, never a model argument. */
export interface LearningActionContext {
  readonly session: LearningSessionContext;
  readonly threadId: string;
  readonly turnId: string;
  readonly provider: "omp" | "pi";
  readonly sessionKey: string;
  readonly requestId?: string;
  readonly assertActive: () => Effect.Effect<void, unknown>;
}

export interface LearningActionResult {
  readonly status: "committed" | "saved_unbound" | "deferred" | "unchanged";
  readonly changeSet?: LearningChangeSet;
  readonly coverage?: readonly string[];
}

export interface ExpertLearningActionsShape {
  readonly read: (
    context: LearningActionContext,
    input: LearningReadInput,
  ) => Effect.Effect<unknown, unknown>;
  readonly commit: (
    context: LearningActionContext,
    input: LearningCommitInput,
  ) => Effect.Effect<LearningActionResult, unknown>;
  readonly revert: (
    context: LearningActionContext,
    input: LearningRevertInput,
  ) => Effect.Effect<LearningActionResult, unknown>;
  readonly listChanges: (
    ownerId: string,
    expertId: string,
  ) => Effect.Effect<readonly LearningChangeSet[], unknown>;
  readonly readMemory: (
    ownerId: string,
    expertId: string,
    changeId: string,
    revision: number,
  ) => Effect.Effect<SpaceMemoryEntry, unknown>;
  readonly readSkillChange: (
    ownerId: string,
    expertId: string,
    changeId: string,
  ) => Effect.Effect<LearningSkillChangeDetail, unknown>;
  readonly revertOwner: (
    ownerId: string,
    expertId: string,
    input: LearningRevertInput,
  ) => Effect.Effect<LearningActionResult, unknown>;
  readonly editOwnerMemory: (
    ownerId: string,
    expertId: string,
    input: {
      readonly changeId: string;
      readonly requestId: string;
      readonly expectedRevision: number;
      readonly content: string;
      readonly validUntil?: string;
    },
  ) => Effect.Effect<LearningActionResult, unknown>;
  readonly commitAutomaticMemory: (input: {
    readonly ownerId: string;
    readonly expertId: string;
    readonly epoch: number;
    readonly requestId: string;
    readonly evidence: ExpertLearningEvidence;
    readonly draft: LearningMemoryDraft;
    readonly citations: readonly SkillEvolutionEvidence[];
  }) => Effect.Effect<LearningActionResult, unknown>;
}

export class ExpertLearningActions extends ServiceMap.Service<
  ExpertLearningActions,
  ExpertLearningActionsShape
>()("synara/ExpertLearningActions") {}
