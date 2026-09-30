import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

import { synaraDesktopIdentity } from "@synara/shared/desktopIdentity";
import { assertLoopbackUrl } from "../computer-use-fixtures/packaged-client.ts";

export type RuntimeProbeOptions = {
  sourceSha: string;
  ownerUrl: string;
  instanceHome: string;
  outputDir: string;
  codexHome: string;
  piAgentDir: string;
  awaitServerRestart: boolean;
};

export type ParsedRuntimeProbeOptions = Omit<RuntimeProbeOptions, "ownerUrl"> & {
  ownerBaseUrl: string;
};

function required(values: Record<string, string | boolean | undefined>, name: string): string {
  const value = values[name];
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`Missing required option: --${name}.`);
  return value;
}

function knownSynaraHomes(userHome: string): string[] {
  const flavors = [
    "production",
    "development",
    "canary",
    "cua",
    "workbench",
    "workbench-preview",
  ] as const;
  return [
    ...flavors.map((flavor) =>
      resolve(userHome, synaraDesktopIdentity(flavor).defaultHomeDirectoryName),
    ),
    resolve(userHome, ".synara-beta"),
  ];
}

export function protectedUserProfilePaths(userHome: string): string[] {
  return [
    ...knownSynaraHomes(userHome),
    resolve(userHome, ".codex"),
    resolve(userHome, ".pi", "agent"),
  ];
}

/** Strict parser intentionally has no token argument; credentials are env-only. */
export function parseRuntimeProbeOptions(argv: ReadonlyArray<string>): ParsedRuntimeProbeOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      "source-sha": { type: "string" },
      "owner-url": { type: "string" },
      "instance-home": { type: "string" },
      "output-dir": { type: "string" },
      "codex-home": { type: "string" },
      "pi-agent-dir": { type: "string" },
      "await-server-restart": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const sourceSha = required(values, "source-sha");
  if (!/^[0-9a-f]{40}$/iu.test(sourceSha))
    throw new Error("--source-sha must be a full 40-character commit SHA.");
  const ownerBaseUrl = required(values, "owner-url");
  const rawPaths = {
    instanceHome: required(values, "instance-home"),
    outputDir: required(values, "output-dir"),
    codexHome: required(values, "codex-home"),
    piAgentDir: required(values, "pi-agent-dir"),
  };
  if (Object.values(rawPaths).some((path) => !isAbsolute(path)))
    throw new Error("Instance, output, and provider isolation paths must be absolute.");
  const instanceHome = resolve(rawPaths.instanceHome);
  const outputDir = resolve(rawPaths.outputDir);
  const codexHome = resolve(rawPaths.codexHome);
  const piAgentDir = resolve(rawPaths.piAgentDir);
  if (codexHome === piAgentDir)
    throw new Error("Codex home and Pi agent directory must be separate paths.");
  if (typeof values["await-server-restart"] !== "boolean")
    throw new Error("Invalid --await-server-restart value.");
  return {
    sourceSha: sourceSha.toLowerCase(),
    ownerBaseUrl,
    instanceHome,
    outputDir,
    codexHome,
    piAgentDir,
    awaitServerRestart: values["await-server-restart"],
  };
}

export function authenticatedOwnerUrl(rawBaseUrl: string, token: string | undefined): string {
  if (typeof token !== "string" || !/^[\x21-\x7e]+$/u.test(token))
    throw new Error("SYNARA_WORKBENCH_PROBE_OWNER_TOKEN must contain a printable token.");
  const url = assertLoopbackUrl(rawBaseUrl, "ws:");
  if (!url.port || url.search || url.hash || (url.pathname !== "" && url.pathname !== "/"))
    throw new Error("--owner-url must be a loopback ws URL with a port and no path or query.");
  url.pathname = "/";
  url.searchParams.set("token", token);
  return url.toString();
}

export function validateProbeInstanceHome(
  instanceHome: string,
  userHome: string,
  configuredHome?: string,
  protectedUserProfiles: ReadonlyArray<string> = [],
): void {
  const knownHomes = knownSynaraHomes(userHome);
  const actual = resolve(instanceHome);
  if (knownHomes.some((home) => contains(home, actual) || contains(actual, home)))
    throw new Error("Instance home must not use a current user Synara or Workbench profile.");
  if (configuredHome && (contains(configuredHome, actual) || contains(actual, configuredHome)))
    throw new Error("Instance home must not match the configured user Synara home.");
  if (protectedUserProfiles.some((home) => contains(home, actual) || contains(actual, home))) {
    throw new Error("Instance home overlaps a current user app or provider profile.");
  }
}

function contains(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

/** Lexical isolation checks run before any output or product state is created. */
export function validateProbePaths(input: {
  instanceHome: string;
  outputDir: string;
  codexHome: string;
  piAgentDir: string;
  repositoryRoot: string;
  userHome: string;
  protectedUserProfiles?: ReadonlyArray<string>;
}): void {
  const paths = [input.instanceHome, input.outputDir, input.codexHome, input.piAgentDir];
  if (paths.some((path) => !isAbsolute(path)))
    throw new Error("Instance, output, and provider isolation paths must be absolute.");
  const instanceHome = resolve(input.instanceHome);
  const outputDir = resolve(input.outputDir);
  const codexHome = resolve(input.codexHome);
  const piAgentDir = resolve(input.piAgentDir);
  if (contains(input.repositoryRoot, instanceHome))
    throw new Error("Instance home must be outside the source checkout.");
  if (contains(input.repositoryRoot, outputDir))
    throw new Error("Probe output must be outside the source checkout.");
  if (contains(input.repositoryRoot, codexHome) || contains(input.repositoryRoot, piAgentDir))
    throw new Error("Provider isolation paths must be outside the source checkout.");
  if (
    contains(outputDir, codexHome) ||
    contains(codexHome, outputDir) ||
    contains(outputDir, piAgentDir) ||
    contains(piAgentDir, outputDir) ||
    contains(codexHome, piAgentDir) ||
    contains(piAgentDir, codexHome) ||
    contains(instanceHome, outputDir) ||
    contains(outputDir, instanceHome) ||
    contains(instanceHome, codexHome) ||
    contains(codexHome, instanceHome) ||
    contains(instanceHome, piAgentDir) ||
    contains(piAgentDir, instanceHome)
  ) {
    throw new Error("Instance, probe output, and provider isolation paths must not overlap.");
  }
  const knownProviderHomes = [
    resolve(input.userHome, ".codex"),
    resolve(input.userHome, ".pi", "agent"),
  ];
  if (
    knownProviderHomes.some(
      (home) =>
        contains(home, codexHome) ||
        contains(codexHome, home) ||
        contains(home, piAgentDir) ||
        contains(piAgentDir, home),
    )
  ) {
    throw new Error("Provider isolation paths must not use the default user profile directories.");
  }
  if (
    [...knownProviderHomes, ...knownSynaraHomes(input.userHome)].some(
      (home) => contains(home, outputDir) || contains(outputDir, home),
    )
  ) {
    throw new Error("Probe output must not use a current user Synara or provider profile.");
  }
  if (
    input.protectedUserProfiles?.some((home) =>
      [instanceHome, outputDir, codexHome, piAgentDir].some(
        (path) => contains(home, path) || contains(path, home),
      ),
    )
  ) {
    throw new Error("Probe paths overlap a current user app or provider profile.");
  }
}
