import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZenModeState } from "@synara/contracts";
import { ZEN_MODE_COMPACT_MAX_HEIGHT, ZEN_MODE_COMPACT_MIN_HEIGHT } from "@synara/contracts";
import {
  ZEN_MODE_DEFAULT_WIDTH,
  ZEN_MODE_EXPANDED_HEIGHT,
  ZEN_MODE_INITIAL_COMPACT_HEIGHT,
  ZEN_MODE_MIN_WIDTH,
  ZEN_MODE_SHORTCUT,
  ZenModeManager,
  type ZenModeWindow,
} from "./zenModeManager";
import type { DesktopWindowBounds } from "./windowState";

const workArea: DesktopWindowBounds = { x: 0, y: 0, width: 1920, height: 1040 };
const nativeFrame = { width: 16, height: 56 };

class FakeWindow implements ZenModeWindow {
  destroyed = false;
  maximized = false;
  minimized = false;
  fullScreen = false;
  resizable = true;
  alwaysOnTop = false;
  minimumSize = [840, 620];
  maximumSize = [0, 0];
  bounds: DesktopWindowBounds = { x: 100, y: 200, width: 1100, height: 800 };
  normalBounds = { ...this.bounds };
  failRestoreBounds = false;
  failZenBounds = false;

  isDestroyed(): boolean {
    return this.destroyed;
  }

  getBounds(): DesktopWindowBounds {
    return { ...this.bounds };
  }

  getNormalBounds(): DesktopWindowBounds {
    return { ...this.normalBounds };
  }

  getContentSize(): number[] {
    return [this.bounds.width - nativeFrame.width, this.bounds.height - nativeFrame.height];
  }

  isMaximized(): boolean {
    return this.maximized;
  }

  isMinimized(): boolean {
    return this.minimized;
  }

  isFullScreen(): boolean {
    return this.fullScreen;
  }

  isResizable(): boolean {
    return this.resizable;
  }

  isAlwaysOnTop(): boolean {
    return this.alwaysOnTop;
  }

  getMinimumSize(): number[] {
    return [...this.minimumSize];
  }

  getMaximumSize(): number[] {
    return [...this.maximumSize];
  }

  setBounds(bounds: DesktopWindowBounds): void {
    if (this.failZenBounds && bounds.width < 1100) {
      this.bounds = { ...bounds };
      this.normalBounds = { ...bounds };
      throw new Error("synthetic Zen resize failure");
    }
    if (this.failRestoreBounds && bounds.width === 1100) {
      throw new Error("synthetic restore failure");
    }
    this.bounds = { ...bounds };
    if (!this.maximized && !this.fullScreen && !this.minimized) {
      this.normalBounds = { ...bounds };
    }
  }

  setMinimumSize(width: number, height: number): void {
    this.minimumSize = [width, height];
  }

  setMaximumSize(width: number, height: number): void {
    this.maximumSize = [width, height];
  }

  setResizable(resizable: boolean): void {
    this.resizable = resizable;
  }

  setAlwaysOnTop(alwaysOnTop: boolean): void {
    this.alwaysOnTop = alwaysOnTop;
  }

  maximize(): void {
    this.maximized = true;
  }

  unmaximize(): void {
    this.maximized = false;
    this.bounds = { ...this.normalBounds };
  }

  minimize(): void {
    this.minimized = true;
  }

  restore(): void {
    this.minimized = false;
    this.bounds = { ...this.normalBounds };
  }

  setFullScreen(fullScreen: boolean): void {
    this.fullScreen = fullScreen;
  }
}

function fixture(
  input: {
    window?: FakeWindow;
    workAreas?: ReadonlyArray<DesktopWindowBounds>;
    shortcutRegisterResult?: boolean;
    setFullScreenAndWait?: (window: ZenModeWindow, fullScreen: boolean) => Promise<void>;
  } = {},
) {
  const window = input.window ?? new FakeWindow();
  const states: ZenModeState[] = [];
  const onToggleRequested = vi.fn();
  const setBrowserViewsZenMode = vi.fn();
  const setTrafficLightsVisible = vi.fn();
  const register = vi.fn(
    (_shortcut: string, _callback: () => void) => input.shortcutRegisterResult ?? true,
  );
  const unregister = vi.fn();
  const manager = new ZenModeManager({
    getWindow: () => (window.destroyed ? null : window),
    getDisplayWorkAreas: () => input.workAreas ?? [workArea],
    onStateChanged: (state) => states.push(state),
    onToggleRequested,
    setBrowserViewsZenMode,
    setTrafficLightsVisible,
    shortcutRegistry: { register, unregister },
    ...(input.setFullScreenAndWait ? { setFullScreenAndWait: input.setFullScreenAndWait } : {}),
  });
  return {
    manager,
    window,
    states,
    onToggleRequested,
    setBrowserViewsZenMode,
    setTrafficLightsVisible,
    register,
    unregister,
  };
}

