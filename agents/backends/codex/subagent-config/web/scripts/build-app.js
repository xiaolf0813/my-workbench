import fs from "node:fs/promises";
import path from "node:path";
import { build } from "vite";

const outDir = path.resolve("dist-app");
const runtimeDir = path.resolve("..", "runtime");

await build({
  configFile: path.resolve("vite.config.js"),
  logLevel: "warn",
  build: {
    outDir,
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: path.resolve("src/main.tsx"),
      output: {
        entryFileNames: "component.js",
        assetFileNames: "component.[ext]",
      },
    },
  },
});

const [css, js] = await Promise.all([
  fs.readFile(path.join(outDir, "component.css"), "utf8").catch(() => ""),
  fs.readFile(path.join(outDir, "component.js"), "utf8"),
]);

await fs.mkdir(runtimeDir, { recursive: true });
await fs.writeFile(
  path.join(runtimeDir, "component.html"),
  `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Subagent Config</title><style>${css}</style></head>
<body><div id="root"></div><script type="module">${js}</script></body>
</html>
`,
  "utf8",
);
await fs.rm(outDir, { recursive: true, force: true });
