import { useEffect, useState } from "react";

import { onNativeApiServerCapabilitiesChange, readNativeApiServerCapability } from "~/nativeApi";

/** React subscription for server capabilities that can change after a WS reconnect. */
export function useNativeApiServerCapability(capability: string): boolean {
  const [available, setAvailable] = useState(() => readNativeApiServerCapability(capability));

  useEffect(() => {
    const update = () => setAvailable(readNativeApiServerCapability(capability));
    update();
    return onNativeApiServerCapabilitiesChange(update);
  }, [capability]);

  return available;
}
