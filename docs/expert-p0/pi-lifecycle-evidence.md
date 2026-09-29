# Pi P0 live lifecycle evidence

## Result

The bounded run used the repository's locked and installed `@earendil-works/pi-coding-agent` **0.85.1**, with the existing Pi default **`openai-codex/gpt-5.6-sol`**. The global `pi` CLI 0.87.1 was not used. The check read only the selected provider credential, seeded it into `AuthStorage.inMemory`, and kept model-store and session files under a fresh temporary directory. No user Pi settings, auth file, or real session was written.

Both model turns were live inference requests. The first turn returned the persona, selected-skill, and custom-tool markers; the session was persisted in the temporary session directory. The probe then created a new `ModelRuntime` and session services, reopened that persisted session, and made a second live turn with the same persona, skill folder, and tool. All three markers were observed again. Before each model turn, the probe also asserted that the resource loader had the selected skill, its appended system prompt contained the persona marker, and the created session had the custom tool active.

The cancellation turn invoked the custom tool once. The tool waited on the SDK-provided `AbortSignal`; `session.abort()` triggered it, the tool settled without timing out, the prompt promise completed, and the session reported idle. The last assistant message did not have `stopReason === "aborted"`, so this run does not establish that exact assistant stop-reason label. The custom tool was a local marker/wait function with no external side effect: the result establishes one tool execution in the canceled turn, not exactly-once behavior for a real external service.

## Reproduction

Syntax check:

```sh
node --check scripts/expert-p0/pi-lifecycle-live-probe.mjs
```

One bounded live run (proxy variables were unset for this child command because the inherited local proxy was unavailable):

```sh
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy node scripts/expert-p0/pi-lifecycle-live-probe.mjs
```

The corrected run produced the following sanitized result summary:

```json
{
  "sdkVersion": "0.85.1",
  "provider": "openai-codex",
  "model": "gpt-5.6-sol",
  "authConfiguredAfterLocalRefresh": true,
  "authSourceAfterLocalRefresh": "stored",
  "inferenceModelAvailable": true,
  "firstResourcePreflight": { "skillLoaded": true, "personaLoaded": true },
  "firstTurn": {
    "completed": true,
    "errorCategory": null,
    "markers": { "persona": true, "skill": true, "tool": true }
  },
  "sessionPersisted": true,
  "sessionReconstructed": true,
  "resumedResourcePreflight": { "skillLoaded": true, "personaLoaded": true },
  "resumedTurn": {
    "completed": true,
    "errorCategory": null,
    "markers": { "persona": true, "skill": true, "tool": true }
  },
  "cancellation": {
    "toolStarted": true,
    "promptCompleted": true,
    "errorCategory": null,
    "abortWait": "idle",
    "sessionIdle": true,
    "assistantTerminalAborted": false,
    "toolExecutions": 1,
    "toolReceivedAbortSignal": true,
    "waitingToolStoppedBySignal": true,
    "waitingToolSettled": true,
    "waitingToolTimedOut": false
  },
  "toolExecutions": { "first": 1, "resumed": 1, "cancelled": 1 }
}
```

The first harness attempt did not reach inference: it referenced an undefined local `defaultProvider` while preparing the in-memory settings manager. The probe was corrected to use the verified configured `provider` and rerun once; the JSON above is that corrected run. No alternative model was attempted.

After that run, the probe's exit status was tightened to fail unless both turns' markers pass, the session persists and reconstructs, all three tool execution counts equal one, and cancellation delivers/settles the signal and reaches idle without timeout. The updated script passed `node --check`; no further model calls were made.

## Limits

This checks Pi SDK 0.85.1 only. It does not establish compatibility with the global 0.87.1 CLI, Synara's production orchestration/cancellation event path, or exactly-once effects for tools that call external systems. The cancellation test confirms the custom executor received and honored the abort signal and that the SDK prompt/session reached a completed/idle state; it did not confirm the assistant message's specific `aborted` stop reason.
