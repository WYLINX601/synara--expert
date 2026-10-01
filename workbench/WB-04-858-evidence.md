# WB-04 acceptance evidence for source 858

Date: 2026-10-01. This record is bound to tested source SHA `8584249e19313471fe4e22f7ae7eca277f5ccf14` on `codex/sync-v0-9-2-a33435c1`. The documentation branch `codex/workbench-858-progress` starts at that source; documentation edits do not change the tested source or inherit new runtime evidence.

The candidate merges official `v0.9.2` at `a33435c18474eb7816582004e45f87382965ac8d` from base `b608f0c17fcbc69ee7735cb6bd3d82d9e4d6801b`, with merge commit `1309416dc3aefdc62e6edec1b2a4ed6d46f4e89c`. Source 858 is the direct child of `9591dcda2607b4d81574ac5c25bc6e8d30c7ca80` and changes only `.github/scripts/workbench-weekly.test.mjs`, correcting the synthetic weekly fixture's lineage metadata. It does not weaken production `bind` or compare-and-swap guards. The local `main` remains `8e5c12b963e3dd143837aa751e1749b5b55f5d73`; `upstream.lock` still records `integratedBase` `v0.9.1`.

The private evidence catalogue is `8584249e1931-20261001`, index SHA-256 `8eaecc1a1e75f8a3bf198eba28221237687d1274491f4fcb0a1c1b34cc7054a6`; its README SHA-256 is `9f3151b55c4d194ee64efb7fc020d13217c7ebe049a6483be8869db9dbba5ae2`. It indexes separate checks, weekly-fixture, identity, migration, and artifact evidence. These local records are not uploaded workflow artifacts or remote execution evidence.

## Fixed automatic checks

The first formal verification run on 858, ID `0bc5114a-193e-4acf-8465-7bde53672b3d`, failed only `bun run test`; the other five fixed checks passed. Four assertions in `apps/server/src/config.permissions.test.ts` expected `0644` but observed `0600`. The formal runner wrapper had started with umask `077`, which masks those file creation bits. A fresh shell had umask `022`; a separate external file fixture reproduced `0644` under `022` and `0600` under `077`. The exact affected test file then passed in a focused run under `022`, with no source changes.

The formal verification was rerun once under the normal `022` umask. All six fixed checks passed serially:

| Check                   | Result |
| ----------------------- | ------ |
| `fmt:check`             | passed |
| `lint`                  | passed |
| `typecheck`             | passed |
| `bun run test`          | passed |
| `migrations:check`      | passed |
| `windows-runtime:check` | passed |

Successful run ID: `edcce506-7226-4828-9bd9-de60f63c4d66`. The original common-dir index SHA-256 is `5379ba2f947d4a901287e794b54044fa4fe4b2d44bf16641b934b5f57d1bca8c`; the failed attempt's index SHA-256 is `59a83ccd7c9c31a3de13aa78b9b74fdf747743acfce7f5e79767b15e5131890a`. Both exact index copies, per-gate log paths/hashes and the umask diagnosis are retained in private archive `8584249e1931-20261001`; its checks index SHA-256 is `d5a92f1393973377566895a940e1b92acf7bd459d041f274cbfee5e04aca5abd`. Full raw gate stdout/stderr remain only in the local Git common-dir archive. The sync status is `awaiting-runtime`; runtime evidence is absent.

The focused command was `mise exec -- bun run --cwd apps/server test -- src/config.permissions.test.ts`, exit 0 under observed umask `022`. Its recorded stdout SHA-256 is `4108f2a8ddb69fdfccc68845e9ef8c896076f66a59d9af61b98616a0cd33c150`; stderr SHA-256 is `80afc9f45087cb9465fe4c2cac8b43add99ba54ef89b9efd219fb4ceeb6b49bd`. Those temporary focused-test log files were unavailable when the evidence archive was assembled; only their run result and recorded hashes are retained.

## Weekly sync fixture

