import type { ModelSelection, SkillEvolutionEvent, ThreadId } from "@synara/contracts";
import { Effect, ServiceMap } from "effect";

export interface EvolutionStoredRow {
  readonly requestId: string;
  readonly expertId: string;
  readonly taskThreadId: string;
  readonly record: string;
  readonly updatedAt: string;
}
export interface SkillEvolutionRepositoryShape {
  readonly read: (requestId: string) => Effect.Effect<EvolutionStoredRow | undefined, unknown>;
  readonly list: (expertId?: string) => Effect.Effect<readonly EvolutionStoredRow[], unknown>;
  readonly write: (row: EvolutionStoredRow) => Effect.Effect<void, unknown>;
  readonly appendEvent: (event: SkillEvolutionEvent) => Effect.Effect<void, unknown>;
  readonly events: () => Effect.Effect<readonly SkillEvolutionEvent[], unknown>;
  readonly execution: (threadId: ThreadId) => Effect.Effect<
    | {
        readonly requestId: string;
        readonly ownerId: string;
        readonly modelSelection: ModelSelection;
      }
    | undefined,
    unknown
  >;
}
export class SkillEvolutionRepository extends ServiceMap.Service<
  SkillEvolutionRepository,
  SkillEvolutionRepositoryShape
>()("synara/SkillEvolutionRepository") {}
