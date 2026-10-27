import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'my-workbench-preserve-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A fake `opencode` launcher first on PATH, so the install's prerequisite gate
 *  is deterministic on any machine. */
function opencodePath(t) {
  const bin = join(fixture(t), 'bin')
  mkdirSync(bin)
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'opencode.cmd'), '@echo off\r\necho opencode 1.0.0\r\nexit /b 0\r\n')
  } else {
    writeFileSync(join(bin, 'opencode'), '#!/bin/sh\necho opencode 1.0.0\nexit 0\n')
    chmodSync(join(bin, 'opencode'), 0o755)
  }
  return bin + delimiter + (process.env.PATH ?? '')
}

/** A project sandbox plus a `run` helper spawning the CLI inside it. HOME points at a
 *  sandbox home so a stray user-level write could never touch the real one. */
function projectFixture(t) {
  const dir = fixture(t)
  const project = join(dir, 'project')
  const home = join(dir, 'home')
  mkdirSync(project)
  mkdirSync(home)
  const path = opencodePath(t)
  const run = args =>
    spawnSync(process.execPath, [join(repo, 'bin', 'my-workbench.js'), ...args], {
      cwd: project,
      env: { ...process.env, HOME: home, USERPROFILE: home, PATH: path },
      encoding: 'utf8',
    })
  const file = (...rel) => join(project, ...rel)
  const homeFile = (...rel) => join(home, ...rel)
  return { project, home, run, file, homeFile }
}

test('a --force reinstall preserves the agents frontmatter and reconciles the JSON stubs\' own keys', t => {
  const { run, file } = projectFixture(t)
  const first = run([])
  assert.equal(first.status, 0, first.stderr + first.stdout)
  // A fresh create preserves nothing: the installed files ARE the renders/stubs.
  const oracle = file('.claude', 'agents', 'oracle.md')
  assert.match(readFileSync(oracle, 'utf8'), /^model: inherit$/m)

  // The user retunes one destination per rule:
  // - the claude agent's `model:` line (with the description mangled, to prove
  //   every non-model byte refreshes from the render) plus an `effort:` line
  //   the render lacks — frontmatter preservation, replace + insert;
  // - settings.json, a seed stub whose only owned key is `agent`: user-realistic
  //   content (schema, model, effortLevel, env with a token-like value, hooks)
  //   with the agent value MODIFIED — the stub resets just that value;
  // - opencode.jsonc, a seed stub whose only owned key is `$schema`: user
  //   comments and model keys with the $schema key DELETED — the stub
  //   re-inserts it whole;
  // - the opencode observer agent, whose render carries neither `model:` nor
  //   `variant:`, gaining both lines.
  writeFileSync(oracle, readFileSync(oracle, 'utf8')
    .replace('model: inherit', 'model: custom/pinned-claude\neffort: high')
    .replace('Strategic technical advisor', 'MANGLED description'))
  writeFileSync(file('.claude', 'settings.json'), `{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "agent": "user-pinned-orchestrator",
  "model": "sonnet",
  "effortLevel": "high",
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "sk-user-example-token",
    "MAX_THINKING_TOKENS": "32000"
  },
  "hooks": {
    "PostToolUse": [
      { "matcher": "Write", "hooks": [ { "type": "command", "command": "echo user-hook" } ] }
    ]
  }
}
`)
  writeFileSync(file('.opencode', 'opencode.jsonc'),
    '{\n  // tuned by hand\n  "model": [\n    "custom/pinned-oc" // main pin\n  ],\n  "small_model": "custom/small-pin"\n}\n')
  const observer = file('.opencode', 'agents', 'observer.md')
  writeFileSync(observer, readFileSync(observer, 'utf8')
    .replace('mode: subagent', 'mode: subagent\nmodel: custom/observer-pin$high\nvariant: max'))

  const forced = run(['--force'])
  assert.equal(forced.status, 0, forced.stderr + forced.stdout)
  assert.match(forced.stdout, /overwrite\s+.*oracle\.md/, 'per-file action lines stay as they are')

  // The agent's pinned line survived (replace); the render has no effort line,
  // so the saved one was inserted as the block's new last line — and the
  // mangled description did not survive.
  const afterOracle = readFileSync(oracle, 'utf8')
  assert.match(afterOracle, /^model: custom\/pinned-claude$/m)
  assert.match(afterOracle, /^effort: high\n---/m)
  assert.match(afterOracle, /Strategic technical advisor/)
  assert.doesNotMatch(afterOracle, /MANGLED/)

  // settings.json: ONLY the owned agent key was reset to canonical — every
  // other user byte (schema, model, effortLevel, env token, hooks) survived.
  assert.equal(
    readFileSync(file('.claude', 'settings.json'), 'utf8'),
    `{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "agent": "orchestrator",
  "model": "sonnet",
  "effortLevel": "high",
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "sk-user-example-token",
    "MAX_THINKING_TOKENS": "32000"
  },
  "hooks": {
    "PostToolUse": [
      { "matcher": "Write", "hooks": [ { "type": "command", "command": "echo user-hook" } ] }
    ]
  }
}
`,
  )
  // opencode.jsonc: the deleted $schema came back whole before the closing
  // brace; the comment and the user's own model keys survived verbatim.
  assert.equal(
    readFileSync(file('.opencode', 'opencode.jsonc'), 'utf8'),
    '{\n  // tuned by hand\n  "model": [\n    "custom/pinned-oc" // main pin\n  ],\n  "small_model": "custom/small-pin",\n  "$schema": "https://opencode.ai/config.json"\n}\n',
  )
  // The observer's saved lines were both inserted, in saved order.
  const afterObserver = readFileSync(observer, 'utf8')
  assert.match(afterObserver, /bash: false\nmodel: custom\/observer-pin\$high\nvariant: max\n---/)
  assert.match(afterObserver, /Visual analysis specialist/, 'the rest of the file is the fresh render')
})

