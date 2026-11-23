const HUBROOT = require('path').resolve(__dirname, '..').replace(/\\/g, '/'); require('./_config')();
// The integration routes over HTTP: off by default, on only when the settings say so, only for configured clones.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intapi-'));
const clone = path.join(root, 'Clone'); fs.mkdirSync(clone);
const on = path.join(root, 'on.json');
const base = JSON.parse(fs.readFileSync(process.env.HUB_CONFIG, 'utf8'));
fs.writeFileSync(on, JSON.stringify({ ...base, integrations: { enabled: true }, scorecard: { configFile: path.join(HUBROOT, 'test', 'fixtures', 'scorecard.config.json') }, usage: { file: path.join(root, 'none.jsonl') } }));
let fails = 0;
const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!ok) fails++; };
const start = (port, cfgFile) => spawn(process.execPath, [HUBROOT + '/server.js'], { stdio: 'ignore', env: { ...process.env, HUB_CONFIG: cfgFile, HUB_PORT: String(port), HUB_DATA_DIR: path.join(root, 'data' + port), HUB_ONLY_EXTRA: '1', HUB_EXTRA_CLONES: clone } });
const up = async (b) => { for (let i = 0; i < 60; i++) { try { await fetch(b + '/api/me'); return; } catch { await new Promise((r) => setTimeout(r, 250)); } } };
const get = (b, p) => fetch(b + p).then(async (r) => [r.status, await r.json().catch(() => ({}))]);
(async () => {
  const offSrv = start(4741, process.env.HUB_CONFIG), onSrv = start(4742, on);
  try {
    const A = 'http://localhost:4741', B = 'http://localhost:4742';
    await Promise.all([up(A), up(B)]);
    let [s, b] = await get(A, '/api/integrations/agents');
    check('off by default: the agents route answers 404 and says how to turn it on', s === 404 && /enabled/.test(b.error), s + ' ' + b.error);
    [s, b] = await get(A, '/api/integrations/github?repo=' + encodeURIComponent(clone));
    check('off by default: the GitHub route answers 404', s === 404);
    [s, b] = await get(B, '/api/integrations/agents');
    check('on: the agents route lists both providers, metadata only', s === 200 && b.codex && b.gemini && b.codex.metadataOnly === true && Array.isArray(b.codex.errors));
    [s, b] = await get(B, '/api/integrations/github');
    check('on: no repo given is a 400', s === 400);
    [s, b] = await get(B, '/api/integrations/github?repo=' + encodeURIComponent(path.join(root, 'Other')));
    check('on: a folder that is not a configured clone is a 400', s === 400);
    [s, b] = await get(B, '/api/integrations/github?repo=relative/path');
    check('on: a relative path is a 400', s === 400);
    [s, b] = await get(B, '/api/integrations/github?repo=' + encodeURIComponent(clone.toUpperCase()));
    check('on: the same clone in different capitals is accepted (not a 400)', s !== 400, String(s));
    [s, b] = await get(B, '/api/integrations/github?repo=' + encodeURIComponent(clone));
    check('on: a configured clone gets a clear classified error, never a bare "not authenticated"', [404, 502, 401].includes(s) && ['noremote', 'notinstalled', 'auth', 'access', 'other', 'timeout'].includes(b.kind) && !!b.error, s + ' ' + b.kind + ' ' + b.error);
  } finally {
    offSrv.kill(); onSrv.kill();
    setTimeout(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp */ } }, 1500);
  }
  if (fails) process.exit(1);
  console.log('ALL PASSED');
})();
