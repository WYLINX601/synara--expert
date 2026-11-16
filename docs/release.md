# Linx controlled release

The default release lane is **Linx, macOS Apple Silicon only**. Product version comes from `workbench/build-config.json` (`versions.workbench`), not the upstream workspace package versions. Internal `workbench` flavor keys remain intentional. Stable/Beta qualification utilities remain shared; this workflow does not publish their products.

## Authorization and current prerequisites

On 2026-11-16 the owner authorized production provisioning, main-only commits/pushes, formal releases and isolated upgrade qualification. Both protected Environments now exist with `WYLINX601` as required reviewer, explicit self-review permission and disabled administrator bypass; deployment policies permit only `v*.*.*` tags. Main history and release-tag rulesets are active. The production public key `1113c8bdec541a20` is committed in `workbench/linx-update-source.json`; its private key was provisioned directly to the signing Environment without writing it to the repository. The real protection command passes. The owner selected short-lived workflow tokens rather than an additional PAT; exact workflow-token capability and bootstrap-SHA approval still require release-run evidence. No published Linx candidate or real B0→B1 success is asserted. Daily application/personal-data migration requires separate confirmation after isolated qualification.

Before the authorized first release, maintainers must complete and verify this checklist:

1. Commit `workbench/linx-update-source.json` with exactly `{ "repository": "WYLINX601/synara--expert", "keyRing": { "<keyId>": "<base64 Ed25519 SPKI DER>" } }`. These are real approved public keys, not example material. The builder rejects missing/empty/invalid keys and other repositories. Never commit a private key.
2. Configure **both** `linx-signing` and `linx-publish` Environments with the repository maintainer as a real required reviewer, explicitly allow self-review (`prevent_self_review: false`), and disable administrator bypass (`can_admins_bypass: false`). Restrict deployment branches/tags to the approved release tags and protect main/tag creation. Environment names alone do not confer protection. The workflow reads actual protection rules before entering the signing job and rechecks them before staging and promotion; missing or different rules/API access fail closed. It does not create environments.
3. Use the job's automatically issued `GITHUB_TOKEN` for protection inspection, with `actions: read`. Preflight has only `contents: read` plus `actions: read`; signing and promotion additionally have the `contents: write` permission already needed for their Release operations. This is job-level, not step-level, permission isolation: their inspection steps share those jobs' write capability. The owner explicitly accepted this tradeoff instead of maintaining a separate long-lived PAT. Missing authentication, inaccessible APIs or inadequate protection still fail closed. Do not copy a personal administrator credential into CI.
4. Store `LINX_UPDATE_PRIVATE_KEY` **only as a `linx-signing` Environment secret**, never as a repository/organization secret available to other jobs. Only the signing step references it. Do not print it or pass it to app/helper builds. Key generation remains an explicitly authorized publisher operation, not a build side effect.
5. For the first release only, independently approve the bootstrap trust root and set the protected Environment variable `LINX_BOOTSTRAP_SOURCE_COMMIT` to its exact main SHA. This is an explicit audited bootstrap decision, not an automatic first-key fallback. Later releases use authenticated prior release lineage regardless of that variable.
6. Finish the applicable isolated runtime/migration qualification and real-platform gates in [the authoritative plan](linx-update-development-plan.md). Startup smoke does not substitute for the real signed-source B0→B1 update and system-protection tests.

GitHub protection capabilities and credentials must be confirmed on the actual repository under separate authorization. The source cannot prove that an administrator will never later weaken repository policy.

The owner explicitly selected a single-maintainer approval model on 2026-11-16: `WYLINX601` may initiate and personally approve the same release. This removes independent-person separation, not approval itself. Signing and publication still require their separate protected-Environment approvals; publication approval binds the exact candidate digest. Administrator bypass remains disabled. General permission to prepare or publish releases is not permission for an agent to approve a future, unidentified candidate.

## Fixed-source sequence

