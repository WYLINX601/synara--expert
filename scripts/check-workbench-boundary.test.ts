import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  collectWorkbenchFeatureSources,
  WORKBENCH_RETAINED_IMPORTS,
  findWorkbenchFeatureBoundaryViolations,
} from "./check-workbench-boundary";

describe("Workbench feature import boundary", () => {
  it("rejects direct persistence, Provider, task and Gateway imports", () => {
    const violations = findWorkbenchFeatureBoundaryViolations(
      "apps/server/src/workbench/features/boards/boardService.ts",
      `
        import { SqlitePersistence } from "../../../persistence/Layers/Sqlite";
        import { ProviderService } from "../../../provider/Services/ProviderService";
        export { createThread } from "../../../orchestration/Services/OrchestrationEngine";
        const gateway = await import("../../../agentGateway/Layers/AgentGateway");
        const database = require("@effect/sql-sqlite-bun");
        import * as SqlClient from "effect/unstable/sql/SqlClient";
        const migrator = await import("effect/unstable/sql/Migrator");
      `,
    );

    expect(violations.map(({ boundary }) => boundary)).toEqual([
      "native persistence",
      "Provider runtime control",
      "task internals",
      "native database access",
      "Agent Gateway runtime control",
      "native database access",
      "native database access",
    ]);
    expect(violations).toContainEqual({
      file: "apps/server/src/workbench/features/boards/boardService.ts",
      specifier: "effect/unstable/sql/SqlClient",
      boundary: "native database access",
    });
  });

  it("allows shared, UI and explicit host imports, and ignores commented examples", () => {
    const violations = findWorkbenchFeatureBoundaryViolations(
      "apps/web/src/workbench/features/boards/BoardView.tsx",
      `
        import { Button } from "~/components/ui/button";
        import { Schema } from "@synara/contracts/ws";
        import { data } from "@synara/shared/format";
        import { Effect, Layer } from "effect";
        import * as EffectCore from "effect/Effect";
        import { threadQuery } from "../../host/threadQuery";
        // import { ProviderService } from "../../../server/src/provider/ProviderService";
        /* import { Sql } from "@effect/sql"; */
      `,
    );

    expect(violations).toEqual([]);
  });

  it("allows explicit host access and rejects native imports from either feature surface", () => {
    expect(
      findWorkbenchFeatureBoundaryViolations(
        "apps/server/src/workbench/features/experts/connection.ts",
        `import { connections } from "../../host/connectionHost";`,
      ),
    ).toEqual([]);

    expect(
      findWorkbenchFeatureBoundaryViolations(
        "apps/web/src/workbench/features/experts/connection.ts",
        `import { repository } from "../../../../../server/src/persistence/ExpertStore";`,
      ),
    ).toEqual([
      {
        file: "apps/web/src/workbench/features/experts/connection.ts",
        specifier: "../../../../../server/src/persistence/ExpertStore",
        boundary: "native persistence",
      },
    ]);
  });

  it("passes before feature directories exist and detects files added later", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "synara-workbench-boundary-"));
    try {
      expect(collectWorkbenchFeatureSources(tempRoot)).toEqual([]);
      expect(() => collectWorkbenchFeatureSources(tempRoot, { requireManifest: true })).toThrow(
        /Required Workbench manifest is missing/,
      );

      const featureDirectory = path.join(tempRoot, "apps/server/src/workbench/features/boards");
      mkdirSync(featureDirectory, { recursive: true });
      writeFileSync(
        path.join(featureDirectory, "boardService.ts"),
        `import { ProviderService } from "../../../provider/Services/ProviderService";`,
      );

      const sources = collectWorkbenchFeatureSources(tempRoot);
      expect(sources).toHaveLength(1);
      expect(
        findWorkbenchFeatureBoundaryViolations(sources[0]!.path, sources[0]!.source),
      ).toHaveLength(1);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails with the declared path when a manifest feature file is missing", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "synara-workbench-manifest-"));
    try {
      mkdirSync(path.join(tempRoot, "workbench"), { recursive: true });
      writeFileSync(
        path.join(tempRoot, "workbench/integration-points.json"),
        JSON.stringify({
          integrationPoints: [
            {
              id: "workbench.feature-import-boundary",
              featureFiles: ["apps/web/src/missingFeature.ts"],
            },
          ],
        }),
      );

      expect(() => collectWorkbenchFeatureSources(tempRoot)).toThrow(
        /feature file does not exist: apps\/web\/src\/missingFeature\.ts/,
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects full clients, stores and routes on migrated Expert surfaces", () => {
    expect(
      findWorkbenchFeatureBoundaryViolations(
        "apps/web/src/components/settings/ExpertsSettingsPanel.tsx",
        `import { ensureNativeApi } from "~/nativeApi";
       import { socket } from "~/wsNativeApi.ts";
       import { store } from "~/store";
       import { Route } from "../../routes/_chat.settings";
       import { useNavigate } from "@tanstack/react-router";`,
      ).map(({ boundary }) => boundary),
    ).toEqual([
      "full native client",
      "native transport",
      "native task store",
      "native routes",
      "native router",
    ]);
  });

  it("rejects native client, task store, routes, persistence and legacy context cache from Context and Space features", () => {
    const file = "apps/web/src/components/chat/environment/useProjectContextAutosave.ts";
    const violations = findWorkbenchFeatureBoundaryViolations(
      file,
      `import { api } from "~/nativeApi";
       import { store } from "~/store";
       import { Route } from "~/routes/_chat";
       import { useNavigate } from "@tanstack/react-router";
       import * as Sql from "@effect/sql";
       import { ContextRepository } from "../../../../../server/src/context/ContextRepository";
       import { useProjectInstructionsStore } from "~/projectInstructionsStore";`,
    );

    expect(violations.map(({ boundary }) => boundary)).toEqual([
      "full native client",
      "native task store",
      "native routes",
      "native router",
      "native database access",
      "native persistence",
      "legacy project context cache",
    ]);
  });

  it("allows UI, contracts and the explicit Context host client for migrated consumers", () => {
    expect(
      findWorkbenchFeatureBoundaryViolations(
        "apps/web/src/components/chat/ContextDetailsDialog.tsx",
        `import type { ContextApi } from "@synara/contracts";
         import { SpaceIcon } from "~/components/SpaceIcon";
         import { useContextClient } from "~/workbench/host/contextClient";`,
      ),
    ).toEqual([]);
  });

  it("allows each exact retained seam but rejects the same coupling in a new module", () => {
    for (const seam of WORKBENCH_RETAINED_IMPORTS) {
      const source = `import { capability } from "${seam.specifier}";`;
      expect(findWorkbenchFeatureBoundaryViolations(seam.file, source)).toEqual([]);
      const sibling = seam.file.replace(/[^/]+$/, "NewExpertModule.ts");
      expect(findWorkbenchFeatureBoundaryViolations(sibling, source)).toHaveLength(1);
    }
  });

  it("scans existing experts and future Expert/MCP UI without scanning native panels or fixtures", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "synara-workbench-legacy-"));
    const files = [
      "apps/server/src/experts/FutureExpert.ts",
      "apps/server/src/experts/FutureExpert.test.ts",
      "apps/web/src/components/settings/ExpertNewPanel.tsx",
      "apps/web/src/components/settings/GlobalMcpNewPanel.tsx",
      "apps/web/src/components/settings/LocalMcpNewPanel.tsx",
      "apps/web/src/components/settings/ExpertNewPanel.browser.tsx",
      "apps/web/src/components/settings/ProvidersSettingsPanel.tsx",
      "apps/web/src/components/chat/ExpertNewControl.tsx",
      "apps/web/src/components/chat/ChatView.tsx",
      "apps/web/src/components/SpaceSwitcher.tsx",
      "apps/web/src/components/SpaceSwitcher.browser.tsx",
      "apps/web/src/components/useSpacesController.ts",
      "apps/web/src/components/chat/ContextDetailsDialog.tsx",
      "apps/web/src/components/chat/ContextDetailsDialog.browser.tsx",
      "apps/web/src/components/chat/environment/projectContextAutosave.ts",
      "apps/web/src/components/chat/environment/projectContextAutosave.test.ts",
      "apps/web/src/components/chat/environment/projectContextNavigationGuard.ts",
      "apps/web/src/components/chat/environment/useProjectContextMigration.tsx",
      "apps/web/src/components/chat/environment/useProjectContextMigration.browser.tsx",
    ];
    try {
      for (const file of files) {
        mkdirSync(path.dirname(path.join(tempRoot, file)), { recursive: true });
        writeFileSync(path.join(tempRoot, file), "export {};");
      }
      expect(collectWorkbenchFeatureSources(tempRoot).map(({ path: file }) => file)).toEqual(
        files
          .filter(
            (file) =>
              !/\.(?:test|browser)\./.test(file) &&
              !/(?:ProvidersSettingsPanel|ChatView|useSpacesController)/.test(file),
          )
          .toSorted(),
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
  it("keeps every retained import documented with an owner and regression path", () => {
    const root = path.resolve(import.meta.dirname, "..");
    const scannedFiles = new Set(
      collectWorkbenchFeatureSources(root, { requireManifest: true }).map(({ path: file }) => file),
    );
    const manifest = JSON.parse(
      readFileSync(path.join(root, "workbench/integration-points.json"), "utf8"),
    ) as {
      integrationPoints: Array<{
        id: string;
        retainedImports?: Array<{
          file: string;
          specifiers: string[];
          owner: string;
          reason: string;
          tests: string[];
        }>;
        featureFiles?: string[];
        featureRoots?: string[];
      }>;
    };
    const seams = manifest.integrationPoints.find(
      (point) => point.id === "workbench.feature-import-boundary",
    )!.retainedImports!;
    expect(
      seams
        .flatMap((seam) => seam.specifiers.map((specifier) => `${seam.file}:${specifier}`))
        .toSorted(),
    ).toEqual(
      WORKBENCH_RETAINED_IMPORTS.map((seam) => `${seam.file}:${seam.specifier}`).toSorted(),
    );
    for (const seam of seams) {
      expect(seam.owner.length).toBeGreaterThan(0);
      expect(seam.reason.length).toBeGreaterThan(0);
      expect(seam.tests.length).toBeGreaterThan(0);
      expect(scannedFiles.has(seam.file)).toBe(true);
    }

    const featureFiles = manifest.integrationPoints.flatMap((point) => point.featureFiles ?? []);
    expect(featureFiles.length).toBeGreaterThan(0);
    for (const featureFile of featureFiles) expect(scannedFiles.has(featureFile)).toBe(true);
  });
});
