/**
 * Exact-build compatibility for OMP's native ACP session construction during
 * registered Skill extraction.
 *
 * @module OmpSkillEvolutionCompat
 */
import { createHash, randomUUID } from "node:crypto";
import { chmod, readFile, realpath, writeFile } from "node:fs/promises";
import * as nodePath from "node:path";

import { SKILL_EVOLUTION_SYSTEM_PROMPT } from "../skillEvolutionConstraints.ts";
import { resolveOmpAcpIdleTaskCompatExecutablePath } from "./OmpAcpIdleTaskCompat.ts";

export const OMP_SKILL_EVOLUTION_COMPAT_VERSION = "v1" as const;
export const OMP_SKILL_EVOLUTION_COMPAT_BUNDLE_SHA256 =
  "c5d51fbb4d787035f3cec7b3579234de4c55b169574a094e2a672bb68970992d" as const;
export const OMP_SKILL_EVOLUTION_COMPAT_BUNDLE_SIZE = 17_638_974;
export const OMP_SKILL_EVOLUTION_COMPAT_CLI_VERSION = "18.12.1" as const;
export const OMP_SKILL_EVOLUTION_COMPAT_MARKER_TIMEOUT_MS = 3_000;
export const OMP_SKILL_EVOLUTION_COMPAT_MARKER_PREFIX =
  `SYNARA_OMP_ACP_SKILL_EVOLUTION_COMPAT ${OMP_SKILL_EVOLUTION_COMPAT_VERSION}` as const;

/** Exact observed OMP 18.12.1 ACP session factory. */
export const OMP_SKILL_EVOLUTION_FACTORY_ANCHOR =
  "let{session:d,setToolUIContext:u}=await e.createSession({...e.baseOptions,cwd:t,sessionManager:i,settings:r,authStorage:e.authStorage,modelRegistry:e.modelRegistry,agentId:o,interactivePrompts:n?.interactivePrompts,deferUsageReserveConfirmation:!0,enableMCP:!1,titleSystemPrompt:a,eventBus:l,preloadedExtensions:c});";

/** Exact per-request insertion that would add OMP's ambient date and private CWD to user text. */
export const OMP_SKILL_EVOLUTION_DATE_CWD_REMINDER_ANCHOR =
  "aXs.transform(vt,$yt(),K5(K.getCwd()))";

const OMP_SKILL_EVOLUTION_PRELOAD_FILENAME = "omp-skill-evolution-compat.mjs";

export interface OmpSkillEvolutionCompatLaunch {
  readonly bunExecutable: string;
  /** Canonical selected OMP CLI source path, passed directly to Bun. */
  readonly cliEntrypoint: string;
  readonly preloadPath: string;
  readonly sessionDir: string;
  /** Proves the exact source transform loaded during the --version probe. */
  readonly probeMarker: string;
  /** Proves the native session passed post-construction no-tool assertions. */
  readonly expectedMarker: string;
}

export interface OmpSkillEvolutionCompatPreparationInput {
  readonly cliBinaryPath: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly privateTempDirectory: string;
  readonly sessionDir: string;
  readonly platform?: NodeJS.Platform;
}

export function makeOmpSkillEvolutionCompatArgs(
  launch: OmpSkillEvolutionCompatLaunch,
  cliArgs: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return ["--preload", launch.preloadPath, launch.cliEntrypoint, ...cliArgs];
}

/**
 * Resolve and verify the selected OMP CLI, then write a private Bun preload.
 * No account configuration or credential files are read or copied.
 */
