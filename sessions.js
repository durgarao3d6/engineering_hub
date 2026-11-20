'use strict';
// Claude sessions that worked on a task. Read-only. A session is linked to a task when its transcript records the
// git branch <prefix>/<id>-... Only metadata fields are read (git branch, working folder, timestamps); conversation
// text is never stored or shown. Turns, cost and the one-line label come from the usage log (usage.js).
const fs = require('fs');
const os = require('os');
const path = require('path');

const cfg = require('./config');
const PROJECTS = () => cfg.sessionsDir;
const BRANCH = new RegExp('"gitBranch":"(' + cfg.branchPrefixEsc + '/(\\d+)[^"]*)"', 'g');
const HAS_TASK_BRANCH = '"gitBranch":"' + cfg.branchPrefix + '/';
const TS = /"timestamp":"([^"]+)"/;
const CWD = /"cwd":"((?:[^"\\]|\\.)*)"/;

// file path -> { mtime, size, info }
const cache = new Map();

function scanFile(file) {
  const st = fs.statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.info;
  const text = fs.readFileSync(file, 'utf8');
  let info = null;
  if (text.includes(HAS_TASK_BRANCH)) {
    const branches = new Map(); // task id -> Set of branches
    for (const m of text.matchAll(BRANCH)) { if (!branches.has(m[2])) branches.set(m[2], new Set()); branches.get(m[2]).add(m[1]); }
    const lines = text.split('\n');
    let first = null; let last = null; let cwd = null;
    for (const l of lines) { if (!l) continue; const t = TS.exec(l); if (t) { first = t[1]; break; } }
    for (let i = lines.length - 1; i >= 0; i--) { const t = TS.exec(lines[i] || ''); if (t) { last = t[1]; break; } }
    for (const l of lines) { if (!l) continue; const c = CWD.exec(l); if (c) { try { cwd = JSON.parse('"' + c[1] + '"'); } catch { cwd = c[1]; } break; } }
    info = { branches: [...branches].map(([id, set]) => ({ id, names: [...set] })), first, last, cwd };
  }
  cache.set(file, { mtime: st.mtimeMs, size: st.size, info });
  return info;
}

function allSessions(dir = PROJECTS()) {
  const out = [];
  let projects = [];
  try { projects = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { return out; }
  for (const p of projects) {
    let files = [];
    try { files = fs.readdirSync(path.join(dir, p.name)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      let info = null;
      try { info = scanFile(path.join(dir, p.name, f)); } catch { continue; }
      if (info) out.push({ sessionId: f.slice(0, -6), ...info });
    }
  }
  return out;
}

// rows: usage.jsonl rows (one per turn). Returns { sessions, totals } for one task, newest first.
function forTask(taskId, opts = {}) {
  const id = String(taskId).replace(/\D/g, '');
  if (!id) return { sessions: [], totals: { sessions: 0, turns: 0, usd: 0 } };
  let rows = opts.rows;
  if (!rows) { try { rows = require('./usage').rows(); } catch { rows = []; } }
  const bySession = new Map();
  for (const r of rows) {
    let s = bySession.get(r.sessionId);
    if (!s) { s = { turns: 0, usd: 0, label: '', start: r.start }; bySession.set(r.sessionId, s); }
    s.turns++;
    s.usd += (r.main && r.main.usd) || 0;
    for (const sub of r.subagents || []) s.usd += sub.usd || 0;
    // the first prompt that says something: IDE context lines and pasted tool instructions make poor labels
    if (!s.label && r.prompt && !/^(the user (opened|selected)|# claude in chrome|<|\[)/i.test(String(r.prompt).trim())) s.label = String(r.prompt).slice(0, 90);
  }
  const sessions = [];
  for (const s of allSessions(opts.projectsDir)) {
    const b = s.branches.find((x) => x.id === id);
    if (!b) continue;
    const u = bySession.get(s.sessionId) || { turns: 0, usd: 0, label: '' };
    sessions.push({
      sessionId: s.sessionId, branch: b.names[0], otherTasks: s.branches.filter((x) => x.id !== id).map((x) => x.id),
      folder: s.cwd, first: s.first, last: s.last, turns: u.turns, usd: Math.round(u.usd * 1e4) / 1e4, label: u.label,
    });
  }
  sessions.sort((a, b) => String(b.last || '').localeCompare(String(a.last || '')));
  const totals = { sessions: sessions.length, turns: sessions.reduce((n, s) => n + s.turns, 0), usd: Math.round(sessions.reduce((n, s) => n + s.usd, 0) * 100) / 100 };
  return { sessions, totals };
}

module.exports = { forTask, allSessions };
