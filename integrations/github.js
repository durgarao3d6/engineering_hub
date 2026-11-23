'use strict';
// Optional GitHub adapter: read-only via the authenticated gh CLI; the hub stores no token.
// Only two gh commands exist here (repo view, pr list); anything else is refused before a process starts.
const { execFile } = require('child_process');
const path = require('path');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const FIELDS = 'number,title,state,isDraft,url,headRefName,baseRefName,updatedAt';
const ALLOWED = new Set(['repo view', 'pr list']);

function fail(kind, message) { const e = new Error(message); e.kind = kind; return e; }

// Turns a gh failure into a message that says what is actually wrong.
function classify(err) {
  if (err && err.code === 'ENOENT') return fail('notinstalled', 'GitHub CLI is not installed (install gh).');
  const text = String((err && err.stderr) || '') + ' ' + String((err && err.message) || '');
  if (err && err.killed) return fail('timeout', 'GitHub CLI took too long to answer.');
  if (/none of the git remotes|not a git repository|no git remotes|could not determine|unable to determine base repo/i.test(text)) return fail('noremote', 'This repository is not on GitHub (no GitHub remote), so there is nothing to show.');
  if (/gh auth login|not logged in|authentication|HTTP 401|bad credentials/i.test(text)) return fail('auth', 'GitHub CLI is not signed in. Run gh auth login, then try again.');
  if (/HTTP 403|HTTP 404|could not resolve to a repository|rate limit/i.test(text)) return fail('access', 'GitHub refused access to this repository for your account.');
  const first = String((err && err.stderr) || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
  return fail('other', 'GitHub CLI failed' + (first ? ': ' + first.slice(0, 160) : '.'));
}

async function defaultRun(cmd, argv, opts) { return execFileP(cmd, argv, opts); }

async function gh(args, cwd, run = defaultRun) {
  if (!ALLOWED.has(args.slice(0, 2).join(' '))) throw fail('refused', 'That GitHub command is not allowed (read-only).');
  const opts = { cwd, timeout: 12000, maxBuffer: 2 * 1024 * 1024, windowsHide: true };
  const cmd = process.platform === 'win32' ? 'gh.exe' : 'gh'; // the native binary directly: no command shell
  try { return String((await run(cmd, args, opts)).stdout).trim(); }
  catch (e) { throw classify(e); }
}

function safeRepoPath(repoPath) {
  if (typeof repoPath !== 'string' || !path.isAbsolute(repoPath)) throw fail('path', 'A configured absolute repository path is required.');
  return path.resolve(repoPath);
}

async function inspect(repoPath, run) {
  const cwd = safeRepoPath(repoPath);
  const [remote, prs] = await Promise.all([
    gh(['repo', 'view', '--json', 'nameWithOwner,url,defaultBranchRef'], cwd, run),
    gh(['pr', 'list', '--state', 'open', '--limit', '50', '--json', FIELDS], cwd, run),
  ]);
  let repo, pullRequests;
  try { repo = JSON.parse(remote); pullRequests = JSON.parse(prs); }
  catch { throw fail('other', 'GitHub CLI returned something unexpected.'); }
  return { provider: 'github', source: 'gh-cli', readOnly: true, repository: repo, pullRequests, observedAt: new Date().toISOString() };
}
module.exports = { inspect, safeRepoPath, classify, gh, ALLOWED };
