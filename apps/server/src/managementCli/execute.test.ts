import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeManagementCli, executeManagementCliArgs } from "./execute";
import { parseManagementCliCommand, type ManagementCliFlagValues } from "./cli";

const transport = vi.hoisted(() => ({
  requests: [] as Array<Record<string, unknown>>,
  executeStore: undefined as ((request: Record<string, unknown>) => Promise<unknown>) | undefined,
  execute: vi.fn(async (input: { readonly request: Record<string, unknown> }) => {
    transport.requests.push(input.request);
    if (transport.executeStore) return transport.executeStore(input.request);
    if (input.request.action === "bindings" && input.request.operation === "list") {
      return {
        bindingResult: {
          expertId: input.request.expertId,
          revision: input.request.expertId === "expert-b" ? 7 : 3,
          bindings: [],
        },
      };
    }
    if (input.request.action === "bindExperts") {
      return {
        bindingResults: [
          {
            expertId: "expert-a",
            status: "applied",
            addedSkillIds: ["skl_0123456789abcdef0123456789abcdef"],
            skippedSkillIds: [],
          },
          { expertId: "expert-b", status: "conflict", addedSkillIds: [], skippedSkillIds: [] },
        ],
      };
    }
    return { bindingResult: { status: "applied", expertId: input.request.expertId } };
  }),
}));

vi.mock("./transport", () => ({
  discoverLocalManagementRuntime: vi.fn(async () => ({ endpoint: "http://127.0.0.1:1234" })),
  executeSkillManagementRequest: transport.execute,
  exchangeSkillManagementPairing: vi.fn(),
  revokeCurrentSkillManagementCredential: vi.fn(),
  SkillManagementTransportError: class SkillManagementTransportError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(input: { readonly status?: number; readonly code?: string } = {}) {
      super("management request failed");
      this.status = input.status ?? 400;
      this.code = input.code ?? "invalid_request";
    }
  },
}));

vi.mock("./credential", () => ({
  readSkillManagementCredential: vi.fn(async () => ({
    credentialId: "unit-test-credential",
    instanceId: "unit-test-instance",
    flavor: "development",
    credential: "secret-never-printed",
  })),
  removeSkillManagementCredential: vi.fn(async () => true),
}));

vi.mock("./requestEnvelope", () => ({
  getOrCreateManagementRequestEnvelopeEntry: vi.fn(
    async (input: {
      readonly buildRequest: () => Promise<unknown>;
      readonly preparedContentHash?: () => string | undefined;
    }) => ({
      request: await input.buildRequest(),
      ...(input.preparedContentHash?.()
        ? { preparedContentHash: input.preparedContentHash() }
        : {}),
    }),
  ),
  getOrCreateManagementRequestEnvelope: vi.fn(
    async (input: { readonly buildRequest: () => Promise<unknown> }) => input.buildRequest(),
  ),
  ManagementCliRequestIdConflictError: class ManagementCliRequestIdConflictError extends Error {
    readonly status = 409;
    readonly code = "conflict";
  },
  managementCliIntentHash: vi.fn(() => "a".repeat(64)),
}));

const baseFlags: ManagementCliFlagValues = {
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
  };
}

beforeEach(() => {
  transport.requests.length = 0;
  transport.executeStore = undefined;
  transport.execute.mockClear();
  process.exitCode = 0;
});

