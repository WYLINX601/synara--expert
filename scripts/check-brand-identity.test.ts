import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  findBrandIdentityViolations,
  findVisualBrandAssetViolations,
  findLiveLinxIdentityViolations,
  readTrackedFiles,
} from "./check-brand-identity";
import { synaraDesktopIdentity } from "@synara/shared/desktopIdentity";

const characters = (...codes: number[]): string => String.fromCharCode(...codes);
const shortName = characters(116, 51);
const firstName = `${shortName}${characters(99, 111, 100, 101)}`;
const firstDisplayName = characters(84, 51, 67, 111, 100, 101);
const firstSpacedDisplayName = `${characters(84, 51)} Code`;
const secondName = characters(100, 112, 99, 111, 100, 101);
const companyDisplayName = `${characters(84, 51)} ${characters(84, 111, 111, 108, 115)}`;
const fixtureBundleDomain = characters(99, 111, 109, 46, 115, 121, 110, 97, 114, 97);
const legalNotice = `Copyright (c) 2026 ${companyDisplayName} Inc.`;
const originsAttribution = `Synara began as a clone of [${firstDisplayName}](https://github.com/pingdotgg/${firstName}), but it has since become a substantially different product with its own branding, packaging, release system, provider orchestration, desktop app behavior, and product direction.`;
const releaseAttribution = `**A review of the Synara codebase found an analytics configuration that came from the original ${firstSpacedDisplayName} codebase when Synara was created as a clone in March. We did not add it, and we have no access to the PostHog project receiving the events.**`;
const inAppReleaseAttribution = `"A review of the Synara codebase found an analytics configuration that came from the original ${firstSpacedDisplayName} codebase when Synara was created as a clone in March.",`;

