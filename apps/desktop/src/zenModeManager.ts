import {
  ZEN_MODE_COMPACT_MAX_HEIGHT,
  ZEN_MODE_COMPACT_MIN_HEIGHT,
  type ZenModeState,
} from "@synara/contracts";
import type { DesktopWindowBounds } from "./windowState";
import { resolveVisibleWindowBounds } from "./windowState";

export const ZEN_MODE_SHORTCUT = "CommandOrControl+Shift+Space";
export const ZEN_MODE_DEFAULT_WIDTH = 720;
export const ZEN_MODE_MIN_WIDTH = 520;
export const ZEN_MODE_INITIAL_COMPACT_HEIGHT = 160;
export const ZEN_MODE_EXPANDED_HEIGHT = 560;

type WindowSize = [number, number];

export interface ZenModeWindow {
  isDestroyed(): boolean;
  getBounds(): DesktopWindowBounds;
  getNormalBounds(): DesktopWindowBounds;
  getContentSize(): number[];
  isMaximized(): boolean;
  isMinimized(): boolean;
  isFullScreen(): boolean;
  isResizable(): boolean;
  isAlwaysOnTop(): boolean;
  isVisibleOnAllWorkspaces(): boolean;
  hasShadow(): boolean;
  getMinimumSize(): number[];
  getMaximumSize(): number[];
  setBounds(bounds: DesktopWindowBounds): void;
  setMinimumSize(width: number, height: number): void;
  setMaximumSize(width: number, height: number): void;
  setResizable(resizable: boolean): void;
  setAlwaysOnTop(alwaysOnTop: boolean): void;
  setVisibleOnAllWorkspaces(visible: boolean, options?: { visibleOnFullScreen?: boolean }): void;
  setHasShadow(hasShadow: boolean): void;
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void;
  maximize(): void;
  unmaximize(): void;
  minimize(): void;
  restore(): void;
  setFullScreen(fullScreen: boolean): void;
}

export interface ZenModeSnapshot {
  bounds: DesktopWindowBounds;
  isMaximized: boolean;
  isMinimized: boolean;
  isFullScreen: boolean;
  isResizable: boolean;
  isAlwaysOnTop: boolean;
  isVisibleOnAllWorkspaces: boolean;
  visibleOnFullScreen: boolean;
  hasShadow: boolean;
  minimumSize: WindowSize;
  maximumSize: WindowSize;
}

export interface ZenModeManagerOptions {
  platform: NodeJS.Platform;
  getWindow: () => ZenModeWindow | null;
  getDisplayWorkAreas: () => ReadonlyArray<DesktopWindowBounds>;
  onStateChanged: (state: ZenModeState) => void;
  onToggleRequested: () => void;
  setBrowserViewsZenMode: (window: ZenModeWindow, active: boolean) => void;
  setTrafficLightsVisible: (window: ZenModeWindow, visible: boolean) => void;
  getVisibleOnFullScreen: (window: ZenModeWindow) => boolean;
  setVisibleOnAllWorkspaces: (
    window: ZenModeWindow,
    visible: boolean,
    visibleOnFullScreen: boolean,
  ) => void;
  setZenWindowMaterial: (window: ZenModeWindow, active: boolean) => void;
  shortcutRegistry?: {
    register: (shortcut: string, callback: () => void) => boolean;
    unregister: (shortcut: string) => void;
  };
  setFullScreenAndWait?: (window: ZenModeWindow, fullScreen: boolean) => Promise<void>;
  shortcut?: string;
}

interface FrameSize {
  width: number;
  height: number;
}

function sizeFromNative(value: readonly number[]): WindowSize {
  const width = value[0] ?? 0;
  const height = value[1] ?? 0;
  return [
    Number.isFinite(width) && width >= 0 ? Math.round(width) : 0,
    Number.isFinite(height) && height >= 0 ? Math.round(height) : 0,
  ];
}

function frameSize(window: ZenModeWindow): FrameSize {
  const bounds = window.getBounds();
  const content = sizeFromNative(window.getContentSize());
  return {
    width: Math.max(0, bounds.width - content[0]),
    height: Math.max(0, bounds.height - content[1]),
  };
}

function intersectionArea(left: DesktopWindowBounds, right: DesktopWindowBounds): number {
  const width = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x),
  );
  const height = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
  );
  return width * height;
}

function workAreaFor(
  bounds: DesktopWindowBounds,
  workAreas: ReadonlyArray<DesktopWindowBounds>,
): DesktopWindowBounds | null {
  if (workAreas.length === 0) return null;
  let target = workAreas[0]!;
  let targetIntersection = intersectionArea(bounds, target);
  for (const area of workAreas.slice(1)) {
    const areaIntersection = intersectionArea(bounds, area);
    if (areaIntersection > targetIntersection) {
      target = area;
      targetIntersection = areaIntersection;
    }
  }
  return target;
}

