import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { SKILL_EVOLUTION_SYSTEM_PROMPT } from "../skillEvolutionConstraints.ts";
import {
  buildOmpSkillEvolutionCompatPreload,
  makeOmpSkillEvolutionCompatMarker,
  OMP_SKILL_EVOLUTION_COMPAT_BUNDLE_SHA256,
  OMP_SKILL_EVOLUTION_COMPAT_BUNDLE_SIZE,
  OMP_SKILL_EVOLUTION_COMPAT_CLI_VERSION,
  OMP_SKILL_EVOLUTION_DATE_CWD_REMINDER_ANCHOR,
  OMP_SKILL_EVOLUTION_FACTORY_ANCHOR,
  transformVerifiedOmpSkillEvolutionBundle,
  verifyOmpSkillEvolutionBundle,
  verifyOmpSkillEvolutionCompatProbe,
} from "./OmpSkillEvolutionCompat.ts";

function fixtureBundle() {
  return `#!/usr/bin/env bun\nasync function run(e,t,i,r,o,n,a,l,c){${OMP_SKILL_EVOLUTION_FACTORY_ANCHOR}return d;}\nasync function transform(vt){return ${OMP_SKILL_EVOLUTION_DATE_CWD_REMINDER_ANCHOR}}\n`;
}

function fixtureExpectations(source: string) {
  return {
    sha256: createHash("sha256").update(source).digest("hex"),
    size: Buffer.byteLength(source),
  };
}

