'use strict';
// Reading backups. No dependency on the live database, so the restore command works even when hub.db is damaged.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const cfg = require('./config');

const NAME = /^hub-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-([a-z-]+))?\.db$/;

function list() {
  if (!fs.existsSync(cfg.backupDir)) return [];
  return fs.readdirSync(cfg.backupDir).map((f) => ({ f, m: NAME.exec(f) })).filter((x) => x.m).map(({ f, m }) => {
    const at = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    let size = 0; try { size = fs.statSync(path.join(cfg.backupDir, f)).size; } catch { /* gone */ }
    return { file: f, path: path.join(cfg.backupDir, f), at, atIso: at.toISOString(), label: m[7] || 'daily', size };
  }).sort((a, b) => b.at - a.at);
}

// A backup counts only if it opens, passes the integrity check and has the tables we expect.
function verify(file) {
  const d = new DatabaseSync(file, { readOnly: true });
  try {
    const qc = Object.values(d.prepare('PRAGMA quick_check').get())[0];
    if (qc !== 'ok') throw new Error('integrity check said: ' + qc);
    const names = d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    for (const t of ['notes', 'plan_items', 'moves', 'stashes', 'clearances']) if (!names.includes(t)) throw new Error('table ' + t + ' is missing');
    const n = (sql) => d.prepare(sql).get().n;
    return { counts: { notes: n('SELECT COUNT(*) AS n FROM notes WHERE deleted_at IS NULL'), planItems: n('SELECT COUNT(*) AS n FROM plan_items'), moves: n('SELECT COUNT(*) AS n FROM moves'), clearances: n('SELECT COUNT(*) AS n FROM clearances') } };
  } finally { d.close(); }
}

module.exports = { list, verify, NAME };
