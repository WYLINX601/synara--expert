import { Effect, Layer, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeHubCollaborationConfigStore } from "../../hubCollaboration/HubCollaborationConfigStore.ts";

export class HubCollaborationConfigService extends ServiceMap.Service<
  HubCollaborationConfigService,
  ReturnType<typeof makeHubCollaborationConfigStore>
>()("synara/HubCollaborationConfigService") {}

export const HubCollaborationConfigLive = Layer.effect(
  HubCollaborationConfigService,
  Effect.gen(function* () {
    return makeHubCollaborationConfigStore(yield* SqlClient.SqlClient);
  }),
);
