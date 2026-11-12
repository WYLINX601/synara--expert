import { Effect, Layer } from "effect";
import { ServerConfig } from "../config";
import { expertResourceFiles } from "./ExpertStore";

/**
 * Only for fixtures that seal resources in their own temporary ServerConfig root.
 * Keep this as a dependency of resource consumers: Host/Gate/Library finalizers
 * must finish while stateDir is intact, then remove its readonly trees through
 * their owner, before layerTest's ordinary scoped temporary-root removal.
 * Deliberately accepts no existing root or config overrides.
 */
export const readonlyResourceTestConfigLayer = (prefix: string) =>
  Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => expertResourceFiles.removeStaging(config.stateDir)),
      );
      return config;
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix })));