test('an added model: line survives --force even when the render carries none (insertion)', t => {
  const { run, file, homeFile } = projectFixture(t)
  assert.equal(run([]).status, 0)
  const observer = file('.opencode', 'agents', 'observer.md')
  const installed = readFileSync(observer, 'utf8')
  assert.doesNotMatch(installed, /^model:/m, 'the opencode observer render carries no model line')

  // The user adds a pin the render lacks: the saved line must be inserted as the LAST
  // line of the frontmatter block, immediately before the closing fence.
  writeFileSync(observer, installed.replace('mode: subagent', 'mode: subagent\nmodel: custom/observer-pin$high'))
  assert.equal(run(['--force']).status, 0)
  const after = readFileSync(observer, 'utf8')
  assert.match(after, /bash: false\nmodel: custom\/observer-pin\$high\n---/)
  assert.match(after, /Visual analysis specialist/, 'the rest of the file is the fresh render')

  // The zcode backend's second key rides the same rule at its user-level
  // destination: the render carries neither a changed model nor a
  // thoughtLevel, so both saved lines take the insert path.
  assert.equal(run(['--zcode']).status, 0)
  const zOracle = homeFile('.zcode', 'agents', 'oracle.md')
  writeFileSync(zOracle, readFileSync(zOracle, 'utf8')
    .replace('model: inherit', 'model: custom/zcode-pin\nthoughtLevel: max'))
  assert.equal(run(['--zcode', '--force']).status, 0)
  const afterZ = readFileSync(zOracle, 'utf8')
  assert.match(afterZ, /^model: custom\/zcode-pin$/m)
  assert.match(afterZ, /^thoughtLevel: max\n---/m)
})

test('a rerun without --force leaves edited files untouched (skip)', t => {
  const { run, file } = projectFixture(t)
  assert.equal(run([]).status, 0)
  const oracle = file('.claude', 'agents', 'oracle.md')
  const edited = readFileSync(oracle, 'utf8').replace('model: inherit', 'model: custom/pinned-claude') + '\nHAND-EDIT\n'
  writeFileSync(oracle, edited)
  const rerun = run([])
  assert.equal(rerun.status, 0, rerun.stderr + rerun.stdout)
  assert.match(rerun.stdout, /skip\s+.*oracle\.md/)
  assert.equal(readFileSync(oracle, 'utf8'), edited, 'a skipped file is never rewritten — or preserved into')
})

test('--force twice in a row is idempotent', t => {
  const { run, file } = projectFixture(t)
  assert.equal(run([]).status, 0)
  // Retuned values on disk, then two force overwrites: the second reconcile
  // sees the first's output, so the two trees must be byte-identical.
  const oracle = file('.claude', 'agents', 'oracle.md')
  writeFileSync(oracle, readFileSync(oracle, 'utf8').replace('model: inherit', 'model: custom/pinned-claude\neffort: high'))
  writeFileSync(file('.claude', 'settings.json'), '{\n  "agent": "user-pinned",\n  "model": "sonnet"\n}\n')
  writeFileSync(file('.opencode', 'opencode.jsonc'), '{\n  // mine\n  "model": "custom/pinned-oc"\n}\n')
  const targets = [
    file('.claude', 'agents', 'oracle.md'),
    file('.claude', 'settings.json'),
    file('.opencode', 'opencode.jsonc'),
  ]
  assert.equal(run(['--force']).status, 0)
  const once = targets.map(target => readFileSync(target, 'utf8'))
  assert.equal(run(['--force']).status, 0)
  for (const [index, target] of targets.entries()) {
    assert.equal(readFileSync(target, 'utf8'), once[index], `${target} is byte-identical after the second --force`)
  }
})

test('a malformed JSON stub file is left completely untouched by --force, then reconciled once valid', t => {
  const { run, file } = projectFixture(t)
  assert.equal(run([]).status, 0)
  // User content that does not parse: never overwritten with the stub.
  const settings = file('.claude', 'settings.json')
  const jsonc = file('.opencode', 'opencode.jsonc')
  writeFileSync(settings, '{ "agent": broken')
  writeFileSync(jsonc, 'TAMPERED BY HAND\n')
  assert.equal(run(['--force']).status, 0)
  assert.equal(readFileSync(settings, 'utf8'), '{ "agent": broken')
  assert.equal(readFileSync(jsonc, 'utf8'), 'TAMPERED BY HAND\n')

  // The untouched file is not permanently exempt: once the user's content is
  // valid again, the next --force reconciles the owned key into it.
  writeFileSync(settings, '{\n  // fixed by hand\n  "hooks": { "PostToolUse": [] }\n}\n')
  assert.equal(run(['--force']).status, 0)
  assert.equal(
    readFileSync(settings, 'utf8'),
    '{\n  // fixed by hand\n  "hooks": { "PostToolUse": [] },\n  "agent": "orchestrator"\n}\n',
  )
})
