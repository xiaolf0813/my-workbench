// Run from the project root. Each invocation performs one queue transition.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = '.oxbench';
const tasks = join(root, 'tasks');
const stateFile = join(root, 'queue.json');
const lock = join(root, 'queue.lock');

function replaceFile(path, content) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, content, { flag: 'wx' });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function loadState() {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function readTask(name) {
  if (!name || !/^[^/\\:]+\.md$/i.test(name)) throw Error('Expected a task filename');
  const path = join(tasks, name);
  const text = readFileSync(path, 'utf8');
  const header = /^(?:\uFEFF)?---[^\S\r\n]*\r?\n([\s\S]*?)^---[ \t]*\r?$/m.exec(text);
  const status = header && /^status:[ \t]*(["']?)(pending|in-progress|done|cancelled)\1(?=[ \t]*(?:#.*)?\r?$)/m.exec(header[1]);
  if (!status || header.index !== 0) throw Error(`Missing task status in ${name}`);
  const offset = text.indexOf('\n') + 1 + status.index + status[0].indexOf(status[2]);
  return {
    status: status[2],
    set(next) {
      replaceFile(path, text.slice(0, offset) + next + text.slice(offset + status[2].length));
    },
  };
}

function addTask(slug, draft) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+){1,3}$/.test(slug ?? '')) throw Error('Expected 2–4 hyphenated ASCII words');
  if (typeof draft?.title !== 'string' || !draft.title.trim() || /[\r\n]/.test(draft.title) ||
      typeof draft.description !== 'string' || !draft.description.trim()) {
    throw Error('Expected a one-line title and a description');
  }
  const created = new Date().toISOString();
  const stamp = created.slice(0, 19).replaceAll(':', '').replaceAll('-', '').replace('T', '-');
  const base = `${stamp}-${slug}`;
  let file = `${base}.md`;
  for (let n = 2; existsSync(join(tasks, file)); n++) file = `${base}-${n}.md`;
  replaceFile(join(tasks, file), `---\ntitle: ${JSON.stringify(draft.title)}\nstatus: pending\ncreated: ${created}\n---\n\n${draft.description.trim()}\n`);
  return file;
}

function transition([command, id, argument, result]) {
  const state = loadState();
  const save = () => replaceFile(stateFile, JSON.stringify(state, null, 2) + '\n');
  if (command === 'menu') {
    const pending = readdirSync(tasks, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
      .map(entry => entry.name).sort().filter(name => readTask(name).status === 'pending');
    if (!pending.length) return null;
    if (id !== '--resume' && state.paused && pending.every(name => state.tasks?.includes(name))) return null;
    Object.assign(state, {
      id: randomUUID(), tasks: pending, presentedAt: new Date().toISOString(),
      paused: false, answered: false, selection: null, timerId: null,
    });
    save();
    return { id: state.id, tasks: pending };
  }
  if (command === 'finish') {
    // Tasks already in progress before claims were introduced have no stored token.
    if (argument !== (state.claims?.[id] ?? 'legacy') || !['done', 'cancelled'].includes(result)) return null;
    const task = readTask(id);
    if (task.status === 'in-progress') task.set(result);
    else if (task.status !== result) return null;
    delete state.claims?.[id];
    save();
    return result;
  }
  if (!['timer', 'reply', 'pause', 'claim', 'wake'].includes(command)) throw Error('Unknown queue command');
  if (!id || id !== state.id || state.selection || state.paused) return null;
  if (command === 'timer') {
    if (state.answered || !argument) return null;
    state.timerId = argument;
    save();
    return argument;
  }
  if (command === 'reply' || command === 'pause') {
    state.answered = true;
    state.paused = command === 'pause';
    save();
    return { timerId: state.timerId };
  }
  if (command === 'wake' && state.answered) return null;
  const file = command === 'wake' ? state.tasks[0] : argument;
  if (!state.tasks.includes(file)) return null;
  const task = readTask(file);
  if (task.status !== 'pending') return null;
  const token = randomUUID();
  state.claims ??= {};
  state.claims[file] = token;
  state.selection = file;
  // Persist ownership first. A failed status write leaves a pending task for the next menu.
  save();
  task.set('in-progress');
  return { file, token };
}

async function run() {
  const args = process.argv.slice(2);
  const draft = args[0] === 'add' ? JSON.parse(readFileSync(0, 'utf8').replace(/^\uFEFF/, '')) : null;
  if (args[0] === 'add') mkdirSync(tasks, { recursive: true });
  else if (!existsSync(tasks)) return null;
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw Error(`Queue busy. If all queue commands have exited, remove ${lock} and retry.`);
      await delay(25);
    }
  }
  try {
    return args[0] === 'add' ? addTask(args[1], draft) : transition(args);
  } finally {
    rmdirSync(lock);
  }
}

try {
  console.log(JSON.stringify(await run()));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
