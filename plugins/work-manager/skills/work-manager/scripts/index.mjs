#!/usr/bin/env node
// Builds a small, lasting summary of every past Claude Code conversation in
// ~/.claude/work-manager/history-index.json. Claude Code deletes old
// transcripts (after 30 days by default); the summaries here stay.
//
//   node index.mjs            update (only changed transcripts are read again)
//   node index.mjs --rebuild  read every transcript again
//   node index.mjs --quiet    no output (used by the hooks)
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {
  PROJECTS, FILES, ensureData, readJSON, writeJSON, safeReaddir, safeStat,
  isHumanPrompt, cleanPrompt, contentText, whereLabel, projectName, short, parseArgs, isMain,
} from './lib.mjs';

const MAX_PROMPTS = 1000;
const MAX_FILES = 2000;
const SKIP_HEAD = /^\{"type":"(api-request|file-history|queue-operation|atis|mode|last-prompt|cost-state)/;

export async function summarizeTranscript(file) {
  const rec = {
    id: path.basename(file, '.jsonl'), source: 'claude-code', file,
    cwd: '', project: '', where: '', entrypoint: '', branch: '', title: '', startedAt: null, lastAt: null,
    models: [], prompts: [], promptCount: 0, answers: [], agents: [], files: [],
  };
  const models = new Set(), files = new Set();
  let titleFromAi = '';
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || SKIP_HEAD.test(line.slice(0, 40))) continue;
    if (line.length > 4_000_000) continue;
    const head = line.slice(0, 200);
    if (head.includes('"attachment":')) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.type === 'ai-title' && r.aiTitle) { titleFromAi = r.aiTitle; continue; }
    if (r.type === 'custom-title' && r.customTitle) { rec.title = r.customTitle; continue; }
    if (r.type !== 'user' && r.type !== 'assistant') continue;
    const ts = r.timestamp ? Date.parse(r.timestamp) : null;
    if (ts) {
      if (!rec.startedAt || ts < rec.startedAt) rec.startedAt = ts;
      if (!rec.lastAt || ts > rec.lastAt) rec.lastAt = ts;
    }
    if (!rec.cwd && r.cwd) rec.cwd = r.cwd;
    if (!rec.where && r.entrypoint) { rec.where = whereLabel(r.entrypoint); rec.entrypoint = r.entrypoint; }
    if (r.gitBranch) rec.branch = r.gitBranch;
    if (r.type === 'user') {
      if (!isHumanPrompt(r)) continue;
      rec.promptCount++;
      // Every prompt is kept (later ones shorter), so search finds the middle of long conversations too.
      const p = { at: ts, text: short(cleanPrompt(contentText(r.message.content)), rec.prompts.length < 20 ? 600 : 300) };
      if (rec.prompts.length < MAX_PROMPTS) rec.prompts.push(p);
      else rec.prompts[MAX_PROMPTS - 1] = p;
      continue;
    }
    const m = r.message || {};
    if (m.model && m.model !== '<synthetic>') models.add(m.model);
    const parts = Array.isArray(m.content) ? m.content : [];
    for (const p of parts) {
      if (p.type === 'text' && p.text && p.text.length > 40) {
        rec.answers.push({ at: ts, text: short(p.text, 900) });
        if (rec.answers.length > 4) rec.answers.shift();
      } else if (p.type === 'tool_use') {
        const inp = p.input || {};
        if ((p.name === 'Agent' || p.name === 'Task') && rec.agents.length < 40) {
          rec.agents.push(short(`${inp.description || ''}${inp.subagent_type ? ` (${inp.subagent_type})` : ''}`, 120));
        }
        if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(p.name)) {
          const fp = inp.file_path || inp.notebook_path;
          if (fp && files.size < MAX_FILES) files.add(fp);
        }
      }
    }
  }
  const custom = readJSON(path.join(path.dirname(file), rec.id, 'custom-title.json'), null);
  if (custom && (custom.title || custom.customTitle)) rec.title = custom.title || custom.customTitle;
  if (!rec.title) rec.title = titleFromAi || short(rec.prompts[0]?.text || '(no prompt)', 80);
  rec.project = projectName(rec.cwd);
  // Runs started by scripts or other agents in temporary folders, not by you.
  rec.automated = /^(\/private)?\/(tmp|var\/folders)\//.test(rec.cwd) || rec.entrypoint.startsWith('sdk');
  rec.models = [...models];
  rec.files = [...files];
  return rec;
}

// claude.ai "Export data" file (conversations.json), saved by the user into
// ~/.claude/work-manager/imports/. Read defensively: the format is not documented.
export function summarizeClaudeAiExport(file, parsed) {
  const data = parsed !== undefined ? parsed : readJSON(file, null);
  const list = Array.isArray(data) ? data : Array.isArray(data?.conversations) ? data.conversations : [];
  const str = (v) => (v == null ? '' : typeof v === 'string' ? v : typeof v === 'object' ? '' : String(v));
  const ts = (v) => { const t = Date.parse(str(v)); return Number.isNaN(t) ? null : t; };
  const out = [];
  for (const c of list) {
    if (!c || typeof c !== 'object' || !(c.uuid || c.id)) continue;
    // Skip anything that is not a message object; never let one bad entry stop the rest.
    const msgs = (Array.isArray(c.chat_messages) ? c.chat_messages : Array.isArray(c.messages) ? c.messages : []).filter((m) => m && typeof m === 'object');
    const text = (m) => str(m.text) || contentText(Array.isArray(m.content) ? m.content : str(m.content)) || '';
    const human = msgs.filter((m) => m.sender === 'human' || m.role === 'user' || m.role === 'human');
    const bot = msgs.filter((m) => m.sender === 'assistant' || m.role === 'assistant');
    const kept = human.length > 1000 ? [...human.slice(0, 500), ...human.slice(-500)] : human;
    out.push({
      id: `claude-ai:${str(c.uuid || c.id)}`, source: 'claude.ai', file,
      cwd: '', project: str(c.project?.name) || 'claude.ai', where: 'claude.ai', branch: '',
      title: short(str(c.name), 120) || short(text(human[0] || {}), 80) || '(untitled chat)',
      startedAt: ts(c.created_at), lastAt: ts(c.updated_at) || ts(c.created_at), models: c.model ? [str(c.model)] : [],
      prompts: kept.map((m, i) => ({ at: ts(m.created_at), text: short(text(m), i < 20 ? 600 : 300) })),
      promptCount: human.length,
      answers: bot.slice(-4).map((m) => ({ at: ts(m.created_at), text: short(text(m), 900) })),
      agents: [], files: [],
    });
  }
  return out;
}

