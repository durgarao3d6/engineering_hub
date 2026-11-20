'use strict';
// "Move to live repo": the only hub code that changes a repo, and only after the user confirms in the UI.
// Order is chosen so nothing is lost if a step fails:
//   1 fetch  2 save worktree changes as a patch  3 stash the live repo's own changes (recorded in the hub)
//   4 remove the worktree (links unlinked first)  5 check out the branch in the live repo
//   6 merge origin/main (aborted cleanly on conflict)  7 apply the saved patch, unstaged
// Never pushes, never commits except the merge commit git itself creates, never drops a stash.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const cfg = require('./config');
const store = require('./store');
const { gitx } = require('./collectors/git');

let busy = null; // one move at a time across the hub

const lines = (s) => (s ? s.split(/\r?\n/).filter(Boolean) : []);
const short = (h) => String(h || '').slice(0, 8);

function parseWorktrees(text) {
  const out = []; let cur = null;
  for (const l of lines(text)) {
    if (l.startsWith('worktree ')) { cur = { path: path.normalize(l.slice(9)) }; out.push(cur); }
    else if (cur && l.startsWith('locked')) cur.locked = true;
  }
  return out;
}

async function gitPathExists(cwd, name) {
  const r = await gitx(cwd, ['rev-parse', '--git-path', name], 20000);
  return r.ok && fs.existsSync(path.resolve(cwd, r.out));
}

async function inProgressOp(live) {
  for (const n of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'index.lock']) {
    if (await gitPathExists(live, n)) return n;
  }
  return null;
}

/* ---------- plan (read-only dry run) ---------- */
async function plan(wtPathIn, ignoreBusy) {
  const P = { ok: false, blockers: [], warnings: [], worktree: {}, live: {}, merge: {} };
  const wt = path.normalize(wtPathIn || '');
  if (!wtPathIn || !fs.existsSync(wt)) { P.blockers.push('The worktree folder no longer exists.'); return P; }
  const wl = await gitx(wt, ['worktree', 'list', '--porcelain'], 30000);
  if (!wl.ok) { P.blockers.push('Not a git worktree: ' + (wl.err || 'git failed')); return P; }
  const list = parseWorktrees(wl.out);
  const live = list[0] && list[0].path;
  const me = list.find((x) => x.path.toLowerCase() === wt.toLowerCase());
  if (!live) { P.blockers.push('Could not find the live checkout of this repo.'); return P; }
  if (live.toLowerCase() === wt.toLowerCase()) P.blockers.push('This is the live checkout itself.');
  if (me && me.locked) P.blockers.push('The worktree is locked (git worktree lock). Unlock it first.');

  const branch = (await gitx(wt, ['branch', '--show-current'], 20000)).out;
  if (!branch) P.blockers.push('The worktree is on a detached HEAD, so there is no branch to check out in the live repo.');
  const wst = await gitx(wt, ['status', '--porcelain'], 60000);
  const wtLines = lines(wst.out);
  const hasMain = (await gitx(live, ['rev-parse', '--verify', '-q', 'origin/main'], 20000)).ok;
  if (!hasMain) P.blockers.push('origin/main was not found in this repo.');
  let ahead = 0; let behind = 0;
  if (branch && hasMain) {
    ahead = Number((await gitx(wt, ['rev-list', '--count', 'origin/main..' + branch], 20000)).out) || 0;
    behind = Number((await gitx(wt, ['rev-list', '--count', branch + '..origin/main'], 20000)).out) || 0;
  }
  P.worktree = { path: wt, branch, dirtyFiles: wtLines.length, files: wtLines.slice(0, 12), commitsAhead: ahead, commitsBehind: behind };

  const lbranch = (await gitx(live, ['branch', '--show-current'], 20000)).out;
  const lhead = (await gitx(live, ['rev-parse', '--short', 'HEAD'], 20000)).out;
  const lst = await gitx(live, ['status', '--porcelain'], 60000);
  const lLines = lines(lst.out);
  const stashes = lines((await gitx(live, ['stash', 'list'], 20000)).out).length;
  const op = await inProgressOp(live);
  if (op) P.blockers.push('The live repo has an operation in progress (' + op + '). Finish or abort it first.');
  P.live = { path: live, branch: lbranch || ('detached@' + lhead), dirtyFiles: lLines.length, files: lLines.slice(0, 12), existingStashes: stashes };
  if (busy && !ignoreBusy) P.blockers.push('Another move is running. Wait for it to finish.');

  if (hasMain && branch) {
    if (behind === 0) P.merge = { kind: 'up-to-date', text: 'The branch already contains origin/main. No merge needed.' };
    else if (ahead === 0) P.merge = { kind: 'fast-forward', text: 'The branch has no commits of its own: it will fast-forward to origin/main (' + behind + ' commits). No merge commit.' };
    else {
      const mt = await gitx(live, ['merge-tree', '--write-tree', '--name-only', 'origin/main', branch], 60000);
      if (mt.code === 0) P.merge = { kind: 'merge-commit', text: 'origin/main (' + behind + ' new commits) will be merged into the branch. This creates one merge commit.' };
      else if (mt.code === 1) {
        const files = []; for (const l of mt.out.split(/\r?\n/).slice(1)) { if (!l) break; files.push(l); }
        P.merge = { kind: 'conflicts', files, text: 'Merging origin/main would conflict. The merge will be skipped (aborted cleanly) and your changes applied on the branch as it is.' };
        P.warnings.push('Merge with origin/main would conflict in ' + files.length + ' file(s).');
      } else P.merge = { kind: 'unknown', text: 'Could not predict the merge: ' + (mt.err || 'git merge-tree failed') };
    }
    const fh = await gitx(wt, ['rev-parse', '--git-path', 'FETCH_HEAD'], 20000);
    try { P.merge.lastFetched = fs.statSync(path.resolve(wt, fh.out)).mtime.toISOString(); } catch { /* never fetched */ }
  }
  if (!wtLines.length && ahead === 0) P.warnings.push('This worktree has no uncommitted changes and no commits of its own. Only the branch switch will happen.');
  if (lLines.length) P.warnings.push(lLines.length + ' uncommitted file(s) in the live repo will be stashed first and listed under Stashed work.');
  P.ok = P.blockers.length === 0;
  return P;
}

