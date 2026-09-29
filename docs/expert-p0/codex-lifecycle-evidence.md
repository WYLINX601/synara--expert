# Codex Expert P0 lifecycle evidence

Environment: macOS, Node 22.23.1, Codex CLI 0.156.1. Run: `node scripts/expert-p0/codex-lifecycle-probe.mjs`.

The probe used a fresh temporary `HOME` and `CODEX_HOME`, with no copied auth file or inherited provider credential variables. `codex login status` exited nonzero in that isolated home, and no temporary `auth.json` existed. The CLI started a thread with `developerInstructions`, registered a temporary skill root, and returned that skill from `skills/list`. A skill-bearing `turn/start` returned a turn ID. After the app-server process exited and restarted against the same temporary home, `thread/resume` returned the same thread ID when the same `developerInstructions` were resent; registering the skill root again made the skill discoverable after resume.

This is protocol-level recovery evidence. It does not prove the persona remained effective without being resent, or that the resumed turn activated the skill in model output. No model request was authenticated. The post-resume `turn/start` returned an ID, but `turn/interrupt` returned JSON-RPC `-32600` (“no active turn”); with no credentials, the turn reached a terminal state before cancellation could be confirmed. Active-turn cancellation remains unverified.

Both app-server child processes exited and the temporary directory was removed. The probe exited 0: lifecycle protocol checks passed, while unauthenticated model behavior and cancellation are reported as unverified.
