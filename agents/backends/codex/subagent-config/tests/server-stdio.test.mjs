import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureHome = fileURLToPath(new URL("./fixtures/codex-home", import.meta.url));

test("stdio server exposes the three tools and the MCP Apps resource", async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(pluginRoot, "mcp.json"), "utf8"));
  const serverConfig = manifest.mcpServers["subagent-config"];
  const serverEntryPoint = serverConfig.args[0].replace("${PLUGIN_ROOT}", pluginRoot);
  assert.equal(serverConfig.type, "stdio");
  assert.equal(serverConfig.cwd, "${PLUGIN_ROOT}");
  await fs.access(serverEntryPoint);

  // Exercise the exact four-file deployment shape: no package.json and no
  // node_modules may be required by the bundled server at runtime.
  const isolatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-config-runtime-"));
  const isolatedRuntime = path.join(isolatedRoot, "runtime");
  await fs.mkdir(isolatedRuntime);
  await fs.copyFile(serverEntryPoint, path.join(isolatedRuntime, "server.mjs"));
  await fs.copyFile(
    path.join(pluginRoot, "runtime", "component.html"),
    path.join(isolatedRuntime, "component.html"),
  );

  const client = new Client({ name: "subagent-config-test", version: "0.1.8" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(isolatedRuntime, "server.mjs")],
    cwd: isolatedRoot,
    env: { ...process.env, CODEX_HOME: fixtureHome },
  });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ["get_agent_configurations", "list_models", "update_agent_model"],
    );

    const resources = await client.listResources();
    const appResource = resources.resources.find((resource) => resource.uri === "ui://subagent-config/v11.html");
    assert.ok(appResource);
    const component = await client.readResource({ uri: appResource.uri });
    assert.equal(component.contents[0]?.mimeType, "text/html;profile=mcp-app");
    const componentHtml = component.contents[0]?.text ?? "";
    assert.match(componentHtml, /Subagent Config/);
    assert.match(componentHtml, /ui\/notifications\/tool-input/);
    assert.match(componentHtml, /project-root-value/);
    assert.doesNotMatch(componentHtml, /project-root-field/);

    const models = await client.callTool({ name: "list_models", arguments: {} });
    assert.equal(models.isError, undefined);
    assert.equal(models.structuredContent.allowCustomSlug, false);
    assert.equal(models.structuredContent.models.every((model) => model.available === null), true);

    const snapshot = await client.callTool({ name: "get_agent_configurations", arguments: {} });
    assert.equal(snapshot.isError, undefined);
    assert.ok(Array.isArray(snapshot.structuredContent.agents));

    const secret = "developer-instructions-must-not-leak";
    const rejected = await client.callTool({
      name: "update_agent_model",
      arguments: {
        agentId: "personal:planner",
        fileRevision: `sha256:${"0".repeat(64)}`,
        model: "gpt-6.1-sol",
        modelReasoningEffort: "high",
        developerInstructions: secret,
      },
    });
    assert.equal(rejected.isError, true);
    assert.equal(JSON.stringify(rejected).includes(secret), false);
  } finally {
    await client.close();
    await fs.rm(isolatedRoot, { recursive: true, force: true });
  }
});
