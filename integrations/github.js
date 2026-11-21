'use strict';
// Optional GitHub adapter: read-only via authenticated gh CLI; no tokens persisted by Hub.
const { execFile } = require('child_process');
const path = require('path');
const { promisify } = require('util');
const run = promisify(execFile);
const FIELDS = 'number,title,state,isDraft,url,headRefName,baseRefName,updatedAt';
async function gh(args, cwd) {
  const opts = { cwd, timeout: 12000, maxBuffer: 2 * 1024 * 1024, windowsHide: true };
  // gh.cmd on Windows is a batch script; invoke through cmd.exe without a shell on Unix.
  const cmd = process.platform === 'win32' ? 'cmd.exe' : 'gh';
  const argv = process.platform === 'win32' ? ['/d', '/s', '/c', 'gh', ...args] : args;
  try { return (await run(cmd, argv, opts)).stdout.trim(); }
  catch (e) { throw new Error(/ENOENT/.test(e.code || '') ? 'GitHub CLI not installed (install gh).' : 'GitHub CLI unavailable or not authenticated; run gh auth login and verify repository access.'); }
}
function safeRepoPath(repoPath) {
  if (typeof repoPath !== 'string' || !path.isAbsolute(repoPath)) throw new Error('A configured absolute repository path is required.');
  return path.resolve(repoPath);
}
async function inspect(repoPath) {
  const cwd = safeRepoPath(repoPath);
  const [remote, prs] = await Promise.all([
    gh(['repo', 'view', '--json', 'nameWithOwner,url,defaultBranchRef', '--jq', '.'], cwd),
    gh(['pr', 'list', '--state', 'open', '--limit', '50', '--json', FIELDS], cwd),
  ]);
  const repo = JSON.parse(remote), pullRequests = JSON.parse(prs);
  return { provider: 'github', source: 'gh-cli', readOnly: true, repository: repo, pullRequests, observedAt: new Date().toISOString() };
}
module.exports = { inspect, safeRepoPath };
