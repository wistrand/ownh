// Screenshot a page after it has rendered, for checking report.html and the
// site by eye. `firefox --screenshot` captures at the load event, before
// scripted content draws; this drives headless Firefox over
// WebDriver BiDi (Node's built-in WebSocket) and waits first.
// Usage: node scripts/screenshot.mjs <url> <out.png> [waitMs=4000] [width] [height]
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const [url, out, wait = '4000', w = '1280', h = '900'] = process.argv.slice(2);
const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'ffbidi-'));
const ff = spawn('firefox', ['--headless', '--no-remote', '--profile', profile, `--remote-debugging-port=${port}`, `--window-size=${w},${h}`], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
for (let i = 0; i < 50; i++) {
  try { ws = new WebSocket(`ws://127.0.0.1:${port}/session`); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }); break; } catch { await sleep(300); }
}
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send('session.new', { capabilities: {} });
const tree = await send('browsingContext.getTree', {});
const ctx = tree.result.contexts[0].context;
await send('browsingContext.setViewport', { context: ctx, viewport: { width: +w, height: +h } });
await send('browsingContext.navigate', { context: ctx, url, wait: 'complete' });
await sleep(+wait);
const shot = await send('browsingContext.captureScreenshot', { context: ctx });
writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
ws.close(); ff.kill();
