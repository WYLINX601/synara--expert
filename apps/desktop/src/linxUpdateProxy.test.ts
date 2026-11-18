import { describe, expect, it } from "vitest";
import { parseMacSystemProxy } from "./linxUpdateProxy";

const explicitHttpProxy = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : *.local
  }
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 7897
  SOCKSProxy : 127.0.0.1
}`;

describe("macOS system proxy", () => {
  it("prefers the explicit HTTPS proxy", () => {
    expect(parseMacSystemProxy(explicitHttpProxy)).toEqual({
      proxyUrl: "http://127.0.0.1:7897",
      pacEnabled: false,
    });
  });

  it("falls back to HTTP and SOCKS entries", () => {
    expect(
      parseMacSystemProxy(`HTTPEnable : 1\nHTTPProxy : 10.0.0.1\nHTTPPort : 8080\n`).proxyUrl,
    ).toBe("http://10.0.0.1:8080");
    expect(
      parseMacSystemProxy(`SOCKSEnable : 1\nSOCKSProxy : 10.0.0.2\nSOCKSPort : 1080\n`).proxyUrl,
    ).toBe("socks5://10.0.0.2:1080");
  });

  it("reports PAC instead of inventing a proxy", () => {
    expect(
      parseMacSystemProxy(`ProxyAutoConfigEnable : 1\nProxyAutoConfigURLString : http://x\n`),
    ).toEqual({ proxyUrl: null, pacEnabled: true });
  });

  it("ignores disabled or malformed entries", () => {
    expect(parseMacSystemProxy(`HTTPEnable : 0\nHTTPProxy : 10.0.0.1\nHTTPPort : 8080\n`)).toEqual({
      proxyUrl: null,
      pacEnabled: false,
    });
    expect(parseMacSystemProxy(`HTTPEnable : 1\nHTTPProxy : 10.0.0.1\nHTTPPort : nope\n`)).toEqual({
      proxyUrl: null,
      pacEnabled: false,
    });
  });
});
