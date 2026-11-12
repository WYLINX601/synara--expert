export const ZEN_MODE_COMPACT_MIN_HEIGHT = 96;
export const ZEN_MODE_COMPACT_MAX_HEIGHT = 600;

/** Native state for the compact, single-window Zen composer mode. */
export interface ZenModeState {
  isActive: boolean;
  isBubble: boolean;
  expanded: boolean;
  alwaysOnTop: boolean;
  shortcut: string;
  shortcutAvailable: boolean;
}

/** Available native drag surface, in renderer CSS pixels relative to the content viewport. */
export interface ZenModeDragRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Atomic capability: a host exposing a bubble must also provide recovery and hiding. */
export interface ZenModeBubbleDesktopMethods {
  collapse: () => Promise<void>;
  restore: () => Promise<void>;
  hide: () => Promise<void>;
}

/** Optional Electron bridge for entering and controlling Zen mode. */
export interface ZenModeDesktopMethods {
  getState: () => Promise<ZenModeState>;
  enter: () => Promise<void>;
  exit: () => Promise<void>;
  setExpanded: (expanded: boolean) => Promise<void>;
  setCompactHeight: (contentHeight: number) => Promise<void>;
  setPointerPassthrough: (ignore: boolean) => Promise<void>;
  setDragRegion: (region: ZenModeDragRegion | null) => Promise<void>;
  bubble?: ZenModeBubbleDesktopMethods;
  onStateChanged: (listener: (state: ZenModeState) => void) => () => void;
  onToggleRequested: (listener: () => void) => () => void;
}
