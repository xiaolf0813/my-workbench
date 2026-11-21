import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../agents/solutions/cleanup-artifacts.mjs', import.meta.url));
const KB = 1024;

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'workbench-cleanup-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const root = join(cwd, 'artifacts');
  function run(args, env) {
    return new Promise((resolve, reject) => {
      execFile(process.execPath, [script, ...args], { cwd, env: env ? { ...process.env, ...env } : undefined }, (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolve(JSON.parse(stdout));
      });
    });
  }
  function unit(name, size) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'capture.bin'), Buffer.alloc(size));
    return dir;
  }
  const touch = (path, seconds) => utimesSync(path, seconds, seconds);
  const deliver = (...dirs) => dirs.forEach(dir => writeFileSync(join(dir, '.delivered'), ''));
  const base = path => path.split(/[\\/]/).pop();
  return { cwd, root, run, unit, touch, deliver, base };
}

test('under the cap nothing is deleted and the target is met', async t => {
  const { root, run, unit, touch, deliver } = fixture(t);
  const kept = unit('run-a', 4 * KB);
  touch(join(kept, 'capture.bin'), 1e9);
  deliver(kept);
  const report = await run(['--root', root, '--max-mb', '2']);
  assert.deepEqual(report.deleted, []);
  assert.equal(report.targetMet, true);
  assert.equal(report.beforeBytes, 4 * KB);
  assert.equal(report.afterBytes, 4 * KB);
  assert.ok(existsSync(kept));
});

test('over the cap eviction is oldest-first and stops once the target is met', async t => {
  const { root, run, unit, touch, deliver, base } = fixture(t);
  const oldest = unit('run-a', 800 * KB);
  const middle = unit('run-b', 800 * KB);
  const newest = unit('run-c', 800 * KB);
  touch(join(oldest, 'capture.bin'), 1e9);
  touch(join(middle, 'capture.bin'), 1.1e9);
  touch(join(newest, 'capture.bin'), 1.2e9);
  deliver(oldest, middle, newest);
  const report = await run(['--root', root, '--max-mb', '2']);
  assert.deepEqual(report.deleted.map(entry => base(entry.path)), ['run-a']);
  assert.deepEqual(report.deleted.map(entry => entry.bytes), [800 * KB]);
  assert.equal(report.beforeBytes, 2400 * KB);
  assert.equal(report.afterBytes, 1600 * KB);
  assert.equal(report.targetMet, true);
  assert.ok(!existsSync(oldest));
  assert.ok(existsSync(middle));
  assert.ok(existsSync(newest));
});

test('an excluded unit survives and younger units pay for it', async t => {
  const { root, run, unit, touch, deliver, base } = fixture(t);
  const oldest = unit('run-a', 800 * KB);
  const middle = unit('run-b', 800 * KB);
  const newest = unit('run-c', 800 * KB);
  touch(join(oldest, 'capture.bin'), 1e9);
  touch(join(middle, 'capture.bin'), 1.1e9);
  touch(join(newest, 'capture.bin'), 1.2e9);
  deliver(oldest, middle, newest);
  const report = await run(['--root', root, '--max-mb', '2', '--exclude', oldest]);
  assert.deepEqual(report.deleted.map(entry => base(entry.path)), ['run-b']);
  assert.equal(report.afterBytes, 1600 * KB);
  assert.equal(report.targetMet, true);
  assert.ok(existsSync(oldest));
  assert.ok(!existsSync(middle));
  assert.ok(existsSync(newest));
});

test('a store over the cap whose only unit is excluded deletes nothing and still exits zero', async t => {
  const { root, run, unit, touch, deliver } = fixture(t);
  const only = unit('run-solo', 1100 * KB);
  touch(join(only, 'capture.bin'), 1e9);
  deliver(only);
  const report = await run(['--root', root, '--max-mb', '1', '--exclude', only]);
  assert.deepEqual(report.deleted, []);
  assert.equal(report.targetMet, false);
  assert.ok(existsSync(only));
});

