#!/usr/bin/env node
// Find past work in Claude conversations.
//
//   node recall.mjs recent [--days 7] [--project NAME] [--limit 15] [--all]   (--all: include script runs)
//   node recall.mjs search WORDS... [--days N] [--since YYYY-MM-DD] [--project NAME] [--deep] [--limit 10] [--all]
//   node recall.mjs show ID [--full] [--max 30000]
//   node recall.mjs import PATH/TO/conversations.json     (claude.ai "Export data" file)
//
// "search" looks in the lasting index first (titles, prompts, answers,
// helper tasks, edited files). --deep also reads the full transcripts still
// on disk (slower: about half a minute on a few GB).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import {
  PROJECTS, FILES, ensureData, readJSON, short, fmtWhen, contentText, cleanPrompt, isHumanPrompt,
  parseArgs, isMain,
} from './lib.mjs';
import { updateIndexLocked, summarizeClaudeAiExport } from './index.mjs';

const DEEP_TIMEOUT_MS = 90e3;
const MAX_WORDS = 8;

function loadIndex() { return readJSON(FILES.index, {}); }

function filterRecords(recs, args) {
  let out = recs;
  if (args.days) out = out.filter((r) => r.lastAt && r.lastAt >= Date.now() - Number(args.days) * 864e5);
  if (args.since) { const t = Date.parse(args.since); out = out.filter((r) => r.lastAt && r.lastAt >= t); }
  if (args.project) { const p = String(args.project).toLowerCase(); out = out.filter((r) => `${r.project} ${r.cwd}`.toLowerCase().includes(p)); }
  return out;
}

export function recent(args = {}) {
  const recs = filterRecords(Object.values(loadIndex()), { days: 7, ...args })
    .filter((r) => r.promptCount > 0 && (args.all || !r.automated))
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, Number(args.limit || 15));
  return recs.map((r) => ({
    id: r.id, title: r.title, project: r.project, where: r.where, lastAt: r.lastAt,
    prompts: r.promptCount, lastPrompt: short(r.prompts[r.prompts.length - 1]?.text, 160),
  }));
}

