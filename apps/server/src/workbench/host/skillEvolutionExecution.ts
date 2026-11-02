import { Effect, Option } from "effect";
import type { ThreadId } from "@synara/contracts";
import { SkillEvolutionRepository } from "../../experts/evolution/SkillEvolutionRepository";
import { ExpertLearningRepository } from "../../experts/evolution/ExpertLearningRepository";
import { decodeLearningState } from "../../experts/evolution/ExpertLearningState";

/** Capture the capability in the layer: native dispatch fibers do not inherit its environment. */
export const captureSkillEvolutionExecutionReader = Effect.gen(function* () {
  const repository = yield* Effect.serviceOption(SkillEvolutionRepository);
  const learning = yield* Effect.serviceOption(ExpertLearningRepository);
  return (threadId: ThreadId) =>
    Effect.gen(function* () {
      const identity = Option.isSome(repository)
        ? yield* repository.value.execution(threadId)
        : undefined;
      if (identity?.origin !== "automatic") return identity;
      if (Option.isNone(learning) || !identity.expertId || !identity.cycleId)
        return yield* Effect.fail(new Error("自动学习派发缺少持久授权。"));
      const cycle = yield* learning.value.readCycle(identity.cycleId);
      const row = yield* learning.value.readState(identity.ownerId, identity.expertId);
      const record = row
        ? yield* Effect.try({ try: () => decodeLearningState(row), catch: (error) => error })
        : undefined;
      const progress = cycle
        ? yield* Effect.try({
            try: () =>
              JSON.parse(cycle.record) as {
                status?: unknown;
                discoveryId?: unknown;
                generationId?: unknown;
              },
            catch: (error) => error,
          })
        : undefined;
      if (
        !record?.state.enabled ||
        record.state.epoch !== identity.learningEpoch ||
        record.state.harnessKind !== identity.modelSelection.provider ||
        !cycle ||
        cycle.ownerId !== identity.ownerId ||
        cycle.expertId !== identity.expertId ||
        !["queued", "discovery", "generation"].includes(String(progress?.status)) ||
        (progress?.discoveryId !== identity.requestId &&
          progress?.generationId !== identity.requestId)
      )
        return yield* Effect.fail(new Error("自动学习已关闭或授权已改变，停止原生派发。"));
      return identity;
    });
});