1. Finalize the Linx product version, release notes, public source config, and `bun.lock` on main. Commit and review all release bytes before creating an immutable `vX.Y.Z` tag pointing to that exact main commit. Never move a release tag.
2. Ordinary pushes/PRs retain shared CI; only pushed formal tags enter publication. Manual `Release` dispatch is build-only, with an exact configured version; it cannot publish. Both release entry points inspect the actual Environment protections with the preflight job's read-only token, so a manual build can establish CI API capability and supply real isolated feasibility artifacts without exposing the signing key. Neither path bumps versions, publishes npm packages, advances an official bridge, cuts Beta tags, or merges upstream.
3. Preflight checks the exact workflow SHA, a clean committed source tree, main ancestry, matching product version/tag, and lock SHA-256. Every build/preparation/quality/sign/promotion checkout uses that fixed SHA, not a moving branch.
4. Shared lint/typecheck/all-package tests and server shards run alongside portable JavaScript, pinned Cua and macOS icon preparation. Packaging consumes verified portable outputs and frozen dependencies. The platform lane is fixed to macOS arm64.
5. `scripts/build-desktop-artifact.ts --flavor workbench --platform mac --arch arm64 --target dmg` stages Linx with the authoritative version. It builds the independent Bun helper, embeds the same public source in helper and app resources, uses ad-hoc signing, and produces a DMG plus finalized ZIP. No Developer ID, paid Apple membership, notarization secret, quarantine removal, or Gatekeeper override is required or performed.
6. Qualification extracts the ZIP and mounts the DMG read-only. It checks `com.wylinx.linx`, both bundle versions, native arm64 slices, embedded public source, helper signature, deep/strict app signatures, and DMG checksum. Isolated packaged-startup smoke follows. These are **structural checks, not Gatekeeper acceptance or Apple publisher identity**.
7. After quality and qualification succeed, the reviewer-protected `linx-signing` job computes the ZIP manifest and detached Ed25519 signature. The protected key is only present in that step. The manifest binds Linx identity, stable darwin/arm64, product version, source SHA, ZIP URL/size/hash and signing key ID.
8. The job creates a draft with a complete inventory. `linx-candidate.json` records source SHA, exact tag/version, lock hash, CI run ID and every asset size/hash. Its canonical SHA-256 is printed in the run summary and passed directly to the promotion job. It uploads the descriptor last and downloads/hashes every staged byte before reporting a candidate.
9. A separate `linx-publish` Environment approval is for **that exact candidate digest**, not “latest”. Review the draft, source, qualification evidence, hashes, known issues and recovery text from the run summary. Approval does not rebuild or resign anything.
10. Promotion restores that same draft, verifies local source/run/lock bindings, the approved digest, the complete remote inventory and all remote bytes, then only changes `draft=false`. It cannot overwrite assets or change the tag/source. Post-publication validation fetches the public Release and every public asset **without credentials**, streams all bytes through SHA-256, and checks the same candidate digest. A post-publication failure is a real failure requiring operator response, not evidence of a successful public release.

Required assets are exactly:

- `Linx-X.Y.Z-arm64.dmg`
- `Linx-X.Y.Z-arm64.zip`
- `artifact-mac-arm64.provenance.json`
- `linx-update.json`
- `linx-update.json.sig`
- `linx-update-source.json` (public audit copy; clients do not adopt network keys)
- `linx-candidate.json`

No `latest*.yml`, official channel aliases, or blockmaps are part of this candidate. The client checks only the signed Linx manifest and downloads a ZIP only after user action. Ordinary quit never installs; source or signature failure never falls back to an official feed.

## Immutable retry and incident handling

Use **rerun failed jobs in the same workflow run**, preserving successful build/sign outputs. A platform failure after verified provenance preserves a same-run checkpoint; restoration revalidates source/tag/lock/version/identity and every byte before qualification. It never treats a cross-run artifact as authorization.

An existing complete draft is reused only when its source, lock, version and run ID match and every remote hash still matches. It is never rebuilt, resigned, or overwritten. A different candidate or another run is rejected. A partial draft lacking its last-uploaded descriptor is deliberately blocked: inspect the failure and, under separate explicit authority, retire that incomplete draft before retrying the unchanged source. Do not repair a partial draft by mixing assets from another build. A moved/deleted tag, changed asset or digest conflict is not a retryable success.

