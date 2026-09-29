import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sdkPath = resolve(
  root,
  "apps/server/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
);
const { createAgentSessionServices, createAgentSessionFromServices, SessionManager, defineTool } =
  await import(pathToFileURL(sdkPath).href);

const temp = await mkdtemp(join(tmpdir(), "synara-expert-pi-p0-"));
const sessions = [];
try {
  const cwd = join(temp, "work");
  const agentDir = join(temp, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);

  const create = async (name) => {
    const skillRoot = join(temp, name, "skills");
    const skillDir = join(skillRoot, `expert-${name}`);
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---\nname: expert-${name}\ndescription: P0 ${name} skill\n---\nP0 ${name}.\n`,
    );
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: {
        appendSystemPrompt: [`EXPERT_${name}`],
        additionalSkillPaths: [skillRoot],
        noExtensions: true,
      },
    });
    const tool = defineTool({
      name: `expert_${name}`,
      label: `Expert ${name}`,
      description: "P0 offline tool",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: name }] }),
    });
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(),
      customTools: [tool],
    });
    sessions.push(session);
    return session;
  };

  const [a, b] = await Promise.all([create("a"), create("b")]);
  for (const [own, other, name] of [
    [a, b, "a"],
    [b, a, "b"],
  ]) {
    assert(own.systemPrompt.includes(`EXPERT_${name}`));
    assert(!other.systemPrompt.includes(`EXPERT_${name}`));
    assert(own.resourceLoader.getSkills().skills.some((skill) => skill.name === `expert-${name}`));
    assert(
      !other.resourceLoader.getSkills().skills.some((skill) => skill.name === `expert-${name}`),
    );
    assert(own.getActiveToolNames().includes(`expert_${name}`));
    assert(!other.getActiveToolNames().includes(`expert_${name}`));
  }
  const ambientSkills = a.resourceLoader
    .getSkills()
    .skills.filter((skill) => skill.name !== "expert-a");
  console.log(
    `Pi SDK: two concurrent sessions isolate persona, selected skill and custom tool; ${ambientSkills.length} ambient skills remain visible.`,
  );
} finally {
  for (const session of sessions) session.dispose();
  await rm(temp, { recursive: true, force: true });
}
