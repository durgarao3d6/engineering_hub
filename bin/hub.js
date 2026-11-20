#!/usr/bin/env node
'use strict';
// The hub command-line tool. Talks to the running hub on this machine; never opens the database itself.
//   node bin\hub.js context <taskId>                       shared context of a task: state, worktrees, notes
//   node bin\hub.js note <taskId> "<text>" [--section Findings] [--author "who"]     add a note ("-" reads the text from stdin)
//   node bin\hub.js plan                                    today's checklist
//   node bin\hub.js status                                  hub, database and backup health
// If the hub is not running, a note is saved to its inbox folder and added the next time the hub starts.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('../config');
const { formatContext } = require('../lib/format');

const BASE = 'http://127.0.0.1:' + cfg.port;
const SECTIONS = ['Analysis', 'Findings', 'Decisions', 'Open questions', 'Next step'];
const out = (s) => process.stdout.write(s + '\n');
const fail = (s, code = 1) => { process.stderr.write(s + '\n'); process.exit(code); };

async function call(method, p, body) {
  const res = await fetch(BASE + p, { method, signal: AbortSignal.timeout(6000), headers: { 'Content-Type': 'application/json', 'X-Hub-Request': '1' }, body: body ? JSON.stringify(body) : undefined });
  let data = {}; try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) { const e = new Error((data.error || 'The hub answered ' + res.status) + (data.errors ? ': ' + Object.values(data.errors).join(' ') : '')); e.status = res.status; throw e; } // include the reasons, not just "Validation failed"
  return data;
}
const down = (e) => !e.status; // no HTTP status = the hub did not answer at all

function spool(msg) { // single-writer rule: other programs never open the database, they leave a file for the hub
  const dir = path.join(cfg.dataDir, 'inbox'); fs.mkdirSync(dir, { recursive: true });
  const name = msg.id + '.json'; const tmp = path.join(dir, name + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(msg)); fs.renameSync(tmp, path.join(dir, name));
  return path.join(dir, name);
}

function parse(argv) {
  const pos = []; const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--section' || a === '-s') && argv[i + 1] !== undefined) opt.section = argv[++i];
    else if ((a === '--author' || a === '-a') && argv[i + 1] !== undefined) opt.author = argv[++i];
    else pos.push(a);
  }
  return { pos, opt };
}
const readStdin = () => new Promise((resolve) => { let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { s += d; }); process.stdin.on('end', () => resolve(s)); });

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = parse(rest);
  if (!cmd || cmd === 'help' || cmd === '--help') {
    return out('Usage:\n  hub context <taskId>\n  hub note <taskId> "<text>" [--section Findings|Analysis|Decisions|"Open questions"|"Next step"] [--author "who"]\n  hub plan\n  hub status');
  }
  try {
    if (cmd === 'context') {
      const id = Number(pos[0]); if (!Number.isInteger(id) || id < 1) fail('Give a task number, for example: hub context 5945');
      return out(formatContext(await call('GET', '/api/context/' + id)));
    }
    if (cmd === 'note') {
      const id = Number(pos[0]); if (!Number.isInteger(id) || id < 1) fail('Give a task number, then the note text.');
      let body = pos.slice(1).join(' ');
      if (body === '-') body = await readStdin();
      body = String(body).trim(); if (!body) fail('The note is empty.');
      const section = SECTIONS.find((s) => s.toLowerCase() === String(opt.section || 'Findings').toLowerCase());
      if (!section) fail('Section must be one of: ' + SECTIONS.join(', '));
      const author = String(opt.author || 'claude session').slice(0, 60);
      try { const r = await call('POST', '/api/notes', { taskId: id, section, body, author }); return out('Note #' + r.note.id + ' added to task #' + id + ' (' + section + ').'); }
      catch (e) {
        if (!down(e)) fail('The hub refused the note: ' + e.message);
        const f = spool({ id: 'cli-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'), type: 'note', taskId: id, section, body, author });
        return out('The hub is not running. The note was saved to its inbox and will be added when the hub starts:\n  ' + f);
      }
    }
    if (cmd === 'plan') {
      const p = await call('GET', '/api/plan');
      if (!p.items.length) return out('No plan for ' + p.date + ' yet.');
      return out('Plan for ' + p.date + ':\n' + p.items.map((i) => '  [' + (i.status === 'done' ? 'x' : i.status === 'skipped' ? '-' : ' ') + '] ' + i.text + (i.taskId ? '  (#' + i.taskId + ')' : '')).join('\n'));
    }
    if (cmd === 'status') {
      const h = await call('GET', '/api/health');
      return out('Hub is running. Database: ' + h.db.journalMode + ', schema ' + h.db.schemaVersion + ', integrity ' + h.db.quickCheck + '. Backups: ' + h.backups.count + (h.backups.newest ? ', newest ' + h.backups.newest.at : ', none yet') + '. Inbox: ' + h.inbox.pending + ' waiting.');
    }
    fail('Unknown command "' + cmd + '". Run: hub help');
  } catch (e) {
    fail(down(e) ? 'The hub is not running on port ' + cfg.port + '. Start it with: node "' + path.join(cfg.root, 'server.js') + '"' : e.message);
  }
})();
