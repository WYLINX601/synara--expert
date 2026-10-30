import { WS_METHODS, WsRpcError, type SkillEvolutionRequest } from "@synara/contracts";
import { Effect } from "effect";
import {
  CurrentManagedAttachmentPrincipal,
  type ManagedAttachmentPrincipal,
} from "../../managedAttachmentPrincipal";
import {
  createSkillEvolutionService,
  SKILL_EVOLUTION_CAPABILITIES,
  type SkillEvolutionHost,
} from "../../experts/evolution/SkillEvolutionService";
import type { SkillEvolutionRepositoryShape } from "../../experts/evolution/SkillEvolutionRepository";
import type { createWorkbenchExpertRuntime } from "../runtimeLayer";
import type { RpcEffect } from "./expertRpc";

export function makeSkillEvolutionRpcHandlers<R>(input: {
  readonly stateDir: string;
  readonly runtime: ReturnType<typeof createWorkbenchExpertRuntime>;
  readonly repository?: SkillEvolutionRepositoryShape;
  readonly host: (principal: ManagedAttachmentPrincipal) => SkillEvolutionHost;
  readonly requireOwner: Effect.Effect<void, WsRpcError, R>;
  readonly rpcEffect: RpcEffect;
}) {
  const services = new Map<string, ReturnType<typeof createSkillEvolutionService>>();
  return {
    handlers: {
      [WS_METHODS.serverSkillEvolution]: ({
        request,
      }: {
        readonly request: SkillEvolutionRequest;
      }) =>
        input.rpcEffect(
          Effect.gen(function* () {
            yield* input.requireOwner;
            const principal = yield* CurrentManagedAttachmentPrincipal;
            if (!input.repository) {
              if (request.action === "capabilities")
                return {
                  capabilities: SKILL_EVOLUTION_CAPABILITIES.map((capability) => ({
                    ...capability,
                    supported: false,
                    reason: "提炼持久化服务不可用。",
                  })),
                };
              return yield* Effect.fail(new Error("Skill 提炼服务不可用。"));
            }
            let service = services.get(principal.ownerId);
            if (!service) {
              service = createSkillEvolutionService({
                stateDir: input.stateDir,
                ownerId: principal.ownerId,
                repository: input.repository,
                experts: input.runtime.experts,
                library: input.runtime.skillLibrary,
                packages: input.runtime.skillPackages,
                host: input.host(principal),
              });
              services.set(principal.ownerId, service);
            }
            return yield* Effect.tryPromise({
              try: () => service!.execute(request),
              catch: (cause) => cause,
            });
          }),
          "Skill evolution operation failed",
        ),
    },
    dispose: async () => {
      await Promise.all([...services.values()].map((service) => service.dispose()));
      services.clear();
    },
  };
}
