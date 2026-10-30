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
import type { ExpertLearningRepositoryShape } from "../../experts/evolution/ExpertLearningRepository";
import { createExpertLearningHost } from "./expertLearningHost";
import type { createWorkbenchExpertRuntime } from "../runtimeLayer";
import type { RpcEffect } from "./expertRpc";

export function makeSkillEvolutionRpcHandlers<R>(input: {
  readonly stateDir: string;
  readonly runtime: ReturnType<typeof createWorkbenchExpertRuntime>;
  readonly repository?: SkillEvolutionRepositoryShape;
  readonly learningRepository?: ExpertLearningRepositoryShape;
  readonly host: (principal: ManagedAttachmentPrincipal) => SkillEvolutionHost;
  readonly requireOwner: Effect.Effect<void, WsRpcError, R>;
  readonly rpcEffect: RpcEffect;
}) {
  const services = new Map<string, ReturnType<typeof createSkillEvolutionService>>();
  const serviceFor = (principal: ManagedAttachmentPrincipal) => {
    let service = services.get(principal.ownerId);
    if (!service) {
      if (!input.repository) throw new Error("Skill 提炼服务不可用。");
      service = createSkillEvolutionService({
        stateDir: input.stateDir,
        ownerId: principal.ownerId,
        repository: input.repository,
        experts: input.runtime.experts,
        library: input.runtime.skillLibrary,
        packages: input.runtime.skillPackages,
        host: input.host(principal),
        authorizeAutomatic: async (run) => {
          if (!learning) throw new Error("自学习服务不可用。");
          await learning.authorize(principal, run);
        },
      });
      services.set(principal.ownerId, service);
    }
    return service;
  };
  const learning =
    input.learningRepository && input.repository
      ? createExpertLearningHost({
          stateDir: input.stateDir,
          repository: input.learningRepository,
          experts: input.runtime.experts,
          evolution: serviceFor,
          host: input.host,
          reportError: (error) => {
            console.warn(
              "Expert learning coordination failed",
              error instanceof Error ? error.message : "Unknown failure",
            );
          },
        })
      : undefined;
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
            return yield* Effect.tryPromise({
              try: async () => {
                if (request.action === "learningRead" || request.action === "learningSet") {
                  if (!learning) throw new Error("自学习服务不可用。");
                  return {
                    learningState:
                      request.action === "learningRead"
                        ? await learning.read(principal, request.expertId)
                        : await learning.set(principal, request),
                  };
                }
                return serviceFor(principal).execute(request);
              },
              catch: (cause) => cause,
            });
          }),
          "Skill evolution operation failed",
        ),
    },
    start: async () => {
      await learning?.start();
      if (!input.repository) return;
      const pairs = new Map<string, { principal: ManagedAttachmentPrincipal; expertId: string }>();
      for (const row of await Effect.runPromise(input.repository.list())) {
        try {
          const value = JSON.parse(row.record) as { ownerId?: unknown };
          if (typeof value.ownerId !== "string" || !value.ownerId) continue;
          const principal: ManagedAttachmentPrincipal =
            value.ownerId === "local-loopback"
              ? { ownerKind: "local-loopback", ownerId: "local-loopback" }
              : { ownerKind: "session", ownerId: value.ownerId };
          pairs.set(principal.ownerId + ":" + row.expertId, { principal, expertId: row.expertId });
        } catch {
          /* An unreadable request cannot authorize a new native task. */
        }
      }
      for (const { principal, expertId } of pairs.values()) {
        try {
          await serviceFor(principal).execute({ action: "list", expertId });
        } catch {
          /* Retain durable identities; one invalid request does not stop the host. */
        }
      }
    },
    dispose: async () => {
      await learning?.dispose();
      await Promise.all([...services.values()].map((service) => service.dispose()));
      services.clear();
    },
  };
}
