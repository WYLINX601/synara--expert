import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blockedRequests, installNetworkBoundary } from "./networkBoundary";
import {
  ensureNativeApi,
  readNativeApi,
  readNativeApiServerCapability,
  onNativeApiServerCapabilitiesChange,
} from "./nativeApiBoundary";

describe("prototype isolation", () => {
  beforeEach(() => {
    blockedRequests.length = 0;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fails closed at every imported native API entry", () => {
    for (const read of [
      ensureNativeApi,
      readNativeApi,
      readNativeApiServerCapability,
      onNativeApiServerCapabilitiesChange,
    ])
      expect(read).toThrow(/交互原型禁止/);
  });

  function fixture() {
    const fetch = vi.fn().mockResolvedValue(new Response("asset"));
    const socket = vi.fn();
    class Socket {
      readonly url: string;
      constructor(url: string | URL, protocols?: string | string[]) {
        this.url = String(url);
        socket(url, protocols);
      }
    }
    class Xhr {
      open() {}
    }
    const page = {
      fetch,
      location: {
        href: "http://127.0.0.1:17736/",
        origin: "http://127.0.0.1:17736",
        host: "127.0.0.1:17736",
      },
      WebSocket: Socket,
      EventSource: class {
        readonly readyState = 0;
      },
    };
    const beacon = { sendBeacon: vi.fn() };
    vi.stubGlobal("window", page);
    vi.stubGlobal("XMLHttpRequest", Xhr);
    vi.stubGlobal("navigator", beacon);
    installNetworkBoundary();
    return { page, fetch, socket, beacon, Xhr };
  }

  it("permits only same-origin asset GETs and blocks business and external fetches", async () => {
    const { page, fetch } = fixture();
    await page.fetch("/assets/app.css");
    expect(fetch).toHaveBeenCalledOnce();
    await expect(page.fetch("/api/settings")).rejects.toThrow(/已阻止/);
    await expect(page.fetch("https://example.com/assets/app.css")).rejects.toThrow(/已阻止/);
    await expect(page.fetch("/assets/app.css", { method: "POST" })).rejects.toThrow(/已阻止/);
    expect(fetch).toHaveBeenCalledOnce();
    expect(blockedRequests).toHaveLength(3);
  });

  it("allows local Vite HMR and blocks business sockets, XHR, events and beacons", () => {
    const { page, socket, beacon, Xhr } = fixture();
    const hmrSocket = new page.WebSocket("ws://127.0.0.1:17736/", "vite-hmr");
    expect(hmrSocket.url).toBe("ws://127.0.0.1:17736/");
    expect(socket).toHaveBeenCalledOnce();
    expect(() => new page.WebSocket("ws://127.0.0.1:17736/ws")).toThrow(/已阻止/);
    expect(() => new page.WebSocket("ws://127.0.0.1:17734/", "vite-hmr")).toThrow(/已阻止/);
    expect(() => new Xhr().open()).toThrow(/已阻止/);
    expect(() => new page.EventSource()).toThrow(/已阻止/);
    expect(() => beacon.sendBeacon()).toThrow(/已阻止/);
    expect(socket).toHaveBeenCalledOnce();
    expect(blockedRequests).toHaveLength(5);
  });
});
