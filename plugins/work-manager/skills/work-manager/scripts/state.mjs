// Puts together everything the dashboard and status.mjs show: open Claude
// conversations, their helper agents, the plan board, terminals and what
// needs your attention.
import fs from 'node:fs';
import path from 'node:path';
import {
  FILES, readJSON, readTail, readEvents, transcriptPath, transcriptActivity, agentDefinitionModel,
  modelLabel, modelFamily, FRIENDLY_AGENT, friendlyAgent, baseAgentType, short, safeStat, safeReaddir, contentText,
} from './lib.mjs';
import { snapshot } from './terminals.mjs';

const DAY = 864e5;
const STUCK_MS = 15 * 60e3;
const RESULT_MAX = 6000;
const ATTENTION_NTYPES = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']);
const CHECKERS = new Set(['wm-checker', 'wm-expert-checker']);
const isAgentTool = (t) => t === 'Agent' || t === 'Task';

// Where a conversation keeps its files: next to its transcript, in a folder
// named after the session. Taken from the transcript path the hooks report,
// not from the current folder (which changes after a `cd`).
const sessionDirCache = new Map();
function sessionDir(sid, cwd, tp) {
  if (sessionDirCache.has(sid)) return sessionDirCache.get(sid);
  const file = tp && fs.existsSync(tp) ? tp : transcriptPath(sid, cwd);
  const dir = file ? path.join(path.dirname(file), sid) : null;
  if (dir) sessionDirCache.set(sid, dir);
  return dir;
}

// A helper's files: subagents/agent-<id>.* or, for workflow helpers,
// subagents/workflows/<run>/agent-<id>.*
const agentBaseCache = new Map();
function agentBase(sid, cwd, tp, aid) {
  if (!aid) return null;
  if (agentBaseCache.has(aid)) return agentBaseCache.get(aid);
  const dir = sessionDir(sid, cwd, tp);
  if (!dir) return null;
  const sub = path.join(dir, 'subagents');
  const candidates = [path.join(sub, `agent-${aid}`)];
  for (const wf of safeReaddir(path.join(sub, 'workflows'))) candidates.push(path.join(sub, 'workflows', wf, `agent-${aid}`));
  const found = candidates.find((b) => fs.existsSync(`${b}.jsonl`) || fs.existsSync(`${b}.meta.json`)) || null;
  if (found) agentBaseCache.set(aid, found);
  return found;
}

const finishedCache = new Map();
// Full final report and step count of a finished helper, read once.
function finishedDetails(file) {
  if (finishedCache.has(file)) return finishedCache.get(file);
  let text = '', steps = 0, model = '', structured = null;
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"assistant"')) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (r.type !== 'assistant' || !r.message) continue;
      if (r.message.model && r.message.model !== '<synthetic>') model = r.message.model;
      const parts = Array.isArray(r.message.content) ? r.message.content : [];
      steps += parts.filter((p) => p.type === 'tool_use').length;
      const t = contentText(parts).trim();
      if (t) text = t;
      // Workflow helpers hand back their answer as structured data.
      const so = parts.find((p) => p.type === 'tool_use' && p.name === 'StructuredOutput');
      if (so) structured = so.input;
    }
  } catch { /* unreadable */ }
  if (structured && text.length < 40) text = `Sent back as structured data:\n${JSON.stringify(structured, null, 1)}`;
  const out = { text: text.length > RESULT_MAX ? `${text.slice(0, RESULT_MAX)}\n[… cut here; the full report is in the helper's transcript]` : text, steps, model };
  finishedCache.set(file, out);
  // Drop the oldest entries only, so a busy day does not make every refresh re-read all transcripts.
  while (finishedCache.size > 5000) finishedCache.delete(finishedCache.keys().next().value);
  return out;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
}
function pct(xs, p) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null;
}

// "<task-notification>" notices tell how a background helper ended.
const NOTICE_STATUS = { completed: 'reported', failed: 'failed', killed: 'stopped', stopped: 'stopped' };

