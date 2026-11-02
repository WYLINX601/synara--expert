import { Effect, ServiceMap } from "effect";

export interface LearningStateRow {
  readonly ownerId: string;
  readonly expertId: string;
  /** Server-owned frozen Skill entries and commit receipt; never exposed publicly. */
  readonly record: string;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface LearningEvidenceRow {
  readonly evidenceId: string;
  readonly ownerId: string;
  readonly expertId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly record: string;
  readonly updatedAt: string;
}

export interface LearningCycleRow {
  readonly cycleId: string;
  readonly ownerId: string;
  readonly expertId: string;
  readonly record: string;
  readonly updatedAt: string;
}

export interface ExpertLearningRepositoryShape {
  readonly readState: (
    ownerId: string,
    expertId: string,
  ) => Effect.Effect<LearningStateRow | undefined, unknown>;
  readonly listStates: () => Effect.Effect<readonly LearningStateRow[], unknown>;
  /** expectedRevision is zero when absent; successful writes store expectedRevision + 1. */
  readonly writeState: (
    row: LearningStateRow,
    expectedRevision: number,
  ) => Effect.Effect<void, unknown>;
  readonly readEvidence: (
    evidenceId: string,
  ) => Effect.Effect<LearningEvidenceRow | undefined, unknown>;
  readonly listEvidence: (
    ownerId: string,
    expertId: string,
  ) => Effect.Effect<readonly LearningEvidenceRow[], unknown>;
  readonly writeEvidence: (row: LearningEvidenceRow) => Effect.Effect<void, unknown>;
  readonly readCycle: (cycleId: string) => Effect.Effect<LearningCycleRow | undefined, unknown>;
  readonly listCycles: (
    ownerId?: string,
    expertId?: string,
    activeOnly?: boolean,
  ) => Effect.Effect<readonly LearningCycleRow[], unknown>;
  readonly writeCycle: (row: LearningCycleRow) => Effect.Effect<void, unknown>;
}

export class ExpertLearningRepository extends ServiceMap.Service<
  ExpertLearningRepository,
  ExpertLearningRepositoryShape
>()("synara/ExpertLearningRepository") {}
