'use strict';
// Claude Code Stop hook. Once per session, if the session worked on a task for a while and added no hub note, ask for one before stopping.
// Exits 0 (let the session stop) in every other case, including when the hub is not running. Exit 2 with a message = "please add a note first".
const fs = require('fs');
const os = require('os');
const path = require('path');
const cfg = require('../config');

const TMP = process.env.HUB_HOOK_TMP || path.join(os.tmpdir(), 'tms-hub-hooks');
const MIN_MINUTES = Number(process.env.HUB_HOOK_MIN_MINUTES || 10);
const safe = (s) => String(s || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', async () => {
  try {
    let data = {}; try { data = JSON.parse(raw || '{}'); } catch { /* no input */ }
    if (data.stop_hook_active) process.exit(0); // we already asked once in this stop: never loop
    const file = path.join(TMP, safe(data.session_id) + '.json');
    if (!fs.existsSync(file)) process.exit(0);
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!m.taskId || m.reminded) process.exit(0);
    if ((Date.now() - m.startedAt) / 60000 < MIN_MINUTES) process.exit(0);
    const res = await fetch('http://127.0.0.1:' + cfg.port + '/api/context/' + m.taskId, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) process.exit(0);
    const c = await res.json();
    if ((c.notes || []).some((n) => Date.parse(n.createdAt) >= m.startedAt - 1000)) process.exit(0); // a note was already added
    m.reminded = true; fs.writeFileSync(file, JSON.stringify(m));
    const cli = 'node "' + path.join(cfg.root, 'bin', 'hub.js') + '"';
    process.stderr.write('Before you stop: no hub note was added for task #' + m.taskId + ' in this session. Record what you found, decided or left open so the next session can continue:\n'
      + '  ' + cli + ' note ' + m.taskId + ' "<text>" --section Findings    (also: Analysis, Decisions, "Open questions", "Next step")\n'
      + 'If there is nothing worth recording, say so in one line and stop. This reminder appears once per session.\n');
    process.exit(2);
  } catch { process.exit(0); }
});
