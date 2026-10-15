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
} from "./wsNativeApi";

let cachedDesktopApi: NativeApi | undefined;
let cachedWsApi: NativeApi | undefined;

export function readNativeApi(): NativeApi | undefined {
  if (typeof window === "undefined") return undefined;
  if (cachedDesktopApi && window.nativeApi === cachedDesktopApi) return cachedDesktopApi;

  if (window.nativeApi) {
    cachedDesktopApi = window.nativeApi;
    return cachedDesktopApi;
  }

  cachedWsApi ??= createWsNativeApi();
  return cachedWsApi;
}

export function ensureNativeApi(): NativeApi {
  const api = readNativeApi();
  if (!api) {
    throw new Error("Native API not found");
  }
  return api;
}

export function readNativeApiServerCapability(capability: string): boolean {
  if (typeof window === "undefined") return false;
  if (window.nativeApi) {
    if (capability === WS_GITHUB_PROJECT_PROVISIONING_CAPABILITY) {
      return typeof window.nativeApi.projects?.provisionFromGitHub === "function";
    }
    if (capability === WS_PROJECT_FILE_WATCH_CAPABILITY) {
      return typeof window.nativeApi.projects?.onFileChange === "function";
    }
    if (capability === WS_CONTEXT_V1_CAPABILITY) {
      const context = window.nativeApi.context;
      return (
        typeof context?.getSpace === "function" &&
        typeof context.getProject === "function" &&
        typeof context.getThread === "function" &&
        typeof context.saveSpace === "function" &&
        typeof context.saveProject === "function" &&
        typeof context.getCommandResult === "function" &&
        typeof context.claimMigration === "function" &&
        typeof context.resolveMigration === "function" &&
        typeof context.retryLoad === "function"
      );
    }
    return false;
  }
  return readWsServerCapabilities()?.includes(capability) === true;
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