describe("OMP Skill extraction compatibility", () => {
  it("pins to the verified CLI build and transforms its one exact session factory", () => {
    const source = fixtureBundle();
    const transformed = transformVerifiedOmpSkillEvolutionBundle(
      source,
      fixtureExpectations(source),
      makeOmpSkillEvolutionCompatMarker("11111111111111111111111111111111"),
    );

    expect(OMP_SKILL_EVOLUTION_COMPAT_BUNDLE_SHA256).toBe(
      "c5d51fbb4d787035f3cec7b3579234de4c55b169574a094e2a672bb68970992d",
    );
    expect(OMP_SKILL_EVOLUTION_COMPAT_BUNDLE_SIZE).toBe(17_638_974);
    expect(OMP_SKILL_EVOLUTION_COMPAT_CLI_VERSION).toBe("18.12.1");
    expect(transformed).not.toContain(OMP_SKILL_EVOLUTION_FACTORY_ANCHOR);
    expect(transformed).not.toContain(OMP_SKILL_EVOLUTION_DATE_CWD_REMINDER_ANCHOR);
    expect(transformed).toContain("async function transform(vt){return vt}");
    expect(transformed).toContain(
      'r.overlay({"autolearn.enabled":!1,"autolearn.autoContinue":!1})',
    );
    expect(transformed).toContain("could not prepare a session-local Auto-Learn settings overlay");
    expect(transformed).toContain("synaraAutoLearnSettings.rawValue");
    expect(transformed).toContain("could not verify disabled native Auto-Learn settings");
    expect(transformed).toContain("restrictToolNames:!0,toolNames:[],tools:[],customTools:[]");
    expect(transformed).toContain("preloadedPreparedExtensions:[]");
    expect(transformed).toContain("contextFiles:[],skills:[],rules:[]");
    expect(transformed).toContain('appendSystemPrompt:""');
    expect(transformed).toContain("getActiveToolNames");
    expect(transformed).toContain("getEnabledToolNames");
    expect(transformed).not.toContain("你是 Synara");
    expect(transformed).toContain("\\u4f60\\u662f Synara");
  });

  it("rejects unknown sizes, hashes, and missing or repeated factory anchors", () => {
    const source = fixtureBundle();
    const expected = fixtureExpectations(source);

    expect(() => verifyOmpSkillEvolutionBundle(Buffer.from(source))).toThrow(/bundle size/u);
    expect(() =>
      verifyOmpSkillEvolutionBundle(Buffer.from(source), { ...expected, sha256: "0".repeat(64) }),
    ).toThrow(/bundle hash/u);
    const missingAnchor = source.replace(OMP_SKILL_EVOLUTION_FACTORY_ANCHOR, "");
    expect(() =>
      verifyOmpSkillEvolutionBundle(Buffer.from(missingAnchor), {
        sha256: createHash("sha256").update(missingAnchor).digest("hex"),
        size: Buffer.byteLength(missingAnchor),
      }),
    ).toThrow(/one exact ACP factory and date\/CWD reminder anchor/u);
    const repeated = source.replace("return d;", `${OMP_SKILL_EVOLUTION_FACTORY_ANCHOR}return d;`);
    expect(() =>
      verifyOmpSkillEvolutionBundle(Buffer.from(repeated), {
        sha256: createHash("sha256").update(repeated).digest("hex"),
        size: Buffer.byteLength(repeated),
      }),
    ).toThrow(/one exact ACP factory and date\/CWD reminder anchor/u);
    const missingReminder = source.replace(OMP_SKILL_EVOLUTION_DATE_CWD_REMINDER_ANCHOR, "vt");
    expect(() =>
      verifyOmpSkillEvolutionBundle(Buffer.from(missingReminder), {
        sha256: createHash("sha256").update(missingReminder).digest("hex"),
        size: Buffer.byteLength(missingReminder),
      }),
    ).toThrow(/factory and date\/CWD reminder anchor/u);
    const repeatedReminder = source.replace(
      "async function transform(vt)",
      `async function transform(vt){${OMP_SKILL_EVOLUTION_DATE_CWD_REMINDER_ANCHOR};}`,
    );
    expect(() =>
      verifyOmpSkillEvolutionBundle(Buffer.from(repeatedReminder), {
        sha256: createHash("sha256").update(repeatedReminder).digest("hex"),
        size: Buffer.byteLength(repeatedReminder),
      }),
    ).toThrow(/factory and date\/CWD reminder anchor/u);
  });

  it("constructs a no-tool native session with only the explicit user message", async () => {
    const source = fixtureBundle();
    const marker = makeOmpSkillEvolutionCompatMarker("22222222222222222222222222222222");
    const transformed = transformVerifiedOmpSkillEvolutionBundle(
      source,
      fixtureExpectations(source),
      marker,
    );
    const factory = new Function(
      "process",
      `${transformed.slice(transformed.indexOf("\n") + 1)}; return run;`,
    ) as (process: { stderr: { write: (text: string) => void } }) => (
      e: {
        readonly baseOptions: Record<string, unknown>;
        createSession: (
          options: Record<string, unknown>,
        ) => Promise<{ session: Record<string, any> }>;
      },
      t: string,
      i: unknown,
      r: unknown,
      o: string,
      n: unknown,
      a: string,
      l: unknown,
      c: unknown,
    ) => Promise<Record<string, any>>;
    const stderr = vi.fn();
    const process = { stderr: { write: stderr } };
    const run = factory(process);
    const activeTools = ["read_file"];
    const enabledTools = ["read_file"];
    const receivedPrompts: Array<ReadonlyArray<unknown>> = [];
    let finalOptions: Record<string, unknown> | undefined;
    const ambientSettingsValues: Record<string, unknown> = {
      "autolearn.enabled": true,
      "autolearn.autoContinue": true,
      "autolearn.minToolCalls": 0,
      provider: "user-settings-sentinel",
    };
    const ambientSettings = {
      overlay: vi.fn((overrides: Record<string, unknown>) => ({
        rawValue: vi.fn(
          (setting: { id: string }) => overrides[setting.id] ?? ambientSettingsValues[setting.id],
        ),
      })),
    };
    const session = {
      systemPrompt: ["environment sentinel"],
      getActiveToolNames: () => activeTools,
      getEnabledToolNames: () => enabledTools,
      prompt: async (...args: ReadonlyArray<unknown>) => {
        receivedPrompts.push(args);
        return true;
      },
      dispose: vi.fn(async () => {}),
    };
    const result = await run(
      {
        baseOptions: {
          systemPrompt: ["ENV_SYSTEM_SENTINEL"],
          appendSystemPrompt: "ENV_APPEND_SENTINEL",
          contextFiles: [{ path: "AGENTS.md", content: "ENV_CONTEXT_SENTINEL" }],
          skills: ["ENV_SKILL_SENTINEL"],
          rules: ["ENV_RULE_SENTINEL"],
          tools: ["read_file"],
          toolNames: ["read_file"],
          customTools: ["ENV_CUSTOM_TOOL_SENTINEL"],
          preloadedExtensions: { extensions: ["ENV_EXTENSION_SENTINEL"] },
          disableExtensionDiscovery: false,
          enableMCP: true,
        },
        createSession: async (options) => {
          finalOptions = options;
          session.systemPrompt = options.systemPrompt as string[];
          const restricted =
            options.restrictToolNames === true && (options.toolNames as unknown[]).length === 0;
          activeTools.splice(0, activeTools.length, ...(restricted ? [] : ["read_file"]));
          enabledTools.splice(0, enabledTools.length, ...(restricted ? [] : ["read_file"]));
          return { session };
        },
      },
      "/private/cwd",
      {},
      ambientSettings,
      "agent-id",
      {},
      "title prompt",
      {},
      {},
    );

    expect(result).toBe(session);
    expect(finalOptions).toMatchObject({
      restrictToolNames: true,
      toolNames: [],
      tools: [],
      customTools: [],
      contextFiles: [],
      skills: [],
      rules: [],
      enableMCP: false,
      enableLsp: false,
      enableIrc: false,
      disableExtensionDiscovery: true,
      systemPrompt: [SKILL_EVOLUTION_SYSTEM_PROMPT],
      appendSystemPrompt: "",
      preloadedPreparedExtensions: [],
      preloadedExtensionPaths: [],
      additionalDirectories: [],
      spawns: "",
    });
    expect(ambientSettings.overlay).toHaveBeenCalledExactlyOnceWith({
      "autolearn.enabled": false,
      "autolearn.autoContinue": false,
    });
    const sessionSettings = finalOptions?.settings as {
      rawValue: (setting: { id: string }) => unknown;
    };
    expect(sessionSettings.rawValue({ id: "autolearn.enabled" })).toBe(false);
    expect(sessionSettings.rawValue({ id: "autolearn.autoContinue" })).toBe(false);
    expect(sessionSettings.rawValue({ id: "autolearn.minToolCalls" })).toBe(0);
    expect(sessionSettings.rawValue({ id: "provider" })).toBe("user-settings-sentinel");
    expect(ambientSettingsValues["autolearn.enabled"]).toBe(true);
    expect(ambientSettingsValues["autolearn.autoContinue"]).toBe(true);
    expect(finalOptions?.preloadedExtensions).toBeUndefined();
    expect(JSON.stringify(finalOptions)).not.toMatch(
      /ENV_(?:SYSTEM|APPEND|CONTEXT|SKILL|RULE|CUSTOM_TOOL|EXTENSION)_SENTINEL/u,
    );

    const unsafeCreateSession = vi.fn(async () => ({ session }));
    await expect(
      run(
        { baseOptions: {}, createSession: unsafeCreateSession },
        "/private/cwd",
        {},
        { overlay: () => ({ rawValue: () => true }) },
        "agent-id",
        {},
        "title prompt",
        {},
        {},
      ),
    ).rejects.toThrow(/could not verify disabled native Auto-Learn settings/u);
    expect(unsafeCreateSession).not.toHaveBeenCalled();
    await expect(
      run(
        { baseOptions: {}, createSession: unsafeCreateSession },
        "/private/cwd",
        {},
        {},
        "agent-id",
        {},
        "title prompt",
        {},
        {},
      ),
    ).rejects.toThrow(/could not prepare a session-local Auto-Learn settings overlay/u);
    expect(unsafeCreateSession).not.toHaveBeenCalled();

    await result.prompt("Only this submitted user message.");
    expect(receivedPrompts).toEqual([["Only this submitted user message."]]);
    expect(stderr).toHaveBeenCalledExactlyOnceWith(`${marker}\n`);

    activeTools.push("read_file");
    await expect(result.prompt("Do not dispatch after the tool roster changes.")).rejects.toThrow(
      /no-tool prompt constraints/u,
    );
    expect(receivedPrompts).toHaveLength(1);
  });

  it("emits no trusted probe marker unless the exact nonce and bundle marker match", () => {
    const expectedMarker = `${makeOmpSkillEvolutionCompatMarker("33333333333333333333333333333333")} phase=source-verified`;
    expect(
      verifyOmpSkillEvolutionCompatProbe({
        stdout: "omp/18.12.1\n",
        stderr: `${expectedMarker}\n`,
        exitCode: 0,
        expectedMarker,
      }),
    ).toBe(true);
    expect(
      verifyOmpSkillEvolutionCompatProbe({
        stdout: "omp/18.12.1\n",
        stderr: `${expectedMarker.replace("33333333333333333333333333333333", "44444444444444444444444444444444")}\n`,
        exitCode: 0,
        expectedMarker,
      }),
    ).toBe(false);
  });

  it("links the preload source proof and constructed-session proof to one nonce and hash", () => {
    const baseMarker = makeOmpSkillEvolutionCompatMarker("55555555555555555555555555555555");
    const probeMarker = `${baseMarker} phase=source-verified`;
    const sessionMarker = `${baseMarker} phase=session-verified`;
    const preload = buildOmpSkillEvolutionCompatPreload(
      "/selected/omp/dist/cli.js",
      probeMarker,
      sessionMarker,
    );

    expect(preload).toContain(probeMarker);
    expect(preload).toContain(sessionMarker);
    expect(() =>
      buildOmpSkillEvolutionCompatPreload(
        "/selected/omp/dist/cli.js",
        probeMarker,
        `${makeOmpSkillEvolutionCompatMarker("66666666666666666666666666666666")} phase=session-verified`,
      ),
    ).toThrow(/do not share a verified nonce and hash/u);
  });
});