function transcriptFiles() {
  const out = [];
  for (const dir of safeReaddir(PROJECTS)) {
    const full = path.join(PROJECTS, dir);
    for (const f of safeReaddir(full)) if (f.endsWith('.jsonl')) out.push(path.join(full, f));
  }
  return out;
}

export async function updateIndex({ rebuild = false, log = () => {} } = {}) {
  ensureData();
  // A rebuild reads every file again but keeps summaries whose transcript
  // Claude Code has deleted, and earlier claude.ai imports.
  const index = readJSON(FILES.index, {});
  const state = rebuild ? {} : readJSON(FILES.indexState, {});
  let read = 0;
  const all = transcriptFiles();
  for (const file of all) {
    const st = safeStat(file);
    if (!st) continue;
    const key = `${st.size}:${Math.round(st.mtimeMs)}`;
    if (state[file] === key && index[path.basename(file, '.jsonl')]) continue;
    try {
      const rec = await summarizeTranscript(file);
      index[rec.id] = rec;
      state[file] = key;
      read++;
      log(`read ${short(rec.title, 60)} (${rec.project})`);
    } catch (e) { log(`skipped ${file}: ${e.message}`); }
  }
  for (const f of safeReaddir(FILES.imports)) {
    if (!f.endsWith('.json')) continue;
    const file = path.join(FILES.imports, f);
    const st = safeStat(file);
    const key = `${st.size}:${Math.round(st.mtimeMs)}`;
    if (state[file] === key) continue;
    // Several exports can hold the same chat; keep the most recent version.
    // A file that cannot be read is skipped, never fatal.
    let recs = [];
    try { recs = summarizeClaudeAiExport(file); } catch (e) { log(`skipped ${f}: ${e.message}`); state[file] = key; continue; }
    if (!recs.length) { log(`skipped ${f} (no readable chats)`); state[file] = key; continue; }
    for (const rec of recs) {
      const had = index[rec.id];
      if (!had || (rec.lastAt || 0) > (had.lastAt || 0) || ((rec.lastAt || 0) === (had.lastAt || 0) && rec.promptCount >= had.promptCount)) index[rec.id] = rec;
    }
    state[file] = key;
    read++;
    log(`imported ${f}`);
  }
  for (const rec of Object.values(index)) {
    if (rec.source === 'claude-code') rec.transcriptKept = fs.existsSync(rec.file);
    if (rec.source === 'claude-code' && rec.automated === undefined) rec.automated = /^(\/private)?\/(tmp|var\/folders)\//.test(rec.cwd || '');
  }
  writeJSON(FILES.index, index);
  writeJSON(FILES.indexState, state);
  writeBrief(index);
  return { total: Object.keys(index).length, read };
}

// Small file the session-start hook reads, so starting Claude stays fast.
export function writeBrief(index) {
  const recent = Object.values(index)
    .filter((r) => r.lastAt && r.promptCount > 0 && !r.automated)
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, 12)
    .map((r) => ({
      id: r.id, title: r.title, project: r.project, where: r.where, lastAt: r.lastAt,
      lastPrompt: short(r.prompts[r.prompts.length - 1]?.text || '', 140),
    }));
  writeJSON(FILES.brief, { at: Date.now(), recent });
}

// One update at a time across the hooks, the dashboard and the commands.
// Returns { busy: true } when another update is running.
export async function updateIndexLocked(opts = {}) {
  ensureData();
  const lockDir = `${FILES.index}.lock`;
  try { fs.mkdirSync(lockDir); } catch {
    const st = safeStat(lockDir);
    if (st && Date.now() - st.mtimeMs < 15 * 60 * 1000) return { busy: true, total: Object.keys(readJSON(FILES.index, {})).length, read: 0 };
    fs.rmSync(lockDir, { recursive: true, force: true });
    try { fs.mkdirSync(lockDir); } catch { return { busy: true, total: 0, read: 0 }; }
  }
  try { return await updateIndex(opts); } finally { fs.rmSync(lockDir, { recursive: true, force: true }); }
}

if (isMain(import.meta)) {
  const args = parseArgs(process.argv.slice(2), { booleans: ['rebuild', 'quiet'] });
  if (args._.length) { console.error(`Unexpected word "${args._[0]}". Options start with --.`); process.exit(2); }
  const t0 = Date.now();
  const res = await updateIndexLocked({ rebuild: !!args.rebuild, log: args.quiet ? () => {} : (m) => console.log(m) });
  if (!args.quiet) console.log(res.busy ? 'Another index update is running.' : `Done: ${res.total} conversations in the index, ${res.read} read now, ${((Date.now() - t0) / 1000).toFixed(1)} s.`);
}
