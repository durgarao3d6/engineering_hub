// Runs every test suite one after another (each uses throwaway folders, repos and databases) and prints one summary.
// Usage: node test/run-all.js [name-filter]
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = __dirname;
const filter = process.argv[2] || '';
const suites = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js') && f.includes(filter)).sort();
// Every suite gets one shared temporary folder (TEMP/TMP), removed at the end when no process holds a file in it any more.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-tests-'));
const results = [];
for (const s of suites) {
  const t = Date.now();
  const r = spawnSync(process.execPath, [path.join(dir, s)], { encoding: 'utf8', timeout: 5 * 60 * 1000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, TEMP: TMP, TMP, TMPDIR: TMP } });
  const text = (r.stdout || '') + (r.stderr || '');
  const passed = (text.match(/^PASS /gm) || []).length;
  const failed = (text.match(/^FAIL /gm) || []).length;
  const ok = r.status === 0 && failed === 0 && /ALL PASSED/.test(text);
  results.push({ s, ok, passed, failed, secs: Math.round((Date.now() - t) / 100) / 10 });
  console.log((ok ? 'ok   ' : 'FAIL ') + s.padEnd(26) + passed + ' checks, ' + failed + ' failed, ' + (Date.now() - t) / 1000 + ' s');
  if (!ok) console.log(text.split('\n').filter((l) => /^FAIL |Error|FAILED/.test(l)).slice(0, 12).map((l) => '       ' + l).join('\n'));
}
const bad = results.filter((r) => !r.ok);
console.log('\n' + results.length + ' suites, ' + results.reduce((n, r) => n + r.passed, 0) + ' checks, ' + (bad.length ? bad.length + ' suite(s) FAILED: ' + bad.map((r) => r.s).join(', ') : 'all passed'));
try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 }); } catch { console.log('(could not remove ' + TMP + ')'); }
process.exit(bad.length ? 1 : 0);
