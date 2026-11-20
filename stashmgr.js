'use strict';
// The stash manager's actions. With mover.js this is the only code that changes a repo.
//   clear   : keep a patch + a hidden ref (refs/hub-trash/<hash>), then drop the stash. Recoverable with restore().
//   restore : put a cleared stash back on the stash list.
//   purge   : delete the hidden ref and the patch for good (the history row stays).
//   rework  : new worktree on the commit the stash was made from, stash applied there. The stash itself is left alone.
// Never pushes, never commits, never touches the live working tree. Every stash is found again by its hash right before use
// (a stash's index shifts whenever another one is dropped).
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const store = require('./store');
const mover = require('./mover');
const { gitx, git, exists } = require('./collectors/git');
const { cloneList } = require('./collectors/worktrees');
const info = require('./collectors/stashinfo');

const HASH = /^[0-9a-f]{40}$/;
const NAMES = cfg.coWorkerNames; // the co-worker names, from hub.config.json
const TRASH = 'refs/hub-trash/';
const wtRoot = () => process.env.HUB_WT_ROOT || cfg.worktreeRoot;
const archiveDir = () => path.join(cfg.dataDir, 'stash-archive');

class StashError extends Error { constructor(msg, code = 400) { super(msg); this.code = code; this.status = code; } }
const busyRepos = new Set();

