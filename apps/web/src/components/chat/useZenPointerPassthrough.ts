import { useEffect } from "react";
import { NATIVE_SURFACE_OCCLUSION_SYNC_EVENT } from "~/lib/nativeSurfaceOcclusion";

// Only painted interactive surfaces count. Full-window dialog viewports/backdrops
// and portal containers must not turn the transparent desktop into a hit target.
const ZEN_HIT_SURFACES = [
  "[data-zen-hit-surface]",
  "[data-thread-find-layout='panel']",
  "[data-slot='menu-popup']",
  "[data-slot='menu-sub-content']",
  "[data-slot='select-popup']",
  "[data-slot='combobox-popup']",
  "[data-slot='autocomplete-popup']",
  "[data-slot='command-dialog-popup']",
  "[data-slot='preview-card-popup']",
  "[data-slot='popover-popup']",
  "[data-slot='dialog-popup']",
  "[data-slot='sheet-popup']",
  "[data-slot='alert-dialog-popup']",
  "[data-slot='toast-popup']",
  "[data-zen-toast-surface]",
].join(",");

export function useZenPointerPassthrough(active: boolean) {
  useEffect(() => {
    const bridge = window.desktopBridge?.zenMode;
    if (!active || !bridge?.setPointerPassthrough) return;
    let disposed = false;
    let frame = 0;
    let point: { x: number; y: number } | undefined;
    let desired = false;
    let reported: boolean | undefined;
    let inFlight = false;
    const flush = () => {
      if (disposed || inFlight || desired === reported) return;
      const next = desired;
      reported = next;
      inFlight = true;
      let failed = false;
      void bridge
        .setPointerPassthrough(next)
        .catch(() => {
          failed = true;
          reported = undefined;
          // Fail interactive; a later pointer event can retry without an IPC loop.
          void bridge.setPointerPassthrough(false).catch(() => {});
        })
        .finally(() => {
          inFlight = false;
          if (disposed) {
            // A late IPC completion must not leave the normal workbench transparent.
            void bridge.setPointerPassthrough(false).catch(() => {});
          } else if (!failed) flush();
        });
    };
    const measure = () => {
      frame = 0;
      if (!point || disposed) return;
      desired = !document
        .elementsFromPoint(point.x, point.y)
        .some((element) => element.closest(ZEN_HIT_SURFACES));
      flush();
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const move = (event: MouseEvent) => {
      point = { x: event.clientX, y: event.clientY };
      schedule();
    };
    const resize = () => {
      // Native bottom-anchored resizing changes the window origin. Cached client
      // coordinates are stale until the next forwarded mousemove arrives.
      point = undefined;
      desired = false;
      flush();
    };
    // Electron's forwarding option sends mousemove while native click-through is on.
    window.addEventListener("mousemove", move, true);
    window.addEventListener("resize", resize);
    window.addEventListener(NATIVE_SURFACE_OCCLUSION_SYNC_EVENT, schedule);
    // Dialog portals do not broadcast the menu occlusion event. Observe only
    // body-level portal mounts, never streaming mutations under the app root.
    const portals = new MutationObserver(schedule);
    portals.observe(document.body, { childList: true });
    flush();
    return () => {
      portals.disconnect();
      disposed = true;
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("resize", resize);
      window.removeEventListener(NATIVE_SURFACE_OCCLUSION_SYNC_EVENT, schedule);
      if (frame) cancelAnimationFrame(frame);
      void bridge.setPointerPassthrough(false).catch(() => {});
    };
  }, [active]);
}
