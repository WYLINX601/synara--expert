#!/usr/bin/env bun
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const safeErrors = new Set([
  "gateway-config-missing",
  "gateway-url-invalid",
  "gateway-url-must-be-local-http",
  "default-model-unavailable",
  "stored-credential-unavailable",
  "selected-gateway-tool-unavailable",
  "selected-tool-must-accept-text",
  "selected-skill-unavailable",
  "persona-not-installed",
  "gateway-tool-not-installed",
  "gateway-tool-request-failed",
  "gateway-tool-result-invalid",
  "gateway-result-missing-marker",
  "probe-tool-already-called",
]);
const timeout = (promise, ms, onTimeout) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new Error("probe-timeout"));
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
};
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

async function main() {
  const output = {
    ok: false,
    modelConfigured: false,
    gatewayToolListed: false,
    gatewayToolCalled: false,
    gatewayReturnedMarker: false,
    assistantReferencedReturnedMarker: false,
    personaApplied: false,
    skillApplied: false,
    errorCategory: null,
  };
  let stage = "configuration";
  let temp;
  let session;
  let gatewayCallCount = 0;
  let gatewayToolText = "";
  let timedOut = false;

  try {
    const gatewayUrl = process.env.P0_GATEWAY_URL;
    const gatewayToken = process.env.P0_GATEWAY_TOKEN;
    const toolName = process.env.P0_GATEWAY_TOOL?.trim() || "expert_probe_echo";
    if (!gatewayUrl || !gatewayToken) throw new Error("gateway-config-missing");
    let parsedUrl;
    try {
      parsedUrl = new URL(gatewayUrl);
    } catch {
      throw new Error("gateway-url-invalid");
    }
    if (
      parsedUrl.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsedUrl.hostname)
    ) {
      throw new Error("gateway-url-must-be-local-http");
    }
    const connection = { url: parsedUrl.href, bearerToken: gatewayToken };

    stage = "sdk";
    const sdkDir = resolve(root, "apps/server/node_modules/@earendil-works/pi-coding-agent/dist");
    const sdk = await import(pathToFileURL(join(sdkDir, "index.js")).href);
    const { AuthStorage } = await import(pathToFileURL(join(sdkDir, "core/auth-storage.js")).href);
    const { listAgentGatewayMcpTools, callAgentGatewayMcpTool } = await import(
      pathToFileURL(join(root, "apps/server/src/agentGateway/mcpInjection.ts")).href
    );

    temp = await mkdtemp(join(tmpdir(), "synara-expert-pi-gateway-live-"));
    const sourceAgentDir = sdk.getAgentDir();
    const settings = sdk.SettingsManager.create(temp, sourceAgentDir);
    const provider = settings.getDefaultProvider();
    const modelId = settings.getDefaultModel();
    if (!provider || !modelId) throw new Error("default-model-unavailable");
    stage = "auth";
    const sourceCredential = sdk.readStoredCredential(provider, join(sourceAgentDir, "auth.json"));
    if (!sourceCredential) throw new Error("stored-credential-unavailable");
    const credentials = AuthStorage.inMemory({ [provider]: sourceCredential });
    const modelRuntime = await sdk.ModelRuntime.create({
      credentials,
      modelsPath: join(sourceAgentDir, "models.json"),
      modelsStorePath: join(temp, "models-store.json"),
      allowModelNetwork: false,
    });
    await modelRuntime.refresh({ allowNetwork: false });
    if (!modelRuntime.hasConfiguredAuth(provider)) throw new Error("stored-credential-unavailable");
    const model = modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error("default-model-unavailable");
    output.modelConfigured = true;

    stage = "gateway-list";
    const descriptors = await timeout(
      listAgentGatewayMcpTools({ connection, signal: AbortSignal.timeout(10_000) }),
      11_000,
    );
    const descriptor = descriptors.find((tool) => tool.name === toolName);
    if (!descriptor) throw new Error("selected-gateway-tool-unavailable");
    if (!isRecord(descriptor.inputSchema.properties?.text)) {
      throw new Error("selected-tool-must-accept-text");
    }
    output.gatewayToolListed = true;

    stage = "session";
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
      modelRuntime,
      resourceLoaderOptions: {
        appendSystemPrompt: ["Prefix every final reply with PERSONA_PI:."],
        additionalSkillPaths: [skillRoot],
        noExtensions: true,
      },
    });
    if (!services.resourceLoader.getSkills().skills.some((skill) => skill.name === "expert-live")) {
      throw new Error("selected-skill-unavailable");
    }
    const marker = `P0_DOWNSTREAM_${randomUUID().replaceAll("-", "").toUpperCase()}`;
    const tool = sdk.defineTool({
      name: descriptor.name,
      label: descriptor.name,
      description: descriptor.description,
      parameters: descriptor.inputSchema,
      execute: async (_toolCallId, params, signal) => {
        gatewayCallCount += 1;
        if (gatewayCallCount > 1) throw new Error("probe-tool-already-called");
        output.gatewayToolCalled = true;
        let result;
        try {
          result = await callAgentGatewayMcpTool({
            connection,
            name: descriptor.name,
            arguments: { ...(isRecord(params) ? params : {}), text: marker },
            ...(signal === undefined ? {} : { signal }),
          });
        } catch {
          throw new Error("gateway-tool-request-failed");
        }
        if (!isRecord(result) || result.isError === true || !Array.isArray(result.content)) {
          throw new Error("gateway-tool-result-invalid");
        }
        gatewayToolText = result.content
          .filter((item) => isRecord(item) && item.type === "text" && typeof item.text === "string")
          .map((item) => item.text)
          .join("\n");
        output.gatewayReturnedMarker = gatewayToolText.includes(marker);
        if (!output.gatewayReturnedMarker) throw new Error("gateway-result-missing-marker");
        return { content: [{ type: "text", text: gatewayToolText }] };
      },
    });
    ({ session } = await sdk.createAgentSessionFromServices({
      services,
      sessionManager: sdk.SessionManager.inMemory(cwd),
      model,
      thinkingLevel: "off",
      customTools: [tool],
    }));
    if (!session.systemPrompt.includes("PERSONA_PI:")) throw new Error("persona-not-installed");
    if (!session.getActiveToolNames().includes(descriptor.name)) {
      throw new Error("gateway-tool-not-installed");
    }

    stage = "model-turn";
    await timeout(
      session.prompt(
        `Use the expert-live skill. Call ${descriptor.name} once with a short text value. Then write one short sentence quoting the exact opaque marker from the tool result.`,
      ),
      60_000,
      () => {
        timedOut = true;
        void session?.abort().catch(() => undefined);
      },
    );
    const assistantText = session.messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    output.assistantReferencedReturnedMarker =
      output.gatewayReturnedMarker && assistantText.includes(marker);
    output.personaApplied = assistantText.includes("PERSONA_PI:");
    output.skillApplied = assistantText.includes("SKILL_PI");
    output.ok =
      output.modelConfigured &&
      output.gatewayToolListed &&
      output.gatewayToolCalled &&
      output.gatewayReturnedMarker &&
      output.assistantReferencedReturnedMarker &&
      output.personaApplied &&
      output.skillApplied;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    output.errorCategory = timedOut
      ? `${stage}-timeout`
      : safeErrors.has(message)
        ? message
        : `${stage}-failed`;
  } finally {
    if (session) {
      try {
        await timeout(Promise.resolve(session.dispose()), 3_000);
      } catch {
        output.errorCategory ??= "session-cleanup-incomplete";
      }
    }
    if (temp) {
      try {
        await rm(temp, { recursive: true, force: true });
      } catch {
        output.errorCategory ??= "temporary-cleanup-incomplete";
      }
    }
  }

  console.log(JSON.stringify(output));
  if (!output.ok) process.exitCode = 1;
}

await main();
