import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildOmpAcpIdleTaskCompatMainGuard,
  buildOmpAcpIdleTaskCompatPreload,
  makeOmpAcpIdleTaskCompatArgs,
  makeOmpAcpIdleTaskCompatLaunch,
  OMP_ACP_IDLE_TASK_COMPAT_MARKER,
  OMP_ACP_IDLE_TASK_COMPAT_BUNDLE_SHA256,
  OMP_ACP_IDLE_TASK_COMPAT_BUNDLE_SIZE,
  OMP_ACP_IDLE_TASK_COMPAT_CLI_VERSION,
  transformVerifiedOmpAcpIdleTaskBundle,
  resolveOmpAcpIdleTaskCompatExecutablePath,
  verifyOmpAcpIdleTaskBundle,
  verifyOmpAcpIdleTaskCompatProbe,
  type OmpAcpIdleTaskCompatLaunch,
} from "./OmpAcpIdleTaskCompat.ts";

const handlerAnchor =
  'async#k(e,t){if(t.type!=="thinking_level_changed"&&t.type!=="model_changed")return;';
const permissionBridgeAnchor =
  "async function BXc(e,t,n,r,i){let o={toolCallId:n.toolCallId,title:n.title,...n.kind?{kind:n.kind}:{},...n.status?{status:n.status}:{},...n.rawInput!==void 0?{rawInput:n.rawInput}:{},...n.content?{content:n.content}:{},...n.locations?{locations:n.locations}:{}}";

function fixtureBundle() {
  return `#!/usr/bin/env bun\nconst bundle = "${handlerAnchor}";\n${permissionBridgeAnchor},s=[],a={};}\n`;
}

function fixtureExpectations(source: string) {
  return {
    sha256: createHash("sha256").update(source).digest("hex"),
    size: Buffer.byteLength(source),
  };
}

function makeRunnableBundle() {
  return `#!/usr/bin/env bun
class SyntheticOmpLifetimeHandler {
  #e;
  #l;
  constructor(sessionUpdate) {
    this.#e = { sessionUpdate };
    this.#l = { name: "blob-store" };
    this.fallbackEvents = [];
  }
  ${handlerAnchor}this.fallbackEvents.push(t);}
  dispatch(e, t) { return this.#k(e, t); }
}
${permissionBridgeAnchor},s=r.map((u)=>({optionId:u.optionId,name:u.name,kind:u.kind})),a={sessionId:t,toolCall:o,options:s};return e.requestPermission(a);}
return SyntheticOmpLifetimeHandler;
`;
}

function makeCompatHarness(
  options: {
    readonly rejectSessionUpdate?: boolean;
  } = {},
) {
  const source = makeRunnableBundle();
  const transformed = transformVerifiedOmpAcpIdleTaskBundle(source, fixtureExpectations(source));
  const mapped: Array<{ event: unknown; sessionId: string; toolArgs: unknown; image: unknown }> =
    [];
  const updates: Array<unknown> = [];
  const logged: Array<unknown> = [];
  const Klass = new Function("vWe", "Qde", "z", transformed.slice(transformed.indexOf("\n") + 1))(
    (event: { toolCallId: string }, sessionId: string, mapperOptions: Record<string, any>) => {
      const toolArgs = mapperOptions.getToolArgs(event.toolCallId);
      const image = mapperOptions.resolveImageData("image-id");
      mapped.push({ event, sessionId, toolArgs, image });
      return [`${sessionId}:${event.toolCallId}`];
    },
    (_blobStore: unknown, imageId: string) => `resolved:${imageId}`,
    (...args: ReadonlyArray<unknown>) => logged.push(args),
  ) as new (sessionUpdate: (update: unknown) => Promise<void>) => {
    dispatch: (eventState: Record<string, any>, event: unknown) => Promise<void>;
    fallbackEvents: Array<unknown>;
  };
  const handler = new Klass(async (update) => {
    if (options.rejectSessionUpdate) throw new Error("synthetic session update failed");
    updates.push(update);
  });
  return { handler, mapped, updates, logged };
}