describe("Expert Skill CLI commands", () => {
  it("uses server-side N x M add and returns partial exit status per target", async () => {
    const output = capture();
    const result = await executeManagementCli({
      baseDir: "/tmp/skill-cli-test-home",
      command: parseManagementCliCommand({
        namespace: "expert",
        args: ["skills", "add"],
        flags: {
          ...baseFlags,
          expertIds: "expert-a,expert-b",
          skillId: ["skl_0123456789abcdef0123456789abcdef"],
          requestId: "batch-add-1",
          dryRun: true,
        },
      }),
      io: { stdout: output.stream, stderr: capture().stream },
    });

    expect(result.exitCode).toBe(5);
    const submission = transport.requests.find((request) => request.action === "bindExperts");
    expect(submission).toMatchObject({
      requestId: "batch-add-1",
      dryRun: true,
      targets: [
        { expertId: "expert-a", expectedRevision: 3 },
        { expertId: "expert-b", expectedRevision: 7 },
      ],
    });
    expect(JSON.parse(output.text())).toMatchObject({ ok: false, partial: true, exitCode: 5 });
  });

  it("constructs bindings with evolution disabled by default and preserves the per-Expert revision", async () => {
    const output = capture();
    const result = await executeManagementCli({
      baseDir: "/tmp/skill-cli-test-home",
      command: parseManagementCliCommand({
        namespace: "expert",
        args: ["skills", "add", "expert-a"],
        flags: {
          ...baseFlags,
          skillId: ["skl_0123456789abcdef0123456789abcdef"],
          requestId: "binding-add-1",
        },
      }),
      io: { stdout: output.stream, stderr: capture().stream },
    });

    expect(result.exitCode).toBe(0);
    const mutations = transport.requests.filter(
      (request) => request.action === "bindings" && request.operation === "add",
    );
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({
      expertId: "expert-a",
      expectedRevision: 3,
      requestId: "binding-add-1",
      bindings: [
        {
          skillId: "skl_0123456789abcdef0123456789abcdef",
          enabled: true,
          selectionScope: "entry",
          resourceMode: "shared-readonly",
        },
      ],
    });
    expect((mutations[0]?.bindings as Array<Record<string, unknown>>)[0]).not.toHaveProperty(
      "activation",
    );
    expect((mutations[0]?.bindings as Array<Record<string, unknown>>)[0]).not.toHaveProperty(
      "allowEvolution",
    );
  });

  it.each([
    ["true", true],
    ["false", false],
  ] as const)("passes explicit --allow-evolution %s to a new binding", async (value, expected) => {
    const output = capture();
    await executeManagementCli({
      baseDir: "/tmp/skill-cli-test-home",
      command: parseManagementCliCommand({
        namespace: "expert",
        args: ["skills", "add", "expert-a"],
        flags: {
          ...baseFlags,
          skillId: ["skl_0123456789abcdef0123456789abcdef"],
          requestId: `binding-add-evolution-${value}`,
          allowEvolution: value,
        },
      }),
      io: { stdout: output.stream, stderr: capture().stream },
    });
    const mutation = transport.requests.find(
      (request) => request.action === "bindings" && request.operation === "add",
    );
    expect(mutation?.bindings).toEqual([
      {
        skillId: "skl_0123456789abcdef0123456789abcdef",
        enabled: true,
        allowEvolution: expected,
        selectionScope: "entry",
        resourceMode: "shared-readonly",
      },
    ]);
  });

  it("preserves evolution permission and package/private modes on set unless explicitly changed", async () => {
    const skillId = "skl_0123456789abcdef0123456789abcdef",
      existingBinding = {
        skillId,
        enabled: true,
        allowEvolution: true,
        selectionScope: "package",
        resourceMode: "run-private",
      };
    transport.executeStore = async (request) =>
      request.action === "bindings" && request.operation === "list"
        ? {
            bindingResult: { expertId: "expert-a", revision: 3, bindings: [existingBinding] },
          }
        : { bindingResult: { status: "applied", expertId: "expert-a" } };
    for (const [requestId, modes] of [
      ["set-preserve-modes", {}],
      [
        "set-switch-modes",
        { selectionScope: "entry" as const, resourceMode: "shared-readonly" as const },
      ],
    ] as const) {
      const output = capture();
      await executeManagementCli({
        baseDir: "/tmp/skill-cli-test-home",
        command: parseManagementCliCommand({
          namespace: "expert",
          args: ["skills", "set", "expert-a"],
          flags: { ...baseFlags, skillId: [skillId], requestId, ...modes },
        }),
        io: { stdout: output.stream, stderr: capture().stream },
      });
    }

    const mutations = transport.requests.filter(
      (request) => request.action === "bindings" && request.operation === "set",
    );
    expect(mutations).toHaveLength(2);
    expect(mutations[0]?.bindings).toEqual([
      {
        skillId,
        enabled: true,
        allowEvolution: true,
        selectionScope: "package",
        resourceMode: "run-private",
      },
    ]);
    expect(mutations[1]?.bindings).toEqual([
      {
        skillId,
        enabled: true,
        allowEvolution: true,
        selectionScope: "entry",
        resourceMode: "shared-readonly",
      },
    ]);
  });

  it("allows an explicit false value to clear an existing evolution permission", async () => {
    const skillId = "skl_0123456789abcdef0123456789abcdef";
    transport.executeStore = async (request) =>
      request.action === "bindings" && request.operation === "list"
        ? {
            bindingResult: {
              expertId: "expert-a",
              revision: 3,
              bindings: [
                {
                  skillId,
                  enabled: true,
                  allowEvolution: true,
                  selectionScope: "package",
                  resourceMode: "run-private",
                },
              ],
            },
          }
        : { bindingResult: { status: "applied", expertId: "expert-a" } };
    const output = capture();
    await executeManagementCli({
      baseDir: "/tmp/skill-cli-test-home",
      command: parseManagementCliCommand({
        namespace: "expert",
        args: ["skills", "set", "expert-a"],
        flags: {
          ...baseFlags,
          skillId: [skillId],
          requestId: "set-clear-evolution-permission",
          allowEvolution: "false",
        },
      }),
      io: { stdout: output.stream, stderr: capture().stream },
    });
    expect(
      transport.requests.find(
        (request) => request.action === "bindings" && request.operation === "set",
      )?.bindings,
    ).toEqual([
      {
        skillId,
        enabled: true,
        allowEvolution: false,
        selectionScope: "package",
        resourceMode: "run-private",
      },
    ]);
  });

  it("passes custom modes through per-Expert CAS for multi-Expert add", async () => {
    const output = capture(),
      result = await executeManagementCli({
        baseDir: "/tmp/skill-cli-test-home",
        command: parseManagementCliCommand({
          namespace: "expert",
          args: ["skills", "add"],
          flags: {
            ...baseFlags,
            expertIds: "expert-a,expert-b",
            skillId: ["skl_0123456789abcdef0123456789abcdef"],
            requestId: "multi-private-add",
            selectionScope: "package",
            resourceMode: "run-private",
          },
        }),
        io: { stdout: output.stream, stderr: capture().stream },
      });

    expect(result.exitCode).toBe(0);
    expect(transport.requests.some((request) => request.action === "bindExperts")).toBe(false);
    const mutations = transport.requests.filter(
      (request) => request.action === "bindings" && request.operation === "add",
    );
    expect(mutations).toHaveLength(2);
    expect(mutations.map((request) => request.expertId)).toEqual(["expert-a", "expert-b"]);
    expect(mutations[0]?.requestId).not.toBe(mutations[1]?.requestId);
    for (const mutation of mutations)
      expect(mutation.bindings).toEqual([
        {
          skillId: "skl_0123456789abcdef0123456789abcdef",
          enabled: true,
          selectionScope: "package",
          resourceMode: "run-private",
        },
      ]);
    expect(JSON.parse(output.text())).toMatchObject({
      ok: true,
      result: { results: [{ status: "applied" }, { status: "applied" }] },
    });
  });

  it("refreshes multiple Skills through one server batch with per-item CAS and partial status", async () => {
    const skillA = "skl_0123456789abcdef0123456789abcdef";
    const skillB = "skl_abcdef0123456789abcdef0123456789";
    const responseQueue: Array<unknown> = [
      { skill: { skillId: skillA, revision: 4, entryPath: "SKILL.md" } },
      { skill: { skillId: skillB, revision: 9, entryPath: "SKILL.md" } },
      {
        results: [
          { skillId: skillA, success: true, status: "updated" },
          { skillId: skillB, success: false, status: "failed", message: "Hosted source failed." },
        ],
      },
    ];
    transport.execute.mockImplementationOnce(async (input) => {
      transport.requests.push(input.request);
      return responseQueue.shift() as never;
    });
    transport.execute.mockImplementationOnce(async (input) => {
      transport.requests.push(input.request);
      return responseQueue.shift() as never;
    });
    transport.execute.mockImplementationOnce(async (input) => {
      transport.requests.push(input.request);
      return responseQueue.shift() as never;
    });
    const output = capture();
    const result = await executeManagementCli({
      baseDir: "/tmp/skill-cli-test-home",
      command: parseManagementCliCommand({
        namespace: "skill",
        args: ["refresh"],
        flags: {
          ...baseFlags,
          skillIds: `${skillA},${skillB}`,
          requestId: "refresh-many-1",
          overwriteLocalEdits: true,
        },
      }),
      io: { stdout: output.stream, stderr: capture().stream },
    });

    expect(result.exitCode).toBe(5);
    const batch = transport.requests.find((request) => request.action === "batch");
    expect(batch).toMatchObject({ requestId: "refresh-many-1", dryRun: false });
    expect(batch?.items).toEqual([
      expect.objectContaining({
        operation: "updateFromSource",
        skillId: skillA,
        expectedRevision: 4,
        overwriteLocalEdits: true,
      }),
      expect.objectContaining({
        operation: "updateFromSource",
        skillId: skillB,
        expectedRevision: 9,
        overwriteLocalEdits: true,
      }),
    ]);
    const items = batch?.items as Array<{ readonly requestId: string }>;
    expect(items.map((item) => item.requestId)).toEqual([
      expect.stringMatching(/^skill-refresh-cli-[a-f0-9]{64}$/u),
      expect.stringMatching(/^skill-refresh-cli-[a-f0-9]{64}$/u),
    ]);
    expect(items[0]?.requestId).not.toBe(items[1]?.requestId);
    expect(JSON.parse(output.text())).toMatchObject({ ok: false, partial: true, exitCode: 5 });
  });

  it("returns parser failures as stable JSON usage errors with exit code 2", async () => {
    for (const input of [
      { namespace: "skill" as const, args: ["nonexistent"] },
      { namespace: "skill" as const, args: [] },
      { namespace: "expert" as const, args: ["skills", "nonexistent"] },
    ]) {
      const output = capture();
      const result = await executeManagementCliArgs({
        ...input,
        flags: baseFlags,
        baseDir: "/tmp/unused-management-cli-parser-test",
        io: { stdout: output.stream, stderr: output.stream },
      });
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(output.text())).toMatchObject({
        version: 1,
        ok: false,
        error: { code: "usage_error", exitCode: 2 },
      });
    }
    process.exitCode = 0;
  });

  it("maps a requestId conflict to exit code 3", async () => {
    const { SkillManagementTransportError } = await import("./transport");
    transport.execute.mockRejectedValueOnce(
      new SkillManagementTransportError({
        message: "conflicting requestId",
        status: 409,
        code: "conflict",
      }),
    );
    const output = capture();
    const result = await executeManagementCli({
      baseDir: "/tmp/unused-management-cli-conflict-test",
      command: parseManagementCliCommand({
        namespace: "skill",
        args: ["create"],
        flags: {
          ...baseFlags,
          name: "one-skill",
          content: "---\\nname: one-skill\\n---\\nBody\\n",
          requestId: "same-id",
        },
      }),
      io: { stdout: output.stream, stderr: output.stream },
    });
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(output.text())).toMatchObject({
      version: 1,
      ok: false,
      error: { code: "conflict", exitCode: 3 },
    });
    process.exitCode = 0;
  });
});