/* ---------- link safety ---------- */
function rmLink(p) {
  try { execFileSync('cmd', ['/c', 'rmdir', p], { stdio: 'ignore', windowsHide: true }); } catch { /* try plain unlink */ }
  if (fs.existsSync(p) || safeLstat(p)) { try { fs.unlinkSync(p); } catch { /* reported by caller */ } }
}
const safeLstat = (p) => { try { return fs.lstatSync(p); } catch { return null; } };

// A recursive delete can follow junctions into the real node_modules, so every link is removed first
// (the link only, never its target). Real node_modules folders are checked two levels deep for workspace links.
function unlinkLinks(root) {
  const removed = [];
  const scanNm = (nm) => {
    let ents; try { ents = fs.readdirSync(nm, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(nm, e.name); const st = safeLstat(p); if (!st) continue;
      if (st.isSymbolicLink()) { rmLink(p); removed.push(p); continue; }
      if (st.isDirectory() && e.name.startsWith('@')) {
        let sub; try { sub = fs.readdirSync(p, { withFileTypes: true }); } catch { continue; }
        for (const s of sub) { const q = path.join(p, s.name); const sst = safeLstat(q); if (sst && sst.isSymbolicLink()) { rmLink(q); removed.push(q); } }
      }
    }
  };
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === '.git') continue;
      const p = path.join(dir, e.name); const st = safeLstat(p); if (!st) continue;
      if (st.isSymbolicLink()) { rmLink(p); removed.push(p); continue; }
      if (!st.isDirectory()) continue;
      if (e.name === 'node_modules') { scanNm(p); continue; }
      walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return removed;
}

/* ---------- execute ---------- */
class StepError extends Error {}