function findClone(p) {
  const k = String(p || '').replace(/\//g, '\\').toLowerCase();
  return cloneList().find((c) => c.path.replace(/\//g, '\\').toLowerCase() === k && exists(c.path)) || null;
}
const norm = (p) => p.replace(/\//g, '\\');

async function guard(repoPath) {
  const c = findClone(repoPath);
  if (!c) throw new StashError('That repository is not one of your clones.', 404);
  if (mover.isBusy()) throw new StashError('A Move to live is running. Try again when it has finished.', 409);
  if (busyRepos.has(c.path)) throw new StashError('Another stash action is running on this repository.', 409);
  for (const f of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    if ((await git(c.path, ['rev-parse', '-q', '--verify', f])).ok) throw new StashError('This repository is in the middle of a merge, cherry-pick or revert. Finish or abort it first.', 409);
  }
  for (const d of ['rebase-merge', 'rebase-apply']) {
    const gp = (await git(c.path, ['rev-parse', '--git-path', d])).out;
    if (gp && fs.existsSync(path.resolve(c.path, gp))) throw new StashError('This repository is in the middle of a rebase. Finish or abort it first.', 409);
  }
  return c;
}
async function withRepo(repoPath, fn) {
  const c = await guard(repoPath);
  busyRepos.add(c.path);
  try { return await fn(c); } finally { busyRepos.delete(c.path); }
}
function needHash(h) { if (!HASH.test(String(h || ''))) throw new StashError('Not a valid stash id.'); return String(h); }
async function indexOf(repo, hash) {
  const l = await info.list(repo.path);
  if (!l.ok) throw new StashError('Could not read the stash list: ' + l.error, 500);
  const st = l.stashes.find((s) => s.hash === hash);
  return st || null;
}
const safeName = (s) => String(s || 'repo').replace(/[^A-Za-z0-9._-]/g, '_');

async function filesOf(repo, st) {
  const a = await info.analyse(repo.path, st, null);
  return [...a.files, ...a.untracked];
}

/* ---------- clear ---------- */
async function clear(repoPath, hash, reason, by) {
  needHash(hash);
  const why = String(reason || '').trim();
  if (why.length < 5) throw new StashError('Give a reason (at least 5 characters).');
  return withRepo(repoPath, async (repo) => {
    const st = await indexOf(repo, hash);
    if (!st) throw new StashError('That stash is no longer in the list (already cleared or dropped elsewhere).', 404);
    const files = await filesOf(repo, st);
    // 1. a readable copy
    const dir = path.join(archiveDir(), safeName(repo.repoKey)); fs.mkdirSync(dir, { recursive: true });
    const patchPath = path.join(dir, hash + '.patch');
    let p = await gitx(repo.path, ['stash', 'show', '-p', '--binary', '--include-untracked', '--no-color', hash], 120000);
    if (!p.ok) p = await gitx(repo.path, ['diff', '--binary', '--no-color', hash + '^1', hash], 120000);
    if (!p.ok) throw new StashError('Could not save a copy of the stash, so it was not cleared: ' + p.err, 500);
    fs.writeFileSync(patchPath, p.out + '\n');
    // 2. a hidden ref keeps the commits alive after the stash entry is gone
    const ref = TRASH + hash;
    const u = await gitx(repo.path, ['update-ref', ref, hash]);
    if (!u.ok) throw new StashError('Could not protect the stash, so it was not cleared: ' + u.err, 500);
    const chk = (await git(repo.path, ['rev-parse', '--verify', '-q', ref])).out;
    if (chk !== hash) throw new StashError('The protection ref did not match, so the stash was not cleared.', 500);
    // 3. drop exactly that stash: re-read its position and check the hash again
    const again = await indexOf(repo, hash);
    if (!again) { await gitx(repo.path, ['update-ref', '-d', ref]); throw new StashError('The stash disappeared while clearing.', 409); }
    const cur = (await git(repo.path, ['rev-parse', '--verify', '-q', again.ref])).out;
    if (cur !== hash) { await gitx(repo.path, ['update-ref', '-d', ref]); throw new StashError('The stash list changed while clearing. Nothing was dropped.', 409); }
    const d = await gitx(repo.path, ['stash', 'drop', again.ref]);
    if (!d.ok) { await gitx(repo.path, ['update-ref', '-d', ref]); throw new StashError('git stash drop failed: ' + d.err, 500); }
    const id = store.stashActionAdd({ repoKey: repo.repoKey, repoPath: repo.path, hash, message: st.subject, action: 'cleared', reason: why, patchPath, trashRef: ref, taskId: st.taskId, files, by });
    const hub = store.stashByHash(repo.path, hash);
    if (hub && !hub.handledAt) store.stashHandle(hub.id, 'Cleared in the stash manager: ' + why, by);
    return { id, hash, patchPath, recoverable: true };
  });
}

/* ---------- restore ---------- */
async function restore(repoPath, hash, by) {
  needHash(hash);
  return withRepo(repoPath, async (repo) => {
    const trash = store.stashTrash().find((t) => t.hash === hash && norm(t.repoPath).toLowerCase() === norm(repo.path).toLowerCase());
    if (!trash) throw new StashError('That stash is not in the trash.', 404);
    const ref = TRASH + hash;
    if ((await git(repo.path, ['rev-parse', '--verify', '-q', ref])).out !== hash) throw new StashError('The protected copy is gone from git, so it cannot be restored from here. The patch file is at ' + trash.patchPath, 410);
    if (await indexOf(repo, hash)) throw new StashError('It is already on the stash list.', 409);
    const s = await gitx(repo.path, ['stash', 'store', '-m', trash.message || 'restored by the hub', hash]);
    if (!s.ok) throw new StashError('git stash store failed: ' + s.err, 500);
    await gitx(repo.path, ['update-ref', '-d', ref]);
    const id = store.stashActionAdd({ repoKey: repo.repoKey, repoPath: repo.path, hash, message: trash.message, action: 'restored', reason: null, patchPath: trash.patchPath, taskId: trash.taskId, files: trash.files, by });
    return { id, hash };
  });
}

/* ---------- purge (empty trash) ---------- */
async function purge(repoPath, hash, by) {
  needHash(hash);
  return withRepo(repoPath, async (repo) => {
    const trash = store.stashTrash().find((t) => t.hash === hash && norm(t.repoPath).toLowerCase() === norm(repo.path).toLowerCase());
    if (!trash) throw new StashError('That stash is not in the trash.', 404);
    await gitx(repo.path, ['update-ref', '-d', TRASH + hash]);
    if (trash.patchPath) { try { fs.unlinkSync(trash.patchPath); } catch { /* already gone */ } }
    const id = store.stashActionAdd({ repoKey: repo.repoKey, repoPath: repo.path, hash, message: trash.message, action: 'purged', reason: 'Emptied from the trash', taskId: trash.taskId, files: trash.files, by });
    return { id, hash };
  });
}

/* ---------- re-work ---------- */
function plan(repo, st, taskId, name, usedNames = []) {
  const id = taskId || null;
  const used = new Set(usedNames.map((n) => String(n).toLowerCase()));
  const nm = name || NAMES.find((n) => !used.has(n.toLowerCase())) || 'rework';
  const short = st.hash.slice(0, 7);
  const tag = id ? String(id) : short;
  const folder = nm.toLowerCase() + '-' + tag;
  const branch = cfg.branchPrefix + '/' + (id ? id + '-rework-' + short : 'rework-' + short);
  return { name: nm, folder, branch, dir: path.join(wtRoot(), safeName(String(repo.repoKey).toLowerCase())), taskId: id };
}
async function reworkPlan(repoPath, hash, taskId, name, usedNames) {
  needHash(hash);
  const repo = findClone(repoPath); if (!repo) throw new StashError('That repository is not one of your clones.', 404);
  const st = await indexOf(repo, hash); if (!st) throw new StashError('That stash is no longer in the list.', 404);
  const tid = taskId ? Number(taskId) : st.taskId;
  const p = plan(repo, st, tid, name, usedNames);
  // put it beside an existing worktree of the same repo when there is one
  const wl = await git(repo.path, ['worktree', 'list', '--porcelain']);
  const others = wl.out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)).filter((w) => norm(w).toLowerCase() !== norm(repo.path).toLowerCase());
  if (others.length) p.dir = path.dirname(others[0]);
  p.path = path.join(p.dir, p.folder);
  return { ...p, base: (await git(repo.path, ['rev-parse', '--verify', '-q', hash + '^1'])).out };
}
async function rework(repoPath, hash, taskId, name, by, usedNames) {
  needHash(hash);
  if (name && !/^[A-Za-z][A-Za-z0-9-]{1,20}$/.test(name)) throw new StashError('The name must be letters, digits or dashes (2 to 21 characters).');
  if (taskId && !/^\d{1,7}$/.test(String(taskId))) throw new StashError('The task id must be a number.');
  return withRepo(repoPath, async (repo) => {
    const st = await indexOf(repo, hash);
    if (!st) throw new StashError('That stash is no longer in the list.', 404);
    const p = await reworkPlan(repo.path, hash, taskId, name, usedNames);
    if (!p.base) throw new StashError('The commit this stash was made from is not in this clone any more.', 409);
    if (fs.existsSync(p.path)) throw new StashError('The folder ' + p.path + ' already exists. Pick another name.', 409);
    if ((await git(repo.path, ['rev-parse', '--verify', '-q', 'refs/heads/' + p.branch])).ok) throw new StashError('The branch ' + p.branch + ' already exists. Pick another task id or name.', 409);
    fs.mkdirSync(p.dir, { recursive: true });
    const w = await gitx(repo.path, ['worktree', 'add', '--no-track', '-b', p.branch, p.path, p.base], 180000);
    if (!w.ok) throw new StashError('git worktree add failed: ' + w.err, 500);
    const a = await gitx(p.path, ['stash', 'apply', '--quiet', hash], 180000);
    const files = await filesOf(repo, st);
    const id = store.stashActionAdd({ repoKey: repo.repoKey, repoPath: repo.path, hash, message: st.subject, action: 'reworked', reason: null, worktree: p.path, taskId: p.taskId, files, by });
    if (!a.ok) return { id, path: p.path, branch: p.branch, applied: false, warning: 'The worktree was created but applying the stash reported: ' + a.err + '. The stash is untouched; you can apply it by hand: git stash apply ' + hash };
    return { id, path: p.path, branch: p.branch, applied: true, base: p.base };
  });
}

module.exports = { clear, restore, purge, reworkPlan, rework, StashError, NAMES, TRASH, findClone };