function centerResize(
  bounds: DesktopWindowBounds,
  width: number,
  height: number,
): DesktopWindowBounds {
  return {
    x: Math.round(bounds.x + (bounds.width - width) / 2),
    y: Math.round(bounds.y + (bounds.height - height) / 2),
    width,
    height,
  };
}

function captureWindowState(
  window: ZenModeWindow,
  getVisibleOnFullScreen: (window: ZenModeWindow) => boolean,
): ZenModeSnapshot {
  return {
    bounds: window.getNormalBounds(),
    isMaximized: window.isMaximized(),
    isMinimized: window.isMinimized(),
    isFullScreen: window.isFullScreen(),
    isResizable: window.isResizable(),
    isAlwaysOnTop: window.isAlwaysOnTop(),
    isVisibleOnAllWorkspaces: window.isVisibleOnAllWorkspaces(),
    visibleOnFullScreen: getVisibleOnFullScreen(window),
    hasShadow: window.hasShadow(),
    minimumSize: sizeFromNative(window.getMinimumSize()),
    maximumSize: sizeFromNative(window.getMaximumSize()),
  };
}

/** Reversible native geometry and window-mode changes for the existing main window. */
export class ZenModeManager {
  readonly #options: ZenModeManagerOptions;
  readonly #shortcut: string;
  #snapshot: ZenModeSnapshot | null = null;
  #compactHeight = ZEN_MODE_INITIAL_COMPACT_HEIGHT;
  #expanded = false;
  #shortcutAvailable = false;
  #shortcutRegistered = false;
  #disposed = false;
  #rendererReloadResetPending = false;
  #operation: Promise<unknown> = Promise.resolve();
  #windowGeneration = 0;

  constructor(options: ZenModeManagerOptions) {
    this.#options = options;
    this.#shortcut = options.shortcut ?? ZEN_MODE_SHORTCUT;
  }

  getState(): ZenModeState {
    const window = this.#liveWindow();
    return {
      isActive: Boolean(window && this.#snapshot && !this.#rendererReloadResetPending),
      expanded: this.#expanded,
      alwaysOnTop: window?.isAlwaysOnTop() ?? false,
      shortcut: this.#shortcut,
      shortcutAvailable: this.#shortcutAvailable,
    };
  }

  /** Attempts only this accelerator; an occupied shortcut stays with its owner. */
  registerShortcut(): boolean {
    if (this.#disposed || this.#shortcutRegistered || !this.#options.shortcutRegistry) {
      return this.#shortcutAvailable;
    }
    try {
      const registered = this.#options.shortcutRegistry.register(this.#shortcut, () => {
        if (!this.#disposed && this.#shortcutRegistered) this.#options.onToggleRequested();
      });
      this.#shortcutAvailable = registered;
      this.#shortcutRegistered = registered;
    } catch {
      this.#shortcutAvailable = false;
      this.#shortcutRegistered = false;
    }
    this.#emitState();
    return this.#shortcutAvailable;
  }

  enter(): Promise<void> {
    if (this.#disposed) return Promise.reject(new Error("Zen mode manager is disposed."));
    return this.#enqueue(async () => {
      this.#assertNotDisposed();
      if (this.#snapshot) return;
      const window = this.#requireLiveWindow();
      const snapshot = captureWindowState(window, this.#options.getVisibleOnFullScreen);
      const generation = this.#windowGeneration;
      // Close-time persistence reads this before the first native transition begins.
      this.#snapshot = snapshot;
      this.#compactHeight = ZEN_MODE_INITIAL_COMPACT_HEIGHT;
      this.#expanded = false;
      this.#setBrowserViewsZenMode(window, true);
      try {
        if (snapshot.isFullScreen) await this.#setFullScreen(window, false);
        this.#assertCurrentWindow(window, generation);
        if (window.isMaximized()) window.unmaximize();
        if (window.isMinimized()) window.restore();
        this.#assertCurrentWindow(window, generation);

        this.#setTrafficLightsVisible(window, false);
        this.#setPointerPassthrough(window, false);
        this.#setZenWindowMaterial(window, true);
        this.#options.setVisibleOnAllWorkspaces(window, true, true);
        window.setHasShadow(false);
        const frame = frameSize(window);
        const initialBounds = centerResize(
          snapshot.bounds,
          ZEN_MODE_DEFAULT_WIDTH + frame.width,
          this.#compactHeight + frame.height,
        );
        window.setMaximumSize(0, 0);
        this.#applyZenMinimumSize(window, initialBounds, frame);
        window.setResizable(true);
        window.setAlwaysOnTop(true);
        window.setBounds(
          this.#visibleBounds(initialBounds, this.#zenMinimumSize(initialBounds, frame)),
        );
        this.#emitState();
      } catch (error) {
        await this.#rollbackEnter(window, snapshot);
        throw error;
      }
    });
  }

  exit(): Promise<void> {
    if (this.#disposed) return Promise.reject(new Error("Zen mode manager is disposed."));
    return this.#enqueue(async () => {
      this.#assertNotDisposed();
      await this.#restoreSnapshot();
    });
  }

