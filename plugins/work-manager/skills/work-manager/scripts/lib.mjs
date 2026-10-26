// Shared helpers for Work Manager: where things live, reading Claude Code's
// own files, and plain-language labels.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HOME = os.homedir();
export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
export const PROJECTS = path.join(CLAUDE_DIR, 'projects');
export const SESSIONS = path.join(CLAUDE_DIR, 'sessions');
export const AGENTS_DIR = path.join(CLAUDE_DIR, 'agents');
export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = process.env.WM_DATA_DIR || path.join(CLAUDE_DIR, 'work-manager');

export const FILES = {
  events: path.join(DATA, 'events.jsonl'),
  eventsOld: path.join(DATA, 'events.1.jsonl'),
  board: path.join(DATA, 'board.json'),
  index: path.join(DATA, 'history-index.json'),
  indexState: path.join(DATA, 'index-state.json'),
  brief: path.join(DATA, 'brief-cache.json'),
  termLog: process.env.WM_TERMINAL_LOG || path.join(DATA, 'terminal-log.jsonl'),
  config: path.join(DATA, 'config.json'),
  dashboard: path.join(DATA, 'dashboard.json'),
  pluginSeen: path.join(DATA, 'plugin-active.json'),
  runtime: path.join(DATA, 'runtime'),
  imports: path.join(DATA, 'imports'),
};

export const DEFAULT_CONFIG = {
  port: 4777,
  autoStartDashboard: true,
  sessionStartBrief: true,
  briefRecentDays: 7,
  terminalLogFullCommands: false,
  autoRoute: true,
};

export function ensureData() {
  fs.mkdirSync(DATA, { recursive: true });
}

export function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJSON(file, value) {
  ensureData();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file);
}

export function config() {
  return { ...DEFAULT_CONFIG, ...readJSON(FILES.config, {}) };
}

// Claude Code names a project's folder after its path with every
// non-letter/digit turned into "-".
export function projectSlug(cwd) {
  return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
}

