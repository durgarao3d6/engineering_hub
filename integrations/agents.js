'use strict';
// Portable, local-only discovery. No transcript contents are read, sent or stored.
const fs = require('fs');
const os = require('os');
const path = require('path');
const PROVIDERS = Object.freeze({
  codex: { roots: [path.join(os.homedir(), '.codex', 'sessions')], extensions: ['.jsonl'] },
  gemini: { roots: [path.join(os.homedir(), '.gemini', 'tmp')], extensions: ['.json'], namePattern: /^session-.*\.json$/ }, // chat sessions only, not logs.json or settings
});
function scan(root, extensions, maxFiles = 2000, namePattern = null) {
  const results = [], pending = [{ dir: root, depth: 0 }];
  let examined = 0, unreadable = 0;
  while (pending.length && examined < maxFiles) {
    const { dir, depth } = pending.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { unreadable++; continue; }
    for (const entry of entries) {
      if (++examined > maxFiles) break;
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && depth < 5) pending.push({ dir: file, depth: depth + 1 });
      else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext)) && (!namePattern || namePattern.test(entry.name))) {
        try {
          const st = fs.statSync(file);
          results.push({ id: path.relative(root, file).replace(/\\/g, '/'), modifiedAt: st.mtime.toISOString(), bytes: st.size });
        } catch { /* files can disappear while scanning */ }
      }
    }
  }
  return { files: results.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 100), truncated: examined >= maxFiles, unreadable };
}
function discover(provider, roots) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error('Unsupported agent provider.');
  const dirs = roots || p.roots;
  const sessions = [], errors = [];
  for (const root of dirs) {
    if (!fs.existsSync(root)) continue; // a folder that does not exist is simply not configured
    try {
      const r = scan(root, p.extensions, 2000, p.namePattern);
      sessions.push(...r.files);
      if (r.unreadable) errors.push(r.unreadable + ' folder(s) under ' + path.basename(root) + ' could not be read.');
      if (r.truncated) errors.push('Scan stopped at the file limit; older sessions may be missing.');
    } catch { errors.push('Could not scan an agent session directory.'); }
  }
  return { provider, readOnly: true, metadataOnly: true, configured: dirs.some((d) => fs.existsSync(d)), sessions: sessions.sort((a,b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 100), errors, observedAt: new Date().toISOString() };
}
function discoverAll() { return { codex: discover('codex'), gemini: discover('gemini') }; }
module.exports = { discover, discoverAll };