test('dry-run projects the deletions without touching the files', async t => {
  const { root, run, unit, touch, deliver, base } = fixture(t);
  const oldest = unit('run-a', 800 * KB);
  const middle = unit('run-b', 800 * KB);
  const newest = unit('run-c', 800 * KB);
  touch(join(oldest, 'capture.bin'), 1e9);
  touch(join(middle, 'capture.bin'), 1.1e9);
  touch(join(newest, 'capture.bin'), 1.2e9);
  deliver(oldest, middle, newest);
  const report = await run(['--root', root, '--max-mb', '2', '--dry-run']);
  assert.equal(report.dryRun, true);
  assert.deepEqual(report.deleted.map(entry => base(entry.path)), ['run-a']);
  assert.equal(report.afterBytes, 1600 * KB);
  assert.equal(report.targetMet, true);
  assert.ok(existsSync(oldest));
  assert.ok(existsSync(middle));
  assert.ok(existsSync(newest));
});

test('the safety gate refuses the home directory and plain files', async t => {
  const { cwd, run } = fixture(t);
  const plain = join(cwd, 'plain.txt');
  writeFileSync(plain, 'x');
  for (const blocked of [homedir(), '~', plain]) {
    await assert.rejects(run(['--root', blocked, '--dry-run']), error => {
      assert.notEqual(error.code, 0);
      assert.ok(String(error.stderr).length > 0);
      return true;
    });
  }
  assert.ok(existsSync(plain));
});

test('a stray file is its own unit and directory symlinks are never followed', async t => {
  const { cwd, root, run, unit, touch, deliver, base } = fixture(t);
  mkdirSync(root, { recursive: true });
  const stray = join(root, 'run-stray.bin');
  writeFileSync(stray, Buffer.alloc(800 * KB));
  touch(stray, 1e9);
  const kept = unit('run-z', 400 * KB);
  touch(kept, 1.2e9);
  deliver(kept);
  // Only delivered run directories are evictable; the unmarkable stray file stays pending.
  const report = await run(['--root', root, '--max-mb', '1']);
  assert.deepEqual(report.deleted.map(entry => base(entry.path)), ['run-z']);
  assert.equal(report.afterBytes, 800 * KB);
  assert.ok(existsSync(stray));

  const store = join(cwd, 'artifacts-linked');
  mkdirSync(store, { recursive: true });
  const outside = join(cwd, 'outside');
  mkdirSync(outside, { recursive: true });
  const payload = join(outside, 'payload.bin');
  writeFileSync(payload, Buffer.alloc(800 * KB));
  touch(payload, 1e9);
  const small = join(store, 'run-small');
  mkdirSync(small, { recursive: true });
  const capture = join(small, 'capture.bin');
  writeFileSync(capture, Buffer.alloc(100 * KB));
  touch(capture, 1.1e9);
  let link = null;
  try {
    const candidate = join(store, 'run-linked');
    symlinkSync(outside, candidate, 'junction');
    link = candidate;
  } catch {
    // Symlink creation is not available on every platform or account; skip that half.
  }
  const linked = await run(['--root', store, '--max-mb', '1']);
  assert.equal(linked.beforeBytes, 100 * KB);
  assert.deepEqual(linked.deleted, []);
  if (link) {
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.ok(existsSync(payload));
  }
});

test('the report carries every documented field', async t => {
  const { root, run, unit, touch, deliver } = fixture(t);
  const only = unit('run-a', 4 * KB);
  touch(join(only, 'capture.bin'), 1e9);
  deliver(only);
  const report = await run(['--root', root, '--max-mb', '2']);
  assert.deepEqual(Object.keys(report).sort(),
    ['afterBytes', 'beforeBytes', 'claimedBytes', 'deleted', 'dryRun', 'failures', 'maxBytes', 'pendingBytes', 'root', 'targetMet']);
  assert.equal(report.root, realpathSync(root));
  assert.equal(report.maxBytes, 2 * 1024 * 1024);
  assert.equal(report.pendingBytes, 0);
  assert.equal(report.dryRun, false);
  assert.equal(report.targetMet, true);
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.deleted, []);
});

