# WB-05 weekly upstream sync automation

## Workflow contract

- `.github/workflows/workbench-weekly-sync.yml` runs Saturday at 02:30 UTC (10:30 Shanghai time) and supports `workflow_dispatch`. A fixed concurrency group prevents overlapping sync runs without cancelling the active run.
- All three jobs require the event ref to equal the full default-branch ref. `prepare` checks out the exact event SHA, installs only the existing `static` workspace scope, runs the Git fixture, and uses `contents:read` with no persisted checkout credentials. It compares that fixed SHA with current remote main and reports stale if main advanced; it never silently switches the source snapshot. It selects at most one active `codex/sync-<tag>-<target-short-sha>` branch. `workbench/sync-candidate.json` stores only the fixed base, official target, and branch. The candidate SHA is resolved from its commit, avoiding self-referential metadata.
- `verify` imports the uploaded Git bundle into a fresh checkout, creates the expected local candidate branch, binds that exact SHA with `workbench:sync bind`, then runs `workbench:sync verify` using the candidate's lockfile and the existing workspace setup action. It has `contents:read` only and no provider, release, or publish credentials. Successful automated checks report `awaiting-runtime`; they do not claim `ready` without separate runtime evidence.
- `publish` checks out the trusted default-branch publisher and imports candidate Git objects without checking out or executing candidate code. Its one write-token step compares the default branch and expected old candidate SHA, then uses a fast-forward-only update with an exact `--force-with-lease` expectation. A moved branch, advanced main, non-fast-forward, or permission failure leaves the remote ref untouched and emits a structured report. A failing automated gate may still preserve the bound candidate branch, labeled `candidate-published-checks-failed`.
- The repository's current Actions setting disables GitHub Actions PR creation. The workflow does not attempt PR creation: it preserves the candidate branch and run artifacts/summary instead. It does not merge to main, publish a release, install an app, or change repository settings.

## Recovery and limits

- New-candidate merge conflicts report the filenames and recovery commands that fetch and merge the exact official target SHA. Conflicts while resuming an existing candidate report commands that merge the fixed current-main SHA. Both paths state that manual resolution and a commit are still required; neither publishes an unresolved candidate.
- Cross-run recovery data is in the remote candidate branch and its metadata; run artifacts retain the exact candidate bundle and structured reports for 90 days. The workflow blocks multiple active candidates and malformed active sync branches rather than guessing.
- `workflow_dispatch.candidate_ref` accepts only a full `refs/heads/codex/sync-*` ref and stays read-only. It is passed through an environment variable and validated before Git argument construction.
- The trusted-main helper and the candidate verifier are separate copies. Candidate code and dependency installation run only in the read-only verification job. The publish token is exposed only to the trusted-main publisher step; Git receives it through an ephemeral extra-header environment entry, never a remote URL or report.

## Local evidence

- `mise exec -- bun install --frozen-lockfile` completed in the isolated integration checkout; no lockfile change was made.
- `mise exec -- bun run .github/scripts/workbench-weekly.test.mjs` passed a temporary real-Git fixture covering a complete-history official-tag fetch, bot identity in a new worktree without global Git identity, cross-job bundle import, expected-branch checkout, the real sync `bind` API, candidate branch creation/fast-forward, and refusal to overwrite a moved human-updated branch.
- No GitHub Actions run, manual dispatch, timed run, candidate branch push, PR attempt, or enabled workflow has been performed. GitHub token write permission and artifact retention are still confirmed only by a read-only settings snapshot, not by a live publisher run.
