import fs from "node:fs/promises";
import path from "node:path";
import { build } from "vite";

const outDir = path.resolve("dist-app");

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

await fs.writeFile(
  path.resolve("dist/component.html"),
  `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Codex Subagent Model Configuration</title><style>${css}</style></head>
<body><div id="root"></div><script type="module">${js}</script></body>
</html>
`,
  "utf8",
);
