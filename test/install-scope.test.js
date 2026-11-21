import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'my-workbench-scope-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  const home = join(root, 'home')
  mkdirSync(project)
  mkdirSync(home)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'opencode.cmd'), '@echo off\r\necho opencode 1.0.0\r\nexit /b 0\r\n')
  } else {
    writeFileSync(join(bin, 'opencode'), '#!/bin/sh\necho opencode 1.0.0\nexit 0\n')
    chmodSync(join(bin, 'opencode'), 0o755)
  }
  const run = (args, cwd = project) => spawnSync(process.execPath, [join(repo, 'bin', 'my-workbench.js'), ...args], {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home, PATH: bin },
    encoding: 'utf8',
  })
  return { project, home, run }
}

test('OpenCode installs only at user level with or without --user, preserving existing project files', t => {
  const { project, home, run } = fixture(t)
  const legacy = join(project, '.opencode')
  mkdirSync(legacy, { recursive: true })
  writeFileSync(join(legacy, 'opencode.jsonc'), 'user-owned config\n')
  for (const args of [['--opencode'], ['--user', 'opencode', '--force']]) {
    const result = run(args)
    assert.equal(result.status, 0, result.stderr + result.stdout)
    assert.equal(existsSync(join(home, '.config', 'opencode', 'agents', 'orchestrator.md')), true)
    assert.equal(existsSync(join(home, '.config', 'opencode', 'my-workbench-solutions')), true)
    assert.equal(existsSync(join(home, '.claude')), false)
    assert.equal(existsSync(join(home, '.my-workbench.version')), true)
    assert.deepEqual(readdirSync(project), ['.opencode'])
    assert.deepEqual(readdirSync(legacy), ['opencode.jsonc'])
    assert.equal(readFileSync(join(legacy, 'opencode.jsonc'), 'utf8'), 'user-owned config\n')
  }
})

test('default install uses both project and home realms; --user puts both targets at user level', t => {
  for (const user of [false, true]) {
    const { project, home, run } = fixture(t)
    const result = run(user ? ['--user'] : [])
    assert.equal(result.status, 0, result.stderr + result.stdout)
    assert.equal(existsSync(join(home, '.config', 'opencode', 'opencode.jsonc')), true)
    assert.equal(existsSync(join(home, '.my-workbench.version')), true)
    assert.equal(existsSync(join(project, '.opencode')), false)
    assert.equal(existsSync(join(project, 'my-workbench.version')), !user)
    assert.equal(existsSync(join(project, '.claude', 'agents', 'orchestrator.md')), !user)
    assert.equal(existsSync(join(home, '.claude', 'agents', 'orchestrator.md')), user)
  }
})

test('OpenCode dry-run from the source repository previews only user-level files without writing', t => {
  const { project, home, run } = fixture(t)
  const result = run(['--opencode', '--dry-run'], repo)
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /~\/\.config\/opencode\//)
  assert.match(result.stdout, /~\/\.my-workbench\.version/)
  assert.doesNotMatch(result.stdout, /nothing to copy/)
  assert.deepEqual(readdirSync(project), [])
  assert.deepEqual(readdirSync(home), [])
})
