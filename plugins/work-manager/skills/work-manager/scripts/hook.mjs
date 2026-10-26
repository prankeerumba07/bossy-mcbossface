#!/usr/bin/env node
// Claude Code hook for Work Manager. Claude Code runs it with the hook's JSON
// on stdin.
//
//   hook.mjs event          write one line to events.jsonl (runs in the background)
//   hook.mjs session-start  also print a short "where things stand" note that
//                           Claude reads at the start of every conversation
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { logFailures } from './terminals.mjs';
import { routeNote } from './route.mjs';
import {
  FILES, SKILL_DIR, CLAUDE_DIR, PLUGIN_ROOT, ensureData, readJSON, writeJSON, readTail, readEvents, rotateIfBig, config, liveSessions,
  whereLabel, projectName, short, fmtWhen, contentText, pidAlive, processCommand, isMain, cleanPrompt, isDashboardProcess, transcriptActivity,
} from './lib.mjs';

const MAX_EVENTS_BYTES = 8 * 1024 * 1024;
const MAX_TERMLOG_BYTES = 4 * 1024 * 1024;

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const done = () => resolve(data);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
    setTimeout(done, 3000).unref();
  });
}

function resultText(resp) {
  if (!resp) return '';
  if (typeof resp === 'string') return resp;
  if (typeof resp.content === 'string') return resp.content;
  if (Array.isArray(resp.content)) return contentText(resp.content);
  return '';
}