test('an over-cap store evicts delivered units and keeps the unmarkable junction', async t => {
  const { cwd, run, touch, base } = fixture(t);
  const store = join(cwd, 'artifacts-linked');
  mkdirSync(store, { recursive: true });
  const outside = join(cwd, 'outside');
  mkdirSync(outside, { recursive: true });
  const payload = join(outside, 'payload.bin');
  writeFileSync(payload, Buffer.alloc(800 * KB));
  const stamp = seconds => Math.floor(Date.now() / 1000) + seconds;
  let link = null;
  try {
    const candidate = join(store, 'run-linked');
    symlinkSync(outside, candidate, 'junction');
    link = candidate;
  } catch {
    // Symlink creation is not available on every platform or account; run without it.
  }
  for (const [name, size, seconds] of [['run-a', 800, stamp(1000)], ['run-b', 400, stamp(2000)]]) {
    mkdirSync(join(store, name), { recursive: true });
    const file = join(store, name, 'capture.bin');
    writeFileSync(file, Buffer.alloc(size * KB));
    touch(file, seconds);
    writeFileSync(join(store, name, '.delivered'), '');
  }
  // The junction counts 0 bytes and, being unmarkable, stays pending; only the delivered real units add up.
  const report = await run(['--root', store, '--max-mb', '1']);
  assert.equal(report.beforeBytes, 1200 * KB);
  assert.equal(report.afterBytes, 400 * KB);
  assert.ok(existsSync(payload));
  assert.ok(existsSync(join(store, 'run-b')));
  assert.deepEqual(report.deleted.map(entry => base(entry.path)), ['run-a']);
  if (link) assert.ok(existsSync(link));
});

test('exclusion matches across path forms', async t => {
  const { cwd, run, touch, base } = fixture(t);
  const stamp = seconds => Math.floor(Date.now() / 1000) + seconds;
  const scenario = () => {
    const store = join(cwd, `store-${Math.random().toString(36).slice(2)}`);
    for (const [name, size, seconds] of [['run-a', 800, stamp(1000)], ['run-b', 800, stamp(2000)], ['run-c', 800, stamp(3000)]]) {
      mkdirSync(join(store, name), { recursive: true });
      const file = join(store, name, 'capture.bin');
      writeFileSync(file, Buffer.alloc(size * KB));
      touch(file, seconds);
      writeFileSync(join(store, name, '.delivered'), '');
    }
    return store;
  };
  const forms = [store => store + sep, store => store.split(sep).join('/') + '/'];
  if (process.platform === 'win32') forms.push(store => store.toUpperCase());
  for (const form of forms) {
    const store = scenario();
    const report = await run(['--root', store, '--max-mb', '1', '--exclude', form(join(store, 'run-a'))]);
    assert.ok(existsSync(join(store, 'run-a')));
    assert.deepEqual(report.deleted.map(entry => base(entry.path)), ['run-b', 'run-c']);
  }
});

test('usage errors exit nonzero with a message', async t => {
  const { root, run } = fixture(t);
  for (const args of [['--nope'], ['--max-mb', 'abc'], ['--max-mb']]) {
    await assert.rejects(run(['--root', root, ...args]), error => {
      assert.equal(error.code, 1);
      assert.ok(String(error.stderr).length > 0);
      return true;
    });
  }
});

