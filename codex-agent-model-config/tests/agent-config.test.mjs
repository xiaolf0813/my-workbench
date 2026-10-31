import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parseEditableToml, replaceModelFields } from "../dist/infrastructure/toml-editor.js";
import { modelCatalogFromRows } from "../dist/services/model-catalog-service.js";

test("parses multiline developer instructions", () => {
  const parsed = parseEditableToml('name = "planner"\ndeveloper_instructions = """\nline one\nline two\n"""\n');
  assert.equal(parsed.fields.get("developer_instructions"), "line one\nline two");
});

test("updates model fields while preserving layout and other values", async () => {
  const source = await fs.readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/codex-home/agents/planner.toml"),
    "utf8",
  );
  const updated = replaceModelFields(source, {
    model: "gpt-6-luna",
    model_reasoning_effort: "high",
    model_reasoning_summary: "auto",
    model_verbosity: "low",
  });
  const fields = parseEditableToml(updated).fields;
  assert.equal(fields.get("model"), "gpt-6-luna");
  assert.equal(fields.get("model_reasoning_effort"), "high");
  assert.equal(fields.get("model_reasoning_summary"), "auto");
  assert.equal(fields.get("model_verbosity"), "low");
  assert.equal(fields.get("name"), "planner");
  assert.equal(fields.get("developer_instructions"), "Create an implementation plan before coding.");
  assert.match(updated, /# preserve this comment/);
  assert.match(updated, /\[metadata\]/);
});

test("maps the Codex picker catalog and disallows custom slugs", () => {
  const catalog = modelCatalogFromRows([
    {
      id: "gpt-6.1-sol",
      model: "gpt-6.1-sol",
      displayName: "GPT-6.1-Sol",
      supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: "low" }],
    },
    {
      id: "zcode/GLM-5.3",
      model: "zcode/GLM-5.3",
      displayName: "GLM-5.3 · ZCode",
      supportedReasoningEfforts: [{ reasoningEffort: "max" }],
    },
    {
      id: "hidden",
      model: "hidden",
      hidden: true,
      supportedReasoningEfforts: [{ reasoningEffort: "high" }],
    },
  ]);
  assert.equal(catalog.allowCustomSlug, false);
  assert.ok(catalog.supportedReasoningEfforts.includes("high"));
  assert.deepEqual(
    catalog.models.map((model) => model.slug),
    ["gpt-6.1-sol", "zcode/GLM-5.3"],
  );
});
import { fileURLToPath } from "node:url";