  setExpanded(expanded: boolean): Promise<void> {
    if (this.#disposed) return Promise.reject(new Error("Zen mode manager is disposed."));
    return this.#enqueue(async () => {
      this.#assertNotDisposed();
      const window = this.#liveWindow();
      if (!window || !this.#snapshot || expanded === this.#expanded) return;
      const frame = frameSize(window);
      const requestedHeight = expanded ? ZEN_MODE_EXPANDED_HEIGHT : this.#compactHeight;
      const target = this.#resizeHeight(window.getBounds(), requestedHeight, frame);
      this.#applyZenMinimumSize(window, target, frame);
      window.setBounds(this.#visibleBounds(target, this.#zenMinimumSize(target, frame)));
      this.#expanded = expanded;
      this.#emitState();
    });
  }

  setCompactHeight(contentHeight: number): Promise<void> {
    if (!Number.isFinite(contentHeight)) {
      return Promise.reject(new Error("Zen mode height must be a finite number."));
    }
    if (this.#disposed) return Promise.reject(new Error("Zen mode manager is disposed."));
    return this.#enqueue(async () => {
      this.#assertNotDisposed();
      if (!this.#snapshot) return;
      this.#compactHeight = Math.max(
        ZEN_MODE_COMPACT_MIN_HEIGHT,
        Math.min(ZEN_MODE_COMPACT_MAX_HEIGHT, Math.round(contentHeight)),
      );
      if (this.#expanded) return;
      const window = this.#liveWindow();
      if (!window) return;
      const frame = frameSize(window);
      const target = this.#resizeHeight(window.getBounds(), this.#compactHeight, frame);
      this.#applyZenMinimumSize(window, target, frame);
      window.setBounds(this.#visibleBounds(target, this.#zenMinimumSize(target, frame)));
    });
  }

  /** Ignore native mouse input only while Zen is active; keep movement events flowing to Chromium. */
  setPointerPassthrough(ignore: boolean): Promise<void> {
    if (typeof ignore !== "boolean") {
      return Promise.reject(new Error("Invalid Zen mode pointer passthrough state."));
    }
    if (this.#disposed) return Promise.reject(new Error("Zen mode manager is disposed."));
    return this.#enqueue(() => {
      this.#assertNotDisposed();
      const window = this.#liveWindow();
      if (!window) return;
      if (ignore && (!this.#snapshot || this.#rendererReloadResetPending)) {
        throw new Error("Pointer passthrough is only available while Zen mode is active.");
      }
      // Only macOS currently combines a transparent Zen window with forwarded mousemove
      // events. Windows is intentionally opaque; Linux cannot forward the events needed to
      // leave a click-through region, so enabling ignore there could trap the user.
      if (ignore && this.#options.platform !== "darwin") return;
      this.#setPointerPassthrough(window, ignore);
    });
  }

  /** Return saved normal geometry while Zen is active, including in-flight entry. */
  getWindowStateForPersistence(): Pick<ZenModeSnapshot, "bounds" | "isMaximized"> | null {
    if (!this.#snapshot) return null;
    return { bounds: this.#snapshot.bounds, isMaximized: this.#snapshot.isMaximized };
  }

  /** Renderer reloads always return to normal mode; a new document must opt in again. */
  resetForRendererReload(): Promise<void> {
    this.#windowGeneration += 1;
    if (this.#disposed || !this.#snapshot) return Promise.resolve();
    this.#rendererReloadResetPending = true;
    this.#emitState();
    return this.#enqueue(async () => {
      try {
        await this.#restoreSnapshot();
      } finally {
        this.#rendererReloadResetPending = false;
        this.#emitState();
      }
    });
  }

  /** Clear mode state after the native window has actually gone away. */
  windowClosed(): void {
    const window = this.#liveWindow();
    if (window) this.#setPointerPassthrough(window, false);
    this.#windowGeneration += 1;
    this.#snapshot = null;
    this.#expanded = false;
    this.#compactHeight = ZEN_MODE_INITIAL_COMPACT_HEIGHT;
    this.#rendererReloadResetPending = false;
    this.#emitState();
  }

  dispose(): Promise<void> {
    if (this.#disposed) return this.#enqueue(async () => undefined);
    this.#disposed = true;
    this.#windowGeneration += 1;
    return this.#enqueue(async () => {
      let restoreError: unknown;
      try {
        await this.#restoreSnapshot(true);
      } catch (error) {
        restoreError = error;
      } finally {
        const window = this.#liveWindow();
        if (window) {
          this.#setBrowserViewsZenMode(window, false);
          this.#setTrafficLightsVisible(window, true);
        }
        this.#snapshot = null;
        this.#expanded = false;
        this.#compactHeight = ZEN_MODE_INITIAL_COMPACT_HEIGHT;
        this.unregisterShortcut();
        this.#shortcutAvailable = false;
        this.#emitState();
      }
      if (restoreError) throw restoreError;
    });
  }

  unregisterShortcut(): void {
    if (!this.#shortcutRegistered) return;
    try {
      this.#options.shortcutRegistry?.unregister(this.#shortcut);
    } catch {
      // Electron may already have released application shortcuts during shutdown.
    }
    this.#shortcutRegistered = false;
    this.#shortcutAvailable = false;
  }

  #enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const next = this.#operation.then(operation);
    this.#operation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  #liveWindow(): ZenModeWindow | null {
    const window = this.#options.getWindow();
    return window && !window.isDestroyed() ? window : null;
  }

  #requireLiveWindow(): ZenModeWindow {
    const window = this.#liveWindow();
    if (!window) throw new Error("The desktop window is unavailable.");
    return window;
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error("Zen mode manager is disposed.");
  }

  #assertCurrentWindow(window: ZenModeWindow, generation: number): void {
    if (
      generation !== this.#windowGeneration ||
      this.#liveWindow() !== window ||
      window.isDestroyed()
    ) {
      throw new Error("The desktop window changed during the Zen mode transition.");
    }
  }

  async #setFullScreen(window: ZenModeWindow, fullScreen: boolean): Promise<void> {
    if (window.isFullScreen() === fullScreen) return;
    if (this.#options.setFullScreenAndWait) {
      await this.#options.setFullScreenAndWait(window, fullScreen);
    } else {
      window.setFullScreen(fullScreen);
    }
    if (!window.isDestroyed() && window.isFullScreen() !== fullScreen) {
      throw new Error(`The desktop window did not ${fullScreen ? "enter" : "leave"} full screen.`);
    }
  }

