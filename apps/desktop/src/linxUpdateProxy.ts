import { spawnProcessSync } from "@synara/shared/processRuntime";

export interface MacSystemProxy {
  readonly proxyUrl: string | null;
  readonly pacEnabled: boolean;
}

/** Parses the stable `scutil --proxy` key/value output without shell quoting. */
export function parseMacSystemProxy(output: string): MacSystemProxy {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*([A-Za-z0-9]+)\s*:\s*(.*?)\s*$/u.exec(line);
    if (match) values.set(match[1]!, match[2]!);
  }
  const enabled = (key: string): boolean => values.get(key) === "1";
  const proxy = (hostKey: string, portKey: string, scheme: string): string | null => {
    const host = values.get(hostKey);
    const port = values.get(portKey);
    if (!host || !port || !/^\d+$/u.test(port)) return null;
    return `${scheme}://${host}:${port}`;
  };

  const proxyUrl = enabled("HTTPSEnable")
    ? proxy("HTTPSProxy", "HTTPSPort", "http")
    : enabled("HTTPEnable")
      ? proxy("HTTPProxy", "HTTPPort", "http")
      : enabled("SOCKSEnable")
        ? proxy("SOCKSProxy", "SOCKSPort", "socks5")
        : null;
  return { proxyUrl, pacEnabled: enabled("ProxyAutoConfigEnable") };
}

function normalizeEnvironmentProxy(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "socks5:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/**
 * Returns the proxy Node transport should use. Environment variables win so
 * tests and explicit launches can override the desktop session. PAC scripts
 * are not evaluated here; an explicit HTTP/HTTPS/SOCKS proxy is required.
 */
export function resolveLinxUpdateProxyUrl(): string | null {
  const environment =
    normalizeEnvironmentProxy(process.env.HTTPS_PROXY) ??
    normalizeEnvironmentProxy(process.env.https_proxy) ??
    normalizeEnvironmentProxy(process.env.HTTP_PROXY) ??
    normalizeEnvironmentProxy(process.env.http_proxy) ??
    normalizeEnvironmentProxy(process.env.ALL_PROXY) ??
    normalizeEnvironmentProxy(process.env.all_proxy);
  if (environment) return environment;
  if (process.platform !== "darwin") return null;
  const result = spawnProcessSync("scutil", ["--proxy"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  return parseMacSystemProxy(result.stdout).proxyUrl;
}
