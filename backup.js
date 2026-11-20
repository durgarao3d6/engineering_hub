'use strict';
// Backups of hub.db and a weekly readable export. Runs inside the hub; never blocks it and never crashes it.
//   hub-YYYYMMDD-HHMMSS[-label].db   consistent snapshot (VACUUM INTO), verified after writing
//   export-YYYY-Www.json              notes, plans, moves, stashes, clearances as plain text
// Retention: every snapshot of the last 14 days, plus the newest snapshot of each of the last 8 weeks.
// Snapshots labelled pre-migration or manual are kept 90 days. The newest snapshot is never deleted.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const store = require('./store');
const files = require('./backup-files');

const DAY = 86400000;
let lastError = null; let lastRun = null;

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
function isoWeek(d) { // YYYY-Www
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear(); const w = Math.ceil((((t - Date.UTC(y, 0, 1)) / DAY) + 1) / 7); return y + '-W' + pad(w);
}

function exports_() {
  if (!fs.existsSync(cfg.backupDir)) return [];
  return fs.readdirSync(cfg.backupDir).filter((f) => /^export-\d{4}-W\d{2}\.json$/.test(f)).sort().reverse().map((f) => ({ file: f, path: path.join(cfg.backupDir, f) }));
}

function prune(now = new Date()) {
  const all = files.list(); const keep = new Set(); const t = now.getTime();
  const daily = all.filter((b) => b.label === 'daily');
  daily.forEach((b) => { if (t - b.at.getTime() <= cfg.keepDailyDays * DAY) keep.add(b.file); });
  const weeks = new Map(); daily.forEach((b) => { const w = isoWeek(b.at); if (!weeks.has(w) || b.at > weeks.get(w).at) weeks.set(w, b); }); // newest of each week
  [...weeks.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, cfg.keepWeeklyWeeks).forEach(([, b]) => keep.add(b.file));
  all.filter((b) => b.label !== 'daily' && t - b.at.getTime() <= 90 * DAY).forEach((b) => keep.add(b.file));
  if (all[0]) keep.add(all[0].file);
  const removed = [];
  for (const b of all) if (!keep.has(b.file)) { try { fs.unlinkSync(b.path); removed.push(b.file); } catch { /* locked: next time */ } }
  exports_().slice(8).forEach((e) => { try { fs.unlinkSync(e.path); } catch { /* next time */ } });
  return removed;
}

function snapshot(label = 'daily', now = new Date()) {
  const name = 'hub-' + stamp(now) + (label === 'daily' ? '' : '-' + label) + '.db';
  const file = path.join(cfg.backupDir, name);
  fs.mkdirSync(cfg.backupDir, { recursive: true });
  store.snapshotTo(file);
  try { const v = files.verify(file); prune(now); return { file, name, bytes: fs.statSync(file).size, verified: true, counts: v.counts }; }
  catch (e) { try { fs.unlinkSync(file); } catch { /* keep going */ } throw new Error('The backup was written but failed verification, so it was discarded: ' + e.message); }
}

function exportWeekly(now = new Date(), force = false) {
  const file = path.join(cfg.backupDir, 'export-' + isoWeek(now) + '.json');
  if (fs.existsSync(file) && !force) return null;
  fs.mkdirSync(cfg.backupDir, { recursive: true });
  const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(store.exportAll(), null, 2)); fs.renameSync(tmp, file);
  return file;
}

function status(now = new Date()) {
  const all = files.list(); const newest = all[0]; const ex = exports_()[0];
  const ageHours = newest ? Math.round((now.getTime() - newest.at.getTime()) / 360000) / 10 : null;
  return { dir: cfg.backupDir, count: all.length, newest: newest ? { file: newest.file, at: newest.atIso, bytes: newest.size, label: newest.label } : null, ageHours,
    recent: all.slice(0, 6).map((b) => ({ file: b.file, at: b.atIso, bytes: b.size, label: b.label })), lastExport: ex ? ex.file : null, lastError, lastRun,
    ok: !!newest && ageHours <= 36 && !lastError };
}

// At start and every hour: a snapshot if the newest is older than 20 hours, and this week's export if missing.
function tick(now = new Date()) {
  try {
    const newest = files.list()[0];
    if (!newest || now.getTime() - newest.at.getTime() > 20 * 3600000) snapshot('daily', now);
    exportWeekly(now);
    lastError = null; lastRun = new Date().toISOString();
  } catch (e) { lastError = e.message; }
  return status(now);
}

function start() { setTimeout(tick, 5000).unref(); setInterval(tick, 3600000).unref(); }

module.exports = { snapshot, prune, exportWeekly, tick, status, start, isoWeek };