  #resizeHeight(
    currentBounds: DesktopWindowBounds,
    contentHeight: number,
    frame: FrameSize,
  ): DesktopWindowBounds {
    const targetHeight = Math.round(contentHeight + frame.height);
    return {
      x: currentBounds.x,
      y: currentBounds.y + currentBounds.height - targetHeight,
      width: currentBounds.width,
      height: targetHeight,
    };
  }

  #zenMinimumSize(bounds: DesktopWindowBounds, frame: FrameSize): WindowSize {
    const area = workAreaFor(bounds, this.#options.getDisplayWorkAreas());
    const width = ZEN_MODE_MIN_WIDTH + frame.width;
    const height = ZEN_MODE_COMPACT_MIN_HEIGHT + frame.height;
    return area ? [Math.min(width, area.width), Math.min(height, area.height)] : [width, height];
  }

  #applyZenMinimumSize(window: ZenModeWindow, bounds: DesktopWindowBounds, frame: FrameSize): void {
    const [width, height] = this.#zenMinimumSize(bounds, frame);
    window.setMinimumSize(width, height);
  }

  #visibleBounds(bounds: DesktopWindowBounds, minimumSize: WindowSize): DesktopWindowBounds {
    return resolveVisibleWindowBounds({
      savedBounds: bounds,
      displayWorkAreas: this.#options.getDisplayWorkAreas(),
      minimumWidth: minimumSize[0],
      minimumHeight: minimumSize[1],
    });
  }

  async #rollbackEnter(window: ZenModeWindow, snapshot: ZenModeSnapshot): Promise<void> {
    let restored = false;
    try {
      this.#setPointerPassthrough(window, false);
      if (this.#liveWindow() === window) {
        await this.#restoreWindow(window, snapshot);
        restored = true;
      }
    } catch {
      // Retain the recovery snapshot; a later exit or close still needs normal bounds.
    } finally {
      this.#setPointerPassthrough(window, false);
      this.#setZenWindowMaterial(window, false);
    }
    if (restored) {
      if (this.#snapshot === snapshot) this.#snapshot = null;
      this.#expanded = false;
      this.#compactHeight = ZEN_MODE_INITIAL_COMPACT_HEIGHT;
      this.#setBrowserViewsZenMode(window, false);
      this.#setTrafficLightsVisible(window, true);
    } else if (window.isDestroyed() && this.#snapshot === snapshot) {
      this.#snapshot = null;
      this.#expanded = false;
      this.#compactHeight = ZEN_MODE_INITIAL_COMPACT_HEIGHT;
    }
    this.#emitState();
  }

  async #restoreSnapshot(disposeAfter = false): Promise<void> {
    const snapshot = this.#snapshot;
    if (!snapshot) return;
    const window = this.#liveWindow();
    if (!window) {
      this.#snapshot = null;
      this.#expanded = false;
      this.#compactHeight = ZEN_MODE_INITIAL_COMPACT_HEIGHT;
      this.#emitState();
      return;
    }

    try {
      this.#setPointerPassthrough(window, false);
      await this.#restoreWindow(window, snapshot);
    } finally {
      this.#setPointerPassthrough(window, false);
      this.#setZenWindowMaterial(window, false);
    }
    this.#snapshot = null;
    this.#expanded = false;
    this.#compactHeight = ZEN_MODE_INITIAL_COMPACT_HEIGHT;
    this.#setTrafficLightsVisible(window, true);
    this.#setBrowserViewsZenMode(window, false);
    if (!disposeAfter) this.#emitState();
  }

  async #restoreWindow(window: ZenModeWindow, snapshot: ZenModeSnapshot): Promise<void> {
    if (window.isDestroyed()) return;
    if (window.isFullScreen()) await this.#setFullScreen(window, false);
    if (window.isDestroyed()) return;
    if (window.isMaximized()) window.unmaximize();
    if (window.isMinimized()) window.restore();
    window.setResizable(snapshot.isResizable);

    const workAreas = this.#options.getDisplayWorkAreas();
    const targetArea = workAreaFor(snapshot.bounds, workAreas);
    const minWidth = Math.min(
      snapshot.minimumSize[0],
      targetArea?.width ?? Number.POSITIVE_INFINITY,
    );
    const minHeight = Math.min(
      snapshot.minimumSize[1],
      targetArea?.height ?? Number.POSITIVE_INFINITY,
    );
    window.setMinimumSize(minWidth, minHeight);
    window.setMaximumSize(snapshot.maximumSize[0], snapshot.maximumSize[1]);

    const normalBounds = this.#visibleBounds(snapshot.bounds, [minWidth, minHeight]);
    window.setBounds(normalBounds);
    window.setAlwaysOnTop(snapshot.isAlwaysOnTop);
    this.#options.setVisibleOnAllWorkspaces(
      window,
      snapshot.isVisibleOnAllWorkspaces,
      snapshot.visibleOnFullScreen,
    );
    window.setHasShadow(snapshot.hasShadow);
    this.#setTrafficLightsVisible(window, true);

    if (snapshot.isMaximized) window.maximize();
    if (snapshot.isFullScreen) await this.#setFullScreen(window, true);
    if (snapshot.isMinimized) window.minimize();
  }

  #setBrowserViewsZenMode(window: ZenModeWindow, active: boolean): void {
    try {
      this.#options.setBrowserViewsZenMode(window, active);
    } catch {
      // Browser surfaces may already be tearing down with the main window.
    }
  }

  #setTrafficLightsVisible(window: ZenModeWindow, visible: boolean): void {
    try {
      this.#options.setTrafficLightsVisible(window, visible);
    } catch {
      // Window teardown can race the renderer or application quit path.
    }
  }

  #setPointerPassthrough(window: ZenModeWindow, ignore: boolean): void {
    try {
      window.setIgnoreMouseEvents(ignore, ignore ? { forward: true } : undefined);
    } catch (error) {
      if (ignore) {
        try {
          window.setIgnoreMouseEvents(false);
        } catch {
          // Preserve the original failure; a later state transition retries the reset.
        }
      }
      throw error;
    }
  }

  #setZenWindowMaterial(window: ZenModeWindow, active: boolean): void {
    try {
      this.#options.setZenWindowMaterial(window, active);
    } catch {
      if (active) {
        try {
          this.#options.setZenWindowMaterial(window, false);
        } catch {
          // Keep the outer failure; renderer reload or exit can retry material restoration.
        }
      }
      throw new Error("Failed to apply the native Zen window material state.");
    }
  }

  #emitState(): void {
    this.#options.onStateChanged(this.getState());
  }
}