export async function prepareOmpSkillEvolutionCompat(
  input: OmpSkillEvolutionCompatPreparationInput,
): Promise<OmpSkillEvolutionCompatLaunch> {
  const platform = input.platform ?? process.platform;
  const cliEntrypoint = resolveSelectedOmpEntrypoint(
    input.cliBinaryPath,
    input.cwd,
    input.env,
    platform,
  );
  const sourcePath = await realpath(cliEntrypoint).catch(() => undefined);
  if (!sourcePath) {
    throw new Error(
      "OMP Skill extraction compatibility cannot verify the selected CLI entry point.",
    );
  }
  const source = await readFile(sourcePath);
  verifyOmpSkillEvolutionBundle(source);
  if (source.subarray(0, source.indexOf(0x0a)).toString("utf8") !== "#!/usr/bin/env bun") {
    throw new Error("OMP Skill extraction compatibility requires the verified Bun CLI shebang.");
  }

  const bunExecutable = resolveOmpAcpIdleTaskCompatExecutablePath(
    "bun",
    input.cwd,
    input.env,
    platform,
  );
  if (!bunExecutable) {
    throw new Error(
      "OMP Skill extraction compatibility cannot resolve Bun from the selected account PATH.",
    );
  }

  const privateTempDirectory = input.privateTempDirectory.trim();
  const sessionDir = input.sessionDir.trim();
  if (!privateTempDirectory || !sessionDir) {
    throw new Error(
      "OMP Skill extraction compatibility requires owned preload and session directories.",
    );
  }
  const preloadPath = nodePath.join(privateTempDirectory, OMP_SKILL_EVOLUTION_PRELOAD_FILENAME);
  const nonce = randomUUID().replaceAll("-", "");
  const marker = makeOmpSkillEvolutionCompatMarker(nonce);
  const probeMarker = `${marker} phase=source-verified`;
  const expectedMarker = `${marker} phase=session-verified`;
  const preload = buildOmpSkillEvolutionCompatPreload(sourcePath, probeMarker, expectedMarker);
  await writeFile(preloadPath, preload, { encoding: "utf8", mode: 0o400, flag: "wx" });
  await chmod(preloadPath, 0o400).catch(() => {});
  return {
    bunExecutable,
    cliEntrypoint: sourcePath,
    preloadPath,
    sessionDir,
    probeMarker,
    expectedMarker,
  };
}

export function makeOmpSkillEvolutionCompatMarker(nonce: string): string {
  if (!/^[a-f0-9]{32}$/u.test(nonce)) {
    throw new Error("OMP Skill extraction compatibility marker requires a 128-bit nonce.");
  }
  return `${OMP_SKILL_EVOLUTION_COMPAT_MARKER_PREFIX} nonce=${nonce} sha256=${OMP_SKILL_EVOLUTION_COMPAT_BUNDLE_SHA256}`;
}

export function verifyOmpSkillEvolutionCompatProbe(input: {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly expectedMarker: string;
}): boolean {
  return (
    input.exitCode === 0 &&
    input.stdout.trim() === `omp/${OMP_SKILL_EVOLUTION_COMPAT_CLI_VERSION}` &&
    input.stderr.split(/\r?\n/u).some((line) => line.trim() === input.expectedMarker)
  );
}

export function verifyOmpSkillEvolutionBundle(
  source: Uint8Array,
  expected: { readonly sha256?: string; readonly size?: number } = {},
): void {
  const expectedSha256 = expected.sha256 ?? OMP_SKILL_EVOLUTION_COMPAT_BUNDLE_SHA256;
  const expectedSize = expected.size ?? OMP_SKILL_EVOLUTION_COMPAT_BUNDLE_SIZE;
  if (source.byteLength !== expectedSize) {
    throw new Error("OMP Skill extraction compatibility does not support this CLI bundle size.");
  }
  const actualSha256 = createHash("sha256").update(source).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error("OMP Skill extraction compatibility does not support this CLI bundle hash.");
  }
  const text = Buffer.from(source).toString("utf8");
  if (
    countOccurrences(text, OMP_SKILL_EVOLUTION_FACTORY_ANCHOR) !== 1 ||
    countOccurrences(text, OMP_SKILL_EVOLUTION_DATE_CWD_REMINDER_ANCHOR) !== 1
  ) {
    throw new Error(
      "OMP Skill extraction compatibility requires one exact ACP factory and date/CWD reminder anchor.",
    );
  }
}

/** Testable source transform used by the private preload's onLoad callback. */
export function transformVerifiedOmpSkillEvolutionBundle(
  source: string,
  expected: { readonly sha256?: string; readonly size?: number } = {},
  marker = makeOmpSkillEvolutionCompatMarker("00000000000000000000000000000000"),
): string {
  if (!isOmpSkillEvolutionCompatMarker(marker)) {
    throw new Error(
      "OMP Skill extraction compatibility marker does not match the expected format.",
    );
  }
  const bytes = Buffer.from(source, "utf8");
  verifyOmpSkillEvolutionBundle(bytes, expected);
  return (
    source
      .replace(OMP_SKILL_EVOLUTION_FACTORY_ANCHOR, makeFactoryReplacement(marker))
      // This executable is dedicated to the registered extraction purpose. Keep
      // its provider request free of OMP's per-request ambient date/CWD user text.
      .replace(OMP_SKILL_EVOLUTION_DATE_CWD_REMINDER_ANCHOR, "vt")
  );
}

