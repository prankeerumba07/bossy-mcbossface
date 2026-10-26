#!/usr/bin/env node
// What is happening in your terminal windows (VS Code and others) and in
// every open Claude Code conversation.
//
//   node terminals.mjs          plain-language report
//   node terminals.mjs --json   the same as JSON
//
// Reads only process lists (ps, lsof) and Claude Code's own session files.
// Recent commands with their exit codes come from the optional terminal log
// (see GUIDE.md); without it, only what is running right now is visible.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  FILES, HOME, rotatedName, config, liveSessions, transcriptPath, transcriptActivity, readTail, safeStat,
  whereLabel, modelLabel, projectName, short, fmtDuration, parseArgs, isMain,
} from './lib.mjs';
import { summarize, redact } from './redact.mjs';

const SHELLS = /^-?(zsh|bash|fish|sh|tcsh|nu|pwsh)$/;
// "no terminal" as macOS (??) and Linux (?) ps print it
const NO_TTY = new Set(['??', '?', '-', '']);

function etimeMs(s) {
  const m = String(s).match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  return ((+(m[1] || 0) * 24 + +(m[2] || 0)) * 3600 + +m[3] * 60 + +m[4]) * 1000;
}

function processTable() {
  let out = '';
  // Windows has no ps; the report is then empty rather than an error.
  try { out = execFileSync('ps', ['-axo', 'pid=,ppid=,tty=,stat=,etime=,command='], { encoding: 'utf8', maxBuffer: 32 << 20, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* no ps */ }
  const procs = new Map();
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    procs.set(+m[1], { pid: +m[1], ppid: +m[2], tty: m[3], stat: m[4], elapsed: etimeMs(m[5]), command: m[6] });
  }
  return procs;
}

function appOf(proc, procs) {
  for (let p = proc, i = 0; p && i < 40; p = procs.get(p.ppid), i++) {
    const c = p.command;
    if (c.includes('/Visual Studio Code.app/') || c.includes('/Code.app/')) return 'VS Code';
    if (c.includes('/Cursor.app/')) return 'Cursor';
    if (c.includes('/Claude.app/')) return 'Claude app';
    if (c.includes('/iTerm.app/') || c.includes('/iTerm2.app/')) return 'iTerm';
    if (c.includes('/Warp.app/')) return 'Warp';
    if (c.includes('/Terminal.app/')) return 'Terminal';
    if (c.includes('/JetBrains/') || /\/(IntelliJ|PyCharm|WebStorm)[^/]*\.app\//.test(c)) return 'JetBrains';
    if (p.ppid <= 1) break;
  }
  return 'Other';
}

function cwds(pids) {
  const map = new Map();
  if (!pids.length) return map;
  try {
    const out = execFileSync('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    let pid = null;
    for (const l of out.split('\n')) {
      if (l.startsWith('p')) pid = +l.slice(1);
      else if (l.startsWith('n') && pid) map.set(pid, l.slice(1));
    }
  } catch (e) {
    // lsof exits 1 when some pids are gone; keep what it printed.
    const out = String(e.stdout || '');
    let pid = null;
    for (const l of out.split('\n')) {
      if (l.startsWith('p')) pid = +l.slice(1);
      else if (l.startsWith('n') && pid) map.set(pid, l.slice(1));
    }
  }
  return map;
}

function baseCmd(command) {
  return path.basename(command.split(' ')[0]);
}

function isClaudeProc(command) {
  return /(^|\/)claude(\s|$)/.test(command) || command.includes('claude.app/Contents/MacOS/claude') || command.includes('native-binary/claude');
}

// Terminal log written by terminal-log.zsh, grouped by shell. Lines carry a
// per-shell number (seq) so a command's start and end pair up even when the
// start line, written in the background, lands after the end line.
export function readTermLog(bytes = 256 * 1024) {
  const old = rotatedName(FILES.termLog);
  const cur = readTail(FILES.termLog, bytes);
  const size = safeStat(FILES.termLog)?.size || 0;
  return size >= bytes || old === FILES.termLog ? cur : [...readTail(old, bytes - size), ...cur];
}

function terminalLog() {
  const old = rotatedName(FILES.termLog);
  const on = !!(safeStat(FILES.termLog) || safeStat(old) || zshrcHasLog());
  const byShell = new Map();
  const bySeq = new Map();
  for (const e of readTermLog()) {
    if (!byShell.has(e.pid)) byShell.set(e.pid, []);
    const list = byShell.get(e.pid);
    const key = `${e.pid}/${e.seq}`;
    if (e.ev === 'run') {
      const c = bySeq.get(key) || { exit: null, secs: null };
      Object.assign(c, { cmd: e.cmd, at: e.ts * 1000, cwd: e.cwd, app: e.app, tty: e.tty });
      if (!bySeq.has(key) || e.seq == null) list.push(c);
      if (e.seq != null) bySeq.set(key, c);
    } else if (e.ev === 'end') {
      const exit = Number.isFinite(e.exit) ? e.exit : null, secs = Number.isFinite(e.secs) ? e.secs : null;
      if (e.seq != null) {
        const c = bySeq.get(key);
        if (c) Object.assign(c, { exit, secs });
        else { const n = { cmd: '', at: e.ts * 1000, exit, secs }; bySeq.set(key, n); list.push(n); }
      } else {
        const last = [...list].reverse().find((c) => c.exit == null);
        if (last) Object.assign(last, { exit, secs });
      }
    }
    if (list.length > 30) list.shift();
  }
  for (const list of byShell.values()) {
    for (let i = list.length - 1; i >= 0; i--) if (!list[i].cmd) list.splice(i, 1);
    // A command followed by later ones in the same shell has ended, even with
    // no end line (e.g. "exec zsh" replaced the shell).
    for (let i = 0; i < list.length - 1; i++) if (list[i].exit == null) list[i].ended = true;
  }
  return { on, byShell };
}

function zshrcHasLog() {
  try { return fs.readFileSync(path.join(HOME, '.zshrc'), 'utf8').includes('work-manager terminal log'); } catch { return false; }
}

export function claudeSessions(procs = processTable()) {
  return liveSessions().map((s) => {
    const proc = procs.get(s.pid);
    const file = transcriptPath(s.sessionId, s.cwd);
    const act = file ? transcriptActivity(file) : {};
    const modelArg = proc && (proc.command.match(/--model[= ](\S+)/) || [])[1];
    return {
      pid: s.pid, sessionId: s.sessionId, name: s.name || '', where: whereLabel(s.entrypoint),
      cwd: s.cwd, project: projectName(s.cwd), status: s.status || '', statusSince: s.statusUpdatedAt || null,
      startedAt: s.startedAt || null, model: act.model || modelArg || '', modelName: modelLabel(act.model || modelArg || ''), doing: act.doing || '',
      lastActivityAt: act.mtime || null, tty: proc && !NO_TTY.has(proc.tty) ? proc.tty : null, transcript: file,
    };
  });
}

// Running commands come from the process list with all their arguments;
// show them the same way the terminal log keeps commands.
function shown(command) {
  let full = false;
  try { full = config().terminalLogFullCommands === true; } catch { /* default */ }
  return short(full ? redact(command) : summarize(command), 160);
}

// Failed commands in the terminal log, paired the same way the report pairs them.
export function logFailures(maxAgeMs = 6 * 3600e3) {
  const out = [];
  for (const list of terminalLog().byShell.values()) {
    for (const c of list) if (Number.isFinite(c.exit) && c.exit !== 0 && c.exit !== 130 && Date.now() - c.at < maxAgeMs) out.push(c);
  }
  return out.sort((a, b) => b.at - a.at);
}

export function snapshot() {
  const procs = processTable();
  const log = terminalLog();
  const byTty = new Map();
  for (const p of procs.values()) {
    if (!p.tty || NO_TTY.has(p.tty)) continue;
    if (!byTty.has(p.tty)) byTty.set(p.tty, []);
    byTty.get(p.tty).push(p);
  }
  const sessions = claudeSessions(procs);
  const terminals = [];
  for (const [tty, list] of byTty) {
    const root = list.find((p) => !list.some((q) => q.pid === p.ppid)) || list[0];
    const shell = SHELLS.test(baseCmd(root.command)) ? root : list.find((p) => SHELLS.test(baseCmd(p.command))) || root;
    const others = list.filter((p) => p.pid !== shell.pid && !SHELLS.test(baseCmd(p.command)) && !p.command.startsWith('ps '));
    const fg = others.filter((p) => p.stat.includes('+')).sort((a, b) => (b.elapsed || 0) - (a.elapsed || 0))[0] || null;
    const bg = others.filter((p) => !p.stat.includes('+') && p.ppid === shell.pid);
    const claude = fg && isClaudeProc(fg.command) ? sessions.find((s) => s.pid === fg.pid) || null : null;
    terminals.push({
      tty, app: appOf(shell, procs), shellPid: shell.pid, shell: baseCmd(shell.command), open: shell.elapsed,
      running: fg ? { pid: fg.pid, cmd: shown(fg.command), elapsed: fg.elapsed, claude } : null,
      background: bg.map((p) => ({ pid: p.pid, cmd: shown(p.command), elapsed: p.elapsed })),
      recent: (log.byShell.get(shell.pid) || []).slice(-8),
    });
  }
  const cw = cwds(terminals.flatMap((t) => [t.shellPid, t.running?.pid].filter(Boolean)));
  for (const t of terminals) {
    t.cwd = cw.get(t.running?.pid) || cw.get(t.shellPid) || '';
    t.project = projectName(t.cwd);
  }
  terminals.sort((a, b) => (a.app === 'VS Code' ? 0 : 1) - (b.app === 'VS Code' ? 0 : 1) || a.tty.localeCompare(b.tty));
  const failures = logFailures();
  return { at: Date.now(), logOn: log.on, terminals, claudeSessions: sessions, failures: failures.slice(0, 10) };
}

function report(s) {
  const lines = [];
  lines.push(`Terminal windows open: ${s.terminals.length}`);
  for (const t of s.terminals) {
    lines.push(`\n• ${t.app} terminal ${t.tty} — folder: ${t.cwd || '?'}`);
    if (t.running?.claude) {
      const c = t.running.claude;
      lines.push(`  Running Claude Code: "${c.name || 'untitled'}" · model ${modelLabel(c.model) || '?'} · ${c.status || '?'}${c.doing ? ` · ${c.doing}` : ''}`);
    } else if (t.running) lines.push(`  Running now (${fmtDuration(t.running.elapsed)}): ${t.running.cmd}`);
    else lines.push('  Idle — waiting for a command');
    for (const b of t.background) lines.push(`  In the background (${fmtDuration(b.elapsed)}): ${b.cmd}`);
    for (const c of t.recent.slice(-5)) {
      const state = c.exit == null ? (c.ended ? 'ended (no exit code)' : 'still running') : c.exit === 0 ? 'ok' : `FAILED (exit ${c.exit})`;
      lines.push(`  ${new Date(c.at).toLocaleTimeString()} ${state}${c.secs != null ? `, ${c.secs}s` : ''}: ${short(c.cmd, 100)}`);
    }
  }
  lines.push(`\nOpen Claude Code conversations: ${s.claudeSessions.length}`);
  for (const c of s.claudeSessions) {
    lines.push(`• "${c.name || 'untitled'}" in ${c.where}${c.tty ? ` (${c.tty})` : ''} · ${c.project} · model ${modelLabel(c.model) || '?'} · ${c.status === 'busy' ? 'working' : c.status || '?'}${c.doing ? ` · last step: ${c.doing}` : ''}`);
  }
  if (s.failures.length) {
    lines.push('\nFailed commands in the last 6 hours:');
    for (const f of s.failures) lines.push(`• ${new Date(f.at).toLocaleTimeString()} exit ${f.exit} in ${f.cwd}: ${short(f.cmd, 100)}`);
  }
  if (!s.logOn) lines.push('\n(Terminal log is off, so past commands and their results are not visible. GUIDE.md says how to turn it on.)');
  return lines.join('\n');
}

if (isMain(import.meta)) {
  const args = parseArgs(process.argv.slice(2), { booleans: ['json'] });
  if (args._.length) { console.error(`Unexpected word "${args._[0]}". Options start with --.`); process.exit(2); }
  const s = snapshot();
  console.log(args.json ? JSON.stringify(s, null, 1) : report(s));
}