test('undelivered runs survive any age and delivered ones reclaim by LRU', async t => {
  const { cwd, run, touch, base } = fixture(t);
  const build = prefix => {
    const store = join(cwd, `store-${Math.random().toString(36).slice(2)}`);
    const now = Math.floor(Date.now() / 1000);
    for (const [unit, seconds] of [[`${prefix}-before`, now - 15 * 24 * 3600], [`${prefix}-after`, now]]) {
      mkdirSync(join(store, unit), { recursive: true });
      const file = join(store, unit, 'capture.mp4');
      writeFileSync(file, Buffer.alloc(800 * KB));
      touch(file, seconds);
    }
    return store;
  };
  // Pending evidence has no age limit: a 15-day old, unmarked run is still protected.
  const store = build('serial');
  const report = await run(['--root', store, '--max-mb', '1', '--exclude', join(store, 'serial-after')]);
  assert.deepEqual(report.deleted, []);
  assert.equal(report.targetMet, false);
  assert.equal(report.pendingBytes, 1600 * KB);
  assert.ok(existsSync(join(store, 'serial-before')));
  assert.ok(existsSync(join(store, 'serial-after')));
  // Once the orchestrator has shown the artifacts, marking delivered makes the run evictable.
  const marked = await run(['--root', store, '--mark-delivered', join(store, 'serial-before')]);
  assert.equal(marked.marked.toLowerCase(), join(store, 'serial-before').toLowerCase());
  const afterMark = await run(['--root', store, '--max-mb', '1', '--exclude', join(store, 'serial-after')]);
  assert.deepEqual(afterMark.deleted.map(entry => base(entry.path)), ['serial-before']);
  assert.equal(afterMark.deleted[0].bytes, 800 * KB); // the marker itself counts nothing
  assert.ok(existsSync(join(store, 'serial-after')));
  assert.equal(afterMark.targetMet, true);
  // A delivered run has no time protection: a fresh one over budget is still reclaimed.
  const raw = build('fresh');
  await run(['--root', raw, '--mark-delivered', join(raw, 'fresh-before')]);
  await run(['--root', raw, '--mark-delivered', join(raw, 'fresh-after')]);
  const reclaimed = await run(['--root', raw, '--max-mb', '1']);
  assert.deepEqual(reclaimed.deleted.map(entry => base(entry.path)), ['fresh-before']);
  assert.equal(reclaimed.pendingBytes, 0);
});

test('empty option values are rejected instead of resolving to the working directory', async t => {
  const { cwd, root, run } = fixture(t);
  const workspace = join(cwd, 'workspace.txt');
  writeFileSync(workspace, 'keep');
  for (const args of [['--root', ''], ['--exclude', ''], ['--max-mb', '']]) {
    await assert.rejects(run([...args, '--root', root, '--dry-run']), error => {
      assert.notEqual(error.code, 0);
      assert.ok(String(error.stderr).length > 0);
      return true;
    });
  }
  assert.ok(existsSync(workspace));
});

test('omitting --root uses the fixed store under the user home', async t => {
  const { cwd, run } = fixture(t);
  const home = join(cwd, 'isolated-home');
  const report = await run(['--max-mb', '2'], { USERPROFILE: home, HOME: home });
  const expected = join(home, '.my-workbench', 'artifacts');
  assert.ok(existsSync(expected));
  assert.equal(report.root.toLowerCase(), realpathSync(expected).toLowerCase());
  assert.equal(report.beforeBytes, 0);
});

test('recency follows the latest of modified and accessed time', async t => {
  const { root, run, unit, deliver, base } = fixture(t);
  const readLater = unit('run-a', 800 * KB);
  const older = unit('run-b', 800 * KB);
  utimesSync(join(readLater, 'capture.bin'), 1.7e9, 1.5e9); // accessed long after it was written
  utimesSync(join(older, 'capture.bin'), 1.6e9, 1.6e9);
  deliver(readLater, older);
  const report = await run(['--root', root, '--max-mb', '1']);
  assert.deepEqual(report.deleted.map(entry => base(entry.path)), ['run-b']);
  assert.ok(existsSync(readLater));
});