function makeTaskUpdate(overrides: Record<string, unknown> = {}) {
  return {
    type: "tool_execution_update",
    toolCallId: "native-task-1",
    partialResult: {
      details: {
        async: {
          type: "task",
          jobId: "job-1",
          state: "running",
          ...overrides,
        },
      },
    },
  };
}

function makeEventState(overrides: Record<string, unknown> = {}) {
  return {
    session: {
      sessionId: "session-1",
      sessionManager: { getCwd: () => "/project" },
    },
    toolArgsById: new Map([["native-task-1", { selected: true }]]),
    promptEventHandlers: new Set<Promise<void>>(),
    ...overrides,
  };
}

describe("OMP ACP idle task compatibility", () => {
  it("executes the Bun.main and canonical-realpath preload guard before plugin setup", async () => {
    const expectedPath = "/private/omp-canonical/dist/cli.js";
    const evaluate = new Function(
      "Bun",
      "expectedPath",
      "realpath",
      `return (async () => { ${buildOmpAcpIdleTaskCompatMainGuard()} })();`,
    ) as (
      bun: { readonly main: string },
      expected: string,
      realpath: (value: string) => Promise<string>,
    ) => Promise<void>;

    await expect(
      evaluate({ main: expectedPath }, expectedPath, async (value) => value),
    ).resolves.toBeUndefined();
    await expect(
      evaluate({ main: "/private/omp-fake/cli.js" }, expectedPath, async (value) => value),
    ).rejects.toThrow(/main entry changed/u);
    await expect(
      evaluate({ main: expectedPath }, expectedPath, async () => "/private/omp-fake/cli.js"),
    ).rejects.toThrow(/main entry changed/u);
    await expect(
      evaluate({ main: expectedPath }, expectedPath, async () => {
        throw new Error("unavailable");
      }),
    ).rejects.toThrow(/became unavailable/u);
  });

  it("pins compatibility to the observed CLI build and transforms the idle update path", () => {
    const source = fixtureBundle();
    const transformed = transformVerifiedOmpAcpIdleTaskBundle(source, fixtureExpectations(source));

    expect(OMP_ACP_IDLE_TASK_COMPAT_BUNDLE_SHA256).toBe(
      "c5d51fbb4d787035f3cec7b3579234de4c55b169574a094e2a672bb68970992d",
    );
    expect(OMP_ACP_IDLE_TASK_COMPAT_BUNDLE_SIZE).toBe(17_638_974);
    expect(transformed).toContain('t.type==="tool_execution_update"');
    expect(transformed).toContain(
      "!e.promptTurn||e.promptTurn.settled||e.promptTurn.cancelRequested",
    );
    expect(transformed).toContain('a?.type==="task"');
    expect(transformed).toContain('typeof a.jobId==="string"&&a.jobId.trim().length>0');
    expect(transformed).toContain('typeof a.state==="string"');
    expect(transformed).toContain("vWe(t,e.session.sessionId");
    expect(transformed).toContain("Qde(this.#l,s)");
    expect(transformed).toContain("this.#e.sessionUpdate(s)");
    expect(transformed).toContain(
      '...(typeof n.toolName==="string"?{_meta:{...(n._meta??{}),synaraToolName:n.toolName}}:{})',
    );
    expect(transformed.indexOf("synaraToolName:n.toolName")).toBeGreaterThan(
      transformed.indexOf("rawInput:n.rawInput"),
    );
  });

  it("carries the actual OMP tool name after raw input so arguments cannot replace it", async () => {
    const source = makeRunnableBundle();
    const transformed = transformVerifiedOmpAcpIdleTaskBundle(source, fixtureExpectations(source));
    const executable = transformed
      .slice(transformed.indexOf("\n") + 1)
      .replace("return SyntheticOmpLifetimeHandler;", "");
    const getBridge = new Function(`${executable}\nreturn BXc;`) as () => (
      client: { requestPermission: (request: unknown) => unknown },
      sessionId: string,
      toolCall: Record<string, unknown>,
      options: ReadonlyArray<unknown>,
    ) => Promise<unknown>;
    const requests: Array<Record<string, any>> = [];
    const bridge = getBridge();

    await bridge(
      {
        requestPermission: async (request) => {
          requests.push(request as Record<string, any>);
          return { outcome: { outcome: "cancelled" } };
        },
      },
      "session-1",
      {
        toolCallId: "call-1",
        toolName: "synara_learning_commit",
        title: "Learning",
        rawInput: { _meta: { synaraToolName: "synara_learning_revert" } },
      },
      [],
    );

    expect(requests[0]?.toolCall).toMatchObject({
      rawInput: { _meta: { synaraToolName: "synara_learning_revert" } },
      _meta: { synaraToolName: "synara_learning_commit" },
    });
  });

  it("forwards valid idle, settled, and cancelled task updates without duplicating active turns", async () => {
    const { handler, mapped, updates } = makeCompatHarness();
    const event = makeTaskUpdate();
    const active = makeEventState({ promptTurn: { settled: false, cancelRequested: false } });
    await handler.dispatch(active, event);
    expect(mapped).toHaveLength(0);

    await handler.dispatch(makeEventState(), event);
    await handler.dispatch(makeEventState({ promptTurn: { settled: true } }), event);
    await handler.dispatch(makeEventState({ promptTurn: { cancelRequested: true } }), event);

    expect(mapped).toHaveLength(3);
    expect(updates).toEqual([
      "session-1:native-task-1",
      "session-1:native-task-1",
      "session-1:native-task-1",
    ]);
    expect(mapped[0]).toMatchObject({
      sessionId: "session-1",
      toolArgs: { selected: true },
      image: "resolved:image-id",
    });
    expect(active.promptEventHandlers.size).toBe(0);
  });

  it("ignores malformed task metadata and closed sessions", async () => {
    const { handler, mapped, updates } = makeCompatHarness();
    for (const event of [
      makeTaskUpdate({ jobId: "  " }),
      makeTaskUpdate({ type: "plugin" }),
      makeTaskUpdate({ state: 12 }),
    ]) {
      await handler.dispatch(makeEventState(), event);
    }
    await handler.dispatch(makeEventState({ closedError: new Error("closed") }), makeTaskUpdate());

    expect(mapped).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("consumes session update rejection and clears the in-flight handler tracker", async () => {
    const { handler, mapped, logged } = makeCompatHarness({ rejectSessionUpdate: true });
    const state = makeEventState();

    await expect(handler.dispatch(state, makeTaskUpdate())).resolves.toBeUndefined();

    expect(mapped).toHaveLength(1);
    expect(state.promptEventHandlers.size).toBe(0);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject([
      "Failed to push idle task update",
      { sessionId: "session-1", eventType: "tool_execution_update" },
    ]);
  });

  it("rejects unknown bundle hashes, sizes, and changed anchors", () => {
    const source = fixtureBundle();
    expect(() =>
      verifyOmpAcpIdleTaskBundle(Buffer.from(source), {
        sha256: "0".repeat(64),
        size: Buffer.byteLength(source),
      }),
    ).toThrow(/bundle hash/u);
    expect(() =>
      verifyOmpAcpIdleTaskBundle(Buffer.from(source), {
        sha256: createHash("sha256").update(source).digest("hex"),
        size: Buffer.byteLength(source) + 1,
      }),
    ).toThrow(/bundle size/u);

    const changedAnchor = source.replace(handlerAnchor, "async#k(e,t){return;");
    expect(() =>
      verifyOmpAcpIdleTaskBundle(Buffer.from(changedAnchor), fixtureExpectations(changedAnchor)),
    ).toThrow(/handler anchor/u);

    const missingPermissionAnchor = source.replace(permissionBridgeAnchor, "async function BXc(){");
    expect(() =>
      verifyOmpAcpIdleTaskBundle(
        Buffer.from(missingPermissionAnchor),
        fixtureExpectations(missingPermissionAnchor),
      ),
    ).toThrow(/permission bridge anchor/u);

    const repeatedPermissionAnchor = `${source}\n${permissionBridgeAnchor},s=[],a={};}`;
    expect(() =>
      verifyOmpAcpIdleTaskBundle(
        Buffer.from(repeatedPermissionAnchor),
        fixtureExpectations(repeatedPermissionAnchor),
      ),
    ).toThrow(/permission bridge anchor/u);
  });

  it("builds a private preload with a literal Unicode and spaced entry path", () => {
    const entryPath = "/private/tmp/项目 space/#omp%/dist/cli.js";
    const preload = buildOmpAcpIdleTaskCompatPreload(entryPath);

    expect(preload).toContain(`const expectedPath = ${JSON.stringify(entryPath)};`);
    expect(preload).toContain(`const marker = ${JSON.stringify(OMP_ACP_IDLE_TASK_COMPAT_MARKER)};`);
    expect(preload).toContain("builder.onLoad({ filter: new RegExp(");
    expect(preload).toContain("const permissionBridgeAnchor =");
    expect(preload).toContain("permissionBridgeOccurrences !== 1");
    expect(preload).toContain("synara-omp-acp-learning-permission-compat-v2");
    expect(preload).toContain("synaraToolName:n.toolName");
    expect(preload).toContain("process.stderr.write(marker");
    expect(preload).toContain(
      'throw new Error("OMP idle-task compatibility entry point became unavailable.")',
    );
    expect(preload).toContain(
      'throw new Error("OMP idle-task compatibility entry point changed after verification.")',
    );
    expect(preload).not.toContain("if (resolvedPath !== expectedPath) return");
    expect(preload.indexOf("if(Bun.main!==expectedPath)")).toBeLessThan(
      preload.indexOf("Bun.plugin({"),
    );
  });

  it("launches the canonical verified source instead of the selected alias", () => {
    const alias = "/tools/omp/current/cli.js";
    const canonical = "/tools/omp/18.12.1/dist/cli.js";
    const launch = makeOmpAcpIdleTaskCompatLaunch({
      bunExecutable: "/tools/bun",
      canonicalSourcePath: canonical,
      preloadPath: "/private/preload.mjs",
    });

    expect(launch.cliEntrypoint).toBe(canonical);
    expect(launch.cliEntrypoint).not.toBe(alias);
  });

  it("resolves relative PATH entries against the native child cwd", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "omp-relative-path-"));
    try {
      const binDir = path.join(cwd, "tools");
      await mkdir(binDir);
      for (const name of ["omp", "bun"]) {
        const executable = path.join(binDir, name);
        await writeFile(executable, "#!/bin/sh\nexit 0\n");
        await chmod(executable, 0o700);
        expect(
          resolveOmpAcpIdleTaskCompatExecutablePath(name, cwd, { PATH: "tools" }, "linux"),
        ).toBe(executable);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("passes Bun preload arguments as distinct argv entries without shell quoting", () => {
    const launch: OmpAcpIdleTaskCompatLaunch = {
      bunExecutable: "/tool path/бин/bun",
      cliEntrypoint: "/tool path/omp/cli.js",
      preloadPath: "/private/tmp/项目 space/preload.mjs",
      expectedMarker: OMP_ACP_IDLE_TASK_COMPAT_MARKER,
    };

    expect(makeOmpAcpIdleTaskCompatArgs(launch, ["acp", "--version"])).toEqual([
      "--preload",
      launch.preloadPath,
      launch.cliEntrypoint,
      "acp",
      "--version",
    ]);
  });

  it("requires exact CLI version, successful exit, and preload marker in the probe", () => {
    const valid = {
      stdout: `omp/${OMP_ACP_IDLE_TASK_COMPAT_CLI_VERSION}\n`,
      stderr: `startup\n${OMP_ACP_IDLE_TASK_COMPAT_MARKER}\n`,
      exitCode: 0,
      expectedMarker: OMP_ACP_IDLE_TASK_COMPAT_MARKER,
    };
    expect(verifyOmpAcpIdleTaskCompatProbe(valid)).toBe(true);
    expect(verifyOmpAcpIdleTaskCompatProbe({ ...valid, exitCode: 1 })).toBe(false);
    expect(verifyOmpAcpIdleTaskCompatProbe({ ...valid, stdout: "omp/18.12.2" })).toBe(false);
    expect(verifyOmpAcpIdleTaskCompatProbe({ ...valid, stderr: "" })).toBe(false);
  });
});
