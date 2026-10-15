import { Effect, Layer } from "effect";

import { ContextRepository, type ContextRepositoryShape } from "../context/ContextRepository.ts";

export function makeContextRepositoryTestLayer(overrides: Partial<ContextRepositoryShape> = {}) {
  const repository: ContextRepositoryShape = {
    getSpace: () => Effect.die(new Error("Unused ContextRepository.getSpace in provider tests.")),
    getProject: () =>
      Effect.die(new Error("Unused ContextRepository.getProject in provider tests.")),
    getThreadBinding: () => Effect.succeed(undefined),
    getContextSession: () => Effect.succeed(undefined),
    getApplied: () => Effect.succeed(undefined),
    upsertApplied: () => Effect.void,
    getThreadDetails: () => Effect.die(new Error("Unused ContextRepository.getThreadDetails.")),
    getCommandResult: () => Effect.die(new Error("Unused ContextRepository.getCommandResult.")),
    getPreview: () => Effect.die(new Error("Unused ContextRepository.getPreview.")),
    buildBindingSnapshot: () =>
      Effect.die(new Error("Unused ContextRepository.buildBindingSnapshot.")),
    prepareSpaceSave: (event) => Effect.succeed(event),
    prepareProjectSave: (event) => Effect.succeed(event),
    prepareMigrationClaim: (event) => Effect.succeed(event),
    prepareMigrationResolve: (event) => Effect.succeed(event),
    prepareBinding: (event) => Effect.succeed(event),
    applyEvent: () => Effect.void,
    ...overrides,
  };
  return Layer.succeed(ContextRepository, repository);
}
