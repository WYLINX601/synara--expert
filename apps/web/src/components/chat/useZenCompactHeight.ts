import { useEffect, useRef, type RefObject } from "react";

import { ZEN_MODE_COMPACT_MAX_HEIGHT } from "@synara/contracts";
import {
  NATIVE_SURFACE_MENU_OVERLAY_SELECTOR,
  NATIVE_SURFACE_COMPACT_POPOVER_SELECTOR,
  NATIVE_SURFACE_OCCLUSION_SYNC_EVENT,
} from "~/lib/nativeSurfaceOcclusion";
import { zenCompactHeight } from "~/lib/zenMode";

/** Measures only intrinsic blocks, never the viewport-sized chat/transcript flex boxes. */
export function useZenCompactHeight(input: {
  active: boolean;
  layoutKey: boolean;
  inlineOverlayOpen: boolean;
  composerRef: RefObject<HTMLFormElement | null>;
  onHeightChange: (height: number) => Promise<void>;
}) {
  const { active, layoutKey, inlineOverlayOpen, composerRef, onHeightChange } = input;
  const inlineOverlayOpenRef = useRef(inlineOverlayOpen);
  const scheduleRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!active) return;
    const composer = composerRef.current;
    if (!composer) return;
    let disposed = false;
    let frame = 0;
    let lastReported: number | undefined;
    let latest: number | undefined;
    let inFlight = false;
    const flush = () => {
      if (disposed || inFlight || latest === undefined || latest === lastReported) return;
      const height = latest;
      lastReported = height;
      inFlight = true;
      // One request in flight; rapid intrinsic changes collapse to the latest height.
      // Failed reports are surfaced by the provider and retried only after a new
      // measurement or a new compact session, never in a rejection loop.
      void onHeightChange(height)
        .catch(() => {})
        .finally(() => {
          inFlight = false;
          flush();
        });
    };
    const measure = () => {
      frame = 0;
      if (disposed) return;
      const overlayOpen =
        inlineOverlayOpenRef.current ||
        Boolean(
          document.querySelector(
            `${NATIVE_SURFACE_MENU_OVERLAY_SELECTOR}[data-open], ${NATIVE_SURFACE_COMPACT_POPOVER_SELECTOR}[data-open], [data-slot='dialog-popup'][data-open], [data-slot='command-dialog-popup'][data-open], [data-slot='alert-dialog-popup'][data-open], [data-slot='sheet-popup'][data-open]`,
          ),
        );
      // Portal/absolute panels need space but their collision-limited height must
      // never feed back into window sizing. Pure tooltips are not in this selector.
      const chat = composer.closest<HTMLElement>("[data-zen-chat]");
      const chatStyle = chat ? getComputedStyle(chat) : null;
      const edgeClearance = chatStyle
        ? Number.parseFloat(chatStyle.paddingTop) + Number.parseFloat(chatStyle.paddingBottom)
        : 0;
      latest = overlayOpen
        ? ZEN_MODE_COMPACT_MAX_HEIGHT
        : zenCompactHeight(
            edgeClearance, // Stable top disclosure and bottom native-drag clearances.
            composer.getBoundingClientRect().height,
          );
      flush();
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    scheduleRef.current = schedule;
    window.addEventListener(NATIVE_SURFACE_OCCLUSION_SYNC_EVENT, schedule);
    observer?.observe(composer);
    const portals = new MutationObserver(schedule);
    portals.observe(document.body, { childList: true });
    schedule();
    return () => {
      disposed = true;
      scheduleRef.current = () => {};
      window.removeEventListener(NATIVE_SURFACE_OCCLUSION_SYNC_EVENT, schedule);
      observer?.disconnect();
      portals.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [active, layoutKey, composerRef, onHeightChange]);
  useEffect(() => {
    inlineOverlayOpenRef.current = inlineOverlayOpen;
    scheduleRef.current();
  }, [inlineOverlayOpen]);
}