test('a unit that cannot be measured is kept and the target is not claimed met', async t => {
  const { cwd, root, run, unit, touch, deliver } = fixture(t);
  const preload = join(cwd, 'inject-eacces.cjs');
  writeFileSync(preload, `
    const fs = require('node:fs');
    const orig = fs.readdirSync;
    fs.readdirSync = (path, options) => {
      if (String(path).includes('run-locked')) {
        const error = new Error('injected EACCES');
        error.code = 'EACCES';
        throw error;
      }
      return orig(path, options);
    };
  `);
  const locked = unit('run-locked', 800 * KB);
  const healthy = unit('run-healthy', 800 * KB);
  touch(join(locked, 'capture.bin'), 1e9);
  touch(join(healthy, 'capture.bin'), 1.1e9);
  deliver(healthy);
  const report = await run(['--root', root, '--max-mb', '1'], { NODE_OPTIONS: `--require "${preload.replaceAll('\\', '/')}"` });
  assert.deepEqual(report.deleted, []);
  assert.equal(report.failures.length, 1);
  assert.ok(report.failures[0].path.includes('run-locked'));
  assert.ok(existsSync(locked));
  assert.ok(existsSync(healthy));
  assert.equal(report.targetMet, false);
});

test('mark-delivered accepts only real run directories of the store', async t => {
  const { cwd, root, run, unit } = fixture(t);
  const outside = join(cwd, 'outside-project');
  mkdirSync(outside, { recursive: true });
  const good = unit('run-a', 4 * KB);
  const nested = join(good, 'nested');
  mkdirSync(nested);
  for (const target of [root, outside, nested, join(root, 'missing'), cwd]) {
    await assert.rejects(run(['--root', root, '--mark-delivered', target]), error => {
      assert.equal(error.code, 1);
      assert.ok(String(error.stderr).length > 0);
      return true;
    });
  }
  assert.ok(!existsSync(join(good, '.delivered')));
  assert.ok(!existsSync(join(nested, '.delivered')));
  const first = await run(['--root', root, '--mark-delivered', good]);
  assert.equal(first.marked.toLowerCase(), good.toLowerCase());
  assert.ok(existsSync(join(good, '.delivered')));
  const again = await run(['--root', root, '--mark-delivered', good]);
  assert.equal(again.already, true);
});

test('mark-delivered with dry-run previews without writing', async t => {
  const { root, run, unit } = fixture(t);
  const good = unit('run-a', 4 * KB);
  const preview = await run(['--root', root, '--mark-delivered', good, '--dry-run']);
  assert.equal(preview.dryRun, true);
  assert.ok(!existsSync(join(good, '.delivered')));
  const real = await run(['--root', root, '--mark-delivered', good]);
  assert.ok(existsSync(join(good, '.delivered')));
});

test('mark-delivered rejects a link submitted in place of a run directory', async t => {
  const { root, run, unit } = fixture(t);
  const a = unit('run-a', 4 * KB);
  const b = unit('run-b', 4 * KB);
  let link = null;
  try {
    const candidate = join(root, 'run-link');
    symlinkSync(b, candidate, 'junction');
    link = candidate;
  } catch {
    // Symlink creation is not available on every platform or account; run without it.
  }
  if (link) {
    await assert.rejects(run(['--root', root, '--mark-delivered', link]), error => {
      assert.equal(error.code, 1);
      assert.ok(String(error.stderr).length > 0);
      return true;
    });
    assert.ok(!existsSync(join(a, '.delivered')));
    assert.ok(!existsSync(join(b, '.delivered')));
  }
  const ok = await run(['--root', root, '--mark-delivered', b]);
  assert.ok(existsSync(join(b, '.delivered')));
});

