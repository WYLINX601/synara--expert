import { useEffect, useState } from "react";
import type { NativeApi } from "@synara/contracts";

import {
  onNativeApiServerCapabilitiesChange,
  readNativeApi,
  readNativeApiServerCapabilityState,
  readNativeApiServerConnection,
  type NativeApiServerCapabilityState,
} from "~/nativeApi";

interface NativeApiCapabilitySnapshot {
  readonly api: NativeApi | undefined;
  readonly capability: NativeApiServerCapabilityState;
  readonly generation: string | null;
  readonly connected: boolean;
}

/** Keep the negotiated value and its original API identity in the same event snapshot. */
export function useNativeApiServerCapabilitySnapshot(
  capability: string,
): NativeApiCapabilitySnapshot {
  const [snapshot, setSnapshot] = useState(() => {
    const api = readNativeApi();
    return {
      api,
      capability: readNativeApiServerCapabilityState(capability),
      ...readNativeApiServerConnection(),
    };
  });
  useEffect(() => {
    const update = () => {
      const api = readNativeApi();
      setSnapshot({
        api,
        capability: readNativeApiServerCapabilityState(capability),
        ...readNativeApiServerConnection(),
      });
    };
    update();
    return onNativeApiServerCapabilitiesChange(update);
  }, [snapshot.api, capability]);
  return snapshot;
}

export function useNativeApiServerCapabilityState(
  capability: string,
): NativeApiServerCapabilityState {
  return useNativeApiServerCapabilitySnapshot(capability).capability;
}

export function useNativeApiServerCapability(capability: string): boolean {
  return useNativeApiServerCapabilityState(capability) === "supported";
}
