import type { NativeApi } from "@synara/contracts";

export function ensureNativeApi(): NativeApi {
  throw new Error("交互原型禁止调用 Synara 业务 API。请使用 ContextDemoAdapter。");
}
export function readNativeApi(): NativeApi | undefined {
  return ensureNativeApi();
}
export function readNativeApiServerCapability(): boolean {
  throw new Error("交互原型禁止读取真实服务端能力。");
}
export function onNativeApiServerCapabilitiesChange(): () => void {
  throw new Error("交互原型禁止订阅真实服务端事件。");
}
