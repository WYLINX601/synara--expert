import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  prototypeRoot,
  sourceRoot,
  webRoot,
  webSource,
  uiRequire,
  uiPackageRoot,
} from "./source-root.mjs";

const react = (await import(pathToFileURL(uiRequire.resolve("@vitejs/plugin-react")).href)).default;
const tailwind = (await import(pathToFileURL(uiRequire.resolve("@tailwindcss/vite")).href)).default;
const nativeBoundary = resolve(prototypeRoot, "src/nativeApiBoundary.ts");
const appSnapBoundary = resolve(prototypeRoot, "src/appSnapBoundary.ts");
const storeBoundary = resolve(prototypeRoot, "src/storeBoundary.ts");

export default {
  root: prototypeRoot,
  publicDir: resolve(webRoot, "public"),
  cacheDir: resolve(prototypeRoot, ".vite"),
  plugins: [
    {
      name: "context-prototype-native-api-boundary",
      enforce: "pre",
      resolveId(id, importer) {
        if (importer?.startsWith(webSource) && /(?:^|\/)store(?:\.ts)?$/.test(id)) {
          return storeBoundary;
        }
        if (importer?.startsWith(webSource) && /(?:^|\/)useAppSnapWindows(?:\.ts)?$/.test(id)) {
          return appSnapBoundary;
        }
        if (importer?.startsWith(webSource) && /(?:^|\/)nativeApi(?:\.ts)?$/.test(id)) {
          return nativeBoundary;
        }
      },
    },
    react(),
    tailwind(),
  ],
  resolve: {
    alias: [
      { find: "~", replacement: webSource },
      { find: "synara-ui", replacement: webSource },
      ...[
        "react",
        "react-dom",
        "@tanstack/react-router",
        "@base-ui/react",
        "@tabler/icons-react",
        "@fontsource-variable/jetbrains-mono",
      ].map((name) => ({
        find: name,
        replacement: uiPackageRoot(name),
      })),
    ],
    dedupe: ["react", "react-dom", "@tanstack/react-router", "@base-ui/react"],
  },
  server: {
    host: "127.0.0.1",
    port: 17736,
    strictPort: true,
    fs: { allow: [sourceRoot, prototypeRoot] },
  },
  preview: { host: "127.0.0.1", port: 17736, strictPort: true },
  build: {
    outDir: resolve(prototypeRoot, "dist"),
    emptyOutDir: true,
    // Keep the real icon library assets accessible without pruning production assets.
    copyPublicDir: true,
  },
  test: {
    include: ["src/*.test.ts"],
    environment: "node",
  },
};
