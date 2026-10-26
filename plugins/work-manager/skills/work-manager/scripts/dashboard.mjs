#!/usr/bin/env node
// Start, find or stop the Work Manager dashboard.
//   node dashboard.mjs url     start it if needed, print the link
//   node dashboard.mjs open    same, then open the link in the default browser
//   node dashboard.mjs stop    stop the dashboard (only this dashboard's own process)
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { SKILL_DIR, isMain } from './lib.mjs';
import { dashboardRunning } from './hook.mjs';

async function ensure() {
  let d = dashboardRunning();
  if (d) return d;
  const child = spawn(process.execPath, [path.join(SKILL_DIR, 'dashboard/server.mjs')], { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 50 && !d; i++) {
    await new Promise((r) => setTimeout(r, 100));
    d = dashboardRunning();
  }
  if (!d) throw new Error(`The dashboard did not start. Try: node "${path.join(SKILL_DIR, 'dashboard', 'server.mjs')}"`);
  return d;
}

if (isMain(import.meta)) {
  const cmd = process.argv[2] || 'url';
  if (!['url', 'open', 'start', 'stop'].includes(cmd) || process.argv.length > 3) { console.error('Use: dashboard.mjs url | open | start | stop'); process.exit(2); }
  try {
    if (cmd === 'stop') {
      const d = dashboardRunning();
      if (!d) console.log('The dashboard is not running.');
      else { process.kill(d.pid, 'SIGTERM'); console.log('Dashboard stopped.'); }
    } else {
      const d = await ensure();
      const url = `http://127.0.0.1:${d.port}`;
      console.log(url);
      if (cmd === 'open') {
        const [prog, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
        try { execFileSync(prog, args, { stdio: 'ignore' }); } catch { console.log('(Could not open a browser here; open the link above yourself.)'); }
      }
    }
  } catch (e) { console.error(e.message); process.exit(1); }
}
export { ensure };
