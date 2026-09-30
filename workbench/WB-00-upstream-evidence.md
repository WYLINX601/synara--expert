# WB-00 upstream evidence supplement

Snapshot: 2026-09-30, isolated identity worktree. This supplements the implementation plan; it does not replace the WB-00 baseline or change the official candidate lock.

## History and migration gate

- Fetch completed without changing the workbench candidate lock: `git -c http.version=HTTP/1.1 -c http.maxRequests=2 -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=45 fetch --unshallow --no-tags upstream '+refs/heads/*:refs/workbench/wb00-upstream/heads/*' '+refs/tags/*:refs/workbench/wb00-upstream/tags/*'`.
- Repository is no longer shallow. The fetched upstream main snapshot is `529ad049cb106c998010f5400189515008997aa4` (2026-09-29; 3,793 commits). Its merge base with this worktree and with `v0.9.2` is `eaa61eded31b6755d4f30ba8eabc5d905cf817cb` (`v0.9.1`). `v0.9.1..v0.9.2` contains 22 commits.
- All 422 advertised upstream heads and 92 `v*` tags are retained under `refs/workbench/wb00-upstream/`. The normal `refs/tags/v*` namespace now contains the same 92 tags (`v0.0.16` through `v0.9.3-beta.1`) so the repository's default `migrations:check` sees release history. Existing refs were snapshotted and verified unchanged after fetch/tag completion; the old `refs/remotes/upstream/main` was restored by compare-and-swap to `ec3b1f6ef9c2f656f26dd9711339fe1265d8cb5c`. The newer observed main remains separately available above; no refs were pruned or pushed.
- `mise exec -- bun run migrations:check` passed: all migrations shipped across 92 release tags keep their released `(id, name)`.

## Candidate lock

Read-only baseline at `8e5c12b963e3dd143837aa751e1749b5b55f5d73:workbench/upstream.lock.json` remains authoritative: integrated base `v0.9.1` / `eaa61eded31b6755d4f30ba8eabc5d905cf817cb`; candidate `v0.9.2` / `a33435c18474eb7816582004e45f87382965ac8d`, status `not-yet-integrated`; recorded `observedUpstreamMain` remains `ec3b1f6ef9c2f656f26dd9711339fe1265d8cb5c`. Latest fetched upstream main is evidence only and did not alter that lock.
