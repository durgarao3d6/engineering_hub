'use strict';
// Reads git stashes and works out what each one is. Read-only: it never changes a repo or its stash list.
// (merge-tree writes a few unreferenced objects into .git, which git removes on its own; nothing visible changes.)
// No AI is involved anywhere in this file: everything comes from git itself.
const { git, gitx, pool } = require('./git');
const cfg = require('../config');
const TASK_BRANCH = new RegExp('^' + cfg.branchPrefixEsc + '/(\\d+)');

const STALE_DAYS = 60;
const CHUNK = 80; // files per git command (keeps Windows command lines short)

function parseSubject(s) {
  const m = /^(?:WIP on|On) ([^:]+):\s*(.*)$/.exec(String(s || ''));
  const branch = m ? m[1].trim() : '';
  const taskId = (TASK_BRANCH.exec(branch) || [])[1] || null;
  return { branch, note: m ? m[2] : String(s || ''), taskId: taskId ? Number(taskId) : null };
}

// Cheap: one git command per repo.
async function list(repoPath) {
  const r = await gitx(repoPath, ['stash', 'list', '--format=%H%x09%gd%x09%ct%x09%gs'], 30000);
  if (!r.ok) return { ok: false, error: r.err || 'git stash list failed', stashes: [] };
  const stashes = r.out.split('\n').filter(Boolean).map((l, i) => {
    const [hash, ref, ct, ...rest] = l.split('\t');
    const subject = rest.join('\t');
    return { hash, ref, index: i, createdAt: new Date(Number(ct) * 1000).toISOString(), subject, ...parseSubject(subject) };
  });
  return { ok: true, stashes };
}

async function mainRef(repoPath) {
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    const r = await git(repoPath, ['rev-parse', '--verify', '-q', ref + '^{commit}']);
    if (r.ok && r.out) return { ref, sha: r.out };
  }
  return null;
}

async function differing(repoPath, from, to, files) {
  const out = [];
  for (let i = 0; i < files.length; i += CHUNK) {
    const r = await gitx(repoPath, ['diff', '--name-only', from, to, '--', ...files.slice(i, i + CHUNK)], 60000);
    if (!r.ok) return null; // unknown
    out.push(...r.out.split('\n').filter(Boolean));
  }
  return out;
}

// One stash. main = { ref, sha } from mainRef(). Returns facts only; verdict() turns them into advice.
async function analyse(repoPath, st, main) {
  const base = (await git(repoPath, ['rev-parse', '--verify', '-q', st.hash + '^1'])).out;
  const hasUntracked = (await git(repoPath, ['rev-parse', '--verify', '-q', st.hash + '^3'])).ok;
  const ns = await gitx(repoPath, ['diff', '--numstat', '--no-renames', base, st.hash], 60000);
  const tracked = []; let added = 0; let removed = 0;
  for (const l of (ns.ok ? ns.out : '').split('\n').filter(Boolean)) {
    const [a, d, ...f] = l.split('\t'); tracked.push(f.join('\t'));
    if (a !== '-') { added += Number(a) || 0; removed += Number(d) || 0; }
  }
  let untracked = [];
  if (hasUntracked) { const u = await gitx(repoPath, ['ls-tree', '-r', '--name-only', st.hash + '^3'], 30000); untracked = u.ok ? u.out.split('\n').filter(Boolean) : []; }
  const res = { hash: st.hash, base, files: tracked, untracked, added, removed, main: main ? main.ref : null, identical: null, conflicts: null, branchMerged: null };
  if (main) {
    const dt = tracked.length ? await differing(repoPath, st.hash, main.sha, tracked) : [];
    const du = untracked.length ? await differing(repoPath, st.hash + '^3', main.sha, untracked) : [];
    res.identical = dt === null || du === null ? null : (dt.length === 0 && du.length === 0);
    res.sameAsMain = dt === null || du === null ? null : tracked.length + untracked.length - dt.length - du.length; // files already identical to main
    if (tracked.length) {
      const mt = await gitx(repoPath, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '--merge-base=' + base, main.sha, st.hash], 60000);
      if (mt.code === 0) res.conflicts = [];
      else if (mt.code === 1) res.conflicts = mt.out.split('\n').slice(1).filter(Boolean);
      else res.conflicts = null; // old git or unrelated history: unknown
    } else res.conflicts = [];
    if (st.branch && st.branch !== 'main' && st.branch !== 'master') {
      const lb = await git(repoPath, ['rev-parse', '--verify', '-q', 'refs/heads/' + st.branch + '^{commit}']);
      const rb = lb.ok ? lb : await git(repoPath, ['rev-parse', '--verify', '-q', 'refs/remotes/origin/' + st.branch + '^{commit}']);
      if (rb.ok) { const anc = await gitx(repoPath, ['merge-base', '--is-ancestor', rb.out, main.sha], 30000); res.branchMerged = anc.code === 0 ? true : (anc.code === 1 ? false : null); }
    }
  }
  return res;
}

