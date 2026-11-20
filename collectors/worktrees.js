'use strict';
const path = require('path');
const cfg = require('../config');
const { git, pool, exists } = require('./git');

const TASK_RE = cfg.branchRe; // <prefix>/<id>-... from hub.config.json

function cloneList() {
  const seen = new Map();
  for (const [key, r] of Object.entries(cfg.repoMap.repos || {})) {
    for (const [layer, p] of Object.entries(r.clones || {})) {
      if (!p) continue;
      const k = p.toLowerCase();
      if (!seen.has(k)) seen.set(k, { repoKey: key, azdoRepo: r.azdoRepo, layer, path: p });
    }
  }
  for (const p of cfg.extraClones) {
    if (!seen.has(p.toLowerCase())) seen.set(p.toLowerCase(), { repoKey: path.basename(p), azdoRepo: path.basename(p), layer: 'extra', path: p });
  }
  return [...seen.values()];
}

function parsePorcelain(text) {
  const out = []; let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9) }; out.push(cur); }
    else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '');
    else if (line === 'detached') cur.detached = true;
    else if (line === 'bare') cur.bare = true;
    else if (line.startsWith('prunable')) cur.prunable = true;
    else if (line.startsWith('locked')) cur.locked = true;
  }
  return out;
}

async function describe(clone, wt, isMain) {
  const info = {
    repoKey: clone.repoKey, azdoRepo: clone.azdoRepo, layer: clone.layer, clonePath: clone.path,
    path: path.normalize(wt.path), isMain, branch: wt.branch || (wt.detached ? '(detached)' : ''),
    head: (wt.head || '').slice(0, 8), prunable: !!wt.prunable, missing: !exists(wt.path),
  };
  const m = TASK_RE.exec(info.branch || '');
  info.taskId = m ? Number(m[1]) : null;
  if (info.missing) return info;
  const [st, last, up, merged] = await Promise.all([
    git(wt.path, ['status', '--porcelain']),
    git(wt.path, ['log', '-1', '--format=%h|%cI|%s']),
    wt.branch ? git(wt.path, ['rev-list', '--left-right', '--count', `${wt.branch}...origin/${wt.branch}`]) : { ok: false },
    wt.branch && !isMain ? git(wt.path, ['merge-base', '--is-ancestor', wt.branch, 'origin/main']) : { ok: false },
  ]);
  const lines = st.out ? st.out.split(/\r?\n/).filter(Boolean) : [];
  info.dirtyFiles = lines.length;
  info.untracked = lines.filter((l) => l.startsWith('??')).length;
  if (last.ok && last.out) { const [h, d, ...s] = last.out.split('|'); info.lastCommit = { hash: h, date: d, subject: s.join('|') }; }
  if (up.ok && up.out) { const [a, b] = up.out.split(/\s+/).map(Number); info.ahead = a; info.behind = b; info.onOrigin = true; }
  else info.onOrigin = false;
  info.mergedToMain = !isMain && merged.ok;
  // Same labels as .claude/commands/work-status.md ("Where it is"); PR/Working come from the task collector.
  if (isMain) info.where = 'Live checkout';
  else if (info.dirtyFiles > 0) info.where = 'Uncommitted in worktree';
  else if (info.mergedToMain) info.where = 'Merged (worktree still on disk)';
  else if (info.onOrigin && info.ahead === 0) info.where = 'Pushed';
  else if (info.onOrigin && info.ahead > 0) info.where = 'Committed locally (ahead of origin)';
  else if (info.lastCommit) info.where = 'Committed locally';
  else info.where = 'Unknown';
  const ref = info.dirtyFiles > 0 ? Date.now() : (info.lastCommit ? Date.parse(info.lastCommit.date) : 0);
  info.idleDays = ref ? Math.floor((Date.now() - ref) / 86400000) : null;
  info.stale = !isMain && (info.mergedToMain || (info.idleDays != null && info.idleDays >= cfg.staleDays && info.dirtyFiles === 0));
  info.needsAttention = !isMain && (info.dirtyFiles > 0 || info.where.startsWith('Committed locally') || info.missing || info.prunable);
  return info;
}

async function collectWorktrees() {
  const clones = cloneList().filter((c) => exists(c.path));
  const missingClones = cloneList().filter((c) => !exists(c.path)).map((c) => c.path);
  const listed = await pool(clones, 6, async (c) => {
    const r = await git(c.path, ['worktree', 'list', '--porcelain']);
    return { c, wts: r.ok ? parsePorcelain(r.out) : [], error: r.ok ? null : 'git worktree list failed (not a git root?)' };
  });
  const jobs = [];
  const errors = [];
  for (const { c, wts, error } of listed) {
    if (error) errors.push({ clone: c.path, error });
    wts.forEach((w, i) => { if (!w.bare) jobs.push({ c, w, main: i === 0 }); });
  }
  const rows = await pool(jobs, 8, (j) => describe(j.c, j.w, j.main));
  return { generatedAt: new Date().toISOString(), clones: clones.length, missingClones, errors, worktrees: rows };
}

module.exports = { collectWorktrees, cloneList };
