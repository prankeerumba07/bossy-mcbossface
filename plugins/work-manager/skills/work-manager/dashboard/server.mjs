#!/usr/bin/env node
// Work Manager live dashboard. Local only (127.0.0.1); read-only.
//   node server.mjs            port from config.json (4777), next free one if taken
//   PORT=0 node server.mjs     any free port (for tests)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILES, ensureData, readJSON, writeJSON, config, liveSessions, isDashboardProcess } from '../scripts/lib.mjs';
import { buildState } from '../scripts/state.mjs';
import { snapshot } from '../scripts/terminals.mjs';
import { search, deepSearch, findRecord, recent } from '../scripts/recall.mjs';
import { updateIndexLocked } from '../scripts/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IDLE_EXIT_MS = 6 * 3600e3;
const INDEX_REFRESH_MS = 3 * 60e3;
const LOCK = `${FILES.dashboard}.lock`;
const cfg = config();
const fixedPort = process.env.PORT != null;
// Loaded once, so the page keeps working even if a plugin update moves this folder.
const PAGE = fs.readFileSync(path.join(HERE, 'index.html'));

function validPort(v, fallback) {
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : fallback;
}

// Only one dashboard: the first to create the lock file runs, others exit.
// A lock left by a dashboard that has gone is taken over.
function claim() {
  ensureData();
  for (let i = 0; i < 3; i++) {
    try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); return true; } catch { /* exists */ }
    const pid = Number(readJSON(LOCK, 0));
    if (pid && pid !== process.pid && isDashboardProcess(pid)) return false;
    try { fs.rmSync(LOCK, { force: true }); } catch { /* raced */ }
  }
  return false;
}
if (!fixedPort && !claim()) process.exit(0);

let term = null, termAt = 0, cached = null, cachedAt = 0;
function currentState() {
  const now = Date.now();
  if (cached && now - cachedAt < 1500) return cached;
  if (!term || now - termAt > 4000) { term = snapshot(); termAt = now; }
  cached = buildState({ term });
  cachedAt = now;
  return cached;
}

const clients = new Set();
let lastBusy = Date.now();
let port = 0;

function send(res, code, type, body) {
  if (res.headersSent) { try { res.end(); } catch { /* closed */ } return; }
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    // Only this machine, by its own address (blocks pages on other sites from reading it).
    const host = String(req.headers.host || '');
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, 'text/plain', 'Forbidden');
    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'Read only');
    let url;
    try { url = new URL(req.url, `http://${host}`); } catch { return send(res, 400, 'text/plain', 'Bad request'); }
    if (url.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', PAGE);
    if (url.pathname === '/api/state') return send(res, 200, 'application/json', JSON.stringify(currentState()));
    if (url.pathname === '/api/stream') {
      const s = currentState();
      const first = JSON.stringify(s);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${first}\n\n`);
      sent.set(res, { sig: signature(s), at: Date.now() });
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/api/search') {
      const q = (url.searchParams.get('q') || '').slice(0, 300);
      const days = url.searchParams.get('days') || undefined;
      if (!q.trim()) return send(res, 200, 'application/json', JSON.stringify({ mode: 'recent', results: recent({ days: days || 30, limit: 30 }) }));
      if (url.searchParams.get('deep') === '1') {
        const ac = new AbortController();
        res.on('close', () => { if (!res.writableEnded) ac.abort(); });
        const results = await deepSearch(q, { days, limit: 15 }, ac.signal);
        return send(res, 200, 'application/json', JSON.stringify({ mode: 'deep', results }));
      }
      return send(res, 200, 'application/json', JSON.stringify({ mode: 'search', results: search(q, { days, limit: 20 }) }));
    }
    if (url.pathname === '/api/conversation') {
      const { rec, error } = findRecord(url.searchParams.get('id') || '');
      return send(res, rec ? 200 : 404, 'application/json', JSON.stringify(rec || { error }));
    }
    return send(res, 404, 'text/plain', 'Not found');
  } catch (e) {
    return send(res, 500, 'application/json', JSON.stringify({ error: e.message }));
  }
});

// Push the state while someone is watching: full data when something other
// than the clock changed (or every 10 s), a small "ping" otherwise. The page
// counts running times up by itself between full updates.
const CLOCK_FIELDS = new Set(['at', 'elapsed', 'eta', 'etaNote', 'progress', 'lastActivityAt', 'open', 'statusSince', 'askSince']);
const signature = (s) => JSON.stringify(s, (k, v) => (CLOCK_FIELDS.has(k) ? undefined : v));
// Each open page remembers what it was last sent.
const sent = new WeakMap();
setInterval(() => {
  if (!clients.size) return;
  lastBusy = Date.now();
  let s, sig, full;
  try { s = currentState(); sig = signature(s); full = `data: ${JSON.stringify(s)}\n\n`; } catch (e) {
    const problem = `event: problem\ndata: ${JSON.stringify({ error: e.message })}\n\n`;
    for (const res of clients) { try { res.write(problem); } catch { clients.delete(res); } }
    return;
  }
  const now = Date.now();
  for (const res of clients) {
    const last = sent.get(res) || { sig: '', at: 0 };
    const changed = last.sig !== sig || now - last.at > 10e3;
    try { res.write(changed ? full : `event: ping\ndata: {"at":${s.at}}\n\n`); } catch { clients.delete(res); continue; }
    if (changed) sent.set(res, { sig, at: now });
  }
}, 2000);

// Keep past-conversation search up to date while the dashboard runs.
setInterval(() => { updateIndexLocked({}).catch(() => {}); }, INDEX_REFRESH_MS).unref();

// Close itself after hours with nobody watching and no Claude open.
setInterval(() => {
  if (clients.size || liveSessions().length) { lastBusy = Date.now(); return; }
  if (Date.now() - lastBusy > IDLE_EXIT_MS) shutdown();
}, 10 * 60e3).unref();

function shutdown() {
  const d = readJSON(FILES.dashboard, null);
  if (d && d.pid === process.pid) fs.rmSync(FILES.dashboard, { force: true });
  if (Number(readJSON(LOCK, 0)) === process.pid) fs.rmSync(LOCK, { force: true });
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
// One bad request or file must not take the dashboard down.
process.on('uncaughtException', (e) => console.error(`Dashboard error (still running): ${e.message}`));
process.on('unhandledRejection', (e) => console.error(`Dashboard error (still running): ${e?.message || e}`));

let tryPort = fixedPort ? validPort(process.env.PORT, 0) : validPort(cfg.port, 4777);
let triesLeft = fixedPort ? 0 : 10;
server.on('listening', () => {
  port = server.address().port;
  ensureData();
  // A test server (PORT set) never replaces the real dashboard's record.
  if (!fixedPort || process.env.WM_DATA_DIR) writeJSON(FILES.dashboard, { pid: process.pid, port, startedAt: Date.now(), script: fileURLToPath(import.meta.url) });
  console.log(`Work Manager dashboard: http://127.0.0.1:${port}`);
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && triesLeft > 0) {
    triesLeft--;
    server.listen(++tryPort, '127.0.0.1');
  } else { console.error(`Dashboard could not start: ${e.message}`); shutdown(); }
});
server.listen(tryPort, '127.0.0.1');