async function run(id, p, user) {
  const wt = p.worktree.path; const live = p.live.path; const branch = p.worktree.branch;
  const dir = path.join(cfg.dataDir, 'moves', String(id));
  fs.mkdirSync(dir, { recursive: true });
  const steps = []; let warned = false; let patch = null; let stashId = null; let mergeNote = '';
  const save = () => store.moveUpdate(id, { steps, patchPath: patch });
  const step = async (name, fn) => {
    const s = { name, status: 'running', detail: '' }; steps.push(s); save();
    try {
      const r = (await fn()) || {};
      s.status = r.warn ? 'warn' : (r.skipped ? 'skipped' : 'ok'); s.detail = r.detail || ''; if (r.warn) warned = true;
    } catch (e) { s.status = 'failed'; s.detail = e.message; save(); throw e; }
    save();
  };
  const must = async (cwd, args, what) => {
    const r = await gitx(cwd, args);
    if (!r.ok) throw new StepError(what + ' failed: ' + (r.err || r.out || 'git exited ' + r.code).split(/\r?\n/).slice(0, 4).join(' | '));
    return r;
  };
  try {
    await step('Fetch origin/main', async () => { await must(live, ['fetch', 'origin', 'main'], 'git fetch'); return { detail: 'origin/main is now ' + short((await gitx(live, ['rev-parse', 'origin/main'])).out) }; });

    await step('Save the worktree changes as a patch', async () => {
      const st = lines((await gitx(wt, ['status', '--porcelain'], 60000)).out);
      if (!st.length) return { skipped: true, detail: 'No uncommitted changes in the worktree.' };
      await must(wt, ['add', '-N', '.'], 'marking new files for the patch'); // new files are invisible to diff until intent-to-add
      patch = path.join(dir, 'uncommitted.patch');
      await must(wt, ['diff', '--binary', '--output=' + patch], 'git diff');
      if (!fs.existsSync(patch) || fs.statSync(patch).size === 0) throw new StepError('The patch is empty, so nothing was changed. Check the worktree with git status.');
      fs.writeFileSync(path.join(dir, 'worktree-status.txt'), st.join('\n') + '\n');
      return { detail: st.length + ' file(s), ' + fs.statSync(patch).size + ' bytes, kept at ' + patch };
    });

    await step('Stash the live repo\'s own changes', async () => {
      const before = lines((await gitx(live, ['status', '--porcelain'], 60000)).out);
      if (!before.length) return { skipped: true, detail: 'The live repo was clean.' };
      const msg = 'hub-move ' + id + ': live changes on ' + p.live.branch + ' before moving ' + branch;
      await must(live, ['stash', 'push', '-u', '-m', msg], 'git stash');
      const hash = (await must(live, ['rev-parse', 'stash@{0}'], 'reading the new stash')).out;
      const after = lines((await gitx(live, ['status', '--porcelain'], 60000)).out);
      stashId = store.stashAdd({ moveId: id, repoKey: p.repoKey, livePath: live, hash, message: msg, prevBranch: p.live.branch, files: before });
      if (after.length) throw new StepError('The live repo is still not clean after stashing (' + after.length + ' file(s)). The stash was saved, nothing else was changed.');
      return { detail: before.length + ' file(s) stashed as ' + short(hash) + ' (listed under Stashed work)' };
    });

    await step('Remove the worktree', async () => {
      const links = unlinkLinks(wt);
      let r = await gitx(live, ['worktree', 'remove', '--force', wt]);
      if (!r.ok && !fs.existsSync(wt)) r = await gitx(live, ['worktree', 'prune']);
      if (!r.ok) throw new StepError('git worktree remove failed: ' + (r.err || r.out).split(/\r?\n/).slice(0, 3).join(' | ') + '. Your changes are saved in the patch.');
      const left = fs.existsSync(wt);
      return { warn: left, detail: (links.length ? 'Unlinked ' + links.length + ' link(s) (targets untouched). ' : '') + (left ? 'The folder is still on disk (a file may be locked); delete it by hand.' : 'Removed.') };
    });

    await step('Switch the live repo to ' + branch, async () => { await must(live, ['checkout', branch], 'git checkout ' + branch); return { detail: 'Live repo is on ' + branch + ' (was ' + p.live.branch + ')' }; });

    await step('Merge origin/main', async () => {
      const behind = Number((await gitx(live, ['rev-list', '--count', 'HEAD..origin/main'])).out) || 0;
      if (behind === 0) { mergeNote = 'already contained origin/main'; return { detail: 'Branch already contains origin/main.' }; }
      const before = (await gitx(live, ['rev-parse', 'HEAD'])).out;
      const m = await gitx(live, ['merge', '--no-edit', 'origin/main']);
      if (m.ok) {
        const after = (await gitx(live, ['rev-parse', 'HEAD'])).out;
        // Fast-forward = HEAD is now exactly origin/main. (Counting parents would be wrong: origin/main's own tip is often a PR merge.)
        const tip = (await gitx(live, ['rev-parse', 'origin/main'])).out;
        mergeNote = after === tip ? 'fast-forwarded to origin/main' : 'merged origin/main (new merge commit ' + short(after) + ')';
        return { detail: mergeNote + ' (' + short(before) + ' to ' + short(after) + ')' };
      }
      const conflicted = lines((await gitx(live, ['diff', '--name-only', '--diff-filter=U'])).out);
      await gitx(live, ['merge', '--abort']);
      const clean = !(await gitPathExists(live, 'MERGE_HEAD'));
      mergeNote = 'NOT merged: origin/main conflicts';
      return { warn: true, detail: 'Merge skipped' + (clean ? ' (aborted cleanly)' : ' (could not abort: run git merge --abort)') + '. ' + (conflicted.length ? 'Conflicts: ' + conflicted.slice(0, 8).join(', ') : (m.err || '').split(/\r?\n/)[0]) };
    });

    await step('Apply the worktree changes (uncommitted)', async () => {
      if (!patch) return { skipped: true, detail: 'There were no uncommitted changes to apply.' };
      let r = await gitx(live, ['apply', '--whitespace=nowarn', patch]);
      if (r.ok) return { detail: 'Applied cleanly.' };
      r = await gitx(live, ['apply', '--3way', '--whitespace=nowarn', patch]);
      // --3way exits non-zero when it leaves conflict markers; that is a warning, not a failure.
      const conflicted = lines((await gitx(live, ['diff', '--name-only', '--diff-filter=U'])).out);
      if (!r.ok && !conflicted.length) throw new StepError('The patch does not apply on top of the merged branch: ' + (r.err || r.out).split(/\r?\n/).slice(0, 3).join(' | ') + '. The patch is kept.');
      await gitx(live, ['reset', '-q']); // --3way stages; put it back to unstaged like the original worktree
      return conflicted.length ? { warn: true, detail: 'Applied with conflict markers in: ' + conflicted.slice(0, 8).join(', ') }
        : { detail: 'Applied after a three-way merge with the new main.' };
    });

    const fin = lines((await gitx(live, ['status', '--porcelain'], 60000)).out);
    const bits = ['Live repo ' + live + ' is on ' + branch + ' with ' + fin.length + ' uncommitted file(s); ' + mergeNote + '.'];
    if (stashId) bits.push('Your previous live changes are in the stash list (see Stashed work).');
    store.moveUpdate(id, { status: warned ? 'done-with-warnings' : 'done', summary: bits.join(' '), finishedAt: new Date().toISOString(), steps, patchPath: patch });
  } catch (e) {
    const failed = steps.find((s) => s.status === 'failed');
    const safe = [];
    if (patch) safe.push('worktree changes are saved at ' + patch);
    if (stashId) safe.push('your live changes are in a stash recorded under Stashed work');
    store.moveUpdate(id, { status: 'failed', steps, patchPath: patch, finishedAt: new Date().toISOString(),
      summary: 'Stopped at "' + (failed ? failed.name : '?') + '": ' + e.message + (safe.length ? ' Nothing is lost: ' + safe.join('; ') + '.' : ' Nothing was changed before this step.') });
  } finally { busy = null; }
}

