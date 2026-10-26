import { Effect } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import { ServerAuth } from "../../auth/Services/ServerAuth";
import { makeEffectAuthRequest } from "../../auth/effectHttp";

/** The command module receives caller facts, never the native auth service. */
export const authenticateSkillManagementHttpRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const auth = yield* ServerAuth;
  const session = yield* auth.authenticateHttpRequest(makeEffectAuthRequest(request));
  return { role: session.role, credentialSource: session.credentialSource };
});