export function buildOmpSkillEvolutionCompatPreload(
  sourcePath: string,
  probeMarker: string,
  expectedMarker: string,
): string {
  if (
    !probeMarker.endsWith(" phase=source-verified") ||
    !expectedMarker.endsWith(" phase=session-verified") ||
    !isOmpSkillEvolutionCompatMarker(probeMarker.replace(/ phase=source-verified$/u, "")) ||
    !isOmpSkillEvolutionCompatMarker(expectedMarker.replace(/ phase=session-verified$/u, "")) ||
    probeMarker.replace(/ phase=source-verified$/u, "") !==
      expectedMarker.replace(/ phase=session-verified$/u, "")
  ) {
    throw new Error(
      "OMP Skill extraction compatibility markers do not share a verified nonce and hash.",
    );
  }
  const entryLiteral = JSON.stringify(sourcePath);
  const markerLiteral = JSON.stringify(probeMarker);
  const shaLiteral = JSON.stringify(OMP_SKILL_EVOLUTION_COMPAT_BUNDLE_SHA256);
  const anchorLiteral = JSON.stringify(OMP_SKILL_EVOLUTION_FACTORY_ANCHOR);
  const exactPathPattern = `^${sourcePath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`;
  const exactPathPatternLiteral = JSON.stringify(exactPathPattern);
  const replacement = makeFactoryReplacement(expectedMarker);
  return `import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";

const expectedPath = ${entryLiteral};
const expectedHash = ${shaLiteral};
const marker = ${markerLiteral};
const anchor = ${anchorLiteral};
const reminderAnchor = ${JSON.stringify(OMP_SKILL_EVOLUTION_DATE_CWD_REMINDER_ANCHOR)};

if(Bun.main!==expectedPath)throw new Error("OMP Skill extraction compatibility main entry changed before preload.");
let mainRealPath;
try{mainRealPath=await realpath(expectedPath)}catch{throw new Error("OMP Skill extraction compatibility main entry became unavailable before preload.")}
if(mainRealPath!==expectedPath)throw new Error("OMP Skill extraction compatibility main entry changed before preload.");

Bun.plugin({
  name: "synara-omp-acp-skill-evolution-compat-v1",
  setup(builder) {
    builder.onLoad({ filter: new RegExp(${exactPathPatternLiteral}) }, async ({ path }) => {
      let resolvedPath;
      try { resolvedPath = await realpath(path); }
      catch { throw new Error("OMP Skill extraction compatibility entry point became unavailable."); }
      if (resolvedPath !== expectedPath) throw new Error("OMP Skill extraction compatibility entry point changed after verification.");
      const bytes = Buffer.from(await Bun.file(path).arrayBuffer());
      if (bytes.byteLength !== ${OMP_SKILL_EVOLUTION_COMPAT_BUNDLE_SIZE} || createHash("sha256").update(bytes).digest("hex") !== expectedHash) {
        throw new Error("OMP Skill extraction compatibility source changed after verification.");
      }
      const source = bytes.toString("utf8");
      if (source.slice(0, source.indexOf("\\n")) !== "#!/usr/bin/env bun") throw new Error("OMP Skill extraction compatibility requires the verified Bun CLI shebang.");
      if (source.split(anchor).length - 1 !== 1) throw new Error("OMP Skill extraction compatibility session factory anchor changed.");
      if (source.split(reminderAnchor).length - 1 !== 1) throw new Error("OMP Skill extraction compatibility date/CWD reminder anchor changed.");
      const contents = source.replace(anchor, ${JSON.stringify(replacement)}).replace(reminderAnchor, "vt");
      process.stderr.write(marker + "\\n");
      return { contents, loader: "js" };
    });
  },
});
`;
}

