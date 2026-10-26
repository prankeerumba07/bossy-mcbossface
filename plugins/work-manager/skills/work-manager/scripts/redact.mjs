#!/usr/bin/env node
// What the terminal log keeps of a command. terminal-log.zsh runs this in the
// background for each command:
//   print -r -- "$cmd" | node redact.mjs run TS PID TTY APP CWD SEQ LOGFILE
// The raw command arrives on stdin and never touches the disk.
//
// By default only the command words are kept: the program and up to two plain
// sub-command words per step, e.g. "npm run build", "git push origin",
// "echo | docker login". Arguments, where passwords and tokens live, are
// dropped. With "terminalLogFullCommands": true in config.json the whole
// command is kept with common secret forms replaced by *** (redact below);
// unusual forms can slip through that mode.
import fs from 'node:fs';
import { isMain, config } from './lib.mjs';

const M = '***';

// ---- Command words (default) ----

// Split a command line into steps and the operators between them, keeping
// quoted text, backslash escapes, $(...) and backticks together, joining
// continued lines, and leaving out here-document bodies.
function steps(line) {
  let text = String(line).replace(/\\\r?\n/g, ' ');
  if (/<<-?\s*['"]?\w/.test(text.split('\n')[0])) text = text.split('\n')[0];
  const out = [];
  let cur = '', q = null, depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && q !== "'") { cur += c + (text[i + 1] ?? ''); i++; continue; }
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; cur += c; continue; }
    if (c === '$' && text[i + 1] === '(') { depth++; cur += '$('; i++; continue; }
    if (c === '(' && depth) { depth++; cur += c; continue; }
    if (c === ')' && depth) { depth--; cur += c; continue; }
    if (depth) { cur += c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) break;
    const two = text.slice(i, i + 2);
    if (two === '&&' || two === '||') { out.push(cur, two); cur = ''; i++; continue; }
    if (c === '|' || c === ';' || c === '&' || c === '\n') { out.push(cur, c); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function words(step) {
  return step.trim().match(/(?:\\.|[^\s"'`\\]+|"(?:[^"\\]|\\.)*"?|'[^']*'?|`[^`]*`?)+/g) || [];
}

// Wrappers run another program; their options may take a value.
const WRAPPERS = { sudo: 'ugpChUrtD', env: 'uSCP', time: 'of', nohup: '', exec: 'a', command: '', builtin: '', nice: 'n', caffeinate: 'tw', doas: 'uC', noglob: '', nocorrect: '' };
const BUILTINS = new Set(['cd', 'echo', 'printf', 'print', 'read', 'export', 'set', 'unset', 'source', '.', 'eval', 'alias', 'exit', 'true', 'false', 'test', '[', '[[', 'pwd', 'pushd', 'popd', 'history', 'fg', 'bg', 'jobs', 'kill', 'wait', 'type', 'which', 'where', 'whence', 'hash', 'rehash', 'umask', 'ulimit', 'trap', 'shift', 'local', 'typeset', 'declare', 'setopt', 'unsetopt', 'autoload', 'bindkey', 'zle', 'for', 'while', 'if', 'case', 'function', 'time', 'yes']);
// Never show arguments of these: what follows is often private.
const NO_ARGS = new Set(['echo', 'printf', 'print', 'read', 'export', 'set', 'source', '.', 'eval', 'alias', 'unset', 'yes', 'cd', 'cat', 'less', 'more', 'open', 'ssh', 'scp', 'sftp', 'curl', 'wget', 'http', 'https', 'mysql', 'psql', 'mongosh', 'redis-cli', 'sshpass', 'security']);
// Programs whose next words are sub-commands worth showing (npm run build, git push origin).
const MULTI = new Set(['git', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'docker', 'podman', 'kubectl', 'helm', 'gh', 'cargo', 'go', 'brew', 'pip', 'pip3', 'uv', 'poetry', 'make', 'just', 'terraform', 'aws', 'gcloud', 'az', 'firebase', 'vercel', 'netlify', 'expo', 'eas', 'xcodebuild', 'swift', 'flutter', 'dart', 'mvn', 'gradle', 'dotnet', 'rails', 'bundle', 'rake', 'composer', 'php', 'claude', 'code', 'deno', 'turbo', 'nx', 'pytest', 'jest', 'vitest', 'tsc', 'eslint', 'prettier', 'gem', 'conda']);
// Script runners: show the script's file name (python3 manage.py).
const RUNNERS = new Set(['python', 'python3', 'node', 'ruby', 'perl', 'bash', 'sh', 'zsh', 'tsx', 'ts-node', 'php']);
const SENSITIVE = /^(login|logout|auth|authenticate|authtoken|password|passwd|passphrase|token|tokens|secret|secrets|key|keys|unlock|add-authtoken|credentials?|signin|sign-in|obscure|encrypt_string|encrypt|decrypt|config|configure|env|set|setenv)$/;
const PLAIN = /^[a-z][a-z0-9._:-]{0,30}$/;
const plainWord = (w) => PLAIN.test(w) && (w.match(/\d/g) || []).length <= 2;

function isCommand(name, cwd) {
  if (BUILTINS.has(name) || name in WRAPPERS) return true;
  if (name.includes('/')) {
    const p = name.startsWith('/') ? name : `${cwd || process.cwd()}/${name}`;
    try { return fs.statSync(p).isFile(); } catch { return false; }
  }
  if (!/^[A-Za-z0-9._+-]+$/.test(name)) return false;
  for (const dir of String(process.env.PATH || '').split(':')) {
    if (dir && fs.existsSync(`${dir}/${name}`)) return true;
  }
  return false;
}

function stepWords(step, cwd) {
  const ws = words(step);
  const shown = [];
  let i = 0;
  const skipAssignments = () => { while (i < ws.length && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(ws[i])) i++; };
  skipAssignments();
  while (i < ws.length && ws[i] in WRAPPERS) {
    const valued = WRAPPERS[ws[i]];
    shown.push(ws[i]);
    i++;
    while (i < ws.length && ws[i].startsWith('-')) {
      const opt = ws[i];
      i++;
      // -u NAME (value in the next word) for options that take one
      if (/^-[A-Za-z]$/.test(opt) && valued.includes(opt[1])) i++;
    }
    skipAssignments();
  }
  if (i >= ws.length) return shown.join(' ');
  const raw = ws[i].replace(/^["']|["']$/g, '');
  const name = raw.split('/').pop();
  // Only a real program name is kept; anything else (a pasted password, a typo) becomes "…".
  if (!raw || /[$`=()\\]/.test(raw) || !isCommand(raw, cwd)) { shown.push('…'); return shown.join(' '); }
  shown.push(name);
  if (NO_ARGS.has(name)) return shown.join(' ');
  const next = ws[i + 1];
  if (RUNNERS.has(name)) {
    if (next && /^[A-Za-z0-9._/-]+\.(py|js|mjs|cjs|ts|rb|pl|sh|zsh|php)$/.test(next) && !/\d{3,}/.test(next)) shown.push(next.split('/').pop());
    return shown.join(' ');
  }
  if (!MULTI.has(name)) return shown.join(' ');
  for (let k = i + 1, n = 0; k < ws.length && n < 2; k++, n++) {
    const w = ws[k];
    if (!plainWord(w)) break;
    shown.push(w);
    if (SENSITIVE.test(w)) break;
  }
  return shown.join(' ');
}

export function summarize(command, cwd) {
  return steps(String(command ?? '')).map((part, idx) => (idx % 2 ? part : stepWords(part, cwd)))
    .join(' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

// ---- Full command with secrets hidden (opt-in) ----

const SECRET_END = '(?:pass(?:word|wd|phrase)?|pwd|pw|secret|token|key|apikey|credentials?|cookie|session|sid|auth|signature|sig)';
const HEADER_END = '(?:pass(?:word|wd|phrase)?|pwd|secret|token|key|apikey|credentials?|cookie|auth-token|signature)';
const VAL = `(?:"(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^\\s"'&,;}]+)`;

const RULES = [
  // Well-known token shapes, wherever they appear.
  [/\b(?:sk-[\w-]{8,}|(?:sk|rk|pk)_(?:live|test)_\w{6,}|gh[pousr]_\w{10,}|github_pat_\w{10,}|xox[abposr]-[\w-]{8,}|(?:AKIA|ASIA)[0-9A-Z]{12,}|eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*|glpat-[\w-]{10,}|npm_\w{20,}|hvs\.[\w-]{10,}|AIza[\w-]{30,}|pypi-[\w-]{20,})/g, M],
  [/((?:hooks\.slack\.com\/services|discord(?:app)?\.com\/api\/webhooks|api\.telegram\.org\/bot)\/?)[\w/:.-]+/gi, `$1${M}`],
  // Passwords and tokens in links: user:pass@, :pass@, token@.
  [/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@'"]*):([^\s/'"]*)@(?=[^\s/@'"]+)/gi, `$1$2:${M}@`],
  [/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@'"]{12,})@/gi, `$1${M}@`],
  // Secret-looking query parameters (?key=, &sig=, X-Amz-Signature=, access_token=).
  [new RegExp(`([?&][\\w.-]*${SECRET_END}[\\w.-]*=)([^&\\s"']+)`, 'gi'), `$1${M}`],
  // Authorization: Bearer X / Basic X.
  [/\b(bearer)\s+(?!\*\*\*)(?!\$)([^\s'"]+)/gi, `$1 ${M}`],
  [/\b(basic|digest|negotiate)\s+([A-Za-z0-9+/=._-]{8,})/gi, `$1 ${M}`],
  // Header "Name: value" whose name ends in a secret word.
  [new RegExp(`(\\b(?:(?:proxy-)?authorization|cookie|[\\w]+[-_]${HEADER_END}|${HEADER_END}[-_][\\w-]+)\\s*:\\s*["']?)(?:(bearer|basic|digest|negotiate|token)\\s+)?(?!\\*\\*\\*)(?!\\$)([^\\s'",}]+)`, 'gi'),
    (m, a, scheme, v) => (/^(bearer|basic|digest|negotiate|token)$/i.test(v) || /^\/\/|^\d+(\/|$)/.test(v) ? m : `${a}${scheme ? `${scheme} ` : ''}${M}`)],
  // NAME=value, --name=value, "name":"value", \"name\":\"value\" whose name ends in a secret word.
  [new RegExp(`((?:^|[\\s"'{,(=:/])-{0,2}[\\w.-]*${SECRET_END}\\s*=\\s*)(?!\\$)${VAL}`, 'gi'), `$1${M}`],
  [new RegExp(`(--arg\\s+[\\w]*${SECRET_END}\\s+)(?!\\$)${VAL}`, 'gi'), `$1${M}`],
  [new RegExp(`(\\\\?["'][\\w.-]*${SECRET_END}\\\\?["']\\s*:\\s*\\\\?["'])((?:[^"'\\\\]|\\\\(?!["']))+)`, 'gi'), `$1${M}`],
  // --password X, --token X, --passphrase X, --http-password X ...
  [new RegExp(`(--[\\w-]*${SECRET_END}\\s+)(?!-)${VAL}`, 'gi'), `$1${M}`],
  // A secret name followed by its value as the next word (config set npmAuthToken X).
  [new RegExp(`(\\b[\\w.:/-]*(?:_?auth_?token|authtoken|secret_access_key|session_token|access_token|api_?key|client_secret|\\.token)\\s+)(?!-)(?!\\*\\*\\*)${VAL}`, 'gi'), `$1${M}`],
];

// Rules that depend on the program being run (attached or separate values, quoted or not).
const Q = `(?:"[^"]*"|'[^']*'|[^\\s'"]+)`;
const PROGRAM_RULES = [
  [/\b(?:mysql|mysqldump|mysqladmin|mariadb)\b/, new RegExp(`(\\s-p)(?=\\S)${Q}`, 'g'), `$1${M}`],
  [/\bsshpass\b/, new RegExp(`(\\s-p\\s*)${Q}`, 'g'), `$1${M}`],
  [/\b7z\b/, new RegExp(`(\\s-p)(?=\\S)${Q}`, 'g'), `$1${M}`],
  [/\b(?:zip|unzip)\b/, new RegExp(`(\\s-P\\s*)${Q}`, 'g'), `$1${M}`],
  [/\bredis-cli\b/, new RegExp(`(\\s-a\\s*)${Q}`, 'g'), `$1${M}`],
  [/\bsecurity\b/, new RegExp(`(\\s-[wp]\\s*)${Q}`, 'g'), `$1${M}`],
  [/\bopenssl\b/, new RegExp(`(\\s-(?:k|pass|passin|passout)\\s+(?:pass:)?)${Q}`, 'g'), `$1${M}`],
  [/\b(?:docker|podman|helm|oc|skopeo|buildah)\b[^|;&]*\blogin\b/, new RegExp(`(\\s(?:-p|--password)\\s*)(?!-)${Q}`, 'g'), `$1${M}`],
  [/\b(?:az|mongosh|mongo|twine)\b/, new RegExp(`(\\s(?:-p|--password)\\s*)(?!-)${Q}`, 'g'), `$1${M}`],
  [/\bsqlcmd\b/, new RegExp(`(\\s-P\\s*)${Q}`, 'g'), `$1${M}`],
  [/\bldap\w+\b/, new RegExp(`(\\s-w\\s*)${Q}`, 'g'), `$1${M}`],
  [/\bssh-keygen\b/, new RegExp(`(\\s-[NP]\\s*)${Q}`, 'g'), `$1${M}`],
  [/\b(?:curl|http|https|xh)\b/, new RegExp(`(\\s(?:-u|--user|-a|--auth)\\s*["']?[^\\s:'"]*:)${Q}`, 'g'), `$1${M}`],
  [/\b(?:curl|http|https|xh)\b/, new RegExp(`(\\s(?:-u|--user|-a|--auth)\\s*)([^\\s:'"]{12,})(?=:?\\s)`, 'g'), `$1${M}`],
  [/\bcurl\b/, new RegExp(`(\\s(?:-b|--cookie)\\s+)${Q}`, 'g'), `$1${M}`],
  [/\blftp\b/, /(\s-u\s+[^\s,]+,)([^\s'"]+)/g, `$1${M}`],
  [/\bsmbclient\b/, /(\s-U\s+[^\s%]+%)([^\s'"]+)/g, `$1${M}`],
  [/\bhtpasswd\b[^|;&]*\s-\w*b/, /(\bhtpasswd\b[^|;&]*\s\S+\s+\S+\s+)(\S+)/g, `$1${M}`],
  [/\bgh\s+secret\s+set\b/, new RegExp(`(\\s(?:--body|-b)\\s+)${Q}`, 'g'), `$1${M}`],
  [/\bvault\s+login\b/, /(\bvault\s+login\s+(?:-\S+\s+)*)([^\s-][^\s'"]*)/g, `$1${M}`],
];

// Rules that look across the whole line: echo SECRET | tool --password-stdin.
const LINE_RULES = [
  [/--(?:password-stdin|with-token|token-stdin)\b|\bsudo\s+-S\b/, new RegExp(`(\\b(?:echo|printf)\\s+(?:-\\w+\\s+)*(?:'%s\\\\n'\\s+|"%s\\\\n"\\s+)?)${Q}`, 'g'), `$1${M}`],
];

export function redact(command) {
  let s = [...String(command ?? '')].slice(0, 2000).join('');
  for (const [re, to] of RULES) s = s.replace(re, to);
  for (const [when, re, to] of LINE_RULES) if (when.test(s)) s = s.replace(re, to);
  // Program rules apply only inside that program's own step of the line.
  return steps(s).map((part, idx) => {
    if (idx % 2) return part;
    let t = ` ${part}`;
    for (const [when, re, to] of PROGRAM_RULES) if (when.test(t)) t = t.replace(re, to);
    return t.slice(1);
  }).join('');
}

if (isMain(import.meta)) {
  const [mode, ts, pid, tty, app, cwd, seq, logFile] = process.argv.slice(2);
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    raw = raw.replace(/\n$/, '');
    let full = false;
    try { full = config().terminalLogFullCommands === true; } catch { /* default */ }
    if (mode === 'run' && logFile) {
      const line = { ev: 'run', ts: Number(ts), pid: Number(pid), seq: Number(seq), tty, app, cwd, cmd: full ? redact(raw) : summarize(raw, cwd), full };
      try { fs.appendFileSync(logFile, `${JSON.stringify(line)}\n`); } catch { /* never disturb the terminal */ }
    } else {
      process.stdout.write(`${mode === 'redact' ? redact(raw) : summarize(raw)}\n`);
    }
  });
}
