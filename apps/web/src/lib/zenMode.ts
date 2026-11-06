import { ZEN_MODE_COMPACT_MIN_HEIGHT, ZEN_MODE_COMPACT_MAX_HEIGHT } from "@synara/contracts";

/** Zen is a presentation of the existing single chat, never a second runtime. */
export function zenModeEntryBlock(input: {
  threadId: string | null;
  splitViewId?: string | undefined;
  view?: string | undefined;
  terminal: boolean;
}): "choose-chat" | "unsupported" | null {
  if (!input.threadId) return "choose-chat";
  if (input.splitViewId || input.view === "editor" || input.terminal) return "unsupported";
  return null;
}

/** Both blocks include their own padding; their shared rail overlaps by one pixel. */
export function zenCompactHeight(
  toolbarHeight: number,
  composerHeight: number,
): number | undefined {
  if (
    !Number.isFinite(toolbarHeight) ||
    !Number.isFinite(composerHeight) ||
    toolbarHeight <= 0 ||
    composerHeight <= 0
  )
    return undefined;
  return Math.min(
    ZEN_MODE_COMPACT_MAX_HEIGHT,
    Math.max(ZEN_MODE_COMPACT_MIN_HEIGHT, Math.ceil(toolbarHeight + composerHeight)),
  );
}