function makeFactoryReplacement(marker: string): string {
  const promptLiteral = `[${stringifyAsciiJavaScriptString(SKILL_EVOLUTION_SYSTEM_PROMPT)}]`;
  const expectedPromptLiteral = stringifyAsciiJavaScriptString(SKILL_EVOLUTION_SYSTEM_PROMPT);
  const markerLiteral = JSON.stringify(marker);
  // The no-tool restriction does not disable OMP's capture controller, so pin and verify its settings too.
  return `if(!r||typeof r.overlay!=="function")throw new Error("OMP Skill extraction could not prepare a session-local Auto-Learn settings overlay.");
const synaraAutoLearnSettings=r.overlay({"autolearn.enabled":!1,"autolearn.autoContinue":!1});
const synaraAutoLearnRawValue=(id)=>synaraAutoLearnSettings.rawValue({id,segments:id.split("."),definition:{}});
if(!synaraAutoLearnSettings||typeof synaraAutoLearnSettings.rawValue!=="function"||synaraAutoLearnRawValue("autolearn.enabled")!==!1||synaraAutoLearnRawValue("autolearn.autoContinue")!==!1)throw new Error("OMP Skill extraction could not verify disabled native Auto-Learn settings.");
let{session:d,setToolUIContext:u}=await e.createSession({...e.baseOptions,cwd:t,sessionManager:i,settings:synaraAutoLearnSettings,authStorage:e.authStorage,modelRegistry:e.modelRegistry,agentId:o,interactivePrompts:n?.interactivePrompts,deferUsageReserveConfirmation:!0,enableMCP:!1,titleSystemPrompt:a,eventBus:l,preloadedExtensions:void 0,preloadedPreparedExtensions:[],preloadedExtensionPaths:[],disableExtensionDiscovery:!0,extensionRoots:void 0,additionalExtensionPaths:[],restrictToolNames:!0,toolNames:[],tools:[],customTools:[],customToolPaths:[],mcpTools:[],mcpManager:void 0,enableLsp:!1,enableIrc:!1,contextFiles:[],skills:[],rules:[],promptTemplates:[],additionalDirectories:[],spawns:"",systemPrompt:${promptLiteral},appendSystemPrompt:""});
const synaraAssertSkillEvolutionSession=()=>{const synaraActive=d.getActiveToolNames();const synaraEnabled=d.getEnabledToolNames();const synaraSystemPrompt=d.systemPrompt;if(!Array.isArray(synaraActive)||synaraActive.length!==0||!Array.isArray(synaraEnabled)||synaraEnabled.length!==0||!Array.isArray(synaraSystemPrompt)||synaraSystemPrompt.length!==1||synaraSystemPrompt[0]!==${expectedPromptLiteral})throw new Error("OMP Skill extraction session lost its verified no-tool prompt constraints.");};
try{synaraAssertSkillEvolutionSession();if(typeof d.prompt!=="function")throw new Error("OMP Skill extraction session has no native prompt method.");const synaraNativePrompt=d.prompt.bind(d);Object.defineProperty(d,"prompt",{configurable:true,writable:true,value:async(...synaraArgs)=>{synaraAssertSkillEvolutionSession();return await synaraNativePrompt(...synaraArgs);}});}catch(synaraCause){await d.dispose?.();throw synaraCause;}
process.stderr.write(${markerLiteral}+"\\n");`;
}

/** Keep the private preload source ASCII-only so Bun's injected module is byte-stable. */
function stringifyAsciiJavaScriptString(value: string): string {
  return JSON.stringify(value).replace(
    /[^\x00-\x7f]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function resolveSelectedOmpEntrypoint(
  selectedBinaryPath: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  const selected = selectedBinaryPath.trim();
  if (!selected)
    throw new Error("OMP Skill extraction compatibility requires the selected CLI path.");
  const pathApi = platform === "win32" ? nodePath.win32 : nodePath;
  if (pathApi.isAbsolute(selected)) return pathApi.normalize(selected);
  if (selected.includes("/") || (platform === "win32" && selected.includes("\\"))) {
    return pathApi.resolve(cwd, selected);
  }
  const resolved = resolveOmpAcpIdleTaskCompatExecutablePath(selected, cwd, env, platform);
  if (!resolved) {
    throw new Error(
      "OMP Skill extraction compatibility cannot resolve the selected CLI from its account PATH.",
    );
  }
  return resolved;
}

function countOccurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

function isOmpSkillEvolutionCompatMarker(marker: string): boolean {
  return new RegExp(
    `^${OMP_SKILL_EVOLUTION_COMPAT_MARKER_PREFIX} nonce=[a-f0-9]{32} sha256=${OMP_SKILL_EVOLUTION_COMPAT_BUNDLE_SHA256}$`,
  ).test(marker);
}