function words(q) {
  const ws = String(q).toLowerCase().split(/\s+/).map((w) => w.replace(/^["']|["']$/g, '')).filter((w) => w.length >= 2);
  return [...new Set(ws)].slice(0, MAX_WORDS);
}

function snippetAround(text, ws, n = 110) {
  const low = text.toLowerCase();
  for (const w of ws) {
    const i = low.indexOf(w);
    if (i >= 0) {
      const s = Math.max(0, i - n), e = Math.min(text.length, i + w.length + n);
      return `${s > 0 ? '…' : ''}${text.slice(s, e).replace(/\s+/g, ' ')}${e < text.length ? '…' : ''}`;
    }
  }
  return '';
}

// Each word counts once per kind of field, so a long conversation does not
// win just by repeating a word; conversations with every word come first.
const FIELD_WEIGHTS = { title: 6, project: 2, prompts: 3, answers: 1, agents: 1, files: 2 };

export function search(query, args = {}) {
  const ws = words(query);
  if (!ws.length) return [];
  const results = [];
  for (const r of filterRecords(Object.values(loadIndex()), args).filter((x) => args.all || !x.automated)) {
    const S = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
    const fields = {
      title: [S(r.title)], project: [S(r.project)], prompts: (r.prompts || []).map((p) => S(p?.text)),
      answers: (r.answers || []).map((a) => S(a?.text)), agents: (r.agents || []).map(S), files: (r.files || []).map(S),
    };
    let score = 0, hits = 0, snippet = '';
    for (const w of ws) {
      let found = false;
      for (const [kind, texts] of Object.entries(fields)) {
        const hitTexts = texts.filter((t) => t.toLowerCase().includes(w));
        if (!hitTexts.length) continue;
        found = true;
        score += FIELD_WEIGHTS[kind] + (kind === 'prompts' ? Math.min(2, Math.log2(hitTexts.length)) : 0);
        if (!snippet && kind !== 'title') snippet = snippetAround(hitTexts[0], [w]);
      }
      if (found) hits++;
    }
    if (!hits) continue;
    const all = hits === ws.length;
    results.push({ id: r.id, title: r.title, project: r.project, where: r.where, lastAt: r.lastAt, score: Math.round(score * 10) / 10, allWords: all, snippet: snippet || short(r.prompts[0]?.text, 200) });
  }
  return results
    .sort((a, b) => Number(b.allWords) - Number(a.allWords) || b.score - a.score || b.lastAt - a.lastAt)
    .slice(0, Number(args.limit || 10));
}

// Files under ~/.claude/projects that contain `word` (top-level transcripts
// only). Runs grep in the background so a dashboard stays responsive.
function grepFiles(word, signal) {
  return new Promise((resolve) => {
    const child = spawn('grep', ['-rliF', '--include=*.jsonl', '--exclude-dir=subagents', '--exclude-dir=tool-results', '-e', word, PROJECTS], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const stop = () => child.kill('SIGTERM');
    const timer = setTimeout(stop, DEEP_TIMEOUT_MS);
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      resolve(new Set(out.split('\n').filter((f) => f && path.dirname(path.dirname(f)) === PROJECTS)));
    });
    // No grep here (Windows): read the files with Node instead.
    child.on('error', () => { clearTimeout(timer); resolve(scanFiles(word, signal)); });
  });
}

async function scanFiles(word, signal) {
  const found = new Set();
  const deadline = Date.now() + DEEP_TIMEOUT_MS;
  for (const dir of fs.readdirSync(PROJECTS, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(PROJECTS, dir.name))) {
      if (!f.endsWith('.jsonl') || signal?.aborted || Date.now() > deadline) continue;
      const file = path.join(PROJECTS, dir.name, f);
      const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const line of rl) if (line.toLowerCase().includes(word)) { found.add(file); rl.close(); break; }
    }
  }
  return found;
}

// Words people and Claude wrote, plus file paths and commands Claude used.
function recordTexts(r) {
  if (r.type === 'user') return isHumanPrompt(r) ? [{ who: 'You', text: cleanPrompt(contentText(r.message?.content)) }] : [];
  const parts = Array.isArray(r.message?.content) ? r.message.content : [];
  const out = [];
  const text = contentText(parts);
  if (text.trim()) out.push({ who: 'Claude', text });
  for (const p of parts) {
    if (p.type !== 'tool_use') continue;
    const inp = p.input || {};
    const t = [inp.file_path, inp.notebook_path, inp.command, inp.description, inp.pattern, inp.url, inp.query].filter(Boolean).join(' ');
    if (t) out.push({ who: `Claude used ${p.name}`, text: t });
  }
  return out;
}

// Full-text search of transcripts still on disk (slower, more complete).
export async function deepSearch(query, args = {}, signal) {
  const ws = words(query);
  if (!ws.length) return [];
  // grep for the longest (usually rarest) word, then check the rest while reading.
  const rarest = [...ws].sort((a, b) => b.length - a.length)[0];
  const files = await grepFiles(rarest, signal);
  if (signal?.aborted) return [];
  const index = loadIndex();
  const out = [];
  for (const file of files) {
    if (signal?.aborted) break;
    const id = path.basename(file, '.jsonl');
    const rec = index[id];
    if (rec && filterRecords([rec], args).length === 0) continue;
    const snippets = [];
    const seen = new Set();
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (snippets.length >= 3) { rl.close(); break; }
      if (!line.toLowerCase().includes(rarest)) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (r.type !== 'user' && r.type !== 'assistant') continue;
      for (const { who, text } of recordTexts(r)) {
        const low = text.toLowerCase();
        if (!ws.every((w) => low.includes(w))) continue;
        const sn = snippetAround(text, ws);
        if (seen.has(sn)) continue;
        seen.add(sn);
        snippets.push(`${who} (${fmtWhen(Date.parse(r.timestamp))}): ${sn}`);
        break;
      }
    }
    if (snippets.length) out.push({ id, title: rec?.title || id, project: rec?.project || '', where: rec?.where || '', lastAt: rec?.lastAt || 0, snippets });
  }
  return out.sort((a, b) => b.lastAt - a.lastAt).slice(0, Number(args.limit || 10));
}