// Every helper agent seen in the events log, with its status.
function collectAgents(events) {
  const recs = [];
  const byTuid = new Map(), byAid = new Map();
  const add = (rec) => { recs.push(rec); if (rec.tuid) byTuid.set(rec.tuid, rec); if (rec.aid) byAid.set(rec.aid, rec); return rec; };
  const meta = (e, aid) => {
    const base = agentBase(e.sid, e.cwd, e.tp, aid);
    return base ? readJSON(`${base}.meta.json`, {}) : {};
  };
  const linkAid = (rec, aid) => {
    const other = byAid.get(aid);
    if (other && other !== rec) { other.merged = true; rec.startedAt = Math.min(rec.startedAt, other.startedAt); }
    rec.aid = aid;
    byAid.set(aid, rec);
  };
  const finish = (rec, ts, status, extra = {}) => {
    if (rec.status !== 'working') return;
    Object.assign(rec, { status, endedAt: ts, durMs: ts - rec.startedAt }, extra);
  };
  for (const e of events) {
    if (e.ev === 'PreToolUse' && isAgentTool(e.tool)) {
      const tag = (e.prompt || '').match(/\bwm:([\w-]+)\/([\w-]+)/);
      add({
        key: e.tuid, tuid: e.tuid, aid: null, sid: e.sid, cwd: e.cwd, tp: e.tp, parentAid: e.aid || null,
        label: e.desc || 'Helper', type: e.stype, reqModel: e.model, bg: e.bg, prompt: e.prompt,
        startedAt: e.ts, endedAt: null, status: 'working', plan: tag?.[1] || null, task: tag?.[2] || null,
      });
    } else if (e.ev === 'SubagentStart' && e.aid && e.atype) {
      if (byAid.has(e.aid)) continue;
      const m = meta(e, e.aid);
      const rec = m.toolUseId && byTuid.get(m.toolUseId);
      if (rec) { linkAid(rec, e.aid); continue; }
      add({
        key: e.aid, tuid: m.toolUseId || null, aid: e.aid, sid: e.sid, cwd: e.cwd, tp: e.tp, parentAid: null,
        label: m.description || m.label || friendlyAgent(e.atype), type: e.atype, reqModel: '',
        startedAt: e.ts, endedAt: null, status: 'working', plan: null, task: null, workflow: e.atype === 'workflow-subagent',
      });
    } else if (e.ev === 'PostToolUse' && isAgentTool(e.tool)) {
      const rec = byTuid.get(e.tuid);
      if (!rec) continue;
      if (e.agentId) linkAid(rec, e.agentId);
      if (e.status === 'async_launched') { rec.bg = true; continue; }
      const ok = e.status === 'completed' || !e.status;
      finish(rec, e.ts, ok ? 'reported' : 'failed', {
        durMs: e.dur ?? e.ts - rec.startedAt, model: e.rmodel || rec.model, result: e.result,
        tokens: e.tokens, toolCount: e.tools, error: ok ? '' : `Ended with status "${e.status}"`,
      });
    } else if (e.ev === 'PostToolUseFailure' && isAgentTool(e.tool)) {
      const rec = byTuid.get(e.tuid);
      if (rec) finish(rec, e.ts, e.interrupt ? 'stopped' : 'failed', { error: e.interrupt ? 'Stopped by you' : e.error });
    } else if (e.ev === 'SubagentStop' && e.aid) {
      const rec = byAid.get(e.aid);
      if (!rec) continue;
      rec.tpath = e.tpath || rec.tpath;
      finish(rec, e.ts, 'reported', { result: rec.result || e.last });
    } else if (e.ev === 'UserPromptSubmit' && e.tn) {
      const rec = (e.tn.tuid && byTuid.get(e.tn.tuid)) || byAid.get(e.tn.id);
      const status = NOTICE_STATUS[e.tn.status];
      if (!rec || !status) continue;
      if (rec.status === 'working') finish(rec, e.ts, status, { error: status === 'failed' ? 'The helper failed' : status === 'stopped' ? 'Stopped before it finished' : '' });
      else if (status !== 'reported' && rec.status === 'reported') Object.assign(rec, { status, error: status === 'failed' ? 'The helper failed' : 'Stopped before it finished' });
    }
  }
  return recs.filter((r) => !r.merged);
}

