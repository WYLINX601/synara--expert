# Contributing

## This Repository

This is the `WYLINX601/synara--expert` fork. All contributions target its `main` branch; Stable and Beta share that branch, so there is no Beta branch.

- **Invited collaborators** work from an agreed issue or story, use a task branch, and open a PR. Do not push directly to `main`; the repository ruleset blocks force-push and deletion.
- **External contributors** fork this repository, branch from `main`, and open a PR. Expect `vouch:unvouched` until a maintainer adds you to [.github/VOUCHED.td](.github/VOUCHED.td) or grants write access.
- **Upstream** [Emanuele-web04/synara](https://github.com/Emanuele-web04/synara) is not the default PR target. Upstream sync and upstream PRs are maintainer tasks; do not send this fork's changes upstream without the sync owner.
- **Before a non-trivial change**, open a draft PR with a short proposal (GitHub Issues are disabled on this fork), or use the agreed team story if you have access. UI or core-flow changes need design confirmation before implementation.
- **One PR, one slice.** Link the issue or story if one exists, record the checks you ran, and rebase on the latest `main`. Do not mix unrelated formatting or drive-by refactors. Wait for the aggregate CI gate `Format, Lint, Typecheck, Test, Browser Test, Build` on the PR head.
- **Review**: once the repository has more than one active developer with write access, every code PR needs at least one non-author approval from a write-access reviewer. Authors never self-approve.
- **Security**: never include credentials, user data, provider logs, diagnostics, or real databases in issues, PRs, screenshots, or test artifacts. Use an isolated home and ports for tests.
- **Releases**: `v*.*.*` tags are maintainer-only and immutable. Contributors do not create tags or publish releases.

The detailed team workflow, ownership rules, and merge queue live in [the development SOP](docs/workbench-development-workflow.md#multi-contributor). The scope guidance below still applies to unsolicited contributions.

## Read This First

We are accepting focused contributions, especially small bug fixes, reliability fixes, performance improvements, and maintenance work.

You can open a pull request; fork-specific proposals start as a draft PR. Reproducible upstream bugs belong in the upstream issue tracker. Please do so knowing that Synara is still early and we are keeping scope, quality, and direction tight.

Large, unfocused, or direction-changing PRs may still be closed quickly.

PRs are automatically labeled with a `vouch:*` trust status and a `size:*` diff size based on changed lines.

If you are an external contributor, expect `vouch:unvouched` until we explicitly add you to [.github/VOUCHED.td](.github/VOUCHED.td).

## What We Are Most Likely To Accept

Small, focused bug fixes.

Small reliability fixes.

Small performance improvements.

Tightly scoped maintenance work that clearly improves the project without changing its direction.

## What We Are Least Likely To Accept

Large PRs.

Drive-by feature work.

Opinionated rewrites.

Anything that expands product scope without us asking for it first.

If you open a 1,000+ line PR full of new features, we will probably close it quickly and remember that you ignored the clearly written instructions.

## If You Still Want To Open A PR

Keep it small.

Explain exactly what changed.

Explain exactly why the change should exist.

Do not mix unrelated fixes together.

If the PR makes anything resembling a UI change, include clear before/after images.

For interface copy, follow [the localization guide](docs/internationalization.md). Add stable semantic keys and translations in every shipped locale, preserve user/provider data, and run the catalog and extraction checks.

If the change depends on motion, timing, transitions, or interaction details, include a short video.

If we have to guess what changed, we are much less likely to review it.

## Proposals First

If you are thinking about a non-trivial change, open a draft PR with a short proposal first. GitHub Issues are disabled on this fork; if you have access to the team story tracker, use that instead.

That gives you a chance to check whether the direction fits before spending time on a larger patch. Reproducible upstream bugs belong in the upstream issue tracker.

## Testing

Run the full workspace test suite from the repository root with:

```bash
bun run test
```

Activate the Node and Bun versions pinned in `.mise.toml` first. With those
versions already installed, `mise exec -- bun run test` selects them without
changing the machine's default PATH. The sync-workflow tests bind candidate
evidence to the actual toolchain; mixing system versions with pinned fixture
versions correctly rejects verification instead of producing a ready candidate.

The root command runs package suites one at a time. Each Vitest process already
owns a worker pool; running several package pools together oversubscribes the
host and can starve native-process and cold-import deadlines. Package-local
worker settings and all test deadlines remain unchanged. A failed package does
not cancel the remaining packages: Turbo collects every package outcome and
still returns a nonzero exit status if any package fails.

For focused web tests, pass paths relative to `apps/web` through the dedicated root command:

```bash
bun run test:web:focused src/path/to/example.test.ts
```

The pinned `@pierre/diffs` patch refreshes file-editor rows after line insertions
and deletions. When upgrading the dependency, verify repeated Enter, subsequent
typing, undo, and redo with the real editor browser tests before removing it:

```bash
bun run --cwd apps/web test:browser src/components/codeEditor/CodeEditorPane.browser.tsx
```

The pinned `@effect/platform-node-shared` patch preserves Windows spawn options
and rejects invalid PIDs before converting child handles into process-group
signals. Windows group cleanup must launch `taskkill` directly with
`windowsHide: true`, so teardown does not open a console beneath the desktop app.
Valid groups may outlive their leader; cleanup must continue to reach those descendants. When updating Effect, keep these behaviors and run
`apps/server/src/platform/effectProcessSignals.test.ts` against the installed
runtime, including its Windows cases.

The same patch makes writable stream errors fail the owning Effect sink, waits
for accepted writes before completing, and removes drain/finish listeners on
cancellation. Pending writes retain an error listener until they settle so a
late broken pipe cannot become an uncaught process exception. Keep the source
and compiled runtime changes together and run
`apps/server/src/platform/effectWritableSink.test.ts` after updating Effect.

Process-tree teardown captures POSIX start times and Windows creation times for
checking descendants during delayed cleanup and exit verification. Start times
add evidence to the existing command-line comparison. POSIX start times have
second resolution and observation followed by signaling is not atomic;
these checks are not proof of arbitrary PID ownership. Root signaling still
requires the caller to own the live process lifecycle. Direct owned-child
cancellation must work even when external process-table tools are unavailable.

Desktop Node fetch uses the pinned Undici dispatcher initialized by `httpRuntime.ts`.
Electron 43's bundled Undici can crash in `setTypeOfService` on macOS; the upstream
fix belongs in the HTTP writer, not an uncaught-exception handler. When updating
Electron or Undici, run `apps/desktop/src/httpRuntime.test.ts` under both Node and
Electron with `ELECTRON_RUN_AS_NODE=1`. The test performs real loopback HTTP
requests while injecting the socket error and also checks ordinary request failures.

Packaged desktop API requests must reach the HTTP backend; the static protocol
serves only GET/HEAD navigation and assets. An attachment upload needs a valid
JSON receipt even when HTTP reports success. Preserve drafts on upload failure
and observe pending upload rejections while workspace preparation is awaiting RPCs.

Desktop stdio MCP proxies reuse Electron's executable and must explicitly set
`ELECTRON_RUN_AS_NODE=1` in their launch configuration. Provider child environments
strip that inherited flag, so relying on inheritance can launch the desktop GUI
instead of the proxy. Keep the provider environment filtering intact.

Database lifecycle locks publish their owner metadata atomically. Startup may
recover an empty lock directory or one containing only Finder's `.DS_Store`,
including the stale-lock recovery guard. It must preserve live owners, malformed
owner metadata, links, and unrecognized files. An unknown owner is not proof of
another running server; the desktop lock dialog provides **Open logs** to inspect
the underlying error. Never remove a populated lock to work around a startup block.

## Be Realistic

Opening a PR does not create an obligation on our side.

We may close it. We may ignore it. We may ask you to shrink it. We may reimplement the idea ourselves later.

If you are fine with that, proceed.
