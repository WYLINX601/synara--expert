import { useLayoutEffect, type RefObject } from "react";

/** Report the actual CSS hit rectangle; the native host arbitrates click-through. */
export function useZenDragRegion(active: boolean, ref: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const bridge = window.desktopBridge?.zenMode;
    const element = ref.current;
    if (!active || !bridge || !element) return;
    let frame = 0;
    const report = () => {
      frame = 0;
      const rect = element.getBoundingClientRect();
      void bridge
        .setDragRegion({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        })
        .catch(() => {
          // Keep the grip interactive if host-side passthrough arbitration fails.
          void bridge.setPointerPassthrough(false).catch(() => {});
        });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(report);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    window.addEventListener("resize", schedule);
    report();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
      void bridge.setDragRegion(null).catch(() => {});
    };
  }, [active, ref]);
}
