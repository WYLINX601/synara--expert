import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sdkDir = resolve(root, "apps/server/node_modules/@earendil-works/pi-coding-agent/dist");
const sdk = await import(pathToFileURL(join(sdkDir, "index.js")).href);
const { AuthStorage } = await import(pathToFileURL(join(sdkDir, "core/auth-storage.js")).href);
const sourceAgentDir = sdk.getAgentDir();
const temp = await mkdtemp(join(tmpdir(), "synara-expert-pi-live-"));
const settings = sdk.SettingsManager.create(temp, sourceAgentDir);
const provider = settings.getDefaultProvider();
const modelId = settings.getDefaultModel();
let session;
let timer;
let toolCalled = false;

try {
  assert(provider && modelId, "Current Pi provider/model is not configured");
  const sourceCredential = sdk.readStoredCredential(provider, join(sourceAgentDir, "auth.json"));
  assert(sourceCredential, "Current Pi provider has no stored credential");
  const credentials = AuthStorage.inMemory({ [provider]: sourceCredential });
  const runtime = await sdk.ModelRuntime.create({
    credentials,
    modelsPath: join(sourceAgentDir, "models.json"),
    modelsStorePath: join(temp, "models-store.json"),
    allowModelNetwork: false,
  });
  assert(runtime.hasConfiguredAuth(provider));
  const model = runtime.getModel(provider, modelId);
  assert(model, "Current Pi model was not found");

  const cwd = join(temp, "work");
  const agentDir = join(temp, "agent");
  const skillRoot = join(temp, "skills");
  const skillDir = join(skillRoot, "expert-live");
  await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(skillDir, { recursive: true })]);
  await writeFile(
    join(skillDir, "SKILL.md"),
    "---\nname: expert-live\ndescription: P0 expert skill\n---\nInclude SKILL_PI in the final answer.\n",
  );
  const services = await sdk.createAgentSessionServices({
    cwd,
    agentDir,
    modelRuntime: runtime,
    resourceLoaderOptions: {
      appendSystemPrompt: ["Prefix every final reply with PERSONA_PI:."],
      additionalSkillPaths: [skillRoot],
      noExtensions: true,
    },
  });
  assert(services.resourceLoader.getSkills().skills.some((skill) => skill.name === "expert-live"));
  const tool = sdk.defineTool({
    name: "expert_probe",
    label: "Expert Probe",
    description: "Return the P0 expert tool token.",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      toolCalled = true;
      return { content: [{ type: "text", text: "TOOL_PI" }] };
    },
  });
  ({ session } = await sdk.createAgentSessionFromServices({
    services,
    sessionManager: sdk.SessionManager.inMemory(cwd),
    model,
    thinkingLevel: "off",
    customTools: [tool],
  }));
  assert(session.getActiveToolNames().includes("expert_probe"));
  timer = setTimeout(() => session.abort(), 90_000);
  await session.prompt(
    "Use the expert-live skill, call expert_probe, and report the tool result in one short sentence.",
  );
  const text = session.messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const outcome = {
    model: `${provider}/${modelId}`,
    persona: text.includes("PERSONA_PI:"),
    skill: text.includes("SKILL_PI"),
    toolCalled,
    toolResult: text.includes("TOOL_PI"),
  };
  console.log(JSON.stringify(outcome));
  assert(outcome.persona && outcome.skill && outcome.toolCalled && outcome.toolResult);
} finally {
  clearTimeout(timer);
  session?.dispose();
  await rm(temp, { recursive: true, force: true });
}
