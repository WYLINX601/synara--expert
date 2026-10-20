import { readFile } from "node:fs/promises";

import {
  SkillPackageSwitchInput,
  WS_METHODS,
  type SkillPackageSwitchApplyInput,
  type SkillPackageSwitchProgressReadInput,
} from "@synara/contracts";
import { Schema } from "effect";

import { connectOwnerUrl } from "../computer-use-fixtures/packaged-client.ts";

type SwitchCommand =
  | { readonly kind: "preview"; readonly inputPath: string }
  | { readonly kind: "apply"; readonly switchId: string; readonly digest: string }
  | { readonly kind: "progress"; readonly switchId: string };

function requiredValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

export function parseSkillPackageSwitchArgs(args: readonly string[]): SwitchCommand {
  const [command, ...flags] = args;
  if (command === "preview") {
    if (flags.length !== 2 || flags[0] !== "--input") {
      throw new Error("Usage: skill-package-switch preview --input <request.json>");
    }
    return { kind: "preview", inputPath: requiredValue(flags, 0, "--input") };
  }
  if (command === "apply") {
    if (flags.length !== 4 || flags[0] !== "--switch-id" || flags[2] !== "--digest") {
      throw new Error("Usage: skill-package-switch apply --switch-id <id> --digest <sha256>");
    }
    const input: SkillPackageSwitchApplyInput = {
      switchId: requiredValue(flags, 0, "--switch-id"),
      digest: requiredValue(flags, 2, "--digest"),
    };
    return { kind: "apply", ...input };
  }
  if (command === "progress") {
    if (flags.length !== 2 || flags[0] !== "--switch-id") {
      throw new Error("Usage: skill-package-switch progress --switch-id <id>");
    }
    const input: SkillPackageSwitchProgressReadInput = {
      switchId: requiredValue(flags, 0, "--switch-id"),
    };
    return { kind: "progress", ...input };
  }
  throw new Error(
    "Usage: skill-package-switch <preview|apply|progress> ... (owner RPC URL must be supplied through SYNARA_EXPERT_SWITCH_OWNER_URL)",
  );
}

export async function runSkillPackageSwitchCli(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  const command = parseSkillPackageSwitchArgs(args);
  const ownerUrl = environment.SYNARA_EXPERT_SWITCH_OWNER_URL;
  if (!ownerUrl) {
    throw new Error(
      "Set SYNARA_EXPERT_SWITCH_OWNER_URL to the authenticated loopback WebSocket URL for the selected isolated owner.",
    );
  }
  const owner = await connectOwnerUrl(ownerUrl);
  try {
    if (command.kind === "preview") {
      const request = Schema.decodeUnknownSync(SkillPackageSwitchInput)(
        JSON.parse(await readFile(command.inputPath, "utf8")) as unknown,
      );
      return await owner.run(owner.api[WS_METHODS.serverPreviewSkillPackageSwitch](request));
    }
    if (command.kind === "apply") {
      return await owner.run(
        owner.api[WS_METHODS.serverApplySkillPackageSwitch]({
          switchId: command.switchId,
          digest: command.digest,
        }),
      );
    }
    return await owner.run(
      owner.api[WS_METHODS.serverReadSkillPackageSwitchProgress]({
        switchId: command.switchId,
      }),
    );
  } finally {
    await owner.close();
  }
}

if (import.meta.main) {
  try {
    const result = await runSkillPackageSwitchCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  }
}
