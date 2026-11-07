export const ZEN_MODE_COMPACT_MIN_HEIGHT = 96;
export const ZEN_MODE_COMPACT_MAX_HEIGHT = 600;

/** Native state for the compact, single-window Zen composer mode. */
export interface ZenModeState {
  isActive: boolean;
  expanded: boolean;
  alwaysOnTop: boolean;
  shortcut: string;
  shortcutAvailable: boolean;
}

/** Optional Electron bridge for entering and controlling Zen mode. */
export interface ZenModeDesktopMethods {
  getState: () => Promise<ZenModeState>;
  enter: () => Promise<void>;
  exit: () => Promise<void>;
  setExpanded: (expanded: boolean) => Promise<void>;
  setCompactHeight: (contentHeight: number) => Promise<void>;
  setPointerPassthrough: (ignore: boolean) => Promise<void>;
  onStateChanged: (listener: (state: ZenModeState) => void) => () => void;
  onToggleRequested: (listener: () => void) => () => void;
}
