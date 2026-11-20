'use strict';
// Which task is a Claude session working on? From the git branch (<prefix>/<id>-..., <prefix>/<type>_<id>_...) or the worktree folder name (<name>-<id>).
// Read-only: one `git branch --show-current`.
const { execFileSync } = require('child_process');
const path = require('path');

const cfg = require('../config');
const BRANCH = cfg.branchRe;
const FOLDER = /-(\d{3,6})$/;

function detectTask(cwd) {
  try {
    const b = execFileSync('git', ['-C', cwd, 'branch', '--show-current'], { encoding: 'utf8', timeout: 2500, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = BRANCH.exec(b); if (m) return Number(m[1]);
  } catch { /* not a git folder */ }
  const f = FOLDER.exec(path.basename(String(cwd || '').replace(/[\\/]+$/, '')));
  return f ? Number(f[1]) : null;
}

module.exports = { detectTask };