test('a dry-run over a missing store reports empty and creates nothing', async t => {
  const { cwd, run } = fixture(t);
  const missing = join(cwd, 'not-there-yet');
  const report = await run(['--root', missing, '--max-mb', '2', '--dry-run']);
  assert.equal(report.beforeBytes, 0);
  assert.equal(report.afterBytes, 0);
  assert.deepEqual(report.deleted, []);
  assert.equal(report.claimedBytes, 0);
  assert.equal(report.targetMet, true);
  assert.ok(!existsSync(missing));
});

test('a release rehearsal over a missing store creates nothing', async t => {
  const { cwd, run } = fixture(t);
  const missing = join(cwd, 'not-there-yet');
  const report = await run(['--root', missing, '--done-presenting', 'unused-token', '--dry-run']);
  assert.deepEqual(report.released, []);
  assert.equal(report.dryRun, true);
  assert.ok(!existsSync(missing));
});

test('a presentation pass spares every run being shown, delivered or not', async t => {
  const { root, run, unit, touch, deliver } = fixture(t);
  const oldRun = unit('run-old', 800 * KB);
  const newRun = unit('run-new', 800 * KB);
  touch(join(oldRun, 'capture.bin'), 1e9);
  touch(join(newRun, 'capture.bin'), 1.2e9);
  deliver(oldRun, newRun);
  const report = await run(['--root', root, '--max-mb', '1', '--exclude', oldRun, '--exclude', newRun]);
  assert.deepEqual(report.deleted, []);
  assert.equal(report.targetMet, false);
  assert.ok(existsSync(join(oldRun, 'capture.bin')));
  assert.ok(existsSync(join(newRun, 'capture.bin')));
});

test('a concurrent delivery cannot evict another task claimed evidence', async t => {
  const { root, run, unit, touch, deliver, base } = fixture(t);
  const oldRun = unit('run-old', 800 * KB);
  const bNew = unit('run-b-new', 400 * KB);
  const filler = unit('run-filler', 800 * KB);
  touch(join(oldRun, 'capture.bin'), 1e9);
  touch(join(bNew, 'capture.bin'), 1.1e9);
  touch(join(filler, 'capture.bin'), 1.2e9);
  deliver(oldRun, filler);
  // Task A starts re-presenting the old image: claim it and keep the token.
  const claim = await run(['--root', root, '--present', oldRun]);
  assert.equal(claim.tokens.length, 1);
  // Task B's cleanup, excluding only B's run, must spare A's claimed run; the filler pays.
  const byB = await run(['--root', root, '--max-mb', '1', '--exclude', bNew]);
  assert.deepEqual(byB.deleted.map(entry => base(entry.path)), ['run-filler']);
  assert.ok(existsSync(join(oldRun, 'capture.bin')));
  assert.equal(byB.claimedBytes, 800 * KB);
  // Two presenters on one directory: releasing one claim keeps the other's protection.
  const second = await run(['--root', root, '--present', oldRun]);
  await run(['--root', root, '--done-presenting', claim.tokens[0]]);
  const stillClaimed = await run(['--root', root, '--max-mb', '1', '--exclude', bNew]);
  assert.deepEqual(stillClaimed.deleted, []);
  assert.ok(existsSync(join(oldRun, 'capture.bin')));
  // Releasing a token nobody holds is a no-op, not an error.
  const none = await run(['--root', root, '--done-presenting', '00000000-0000-0000-0000-000000000000']);
  assert.deepEqual(none.released, []);
  // After the last release the old run is evictable again.
  await run(['--root', root, '--done-presenting', second.tokens[0]]);
  const unclaimed = await run(['--root', root, '--max-mb', '1', '--exclude', bNew]);
  assert.deepEqual(unclaimed.deleted.map(entry => base(entry.path)), ['run-old']);
  assert.equal(unclaimed.claimedBytes, 0);
});

