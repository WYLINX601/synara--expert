import { WS_AMBIENT_CONTEXT_CAPABILITY, type AmbientContextSnapshot } from "@synara/contracts";
import { readNativeApiServerCapabilityState, readNativeApiServerConnection } from "~/nativeApi";

export type AmbientContextSendAuthorization =
  | { readonly allowed: true; readonly generation: string | null }
  | { readonly allowed: false; readonly message: string };

/** Ambient metadata must never be sent to a server that can silently discard it. */
export function readAmbientContextSendAuthorization(
  snapshot: AmbientContextSnapshot | undefined,
  expectedGeneration?: string | null,
): AmbientContextSendAuthorization {
  if (!snapshot?.items.length) return { allowed: true, generation: null };
  const connection = readNativeApiServerConnection();
  const capability = connection.connected
    ? readNativeApiServerCapabilityState(WS_AMBIENT_CONTEXT_CAPABILITY)
    : "unknown";
  if (capability === "unsupported") {
    return {
      allowed: false,
      message:
        "This server does not support attached context. Update the Synara server and reconnect before sending. Your context has been kept.",
    };
  }
  if (
    !connection.connected ||
    !connection.generation ||
    capability !== "supported" ||
    (expectedGeneration !== undefined && expectedGeneration !== connection.generation)
  ) {
    return {
      allowed: false,
      message:
        "The server connection changed or context support is not confirmed. Reconnect and try again. Your context has been kept.",
    };
  }
  return { allowed: true, generation: connection.generation };
}