export function findRecord(idPrefix) {
  const index = loadIndex();
  const id = String(idPrefix || '');
  if (!id) return { error: 'Give a conversation id (from "recent" or "search").' };
  if (Object.hasOwn(index, id)) return { rec: index[id] };
  const hits = Object.values(index).filter((r) => r.id.startsWith(id) || r.id.startsWith(`claude-ai:${id}`));
  if (hits.length === 1) return { rec: hits[0] };
  if (hits.length > 1) return { error: `${hits.length} conversations start with "${id}". Type more of the id.` };
  return { error: `No conversation has an id starting with "${id}". Use "recent" or "search" to find it.` };
}

// Conversation text (your messages and Claude's written answers, no tool output).
export async function fullConversation(rec, max = 30000) {
  const parts = [];
  if (rec.source === 'claude.ai') {
    const data = readJSON(rec.file, null);
    const list = Array.isArray(data) ? data : data?.conversations || [];
    const conv = list.find((c) => `claude-ai:${c.uuid || c.id}` === rec.id);
    if (!conv) return null;
    const msgs = Array.isArray(conv.chat_messages) ? conv.chat_messages : Array.isArray(conv.messages) ? conv.messages : [];
    for (const m of msgs) {
      if (!m || typeof m !== 'object') continue;
      const text = typeof m.text === 'string' ? m.text : contentText(Array.isArray(m.content) ? m.content : '');
      if (!text) continue;
      const who = (m.sender || m.role) === 'assistant' ? 'Claude' : 'You';
      const at = Date.parse(m.created_at);
      parts.push(`\n## ${who}${Number.isNaN(at) ? '' : ` (${fmtWhen(at)})`}\n${short(text, 3000)}`);
    }
  } else {
    if (!rec.file || !fs.existsSync(rec.file)) return null;
    const rl = readline.createInterface({ input: fs.createReadStream(rec.file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (r.type === 'user' && isHumanPrompt(r)) parts.push(`\n## You (${fmtWhen(Date.parse(r.timestamp))})\n${short(cleanPrompt(contentText(r.message.content)), 3000)}`);
      else if (r.type === 'assistant') {
        const t = contentText(r.message?.content).trim();
        if (t.length > 20) parts.push(`\n## Claude\n${short(t, 2500)}`);
      }
    }
  }
  let text = parts.join('\n');
  if (text.length > max) {
    const half = Math.floor(max / 2);
    text = `${text.slice(0, half)}\n\n[… middle of the conversation left out …]\n\n${text.slice(-half)}`;
  }
  return text;
}

function printRecord(rec) {
  console.log(`${rec.title}`);
  console.log(`  id: ${rec.id}`);
  console.log(`  where: ${rec.where}${rec.project ? ` · project: ${rec.project}` : ''}${rec.branch ? ` · branch: ${rec.branch}` : ''}`);
  if (rec.cwd) console.log(`  folder: ${rec.cwd}`);
  console.log(`  from ${fmtWhen(rec.startedAt)} to ${fmtWhen(rec.lastAt)} · ${rec.promptCount} messages from you · models: ${rec.models.join(', ') || '?'}`);
  if (rec.source === 'claude-code') console.log(`  full transcript ${rec.transcriptKept === false ? 'deleted by Claude Code (summary only)' : 'still on disk'}`);
  const shown = rec.prompts.length > 40 ? [...rec.prompts.slice(0, 20), null, ...rec.prompts.slice(-20)] : rec.prompts;
  console.log('\nYour messages:');
  for (const p of shown) console.log(p ? `  - ${fmtWhen(p.at)}: ${short(p.text, 300)}` : `  … ${rec.prompts.length - 40} more (search finds them; --full shows the conversation) …`);
  if (rec.agents.length) { console.log('\nHelper tasks started:'); for (const a of rec.agents.slice(0, 40)) console.log(`  - ${a}`); }
  if (rec.files.length) { console.log(`\nFiles changed (${rec.files.length}):`); for (const f of rec.files.slice(0, 60)) console.log(`  - ${f}`); }
  if (rec.answers.length) { console.log('\nClaude\'s last answers:'); for (const a of rec.answers) console.log(`  - ${short(a.text, 600)}`); }
}

if (isMain(import.meta)) {
  const args = parseArgs(process.argv.slice(2), { booleans: ['deep', 'full', 'all'], values: ['project'], numbers: ['days', 'limit', 'max'], dates: ['since'] });
  const [cmd, ...rest] = args._;
  if (cmd !== 'import') await updateIndexLocked({});
  if (cmd === 'recent' || !cmd) {
    const list = recent(args);
    if (!list.length) console.log('No conversations found for that time.');
    for (const r of list) console.log(`${fmtWhen(r.lastAt)}  ${r.where.padEnd(10)} ${short(r.project, 24).padEnd(24)} ${r.title}\n    id ${r.id} · last message: ${r.lastPrompt}`);
  } else if (cmd === 'search') {
    const q = rest.join(' ');
    const list = args.deep ? await deepSearch(q, args) : search(q, args);
    if (!list.length) console.log(args.deep ? 'Nothing found in the transcripts on disk.' : 'Nothing found in the index. Try --deep, other words, or a wider --days.');
    for (const r of list) {
      console.log(`${fmtWhen(r.lastAt)}  ${r.where ? `${r.where} · ` : ''}${r.project || ''}  ${r.title}\n    id ${r.id}${r.allWords === false ? ' (some words only)' : ''}`);
      for (const s of r.snippets || [r.snippet]) if (s) console.log(`    ${s}`);
    }
  } else if (cmd === 'show') {
    const { rec, error } = findRecord(rest[0] || '');
    if (!rec) { console.log(error); process.exit(1); }
    printRecord(rec);
    if (args.full) {
      const text = await fullConversation(rec, Number(args.max || 30000));
      console.log(text == null ? '\n(The full conversation is not on disk any more; the summary above is what was kept.)' : `\n# Conversation\n${text}`);
    }
  } else if (cmd === 'import') {
    const src = rest[0];
    if (!src || !fs.existsSync(src)) { console.log('Give the path of conversations.json from the claude.ai export.'); process.exit(1); }
    const buf = fs.readFileSync(src);
    let data = null;
    try { data = JSON.parse(buf.toString('utf8')); } catch { /* checked below */ }
    const list = Array.isArray(data) ? data : Array.isArray(data?.conversations) ? data.conversations : null;
    let readable = [];
    try { readable = list ? summarizeClaudeAiExport(src, data) : []; } catch { readable = []; }
    if (!readable.length) { console.log('This is not conversations.json from the claude.ai export (each chat needs an id and its messages). Nothing was imported.'); process.exit(1); }
    const skipped = list.length - readable.length;
    ensureData();
    fs.mkdirSync(FILES.imports, { recursive: true });
    const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);
    const dest = path.join(FILES.imports, `claude-ai-${new Date().toISOString().slice(0, 10)}-${hash}.json`);
    fs.writeFileSync(dest, buf);
    const res = await updateIndexLocked({});
    console.log(`Imported ${readable.length} chats${skipped > 0 ? ` (${skipped} entries without an id were skipped)` : ''}. The index now has ${res.total} conversations.`);
  } else {
    console.error('Use: recent | search WORDS | show ID [--full] | import FILE');
    process.exit(2);
  }
}
