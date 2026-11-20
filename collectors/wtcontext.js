'use strict';
// Code context of a worktree, used to write better drafts. READ-ONLY git only (log, diff --name-only, status, rev-parse).
// It returns file names and commit subjects, never file contents.
const { gitx, pool } = require('./git');

const lines = (s) => (s ? s.split(/\r?\n/).filter(Boolean) : []);
const CAPS = { commits: 6, files: 20 };
const cache = new Map();

async function contextFor(w) {
  const hit = cache.get(w.path);
  if (hit && Date.now() - hit.at < 60000) return hit.v;
  const cwd = w.path;
  const hasMain = (await gitx(cwd, ['rev-parse', '--verify', '-q', 'origin/main'], 15000)).ok;
  const [log, diff, st] = await Promise.all([
    hasMain ? gitx(cwd, ['log', '--format=%s', '-n', String(CAPS.commits), 'origin/main..HEAD'], 20000) : { out: '' },
    hasMain ? gitx(cwd, ['diff', '--name-only', 'origin/main...HEAD'], 20000) : { out: '' },
    gitx(cwd, ['status', '--porcelain', '--untracked-files=all'], 30000), // list new files one by one, not as a collapsed folder
  ]);
  const committed = lines(diff.out); const uncommitted = lines(st.out).map((l) => l.slice(3));
  const v = {
    repoKey: w.repoKey, layer: w.layer, branch: w.branch, liveCheckout: !!w.isMain,
    commits: lines(log.out).slice(0, CAPS.commits),
    committedFiles: committed.slice(0, CAPS.files), moreCommittedFiles: Math.max(0, committed.length - CAPS.files),
    uncommittedFiles: uncommitted.slice(0, CAPS.files), moreUncommittedFiles: Math.max(0, uncommitted.length - CAPS.files),
  };
  cache.set(w.path, { at: Date.now(), v });
  return v;
}

const contextMany = (list) => pool(list, 4, contextFor);

module.exports = { contextFor, contextMany, clearCache: () => cache.clear() };