describe("brand identity guard", () => {
  it("preserves dated historical documentation without exempting current source or live guides", () => {
    expect(
      findBrandIdentityViolations([{ path: "docs/install-2026-11-04.md", contents: firstName }]),
    ).toEqual([]);
    expect(
      findBrandIdentityViolations([
        { path: "docs/release.md", contents: firstName },
        { path: "apps/web/src/branding.ts", contents: 'displayName: "Personal Workbench"' },
        { path: "docs/release-2026-11-13.md", contents: firstName },
      ]),
    ).toHaveLength(3);
  });
  it("rejects live stale Linx profile, home, bundle, origin and override identities", () => {
    const stable = synaraDesktopIdentity("workbench");
    const preview = synaraDesktopIdentity("workbench-preview");
    expect(
      findLiveLinxIdentityViolations([stable, preview], ["LINX_HOME", "LINX_PREVIEW_HOME"]),
    ).toEqual([]);
    for (const changed of [
      { ...stable, displayName: "Personal Workbench" },
      { ...stable, defaultHomeDirectoryName: ".old" },
      { ...stable, scheme: "old" },
      { ...stable, bundleId: "com.old.app" },
      { ...stable, userDataDirectoryName: "old" },
    ])
      expect(
        findLiveLinxIdentityViolations([changed, preview], ["LINX_HOME", "LINX_PREVIEW_HOME"]),
      ).toHaveLength(1);
    expect(
      findLiveLinxIdentityViolations([stable, preview], ["SYNARA_HOME", "LINX_PREVIEW_HOME"]),
    ).toHaveLength(1);
  });
  it("scans owned files while ignoring initialized and absent gitlinks", () => {
    const cwd = mkdtempSync(join(tmpdir(), "synara-brand-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    try {
      git("init", "--quiet");
      const path = "source with spaces.ts";
      writeFileSync(join(cwd, path), `const value = "${secondName}:state";`);
      git("add", "--", path);
      const oid = git("hash-object", "-w", path);
      git("update-index", "--add", "--cacheinfo", `160000,${oid},nested`);
      git("update-index", "--add", "--cacheinfo", `160000,${oid},absent`);
      mkdirSync(join(cwd, "nested"));
      writeFileSync(join(cwd, "nested", "outside.ts"), firstName);

      const files = readTrackedFiles(cwd);
      expect(files.map((file) => file.path)).toEqual([path]);
      expect(
        findBrandIdentityViolations(
          files.map((file) => ({ ...file, contents: Buffer.from(file.contents).toString("utf8") })),
        ),
      ).toHaveLength(1);

      // Explicit worktree retirement must not keep dead branding in the gate.
      rmSync(join(cwd, path));
      expect(readTrackedFiles(cwd)).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("detects retired names in paths and text", () => {
    const violations = findBrandIdentityViolations([
      { path: `docs/${firstName}.md`, contents: "Synara" },
      { path: "source.ts", contents: `const value = "${secondName}:state";` },
    ]);
    expect(violations).toHaveLength(2);
  });

  it("does not match ordinary numeric type names or canonical Synara text", () => {
    expect(
      findBrandIdentityViolations([
        { path: "source.ts", contents: "const value = new Uint32Array(); // Synara" },
      ]),
    ).toEqual([]);
  });

  it("distinguishes reviewed Hub delivery phases from retired branding", () => {
    const stage = shortName.toUpperCase();
    const path = "apps/server/src/hubCollaboration/planRevisionImpact.ts";
    const phase = `${stage} proposal analysis, with no writes or execution authority.`;
    expect(findBrandIdentityViolations([{ path, contents: phase }])).toEqual([]);
    for (const contents of [
      `${phase} ${firstName}`,
      `${phase} ${stage}`,
      phase.toLowerCase(),
      `${stage} product`,
      `${stage} Code`,
    ]) {
      expect(findBrandIdentityViolations([{ path, contents }])).toHaveLength(1);
    }
    expect(
      findBrandIdentityViolations([{ path: "apps/server/src/other.ts", contents: phase }]),
    ).toHaveLength(1);
    expect(
      findBrandIdentityViolations([
        { path: "context/PROJECT_RECORDS.md", contents: `保留 ${stage} 运行中修订的未验收边界。` },
        {
          path: "context/PROJECT_RECORDS.md",
          contents: `保留 ${stage} 运行中修订的未验收边界。${secondName}`,
        },
      ]),
    ).toHaveLength(1);
  });

  it("allows the exact legal attribution once in LICENSE", () => {
    expect(findBrandIdentityViolations([{ path: "LICENSE", contents: legalNotice }])).toEqual([]);
    expect(
      findBrandIdentityViolations([{ path: "docs/license-copy.md", contents: legalNotice }]),
    ).toHaveLength(1);
    expect(
      findBrandIdentityViolations([
        { path: "LICENSE", contents: `${legalNotice}\n${legalNotice}` },
      ]),
    ).toHaveLength(1);
  });

  it("allows the exact predecessor attribution only in the README Origins section", () => {
    expect(
      findBrandIdentityViolations([
        { path: "README.md", contents: `## Origins\n\n${originsAttribution}` },
      ]),
    ).toEqual([]);
    expect(
      findBrandIdentityViolations([
        { path: "README.md", contents: `## About\n\n${originsAttribution}` },
      ]),
    ).toHaveLength(1);
    expect(
      findBrandIdentityViolations([
        {
          path: "README.md",
          contents: `## Origins\n\n${originsAttribution}\nLegacy ${firstName}`,
        },
      ]),
    ).toHaveLength(1);
  });

  it("allows the exact 0.7.0 release attribution only in its approved locations", () => {
    expect(
      findBrandIdentityViolations([
        { path: "CHANGELOG.md", contents: `## 0.7.0 - 2026-08-05\n\n${releaseAttribution}` },
        {
          path: "apps/web/src/whatsNew/entries.ts",
          contents: inAppReleaseAttribution,
        },
      ]),
    ).toEqual([]);
    expect(
      findBrandIdentityViolations([
        { path: "CHANGELOG.md", contents: `## 0.6.7 - 2026-08-05\n\n${releaseAttribution}` },
        { path: "apps/web/src/other.ts", contents: inAppReleaseAttribution },
      ]),
    ).toHaveLength(2);
  });

  it("preserves exact Computer license attribution without exempting surrounding prose", () => {
    const path = "docs/computer-use-cua/extraction-plan.md";
    const section = "## Upstream license and PR-back feasibility";
    const attribution = `also MIT (LICENSE, ${companyDisplayName} Inc and Emanuele Di Pietro). There is no license`;
    expect(findBrandIdentityViolations([{ path, contents: `${section}\n${attribution}` }])).toEqual(
      [],
    );
    for (const contents of [
      `## Other\n${attribution}`,
      `${section}\n${attribution}\n${attribution}`,
      `${section}\n${attribution} ${firstName}`,
      `${section}\n${attribution}\n${secondName}`,
    ]) {
      expect(findBrandIdentityViolations([{ path, contents }])).toHaveLength(1);
    }
    expect(
      findBrandIdentityViolations([
        { path: "docs/computer-use-cua/other.md", contents: `${section}\n${attribution}` },
      ]),
    ).toHaveLength(1);
  });

  it("allows only the two reviewed cubic expressions in the native patch", () => {
    const path = "apps/desktop/patches/cua-driver/0001-synara-native.patch";
    const firstExpression = `+                            + ${shortName} * self.to.0`;
    const expressions = [firstExpression, firstExpression.replace("self.to.0", "self.to.1")];
    expect(findBrandIdentityViolations([{ path, contents: expressions.join("\n") }])).toEqual([]);
    for (const contents of [
      `${firstExpression}\n${firstExpression}`,
      firstExpression.replace("self.to.0", "self.from.0"),
      `${firstExpression} // ${firstName}`,
      `${expressions.join("\n")}\n+ ${secondName}`,
    ]) {
      expect(findBrandIdentityViolations([{ path, contents }])).toHaveLength(1);
    }
    expect(
      findBrandIdentityViolations([
        { path: "apps/desktop/patches/cua-driver/other.patch", contents: expressions.join("\n") },
      ]),
    ).toHaveLength(2);
  });

  it.each([
    ["apps/desktop/src/cuaFixtures/electron.ts", "cua-fixture"],
    ["apps/server/src/computer/computerSignatureChange.test.ts", "test"],
  ])("preserves only the reviewed fixture identity at %s", (path, suffix) => {
    const bundleId = `${fixtureBundleDomain}.${suffix}`;
    expect(
      findBrandIdentityViolations([
        { path, contents: `bundleId: "${bundleId}",\n"tccutil reset ScreenCapture ${bundleId}"` },
      ]),
    ).toEqual([]);
    for (const forbidden of [
      firstName,
      companyDisplayName,
      secondName,
      fixtureBundleDomain,
      `${fixtureBundleDomain}.other-fixture`,
      `${bundleId}.child`,
      `${bundleId}-copy`,
      `${bundleId}_copy`,
      `prefix${bundleId}`,
      bundleId.toUpperCase(),
    ]) {
      expect(
        findBrandIdentityViolations([{ path, contents: `"${bundleId}" "${forbidden}"` }]),
      ).toHaveLength(1);
    }
  });

  it("does not extend fixture identity exemptions to other paths or fixture families", () => {
    const bundleId = `${fixtureBundleDomain}.cua-fixture`;
    expect(
      findBrandIdentityViolations([
        { path: "apps/desktop/src/main.ts", contents: bundleId },
        { path: "apps/desktop/src/cuaFixtures/new.ts", contents: bundleId },
        { path: "scripts/computer-use-fixtures/new.mjs", contents: bundleId },
        { path: "apps/server/src/computer/new.test.ts", contents: bundleId },
        { path: "docs/computer-use-cua/evidence/new-report.json", contents: bundleId },
        { path: "scripts/computer-use-fixtures/build-canary.mjs", contents: bundleId },
        { path: "apps/desktop/src/cuaFixtures/electron.ts", contents: `${bundleId}-external` },
      ]),
    ).toHaveLength(7);
  });

  it("requires user-facing raster assets to match a visually approved digest", () => {
    const approvedContents = new TextEncoder().encode("approved Synara screenshot");
    const approvedDigest = "a553296ca5a2d3ad7b64a6bc1b36c2834da750eae6611642177482b99ba85bd8";
    const approvedDigests = new Map([["screenshot.jpeg", approvedDigest]]);

    expect(
      findVisualBrandAssetViolations(
        [{ path: "screenshot.jpeg", contents: approvedContents }],
        approvedDigests,
      ),
    ).toEqual([]);
    expect(
      findVisualBrandAssetViolations(
        [{ path: "screenshot.jpeg", contents: new TextEncoder().encode("changed") }],
        approvedDigests,
      ),
    ).toHaveLength(1);
    expect(findVisualBrandAssetViolations([], approvedDigests)).toHaveLength(1);
  });
});
