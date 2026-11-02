import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthSessionId, type ExecutionEnvironmentDescriptor } from "@synara/contracts";
import { DateTime, Effect, Exit, Layer, Scope } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vitest";

import {
  AuthError,
  ServerAuth,
  type AuthRequest,
  type ServerAuthShape,
} from "../auth/Services/ServerAuth";
import { ServerConfig, type ServerConfigShape } from "../config";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment";
import {
  createSkillManagementAuthStore,
  SKILL_MANAGEMENT_CREDENTIAL_TTL_MS,
} from "./managementAuth";
import { skillManagementCliEffectRouteLayer } from "./httpRoute";
import { executeManagementCli, type ManagementCliInput } from "./execute";
import {
  parseManagementCliCommand,
  type ManagementCliFlagValues,
  type ManagementCliNamespace,
} from "./cli";
import { readSkillManagementCredential } from "./credential";
import { computeExternalMcpRuntimeProof } from "../externalMcp/runtimeProof";
import { createExpertStore } from "../experts/ExpertStore";
import { createSkillLibraryStore, readSkillLibraryDefinitions } from "../experts/SkillLibraryStore";

const temporaryDirectories: string[] = [];
const ownerSessionId = AuthSessionId.makeUnsafe("11111111-1111-4111-8111-111111111111");
const runtimeSecret = "management-cli-e2e-runtime-secret-with-sufficient-entropy";

const defaultFlags: ManagementCliFlagValues = {
  json: false,
  content: undefined,
  contentFile: undefined,
  stdin: false,
  codeStdin: false,
  file: undefined,
  url: undefined,
  path: undefined,
  name: undefined,
  description: undefined,
  search: undefined,
  usage: undefined,
  source: [],
  tag: [],
  expertId: [],
  expertIds: undefined,
  skillId: [],
  skillIds: undefined,
  sort: undefined,
  direction: undefined,
  expectedRevision: undefined,
  requestId: undefined,
  dryRun: false,
  clear: false,
  yes: false,
  overwriteLocalEdits: false,
  entry: undefined,
  duplicate: undefined,
  allowEvolution: undefined,
  selectionScope: undefined,
  resourceMode: undefined,
  instanceId: undefined,
  flavor: undefined,
};

