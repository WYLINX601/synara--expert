# WB-04 acceptance evidence for source 9591

Date: 2026-10-01. This record binds the listed runs to tested source SHA `9591dcda2607b4d81574ac5c25bc6e8d30c7ca80`. The documentation branch `codex/workbench-9591-progress` was created from that source; documentation-only commits do not change the tested source or inherit new runtime evidence.

The candidate integrates official `v0.9.2` at `a33435c18474eb7816582004e45f87382965ac8d` into base `b608f0c17fcbc69ee7735cb6bd3d82d9e4d6801b`, with merge commit `1309416dc3aefdc62e6edec1b2a4ed6d46f4e89c`. The current `upstream.lock` `integratedBase` remains `v0.9.1`; no acceptance evidence here advances it.

## Fixed automatic checks

The six fixed checks passed serially on source 9591:

| Check                   | Result |
| ----------------------- | ------ |
| `fmt:check`             | passed |
| `lint`                  | passed |
| `typecheck`             | passed |
| `bun run test`          | passed |
| `migrations:check`      | passed |
| `windows-runtime:check` | passed |

Verification run ID: `dcee7659-f402-4790-a483-c0645a4e8129`. Its private local log index is identified by SHA-256 `547fd67c159387f819ea36d0c827c75a6b69d85e12cb726d93470c6cd630a4cd`. Detailed gate output remains in the local private Git common-dir archive; it is not uploaded as a workflow artifact. The sync state after these checks is `awaiting-runtime`, not `ready`.

## Diagnostic builds and payload identity

Workbench `0.1.0` and Preview `0.1.0-preview.1` were built for macOS arm64 as unsigned diagnostic packages. Both packaged startup smokes and actual bundle/Info.plist identity checks passed. No package was installed, signed, submitted to Gatekeeper, or published.

Both builds used an external copy of the installed app's `Assets.car`, revalidated at SHA-256 `9c38b62b4eccf2e6d3d5e129793da3630c5957657270f938391899c8ade24a60`. This is an explicitly recorded installed-catalog input, not a source-tree artifact. The packages therefore do not establish a fully source-reproducible release build; the manifest's diagnostic status remains unchanged.

The read-only package/workspace payload comparison found zero byte differences for each flavor: 2,642 server distribution files and 2,619 web distribution files. The restore CLI's raw file SHA-256 was `e89de92fe75f1e348b968a3f4d7ef655283b79a9070682c4ee725f78174823b4`. The private artifact archive is identified as `9591dcda2607-20261001`, with index SHA-256 `3dd21c988ac9ad9d0a9905f69b021854b022238bc37d8dda3f95b89d90d334ce`; the source-bound authority report SHA-256 is `9958e1852219af445d2a2089604c2f07a49f3247a33d907d11d92809d221e535`. Original build manifests retain their accurate `automaticChecks: not-run` and `runtimeEvidence: not-run` fields: the six automatic checks are recorded by the separate verification report, not retroactively inserted into the build manifests.

## Identity and coexistence

The separate identity run verified both Workbench packages while the installed original app remained present. All three apps used separate profiles/data homes; listener checks and cleanup passed. With the updater-disable environment variable unset, both packaged Workbench apps reported updater disabled. This is the updater-policy evidence; the startup smoke itself deliberately disables auto-update and is not used to prove that behavior.

The private identity evidence archive is `9591dcda2607-20261001`. Its two-package report SHA-256 is `d6335ab60593f41f92f2d566657db7c4796e8355bc1039dcdb438104db88243d`, three-app report SHA-256 is `c4947424c51130d4560fe8638864a139c431856bf898c4a26427a87f0ee176e8`, and index SHA-256 is `076eb1a530af3ec977788aaf081585b5fe2fe6fb2edb621bb287ac1e033571a1`.

## Synthetic migration and restore rehearsal

All three synthetic scenarios passed without accessing a user database:

1. Successful startup migration passed with the pinned Bun harness.
2. Injected failure and retry using the same persisted backup passed with the pinned Bun harness.
3. The built restore CLI passed in the packaged Workbench Electron 43.4.1 executable with `ELECTRON_RUN_AS_NODE=1` and exit code 0.

The third scenario runs the CLI in Node mode; it does not prove a normal Electron startup/upgrade migration. The migration archive index SHA-256 is `389becf746566efaf1f22ffe7d00a1bad42c3b1a18ec03b43e6c30e3ddf25176`; the redacted rehearsal report SHA-256 is `45c986e3af8bef1b7628f8705239e0f7cae6ea6a3ee589b2fe78f85c027cfef7`; and the redacted post-run audit SHA-256 is `7557ced0571e4590b906d79320ddbf86a46edd1bbfa78096b5f17aa5d745dfef`. The earlier fee08 rehearsal remains a distinct historical record: its third scenario used pinned Node, not packaged Electron.

## Remaining acceptance work

- The 9591 product provider probe has not run. An earlier fee08 Codex ordinary-first-turn request using `gpt-6.1-sol` returned HTTP 400 because the model is unsupported for the configured account; the other seven required runtime cases were not run. Changing model selection requires user authorization.
- Until the exact runtime evidence set passes, the candidate remains `awaiting-runtime`; M1, M2, and M3 are pending, and `integratedBase` remains `v0.9.1`.
- The WB-05 local Git fixture was run on source SHA 9591 and failed with exit 1: expected `candidate-bound`, received `bind-rejected`. The inspected synthetic fixture uses a placeholder `integratedBase` (`aaaa…`) that fails the binder's ancestry check; this is a fixture precondition, not evidence of a production bind defect. A corrected fixture has not been merged into 9591 or rerun there. The report SHA-256 is `686e3c4dbf580a793f529fac00e6582e23230ca9971278fde60b46eeaf705de3`, stderr SHA-256 is `6ce249f5a6bb830f2dd44e1d09c7bdfaee5c6e801d7a4bffb65430840eca2c9f`, and private archive index SHA-256 is `6afad44c701069680dbd2d9120f1cbdce38f9190208a4b3e03e6037559266d28`. The run exercised only a synthetic local Git repository; it did not change real refs or access GitHub, providers, or models. No remote manual dispatch, real scheduled run, candidate push, or publisher permission check was performed.
- WB-06 remains deferred by the user's decision.
