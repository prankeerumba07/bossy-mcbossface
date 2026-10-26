#!/usr/bin/env node
// The plan board: the main agent's list of tasks, shown on the dashboard.
//
//   node board.mjs new "Plan title" < tasks.json   (or a JSON array as the 2nd argument)
//       tasks: [{"id":"t1","title":"…","size":"easy|medium|hard","agent":"wm-quick","model":"claude-haiku-5-5","after":["t0"]}]
//       prints the plan id, e.g. p3
//   node board.mjs set PLAN TASK STATUS ["note"]
//       STATUS: planned | working | checking | done | failed | needs-you | skipped
//   node board.mjs result PLAN TASK "what came back" [--check "how it was checked"]
//   node board.mjs close PLAN ["final note"]
//   node board.mjs show [PLAN]          (default: open plans)
//
// Put "wm:PLAN/TASK" in a helper's prompt (e.g. "Task wm:p3/t1") and the
// dashboard links that helper's live progress to the task by itself.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { FILES, SESSIONS, ensureData, readJSON, writeJSON, short, fmtWhen, parseArgs, isMain, pidAlive } from './lib.mjs';

const STATUSES = ['planned', 'working', 'checking', 'done', 'failed', 'needs-you', 'skipped'];

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// One writer at a time. The lock folder holds the owner's pid; a lock is
// taken over only when its owner has exited or it is older than 10 s.
function withLock(fn) {
  ensureData();
  const lock = `${FILES.board}.lock`;
  const owner = path.join(lock, 'pid');
  let mine = false;
  for (let i = 0; i < 300 && !mine; i++) {
    try { fs.mkdirSync(lock); fs.writeFileSync(owner, String(process.pid)); mine = true; break; } catch { /* held */ }
    const st = fs.statSync(lock, { throwIfNoEntry: false });
    const pid = Number(readJSON(owner, 0));
    const ownerGone = pid > 0 && !pidAlive(pid);
    if (st && (ownerGone || Date.now() - st.mtimeMs > 10000)) {
      const stale = `${lock}.stale.${process.pid}`;
      try { fs.renameSync(lock, stale); fs.rmSync(stale, { recursive: true, force: true }); } catch { /* someone else took it */ }
      continue;
    }
    sleep(50);
  }
  if (!mine) throw new Error('The plan board is busy (another update is holding it). Try again in a moment.');
  try {
    const board = readJSON(FILES.board, { next: 1, plans: [] });
    const out = fn(board);
    writeJSON(FILES.board, board);
    return out;
  } finally {
    try { if (fs.readFileSync(owner, 'utf8') === String(process.pid)) fs.rmSync(lock, { recursive: true, force: true }); } catch { /* already gone */ }
  }
}

// The Claude Code conversation this command runs in: walk up the parent
// processes until one has a ~/.claude/sessions/<pid>.json file.
function mySession() {
  let pid = process.ppid;
  for (let i = 0; i < 12 && pid > 1; i++) {
    const s = readJSON(path.join(SESSIONS, `${pid}.json`), null);
    if (s && s.sessionId) return s;
    try { pid = +execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch { break; }
  }
  return null;
}

function findTask(board, planId, taskId) {
  const plan = board.plans.find((p) => p.id === planId);
  if (!plan) throw new Error(`No plan ${planId}`);
  const task = plan.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`No task ${taskId} in ${planId}`);
  return { plan, task };
}

export function newPlan(title, tasks) {
  const me = mySession();
  return withLock((board) => {
    const id = `p${board.next++}`;
    board.plans.push({
      id, title, created: Date.now(), status: 'open', sessionId: me?.sessionId || '', cwd: me?.cwd || process.cwd(),
      tasks: tasks.map((t, i) => ({
        id: t.id || `t${i + 1}`, title: t.title, size: t.size || 'medium', agent: t.agent || '', model: t.model || '',
        after: t.after || [], status: 'planned', notes: [], result: '', check: '', attempts: 0, started: null, ended: null,
      })),
    });
    if (board.plans.length > 200) board.plans = board.plans.slice(-200);
    return id;
  });
}

