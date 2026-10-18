import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { ExpertConnectionSaveInput, ExpertMcpBinding } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createExpertStore } from "./ExpertStore.ts";
import {
  createExpertConnectionStore,
  scanExpertConnectionReferences,
} from "./ExpertConnectionStore.ts";
import { createExpertMcpBindingStore } from "./ExpertMcpBindingStore.ts";

const temporaryRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "synara-expert-connection-"));
  temporaryRoots.push(root);
  return root;
}

async function makeWritableTree(target: string): Promise<void> {
  const stat = await lstat(target).catch(() => null);
  if (!stat || stat.isSymbolicLink()) return;
  await chmod(target, stat.isDirectory() ? 0o700 : 0o600).catch(() => undefined);
  if (!stat.isDirectory()) return;
  for (const entry of await readdir(target)) {
    await makeWritableTree(path.join(target, entry));
  }
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await makeWritableTree(root);
    await rm(root, { recursive: true, force: true });
  }
});

function stdioInput(
  id: string,
  extra: Partial<ExpertConnectionSaveInput> = {},
): ExpertConnectionSaveInput {
  return {
    id,
    name: "Local tools",
    transport: { type: "stdio", command: "node", args: [], envFromHost: [] },
    ...extra,
  };
}

async function makeAllModeSnapshot() {
  const stateDir = path.join(await makeTempRoot(), "state");
  const connections = createExpertConnectionStore(stateDir);
  await connections.save(stdioInput("all-mcp"));
  const experts = createExpertStore(stateDir);
  const expert = await experts.save({
    id: "all-mode-reference-test",
    name: "All-mode reference test",
    description: "",
    useCases: "",
    persona: "",
    outputRequirements: "",
    skills: [],
    references: [],
    connections: [{ id: "all-mcp", required: false, tools: [], toolMode: "all" }],
  });
  const taskBinding = await experts.prepareSnapshot(expert.id);
  const snapshot = await experts.readSnapshot(taskBinding.snapshotId);
  if (!snapshot.mcpBinding) throw new Error("Expected a pinned MCP binding.");
  return { stateDir, snapshot, binding: snapshot.mcpBinding };
}

