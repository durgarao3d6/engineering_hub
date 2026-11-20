'use strict';
// Restore hub.db from a backup. STOP THE HUB FIRST.
//   node bin\restore.js --list
//   node bin\restore.js --latest
//   node bin\restore.js hub-20261119-063000.db        (a name from the backup folder, or a full path)
// The current database is never deleted: it is moved to data\before-restore-<time>\ first.
const fs = require('fs');
const path = require('path');
const net = require('net');
const cfg = require('../config');
const files = require('../backup-files');

const out = (s) => process.stdout.write(s + '\n');
const fail = (s) => { process.stderr.write('\nSTOP: ' + s + '\n'); process.exit(2); };
const pad = (n) => String(n).padStart(2, '0');

function hubIsRunning() {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: cfg.port, timeout: 800 });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('timeout', () => { s.destroy(); resolve(false); });
    s.on('error', () => resolve(false));
  });
}

(async () => {
  const arg = process.argv[2];
  const all = files.list();
  if (!arg || arg === '--help') { out('Usage: node bin\\restore.js --list | --latest | <backup file>\nBackups are in: ' + cfg.backupDir); return; }
  if (arg === '--list') {
    if (!all.length) return out('No backups found in ' + cfg.backupDir);
    all.forEach((b) => out(b.file.padEnd(44) + ' ' + String(Math.round(b.size / 1024)).padStart(6) + ' KB  ' + b.label));
    return;
  }
  let chosen;
  if (arg === '--latest') chosen = all[0];
  else { const p = path.isAbsolute(arg) ? arg : path.join(cfg.backupDir, arg); if (fs.existsSync(p)) chosen = { file: path.basename(p), path: p }; }
  if (!chosen) fail('No backup found' + (arg === '--latest' ? ' in ' + cfg.backupDir : ' called "' + arg + '"') + '. Run with --list to see what exists.');
  if (await hubIsRunning()) fail('The hub is running on port ' + cfg.port + '. Stop it first, then run this again. Nothing was changed.');

  let v; try { v = files.verify(chosen.path); } catch (e) { fail('That backup is not usable (' + e.message + '). Nothing was changed. Try an older one with --list.'); }

  const db = path.join(cfg.dataDir, 'hub.db'); fs.mkdirSync(cfg.dataDir, { recursive: true });
  let kept = null;
  if (fs.existsSync(db) || fs.existsSync(db + '-wal')) {
    const t = new Date(); kept = path.join(cfg.dataDir, 'before-restore-' + t.getFullYear() + pad(t.getMonth() + 1) + pad(t.getDate()) + '-' + pad(t.getHours()) + pad(t.getMinutes()) + pad(t.getSeconds()));
    fs.mkdirSync(kept, { recursive: true });
    for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(db + ext)) fs.renameSync(db + ext, path.join(kept, 'hub.db' + ext));
  }
  fs.copyFileSync(chosen.path, db);
  out('Restored ' + chosen.file + ' to ' + db);
  out('It contains: ' + v.counts.notes + ' notes, ' + v.counts.planItems + ' plan lines, ' + v.counts.moves + ' moves, ' + v.counts.clearances + ' clearances.');
  if (kept) out('The database you had before was kept in: ' + kept);
  out('Start the hub again. Anything saved after that backup was made is not in it.');
})().catch((e) => fail(e.message));
