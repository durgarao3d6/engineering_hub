'use strict';
// Portable, local-only discovery. No transcript contents are read, sent or stored.
const fs = require('fs');
const os = require('os');
const path = require('path');
const PROVIDERS = Object.freeze({
  codex: { roots: [path.join(os.homedir(), '.codex', 'sessions')], extensions: ['.jsonl'] },
  gemini: { roots: [path.join(os.homedir(), '.gemini', 'tmp')], extensions: ['.json'] },
});
function scan(root, extensions, maxFiles = 2000) {
  const results = [], pending = [{ dir: root, depth: 0 }];
  let examined = 0;
  while (pending.length && examined < maxFiles) {
    const { dir, depth } = pending.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (++examined > maxFiles) break;
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && depth < 5) pending.push({ dir: file, depth: depth + 1 });
      else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
        try {
          const st = fs.statSync(file);
          results.push({ id: path.relative(root, file).replace(/\\/g, '/'), modifiedAt: st.mtime.toISOString(), bytes: st.size });
        } catch { /* files can disappear while scanning */ }
      }
    }
  }
  return { files: results.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 100), truncated: examined >= maxFiles };
}
function discover(provider, roots) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error('Unsupported agent provider.');
  const dirs = roots || p.roots;
  const sessions = [], errors = [];
  for (const root of dirs) {
    try { sessions.push(...scan(root, p.extensions).files); }
    catch { errors.push('Could not scan an agent session directory.'); }
  }
  return { provider, readOnly: true, metadataOnly: true, configured: dirs.some((d) => fs.existsSync(d)), sessions: sessions.sort((a,b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 100), errors, observedAt: new Date().toISOString() };
}
function discoverAll() { return { codex: discover('codex'), gemini: discover('gemini') }; }
module.exports = { discover, discoverAll };
