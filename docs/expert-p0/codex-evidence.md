# Codex Expert P0 evidence

Environment: macOS, Node 22.23.1, Codex CLI 0.156.1. Probe: [`scripts/expert-p0/codex-probe.mjs`](../../scripts/expert-p0/codex-probe.mjs). Run with `node scripts/expert-p0/codex-probe.mjs --live`.

The probe creates two temporary `CODEX_HOME` directories and workspaces, copies only the local Codex login file into each temporary home, and removes both on exit. It starts two app-server processes, registers a distinct skill root in each, checks `skills/list`, and starts threads with distinct `developerInstructions`. Both threads completed a real model turn. Each final answer contained its own persona marker and skill marker. One turn also used a per-turn `collaborationMode` carrying `developer_instructions`; its persona marker remained present. No shared Synara configuration or production code was changed.

This proves the required entry points work in the installed Codex version and the two tested sessions do not overwrite each other's Expert resources. It does **not** prove strict exclusion of ambient/global skills, all instruction conflicts, thread resume, cancellation, or production Synara wiring. `collaborationMode` takes precedence over developer instructions according to the generated protocol schema; Expert integration should explicitly compose persona with Synara's per-turn mode instructions and test the final behavior.
