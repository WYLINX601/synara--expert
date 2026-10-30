import { Effect, Option } from "effect";
import type { ThreadId } from "@synara/contracts";
import { SkillEvolutionRepository } from "../../experts/evolution/SkillEvolutionRepository";

/** Capture the capability in the layer: native dispatch fibers do not inherit its environment. */
export const captureSkillEvolutionExecutionReader = Effect.gen(function* () {
  const repository = yield* Effect.serviceOption(SkillEvolutionRepository);
  return (threadId: ThreadId) =>
    Option.isSome(repository) ? repository.value.execution(threadId) : Effect.succeed(undefined);
});
