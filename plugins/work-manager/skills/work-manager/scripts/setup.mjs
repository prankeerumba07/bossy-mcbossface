#!/usr/bin/env node
// Work Manager setup. The plugin itself brings the skill, the helpers and the
// hooks; this script only does the optional, per-computer parts.
//
//   node setup.mjs --check               what is set up on this computer
//   node setup.mjs --terminal-log on     log terminal commands (adds one line to ~/.zshrc, backed up first)
//   node setup.mjs --terminal-log off    remove that line
//   node setup.mjs --remove-old-copy     retire an older non-plugin install (its hooks in
//                                        ~/.claude/settings.json, its helpers in ~/.claude/agents,
//                                        its folder ~/.claude/skills/work-manager → moved to
//                                        ~/.claude/skills/.trash). Your data is kept.
import fs from 'node:fs';
import path from 'node:path';
import {
  CLAUDE_DIR, AGENTS_DIR, SKILL_DIR, HOME, FILES, PLUGIN_ROOT, readJSON, parseArgs, isMain, safeStat,
} from './lib.mjs';
import { dashboardRunning, refreshRuntime, ensureDashboard } from './hook.mjs';

const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const ZSHRC = path.join(HOME, '.zshrc');
const TAG = '_work_manager';
const OLD_AGENTS = ['wm-quick', 'wm-worker', 'wm-expert', 'wm-checker', 'wm-expert-checker'];
const OLD_SKILL = path.join(CLAUDE_DIR, 'skills', 'work-manager');
const ZSH_START = '# >>> work-manager terminal log >>>';
const ZSH_END = '# <<< work-manager terminal log <<<';
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// An older copy's hook: tagged by its installer, or (when Claude Code rewrote
// settings.json and dropped the tag) recognised by the script it runs.
const OLD_HOOK_CMD = /[\\/]\.claude[\\/]skills[\\/]work-manager[\\/]scripts[\\/]hook\.mjs/;
export const isOldHookGroup = (g) => !!g && (g[TAG] || ((g.hooks || []).length > 0 && (g.hooks || []).every((h) => OLD_HOOK_CMD.test(h.command || ''))));
const BLOCK_RE = new RegExp(`\\n?\\n?${esc(ZSH_START)}[\\s\\S]*?${esc(ZSH_END)}\\n?`);

function readSettings() {
  if (!fs.existsSync(SETTINGS)) return {};
  try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch {
    throw new Error(`${SETTINGS} is not valid JSON, so nothing was changed. Fix it first.`);
  }
}

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const to = `${file}.bak.work-manager-${stamp()}`;
  fs.copyFileSync(file, to);
  return to;
}

function zshrcText() { return fs.existsSync(ZSHRC) ? fs.readFileSync(ZSHRC, 'utf8') : ''; }

function terminalLogOn() {
  refreshRuntime(true);
  const runtimeScript = path.join(FILES.runtime, 'terminal-log.zsh');
  const block = `${ZSH_START}\n[ -f "${runtimeScript}" ] && source "${runtimeScript}"\n${ZSH_END}\n`;
  const text = zshrcText();
  if (text.includes(ZSH_START)) {
    if (text.includes(runtimeScript)) return console.log('The terminal log is already on.');
    // An older line pointed at a copy that can move; point it at the stable copy.
    const b = backup(ZSHRC);
    fs.writeFileSync(ZSHRC, text.replace(BLOCK_RE, `\n${block}`));
    return console.log(`Terminal log line updated (backup: ${b}). Open a new terminal tab to use it.`);
  }
  const b = backup(ZSHRC);
  fs.appendFileSync(ZSHRC, `${text && !text.endsWith('\n') ? '\n' : ''}\n${block}`);
  console.log(`Terminal log turned on${b ? ` (backup: ${b})` : ''}. Open a new terminal tab to use it.`);
}

function terminalLogOff() {
  const text = zshrcText();
  if (!text.includes(ZSH_START)) return console.log('The terminal log is already off.');
  const b = backup(ZSHRC);
  fs.writeFileSync(ZSHRC, text.replace(BLOCK_RE, '\n'));
  console.log(`Terminal log turned off (backup: ${b}). Open terminal tabs keep logging until they are closed.`);
}

function oldCopy() {
  const s = readSettings();
  const hooks = Object.values(s.hooks || {}).flat().filter(isOldHookGroup).length;
  const agents = OLD_AGENTS.filter((a) => fs.existsSync(path.join(AGENTS_DIR, `${a}.md`)));
  const folder = fs.existsSync(path.join(OLD_SKILL, 'SKILL.md')) && path.resolve(OLD_SKILL) !== path.resolve(SKILL_DIR) ? OLD_SKILL : null;
  return { hooks, agents, folder };
}

