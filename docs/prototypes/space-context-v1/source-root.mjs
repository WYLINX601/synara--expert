import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const prototypeRoot = dirname(fileURLToPath(import.meta.url));
const localConfig = resolve(prototypeRoot, "ui-source.local.json");
const configuredRoot = existsSync(localConfig)
  ? JSON.parse(readFileSync(localConfig, "utf8")).sourceRoot
  : undefined;
export const sourceRoot = resolve(
  process.env.SYNARA_UI_SOURCE_ROOT ?? configuredRoot ?? resolve(prototypeRoot, "../../.."),
);
export const webRoot = resolve(sourceRoot, "apps/web");
export const webSource = resolve(webRoot, "src");
export const uiRequire = createRequire(resolve(webRoot, "package.json"));

if (!existsSync(resolve(webSource, "components/SpaceSwitcher.tsx"))) {
  throw new Error(
    "UI source lacks SpaceSwitcher. Set SYNARA_UI_SOURCE_ROOT or ui-source.local.json to the approved Synara UI checkout.",
  );
}

export function uiPackageRoot(name) {
  return dirname(uiRequire.resolve(`${name}/package.json`));
}
