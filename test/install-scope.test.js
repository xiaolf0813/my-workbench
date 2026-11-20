import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
  const run = args => spawnSync(process.execPath, [join(repo, 'bin', 'my-workbench.js'), ...args], {
    cwd: project,
    env: { ...process.env, HOME: home, USERPROFILE: home, PATH: '' },
    encoding: 'utf8',
  })
  return { project, home, run }
}

test('--user installs only Claude Code without requiring OpenCode or touching its existing global config', t => {
  const { project, home, run } = fixture(t)
  const legacy = join(home, '.config', 'opencode')
  mkdirSync(legacy, { recursive: true })
  writeFileSync(join(legacy, 'opencode.jsonc'), 'user-owned config\n')
  for (const args of [['--user'], ['--claude', '--user', '--force']]) {
    const result = run(args)
    assert.equal(result.status, 0, result.stderr + result.stdout)
    assert.equal(existsSync(join(home, '.claude', 'agents', 'orchestrator.md')), true)
    assert.equal(existsSync(join(home, '.my-workbench.version')), true)
    assert.deepEqual(readdirSync(project), [])
    assert.deepEqual(readdirSync(legacy), ['opencode.jsonc'])
    assert.equal(readFileSync(join(legacy, 'opencode.jsonc'), 'utf8'), 'user-owned config\n')
  }
})

test('explicit user-level OpenCode requests fail before prerequisites, writes, or upgrade registry access', t => {
  const { project, home, run } = fixture(t)
  for (const args of [
    ['--opencode', '--user'],
    ['--user', 'opencode', '--force'],
    ['--claude', '--opencode', '--user', '--dry-run'],
    ['--opencode', '--user', '--upgrade'],
  ]) {
    const result = run(args)
    assert.equal(result.status, 1, result.stderr + result.stdout)
    assert.match(result.stderr, /OpenCode only supports project-level installation/)
    assert.equal(result.stdout, '')
    assert.deepEqual(readdirSync(project), [])
    assert.deepEqual(readdirSync(home), [])
  }
})