// Usual time for this kind of helper: same helper and model first, then the
// same helper, then the same model. Workflow helpers (long multi-step runs)
// and ordinary helpers are never mixed.
function etaFor(r, finished, elapsed) {
  const fam = modelFamily(r.modelId);
  const sameKind = finished.filter((f) => !!f.workflow === !!r.workflow);
  const pools = [
    sameKind.filter((f) => baseAgentType(f.type) === baseAgentType(r.type) && modelFamily(f.modelId) === fam),
    sameKind.filter((f) => baseAgentType(f.type) === baseAgentType(r.type)),
    sameKind.filter((f) => modelFamily(f.modelId) === fam),
  ];
  const at = pools.findIndex((p) => p.length >= 3);
  if (at < 0) {
    const need = 3 - pools[0].length;
    return { eta: null, etaNote: `no estimate yet (${need} more finished ${FRIENDLY_AGENT[baseAgentType(r.type)] || 'helper'}${need > 1 ? 's' : ''} on ${modelLabel(r.modelId) || 'this model'} needed)`, progress: null };
  }
  const pool = pools[at];
  const xs = pool.map((f) => f.durMs);
  const rough = at > 0 ? 'rough guess: ' : '';
  const med = median(xs), p80 = pct(xs, 0.8);
  const progress = Math.min(0.95, elapsed / Math.max(med, 1));
  if (elapsed < med) {
    const eta = med - elapsed;
    const left = eta < 60e3 ? 'under 1 min' : `about ${Math.round(eta / 60e3)} min`;
    return { eta, etaNote: `${rough}${left} left (usual ${med < 60e3 ? `${Math.round(med / 1000)} s` : `${Math.round(med / 60e3)} min`})`, progress };
  }
  return { eta: 0, etaNote: elapsed < p80 * 1.5 ? `${rough}should finish soon` : 'taking longer than usual', progress };
}