test('expired claims are pruned and no longer protect their run', async t => {
  const { root, run, unit, touch, deliver, base } = fixture(t);
  const old = unit('run-old', 800 * KB);
  touch(join(old, 'capture.bin'), 1e9);
  deliver(old);
  const { tokens } = await run(['--root', root, '--present', old]);
  const claimFile = join(root, '.claims', `run-old.${tokens[0]}`);
  utimesSync(claimFile, 1e9, 1e9); // a claim left behind long ago by a crashed presenter
  const report = await run(['--root', root, '--max-mb', '0']);
  assert.deepEqual(report.deleted.map(entry => base(entry.path)), ['run-old']);
  assert.ok(!existsSync(claimFile));
});

test('a real cleanup waits while the store lock is held', async t => {
  const { cwd, root, unit, touch, deliver, base } = fixture(t);
  const old = unit('run-old', 800 * KB);
  touch(join(old, 'capture.bin'), 1e9);
  deliver(old);
  writeFileSync(join(root, '.cleanup.lock'), 'held-by-test');
  const waiting = new Promise((resolve, reject) => {
    execFile(process.execPath, [script, '--root', root, '--max-mb', '0'], { cwd }, (error, stdout) => {
      if (error) reject(Object.assign(error, { stdout }));
      else resolve(JSON.parse(stdout));
    });
  });
  await new Promise(resolve => setTimeout(resolve, 400));
  const settled = await Promise.race([waiting.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 50))]);
  assert.equal(settled, false); // the pass cannot decide or delete while the lock is held
  rmSync(join(root, '.cleanup.lock'), { force: true });
  const report = await waiting;
  assert.deepEqual(report.deleted.map(entry => base(entry.path)), ['run-old']);
});

test('a stale lock is stolen so a crashed holder cannot block the store', async t => {
  const { root, run, unit } = fixture(t);
  unit('run-a', 4 * KB);
  const lock = join(root, '.cleanup.lock');
  writeFileSync(lock, 'crashed-holder');
  utimesSync(lock, 1e9, 1e9);
  const report = await run(['--root', root, '--max-mb', '2']);
  assert.deepEqual(report.deleted, []);
  assert.ok(!existsSync(lock));
});

test('a lock whose recorded process exited is recovered immediately', async t => {
  const { root, run, unit } = fixture(t);
  unit('run-a', 4 * KB);
  const exited = spawnSync(process.execPath, ['-e', '']);
  assert.equal(exited.status, 0);
  const lock = join(root, '.cleanup.lock');
  writeFileSync(lock, JSON.stringify({ owner: 'exited-test-owner', pid: exited.pid }));
  const report = await run(['--root', root, '--max-mb', '2']);
  assert.deepEqual(report.deleted, []);
  assert.ok(!existsSync(lock));
});

test('an old lock owned by a live process is never stolen', async t => {
  const { cwd, root, unit, touch, deliver, base } = fixture(t);
  const old = unit('run-old', 800 * KB);
  touch(join(old, 'capture.bin'), 1e9);
  deliver(old);
  const lock = join(root, '.cleanup.lock');
  writeFileSync(lock, JSON.stringify({ owner: 'live-test-owner', pid: process.pid }));
  utimesSync(lock, 1e9, 1e9);
  const waiting = new Promise((resolve, reject) => {
    execFile(process.execPath, [script, '--root', root, '--max-mb', '0'], { cwd }, (error, stdout) => {
      if (error) reject(Object.assign(error, { stdout }));
      else resolve(JSON.parse(stdout));
    });
  });
  await new Promise(resolve => setTimeout(resolve, 400));
  const settled = await Promise.race([waiting.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 50))]);
  assert.equal(settled, false);
  rmSync(lock, { force: true });
  const report = await waiting;
  assert.deepEqual(report.deleted.map(entry => base(entry.path)), ['run-old']);
});

