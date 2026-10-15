// The Vite HMR connection is the only allowed socket. Business transports fail closed.
export const blockedRequests: string[] = [];

function rejectRequest(label: string): never {
  blockedRequests.push(label);
  throw new Error(`交互原型已阻止业务网络请求：${label}`);
}

export function installNetworkBoundary() {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const isAsset =
      /^\/(?:src\/|assets\/|@|node_modules\/|central-icons-|app-icons\/|favicon|synara-logo)/.test(
        url.pathname,
      );
    if (url.origin !== window.location.origin || method !== "GET" || !isAsset) {
      return Promise.reject(new Error(`交互原型已阻止业务请求：${url.pathname}`)).finally(() => {
        blockedRequests.push(`${method} ${url.origin}${url.pathname}`);
      });
    }
    return nativeFetch(input, init);
  };
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = class PrototypeWebSocket extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      const target = new URL(String(url), window.location.href);
      const isHmr = protocols === "vite-hmr" && target.host === window.location.host;
      if (!isHmr) rejectRequest(`WebSocket ${target.origin}${target.pathname}`);
      super(url, protocols);
    }
  };
  XMLHttpRequest.prototype.open = function () {
    rejectRequest("XMLHttpRequest");
  };
  window.EventSource = function BlockedEventSource() {
    rejectRequest("EventSource");
  } as unknown as typeof EventSource;
  navigator.sendBeacon = () => rejectRequest("sendBeacon");
}