Stage, restore, promotion and anonymous validation resolve the actual remote Git ref, including bounded annotated-tag peeling. They repeat the source check around remote-byte verification and publication; `target_commitish` alone is not proof. GitHub does not provide an atomic tag-lock/publish transaction, so a detected post-publication tag change is an incident, not a silently repaired success.

If promotion already succeeded but its response was lost, rerunning promotion only accepts the unchanged published candidate; it still hashes all bytes and performs anonymous validation. An already published version is immutable. Fixes use a strictly higher product version and new approval. Do not replace signed assets in place.

For a severe release, stop distribution under explicit incident authority and issue a higher-version repair. Removing a Release cannot revoke bytes already downloaded. The installer revalidates its exact public target online before handoff; offline, withdrawn or changed targets are not installed. A withdrawal race between final validation and replacement is unavoidable. Preserve recovery evidence and explain it rather than promising instantaneous recall.

## Public-key lineage

For every non-bootstrap release, the signer discovers the highest published stable Linx release, binds its manifest version to the exact historical Git tag/commit, requires that commit to be an ancestor of the current fixed source, loads that commit's approved public source config, and verifies the prior manifest's raw-byte signature against that config. The current signing key must be present with identical DER bytes in both that authenticated prior config and the current config.

To rotate normally, release the expanded public ring **using the old key**; only a subsequent release may activate the new key. Downloading a key list, putting a new key only into the current source, or changing a key ID's DER bytes cannot authorize rotation. Loss/compromise of the old private key is a stop-and-manual-trusted-bootstrap incident, never permission to accept new network trust roots.

## Helper integration and safe recovery

`scripts/build-linx-update-helper.ts` exports:

```ts
buildLinxUpdateHelper({ repositoryRoot, outputPath, source: { repository, keyRing } });
// Promise<{ filePath: string; size: number; sha256: string }>
```

It compiles `apps/desktop/src/linxUpdateHelper.ts` as `bun-darwin-arm64`, defines `__LINX_UPDATE_SOURCE_JSON__` as a **string containing JSON**, ad-hoc signs and structurally verifies the executable, and returns its streamed digest. It never receives a private key. A formal build cannot compile a missing helper entry or substitute a no-op.

The staged helper/source paths are `apps/desktop/prod-resources/linx-update-helper` and `apps/desktop/prod-resources/linx-update-source.json`; electron-builder places them at `Contents/Resources/linx-update-helper` and `Contents/Resources/linx-update-source.json`. Runtime resolves both from `process.resourcesPath`. The main-process installer must copy/verify the trusted helper into its private attempt directory before moving the app, bind the immutable attempt and source, and never invoke a downloaded arbitrary script.

The final signed helper SHA-256 is embedded in the running main bundle. Packaging builds/signs the helper before compiling that isolated main bundle, including a `--skip-build` packaging run, preserves only this helper from later re-signing, and compares the final packaged resource bytes. The controller requires the embedded digest before copying and again before spawning; a newly self-consistent on-disk ad-hoc seal cannot establish its own trusted helper identity.

Candidate content expectations come from authenticated ZIP streams on a pinned file handle, including file digests, entry types, modes, link text and implicit directories—not from a writable extracted candidate. Startup derives the same expectation independently from the authenticated package. Native macOS ZIP filenames are strict UTF-8 even when `ditto` omits the language flag; contradictory names, traversal and collisions remain rejected.

Installation-target exclusion uses a permanent private directory and a never-unlinked kernel-lock guard. An atomically published owner binds an interrupted attempt; successful release removes the owner while holding the guard. A remaining guard-only directory is normal and must not be deleted as a stale lock. Preparation refusal keeps the authenticated cancel/ack path available; disconnect also releases uncommitted ownership.

Recovery must keep a verified old application and data recovery set until the new version reports application/backend/data health. A package download, process exit, helper exit or unchanged version is not success. After new code may have written data, never automatically relaunch old code against it. On permissions, space, recovery verification, active tasks/approvals, unsaved edits or unknown state, retain the verified download and refuse safely; the user must explicitly try again. For system refusal, preserve logs and provide ordinary manual recovery instructions. Never clear quarantine, disable system protections, silently elevate, or force-stop user work to make a release look successful.

