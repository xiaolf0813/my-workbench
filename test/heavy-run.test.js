import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../agents/solutions/heavy-run.mjs', import.meta.url));

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'workbench-heavy-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const root = join(cwd, 'heavy');
  const log = join(cwd, 'log.txt');
  const env = { ...process.env, MY_WORKBENCH_HEAVY_POLL_MS: '25' };
  const run = (args) => new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { cwd, env }, (error, stdout, stderr) => {
      resolve({ status: error ? error.code : 0, stdout, stderr });
    });
  });
  const start = (args) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env, stdio: 'ignore' });
    return { pid: child.pid, done: new Promise((resolve) => child.on('exit', (code) => resolve(code))) };
  };
  // The wrapped child appends "<label>:start", sleeps, appends "<label>:end",
  // then exits with <code> — the log proves exclusive execution intervals.
  const words = (label, ms, code = 0) => [process.execPath, '-e',
    `const fs=require("fs");fs.appendFileSync(${JSON.stringify(log)},${JSON.stringify(`${label}:start\n`)});` +
    `setTimeout(()=>{fs.appendFileSync(${JSON.stringify(log)},${JSON.stringify(`${label}:end\n`)});process.exit(${code})},${ms})`];
  const runChild = (label, ms, code = 0, wait = '5') => run(['run', '--root', root, '--wait', wait, '--', ...words(label, ms, code)]);
  const startChild = (label, ms) => start(['run', '--root', root, '--wait', '30', '--', ...words(label, ms)]);
  const lines = () => (existsSync(log) ? readFileSync(log, 'utf8') : '').split('\n').filter(Boolean);
  const waitFor = async (path) => {
    for (const deadline = Date.now() + 5000; !existsSync(path);) {
      if (Date.now() > deadline) throw Error(`timeout waiting for ${path}`);
      await delay(10);
    }
  };
  const waitForTickets = async (count) => {
    const queueDir = join(root, 'queue');
    for (const deadline = Date.now() + 5000; (existsSync(queueDir) ? readdirSync(queueDir).length : 0) < count;) {
      if (Date.now() > deadline) throw Error(`timeout waiting for ${count} queue ticket(s)`);
      await delay(10);
    }
  };
  const lockDir = join(root, 'lock');
  const holderFile = join(lockDir, 'holder.json');
  return { cwd, root, run, start, runChild, startChild, lines, waitFor, waitForTickets, lockDir, holderFile };
}

function deadPid() {
  // A pid that has exited by the time it is read back.
  return spawnSync(process.execPath, ['-e', '']).pid;
}

function forgeLock(root, holder) {
  mkdirSync(join(root, 'lock'), { recursive: true });
  writeFileSync(join(root, 'lock', 'holder.json'), `${JSON.stringify(holder)}\n`);
}

test('concurrent runs serialize, the lock releases, and exit codes pass through', async t => {
  const { root, run, runChild, startChild, lines, waitFor, lockDir, holderFile } = fixture(t);
  const first = startChild('A', 400);
  await waitFor(holderFile);
  const second = runChild('B', 200, 7);
  assert.equal(await first.done, 0);
  assert.equal((await second).status, 7);
  assert.deepEqual(lines(), ['A:start', 'A:end', 'B:start', 'B:end']);
  assert.equal(existsSync(lockDir), false);
  const after = JSON.parse((await run(['status', '--root', root])).stdout);
  assert.equal(after.holder, null);
  assert.deepEqual(after.queue, []);
});

test('waiters acquire in ticket order and status reports holder and queue', async t => {
  const { root, run, runChild, startChild, lines, waitFor, waitForTickets, holderFile } = fixture(t);
  const holder = startChild('A', 600);
  await waitFor(holderFile);
  const waiters = [];
  for (const label of ['B', 'C', 'D']) {
    waiters.push(runChild(label, 150));
    // Let this waiter's ticket land, then let the clock tick past the current
    // millisecond so ticket filename order matches spawn order.
    await waitForTickets(waiters.length);
    await delay(50);
  }
  const snapshot = JSON.parse((await run(['status', '--root', root])).stdout);
  assert.equal(snapshot.holder.pid, holder.pid);
  assert.match(snapshot.holder.command, /A:start/);
  assert.equal(snapshot.queue.length, 3);
  assert.match(snapshot.queue.map(entry => entry.command).join(' -> '), /B:start.*C:start.*D:start/);
  assert.deepEqual((await Promise.all(waiters)).map(result => result.status), [0, 0, 0]);
  assert.equal(await holder.done, 0);
  assert.deepEqual(lines(), ['A:start', 'A:end', 'B:start', 'B:end', 'C:start', 'C:end', 'D:start', 'D:end']);
});

test('a lock whose wrapper and child are both dead is taken over by the next waiter', async t => {
  const { root, runChild, lines, lockDir } = fixture(t);
  forgeLock(root, { pid: deadPid(), childPid: deadPid(), command: 'gone', cwd: '.', startedAt: new Date().toISOString() });
  const result = await runChild('S', 100);
  assert.equal(result.status, 0);
  assert.match(result.stderr, /stale lock/);
  assert.deepEqual(lines(), ['S:start', 'S:end']);
  assert.equal(existsSync(lockDir), false);
});

test('a lock whose child still runs is never stolen and --wait 0 gives up with 124', async t => {
  const { root, runChild, lines, lockDir } = fixture(t);
  const orphan = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { stdio: 'ignore', detached: true });
  orphan.unref();
  t.after(() => { try { process.kill(orphan.pid); } catch { /* already gone */ } });
  forgeLock(root, { pid: deadPid(), childPid: orphan.pid, command: 'building', cwd: '.', startedAt: new Date().toISOString() });
  const result = await runChild('S', 100, 0, '0');
  assert.equal(result.status, 124);
  assert.match(result.stderr, /gave up/);
  assert.deepEqual(lines(), []);
  assert.equal(existsSync(lockDir), true, 'the live-child lock is left in place');
});

test('a dead waiter ticket is pruned so later waiters proceed', async t => {
  const { root, start, runChild, startChild, lines, waitFor, waitForTickets } = fixture(t);
  const holder = startChild('A', 900);
  await waitFor(join(root, 'lock', 'holder.json'));
  const ghost = start(['run', '--root', root, '--wait', '30', '--', 'unused']);
  await waitForTickets(1);
  process.kill(ghost.pid); // leaves its ticket behind, unpruned
  const survivor = await runChild('B', 100);
  assert.equal(survivor.status, 0);
  assert.equal(await holder.done, 0);
  assert.deepEqual(lines(), ['A:start', 'A:end', 'B:start', 'B:end']);
});

test('argument errors fail fast with a message', async t => {
  const { root, run } = fixture(t);
  const cases = [
    [['frob'], /run\|status/],
    [['run', '--root', root], /Expected a command after --/],
    [['run', '--root', root, '--wait', '-1', '--', 'x'], /non-negative/],
    [['run', '--root', root, '--wait', 'abc', '--', 'x'], /non-negative/],
    [['run', '--root', root, '--fast', '--', 'x'], /Unknown option/],
  ];
  for (const [args, message] of cases) {
    const result = await run(args);
    assert.equal(result.status, 1, JSON.stringify(result));
    assert.match(result.stderr, message);
  }
});
