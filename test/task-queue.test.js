import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../agents/solutions/task-queue.mjs', import.meta.url));

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'workbench-queue-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  function run(args, input) {
    return new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [helper, ...args], { cwd }, (error, stdout) => {
        if (error) reject(error);
        else resolve(JSON.parse(stdout));
      });
      child.stdin.end(input);
    });
  }
  return {
    task: file => join(cwd, '.oxbench', 'tasks', file),
    cmd: (...args) => run(args),
    add: title => run(['add', 'queue-test'], JSON.stringify({ title, description: '说明\nstatus: pending' })),
  };
}

test('simultaneous manual and timer claims dispatch once and only the owner can finish', async t => {
  const { cmd, add, task } = fixture(t);
  const file = await add('修复: "A"');
  const before = readFileSync(task(file), 'utf8');
  assert.match(before, /^title: "修复: \\"A\\""/m);
  const { id } = await cmd('menu');
  await cmd('auto-start', 'on');
  const results = await Promise.all([cmd('claim', id, file), cmd('wake', id), cmd('claim', id, file)]);
  const winners = results.filter(Boolean);
  assert.equal(winners.length, 1);
  assert.equal(winners[0].file, file);
  assert.equal(await cmd('finish', file, 'wrong-owner', 'done'), null);
  assert.equal(readFileSync(task(file), 'utf8'), before.replace('status: pending', 'status: in-progress'));
  assert.equal(await cmd('finish', file, winners[0].token, 'done'), 'done');
  assert.equal(readFileSync(task(file), 'utf8'), before.replace('status: pending', 'status: done'));
  const next = await add('B');
  const menu = await cmd('menu');
  assert.equal(await cmd('wake', id), null);
  assert.equal((await cmd('wake', menu.id)).file, next);
});

test('pause, replies and replaced menus disable only their own timer', async t => {
  const { cmd, add } = fixture(t);
  const file = await add('A');
  const first = await cmd('menu');
  const second = await cmd('menu');
  await cmd('auto-start', 'on');
  assert.equal(await cmd('timer', first.id, 'late-timer'), null);
  assert.equal(await cmd('wake', first.id), null);
  assert.equal(await cmd('timer', second.id, 'timer-B'), 'timer-B');
  assert.deepEqual(await cmd('reply', second.id), { timerId: 'timer-B' });
  assert.equal(await cmd('wake', second.id), null);
  await cmd('pause', second.id);
  assert.equal(await cmd('menu'), null);
  const resumed = await cmd('menu', '--resume');
  await cmd('pause', resumed.id);
  await add('B');
  const current = await cmd('menu');
  assert.equal(current.tasks.length, 2);
  await cmd('reply', current.id);
  const claim = await cmd('claim', current.id, file);
  assert.equal(await cmd('finish', file, claim.token, 'cancelled'), 'cancelled');
});

test('existing task files preserve frontmatter, line endings and body', async t => {
  const { cmd, add, task } = fixture(t);
  const file = await add('A');
  const before = '\uFEFF---\r\ntitle: old\r\nstatus: "pending" # state\r\n---\r\nstatus: pending\r\n';
  writeFileSync(task(file), before);
  const menu = await cmd('menu');
  await cmd('auto-start', 'on');
  const claim = await cmd('wake', menu.id);
  assert.equal(readFileSync(task(file), 'utf8'), before.replace('"pending"', '"in-progress"'));
  assert.equal(await cmd('finish', file, 'legacy', 'done'), null);
  assert.equal(await cmd('finish', file, claim.token, 'done'), 'done');
  writeFileSync(task('older.md'), before.replace('"pending"', '"in-progress"'));
  assert.equal(await cmd('finish', 'older.md', 'legacy', 'done'), 'done');
});

test('auto-start defaults off: timers and wakes are inert until enabled; manual claims unaffected', async t => {
  const { cmd, add } = fixture(t);
  const file = await add('A');
  const menu = await cmd('menu');
  assert.equal(await cmd('timer', menu.id, 'cron-1'), null);
  assert.equal(await cmd('wake', menu.id), null);
  assert.deepEqual(await cmd('auto-start', 'on'), { autoStart: true });
  const claim = await cmd('wake', menu.id);
  assert.equal(claim.file, file);
  assert.equal(await cmd('finish', file, claim.token, 'done'), 'done');
  assert.deepEqual(await cmd('auto-start', 'off'), { autoStart: false });
  const next = await add('B');
  const second = await cmd('menu');
  assert.equal(await cmd('wake', second.id), null);
  const manual = await cmd('claim', second.id, next);
  assert.equal(await cmd('finish', next, manual.token, 'cancelled'), 'cancelled');
});