The installer refreshes the **same pinned release receipt twice**: before helper creation (downloads and explicit retries can outlive its short validity) and after verified recovery, before committed handoff. A fresh receipt never authorizes switching to a newer target. Server maintenance is reversible until commit; after a possibly accepted commit, recovery proves clean backend exit and starts a fresh idle backend rather than reusing a quiesced engine. Failure to return ownership keeps the recovery latch held.

Private helper responses contain only a bounded failure code (`space`, `permissions`, `macos`, `failed`), not raw filesystem/schema errors or authorization bytes. The existing update UI reports online, preparation, backup and final-verification phases separately. Keep partial unpublished recovery copies if they could contain unique data; only a verified recovery manifest authorizes restoration.

Run builds under the repository's mise-pinned Node/Bun versions. The 2026-11-16 real helper qualification used Bun 1.4.4 and verified native minimum macOS 13.0; an accidentally used ambient Bun 1.4.0 produced a different minimum and is explicitly invalid evidence. Do not raise deployment requirements to the build host's OS or weaken minimum-version checks to accept an incorrectly built helper.

Local native receipts prove their recorded source snapshots only. Earlier commit scenarios observed recovery ownership transfer, cancellation, interrupted-attempt recovery and a real replacement/LaunchServices attempt that timed out waiting for health; no successful new-process health was observed. Later candidate-authentication and target-lock repairs are not retroactively qualified by those receipts. Current focused native/browser/Bun checks and each source boundary are recorded in [the update plan](linx-update-development-plan.md). None proves a published Linx candidate, Gatekeeper acceptance or B0→B1.

## Home migration and continuation proof

First-launch migration reads saved source settings and referenced secrets without starting or mutating the old application's services. It proves each old live binding against those original launch values, then proves the copied launch changes only verified owned directory locations. Canonical and alias spellings may match only the same relocated native directory; changing another account path or credential still fails. Cursors, generations, model selection, fixed Expert evidence and historical events are not reset to force compatibility.

Copied Codex state retains native contained aliases and private account files, rebinds the source-home marker, and relocates an owned root `sqlite_home` in `config.toml` without rewriting unrelated TOML or external source state. The current Electron/SQLite receipt covers two persisted bindings across directory close/reopen and an idempotent second pass; it uses isolated fixture data and an empty browser-storage adapter, not personal data, a real Provider run or a complete application upgrade.

Before relocating live project paths, the unpublished imported engine replays its durable journal and settles orphaned turns, checkpoints and approvals under the source/database locks. Explicit quit intent wins over newly captured crash intent. Providers, subscriptions, cleanup workers and other producers remain stopped until migration completes; a replay failure keeps the receipt pending.

Strict image replay may re-reserve only the same never-claimed attachment identity after an interrupted upload, expired staging or a recorded staging failure. It rechecks ownership, metadata and quotas and atomically replaces the eligible reservation with its copied cleanup job removed. Only that identity's private partial is discarded; the final blob stays until atomic replacement. Claimed/user-deleted assets and ordinary uploads keep their existing rules. The exclusive, quiescent migration boundary is required for this internal capability.

## Source retirement versus remote receipts

The default official bridge/npm/auto-Beta publishing jobs and scheduled upstream-sync workflow plus its uncalled publisher have been removed from source. Source history, licenses, historical releases and shared platform/migration/quality utilities are preserved. This is **not** a receipt that remote workflows, old npm trusted publishers, repository variables, schedules on another branch, or already queued runs were disabled. Obtain separate authority, inspect them, and record actual remote results before closing the retirement acceptance criterion.

## Verification handoff

After integration, run the authored behavioral release policy, source/lineage, candidate protection, Linx checkpoint, provenance, artifact identity and brand tests; then the workspace's formatting/lint/typecheck/test and brand/boundary/platform checks. Actual helper compilation, DMG/ZIP structural checks, protected CI staging/approval, anonymous GitHub downloads, proxy paths, and real isolated B0→B1/system-protection behavior each need their own observed evidence. None are asserted merely by this source implementation.