The corrected weekly fixture passed on source 858 with Bun `1.4.2`. It exercises synthetic local Git repositories, including the real sync bind path and candidate compare-and-swap behavior. It is not a GitHub Actions run, remote branch write, manual dispatch, or scheduled execution. The archived stdout SHA-256 is `57596ebbc0d283ae3915f4dbf4f626afb2c206f0edb351048c8fc3fb0e395905`; stderr is empty with SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. The private weekly index SHA-256 is `86bb64121732d691fbe778693fb550bde696b5eedc1a295b3c8eba1b2b8f8012`.

The earlier source-9591 fixture failure remains a separate historical result: it supplied a placeholder `integratedBase` and correctly received `bind-rejected`. The fixture correction was committed in source 858; the production ancestry and CAS checks were not relaxed. WB-05 still requires a real manual workflow run and a separate real scheduled run.

## Diagnostic builds and startup smoke

Both flavors were built for macOS arm64 as diagnostic packages with pinned Node `24.13.1` and Bun `1.4.2`:

| Flavor    | Version           | DMG (size; SHA-256)                                                                   | ZIP (size; SHA-256)                                                                   | Manifest SHA-256                                                   |
| --------- | ----------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Workbench | `0.1.0`           | `321283123` bytes; `119ef71861ce0b98891db37eacc76dfdad80fa87d2bd071a60fcf5a65eb7a914` | `286399515` bytes; `3aec84a6c3bfc0651ae42dd14823fbb549ddced38f8af83729d06a19ef73e0bd` | `b0173987297bd820fd6d8b474d23d9127ab0c0d6979ec96d91c9ea7fb631c172` |
| Preview   | `0.1.0-preview.1` | `321203954` bytes; `256f7dda18b56df876847cd2940456c9ad1290bafd47be0d9977618c352fe8c8` | `286435209` bytes; `b8f6aa5f8b1930f1b21b34c6fc2b2207e9168b12b70742b8c302ed4c819c7a94` | `8a2a580f3c58eea13d4b7702ad7a33eeb5dec377d71c8829d9755b4dcf292436` |

Both manifests bind source SHA 858 and official `v0.9.2` SHA `a33435c18474eb7816582004e45f87382965ac8d`. They record `diagnostic-build-only`, `automaticChecks: not-run`, `runtimeEvidence: not-run`, and `publication: not-performed`. The shared lock hashes are: `bun.lock` `ac06520bbb21b50f9a918729ffcfaf096b2ae91f0b54edd9a1cad4889263c676`; `workbench/upstream.lock.json` `8e98354414042b011332f5cddee1231825392710b01cda357b5764711fdde840`; `.mise.toml` `a0ed2eb3e3c3704430e76428c341f7f31bb0ef5fbf13d6d28049099a3ad5c898`; `workbench/build-config.json` `13953efc2854bbba6b8cbad87419f41c3e7fde70a6b1d0e43a0fa1e7f8c1e741`. The manifests record official migration high-water `108`, Workbench module `expert` high-water `2`, and Workbench schema format version `1`.

Both manifests use the installed app's `Assets.car` as an explicit external non-source input, SHA-256 `9c38b62b4eccf2e6d3d5e129793da3630c5957657270f938391899c8ade24a60`; this does not establish source-reproducible icon provenance. The top-level manifest status is `diagnostic-build-only`; `artifactProvenance.signing.status` is `unsigned-build-only`, meaning no Developer ID release signature. The packager applied ad-hoc local signatures. There was no notarization, installation, or publication. The private artifact archive index is SHA-256 `a4b4522b07a6f964a34f723eda0717108098628d64c1eaba2b6cea79df8e7d04`.

The native packaged startup smoke passed in isolated state for Workbench session `91693` and Preview session `85347`; both exited 0. Each raw smoke log has SHA-256 `45b5336558cca4060026841f143486bf6733abb1a4ce6f9a2e5729d7399e7505`. The smoke covers runtime dependency/startup and runs with `SYNARA_DISABLE_AUTO_UPDATE=1`; updater behavior is evidenced separately below.

## Payload and identity checks

