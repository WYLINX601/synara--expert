# WB-00 upstream evidence supplement

Snapshot: 2026-09-30, isolated identity worktree. This supplements the implementation plan; it does not replace the WB-00 baseline or change the official candidate lock.

## History and migration gate

- Fetch completed without changing the workbench candidate lock: `git -c http.version=HTTP/1.1 -c http.maxRequests=2 -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=45 fetch --unshallow --no-tags upstream '+refs/heads/*:refs/workbench/wb00-upstream/heads/*' '+refs/tags/*:refs/workbench/wb00-upstream/tags/*'`.
- Repository is no longer shallow. The fetched upstream main snapshot is `529ad049cb106c998010f5400189515008997aa4` (2026-09-29; 3,793 commits). Merge bases: this worktree `HEAD` vs fetched upstream main = `eaa61eded31b6755d4f30ba8eabc5d905cf817cb` (`v0.9.1`); `HEAD` vs `v0.9.2` = the same `eaa61...`; fetched upstream main vs `v0.9.2` = `a33435c18474eb7816582004e45f87382965ac8d` (`v0.9.2`). `v0.9.1..v0.9.2` contains 22 commits.
- All 422 advertised upstream heads and 92 `v*` tags are retained under `refs/workbench/wb00-upstream/`. The normal `refs/tags/v*` namespace now contains the same 92 tags (`v0.0.16` through `v0.9.3-beta.1`) so the repository's default `migrations:check` sees release history. Existing refs were snapshotted and verified unchanged after fetch/tag completion; the old `refs/remotes/upstream/main` was restored by compare-and-swap to `ec3b1f6ef9c2f656f26dd9711339fe1265d8cb5c`. The newer observed main remains separately available above; no refs were pruned or pushed.
- `mise exec -- bun run migrations:check` passed: all migrations shipped across 92 release tags keep their released `(id, name)`.

## Candidate lock

Read-only baseline at `8e5c12b963e3dd143837aa751e1749b5b55f5d73:workbench/upstream.lock.json` remains authoritative: integrated base `v0.9.1` / `eaa61eded31b6755d4f30ba8eabc5d905cf817cb`; candidate `v0.9.2` / `a33435c18474eb7816582004e45f87382965ac8d`, status `not-yet-integrated`; recorded `observedUpstreamMain` remains `ec3b1f6ef9c2f656f26dd9711339fe1265d8cb5c`. Latest fetched upstream main is evidence only and did not alter that lock.

<a id="2026-10-16-baseline-audit"></a>

## 2026-10-16 baseline audit

Scope: local read-only preflight for the user-authorized v1.1 standards/SOP rollout. The preceding 2026-09-30 snapshot is historical, not the current checkout's acceptance. Commands used the repository-pinned toolchain where applicable; no fetch, bind, verify, merge, lock update, installation, or data migration was performed.

| Observation               | Result and interpretation                                                                                                                                                                                                                                                                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source                    | Local `main` HEAD `7e25e023d147ac8bac630139822e13d5c1c676a4`, with pre-existing uncommitted Expert/MCP and documentation changes; HEAD alone does not identify the full working tree                                                                                                                                                                                 |
| Official ancestry         | `git merge-base --is-ancestor` exited 0 for both locked `v0.9.1` (`eaa61eded31b6755d4f30ba8eabc5d905cf817cb`) and target `v0.9.2` (`a33435c18474eb7816582004e45f87382965ac8d`) against HEAD                                                                                                                                                                          |
| Merge history             | `1309416dc3aefdc62e6edec1b2a4ed6d46f4e89c` has target `a33435c…` as its second parent. Later merge `61df29b094d3e5f2877f7787613655220a4f72a2` has historical candidate `aeffdc63623d7cf4c535141a71889f29dcbf0d5f` as its second parent; both are ancestors of the inspected HEAD                                                                                     |
| Tracked state             | `upstream.lock.json` still records `v0.9.1` as integrated base and `v0.9.2` as `not-yet-integrated`. `sync-candidate.json` still names base `b608f0c17fcbc69ee7735cb6bd3d82d9e4d6801b` and branch `codex/sync-v0-9-2-a33435c1`                                                                                                                                       |
| Generated status          | `mise exec -- bun run workbench:sync status` exited 0 and reported persisted `ready` for candidate `aeffdc63623d7cf4c535141a71889f29dcbf0d5f`, mainRef `refs/heads/codex/workbench-foundation`, base/main SHA `b608f0c17fcbc69ee7735cb6bd3d82d9e4d6801b`, updated `2026-10-02T23:48:48.511Z`; this is not current `refs/heads/main` or dirty-working-tree acceptance |
| Existing dependency guard | `mise exec -- bun run workbench:check-boundaries` exited 0, scanning 29 source files. Coverage is the guard's configured feature/legacy surfaces; it is not an all-module or runtime security audit                                                                                                                                                                  |