// Pure. a = analyse() result, st = list() entry, ctx = { taskState, now }.
function verdict(a, st, ctx = {}) {
  const now = ctx.now || Date.now();
  const ageDays = Math.floor((now - Date.parse(st.createdAt)) / 86400000);
  const n = a.files.length + a.untracked.length;
  const DONE = /^(closed|done|resolved|removed)$/i;
  if (n === 0) return { kind: 'safe', label: 'Safe to clear', why: 'The stash holds no file changes.', ageDays };
  if (a.identical === true) return { kind: 'safe', label: 'Safe to clear', why: 'Every file in it is identical to ' + a.main + ' already.', ageDays };
  // A merged branch alone is weak evidence: a recent stash is probably live work on that branch, so it needs more than the merge to be called obsolete.
  const mostlyInMain = a.sameAsMain != null && a.sameAsMain >= Math.ceil(n / 2);
  if (a.branchMerged === true && (ageDays > 7 || mostlyInMain)) return { kind: 'obsolete', label: 'Likely obsolete', why: 'Its branch ' + st.branch + ' is merged into ' + a.main + (mostlyInMain ? ' and most of these files already match it' : ' and the stash is ' + ageDays + ' days old') + '. Check the diff for work done after the merge.', ageDays };
  if (st.taskId && ctx.taskState && DONE.test(ctx.taskState)) return { kind: 'obsolete', label: 'Likely obsolete', why: 'Task #' + st.taskId + ' is ' + ctx.taskState + '. Check the diff in case something was not committed.', ageDays };
  if (a.conflicts && a.conflicts.length) return { kind: 'rework', label: 'Needs rework', why: a.conflicts.length + ' file(s) conflict with current ' + a.main + ': ' + a.conflicts.slice(0, 3).join(', ') + (a.conflicts.length > 3 ? '…' : ''), ageDays };
  if (ageDays > STALE_DAYS) return { kind: 'old', label: 'Old, review', why: 'Older than ' + STALE_DAYS + ' days' + (a.conflicts ? '; it still applies cleanly to ' + a.main : '') + '.', ageDays };
  if (a.branchMerged === true) return { kind: 'review', label: 'Worth reviewing', why: 'Its branch ' + st.branch + ' is merged, but this stash is recent and differs from ' + a.main + ': it may be live work.', ageDays };
  return { kind: 'review', label: 'Worth reviewing', why: a.conflicts ? 'Applies cleanly to ' + (a.main || 'main') + '.' : 'Could not test it against main.', ageDays };
}

// The whole change as a complete, cheap summary (git numstat): never cut, however big the stash is.
const baseOf = async (repoPath, st) => (await git(repoPath, ['rev-parse', '--verify', '-q', st.hash + '^1'])).out;
async function summary(repoPath, st) {
  const base = await baseOf(repoPath, st);
  const ns = await gitx(repoPath, ['diff', '--numstat', '--no-renames', base, st.hash], 60000);
  const nm = await gitx(repoPath, ['diff', '--name-status', '--no-renames', base, st.hash], 60000);
  const status = new Map((nm.ok ? nm.out : '').split('\n').filter(Boolean).map((l) => { const [c, ...f] = l.split('\t'); return [f.join('\t'), c[0]]; }));
  const files = (ns.ok ? ns.out : '').split('\n').filter(Boolean).map((l) => {
    const [a, d, ...f] = l.split('\t'); const file = f.join('\t'); const binary = a === '-';
    return { file, status: status.get(file) || 'M', added: binary ? 0 : Number(a) || 0, removed: binary ? 0 : Number(d) || 0, binary };
  });
  const u = await gitx(repoPath, ['ls-tree', '-r', '-l', st.hash + '^3'], 30000);
  const untracked = (u.ok ? u.out : '').split('\n').filter(Boolean).map((l) => {
    const tab = l.indexOf('\t'); if (tab < 0) return null;
    const size = l.slice(0, tab).trim().split(/\s+/)[3];
    return { file: l.slice(tab + 1), size: size === '-' ? 0 : Number(size) || 0 };
  }).filter(Boolean);
  return { base, files, untracked, totals: { files: files.length + untracked.length, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0), untracked: untracked.length } };
}

// One file's change, loaded only when asked for (a 33-file stash is never fetched as one block).
const MAX_FILE = 400 * 1024;
async function fileDiff(repoPath, st, file) {
  const sum = await summary(repoPath, st);
  const tracked = sum.files.find((f) => f.file === file); const un = sum.untracked.find((f) => f.file === file);
  if (!tracked && !un) return null;
  let text = ''; let binary = false;
  if (tracked) {
    if (tracked.binary) binary = true;
    else text = (await gitx(repoPath, ['diff', '--no-color', '--no-ext-diff', '--no-renames', sum.base, st.hash, '--', file], 60000)).out;
  } else {
    const c = await gitx(repoPath, ['show', st.hash + '^3:' + file], 60000);
    if (c.out.includes(String.fromCharCode(0))) binary = true; else text = c.out.split('\n').map((l) => '+' + l).join('\n');
  }
  const truncated = text.length > MAX_FILE;
  return { file, diff: truncated ? text.slice(0, MAX_FILE) : text, truncated, binary };
}

// Everything, uncut, for download: the tracked changes as a patch you can git apply.
async function fullPatch(repoPath, st) {
  const base = await baseOf(repoPath, st);
  const d = await gitx(repoPath, ['diff', '--binary', '--no-color', '--no-ext-diff', '--no-renames', base, st.hash], 120000);
  return d.ok ? d.out + '\n' : '';
}

module.exports = { list, mainRef, analyse, verdict, summary, fileDiff, fullPatch, parseSubject, STALE_DAYS, pool };
