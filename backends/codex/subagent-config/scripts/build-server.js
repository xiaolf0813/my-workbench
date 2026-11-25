import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";

const runtimeDir = path.resolve("runtime");
await fs.mkdir(runtimeDir, { recursive: true });
const keyringAssets = path.resolve("assets/keyring");
const keyringRuntime = path.join(runtimeDir, "keyring");
const keyringBindings = path.join(keyringRuntime, "bindings");
await fs.mkdir(keyringBindings, { recursive: true });
await fs.copyFile(path.join(keyringAssets, "index.js"), path.join(keyringRuntime, "index.cjs"));
for (const filename of [
  "keyring.win32-x64-msvc.node",
  "keyring.linux-x64-gnu.node",
  "keyring.linux-arm64-gnu.node",
  "keyring.darwin-x64.node",
  "keyring.darwin-arm64.node",
]) {
  await fs.copyFile(path.join(keyringAssets, "bindings", filename), path.join(keyringBindings, filename));
}

await build({
  entryPoints: [path.resolve("server/index.ts")],
  outfile: path.join(runtimeDir, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  external: ["@napi-rs/keyring", "cpu-features", "*.node"],
  banner: { js: 'import { createRequire as createBundleRequire } from "node:module"; import { fileURLToPath as bundleFileURLToPath } from "node:url"; import { dirname as bundleDirname } from "node:path"; const require = createBundleRequire(import.meta.url); const __dirname = bundleDirname(bundleFileURLToPath(import.meta.url));' },
  sourcemap: false,
  legalComments: "none",
});
const serverBundle = path.join(runtimeDir, "server.mjs");
const serverSource = await fs.readFile(serverBundle, "utf8");
await fs.writeFile(serverBundle, serverSource.replace(/[\t ]+$/gm, ""));
execFileSync(process.execPath, ["--check", serverBundle], { stdio: "inherit" });
