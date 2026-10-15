import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { prototypeRoot, sourceRoot, webRoot, webSource, uiPackageRoot } from "./source-root.mjs";

const command = process.argv[2] ?? "dev";
const extraArgs = process.argv.slice(3);
if (!["dev", "build", "preview", "typecheck", "test"].includes(command)) {
  throw new Error(`Unknown command: ${command}`);
}

function writeGenerated(path, contents) {
  if (!existsSync(path) || readFileSync(path, "utf8") !== contents) writeFileSync(path, contents);
}

writeGenerated(
  resolve(prototypeRoot, "src/synara.generated.css"),
  `/* Generated locally by run.mjs; imports the actual Synara stylesheet. */\n@import ${JSON.stringify(resolve(webSource, "index.css"))};\n@source ${JSON.stringify(webSource)};\n@source ".";\n`,
);

writeGenerated(
  resolve(prototypeRoot, "tsconfig.resolved.json"),
  JSON.stringify(
    {
      extends: resolve(sourceRoot, "tsconfig.base.json"),
      compilerOptions: {
        noEmit: true,
        jsx: "react-jsx",
        lib: ["ES2023", "DOM", "DOM.Iterable"],
        types: ["node"],
        typeRoots: [
          resolve(webRoot, "node_modules/@types"),
          resolve(sourceRoot, "node_modules/@types"),
        ],
        paths: {
          "~/*": [resolve(webSource, "*")],
          "synara-ui/*": [resolve(webSource, "*")],
          "@synara/contracts": [resolve(sourceRoot, "packages/contracts/src/index.ts")],
          "@synara/shared/*": [resolve(sourceRoot, "packages/shared/src/*")],
          react: [resolve(webRoot, "node_modules/@types/react/index.d.ts")],
          "react/*": [resolve(webRoot, "node_modules/@types/react/*")],
          "react-dom/*": [resolve(webRoot, "node_modules/@types/react-dom/*")],
          "react-dom": [resolve(webRoot, "node_modules/@types/react-dom/index.d.ts")],
          "@tanstack/react-router": [resolve(webRoot, "node_modules/@tanstack/react-router")],
          "@tabler/icons-react": [uiPackageRoot("@tabler/icons-react")],
        },
      },
      include: [
        "src/**/*.ts",
        "src/**/*.tsx",
        resolve(webSource, "global.d.ts"),
        resolve(webSource, "vite-env.d.ts"),
      ],
    },
    null,
    2,
  ) + "\n",
);

const config = resolve(prototypeRoot, "vite.config.mjs");
let executable;
let args;
if (command === "typecheck") {
  executable = resolve(sourceRoot, "node_modules/@typescript/native/bin/tsc");
  args = ["--project", resolve(prototypeRoot, "tsconfig.resolved.json"), "--noEmit", ...extraArgs];
} else if (command === "test") {
  executable = resolve(uiPackageRoot("vitest"), "vitest.mjs");
  args = ["run", "--config", config, ...extraArgs];
} else {
  executable = resolve(webRoot, "node_modules/vite/bin/vite.js");
  args = [...(command === "dev" ? [] : [command]), "--config", config, ...extraArgs];
}
console.log(`Synara Context prototype · UI source: ${sourceRoot}`);
const result = spawnSync(process.execPath, [executable, ...args], {
  cwd: prototypeRoot,
  stdio: "inherit",
  env: process.env,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