// One small line per hook call: only what the dashboard needs.
export function toEvent(h) {
  const e = { ts: Date.now(), ev: h.hook_event_name, sid: h.session_id, cwd: h.cwd };
  // The conversation's own file: its helpers' files sit next to it.
  if (h.transcript_path && ['SessionStart', 'PreToolUse', 'SubagentStart', 'SubagentStop'].includes(h.hook_event_name)) e.tp = h.transcript_path;
  if (h.agent_id) e.aid = h.agent_id;
  if (h.agent_type) e.atype = h.agent_type;
  const inp = h.tool_input || {};
  switch (h.hook_event_name) {
    case 'PreToolUse':
      Object.assign(e, {
        tool: h.tool_name, tuid: h.tool_use_id, desc: short(inp.description, 120), stype: inp.subagent_type || 'general-purpose',
        model: inp.model || '', bg: !!inp.run_in_background, prompt: short(inp.prompt, 400),
      });
      break;
    case 'PostToolUse': {
      const r = h.tool_response || {};
      Object.assign(e, {
        tool: h.tool_name, tuid: h.tool_use_id, status: r.status || '', agentId: r.agentId || '',
        rmodel: String(r.resolvedModel || ''), dur: Number.isFinite(r.totalDurationMs) ? r.totalDurationMs : Number.isFinite(h.duration_ms) ? h.duration_ms : null, tokens: Number.isFinite(r.totalTokens) ? r.totalTokens : null,
        tools: Number.isFinite(r.totalToolUseCount) ? r.totalToolUseCount : null, result: short(resultText(r), 700),
      });
      break;
    }
    case 'PostToolUseFailure':
      Object.assign(e, { tool: h.tool_name, tuid: h.tool_use_id, error: short(h.error, 400), interrupt: !!h.is_interrupt });
      break;
    case 'SubagentStop':
      Object.assign(e, { tpath: h.agent_transcript_path || '', last: short(h.last_assistant_message, 700) });
      break;
    case 'Notification':
      Object.assign(e, { ntype: h.notification_type || '', msg: short(h.message, 200) });
      break;
    case 'UserPromptSubmit': {
      // Notices the app sends by itself (a helper finished, etc.) are not your messages.
      const p = h.prompt || '';
      if (/^\s*<(task-notification|side-sessions-event|ci-monitor-event|agent-message|cross-session-message)/.test(p)) {
        e.auto = true;
        const tag = (name) => (p.match(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`)) || [])[1] || '';
        if (p.trimStart().startsWith('<task-notification')) e.tn = { id: tag('task-id'), tuid: tag('tool-use-id'), status: tag('status') };
      } else e.prompt = short(cleanPrompt(p), 200);
      break;
    }
    case 'SessionStart':
      Object.assign(e, { source: h.source || '', model: h.model || '' });
      break;
    case 'SessionEnd':
      e.reason = h.reason || '';
      break;
    case 'StopFailure':
      e.error = short(h.error || h.message, 300);
      break;
    default:
  }
  return e;
}

export function appendEvent(e) {
  ensureData();
  let line = JSON.stringify(e);
  if (line.length > 3800) { e.prompt = short(e.prompt, 100); e.result = short(e.result, 200); e.last = short(e.last, 200); line = JSON.stringify(e); }
  fs.appendFileSync(FILES.events, `${line}\n`);
}


// The conversation's model: from its last reply, else what it was started
// with (--model, ANTHROPIC_MODEL, project or user settings). '' when unknown.
function conversationModel(h) {
  try { const m = h.transcript_path ? transcriptActivity(h.transcript_path).model : ''; if (m) return m; } catch { /* unknown */ }
  const started = [...readEvents(256 * 1024)].reverse().find((e) => e.ev === 'SessionStart' && e.sid === h.session_id && e.model);
  if (started) return started.model;
  let pid = process.ppid;
  for (let i = 0; i < 8 && pid > 1; i++) {
    let line = '';
    try { line = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { break; }
    const m = line.match(/^(\d+)\s+(.*)$/);
    if (!m) break;
    if (/claude/i.test(m[2])) {
      const flag = m[2].match(/--model[= ](\S+)/);
      if (flag) return flag[1];
    }
    pid = Number(m[1]);
  }
  if (process.env.ANTHROPIC_MODEL) return process.env.ANTHROPIC_MODEL;
  for (const f of [path.join(h.cwd || '', '.claude', 'settings.local.json'), path.join(h.cwd || '', '.claude', 'settings.json'), path.join(CLAUDE_DIR, 'settings.json')]) {
    const model = readJSON(f, {})?.model;
    if (model && model !== 'default') return model;
  }
  return '';
}

function startDetached(script, args = []) {
  const child = spawn(process.execPath, [path.join(SKILL_DIR, script), ...args], { detached: true, stdio: 'ignore' });
  child.unref();
}

export function dashboardRunning() {
  const d = readJSON(FILES.dashboard, null);
  return d && isDashboardProcess(d.pid) ? d : null;
}

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

// Start the dashboard, or restart it when it runs from another copy of
// Work Manager (an older version after a plugin update, or a removed copy).
export function ensureDashboard() {
  const d = dashboardRunning();
  const mine = path.join(SKILL_DIR, 'dashboard', 'server.mjs');
  if (d) {
    if (!d.script || real(d.script) === real(mine)) return;
    try { process.kill(d.pid, 'SIGTERM'); } catch { /* already gone */ }
    for (let i = 0; i < 20 && pidAlive(d.pid); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  startDetached('dashboard/server.mjs');
}

// The terminal log runs from a copy in ~/.claude/work-manager/runtime so ~/.zshrc
// never points into a folder that a plugin update replaces. Keep the copy current.
const RUNTIME_FILES = ['terminal-log.zsh', 'redact.mjs', 'lib.mjs'];
export function refreshRuntime(force = false) {
  if (!force && !fs.existsSync(FILES.runtime)) return false;
  fs.mkdirSync(FILES.runtime, { recursive: true });
  let changed = false;
  for (const f of RUNTIME_FILES) {
    const src = path.join(SKILL_DIR, 'scripts', f), dest = path.join(FILES.runtime, f);
    let a = '', b = null;
    try { a = fs.readFileSync(src, 'utf8'); } catch { continue; }
    try { b = fs.readFileSync(dest, 'utf8'); } catch { /* new */ }
    if (a !== b) { fs.writeFileSync(`${dest}.tmp`, a); fs.renameSync(`${dest}.tmp`, dest); changed = true; }
  }
  // Where this copy came from; the shell stops logging if that folder is removed.
  const marker = path.join(FILES.runtime, 'skill-dir');
  let had = null;
  try { had = fs.readFileSync(marker, 'utf8'); } catch { /* new */ }
  if (had !== SKILL_DIR) { fs.writeFileSync(marker, SKILL_DIR); changed = true; }
  return changed;
}

// When the plugin's hooks are running, an older local copy's hooks stand down,
// so nothing is recorded twice.
function localCopyShouldStandDown() {
  const seen = readJSON(FILES.pluginSeen, null);
  // Stays quiet for as long as that plugin folder exists, however long ago it last ran.
  return !!(seen && seen.root && fs.existsSync(path.join(seen.root, '.claude-plugin', 'plugin.json')) && path.resolve(seen.root) !== path.resolve(SKILL_DIR, '..', '..'));
}

// The note Claude sees when a conversation starts. Kept short and fast: it
// reads small files only, never whole transcripts.
export function brief(currentSid, cfg = config()) {
  const scripts = path.join(SKILL_DIR, 'scripts');
  const q = (p) => (/\s/.test(p) ? `"${p}"` : p);
  const lines = ['[Work Manager] Your work across Claude, ready to pick up (use the work-manager skill to plan and hand out work).'];
  const dash = dashboardRunning();
  const startCmd = `node ${q(path.join(scripts, 'dashboard.mjs'))} url`;
  lines.push(`Live dashboard: ${dash ? `http://127.0.0.1:${dash.port}` : cfg.autoStartDashboard ? `starting (${startCmd} prints the link)` : `not running (start it with: ${startCmd})`}`);

  const others = liveSessions().filter((s) => s.sessionId !== currentSid);
  if (others.length) {
    lines.push(`Other Claude conversations open now (${others.length}):`);
    for (const s of others.slice(0, 5)) lines.push(`- "${short(s.name || 'untitled', 60)}" · ${whereLabel(s.entrypoint)} · ${projectName(s.cwd)} · ${s.status === 'busy' ? 'working' : s.status || '?'}`);
  }

  const events = readEvents(256 * 1024).filter((e) => Date.now() - e.ts < 12 * 3600e3);
  const started = new Map();
  for (const e of events) {
    if (e.ev === 'PreToolUse' && (e.tool === 'Agent' || e.tool === 'Task')) started.set(e.tuid, e);
    if ((e.ev === 'PostToolUse' && e.status !== 'async_launched') || e.ev === 'PostToolUseFailure') started.delete(e.tuid);
  }
  // A background helper has ended when it stopped, or a notice said it completed, failed or was stopped.
  const notices = events.filter((e) => e.ev === 'UserPromptSubmit' && e.tn && ['completed', 'failed', 'killed', 'stopped'].includes(e.tn.status));
  const stopped = new Set([...events.filter((e) => e.ev === 'SubagentStop').map((e) => e.aid), ...notices.map((e) => e.tn.id)]);
  const bgDone = new Set([
    ...events.filter((e) => e.ev === 'PostToolUse' && e.status === 'async_launched' && stopped.has(e.agentId)).map((e) => e.tuid),
    ...notices.map((e) => e.tn.tuid).filter(Boolean),
  ]);
  const running = [...started.values()].filter((e) => !bgDone.has(e.tuid) && liveSessions().some((s) => s.sessionId === e.sid));
  if (running.length) lines.push(`Helpers still working: ${running.map((e) => `"${e.desc}" (${e.stype})`).slice(0, 5).join(', ')}`);

  const board = readJSON(FILES.board, { plans: [] });
  const waiting = (p) => p.tasks.some((t) => ['needs-you', 'failed'].includes(t.status));
  const open = (Array.isArray(board.plans) ? board.plans : []).filter((p) => p && Array.isArray(p.tasks) && p.tasks.some((t) => !['done', 'skipped'].includes(t.status))
    && (p.status !== 'closed' || (waiting(p) && Date.now() - (p.closed || 0) < 7 * 864e5)));
  for (const p of open.slice(0, 3)) {
    const left = p.tasks.filter((t) => !['done', 'skipped'].includes(t.status));
    lines.push(`${p.status === 'closed' ? 'Closed plan with tasks still waiting on you' : 'Unfinished plan'} "${short(p.title, 60)}" (${projectName(p.cwd)}): ${left.length} of ${p.tasks.length} tasks left — ${left.slice(0, 3).map((t) => `${t.title} [${t.status}]`).join('; ')}`);
  }

  const cache = readJSON(FILES.brief, { recent: [] });
  const recent = cache.recent.filter((r) => r.id !== currentSid && Date.now() - r.lastAt < cfg.briefRecentDays * 864e5).slice(0, 6);
  if (recent.length) {
    lines.push(`Recent conversations (last ${cfg.briefRecentDays} days):`);
    for (const r of recent) lines.push(`- ${fmtWhen(r.lastAt)} · ${r.where} · ${r.project} · "${short(r.title, 60)}" — last ask: ${short(r.lastPrompt, 90)}`);
  }

  const fails = logFailures(3 * 3600e3);
  if (fails.length) lines.push(`Terminal commands that failed in the last 3 hours: ${fails.length} (node ${q(path.join(scripts, 'terminals.mjs'))} shows them)`);

  lines.push(`Find older work: node ${q(path.join(scripts, 'recall.mjs'))} search WORDS (use only when it helps the task).`);
  if (PLUGIN_ROOT) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'settings.json'), 'utf8'));
      if (Object.values(s.hooks || {}).flat().some((g) => g && g._work_manager)) lines.push(`An older non-plugin copy of Work Manager is also installed; offer the user to retire it: node ${q(path.join(scripts, 'setup.mjs'))} --remove-old-copy (asks first).`);
    } catch { /* no settings */ }
  }
  return lines.join('\n');
}

async function main() {
  const mode = process.argv[2] || 'event';
  const fromPlugin = process.argv[3] === 'plugin';
  const raw = await readStdin();
  if (!fromPlugin && localCopyShouldStandDown()) return;
  if (fromPlugin && mode === 'session-start') {
    try { writeJSON(FILES.pluginSeen, { at: Date.now(), root: process.env.CLAUDE_PLUGIN_ROOT || path.resolve(SKILL_DIR, '..', '..') }); } catch { /* ignore */ }
  }
  let h = {};
  try { h = JSON.parse(raw || '{}'); } catch { /* keep empty */ }
  if (h && h.hook_event_name && mode !== 'route') { try { appendEvent(toEvent(h)); } catch { /* never block Claude */ } }
  if (mode === 'route') {
    // Grade the request and, when the conversation's model does not fit it, tell Claude which helper to use.
    const cfg = config();
    if (cfg.autoRoute === false || !h.prompt) return;
    if (/^\s*</.test(h.prompt)) return;
    const main = conversationModel(h);
    const r = routeNote(cleanPrompt(h.prompt), main || 'claude-opus', { plugin: fromPlugin });
    if (!r.grade) return;
    try { appendEvent({ ts: Date.now(), ev: 'Route', sid: h.session_id, cwd: h.cwd, level: r.level, model: r.model, main, noted: !!r.note }); } catch { /* ignore */ }
    if (r.note) process.stdout.write(`${r.note}\n`);
    return;
  }
  if (mode === 'session-start') {
    const cfg = config();
    try { rotateIfBig(FILES.events, MAX_EVENTS_BYTES); rotateIfBig(FILES.termLog, MAX_TERMLOG_BYTES); } catch { /* ignore */ }
    try { refreshRuntime(); } catch { /* ignore */ }
    try { startDetached('scripts/index.mjs', ['--quiet']); } catch { /* ignore */ }
    if (cfg.autoStartDashboard) { try { ensureDashboard(); } catch { /* ignore */ } }
    if (cfg.sessionStartBrief) {
      try { process.stdout.write(`${brief(h.session_id, cfg)}\n`); } catch { /* ignore */ }
    }
  } else if (h.hook_event_name === 'SessionEnd') {
    try { startDetached('scripts/index.mjs', ['--quiet']); } catch { /* ignore */ }
  }
}

if (isMain(import.meta)) {
  main().then(() => process.exit(0), () => process.exit(0));
}
