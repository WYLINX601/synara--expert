import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  collectWorkbenchFeatureSources,
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
});
