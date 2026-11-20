'use strict';
// The single-writer rule: only the hub process writes to hub.db. Other programs (the hub command-line tool, Claude session hooks)
// either call the hub's local API, or, when the hub is not running, drop a small JSON file in data\inbox\ that the hub applies when it is up.
//   Writers must create the file as <name>.tmp and rename it to <name>.json when complete.
//   {"id":"<unique id>","type":"note","taskId":5945,"section":"Findings","body":"...","author":"session abc"}
// Each message is applied at most once (by id), then moved to inbox\done\; bad ones go to inbox\rejected\ with a .reason.txt.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const DIR = path.join(cfg.dataDir, 'inbox');
const MAX_BYTES = 16384; const MAX_PER_TICK = 50; const SETTLE_MS = 3000;

function move(file, to, reason) {
  const dest = path.join(DIR, to); fs.mkdirSync(dest, { recursive: true });
  const base = path.basename(file); let target = path.join(dest, base);
  if (fs.existsSync(target)) target = path.join(dest, Date.now() + '-' + base);
  fs.renameSync(file, target);
  if (reason) fs.writeFileSync(target + '.reason.txt', String(reason) + '\n');
}

// handlers: { note: (msg) => 'applied' | 'duplicate' }, each throws an Error with a clear reason for a message that is not acceptable.
function ingestOnce(handlers, now = Date.now()) {
  fs.mkdirSync(DIR, { recursive: true });
  const out = { applied: 0, duplicate: 0, rejected: 0, waiting: 0 };
  const files = fs.readdirSync(DIR, { withFileTypes: true }).filter((e) => e.isFile() && /^[A-Za-z0-9._-]+\.json$/.test(e.name)).map((e) => path.join(DIR, e.name)).slice(0, MAX_PER_TICK);
  for (const file of files) {
    let st; try { st = fs.statSync(file); } catch { continue; }
    try {
      if (st.size > MAX_BYTES) throw new Error('message is larger than ' + MAX_BYTES + ' bytes');
      let msg; try { msg = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch { if (now - st.mtimeMs < SETTLE_MS) { out.waiting++; continue; } throw new Error('not valid JSON'); } // a file that is still being written is left for the next round
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error('message must be a JSON object');
      if (typeof msg.id !== 'string' || !/^[A-Za-z0-9._:-]{8,80}$/.test(msg.id)) throw new Error('message needs an "id" of 8 to 80 letters, digits or . _ : -');
      const h = handlers[msg.type]; if (!h) throw new Error('unknown message type "' + String(msg.type).slice(0, 30) + '"');
      const r = h(msg);
      if (r === 'duplicate') { out.duplicate++; move(file, 'done', 'duplicate: this message id was already applied'); } else { out.applied++; move(file, 'done'); }
    } catch (e) { out.rejected++; try { move(file, 'rejected', e.message); } catch { /* leave it */ } }
  }
  return out;
}

function counts() {
  const n = (d) => { try { return fs.readdirSync(path.join(DIR, d)).filter((f) => f.endsWith('.json')).length; } catch { return 0; } };
  let pending = 0; try { pending = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).length; } catch { /* none yet */ }
  return { dir: DIR, pending, done: n('done'), rejected: n('rejected') };
}

function start(handlers) { ingestOnce(handlers); setInterval(() => { try { ingestOnce(handlers); } catch { /* next round */ } }, 3000).unref(); }

module.exports = { ingestOnce, counts, start, DIR };