test('claiming a run a finished pass already evicted fails explicitly', async t => {
  const { root, run, unit, touch, deliver } = fixture(t);
  const old = unit('run-old', 800 * KB);
  touch(join(old, 'capture.bin'), 1e9);
  deliver(old);
  const report = await run(['--root', root, '--max-mb', '0']);
  assert.equal(report.deleted.length, 1);
  await assert.rejects(run(['--root', root, '--present', old]), error => {
    assert.equal(error.code, 1);
    assert.ok(String(error.stderr).length > 0);
    return true;
  });
});

test('a partially invalid present batch writes no claims at all', async t => {
  const { root, run, unit } = fixture(t);
  const good = unit('run-a', 4 * KB);
  const other = unit('run-b', 4 * KB);
  const existing = await run(['--root', root, '--present', other]);
  const before = readdirSync(join(root, '.claims')).length;
  await assert.rejects(run(['--root', root, '--present', good, '--present', join(root, 'missing')]), error => error.code === 1);
  const after = readdirSync(join(root, '.claims'));
  assert.equal(after.length, before);
  assert.ok(!after.some(name => name.startsWith('run-a.')));
  const done = await run(['--root', root, '--done-presenting', existing.tokens[0]]);
  assert.equal(done.released.length, 1);
});

test('a failed claim write rolls back every claim from that batch', async t => {
  const { cwd, root, run, unit } = fixture(t);
  const first = unit('run-a', 4 * KB);
  const second = unit('run-b', 4 * KB);
  const preload = join(cwd, 'inject-claim-write-failure.cjs');
  writeFileSync(preload, `
    const fs = require('node:fs');
    const path = require('node:path');
    const original = fs.writeFileSync;
    let writes = 0;
    fs.writeFileSync = (target, ...args) => {
      if (path.basename(path.dirname(String(target))) === '.claims' && ++writes === 2) {
        const error = new Error('injected ENOSPC');
        error.code = 'ENOSPC';
        throw error;
      }
      return original(target, ...args);
    };
    require('node:module').syncBuiltinESMExports();
  `);
  await assert.rejects(
    run(['--root', root, '--present', first, '--present', second], { NODE_OPTIONS: `--require "${preload.replaceAll('\\', '/')}"` }),
    error => error.code === 1 && String(error.stderr).includes('injected ENOSPC'),
  );
  assert.deepEqual(readdirSync(join(root, '.claims')), []);
});

test('a present rehearsal neither creates claims nor the claims directory', async t => {
  const { root, run, unit } = fixture(t);
  const good = unit('run-a', 4 * KB);
  const preview = await run(['--root', root, '--present', good, '--dry-run']);
  assert.deepEqual(preview.tokens, []);
  assert.equal(preview.dryRun, true);
  assert.ok(!existsSync(join(root, '.claims')));
});

test('an unreadable claim aborts cleanup instead of dropping its protection', async t => {
  const { cwd, root, run, unit, deliver } = fixture(t);
  const claimed = unit('run-a', 800 * KB);
  deliver(claimed);
  const { tokens } = await run(['--root', root, '--present', claimed]);
  const preload = join(cwd, 'inject-claim-stat-failure.cjs');
  writeFileSync(preload, `
    const fs = require('node:fs');
    const path = require('node:path');
    const original = fs.statSync;
    fs.statSync = (target, ...args) => {
      if (path.basename(path.dirname(String(target))) === '.claims') {
        const error = new Error('injected EIO');
        error.code = 'EIO';
        throw error;
      }
      return original(target, ...args);
    };
    require('node:module').syncBuiltinESMExports();
  `);
  await assert.rejects(
    run(['--root', root, '--max-mb', '0'], { NODE_OPTIONS: `--require "${preload.replaceAll('\\', '/')}"` }),
    error => error.code === 1 && String(error.stderr).includes('Cannot inspect presentation claim'),
  );
  assert.ok(existsSync(join(claimed, 'capture.bin')));
  const released = await run(['--root', root, '--done-presenting', tokens[0]]);
  assert.equal(released.released.length, 1);
});