function capture() {
  const chunks: Buffer[] = [];
  return {
    stream: {
      write(chunk: string | Uint8Array) {
        chunks.push(Buffer.from(chunk));
        return true;
      },
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
    bytes: () => Buffer.concat(chunks),
  };
}

function makeAuth(): ServerAuthShape {
  return {
    authenticateHttpRequest: (request: AuthRequest) => {
      const role =
        request.headers.authorization === "Bearer owner-session"
          ? "owner"
          : request.headers.authorization === "Bearer client-session"
            ? "client"
            : null;
      if (role) {
        return Effect.succeed({
          sessionId: ownerSessionId,
          subject: role,
          method: "bearer-session-token",
          role,
          credentialSource: "bearer",
        });
      }
      return Effect.fail(new AuthError({ message: "Authentication required.", status: 401 }));
    },
  } as unknown as ServerAuthShape;
}

function makeCommand(input: {
  readonly namespace: ManagementCliNamespace;
  readonly args: ReadonlyArray<string>;
  readonly baseDir: string;
  readonly overrides?: Partial<ManagementCliFlagValues>;
  readonly io?: ManagementCliInput["io"];
}) {
  return {
    command: parseManagementCliCommand({
      namespace: input.namespace,
      args: input.args,
      flags: { ...defaultFlags, ...input.overrides },
    }),
    baseDir: input.baseDir,
    ...(input.io ? { io: input.io } : {}),
  };
}

async function withManagementCliServer(
  run: (input: {
    readonly baseDir: string;
    readonly stateDir: string;
    readonly origin: string;
  }) => Promise<void>,
  options: { readonly host?: string } = {},
): Promise<void> {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-skill-management-e2e-"));
  temporaryDirectories.push(baseDir);
  if (process.platform !== "win32") fs.chmodSync(baseDir, 0o700);
  const stateDir = path.join(baseDir, "userdata");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  const descriptor: ExecutionEnvironmentDescriptor = {
    environmentId: "skill-management-e2e" as ExecutionEnvironmentDescriptor["environmentId"],
    label: "Skill management e2e",
    platform: { os: "unknown", arch: "other" },
    serverVersion: "test",
    capabilities: { repositoryIdentity: false },
  };
  const config = {
    host: options.host ?? "127.0.0.1",
    port: 0,
    publicUrl: undefined,
    baseDir,
    stateDir,
  } as ServerConfigShape;

  const runtimeChallenge = HttpRouter.add(
    "POST",
    "/api/mcp/external/runtime-challenge",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const nonce = request.headers["x-synara-runtime-challenge"];
      if (typeof nonce !== "string") {
        return HttpServerResponse.jsonUnsafe({ error: "Missing challenge." }, { status: 400 });
      }
      return HttpServerResponse.jsonUnsafe({
        proof: computeExternalMcpRuntimeProof(runtimeSecret, nonce),
      });
    }),
  );

  const scope = await Effect.runPromise(Scope.make("sequential"));
  let nodeServer: http.Server | null = null;
  try {
    const services = await Effect.runPromise(
      Layer.buildWithScope(
        Layer.mergeAll(
          Layer.succeed(ServerConfig, config),
          Layer.succeed(ServerAuth, makeAuth()),
          Layer.succeed(ServerEnvironment, { getDescriptor: Effect.succeed(descriptor) }),
          NodeServices.layer,
        ),
        scope,
      ),
    );
    await Effect.runPromise(
      Scope.provide(
        Effect.gen(function* () {
          const httpServer = yield* NodeHttpServer.make(
            () => {
              nodeServer = http.createServer();
              return nodeServer;
            },
            { port: 0, host: "127.0.0.1" },
          );
          const routes = Layer.mergeAll(skillManagementCliEffectRouteLayer, runtimeChallenge);
          yield* httpServer.serve(yield* HttpRouter.toHttpEffect(routes));
        }).pipe(Effect.provideServices(services)),
        scope,
      ),
    );

    const address = (nodeServer as http.Server | null)?.address();
    if (!address || typeof address !== "object")
      throw new Error("Expected a local management test server.");
    (config as { port: number }).port = address.port;
    const origin = `http://127.0.0.1:${address.port}`;
    const runtimeStatePath = path.join(stateDir, "server-runtime.json");
    fs.writeFileSync(
      runtimeStatePath,
      JSON.stringify({
        version: 1,
        pid: process.pid,
        host: "127.0.0.1",
        port: address.port,
        origin,
        startedAt: new Date().toISOString(),
        externalMcpRuntimeSecret: runtimeSecret,
      }),
      { mode: 0o600 },
    );
    if (process.platform !== "win32") fs.chmodSync(runtimeStatePath, 0o600);

    await run({ baseDir, stateDir, origin });
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

async function pairManagementCli(baseDir: string, origin: string) {
  const pairingResponse = await fetch(`${origin}/api/skill-management/pairing`, {
    method: "POST",
    headers: { Authorization: "Bearer owner-session", Origin: origin },
    body: "{}",
  });
  expect(pairingResponse.status).toBe(200);
  const pairing = (await pairingResponse.json()) as {
    readonly code: string;
    readonly instanceId: string;
    readonly flavor: string;
  };
  const outcome = await executeManagementCli(
    makeCommand({
      namespace: "skill",
      args: ["auth", "pair"],
      baseDir,
      overrides: {
        instanceId: pairing.instanceId,
        flavor: pairing.flavor as ManagementCliFlagValues["flavor"],
      },
      io: {
        stdout: capture().stream,
        stderr: capture().stream,
        promptCode: async () => pairing.code,
      },
    }),
  );
  process.exitCode = 0;
  expect(outcome.exitCode).toBe(0);
  return readSkillManagementCredential({
    baseDir,
    instanceId: pairing.instanceId,
    flavor: pairing.flavor as "development",
  });
}

function replaceStoredCapabilities(
  stateDir: string,
  credentialId: string,
  capabilities: ReadonlyArray<"skill.manage" | "expert.skillBindings.manage">,
): void {
  const filePath = path.join(stateDir, "skill-management-auth.json");
  const store = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
    readonly credentials: ReadonlyArray<{
      readonly credentialId: string;
      readonly [key: string]: unknown;
    }>;
    readonly [key: string]: unknown;
  };
  const updated = {
    ...store,
    credentials: store.credentials.map((credential) =>
      credential.credentialId === credentialId ? { ...credential, capabilities } : credential,
    ),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(updated)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(filePath, 0o600);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    const makeWritable = (current: string) => {
      const stat = fs.lstatSync(current);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        for (const entry of fs.readdirSync(current)) makeWritable(path.join(current, entry));
        if (process.platform !== "win32") fs.chmodSync(current, 0o700);
      } else if (stat.isFile() && process.platform !== "win32") {
        fs.chmodSync(current, 0o600);
      }
    };
    makeWritable(directory);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Skill management local HTTP and CLI e2e", () => {
  it("re-previews a cancelled import only when the immutable source fingerprint still matches", async () => {
    await withManagementCliServer(async ({ baseDir, origin }) => {
      await pairManagementCli(baseDir, origin);
      const sourceDir = path.join(baseDir, "source-skill");
      fs.mkdirSync(sourceDir, { mode: 0o700 });
      const skillFile = path.join(sourceDir, "SKILL.md");
      fs.writeFileSync(skillFile, "---\nname: stable-import\n---\nOriginal body.\n", {
        mode: 0o600,
      });

      const realFetch = globalThis.fetch;
      let dropBeforeDelivery = true;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (dropBeforeDelivery && url.endsWith("/api/skill-management/command")) {
          const body = JSON.parse(String(init?.body)) as {
            readonly request?: { readonly action?: string };
          };
          if (body.request?.action === "import") {
            dropBeforeDelivery = false;
            throw new TypeError("simulated import request loss before delivery");
          }
        }
        return realFetch(input, init);
      }) as typeof fetch;

      try {
        const first = await executeManagementCli(
          makeCommand({
            namespace: "skill",
            args: ["import"],
            baseDir,
            overrides: { path: sourceDir, requestId: "management-import-replay" },
            io: { stdout: capture().stream, stderr: capture().stream },
          }),
        );
        process.exitCode = 0;
        expect(first.exitCode).toBe(1);

        const retryOutput = capture();
        const retry = await executeManagementCli(
          makeCommand({
            namespace: "skill",
            args: ["import"],
            baseDir,
            overrides: { path: sourceDir, requestId: "management-import-replay" },
            io: { stdout: retryOutput.stream, stderr: capture().stream },
          }),
        );
        process.exitCode = 0;
        expect(retry.exitCode).toBe(0);
        expect(JSON.parse(retryOutput.text())).toMatchObject({
          requestId: "management-import-replay",
          result: { skills: [{ name: "stable-import" }] },
        });
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  });

  it("rejects an import retry when re-previewed content differs from the prepared source", async () => {
    await withManagementCliServer(async ({ baseDir, origin }) => {
      await pairManagementCli(baseDir, origin);
      const sourceDir = path.join(baseDir, "changed-import-source");
      fs.mkdirSync(sourceDir, { mode: 0o700 });
      const skillFile = path.join(sourceDir, "SKILL.md");
      fs.writeFileSync(skillFile, "---\nname: changed-import\n---\nOriginal body.\n", {
        mode: 0o600,
      });

      const realFetch = globalThis.fetch;
      let dropBeforeDelivery = true;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (dropBeforeDelivery && url.endsWith("/api/skill-management/command")) {
          const body = JSON.parse(String(init?.body)) as {
            readonly request?: { readonly action?: string };
          };
          if (body.request?.action === "import") {
            dropBeforeDelivery = false;
            throw new TypeError("simulated import request loss before delivery");
          }
        }
        return realFetch(input, init);
      }) as typeof fetch;
      try {
        const first = await executeManagementCli(
          makeCommand({
            namespace: "skill",
            args: ["import"],
            baseDir,
            overrides: { path: sourceDir, requestId: "management-import-changed" },
            io: { stdout: capture().stream, stderr: capture().stream },
          }),
        );
        process.exitCode = 0;
        expect(first.exitCode).toBe(1);
        fs.writeFileSync(skillFile, "---\nname: changed-import\n---\nModified body.\n", {
          mode: 0o600,
        });

        const retryOutput = capture();
        const retryError = capture();
        const retry = await executeManagementCli(
          makeCommand({
            namespace: "skill",
            args: ["import"],
            baseDir,
            overrides: { path: sourceDir, requestId: "management-import-changed" },
            io: { stdout: retryOutput.stream, stderr: retryError.stream },
          }),
        );
        process.exitCode = 0;
        expect(retry.exitCode).toBe(3);
        expect(JSON.parse(retryError.text())).toMatchObject({
          error: { code: "conflict", exitCode: 3 },
        });
        expect(retryOutput.text()).toBe("");
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  });

  it("pairs an owner-issued code, performs server-validated dry-run and create, then honors owner revocation", async () => {
    await withManagementCliServer(async ({ baseDir, stateDir, origin }) => {
      const pairingResponse = await fetch(`${origin}/api/skill-management/pairing`, {
        method: "POST",
        headers: {
          Authorization: "Bearer owner-session",
          Origin: origin,
        },
        body: "{}",
      });
      expect(pairingResponse.status).toBe(200);
      const pairing = (await pairingResponse.json()) as {
        readonly code: string;
        readonly instanceId: string;
        readonly flavor: string;
      };
      expect(pairing.flavor).toBe("development");

      const pairOutput = capture();
      const pairOutcome = await executeManagementCli(
        makeCommand({
          namespace: "skill",
          args: ["auth", "pair"],
          baseDir,
          overrides: { instanceId: pairing.instanceId, flavor: "development" },
          io: {
            stdout: pairOutput.stream,
            stderr: capture().stream,
            promptCode: async () => pairing.code,
          },
        }),
      );
      process.exitCode = 0;
      expect(pairOutcome.exitCode).toBe(0);
      const storedCredential = await readSkillManagementCredential({
        baseDir,
        instanceId: pairing.instanceId,
        flavor: "development",
      });
      expect(pairOutput.text()).not.toContain(storedCredential.credential);
      expect(pairOutput.text()).toContain(storedCredential.credentialId);
      expect(
        fs.readFileSync(path.join(stateDir, "skill-management-auth.json"), "utf8"),
      ).not.toContain(storedCredential.credential);

      const skillBody =
        "---\nname: cli-created\ndescription: Created by the local management CLI.\n---\nUse this skill.\n";
      const dryRunOutput = capture();
      const dryRun = await executeManagementCli(
        makeCommand({
          namespace: "skill",
          args: ["create"],
          baseDir,
          overrides: {
            name: "cli-created",
            content: skillBody,
            requestId: "management-e2e-create",
            dryRun: true,
          },
          io: { stdout: dryRunOutput.stream, stderr: capture().stream },
        }),
      );
      process.exitCode = 0;
      expect(dryRun.exitCode).toBe(0);
      expect(JSON.parse(dryRunOutput.text())).toMatchObject({ result: { dryRun: true } });

      const listBeforeCreate = capture();
      await executeManagementCli(
        makeCommand({
          namespace: "skill",
          args: ["list"],
          baseDir,
          io: { stdout: listBeforeCreate.stream, stderr: capture().stream },
        }),
      );
      process.exitCode = 0;
      expect(JSON.parse(listBeforeCreate.text())).toMatchObject({ result: { skills: [] } });

      const createOutput = capture();
      const created = await executeManagementCli(
        makeCommand({
          namespace: "skill",
          args: ["create"],
          baseDir,
          overrides: {
            name: "cli-created",
            content: skillBody,
            requestId: "management-e2e-create",
          },
          io: { stdout: createOutput.stream, stderr: capture().stream },
        }),
      );
      process.exitCode = 0;
      expect(created.exitCode).toBe(0);
      const createdResult = JSON.parse(createOutput.text()) as {
        readonly result: {
          readonly skill: {
            readonly name: string;
            readonly skillId: string;
            readonly createdAt: string;
          };
        };
      };
      expect(createdResult).toMatchObject({
        result: {
          skill: {
            name: "cli-created",
          },
        },
      });
      expect(createdResult.result.skill).not.toHaveProperty("createdBy");
      expect(createdResult.result.skill.createdAt).toBeDefined();

      const replayOutput = capture();
      const replay = await executeManagementCli(
        makeCommand({
          namespace: "skill",
          args: ["create"],
          baseDir,
          overrides: {
            name: "cli-created",
            content: skillBody,
            requestId: "management-e2e-create",
          },
          io: { stdout: replayOutput.stream, stderr: capture().stream },
        }),
      );
      process.exitCode = 0;
      expect(replay.exitCode).toBe(0);
      expect(JSON.parse(replayOutput.text())).toMatchObject({
        result: { skill: { skillId: createdResult.result.skill.skillId } },
      });

      const binaryPath = path.join(baseDir, "payload.bin");
      const expectedBytes = Buffer.alloc(1024 * 1024);
      for (let index = 0; index < expectedBytes.length; index += 1) {
        expectedBytes[index] = index % 251;
      }
      fs.writeFileSync(binaryPath, expectedBytes);
      const fileWrite = await executeManagementCli(
        makeCommand({
          namespace: "skill",
          args: ["files", "write", createdResult.result.skill.skillId, "assets/payload.bin"],
          baseDir,
          overrides: { contentFile: binaryPath, requestId: "management-e2e-binary-write" },
          io: { stdout: capture().stream, stderr: capture().stream },
        }),
      );
      process.exitCode = 0;
      expect(fileWrite.exitCode).toBe(0);

      const binaryOutput = capture();
      const fileRead = await executeManagementCli(
        makeCommand({
          namespace: "skill",
          args: ["files", "read", createdResult.result.skill.skillId, "assets/payload.bin"],
          baseDir,
          io: { stdout: binaryOutput.stream, stderr: capture().stream },
        }),
      );
      process.exitCode = 0;
      expect(fileRead.exitCode).toBe(0);
      expect(binaryOutput.bytes()).toEqual(expectedBytes);

      const conflictingReuse = await fetch(`${origin}/api/skill-management/command`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${storedCredential.credential}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          request: {
            action: "create",
            requestId: "management-e2e-create",
            name: "different-content",
            body: skillBody + "Changed under the same id.\n",
            tags: [],
          },
        }),
      });
      expect(conflictingReuse.status).toBe(409);
      await expect(conflictingReuse.json()).resolves.toMatchObject({ code: "conflict" });

      const boundExpert = await createExpertStore(stateDir).save({
        name: "Bound for delete authorization",
        description: "",
        useCases: "",
        persona: "Test only",
        outputRequirements: "",
        skills: [],
        references: [],
        connections: [],
        skillBindings: [
          {
            skillId: createdResult.result.skill.skillId,
            enabled: true,
          },
        ],
      });

      replaceStoredCapabilities(stateDir, storedCredential.credentialId, ["skill.manage"]);
      const cascadeDeleteOutput = capture();
      const cascadeDeleteDenied = await executeManagementCli(
        makeCommand({
          namespace: "skill",
          args: ["delete", createdResult.result.skill.skillId],
          baseDir,
          overrides: { yes: true, requestId: "management-e2e-cascade-denied" },
          io: { stdout: capture().stream, stderr: cascadeDeleteOutput.stream },
        }),
      );
      process.exitCode = 0;
      expect(cascadeDeleteDenied.exitCode).toBe(4);
      expect(JSON.parse(cascadeDeleteOutput.text())).toMatchObject({
        error: { code: "unauthorized", exitCode: 4 },
      });

      const currentSkillResponse = await fetch(`${origin}/api/skill-management/command`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${storedCredential.credential}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          request: { action: "read", skillId: createdResult.result.skill.skillId },
        }),
      });
      const currentSkill = (await currentSkillResponse.json()) as {
        readonly skill: { readonly revision: number };
      };
      const batchDeleteDenied = await fetch(`${origin}/api/skill-management/command`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${storedCredential.credential}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          request: {
            action: "batch",
            requestId: "management-e2e-batch-cascade-denied",
            items: [
              {
                operation: "delete",
                skillId: createdResult.result.skill.skillId,
                expectedRevision: currentSkill.skill.revision,
                confirmExpertIds: [boundExpert.id],
              },
            ],
          },
        }),
      });
      expect(batchDeleteDenied.status).toBe(403);

      const bindingDeniedOutput = capture();
      const bindingDenied = await executeManagementCli(
        makeCommand({
          namespace: "expert",
          args: ["skills", "list", "expert-a"],
          baseDir,
          io: { stdout: capture().stream, stderr: bindingDeniedOutput.stream },
        }),
      );
      process.exitCode = 0;
      expect(bindingDenied.exitCode).toBe(4);

      const skillAllowed = await executeManagementCli(
        makeCommand({
          namespace: "skill",
          args: ["list"],
          baseDir,
          io: { stdout: capture().stream, stderr: capture().stream },
        }),
      );
      process.exitCode = 0;
      expect(skillAllowed.exitCode).toBe(0);

      replaceStoredCapabilities(stateDir, storedCredential.credentialId, [
        "skill.manage",
        "expert.skillBindings.manage",
      ]);
      const realFetch = globalThis.fetch;
      let dropNextCommandResponse = true;
      const interceptFetch = async (input: string | URL | Request, init?: RequestInit) => {
        const response = await realFetch(input, init);
        const url = input instanceof Request ? input.url : String(input);
        if (dropNextCommandResponse && url.endsWith("/api/skill-management/command")) {
          dropNextCommandResponse = false;
          throw new TypeError("simulated CLI response loss after server commit");
        }
        return response;
      };
      globalThis.fetch = interceptFetch as typeof fetch;
      try {
        const lostResponseDelete = await executeManagementCli(
          makeCommand({
            namespace: "skill",
            args: ["delete", createdResult.result.skill.skillId],
            baseDir,
            overrides: { yes: true, requestId: "management-e2e-delete-replay" },
            io: { stdout: capture().stream, stderr: capture().stream },
          }),
        );
        process.exitCode = 0;
        expect(lostResponseDelete.exitCode).toBe(1);
      } finally {
        globalThis.fetch = realFetch;
      }
      const replayDeleteOutput = capture();
      const replayDelete = await executeManagementCli(
        makeCommand({
          namespace: "skill",
          args: ["delete", createdResult.result.skill.skillId],
          baseDir,
          overrides: { yes: true, requestId: "management-e2e-delete-replay" },
          io: { stdout: replayDeleteOutput.stream, stderr: capture().stream },
        }),
      );
      process.exitCode = 0;
      expect(replayDelete.exitCode).toBe(0);
      expect(JSON.parse(replayDeleteOutput.text())).toMatchObject({
        requestId: "management-e2e-delete-replay",
        result: {},
      });

      replaceStoredCapabilities(stateDir, storedCredential.credentialId, [
        "expert.skillBindings.manage",
      ]);
      const bindingAllowed = await fetch(`${origin}/api/skill-management/command`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${storedCredential.credential}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          request: { action: "bindings", operation: "list", expertId: "missing-expert" },
        }),
      });
      expect(bindingAllowed.status).not.toBe(403);

      const bindingSkill = (
        await createSkillLibraryStore(stateDir).execute({
          action: "create",
          name: "Binding only capability",
          body: "---\nname: Binding only capability\n---\nBind without Skill management access.\n",
          tags: [],
        })
      ).skill!;
      const currentExpert = (await createExpertStore(stateDir).read(boundExpert.id))!;
      const bindingMutation = await fetch(`${origin}/api/skill-management/command`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${storedCredential.credential}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          request: {
            action: "bindings",
            operation: "add",
            expertId: currentExpert.id,
            expectedRevision: currentExpert.revision,
            requestId: "binding-only-current-add",
            bindings: [{ skillId: bindingSkill.skillId, enabled: true }],
          },
        }),
      });
      expect(bindingMutation.status).toBe(200);
      await expect(bindingMutation.json()).resolves.toMatchObject({
        bindingResult: { status: "applied", bindings: [{ skillId: bindingSkill.skillId }] },
      });
      expect((await createExpertStore(stateDir).read(boundExpert.id))?.skillBindings).toEqual([
        { skillId: bindingSkill.skillId, enabled: true },
      ]);

      const skillDenied = await executeManagementCli(
        makeCommand({
          namespace: "skill",
          args: ["list"],
          baseDir,
          io: { stdout: capture().stream, stderr: capture().stream },
        }),
      );
      process.exitCode = 0;
      expect(skillDenied.exitCode).toBe(4);

      const revokeResponse = await fetch(`${origin}/api/skill-management/credentials/revoke`, {
        method: "POST",
        headers: {
          Authorization: "Bearer owner-session",
          Origin: origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ credentialId: storedCredential.credentialId }),
      });
      expect(revokeResponse.status).toBe(200);
      await expect(revokeResponse.json()).resolves.toEqual({ revoked: true });

      const deniedOutput = capture();
      const denied = await executeManagementCli(
        makeCommand({
          namespace: "skill",
          args: ["list"],
          baseDir,
          io: { stdout: capture().stream, stderr: deniedOutput.stream },
        }),
      );
      process.exitCode = 0;
      expect(denied.exitCode).toBe(4);
      expect(JSON.parse(deniedOutput.text())).toMatchObject({
        ok: false,
        error: { code: "unauthorized", exitCode: 4 },
      });

      const authStore = createSkillManagementAuthStore(stateDir, {
        instanceId: pairing.instanceId,
        flavor: "development",
      });
      expect(await authStore.listCredentials()).toHaveLength(1);
      expect(Date.parse(storedCredential.expiresAt) - Date.now()).toBeLessThanOrEqual(
        SKILL_MANAGEMENT_CREDENTIAL_TTL_MS,
      );
    });
  }, 30_000);

  it("rechecks binding capability before single and batch delete cascades", async () => {
    await withManagementCliServer(async ({ baseDir, stateDir, origin }) => {
      const credential = await pairManagementCli(baseDir, origin);
      replaceStoredCapabilities(stateDir, credential.credentialId, ["skill.manage"]);

      const library = createSkillLibraryStore(stateDir);
      const experts = createExpertStore(stateDir);
      const definition = {
        name: "Capability race target",
        description: "",
        useCases: "",
        persona: "Test only",
        outputRequirements: "",
        skills: [],
        references: [],
        connections: [],
        skillBindings: [],
      };
      const expert = await experts.save(definition);
      const makeSkill = async (name: string) =>
        (
          await library.execute({
            action: "create",
            name,
            body: `---\nname: ${name}\ndescription: Race fixture\n---\nBody.\n`,
            tags: [],
          })
        ).skill!;
      const singleSkill = await makeSkill("single-race-target");
      const batchSkill = await makeSkill("batch-race-target");
      const unboundSkill = await makeSkill("unbound-skill-only-target");
      const pendingBindings = new Set([singleSkill.skillId, batchSkill.skillId]);
      const originalExecute = library.execute.bind(library);
      const bindConcurrently = async (skillId: string) => {
        const current = await experts.read(expert.id);
        if (!current) throw new Error("Race fixture Expert disappeared.");
        await experts.save({
          ...definition,
          id: current.id,
          expectedRevision: current.revision,
          skillBindings: [...(current.skillBindings ?? []), { skillId, enabled: true }],
        });
      };
      library.execute = async (request, context) => {
        const result = await originalExecute(request, context);
        if (request.action === "previewDelete" && pendingBindings.delete(request.skillId)) {
          // This runs after the route's capability preflight and before the delete mutation.
          await bindConcurrently(request.skillId);
        }
        return result;
      };

      try {
        const singleResponse = await fetch(`${origin}/api/skill-management/command`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${credential.credential}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            request: {
              action: "delete",
              requestId: "capability-race-single-delete",
              skillId: singleSkill.skillId,
              expectedRevision: singleSkill.revision,
              confirmExpertIds: [expert.id],
            },
          }),
        });
        expect(singleResponse.status).toBe(403);
        await expect(singleResponse.json()).resolves.toMatchObject({
          code: "management_unauthorized",
        });
        expect(
          (await experts.read(expert.id))?.skillBindings?.map((item) => item.skillId),
        ).toContain(singleSkill.skillId);
        expect(
          (await readSkillLibraryDefinitions(stateDir)).find(
            (item) => item.skillId === singleSkill.skillId,
          )?.deleted,
        ).toBe(false);

        const batchResponse = await fetch(`${origin}/api/skill-management/command`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${credential.credential}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            request: {
              action: "batch",
              requestId: "capability-race-batch-delete",
              items: [
                {
                  operation: "delete",
                  skillId: batchSkill.skillId,
                  expectedRevision: batchSkill.revision,
                  confirmExpertIds: [expert.id],
                },
              ],
            },
          }),
        });
        expect(batchResponse.status).toBe(200);
        const batchResult = (await batchResponse.json()) as {
          readonly results?: ReadonlyArray<{
            readonly success: boolean;
            readonly message?: string;
          }>;
        };
        expect(batchResult.results).toEqual([expect.objectContaining({ success: false })]);
        expect(batchResult.results?.[0]?.message).toContain("authorization changed");
        expect(
          (await experts.read(expert.id))?.skillBindings?.map((item) => item.skillId),
        ).toContain(batchSkill.skillId);
        expect(
          (await readSkillLibraryDefinitions(stateDir)).find(
            (item) => item.skillId === batchSkill.skillId,
          )?.deleted,
        ).toBe(false);

        const unboundResponse = await fetch(`${origin}/api/skill-management/command`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${credential.credential}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            request: {
              action: "delete",
              requestId: "capability-race-unbound-delete",
              skillId: unboundSkill.skillId,
              expectedRevision: unboundSkill.revision,
              confirmExpertIds: [],
            },
          }),
        });
        expect(unboundResponse.status).toBe(200);
        expect(
          (await readSkillLibraryDefinitions(stateDir)).find(
            (item) => item.skillId === unboundSkill.skillId,
          )?.deleted,
        ).toBe(true);
      } finally {
        library.execute = originalExecute;
        await library.dispose();
      }
    });
  }, 30_000);

  it("requires an owner session and rejects remotely reachable server policy", async () => {
    await withManagementCliServer(async ({ origin }) => {
      const response = await fetch(`${origin}/api/skill-management/pairing`, {
        method: "POST",
        headers: { Authorization: "Bearer client-session", Origin: origin },
        body: "{}",
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ code: "owner_required" });
    });

    await withManagementCliServer(
      async ({ origin }) => {
        const response = await fetch(`${origin}/api/skill-management/pairing`, {
          method: "POST",
          headers: { Authorization: "Bearer owner-session", Origin: origin },
          body: "{}",
        });
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({ code: "loopback_required" });
      },
      { host: "0.0.0.0" },
    );
  }, 30_000);
});
