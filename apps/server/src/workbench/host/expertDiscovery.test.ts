import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { WsRpcError } from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createExpertStore, expertResourceFiles } from "../../experts/ExpertStore";
import { createSkillLibraryStore } from "../../experts/SkillLibraryStore";
import { makeWorkbenchExpertDiscoveryHandlers } from "./expertRpc";

describe("fixed Expert discovery RPC host wiring", () => {
  it("uses the admitted snapshot before native discovery, including empty assemblies and queued revisions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fixed-discovery-rpc-")),
      store = createSkillLibraryStore(root),
      experts = createExpertStore(root);
    try {
      const skill = (
        await store.execute({
          action: "create",
          name: "selected-a",
          body: "---\nname: selected-a\ndescription: Selected only\n---\nA\n",
          tags: [],
        })
      ).skill!;
      const definition = await experts.save({
        name: "Fixed",
        description: "",
        useCases: "",
        persona: "Fixed",
        outputRequirements: "",
        skills: [],
        skillBindings: [{ skillId: skill.skillId, enabled: true, activation: "on-demand" }],
        references: [],
        connections: [],
      });
      const binding = await experts.prepareSnapshot(definition.id);
      await store.execute({
        action: "save",
        skillId: skill.skillId,
        expectedRevision: skill.revision,
        name: skill.name,
        tags: [],
        changes: [
          {
            path: "SKILL.md",
            content: Buffer.from("---\nname: new-head\ndescription: New head\n---\nNew\n").toString(
              "base64",
            ),
          },
        ],
      });
      const nativeCommands = vi.fn(() =>
          Effect.succeed({
            commands: [{ name: "advisor" }, { name: "ambient-c" }],
            source: "native",
            cached: false,
          }),
        ),
        nativeSkills = vi.fn(() =>
          Effect.succeed({
            skills: [{ name: "ambient-c", path: "/outside/SKILL.md", enabled: true }],
            source: "native",
            cached: false,
          }),
        );
      const readSnapshot = vi.fn((id: string) => experts.readSnapshot(id));
      const handlers = makeWorkbenchExpertDiscoveryHandlers({
        requireOwner: Effect.void,
        loadThreadBinding: () => Effect.succeed(binding),
        readSnapshot,
        listCommands: nativeCommands,
        listSkills: nativeSkills,
      });
      expect(
        (
          await Effect.runPromise(
            handlers.listCommands({ provider: "omp", cwd: root, threadId: "accepted" }),
          )
        ).commands,
      ).toEqual([]);
      const skills = await Effect.runPromise(
        handlers.listSkills({ provider: "codex", cwd: root, threadId: "accepted" }),
      );
      expect(skills.skills).toHaveLength(1);
      expect(skills.skills[0]!.name).toBe("selected-a");
      expect(skills.skills[0]!.expert?.packageId).toBe(skill.packageId);
      expect(nativeCommands).not.toHaveBeenCalled();
      expect(nativeSkills).not.toHaveBeenCalled();
      const empty = await experts.save({
        ...definition,
        expectedRevision: definition.revision,
        skillBindings: [],
      });
      const emptyBinding = await experts.prepareSnapshot(empty.id);
      const emptyHandlers = makeWorkbenchExpertDiscoveryHandlers({
        requireOwner: Effect.void,
        loadThreadBinding: () => Effect.succeed(emptyBinding),
        readSnapshot,
        listCommands: nativeCommands,
        listSkills: nativeSkills,
      });
      expect(
        (
          await Effect.runPromise(
            emptyHandlers.listSkills({ provider: "codex", cwd: root, threadId: "empty" }),
          )
        ).skills,
      ).toEqual([]);
      await Effect.runPromise(handlers.listCommands({ provider: "omp", cwd: root }));
      expect(nativeCommands).toHaveBeenCalledOnce();
      const denied = makeWorkbenchExpertDiscoveryHandlers({
        requireOwner: Effect.fail(new WsRpcError({ message: "Owner required" })),
        loadThreadBinding: () => Effect.succeed(binding),
        readSnapshot,
        listCommands: nativeCommands,
        listSkills: nativeSkills,
      });
      const previous = readSnapshot.mock.calls.length;
      await expect(
        Effect.runPromise(
          denied.listCommands({ provider: "omp", cwd: root, threadId: "accepted" }),
        ),
      ).rejects.toThrow(/Owner required/u);
      expect(readSnapshot).toHaveBeenCalledTimes(previous);
      const legacy = makeWorkbenchExpertDiscoveryHandlers({
        requireOwner: Effect.void,
        loadThreadBinding: () => Effect.succeed(binding),
        readSnapshot: async (id) => ({
          ...(await experts.readSnapshot(id)),
          schemaVersion: 2,
          skillPolicy: undefined,
        }),
        listCommands: nativeCommands,
        listSkills: nativeSkills,
      });
      await expect(
        Effect.runPromise(
          legacy.listCommands({ provider: "omp", cwd: root, threadId: "historical" }),
        ),
      ).rejects.toThrow(/historical/iu);
      expect(nativeCommands).toHaveBeenCalledOnce();
    } finally {
      await store.dispose();
      await expertResourceFiles.removeStaging(root);
    }
  });
});
