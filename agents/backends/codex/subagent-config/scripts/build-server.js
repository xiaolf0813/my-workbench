import fs from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const runtimeDir = path.resolve("runtime");
await fs.mkdir(runtimeDir, { recursive: true });

await build({
  entryPoints: [path.resolve("server/index.ts")],
  outfile: path.join(runtimeDir, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  sourcemap: false,
  legalComments: "none",
});
