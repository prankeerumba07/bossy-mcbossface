#!/usr/bin/env node
// One-screen overview for the main agent: open conversations, helpers,
// plans, terminals and what needs the user.   node status.mjs [--json]
import { buildState } from './state.mjs';
import { short, fmtDuration, fmtWhen, parseArgs, isMain } from './lib.mjs';

export function statusText(s) {
  const L = [];
  const c = s.counts;
  L.push(`Open conversations: ${c.conversations} · helpers working: ${c.working} · finished today: ${c.doneToday} · failed today: ${c.failed}${c.stopped ? ` · stopped today: ${c.stopped}` : ''} · needs you: ${c.attention}`);
  if (s.attention.length) {
    L.push('\nNeeds your attention:');
    for (const a of s.attention.slice(0, 10)) L.push(`- ${a.text}${a.where ? ` (${a.where})` : ''}`);
  }
  L.push('\nConversations (main agents):');
  for (const m of s.main) {
    L.push(`- "${m.name}" · ${m.where} · ${m.project} · ${m.model || '?'} · ${m.status}${m.doing ? ` · ${m.doing}` : ''}${m.lastPrompt ? ` · last ask: ${short(m.lastPrompt, 80)}` : ''}`);
    for (const a of s.agents.filter((x) => x.sid === m.sid)) {
      L.push(`    · ${a.typeName} "${a.label}" · ${a.model} · ${a.status}${a.status === 'working' ? ` ${fmtDuration(a.elapsed)} · ${a.doing} · ${a.etaNote}` : ` in ${fmtDuration(a.elapsed)}`}`);
    }
  }
  for (const p of s.plans.filter((x) => x.status !== 'closed')) {
    L.push(`\nPlan ${p.id} "${p.title}":`);
    for (const t of p.tasks) L.push(`  ${t.id} [${t.live}] ${t.title} · ${t.agentModel || t.agent || ''}${t.eta ? ` · ${t.eta}` : ''}`);
  }
  L.push(`\nTerminals: ${s.terminals.length}`);
  for (const t of s.terminals) L.push(`- ${t.app} ${t.tty} · ${t.cwd} · ${t.running ? `running ${fmtDuration(t.running.elapsed)}: ${short(t.running.cmd, 80)}` : 'idle'}`);
  if (s.recent.length) {
    L.push('\nRecent conversations:');
    for (const r of s.recent.slice(0, 6)) L.push(`- ${fmtWhen(r.lastAt)} · ${r.where} · ${r.project} · "${short(r.title, 60)}"`);
  }
  return L.join('\n');
}

if (isMain(import.meta)) {
  const args = parseArgs(process.argv.slice(2), { booleans: ['json'] });
  if (args._.length) { console.error(`Unexpected word "${args._[0]}". Options start with --.`); process.exit(2); }
  const s = buildState();
  console.log(args.json ? JSON.stringify(s, null, 1) : statusText(s));
}
