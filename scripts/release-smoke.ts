// Policy smoke for the static CI lane. Behavioral suites cover
// signatures, provenance and checkpoints; do not pin workflow source wording.
import assert from "node:assert/strict";
import { readLinxProductVersion } from "./lib/linx-release-source.ts";
import { resolveReleaseUpdatePolicy } from "./lib/release-update-policy.ts";
import { resolveReleaseBuildScope } from "./lib/release-build-scope.ts";
const version = readLinxProductVersion(new URL("..", import.meta.url).pathname);
assert.equal(resolveReleaseUpdatePolicy(`v${version}`, version).desktopFlavor, "workbench");
assert.throws(() => resolveReleaseUpdatePolicy(`${version}-beta.1`, version));
assert.throws(() => resolveReleaseUpdatePolicy("1.1.0", "0.1.15"));
assert.deepEqual(
  resolveReleaseBuildScope(undefined, "artifact", true).matrix.include.map((entry) => entry.id),
  ["mac-arm64"],
);
for (const platform of ["all", "mac-x64", "win-x64", "linux-x64"])
  assert.throws(() => resolveReleaseBuildScope(platform, "artifact", true));
console.log("Linx release policy smoke passed.");
