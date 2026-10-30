import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { FIXED_EXPERT_SKILL_POLICY, type ProviderExpertSession } from "@synara/contracts";
import {
  createExpertSkillApplication,
  recordVerifiedNativeSkillAssembly,
  verifyFixedExpertAssembly,
} from "./expertSkillCatalog";
import { verifyProjectedSkillAssembly } from "./fixedSkillProjection";
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});
describe("fixed native Expert assembly", () => {
  it("empty means zero native, global, bundled, project and plugin entries", async () => {
    const session: ProviderExpertSession = {
      snapshotId: "empty",
      persona: "Expert",
      skills: [],
      skillEntries: [],
      skillPolicy: FIXED_EXPERT_SKILL_POLICY,
      references: [],
    };
    await verifyFixedExpertAssembly(session, []);
    await expect(
      verifyFixedExpertAssembly(session, [{ name: "bundled", path: "/global/SKILL.md" }]),
    ).rejects.toThrow(/catalog/iu);
  });
  it("binds native receipts to the verified lifecycle and revokes proof on a failed reload", async () => {
    const session: ProviderExpertSession = {
      snapshotId: `exp_${"f".repeat(64)}`,
      persona: "Fixed",
      skills: [],
      skillEntries: [],
      skillPolicy: FIXED_EXPERT_SKILL_POLICY,
      references: [],
    };
    const receipt = (lifecycleGeneration: string) =>
      createExpertSkillApplication({ session, instructions: "fixed", lifecycleGeneration });
    expect(() => receipt("generation-1")).toThrow(/native verification/iu);
    await recordVerifiedNativeSkillAssembly(session, [], "generation-1");
    expect(receipt("generation-1").enforcement).toBe("native-fixed");
    expect(() => receipt("generation-2")).toThrow(/current lifecycle generation/iu);
    await recordVerifiedNativeSkillAssembly(session, [], "generation-2");
    expect(receipt("generation-2").lifecycleGeneration).toBe("generation-2");
    await expect(
      verifyProjectedSkillAssembly(
        session,
        {
          root: "/not-used",
          skillRoots: [],
          packages: [],
          entries: [],
        },
        [{ name: "ambient", path: "/outside/SKILL.md" }],
        "generation-2",
      ),
    ).rejects.toThrow(/unselected/iu);
    expect(() => receipt("generation-2")).toThrow(/native verification/iu);
    await recordVerifiedNativeSkillAssembly(session, [], "generation-2");
    expect(() => receipt("generation-1")).toThrow(/current lifecycle generation/iu);
    await expect(
      recordVerifiedNativeSkillAssembly(
        session,
        [{ name: "ambient", path: "/outside/SKILL.md" }],
        "generation-2",
      ),
    ).rejects.toThrow(/catalog/iu);
    expect(() => receipt("generation-2")).toThrow(/native verification/iu);
  });
  it("requires exact paths, the complete set, and pinned bytes even for same-name impostors", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fixed-expert-"));
    directories.push(directory);
    const file = path.join(directory, "SKILL.md"),
      bytes = Buffer.from("fixed content");
    await fs.writeFile(file, bytes);
    const entry = {
      packageId: `pkg_${"a".repeat(64)}`,
      entryPath: "SKILL.md",

      name: "selected",
      description: "",
      path: file,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const session: ProviderExpertSession = {
      snapshotId: "fixed",
      persona: "Expert",
      skills: [{ name: entry.name, path: file }],
      skillEntries: [entry],
      skillPolicy: FIXED_EXPERT_SKILL_POLICY,
      references: [],
    };
    await verifyFixedExpertAssembly(session, session.skills);
    await expect(
      verifyFixedExpertAssembly(session, [{ name: entry.name, path: `${file}.other` }]),
    ).rejects.toThrow(/identity/iu);
    await expect(
      verifyFixedExpertAssembly(session, [...session.skills, { name: "other", path: "/other" }]),
    ).rejects.toThrow(/catalog/iu);
    await fs.writeFile(file, "changed");
    await expect(verifyFixedExpertAssembly(session, session.skills)).rejects.toThrow(/changed/iu);
  });
});