function removeOldCopy() {
  const { hooks, agents, folder } = oldCopy();
  if (!hooks && !agents.length && !folder) return console.log('No older copy found. Nothing to remove.');
  if (!PLUGIN_ROOT) throw new Error('Run this from the plugin copy of Work Manager, so something is still running afterwards.');
  if (hooks) {
    const s = readSettings();
    const b = backup(SETTINGS);
    const out = {};
    for (const [ev, groups] of Object.entries(s.hooks || {})) {
      const kept = (groups || []).filter((g) => !isOldHookGroup(g));
      if (kept.length) out[ev] = kept;
    }
    s.hooks = out;
    const tmp = `${SETTINGS}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
    JSON.parse(fs.readFileSync(tmp, 'utf8'));
    fs.renameSync(tmp, SETTINGS);
    console.log(`Removed ${hooks} old hook groups from ~/.claude/settings.json (backup: ${b}).`);
  }
  // Nothing is deleted: old helpers and the old folder go to the trash folder.
  const trash = path.join(CLAUDE_DIR, 'skills', '.trash', `work-manager-${stamp()}`);
  if (agents.length) {
    fs.mkdirSync(path.join(trash, 'agents'), { recursive: true });
    for (const a of agents) fs.renameSync(path.join(AGENTS_DIR, `${a}.md`), path.join(trash, 'agents', `${a}.md`));
    console.log(`Moved old helpers (${agents.join(', ')}) to ${path.join(trash, 'agents')}.`);
  }
  if (folder) {
    fs.mkdirSync(trash, { recursive: true });
    fs.renameSync(folder, path.join(trash, 'skill'));
    console.log(`Moved the old skill folder to ${path.join(trash, 'skill')} (delete it later if you like).`);
  }
  if (zshrcText().includes(ZSH_START)) terminalLogOn();
  try { ensureDashboard(); } catch { /* it starts with the next conversation */ }
  console.log('Done. Your history, plans and settings in ~/.claude/work-manager are unchanged.');
}

function check() {
  const s = readSettings();
  const index = readJSON(FILES.index, {});
  const d = dashboardRunning();
  const seen = readJSON(FILES.pluginSeen, null);
  const old = oldCopy();
  const zsh = zshrcText();
  const cfg = readJSON(FILES.config, {});
  console.log(`Running from:      ${PLUGIN_ROOT ? `plugin (${PLUGIN_ROOT})` : SKILL_DIR}`);
  console.log(`Plugin hooks:      ${seen && Date.now() - seen.at < 3 * 864e5 ? `active (last start ${new Date(seen.at).toLocaleString()})` : 'not seen yet (start a new Claude Code conversation)'}`);
  if (old.hooks || old.agents.length || old.folder) {
    console.log(`Older copy:        ${[old.hooks && `${old.hooks} hook groups in settings.json`, old.agents.length && `${old.agents.length} helpers in ~/.claude/agents`, old.folder && old.folder].filter(Boolean).join(', ')} — it stands down while the plugin runs; remove it with --remove-old-copy`);
  }
  console.log(`History index:     ${Object.keys(index).length} conversations`);
  console.log(`Dashboard:         ${d ? `running at http://127.0.0.1:${d.port}` : 'not running (starts with the next conversation)'}`);
  console.log(`Terminal log:      ${zsh.includes(ZSH_START) ? 'on' : 'off'}${cfg.terminalLogFullCommands ? ' (full command lines)' : ''}`);
  console.log(`Keep transcripts:  ${s.cleanupPeriodDays ? `${s.cleanupPeriodDays} days` : '30 days (Claude Code default)'}`);
  console.log(`Data folder:       ${path.dirname(FILES.index)}${safeStat(FILES.events) ? '' : ' (no activity recorded yet)'}`);
}

if (isMain(import.meta)) {
  const args = parseArgs(process.argv.slice(2), { booleans: ['check', 'remove-old-copy'], values: ['terminal-log'] });
  if (args._.length) { console.error(`Unexpected word "${args._[0]}". Use --check, --terminal-log on|off or --remove-old-copy. Nothing was changed.`); process.exit(2); }
  try {
    if (args['terminal-log'] === 'on') terminalLogOn();
    else if (args['terminal-log'] === 'off') terminalLogOff();
    else if (args['terminal-log']) { console.error('Use --terminal-log on or --terminal-log off.'); process.exit(2); }
    else if (args['remove-old-copy']) removeOldCopy();
    else check();
  } catch (e) { console.error(e.message); process.exit(1); }
}