describe("ExpertConnectionStore", () => {
  it("persists source provenance across current and immutable revisions", async () => {
    const store = createExpertConnectionStore(path.join(await makeTempRoot(), "state"));
    const firstSource = { kind: "codex" as const, path: "/tmp/codex.toml", entryId: "fixture" };
    const secondSource = {
      kind: "json" as const,
      path: "/tmp/mcp.json",
      entryId: "servers:fixture",
    };
    const first = await store.save(stdioInput("imported", { importedFrom: [firstSource] }));
    const second = await store.save(
      stdioInput("imported", {
        name: "Imported MCP",
        expectedRevision: first.revision,
        importedFrom: [firstSource, secondSource],
      }),
    );

    expect(first.importedFrom).toEqual([firstSource]);
    expect(second.importedFrom).toEqual([firstSource, secondSource]);
    expect(await store.readRevision("imported", 1)).toEqual(first);
    expect(await store.readRevision("imported", 2)).toEqual(second);
  });

  it("keeps immutable revisions readable and retires removed IDs permanently", async () => {
    const store = createExpertConnectionStore(path.join(await makeTempRoot(), "state"));
    const created = await store.save(stdioInput("local-tools"));
    expect(created).toMatchObject({ id: "local-tools", revision: 1 });
    expect(await store.readRevision("local-tools", 1)).toEqual(created);
    expect((await store.read(created.id))?.transport).toEqual({
      type: "stdio",
      command: "node",
      args: [],
      envFromHost: [],
    });
    expect((await store.list()).map(({ id }) => id)).toEqual(["local-tools"]);

    const pinned = await store.pinRevision(created.id);
    expect(pinned).toEqual(created);
    const updates = await Promise.allSettled([
      store.save(stdioInput("local-tools", { name: "First", expectedRevision: 1 })),
      store.save(stdioInput("local-tools", { name: "Second", expectedRevision: 1 })),
    ]);
    expect(updates.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(updates.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(updates.find(({ status }) => status === "rejected")).toMatchObject({
      reason: { code: "revision_conflict" },
    });
    const current = await store.read(created.id);
    expect(current?.revision).toBe(2);
    expect(await store.readRevision("local-tools", 1)).toEqual(created);
    expect(await store.readRevision("local-tools", 2)).toEqual(current);
    await store.remove(created.id, 2);
    expect(await store.read(created.id)).toBeNull();
    expect(await store.readRevision("local-tools", 1)).toEqual(created);
    expect((await store.readState("local-tools")).status).toBe("retired");
    await expect(store.save(stdioInput("local-tools"))).rejects.toMatchObject({
      code: "revision_conflict",
    });
    await expect(
      store.setState({ id: "local-tools", status: "active", expectedRevision: 2 }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("serializes state CAS across store instances and publishes only committed changes", async () => {
    const stateDir = path.join(await makeTempRoot(), "state");
    const first = createExpertConnectionStore(stateDir);
    const second = createExpertConnectionStore(stateDir);
    await first.save(stdioInput("stateful"));
    expect(await first.readState("stateful")).toMatchObject({
      id: "stateful",
      status: "active",
      revision: 1,
    });

    const events: unknown[] = [];
    const unsubscribe = second.subscribeStateChanges((state) => events.push(state));
    const disabled = await first.setState({
      id: "stateful",
      status: "disabled",
      expectedRevision: 1,
    });
    expect(disabled).toMatchObject({ status: "disabled", revision: 2 });
    expect(await second.readState("stateful")).toEqual(disabled);
    expect(events).toEqual([disabled]);

    const competing = await Promise.allSettled([
      first.setState({ id: "stateful", status: "active", expectedRevision: 2 }),
      second.setState({ id: "stateful", status: "retired", expectedRevision: 2 }),
    ]);
    expect(competing.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(competing.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(competing.find(({ status }) => status === "rejected")).toMatchObject({
      reason: { code: "revision_conflict" },
    });
    expect(events).toHaveLength(2);
    unsubscribe();
    const current = await first.readState("stateful");
    await first.setState({
      id: "stateful",
      status: current.status,
      expectedRevision: current.revision,
    });
    expect(events).toHaveLength(2);
  });

  it("leaves current unchanged when archive storage fails", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const store = createExpertConnectionStore(stateDir);
    const created = await store.save(stdioInput("stable"));
    const revisionsDir = path.join(stateDir, "expert-connections", "revisions");
    const backupDir = path.join(stateDir, "expert-connections", "revisions.backup");
    const externalDir = path.join(root, "external-revisions");
    await mkdir(externalDir);
    await rename(revisionsDir, backupDir);
    await symlink(externalDir, revisionsDir);

    await expect(
      store.save(stdioInput("stable", { name: "Updated", expectedRevision: 1 })),
    ).rejects.toMatchObject({ code: "corrupt" });
    await rm(revisionsDir);
    await rename(backupDir, revisionsDir);
    expect(await store.read("stable")).toEqual(created);
  });

  it("rejects symlinked revision directories, current files, and expert roots", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const store = createExpertConnectionStore(stateDir);
    await store.save(stdioInput("revision-link"));
    const revisionDirectory = path.join(
      stateDir,
      "expert-connections",
      "revisions",
      "revision-link",
    );
    const outsideRevisionDirectory = path.join(root, "outside-revisions");
    await mkdir(outsideRevisionDirectory);
    await rm(revisionDirectory, { recursive: true, force: true });
    await symlink(outsideRevisionDirectory, revisionDirectory);
    await expect(store.readRevision("revision-link", 1)).rejects.toMatchObject({
      code: "corrupt",
    });

    const currentPath = path.join(stateDir, "expert-connections", "file-link.json");
    const outsideFile = path.join(root, "outside.json");
    await writeFile(outsideFile, JSON.stringify(await store.save(stdioInput("file-link"))));
    await rm(currentPath);
    await symlink(outsideFile, currentPath);
    await expect(store.read("file-link")).rejects.toMatchObject({ code: "corrupt" });

    const scanStateDir = path.join(root, "scan-state");
    const outsideExperts = path.join(root, "outside-experts");
    await mkdir(scanStateDir);
    await mkdir(outsideExperts);
    await symlink(outsideExperts, path.join(scanStateDir, "experts"));
    await expect(
      scanExpertConnectionReferences(scanStateDir, "revision-link"),
    ).rejects.toMatchObject({
      code: "corrupt",
    });
  });

  it("blocks removal for active experts and immutable historical snapshots", async () => {
    const stateDir = path.join(await makeTempRoot(), "state");
    const connections = createExpertConnectionStore(stateDir);
    await connections.save(stdioInput("mcp-one"));
    const experts = createExpertStore(stateDir);
    await experts.save({
      id: "helper-one",
      name: "Helper",
      description: "",
      useCases: "",
      persona: "",
      outputRequirements: "",
      skills: [],
      references: [],
      connections: [{ id: "mcp-one", required: false, tools: ["read"] }],
    });
    const snapshot = await experts.prepareSnapshot("helper-one");
    const references = await scanExpertConnectionReferences(stateDir, "mcp-one");
    expect(references.experts).toMatchObject([
      { id: "helper-one", enabled: true, required: false, tools: ["read"] },
    ]);
    expect(references.snapshots).toMatchObject([
      {
        snapshotId: snapshot.snapshotId,
        expertId: "helper-one",
        configRevision: 1,
        required: false,
        legacy: false,
      },
    ]);
    await expect(connections.remove("mcp-one", 1)).rejects.toMatchObject({
      code: "in_use",
    });

    await experts.archive("helper-one", 1);
    expect((await scanExpertConnectionReferences(stateDir, "mcp-one")).experts[0]?.enabled).toBe(
      false,
    );
    await expect(connections.remove("mcp-one", 1)).rejects.toMatchObject({
      code: "in_use",
    });
  });

  it.each([
    ["resolved tools", { status: "resolved" as const, tools: ["read", "write"] }],
    ["unavailable tools", { status: "unavailable" as const, tools: [] }],
  ])("scans references when an all-mode sidecar has %s", async (_label, resolution) => {
    const { stateDir, snapshot, binding } = await makeAllModeSnapshot();
    const bindings = createExpertMcpBindingStore(stateDir);
    await bindings.get(snapshot.snapshotId, () => binding);
    await bindings.resolveToolsOnce(snapshot.snapshotId, "all-mcp", resolution);

    await expect(scanExpertConnectionReferences(stateDir, "all-mcp")).resolves.toMatchObject({
      experts: [{ id: "all-mode-reference-test", toolMode: "all", tools: [] }],
      snapshots: [
        {
          snapshotId: snapshot.snapshotId,
          expertId: snapshot.expertId,
          configRevision: 1,
          required: false,
          toolMode: "all",
          legacy: false,
        },
      ],
    });
  });

  it.each([
    [
      "config revision",
      (binding: ExpertMcpBinding): ExpertMcpBinding => ({
        ...binding,
        servers: binding.servers.map((server) => ({
          ...server,
          configRevision: (server.configRevision ?? 0) + 1,
        })),
      }),
    ],
    [
      "tool mode",
      (binding: ExpertMcpBinding): ExpertMcpBinding => ({
        ...binding,
        servers: binding.servers.map((server) => ({ ...server, toolMode: "selected" })),
      }),
    ],
    [
      "authorization ID",
      (binding: ExpertMcpBinding): ExpertMcpBinding => ({
        ...binding,
        authorizationId: "different-task-authorization",
      }),
    ],
  ])("rejects a sidecar with a mismatched pinned %s", async (_field, mutate) => {
    const { stateDir, snapshot, binding } = await makeAllModeSnapshot();
    await createExpertMcpBindingStore(stateDir).createOnce(snapshot.snapshotId, mutate(binding));

    await expect(scanExpertConnectionReferences(stateDir, "all-mcp")).rejects.toMatchObject({
      code: "corrupt",
    });
  });

  it("blocks removal when an orphan legacy binding sidecar still names the connection", async () => {
    const stateDir = path.join(await makeTempRoot(), "state");
    const connections = createExpertConnectionStore(stateDir);
    await connections.save(stdioInput("legacy-mcp"));
    const bindings = createExpertMcpBindingStore(stateDir);
    const snapshotId = "exp_" + "a".repeat(64);
    const capture = vi.fn(() => ({
      schemaVersion: 1 as const,
      source: "legacy-current" as const,
      createdAt: "2026-10-04T00:00:00.000Z",
      servers: [
        {
          id: "legacy-mcp",
          configRevision: 1,
          required: false,
          tools: ["read"],
        },
      ],
    }));
    const [first, second] = await Promise.all([
      bindings.get(snapshotId, capture),
      bindings.get(snapshotId, capture),
    ]);
    expect(first).toEqual(second);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(await bindings.createOnce(snapshotId, first)).toEqual(first);
    await expect(
      bindings.createOnce(snapshotId, { ...first, createdAt: "2026-10-05T00:00:00.000Z" }),
    ).rejects.toMatchObject({ code: "revision_conflict" });

    const references = await scanExpertConnectionReferences(stateDir, "legacy-mcp");
    expect(references.snapshots).toMatchObject([
      {
        snapshotId,
        configRevision: 1,
        required: false,
        legacy: true,
      },
    ]);
    await expect(connections.remove("legacy-mcp", 1)).rejects.toMatchObject({
      code: "in_use",
    });
  });

  it("rejects plaintext credentials and unexpected secret fields", async () => {
    const store = createExpertConnectionStore(path.join(await makeTempRoot(), "state"));
    await expect(
      store.save(
        stdioInput("plain-arg", {
          transport: {
            type: "stdio",
            command: "node",
            args: ["--token", "plain-secret"],
            envFromHost: [],
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      store.save({
        ...stdioInput("plain-header"),
        transport: {
          type: "http",
          url: "https://tools.example/mcp",
          headersFromHost: [],
          headers: { Authorization: "Bearer plain-secret" },
        },
      } as never),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      store.save({
        id: "plain-url",
        name: "Plain URL",
        transport: {
          type: "http",
          url: "https://tools.example/mcp?access_token=plain-secret",
          headersFromHost: [],
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      store.save({
        id: "query-url",
        name: "Query URL",
        transport: {
          type: "http",
          url: "https://tools.example/mcp?region=local",
          headersFromHost: [],
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      store.save({
        id: "duplicate-secret-name",
        name: "Duplicate secret name",
        transport: {
          type: "stdio",
          command: "node",
          args: [],
          envFromHost: [{ name: "TOKEN", envVar: "HOST_TOKEN" }],
          envFromSecret: {
            credentialId: "01234567-89ab-cdef-0123-456789abcdef",
            names: ["TOKEN"],
          },
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(await store.list()).toEqual([]);
  });

  it("rejects unsafe IDs and oversized inputs", async () => {
    const store = createExpertConnectionStore(path.join(await makeTempRoot(), "state"));
    await expect(store.read("../outside")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      store.save(
        stdioInput("too-large", {
          transport: {
            type: "stdio",
            command: "node",
            args: Array.from({ length: 10 }, () => "x".repeat(8_000)),
            envFromHost: [],
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("limits the final UTF-8 JSON bytes before writing any revision", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const store = createExpertConnectionStore(stateDir);
    const argsFor = (paddingLength: number): string[] => {
      let remaining = paddingLength;
      const args = ['汉字"\\\n'];
      for (let index = 0; index < 9; index += 1) {
        const length = Math.min(8_192, remaining);
        args.push("x".repeat(length));
        remaining -= length;
      }
      if (remaining !== 0) throw new Error("Boundary fixture exceeds the argument schema.");
      return args;
    };
    const inputFor = (
      paddingLength: number,
      expectedRevision?: number,
    ): ExpertConnectionSaveInput => ({
      id: "byte-limit",
      name: "含中文的 MCP",
      transport: { type: "stdio", command: "node", args: argsFor(paddingLength), envFromHost: [] },
      importedFrom: [{ kind: "json", path: "/tmp/空间.json", entryId: "mcpServers:fixture" }],
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    });
    const projectedBytes = (input: ExpertConnectionSaveInput, revision: number): number => {
      const { expectedRevision: _ignored, ...persistedInput } = input;
      void _ignored;
      return Buffer.byteLength(
        JSON.stringify(
          {
            ...persistedInput,
            revision,
            updatedAt: "2026-10-18T00:00:00.000Z",
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );
    };

    let low = 0;
    let high = 9 * 8_192;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (projectedBytes(inputFor(middle), 1) <= 64 * 1024) low = middle;
      else high = middle - 1;
    }
    const exactInput = inputFor(low);
    expect(projectedBytes(exactInput, 1)).toBe(64 * 1024);
    expect(Buffer.byteLength(JSON.stringify(exactInput), "utf8")).toBeLessThan(64 * 1024);

    const saved = await store.save(exactInput);
    const currentPath = path.join(stateDir, "expert-connections", "byte-limit.json");
    const currentContents = await readFile(currentPath, "utf8");
    expect(Buffer.byteLength(currentContents, "utf8")).toBe(64 * 1024);
    expect(currentContents.endsWith("\n")).toBe(true);
    expect(await store.read("byte-limit")).toEqual(saved);

    const revisionDirectory = path.join(stateDir, "expert-connections", "revisions", "byte-limit");
    await rm(path.join(revisionDirectory, "1.json"));
    const before = await readFile(currentPath);
    const tooLarge = inputFor(low + 1, 1);
    expect(projectedBytes(tooLarge, 2)).toBe(64 * 1024 + 1);
    expect(Buffer.byteLength(JSON.stringify(tooLarge), "utf8")).toBeLessThan(64 * 1024);
    await expect(store.save(tooLarge)).rejects.toMatchObject({ code: "invalid_input" });
    expect(await readFile(currentPath)).toEqual(before);
    expect(await readdir(revisionDirectory)).toEqual([]);
  });
});
