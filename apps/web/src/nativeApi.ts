import {
  WS_CONTEXT_V1_CAPABILITY,
  WS_GITHUB_PROJECT_PROVISIONING_CAPABILITY,
  WS_PROJECT_FILE_WATCH_CAPABILITY,
  type NativeApi,
} from "@synara/contracts";

import {
  createWsNativeApi,
  onWsServerCapabilitiesChange,
  readWsServerCapabilities,
  readWsServerConnectionState,
} from "./wsNativeApi";

let cachedDesktopApi: NativeApi | undefined;

export function readNativeApi(): NativeApi | undefined {
  if (typeof window === "undefined") return undefined;
  if (cachedDesktopApi && window.nativeApi === cachedDesktopApi) return cachedDesktopApi;

  if (window.nativeApi) {
    cachedDesktopApi = window.nativeApi;
    return cachedDesktopApi;
  }

  return createWsNativeApi();
}

export function ensureNativeApi(): NativeApi {
  const api = readNativeApi();
  if (!api) {
    throw new Error("Native API not found");
  }
  return api;
}

export type NativeApiServerCapabilityState = "unknown" | "supported" | "unsupported";

export function readNativeApiServerCapabilityState(
  capability: string,
): NativeApiServerCapabilityState {
  if (typeof window === "undefined") return "unknown";
  if (window.nativeApi) {
    if (capability === WS_GITHUB_PROJECT_PROVISIONING_CAPABILITY) {
      return typeof window.nativeApi.projects?.provisionFromGitHub === "function"
        ? "supported"
        : "unsupported";
    }
    if (capability === WS_PROJECT_FILE_WATCH_CAPABILITY) {
      return typeof window.nativeApi.projects?.onFileChange === "function"
        ? "supported"
        : "unsupported";
    }
    if (capability === WS_CONTEXT_V1_CAPABILITY) {
      const context = window.nativeApi.context;
      return typeof context?.getSpace === "function" &&
        typeof context.getProject === "function" &&
        typeof context.getThread === "function" &&
        typeof context.saveSpace === "function" &&
        typeof context.saveProject === "function" &&
        typeof context.getCommandResult === "function" &&
        typeof context.claimMigration === "function" &&
        typeof context.resolveMigration === "function" &&
        typeof context.retryLoad === "function"
        ? "supported"
        : "unsupported";
    }
    return "unsupported";
  }
  if (readWsServerConnectionState()?.state !== "open") return "unknown";
  const capabilities = readWsServerCapabilities();
  return capabilities === null
    ? "unknown"
    : capabilities.includes(capability)
      ? "supported"
      : "unsupported";
}

// Numeric host metadata never retains an API client. Activation also separates a
// previously used host API object when it is selected again after another API.
const hostApiIds = new WeakMap<NativeApi, number>();
let nextHostApiId = 0;
let activeHostApiId: number | null = null;
let hostActivation = 0;
export function readNativeApiServerConnection(): {
  readonly generation: string | null;
  readonly connected: boolean;
} {
  const api = readNativeApi();
  if (!api) {
    activeHostApiId = null;
    return { generation: null, connected: false };
  }
  let id = hostApiIds.get(api);
  if (id === undefined) {
    id = ++nextHostApiId;
    hostApiIds.set(api, id);
  }
  if (activeHostApiId !== id) {
    activeHostApiId = id;
    hostActivation += 1;
  }
  if (typeof window !== "undefined" && window.nativeApi) {
    return { generation: `${hostActivation}:${id}:native`, connected: true };
  }
  const connection = readWsServerConnectionState();
  return {
    generation: connection ? `${hostActivation}:${id}:${connection.sessionVersion}` : null,
    connected: connection?.state === "open",
  };
}

export function readNativeApiServerCapability(capability: string): boolean {
  return readNativeApiServerCapabilityState(capability) === "supported";
}

export function onNativeApiServerCapabilitiesChange(
  listener: () => void,
  options?: { readonly replayCurrent?: boolean },
): () => void {
  if (typeof window === "undefined") {
    if (options?.replayCurrent) listener();
    return () => undefined;
  }
  if (window.nativeApi) {
    if (options?.replayCurrent) listener();
    return () => undefined;
  }
  return onWsServerCapabilitiesChange(listener, options);
}
