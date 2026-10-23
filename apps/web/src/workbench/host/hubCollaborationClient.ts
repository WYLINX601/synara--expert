import type { HubTeamsApi, HubPlansApi } from "@synara/contracts";
import {
  WS_HUB_COLLABORATION_CONFIG_CAPABILITY,
  WS_HUB_COLLABORATION_PLAN_CAPABILITY,
} from "@synara/contracts";

import { ensureNativeApi, readNativeApiServerCapabilityState } from "~/nativeApi";

function assertCapability(capability: string): void {
  const state =
    typeof window !== "undefined" && window.nativeApi
      ? "supported"
      : readNativeApiServerCapabilityState(capability);
  if (state === "unsupported") {
    throw new Error("当前服务端尚不支持该 Hub 协作接口，请更新服务端后重试。");
  }
  if (state === "unknown") {
    throw new Error("正在确认服务端 Hub 协作能力，请稍后重试。");
  }
}

/** Reuse the host transport; older hosts fail explicitly instead of saving locally. */
export function ensureHubTeamsClient(): HubTeamsApi {
  assertCapability(WS_HUB_COLLABORATION_CONFIG_CAPABILITY);
  const api = ensureNativeApi().hubTeams;
  if (!api) throw new Error("当前服务端尚不支持专家团配置，请更新服务端后重试。");
  return api;
}

export function ensureHubPlansClient(): HubPlansApi {
  assertCapability(WS_HUB_COLLABORATION_PLAN_CAPABILITY);
  const api = ensureNativeApi().hubPlans;
  if (!api) throw new Error("当前服务端尚不支持协作计划，请更新服务端后重试。");
  return api;
}