export function transcriptPath(sessionId, cwd) {
  if (cwd) {
    const p = path.join(PROJECTS, projectSlug(cwd), `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  for (const dir of safeReaddir(PROJECTS)) {
    const p = path.join(PROJECTS, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

export function safeStat(file) {
  try { return fs.statSync(file); } catch { return null; }
}

// Last `bytes` of a JSONL file, parsed. The first (cut) line is dropped.
export function readTail(file, bytes = 65536) {
  const st = safeStat(file);
  if (!st || !st.isFile()) return [];
  const start = Math.max(0, st.size - bytes);
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return []; }
  try {
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    const out = [];
    for (const l of lines) {
      if (!l) continue;
      try { out.push(JSON.parse(l)); } catch { /* cut or bad line */ }
    }
    return out;
  } finally { fs.closeSync(fd); }
}

export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Is this pid a Work Manager dashboard? Uses ps when there is one; where there is
// no ps (Windows) a live pid is taken at its word.
export function isDashboardProcess(pid) {
  if (!pidAlive(pid)) return false;
  const cmd = processCommand(pid);
  return cmd === '' ? true : /server\.mjs/.test(cmd);
}

export function processCommand(pid) {
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim(); }
  catch { return ''; }
}

// Live Claude Code sessions (terminal, VS Code, desktop app) from
// ~/.claude/sessions/<pid>.json, which Claude Code keeps up to date.
export function liveSessions() {
  const out = [];
  for (const f of safeReaddir(SESSIONS)) {
    if (!f.endsWith('.json')) continue;
    const s = readJSON(path.join(SESSIONS, f), null);
    if (!s || !s.sessionId || !pidAlive(s.pid)) continue;
    out.push(s);
  }
  return out;
}

export function whereLabel(entrypoint) {
  const e = String(entrypoint || '');
  if (e.startsWith('sdk')) return 'Script';
  if (e.includes('vscode')) return 'VS Code';
  if (e.includes('desktop')) return 'Claude app';
  if (e.includes('jetbrains')) return 'JetBrains';
  if (e === 'cli' || e.includes('cli')) return 'Terminal';
  return e || 'Unknown';
}

export function modelLabel(id) {
  if (!id) return '';
  const s = String(id).replace(/\[.*\]$/, '');
  const alias = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable', inherit: 'Same as main' };
  if (alias[s]) return alias[s];
  const m = s.match(/claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/);
  if (!m) return s;
  const name = m[1][0].toUpperCase() + m[1].slice(1);
  return m[3] ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`;
}

export function modelFamily(id) {
  const m = String(id || '').match(/haiku|sonnet|opus|fable/);
  return m ? m[0] : 'other';
}

export function projectName(cwd) {
  if (!cwd) return '';
  return path.basename(cwd);
}

export function short(text, n = 120) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// "What is it doing" in plain words, from a tool call.
export function describeToolUse(name, input = {}) {
  const base = (p) => (p ? path.basename(String(p)) : '');
  switch (name) {
    case 'Read': return `Reading ${base(input.file_path)}`;
    case 'Edit': case 'MultiEdit': return `Editing ${base(input.file_path)}`;
    case 'Write': return `Writing ${base(input.file_path)}`;
    case 'NotebookEdit': return `Editing ${base(input.notebook_path)}`;
    case 'Bash': return `Running: ${short(input.description || input.command, 70)}`;
    case 'Grep': return `Searching for "${short(input.pattern, 40)}"`;
    case 'Glob': return `Looking for files ${short(input.pattern, 40)}`;
    case 'WebFetch': try { return `Reading web page ${new URL(input.url).host}`; } catch { return 'Reading a web page'; }
    case 'WebSearch': return `Searching the web: ${short(input.query, 50)}`;
    case 'Agent': case 'Task': return `Starting a helper: ${short(input.description, 50)}`;
    case 'TodoWrite': return 'Updating its to-do list';
    case 'Skill': return `Using skill ${input.skill || ''}`.trim();
    default:
      if (name?.startsWith('mcp__')) return `Using ${name.split('__').slice(1).join(' ')}`;
      return name ? `Using ${name}` : 'Thinking';
  }
}

// Text of a message.content (string or list of parts).
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((p) => p && p.type === 'text').map((p) => p.text || '').join('\n');
}

// A prompt's own words: drops blocks the apps add (browser rules, reminders,
// open-file notes) and the tags around pasted text.
export function cleanPrompt(text) {
  let t = String(text || '');
  // A slash command the person typed, e.g. "/work-manager continue the audit".
  const cmd = t.match(/<command-name>\s*([^<]*?)\s*<\/command-name>/);
  if (cmd) {
    const cargs = (t.match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1] || '';
    t = `${cmd[1].startsWith('/') ? '' : '/'}${cmd[1]} ${cargs}`;
  }
  return t
    .replace(/<(browser_instruction|system-reminder|ide_opened_file|ide_selection|ide_diagnostics|[a-z]+(?:-[a-z]+)*-context)\b[^>]*>[\s\S]*?<\/\1>/g, ' ')
    .replace(/<\/?pasted_content[^>]*>/g, ' ')
    .trim();
}

// True for a prompt the person typed (not tool output, reminders or
// automatic messages).
export function isHumanPrompt(rec) {
  if (rec.type !== 'user' || rec.isMeta || rec.toolUseResult) return false;
  const kind = rec.origin && rec.origin.kind;
  if (kind && kind !== 'human') return false;
  const c = rec.message && rec.message.content;
  if (Array.isArray(c) && c.some((p) => p && p.type === 'tool_result')) return false;
  const t = cleanPrompt(contentText(c));
  if (!t) return false;
  if (kind === 'human') return true;
  // A bare command such as /compact or /model carries no words worth keeping.
  if (/^\/\S+$/.test(t)) return false;
  return !/^(<|This session is being continued|\[Request interrupted|Another Claude session|Caveat:)/.test(t);
}

// Current activity of a transcript: last tool call or text, its time and model.
export function transcriptActivity(file) {
  const size = safeStat(file)?.size || 0;
  let recs = [];
  // Big attachment lines can hide the last reply, so look further back if needed.
  for (const bytes of [96 * 1024, 1024 * 1024, 8 * 1024 * 1024]) {
    recs = readTail(file, bytes);
    if (recs.some((r) => r.type === 'assistant') || bytes >= size) break;
  }
  let model = '', doing = '', at = null, finalText = '';
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i];
    if (r.type !== 'assistant' || !r.message) continue;
    if (!model && r.message.model && r.message.model !== '<synthetic>') model = r.message.model;
    if (!doing) {
      const parts = Array.isArray(r.message.content) ? r.message.content : [];
      const tool = [...parts].reverse().find((p) => p.type === 'tool_use');
      const text = [...parts].reverse().find((p) => p.type === 'text' && p.text);
      if (tool) doing = describeToolUse(tool.name, tool.input);
      else if (text) { doing = 'Writing its answer'; finalText = text.text; }
      at = r.timestamp ? Date.parse(r.timestamp) : null;
    }
    if (model && doing) break;
  }
  const st = safeStat(file);
  return { model, doing, at, finalText, mtime: st ? st.mtimeMs : null };
}

