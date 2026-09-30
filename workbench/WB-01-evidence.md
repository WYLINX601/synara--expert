# WB-01 bounded evidence

Snapshot: 2026-09-30, macOS host. This is environment and repository evidence; no installed app was changed or launched, and no user database was accessed.

## Icon input and build limits

- `/Applications` has no Xcode app. `xcode-select -p` resolves to Command Line Tools; `xcodebuild -version` fails because full Xcode is required, and `xcrun --find actool` reports no `actool`. `swiftc` 6.2.3, `sips`, and `ditto` are available. A source-catalog rebuild with Apple's asset compiler is therefore unavailable on this host without installing tools.
- The installed `/Applications/Synara.app` is version 0.9.2, bundle ID `com.emanueledipietro.synara`. Its `Contents/Resources/Assets.car` is 546,152 bytes, SHA-256 `9c38b62b4eccf2e6d3d5e129793da3630c5957657270f938391899c8ade24a60`. No `Assets.car` exists in the checked-out source asset locations. The three production icon source directories/files (`Synara.icon`, `Synara-Dark.icon`, `Synara-Custom.icon`) match fixed `refs/tags/v0.9.2` at current `HEAD`; this does not prove the installed catalog was produced from that checkout.
- The artifact builder accepts `SYNARA_MAC_ICON_CATALOG` and copies the supplied catalog into staging; absent that input it calls `xcrun actool`. The release workflow builds and uploads `Assets.car` on macOS from its checkout. A future candidate-bound reproducible check can use that artifact from the exact candidate SHA, build both Workbench flavors as ZIPs, then extract the `.app` with `/usr/bin/ditto -x -k` for bundle-ID and coexistence inspection. The current macOS artifact wrapper finalizes a ZIP and does not support a direct `--target dir` path.
- No identity diagnostic package was built in this stage, by scheduling decision. Copying the installed catalog into an isolated temp directory and setting `SYNARA_MAC_ICON_CATALOG` was authorized only for explicitly labeled diagnosis, not release provenance; it has not been done. Actual Workbench identities, installed-app coexistence, launch behavior, updater behavior, and user-data isolation remain unverified.

## GitHub Actions settings snapshot

Read-only `gh`/GitHub API inspection for `WYLINX601/synara--expert` found a public repository with default branch `main` and viewer permission `ADMIN`. Actions are enabled (`allowed_actions=all`); default workflow token permission is read-only; `can_approve_pull_request_reviews=false`. No repository rulesets or classic branch-protection rules were returned. The CLI token was not printed.

The repository setting controlling whether `GITHUB_TOKEN` may create and approve pull requests is off. Therefore WB-05 must treat automated PR creation as unavailable by default; explicit `contents:write` may permit candidate-branch writes, subject to a real run. A candidate-branch plus run-artifact/check summary is the available planned fallback; no PAT or repository-setting change is authorized. Workflow execution, scheduled dispatch, branch-write permission, artifact retention, and quotas have not been tested.

References: [GitHub Actions repository settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository); [workflow token permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions).
