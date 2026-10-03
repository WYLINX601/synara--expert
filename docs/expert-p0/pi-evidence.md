# Pi P0 evidence

## SDK-only session/resource probe

The checkout declares `@earendil-works/pi-coding-agent@^0.85.1`; `bun.lock` resolves it to **0.85.1**, and the package installed under `apps/server/node_modules` is also **0.85.1**. The global `pi` CLI is **0.87.1** and was not used. Node is **v22.23.1** and Bun is **1.4.0**. A direct import smoke check against 0.85.1 found `createAgentSessionServices`, `createAgentSessionFromServices`, and `createAgentSessionRuntime` as functions. Its `DefaultResourceLoader` accepts per-runtime `appendSystemPrompt` and `additionalSkillPaths`.

Command:

```sh
node scripts/expert-p0/pi-probe.mjs
```

Result:

```text
Pi SDK: two concurrent sessions isolate persona, selected skill and custom tool; 2 ambient skills remain visible.
```

The script creates two SDK sessions concurrently with distinct appended persona markers, selected skill folders, and registered custom tools. It asserts each session sees its own marker, skill, and tool, and does not see the sibling session's resources. This verifies per-session SDK resource construction and custom-tool registration; it does not invoke the tool, call a model, or exercise resume/reconstruction and cancellation/disposal. The two ambient skills remain visible in addition to the selected folder.

## Live model turn

**Live inference passed with the existing `openai-codex / gpt-5.6-sol` configuration.** The earlier preflight explicitly used `refreshOnCreate: false`, then inspected the uninitialized auth snapshot. That produced `hasConfiguredAuth: false` and `source: null` even though the selected provider's credential is stored. After `runtime.refresh({ allowNetwork: false })`, the same runtime reports configured auth with source `stored`. This was a false negative in the preflight, not a provider rejection, quota error, or missing-credential finding.

The check used the repository-installed 0.85.1 `ModelRuntime` and `SettingsManager`. It read the existing Pi auth, model, and default-selection files and redirected model-store state to a temporary directory. The following reproduces both snapshots without printing credentials/environment values or writing Pi settings or sessions:

```sh
node --input-type=module <<'NODE'
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const sdk = await import('./apps/server/node_modules/@earendil-works/pi-coding-agent/dist/index.js');
const agentDir = sdk.getAgentDir();
const scratch = await mkdtemp(join(tmpdir(), 'synara-pi-p0-authcheck-'));
try {
  const settings = sdk.SettingsManager.create(scratch, agentDir);
  const provider = settings.getDefaultProvider();
  const model = settings.getDefaultModel();
  const runtime = await sdk.ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
    modelsStorePath: join(scratch, 'models-store.json'),
    refreshOnCreate: false,
  });
  const authBeforeLocalRefresh = Boolean(provider && runtime.hasConfiguredAuth(provider));
  await runtime.refresh({ allowNetwork: false });
  console.log(JSON.stringify({
    sdkVersion: sdk.VERSION,
    defaultProviderConfigured: Boolean(provider),
    defaultModelConfigured: Boolean(model),
    defaultModelAvailableInSdk: Boolean(provider && model && runtime.getModel(provider, model)),
    authBeforeLocalRefresh,
    authAfterLocalRefresh: Boolean(provider && runtime.hasConfiguredAuth(provider)),
    authSourceAfterLocalRefresh: provider ? runtime.getProviderAuthStatus(provider).source ?? null : null,
    provider: provider ?? null,
    model: model ?? null,
  }));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
NODE
```

Result:

```json
{
  "sdkVersion": "0.85.1",
  "defaultProviderConfigured": true,
  "defaultModelConfigured": true,
  "defaultModelAvailableInSdk": true,
  "authBeforeLocalRefresh": false,
  "authAfterLocalRefresh": true,
  "authSourceAfterLocalRefresh": "stored",
  "provider": "openai-codex",
  "model": "gpt-5.6-sol"
}
```

Synara's `PiAdapter` creates its runtime with the selected `agentDir/auth.json` and `agentDir/models.json` and does not set `refreshOnCreate: false`; its SDK session-service setup performs the local refresh. The corrected preflight therefore agrees with the adapter's auth lifecycle.

The live probe reads only that provider's stored credential into an in-memory credential store, keeps model-store and session state temporary, and deletes them afterward. It creates a session with an appended Persona, a Skill directory, and a custom tool, then asks the current model to use them. It prints booleans rather than model text or credentials:

```sh
node scripts/expert-p0/pi-live-probe.mjs
```

```json
{
  "model": "openai-codex/gpt-5.6-sol",
  "persona": true,
  "skill": true,
  "toolCalled": true,
  "toolResult": true
}
```

This proves one live turn honored all three resources in the pinned Pi SDK 0.85.1. The additional [lifecycle evidence](pi-lifecycle-evidence.md) covers a persisted-session reconstruction, a second live turn with the same resources, and active custom-tool cancellation. Synara's full adapter orchestration path and exactly-once effects for real external tools remain unverified.