The final payload report SHA-256 is `82b86a323c65ebc5db76c248b46713b4910469c4e1d4660e08814047ce57d884`; its raw comparison SHA-256 is `081d8446ca2e36995b82f33d6f6a84af85fededc259146b3e766e2d85c740d76`. For each flavor, the packaged server tree contains 2,642 files / 38,863,472 bytes and the web tree 2,619 files / 32,088,966 bytes, with zero file differences against the frozen source payload. Bundle/plist checks passed for bundle ID, display name, scheme, version, and executable. The raw packaged restore CLI is 2,119 bytes, SHA-256 `e89de92fe75f1e348b968a3f4d7ef655283b79a9070682c4ee725f78174823b4`, matching the source workspace copy.

The CUA build input raw SHA-256 is `4bd78fa18d9695aabaec3f5b7ea73fe1579d7c0319d142fb76658b50ed68cfe4`; the packaged binary raw SHA-256 is `630742b03544d95a9da408e0dbaf04d8b45b055bce28899c04107bc98529bc11`. After removing local ad-hoc signatures, the packaged copies hash to `5c12bf0eba43d2d69860fb071b33a609fec72361a65c19b9d02f42afeb4d0a58` and compare equal to the normalized input; strict signature verification exited 0. The stage provenance hash predates that package signing and is not the final raw binary hash. This is not a claim that the final packaged binary is byte-identical to the input or is a release-signed artifact. The CUA diagnostic report SHA-256 is `93eb6ef28d27fb7371a0c9b24641a71af1f880c7d5add418ce6015f52770cdc5`.

The separate identity run passed three-app coexistence with distinct process/profile identities and owned cleanup. With `SYNARA_DISABLE_AUTO_UPDATE` unset, both Workbench updater bridges returned `enabled=false`, `status=disabled`, and `releaseUrl=null`; the installed original app's updater was not read. The raw three-app report SHA-256 is `9c2253d45c270eb9380c971d777f849506f13f460825fcd5f9cc2b0a02cda10e`; the raw two-package report SHA-256 is `90622a9fd3a00efa00804459b45c155a86782dce0080005269c44edf1912c256`. Their evidence is indexed in the private identity archive at SHA-256 `cfb352d63d7a43e57057909783cea9666a4e246c6cb8b812e4fcf94e022b1461`.

## Synthetic migration and restore

Three isolated synthetic scenarios passed on source 858. Successful startup and a failure/retry using the same backup ran in the pinned Bun harness. The third scenario invoked the restore CLI from the actual packaged Workbench Electron 43.4.1 executable with `ELECTRON_RUN_AS_NODE=1` and exited 0. The raw rehearsal report SHA-256 is `e44bf0a069bc01f4a270e3a758a78835f6dcdfaec2a127c15787cc81fa13d5ef`; the audit SHA-256 is `bdd5506cea0f46b9e772428b60f45e71ffbe6453335137869d475938cf08eebc`; the private migration index SHA-256 is `2af9e6fc8f6d602268e60472150786c9a34f952ba1ee8394a6b0b29e4fb18a17`. These scenarios used synthetic databases only. The Electron Node-mode CLI result is not a normal Electron startup or upgrade test and none of the scenarios accessed a user database.

## Remaining acceptance work

- The 858 weekly fixture passed only against its synthetic local Git repositories. Source 9591's separate fixture failure remains recorded as history; the 858 fixture correction does not weaken production bind/CAS guards. GitHub manual dispatch, scheduled execution, remote branch write, and publication have not been tested.
- The ten required runtime evidence records have not yet been assembled and bound to the candidate. The eight product Provider checks (ordinary and expert first turns for Codex and Pi, recovery, cancellation, MCP, and product session/persona isolation) have not run on 858. The earlier fee08 Codex ordinary-first-turn attempt with `gpt-6.1-sol` returned HTTP 400 because that model was unsupported for the configured account; the other seven Provider checks were not run. Packaged identity and synthetic restore have the separate passing evidence above, but are not yet bound into `runtimeEvidence`. Querying/selecting a Codex model awaits user authorization. The four explicit model/effort parameters remain required; there is no alias or default.
- The candidate remains `awaiting-runtime` with no runtime evidence. `M1`, `M2` and `M3` remain pending; `upstream.lock` still has `integratedBase` `v0.9.1`; local main is unchanged. WB-06 remains deferred by the user's decision.