async function start(wtPath, user, repoKey) {
  if (busy) { const e = new Error('Another move is running.'); e.status = 409; throw e; }
  busy = 'planning';
  let p;
  try { p = await plan(wtPath, true); } catch (e) { busy = null; throw e; }
  if (p.blockers.length) { busy = null; const e = new Error(p.blockers[0]); e.status = 409; e.blockers = p.blockers; throw e; }
  p.repoKey = repoKey || '';
  const id = store.moveStart({ wtPath: p.worktree.path, branch: p.worktree.branch, repoKey, livePath: p.live.path, prevLiveBranch: p.live.branch }, user);
  busy = id;
  run(id, p, user); // runs in the background; the UI polls /api/moves/:id
  return id;
}

/* ---------- stash state ---------- */
async function stashStates(list) {
  const byLive = new Map();
  for (const s of list) { if (!byLive.has(s.livePath)) byLive.set(s.livePath, null); }
  for (const lp of byLive.keys()) {
    const r = fs.existsSync(lp) ? await gitx(lp, ['stash', 'list', '--format=%H'], 30000) : null;
    byLive.set(lp, r && r.ok ? new Set(lines(r.out)) : null);
  }
  return list.map((s) => {
    const set = byLive.get(s.livePath);
    return { ...s, state: s.handledAt ? 'handled' : (set === null ? 'unknown' : (set.has(s.hash) ? 'stashed' : 'gone')) };
  });
}

module.exports = { plan, start, stashStates, isBusy: () => !!busy, unlinkLinks };
