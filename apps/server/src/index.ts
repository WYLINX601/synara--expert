import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CliConfig, synaraCli } from "./main";
import { OpenLive } from "./open";
import { Command } from "effect/unstable/cli";
import { version } from "../package.json" with { type: "json" };
import { ServerLive } from "./effectServer";
import { NetService } from "@synara/shared/Net";
import { FetchHttpClient } from "effect/unstable/http";
import { consumeDesktopParentInput, withDesktopParentLifetime } from "./desktopParentLifetime";
import { parseManagementCliFlagFailure } from "./managementCli/cli";

const desktopParentInput = consumeDesktopParentInput(process.env, () => process.stdin);
const managementFlagFailure = parseManagementCliFlagFailure(process.argv.slice(2));

if (managementFlagFailure) {
  process.stderr.write(
    `${JSON.stringify({
      version: 1,
      ok: false,
      command: managementFlagFailure.namespace,
      error: { code: "usage_error", message: managementFlagFailure.message, exitCode: 2 },
    })}\n`,
  );
  process.exitCode = 2;
} else {
  const RuntimeLayer = Layer.empty.pipe(
    Layer.provideMerge(CliConfig.layer),
    Layer.provideMerge(ServerLive),
    Layer.provideMerge(OpenLive),
    Layer.provideMerge(NetService.layer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(FetchHttpClient.layer),
  );

  Command.run(synaraCli, { version })
    .pipe(Effect.provide(RuntimeLayer))
    .pipe((program) => withDesktopParentLifetime(program, desktopParentInput))
    .pipe((program) => NodeRuntime.runMain(program as Effect.Effect<void, unknown, never>));
}
