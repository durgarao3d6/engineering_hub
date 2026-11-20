'use strict';
// Claude Code SessionStart hook. If the session runs in a folder or branch that belongs to a task (<prefix>/<id>-..., <name>-<id>),
// prints that task's shared context so the session starts with what earlier sessions found and decided.
// Silent when there is no task or the hub is not running. It never blocks a session and always exits 0.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cfg = require('../config');
const { detectTask } = require('../lib/task');
const { formatContext } = require('../lib/format');

const TMP = process.env.HUB_HOOK_TMP || path.join(os.tmpdir(), 'eng-hub-hooks');
const safe = (s) => String(s || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', async () => {
  try {
    let data = {}; try { data = JSON.parse(raw || '{}'); } catch { /* no input */ }
    const cwd = data.cwd || process.cwd();
    const id = detectTask(cwd);
    fs.mkdirSync(TMP, { recursive: true });
    fs.writeFileSync(path.join(TMP, safe(data.session_id) + '.json'), JSON.stringify({ session: data.session_id || null, taskId: id, startedAt: Date.now(), cwd }));
    if (!id) return;
    const res = await fetch('http://127.0.0.1:' + cfg.port + '/api/context/' + id, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return;
    const c = await res.json();
    const cli = 'node "' + path.join(cfg.root, 'bin', 'hub.js') + '"';
    process.stdout.write('## ' + cfg.brand + ': shared context for task #' + id + '\n' + formatContext(c) + '\n\n'
      + 'Before you finish, record what you found, decided or left open so the next session does not start from zero:\n'
      + '  ' + cli + ' note ' + id + ' "<text>" --section Findings    (also: Analysis, Decisions, "Open questions", "Next step")\n');
  } catch { /* never block a session */ }
});
