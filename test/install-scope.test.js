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

test('a default run installs both targets at user level and writes nothing to the working directory', t => {
  const { project, home, run } = fixture(t)
  const result = run([])
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.equal(existsSync(join(home, '.config', 'opencode', 'opencode.jsonc')), true)
  assert.equal(existsSync(join(home, '.config', 'opencode', 'agents', 'orchestrator.md')), true)
  assert.equal(existsSync(join(home, '.config', 'opencode', 'my-workbench-solutions')), true)
  assert.equal(existsSync(join(home, '.claude', 'settings.json')), true)
  assert.equal(existsSync(join(home, '.claude', 'agents', 'orchestrator.md')), true)
  assert.equal(existsSync(join(home, '.claude', 'my-workbench-solutions')), true)
  assert.equal(existsSync(join(home, '.my-workbench.version')), true)
  assert.deepEqual(readdirSync(project), [], 'nothing is ever written to the current directory')
  assert.match(result.stdout, /installing OpenCode \+ Claude Code agent setup \(user-level\)/)
})

test('the retired Claude user-level flag fails through the unknown-option path', t => {
  const { project, home, run } = fixture(t)
  // Assembled from parts so this file carries no literal of the removed flag.
  const flag = '--' + 'user'
  const result = run([flag])
  assert.equal(result.status, 1)
  assert.match(result.stderr, new RegExp(`unknown argument: ${flag}`))
  assert.match(result.stderr, /Usage/)
  assert.deepEqual(readdirSync(project), [])
  assert.deepEqual(readdirSync(home), [])
})

test('--opencode and --claude each deploy only their own user-level destination', t => {
  const { project, home, run } = fixture(t)
  const oc = run(['--opencode'])
  assert.equal(oc.status, 0, oc.stderr + oc.stdout)
  assert.equal(existsSync(join(home, '.config', 'opencode', 'agents', 'orchestrator.md')), true)
  assert.equal(existsSync(join(home, '.claude')), false)
  const cl = run(['--claude'])
  assert.equal(cl.status, 0, cl.stderr + cl.stdout)
  assert.equal(existsSync(join(home, '.claude', 'agents', 'orchestrator.md')), true)
  assert.equal(existsSync(join(home, '.claude', 'settings.json')), true)
  assert.deepEqual(readdirSync(project), [])
})

test('positional target forms select the same user-level destinations', t => {
  for (const [args, deployed, absent] of [
    [['claude'], ['.claude', 'agents', 'orchestrator.md'], ['.config', 'opencode']],
    [['opencode'], ['.config', 'opencode', 'opencode.jsonc'], ['.claude']],
  ]) {
    const { project, home, run } = fixture(t)
    const result = run(args)
    assert.equal(result.status, 0, result.stderr + result.stdout)
    assert.equal(existsSync(join(home, ...deployed)), true)
    assert.equal(existsSync(join(home, ...absent)), false)
    assert.deepEqual(readdirSync(project), [])
  }
})

test('an existing project .claude/ tree is the user\'s own and is left untouched', t => {
  const { project, home, run } = fixture(t)
  const legacy = join(project, '.claude')
  mkdirSync(join(legacy, 'agents'), { recursive: true })
  writeFileSync(join(legacy, 'agents', 'mine.md'), 'user-owned\n')
  const result = run([])
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.deepEqual(readdirSync(project), ['.claude'])
  assert.deepEqual(readdirSync(join(legacy, 'agents')), ['mine.md'])
  assert.equal(readFileSync(join(legacy, 'agents', 'mine.md'), 'utf8'), 'user-owned\n')
  assert.equal(existsSync(join(home, '.claude', 'agents', 'orchestrator.md')), true)
})

test('a default dry-run from the source repository previews only user-level files without writing', t => {
  const { project, home, run } = fixture(t)
  const result = run(['--dry-run'], repo)
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /~\/\.config\/opencode\//)
  assert.match(result.stdout, /~\/\.claude\//)
  assert.match(result.stdout, /~\/\.my-workbench\.version/)
  assert.doesNotMatch(result.stdout, /nothing to copy/)
  assert.deepEqual(readdirSync(project), [])
  assert.deepEqual(readdirSync(home), [])
})