afterEach(() => vi.useRealTimers());

describe("ZenModeManager", () => {
  it("enters on the existing window and restores its original window state", async () => {
    const window = new FakeWindow();
    window.maximized = true;
    window.resizable = false;
    window.alwaysOnTop = false;
    window.minimumSize = [840, 620];
    window.maximumSize = [1500, 1000];
    const original = window.getNormalBounds();
    const f = fixture({ window });

    await f.manager.enter();

    expect(f.manager.getState()).toMatchObject({
      isActive: true,
      expanded: false,
      alwaysOnTop: true,
      shortcut: ZEN_MODE_SHORTCUT,
    });
    expect(f.window.getBounds()).toEqual({ x: 282, y: 492, width: 736, height: 216 });
    expect(f.window.getMinimumSize()).toEqual([536, 152]);
    expect(f.window.getMaximumSize()).toEqual([0, 0]);
    expect(f.window.isResizable()).toBe(true);
    expect(f.setBrowserViewsZenMode).toHaveBeenLastCalledWith(f.window, true);
    expect(f.setTrafficLightsVisible).toHaveBeenLastCalledWith(f.window, false);
    expect(f.manager.getWindowStateForPersistence()).toEqual({
      bounds: original,
      isMaximized: true,
    });

    await f.manager.exit();

    expect(f.manager.getState().isActive).toBe(false);
    expect(f.window.getBounds()).toEqual(original);
    expect(f.window.isMaximized()).toBe(true);
    expect(f.window.isResizable()).toBe(false);
    expect(f.window.isAlwaysOnTop()).toBe(false);
    expect(f.window.getMinimumSize()).toEqual([840, 620]);
    expect(f.window.getMaximumSize()).toEqual([1500, 1000]);
    expect(f.setBrowserViewsZenMode).toHaveBeenLastCalledWith(f.window, false);
    expect(f.setTrafficLightsVisible).toHaveBeenLastCalledWith(f.window, true);
  });

  it("uses finite measured compact content height and keeps the bottom edge anchored", async () => {
    const f = fixture();
    await f.manager.enter();
    const initial = f.window.getBounds();
    const bottom = initial.y + initial.height;

    await f.manager.setCompactHeight(300.4);
    expect(f.window.getBounds()).toEqual({ ...initial, y: bottom - 356, height: 356 });
    await expect(f.manager.setCompactHeight(Number.NaN)).rejects.toThrow("finite number");
    await f.manager.setCompactHeight(1);
    expect(f.window.getBounds().height).toBe(ZEN_MODE_COMPACT_MIN_HEIGHT + nativeFrame.height);
    await f.manager.setCompactHeight(900);
    expect(f.window.getBounds().height).toBe(ZEN_MODE_COMPACT_MAX_HEIGHT + nativeFrame.height);
  });

  it("caches measurements while expanded and restores the latest compact height", async () => {
    const f = fixture();
    await f.manager.enter();
    await f.manager.setCompactHeight(240);
    await f.manager.setExpanded(true);
    const expandedBounds = f.window.getBounds();
    expect(expandedBounds.height).toBe(ZEN_MODE_EXPANDED_HEIGHT + nativeFrame.height);

    await f.manager.setCompactHeight(320);
    expect(f.window.getBounds()).toEqual(expandedBounds);
    await f.manager.setExpanded(false);
    expect(f.window.getBounds()).toEqual({
      ...expandedBounds,
      y: expandedBounds.y + expandedBounds.height - 320 - nativeFrame.height,
      height: 320 + nativeFrame.height,
    });
  });

  it("clamps compact and expanded bounds and minimum size to a small display", async () => {
    const smallArea = { x: -600, y: 20, width: 600, height: 350 };
    const f = fixture({ workAreas: [smallArea] });
    await f.manager.enter();
    expect(f.window.getBounds()).toEqual({ x: -600, y: 87, width: 600, height: 216 });
    expect(f.window.getMinimumSize()).toEqual([536, 152]);

    await f.manager.setExpanded(true);
    expect(f.window.getBounds()).toEqual({ x: -600, y: 20, width: 600, height: 350 });
    await f.manager.setExpanded(false);
    expect(f.window.getBounds().height).toBe(216);
    expect(ZEN_MODE_DEFAULT_WIDTH).toBe(720);
    expect(ZEN_MODE_MIN_WIDTH).toBe(520);
  });

  it("restores off-screen original bounds to a visible work area and clamps minimum constraints", async () => {
    const window = new FakeWindow();
    window.bounds = { x: 4000, y: 3000, width: 1100, height: 800 };
    window.normalBounds = { ...window.bounds };
    const smallArea = { x: 0, y: 0, width: 600, height: 350 };
    const f = fixture({ window, workAreas: [smallArea] });
    await f.manager.enter();
    await f.manager.exit();
    expect(f.window.getBounds()).toEqual(smallArea);
    expect(f.window.getMinimumSize()).toEqual([600, 350]);
  });

  it("waits for fullscreen transitions and restores maximized/fullscreen/minimized state", async () => {
    const window = new FakeWindow();
    window.fullScreen = true;
    window.minimized = true;
    const fullScreenChanges: boolean[] = [];
    const f = fixture({
      window,
      setFullScreenAndWait: async (target, fullScreen) => {
        fullScreenChanges.push(fullScreen);
        await Promise.resolve();
        (target as FakeWindow).setFullScreen(fullScreen);
      },
    });
    await f.manager.enter();
    expect(window.isFullScreen()).toBe(false);
    expect(window.isMinimized()).toBe(false);
    await f.manager.exit();
    expect(fullScreenChanges).toEqual([false, true]);
    expect(window.isFullScreen()).toBe(true);
    expect(window.isMinimized()).toBe(true);
  });

  it("keeps normal geometry available to close persistence during async entry", async () => {
    const window = new FakeWindow();
    window.fullScreen = true;
    let finishTransition!: () => void;
    let didStart!: () => void;
    const started = new Promise<void>((resolve) => (didStart = resolve));
    const f = fixture({
      window,
      setFullScreenAndWait: async (target, fullScreen) => {
        if (!fullScreen) {
          didStart();
          await new Promise<void>((resolve) => (finishTransition = resolve));
        }
        (target as FakeWindow).setFullScreen(fullScreen);
      },
    });
    const entering = f.manager.enter();
    await started;
    expect(f.manager.getWindowStateForPersistence()).toEqual({
      bounds: window.normalBounds,
      isMaximized: false,
    });
    finishTransition();
    await entering;
    f.manager.windowClosed();
    expect(f.manager.getState().isActive).toBe(false);
  });

  it("aborts a stale fullscreen entry on renderer reload without reentering after load", async () => {
    const window = new FakeWindow();
    window.fullScreen = true;
    let finishTransition!: () => void;
    let didStart!: () => void;
    const started = new Promise<void>((resolve) => (didStart = resolve));
    const f = fixture({
      window,
      setFullScreenAndWait: async (target, fullScreen) => {
        if (!fullScreen) {
          didStart();
          await new Promise<void>((resolve) => (finishTransition = resolve));
        }
        (target as FakeWindow).setFullScreen(fullScreen);
      },
    });
    const entering = f.manager.enter();
    await started;
    const reset = f.manager.resetForRendererReload();
    expect(f.manager.getState().isActive).toBe(false);
    finishTransition();
    await expect(entering).rejects.toThrow("window changed");
    await reset;
    expect(f.manager.getState().isActive).toBe(false);
    expect(f.window.getBounds()).toEqual(f.window.normalBounds);
    expect(f.setBrowserViewsZenMode).toHaveBeenLastCalledWith(f.window, false);
  });

  it("does not claim a conflicting shortcut and releases only its own registration", async () => {
    const blocked = fixture({ shortcutRegisterResult: false });
    expect(blocked.manager.registerShortcut()).toBe(false);
    expect(blocked.manager.getState().shortcutAvailable).toBe(false);
    blocked.register.mock.calls[0]?.[1]?.();
    expect(blocked.onToggleRequested).not.toHaveBeenCalled();
    await blocked.manager.dispose();
    expect(blocked.unregister).not.toHaveBeenCalled();

    const registered = fixture();
    expect(registered.manager.registerShortcut()).toBe(true);
    registered.register.mock.calls[0]?.[1]?.();
    expect(registered.onToggleRequested).toHaveBeenCalledOnce();
    await registered.manager.dispose();
    expect(registered.unregister).toHaveBeenCalledExactlyOnceWith(ZEN_MODE_SHORTCUT);
  });

  it("unregisters the shortcut even if native teardown restoration fails", async () => {
    const f = fixture();
    f.manager.registerShortcut();
    await f.manager.enter();
    f.window.failRestoreBounds = true;
    await expect(f.manager.dispose()).rejects.toThrow("synthetic restore failure");
    expect(f.unregister).toHaveBeenCalledExactlyOnceWith(ZEN_MODE_SHORTCUT);
    expect(f.manager.getState().shortcutAvailable).toBe(false);
  });

  it("retains normal persistence state when enter rollback fails so exit can retry", async () => {
    const window = new FakeWindow();
    const original = window.getNormalBounds();
    const f = fixture({ window });
    window.failZenBounds = true;
    window.failRestoreBounds = true;

    await expect(f.manager.enter()).rejects.toThrow("synthetic Zen resize failure");
    expect(f.manager.getState().isActive).toBe(true);
    expect(f.manager.getWindowStateForPersistence()).toEqual({
      bounds: original,
      isMaximized: false,
    });

    window.failZenBounds = false;
    window.failRestoreBounds = false;
    await f.manager.exit();
    expect(f.manager.getState().isActive).toBe(false);
    expect(f.window.getBounds()).toEqual(original);
  });
});
