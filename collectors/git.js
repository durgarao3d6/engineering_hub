'use strict';
// git() is for read-only collectors. gitx() keeps exit code and stderr and is also used by mover.js,
// the one place that changes a repo (only after the user confirms "Move to live").
const { execFile } = require('child_process');
const fs = require('fs');

function git(cwd, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile('git', ['--no-optional-locks', '-c', 'core.longpaths=true', ...args],
      { cwd, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => resolve({ ok: !err, out: (stdout || '').toString().trim() }));
  });
}

function gitx(cwd, args, timeout = 120000) {
  return new Promise((resolve) => {
    execFile('git', ['--no-optional-locks', '-c', 'core.longpaths=true', ...args],
      { cwd, timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => resolve({
        ok: !err, code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        out: (stdout || '').toString().trim(), err: (stderr || '').toString().trim(),
      }));
  });
}

async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; results[k] = await fn(items[k]); }
  }));
  return results;
}

module.exports = { git, gitx, pool, exists: (p) => fs.existsSync(p) };