export function buildState({ term } = {}) {
  const now = Date.now();
  const t = term || snapshot();
  const sessions = t.claudeSessions;
  const liveSids = new Set(sessions.map((s) => s.sessionId));
  const sessionById = new Map(sessions.map((s) => [s.sessionId, s]));
  const events = readEvents(4 * 1024 * 1024);

  // Helper agents
  const all = collectAgents(events);
  for (const r of all) {
    const base = agentBase(r.sid, r.cwd, r.tp, r.aid);
    const file = (r.tpath && fs.existsSync(r.tpath) && r.tpath) || (base && fs.existsSync(`${base}.jsonl`) ? `${base}.jsonl` : null);
    if (r.status === 'working') {
      const act = file ? transcriptActivity(file) : {};
      r.modelId = r.model || act.model || r.reqModel || agentDefinitionModel(r.type) || sessionById.get(r.sid)?.model || '';
      r.doing = act.doing || 'Starting up';
      r.lastActivityAt = Math.max(act.mtime || 0, r.startedAt);
      if (!liveSids.has(r.sid)) { r.status = 'stopped'; r.error = 'Its conversation was closed before it finished'; r.endedAt = r.lastActivityAt; }
      else if (now - r.lastActivityAt > STUCK_MS) r.stuck = true;
    } else {
      const d = file ? finishedDetails(file) : {};
      r.modelId = r.model || d.model || r.reqModel || agentDefinitionModel(r.type) || sessionById.get(r.sid)?.model || '';
      if (d.text && d.text.length > (r.result || '').length) r.result = d.text;
      if (r.toolCount == null && d.steps) r.toolCount = d.steps;
    }
  }
  const finished = all.filter((r) => r.status === 'reported' && r.durMs > 0);
  const agents = all
    .filter((r) => r.status === 'working' || (r.endedAt && now - r.endedAt < DAY))
    .map((r) => {
      const elapsed = r.durMs ?? (r.endedAt || now) - r.startedAt;
      const est = r.status === 'working' ? etaFor(r, finished, elapsed) : { eta: null, etaNote: '', progress: null };
      return {
        key: r.key, sid: r.sid, parentAid: r.parentAid, aid: r.aid, label: r.label, type: r.type,
        typeName: r.workflow ? 'Workflow helper' : friendlyAgent(r.type), model: modelLabel(r.modelId) || 'Same as main', modelFamily: modelFamily(r.modelId),
        status: r.status, stuck: !!r.stuck, background: !!r.bg, doing: r.doing || '', startedAt: r.startedAt, endedAt: r.endedAt,
        elapsed, eta: est.eta, etaNote: est.etaNote, progress: est.progress, result: r.result || '', error: r.error || '',
        tokens: r.tokens ?? null, toolCount: r.toolCount ?? null, plan: r.plan, task: r.task, checker: CHECKERS.has(baseAgentType(r.type)),
        project: path.basename(r.cwd || ''), lastActivityAt: r.lastActivityAt || null,
      };
    })
    .sort((a, b) => (a.status === 'working' ? 0 : 1) - (b.status === 'working' ? 0 : 1) || b.startedAt - a.startedAt);

  // Main agents (open conversations)
  const lastBySid = new Map();
  for (const e of events) {
    if (!e.sid) continue;
    const s = lastBySid.get(e.sid) || {};
    if (e.ev === 'UserPromptSubmit') {
      if (!e.auto) { s.prompt = e.prompt; s.promptAt = e.ts; s.failed = null; s.failedAt = null; }
      s.clearAt = e.ts;
    } else if (e.ev === 'Stop') { s.clearAt = e.ts; s.failed = null; s.failedAt = null; }
    else if (e.ev === 'PostToolUse') s.clearAt = e.ts;
    else if (e.ev === 'Notification' && ATTENTION_NTYPES.has(e.ntype)) { s.ask = e.msg; s.askAt = e.ts; }
    else if (e.ev === 'StopFailure') { s.failed = e.error || 'API error'; s.failedAt = e.ts; }
    else if (e.ev === 'Route') s.route = { level: e.level, model: e.model, main: modelLabel(e.main), noted: e.noted, steps: e.steps || null, at: e.ts };
    lastBySid.set(e.sid, s);
  }
  const main = sessions.map((s) => {
    const ev = lastBySid.get(s.sessionId) || {};
    const asking = ev.askAt && ev.askAt > (ev.clearAt || 0) && (s.lastActivityAt || 0) < ev.askAt + 3000;
    const helpersWorking = agents.filter((a) => a.sid === s.sessionId && a.status === 'working').length;
    let status = asking ? 'needs-you' : s.status === 'busy' || helpersWorking ? 'working' : 'idle';
    let doing = s.status === 'busy' ? s.doing : '';
    if (!asking && helpersWorking && (s.status !== 'busy' || /^(Writing its answer|Starting a helper)/.test(doing || ''))) {
      doing = `Waiting for ${helpersWorking} helper${helpersWorking > 1 ? 's' : ''} to finish`;
    }
    return {
      sid: s.sessionId, name: s.name || 'Untitled conversation', where: s.where, project: s.project, cwd: s.cwd,
      model: modelLabel(s.model), status, ask: asking ? ev.ask : '', askSince: asking ? ev.askAt : null,
      lastPrompt: ev.prompt || '', lastPromptAt: ev.promptAt || null,
      doing, lastActivityAt: s.lastActivityAt, startedAt: s.startedAt, tty: s.tty, route: ev.route || null,
      agents: agents.filter((a) => a.sid === s.sessionId).map((a) => a.key),
    };
  });

  // Plan board
  const board = readJSON(FILES.board, { plans: [] });
  const open = (tk) => ['failed', 'needs-you'].includes(tk.status);
  const plans = (Array.isArray(board.plans) ? board.plans : [])
    .filter((p) => p && (p.status !== 'closed' || now - (p.closed || 0) < DAY || (now - (p.closed || 0) < 7 * DAY && (p.tasks || []).some(open))))
    .slice(-12)
    .map((p) => ({
      ...p,
      tasks: (p.tasks || []).map((tk) => {
        const linked = agents.filter((a) => a.plan === p.id && a.task === tk.id).sort((a, b) => b.startedAt - a.startedAt);
        const doer = linked.find((a) => !a.checker);
        // A check only counts if it started after the latest try of the work and,
        // when the board was set back to 'working' (a retry), after that too.
        const since = Math.max(doer?.startedAt || 0, tk.status === 'working' ? tk.statusAt || 0 : 0);
        const checker = linked.find((a) => a.checker && a.startedAt >= since);
        // The board says what the main agent decided; helpers show what is happening
        // in between (a retry after a failed check, a check that has finished).
        let live = tk.status;
        if (['planned', 'working', 'checking'].includes(tk.status)) {
          if (checker) live = checker.status === 'working' ? 'checking' : checker.status === 'reported' ? 'checked' : checker.status;
          else if (doer && (tk.status !== 'checking' || doer.status === 'working')) live = doer.status;
        }
        const shown = doer || checker;
        return {
          ...tk, live, agentKey: shown?.key || null, checkerKey: checker?.key || null,
          agentModel: doer?.model || modelLabel(tk.model), checkerModel: checker?.model || '',
          eta: (checker?.status === 'working' ? checker.etaNote : doer?.status === 'working' ? doer.etaNote : '') || '',
          tries: Math.max(tk.attempts || 0, linked.filter((a) => !a.checker).length),
          elapsed: doer?.elapsed ?? null, doerWorkingSince: doer?.status === 'working' ? doer.startedAt : null,
        };
      }),
    }))
    .reverse();

  // Needs your attention
  const attention = [];
  for (const m of main) if (m.status === 'needs-you') attention.push({ kind: 'ask', text: `"${m.name}" is waiting for you: ${m.ask || 'it asked a question'}`, where: `${m.where} · ${m.project}`, at: m.askSince });
  for (const a of agents) {
    if (a.status === 'failed') attention.push({ kind: 'failed', text: `Helper "${a.label}" failed: ${short(a.error, 160)}`, where: a.project, at: a.endedAt });
    if (a.stuck) attention.push({ kind: 'stuck', text: `Helper "${a.label}" has done nothing for ${Math.round((now - a.lastActivityAt) / 60e3)} min`, where: a.project, at: a.lastActivityAt });
  }
  for (const p of plans) for (const tk of p.tasks) {
    if (open(tk)) attention.push({ kind: tk.status, text: `Plan "${p.title}": task "${tk.title}" ${tk.status === 'failed' ? 'failed' : 'needs your decision'}${tk.notes?.length ? ` — ${short(tk.notes[tk.notes.length - 1].text, 140)}` : ''}`, where: path.basename(p.cwd || ''), at: tk.ended || p.created });
  }
  for (const [sid, ev] of lastBySid) if (ev.failedAt && now - ev.failedAt < 6 * 3600e3) attention.push({ kind: 'failed', text: `A conversation stopped with an error: ${short(ev.failed, 160)}`, where: sessionById.get(sid)?.project || '', at: ev.failedAt });
  for (const f of t.failures) attention.push({ kind: 'terminal', text: `Command failed (exit ${f.exit}): ${short(f.cmd, 120)}`, where: f.cwd, at: f.at });
  attention.sort((a, b) => (b.at || 0) - (a.at || 0));

  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const brief = readJSON(FILES.brief, { recent: [] });
  return {
    at: now,
    counts: {
      conversations: main.length,
      working: agents.filter((a) => a.status === 'working').length,
      doneToday: agents.filter((a) => a.status === 'reported' && a.endedAt >= startOfDay.getTime()).length,
      failed: agents.filter((a) => a.status === 'failed' && a.endedAt >= startOfDay.getTime()).length,
      stopped: agents.filter((a) => a.status === 'stopped' && a.endedAt >= startOfDay.getTime()).length,
      attention: attention.length,
    },
    main, agents, plans, attention,
    terminals: t.terminals, terminalLogOn: t.logOn,
    recent: brief.recent || [],
    eventsSeen: !!(safeStat(FILES.events) || safeStat(FILES.eventsOld)),
  };
}