Disposition: Git proves source inclusion of v0.9.2, while tracked and generated records describe different historical states. The local persisted `ready` result remains source/ref-bound; this audit did not rerun its six gates or runtime evidence. Current-main upgrade acceptance and the next candidate must not be inferred from it. Leave the existing lock and candidate metadata unchanged until their transition is reconciled with source-bound acceptance under the [sync SOP](../docs/workbench-implementation-plan.md#sync-sop); do not rewrite historical evidence to match a desired state. Independent daily development may continue. Current remote protection/weekly observations are recorded separately in [WB-05](./WB-05-automation.md#2026-10-16-remote-read-only-audit).

<a id="alignment-status-20261016"></a>

## 2026-10-16 status after architecture alignment

The implemented `workbench:sync status --main-ref refs/heads/main` now reports `baseline-review-required` for the same HEAD and retained records. Its `baseline` identifies `candidate-main-ref-mismatch` and `locked-target-in-main-without-baseline-calibration`; inclusion of both the official target and historical candidate is reported separately from acceptance. The nested historical `candidate.status` stays `ready`. The caller working tree is explicitly `dirty`.

The real CLI returned exit 0 for successful read-only inspection. SHA-256 of the tracked upstream lock, candidate metadata and Git common-dir state file matched before/after; no records were calibrated, retired or rebound. Tests also cover check/prepare/bind refusal before candidate advancement, explicit historical-ref inspection, and the new seventh architecture gate. Source/validation scope is in the [alignment acceptance](../docs/workbench-adaptation-acceptance.md#alignment-implementation-20261016).

Calibration remains a separate maintenance change: establish source-bound main acceptance, reconcile the frozen candidate's old mainRef and archive/transition its state through reviewed maintenance, then update the tracked baseline only with that evidence. Neither the new status nor a contained target authorizes marking current main as accepted; do not hand-edit the state merely to remove the warning.

<a id="maintenance-proof-20261016"></a>

## 2026-10-16 historical baseline reconciliation proposal

The follow-up maintenance inspected the original ready state at SHA-256 `3b82ea779e9e5261bf8a2681770ec297e1b3602c8c0c8e1918b43d30551cfbd6`. The six-gate index hash `71df28e224076d5dc2fd37d004321d8148c9217bcb4a820cbf7b7167c859cf40`, all 12 referenced stdout/stderr logs (hash and byte size), ten-check runtime binding hash and exact candidate/base/ref/lock/toolchain fields match. The accepted candidate's lock hashes match its committed source files. Merge `61df29b094d3e5f2877f7787613655220a4f72a2` has source `aeffdc63623d7cf4c535141a71889f29dcbf0d5f` as second parent and an identical tree, and is included in local main. This supports reconciling the historical v0.9.2 source baseline; it does not grant acceptance to current main or promote six old gates into seven.

A reviewed, fail-closed proposal is saved locally at `/private/tmp/linx-maintenance-lb7ugot1/reconcile-plan.json`. It checks expected main/state/lock hashes and the evidence above, then proposes archiving the original state and lock before recording v0.9.2 as the integrated source and removing the old-ref active binding. The automatic approval reviewer initially rejected the write because explicit authorization to rewrite persistent lock/state was unclear. The user then explicitly approved source-baseline calibration and archival. The same reviewed operation subsequently completed: v0.9.2 is now recorded as the historical integrated source, and the old-ref active state has been archived without retargeting or granting acceptance to current main. The prior rejection and pre-calibration observations remain historical evidence.

<a id="baseline-reconciled-20261016"></a>

## Approved source calibration result

The user explicitly confirmed the proposed source-baseline calibration and old-state archival. [Versioned receipt](./baseline-reconciliation.json) records exact source/merge, original lock/state hashes, historical six-gate and ten-check runtime provenance, and `currentFormalAcceptance: not-granted`. Original state and lock bytes are saved under Git common-dir `workbench-sync/baseline-reconciliations/3b82ea779e9e5261bf8a2681770ec297e1b3602c8c0c8e1918b43d30551cfbd6/`. The old ready candidate was removed from the active slot, not rebound or promoted. Tracked historical candidate metadata remains unchanged.

The actual post-operation `status --main-ref refs/heads/main` reads `no-candidate`, baseline reasons `[]`, and integrated source v0.9.2. This means there is no active bound candidate; the unresolved isolated v1.0.1 preparation still exists separately. No new source was merged, no current-main acceptance was granted, and no user database or remote ref was changed.
