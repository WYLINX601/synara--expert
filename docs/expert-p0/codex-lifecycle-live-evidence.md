# Codex live lifecycle evidence

Date: 2026-09-25. Probe: [`scripts/expert-p0/codex-lifecycle-live-probe.mjs`](../../scripts/expert-p0/codex-lifecycle-live-probe.mjs).

## Environment and isolation

- Codex CLI `0.156.1`; Node.js `v22.23.1`.
- The probe read only `model`, `model_reasoning_effort`, and `model_provider` from the current Codex config. They were `gpt-6-sol`, `medium`, and unset. It wrote only the model and effort fields to a temporary `CODEX_HOME` config; it did not change the user config or account settings.
- The existing `auth.json` was copied into that temporary home with mode `0600`. The temporary root was mode `0700`; the home and work directories were private. The script removed the temporary tree before exit and did not print credentials or model response text.
- An earlier exploratory attempt used `gpt-6-luna/max`, because those values were hard-coded in the first script version. That result is excluded from current-config validation. The final bounded run used the current configured `gpt-6-sol/medium` selection.

## Results

The bootstrap turn completed. The probe then stopped and restarted the app-server, resumed the same thread ID, re-sent the session Persona, and re-registered the temporary Skill root. A real resumed model turn returned both expected markers: `PERSONA_RESUME_LIVE` and `SKILL_RESUME_LIVE`. The script checked these markers in memory only.

The long-running command cancellation attempt did **not** reach an active command. `turn/start` returned status `inProgress`; the cached notifications contained item categories `reasoning`, `agentMessage`, and `other`, with no `commandExecution` item and no recognized item status. There were zero command approval requests, no hold-script PID marker was observed, and the turn reached `turn/completed` before any active PID was observed. The probe therefore did not send `turn/interrupt` for that turn. The observations indicate that the model did not start the requested shell command in this run, rather than an approval denial or a command that failed to write its PID marker.

The exact app-server child PIDs observed by the probe were `64922` and `64951`; both exited with code `0`. No hold-process PID was observed. The temporary directory was removed. The live probe exited `1` as designed because its active-command assertion failed; this is a recorded validation failure, not a successful cancellation result.

A smaller follow-up probe tested **active turn cancellation** without requiring a shell command. It used the same current `gpt-6-sol/medium` configuration in a private temporary home. Sending `turn/interrupt` immediately after the `turn/start` response twice returned “no active turn to interrupt”: the response's `inProgress` value arrived before any `turn/started` notification. After waiting for the matching `turn/started` notification, a single run received an acknowledged `turn/interrupt` response and `turn/completed` with status `interrupted`. The app-server exited and the temporary home was removed. This establishes live cancellation of an active Codex turn; it does **not** establish cleanup of an in-flight shell command or downstream MCP call. The bounded follow-up script is [`codex-interrupt-live-probe.mjs`](../../scripts/expert-p0/codex-interrupt-live-probe.mjs).

## Reproduction

```sh
node --check scripts/expert-p0/codex-lifecycle-live-probe.mjs
node scripts/expert-p0/codex-lifecycle-live-probe.mjs
node scripts/expert-p0/codex-interrupt-live-probe.mjs
```

The lifecycle script's syntax check passed. Its live run used a 60-second PID-activation window and did not retry after the missing command. The follow-up interrupt script exited `0` on the successful active-notification run. Re-running requires the existing Codex login; no repository dependencies were installed.