// "work-manager:wm-quick" (plugin) and "wm-quick" (local copy) are the same helper.
export function baseAgentType(type) {
  return String(type || '').split(':').pop();
}

// A helper's model from its definition: ~/.claude/agents, or the plugin's agents/ folder.
export function agentDefinitionModel(type) {
  const base = baseAgentType(type);
  if (!base) return '';
  for (const dir of [AGENTS_DIR, path.join(SKILL_DIR, 'agents'), path.resolve(SKILL_DIR, '..', '..', 'agents')]) {
    try {
      const head = fs.readFileSync(path.join(dir, `${base}.md`), 'utf8').slice(0, 2000);
      const m = head.match(/^model:\s*(\S+)/m);
      if (m) return m[1];
    } catch { /* not here */ }
  }
  return '';
}

export function friendlyAgent(type) {
  return FRIENDLY_AGENT[baseAgentType(type)] || type;
}

// Running inside the plugin (Claude Code sets this for plugin hooks and scripts)?
export const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || (fs.existsSync(path.resolve(SKILL_DIR, '..', '..', '.claude-plugin', 'plugin.json')) ? path.resolve(SKILL_DIR, '..', '..') : '');

export const FRIENDLY_AGENT = {
  'wm-quick': 'Quick helper',
  'wm-worker': 'Worker',
  'wm-expert': 'Expert',
  'wm-checker': 'Checker',
  'wm-expert-checker': 'Expert checker',
  'general-purpose': 'General helper',
  Explore: 'Explorer',
  Plan: 'Planner',
};

export function fmtDuration(ms) {
  if (ms == null || !isFinite(ms)) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function fmtWhen(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Command options. Each script lists its own:
//   parseArgs(argv, { booleans: ['deep'], values: ['project'], numbers: ['days'], dates: ['since'] })
// Accepts --name value, --name=value, --flag=false, and "--" to end options
// (so words that start with dashes can be searched). Unknown options, a
// missing value, a bad number or a bad date stop the command with a message.
export function parseArgs(argv, spec = {}) {
  const booleans = new Set(spec.booleans || []);
  const numbers = new Set(spec.numbers || []);
  const dates = new Set(spec.dates || []);
  const values = new Set([...(spec.values || []), ...numbers, ...dates]);
  const fail = (msg) => { console.error(msg); process.exit(2); };
  const known = () => [...booleans, ...values].map((k) => `--${k}`).join(', ') || 'none';
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (booleans.has(key)) {
      out[key] = eq > 0 ? !/^(false|0|no|off)$/i.test(a.slice(eq + 1)) : true;
      continue;
    }
    if (!values.has(key)) fail(`Unknown option --${key}. Options here: ${known()}.`);
    let v;
    if (eq > 0) v = a.slice(eq + 1);
    else { v = argv[i + 1]; if (v !== undefined && !v.startsWith('--')) i++; else v = undefined; }
    if (v === undefined || v === '') fail(`--${key} needs a value, e.g. --${key} ${{ project: 'NAME', since: '2026-10-01', check: '"how it was checked"' }[key] || '7'}`);
    if (numbers.has(key) && !(Number(v) > 0)) fail(`--${key} must be a number above 0 (got "${v}").`);
    if (dates.has(key) && Number.isNaN(Date.parse(v))) fail(`--${key} must be a date like 2026-10-01 (got "${v}").`);
    out[key] = v;
  }
  return out;
}

// "terminal-log.jsonl" -> "terminal-log.1.jsonl" (any other name gets ".1" added).
export function rotatedName(file) {
  const p = path.parse(file);
  return path.join(p.dir, p.ext ? `${p.name}.1${p.ext}` : `${p.base}.1`);
}

export function isMain(meta) {
  if (!process.argv[1]) return false;
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  return real(process.argv[1]) === real(fileURLToPath(meta.url));
}

// Hook events: the current file plus the previous one kept after rotation.
export function readEvents(bytes = 4 * 1024 * 1024) {
  const cur = readTail(FILES.events, bytes);
  const size = safeStat(FILES.events)?.size || 0;
  if (size >= bytes) return cur;
  return [...readTail(FILES.eventsOld, bytes - size), ...cur];
}

// Rename a log that has grown too big; readers also read the .1 file.
// Writers that still hold the old name finish into the renamed file, so
// nothing is lost.
export function rotateIfBig(file, maxBytes) {
  const st = safeStat(file);
  if (!st || st.size < maxBytes) return false;
  fs.renameSync(file, rotatedName(file));
  return true;
}