export function setStatus(planId, taskId, status, note) {
  if (!STATUSES.includes(status)) throw new Error(`Status must be one of: ${STATUSES.join(', ')}`);
  return withLock((board) => {
    const { task } = findTask(board, planId, taskId);
    if (status === 'working' && task.status !== 'working') { task.attempts++; task.started = task.started || Date.now(); }
    if (['done', 'failed', 'skipped'].includes(status)) task.ended = Date.now();
    task.status = status;
    task.statusAt = Date.now();
    if (note) task.notes.push({ at: Date.now(), text: short(note, 500) });
  });
}

export function setResult(planId, taskId, result, check) {
  if (!String(result || '').trim()) throw new Error('Give the result text: board.mjs result PLAN TASK "what came back" [--check "how it was checked"]');
  return withLock((board) => {
    const { task } = findTask(board, planId, taskId);
    task.result = short(result, 1500);
    if (check) task.check = short(check, 800);
  });
}

export function closePlan(planId, note) {
  return withLock((board) => {
    const plan = board.plans.find((p) => p.id === planId);
    if (!plan) throw new Error(`No plan ${planId}`);
    plan.status = 'closed';
    plan.closed = Date.now();
    if (note) plan.note = short(note, 1500);
    return plan.tasks.filter((t) => !['done', 'skipped'].includes(t.status));
  });
}

function show(planId) {
  const board = readJSON(FILES.board, { plans: [] });
  const plans = planId ? board.plans.filter((p) => p.id === planId) : board.plans.filter((p) => p.status !== 'closed');
  if (!plans.length) return console.log(planId ? `No plan ${planId}` : 'No open plans.');
  for (const p of plans) {
    console.log(`${p.id} · ${p.title} · ${p.status} · made ${fmtWhen(p.created)} · ${p.cwd}`);
    for (const t of p.tasks) {
      console.log(`  ${t.id} [${t.status}] ${t.title} — ${t.size}, ${t.agent || '?'}${t.model ? ` (${t.model})` : ''}${t.attempts > 1 ? `, try ${t.attempts}` : ''}`);
      if (t.result) console.log(`     result: ${short(t.result, 200)}`);
      if (t.check) console.log(`     checked: ${short(t.check, 200)}`);
    }
  }
}

if (isMain(import.meta)) {
  const args = parseArgs(process.argv.slice(2), { values: ['check'] });
  const [cmd, a, b, c, d] = args._;
  try {
    if (cmd === 'new') {
      const raw = b || fs.readFileSync(0, 'utf8');
      let tasks;
      try { tasks = JSON.parse(raw); } catch { throw new Error('The tasks must be JSON, e.g. \'[{"id":"t1","title":"…","size":"easy","agent":"wm-quick"}]\''); }
      tasks = Array.isArray(tasks) ? tasks : tasks?.tasks;
      if (!Array.isArray(tasks) || !tasks.length || !tasks.every((t) => t && typeof t === 'object' && String(t.title || '').trim())) throw new Error('Give a list of tasks, each with a "title".');
      console.log(newPlan(a || 'Untitled plan', tasks));
    } else if (cmd === 'set') { setStatus(a, b, c, d); console.log('ok'); }
    else if (cmd === 'result') { setResult(a, b, c, args.check); console.log('ok'); }
    else if (cmd === 'close') {
      const left = closePlan(a, b);
      console.log(left.length ? `Closed. Still not done: ${left.map((t) => `${t.id} [${t.status}]`).join(', ')} — tell the user; tasks that need them stay on the dashboard and in the start note for 7 days.` : 'ok');
    }
    else if (!cmd || cmd === 'show') show(a);
    else { console.error(`Unknown command "${cmd}". Use: new | set | result | close | show`); process.exit(2); }
  } catch (e) { console.error(e.message); process.exit(1); }
}
