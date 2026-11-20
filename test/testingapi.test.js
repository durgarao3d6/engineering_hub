const HUBROOT = require('path').resolve(__dirname, '..').replace(/\\/g, '/'); require('./_config')();
// The Testing page API: a throwaway hub over a throwaway specs folder and QA repository.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qaapi-'));
process.env.HUB_DATA_DIR = path.join(dir, 'fixture-data');
Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' });
const FX = require('./_qafixture.js').build(dir);
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const cfgFile = path.join(dir, 'hub.config.json');
fs.writeFileSync(cfgFile, JSON.stringify({ branchPrefix: 'dev', testing: { specsDir: FX.LPS, evidenceDir: FX.evid, worktreeRoot: path.join(dir, 'wt'), qa: { path: FX.QA, libDir: 'shared/flows', importTo: '../../shared/flows/', defaultTags: ['@regression', '@flows', '@api'] } } }));
const port = 4725; const base = 'http://localhost:' + port;
const srv = spawn(process.execPath, [HUBROOT + '/server.js'], { stdio: 'ignore', env: { ...process.env, HUB_CONFIG: cfgFile, HUB_PORT: String(port), HUB_DATA_DIR: path.join(dir, 'data'), HUB_ONLY_EXTRA: '1', HUB_EXTRA_CLONES: '' } });
const H = { 'Content-Type': 'application/json', 'X-Hub-Request': '1' };
const post = (p, b, h) => fetch(base + p, { method: 'POST', headers: h || H, body: JSON.stringify(b || {}) }).then(async (r) => [r.status, await r.json().catch(() => ({}))]);
const get = (p) => fetch(base + p).then(async (r) => [r.status, await r.json().catch(() => ({}))]);
let fails = 0;
const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!ok) fails++; };

(async () => {
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/me'); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  const qaBefore = g(FX.QA, 'status', '--porcelain') + g(FX.QA, 'rev-parse', 'HEAD');

  console.log('--- the page data');
  let [s, d] = await get('/api/testing');
  const by = Object.fromEntries((d.entries || []).map((e) => [e.file, e]));
  check('the catalogue loads with QA status, evidence, the library and no file contents', s === 200 && d.configured && d.qaConfigured && d.entries.length === 7 && by['01-cancel.spec.ts'].status === 'in-sync' && by['01-cancel.spec.ts'].evidence.ok === true && by['03-new.spec.ts'].status === 'not-in-qa' && by['04-graph.spec.ts'].status === 'cannot-port' && d.library.length >= 3 && !JSON.stringify(d).includes('test.step('), JSON.stringify([s, d.entries && d.entries.length]));
  check('evidence runs are counted', d.evidenceRuns === 2);
  [s, d] = await get('/api/testing/spec?file=03-new.spec.ts');
  check('one flow\'s detail has the card, the Test Plans draft and the rewritten spec', s === 200 && /# Third flow/.test(d.card) && /Associated automation/.test(d.testCase) && /const TAGS/.test(d.portedSpec));
  [s] = await get('/api/testing/spec?file=..%2Fx.spec.ts');
  check('an odd name is a 400', s === 400);
  [s] = await get('/api/testing/spec?file=nope.spec.ts');
  check('an unknown spec is a 404', s === 404);

  console.log('--- guards');
  [s] = await post('/api/testing/preview', { files: ['03-new.spec.ts'] }, { 'Content-Type': 'application/json' });
  check('a write without the hub header is refused (403)', s === 403);
  let r = await fetch(base + '/api/testing/pack', { method: 'POST', headers: { ...H, Origin: 'https://evil.example' }, body: '{}' });
  check('from another origin (403)', r.status === 403);
  r = await fetch(base + '/api/testing/pack', { method: 'POST', headers: H, body: JSON.stringify({ files: ['x'.repeat(20000)] }) });
  check('an oversized body is refused (413)', r.status === 413);
  [s] = await post('/api/testing/preview', { files: [] });
  check('no flow picked is a 400', s === 400);
  [s, d] = await post('/api/testing/preview', { files: ['../../etc/passwd', '..\\x.spec.ts', 'a/b.spec.ts'] });
  check('names that are not plain spec names are dropped before anything happens (400)', s === 400);

  console.log('--- preview and pack');
  [s, d] = await post('/api/testing/preview', { files: ['03-new.spec.ts', '04-graph.spec.ts'], include: ['card', 'spec'] });
  check('preview lists the files and the reason for what is left out, and writes nothing', s === 200 && d.files.map((f) => f.kind).sort().join() === 'card,card,spec' && d.skipped.some((x) => /gremlin/.test(x.why)) && g(FX.QA, 'status', '--porcelain') + g(FX.QA, 'rev-parse', 'HEAD') === qaBefore);
  [s, d] = await post('/api/testing/pack', { files: ['03-new.spec.ts', '01-cancel.spec.ts'], taskId: '4242' });
  check('the pack is prepared in a new worktree (201) and nothing is committed', s === 201 && d.branch.startsWith('dev/4242-qa-flows-') && fs.existsSync(path.join(d.worktree, 'tests/flows/03-new.spec.ts')) && g(d.worktree, 'diff', '--cached', '--name-only') === '' && g(d.worktree, 'rev-parse', 'HEAD') === g(FX.QA, 'rev-parse', 'origin/main'), JSON.stringify([s, d.error]));
  const wt = d.worktree;
  check('the live QA clone is unchanged', g(FX.QA, 'status', '--porcelain') + g(FX.QA, 'rev-parse', 'HEAD') === qaBefore);
  check('nothing reached the QA remote', !/qa-flows/.test(g(FX.QAO, 'for-each-ref')));
  [s, d] = await get('/api/testing');
  check('the page now lists the pack', d.packs.length === 1 && d.packs[0].worktree === wt && d.packs[0].files.length >= 3);
  [s, d] = await post('/api/testing/pack', { files: ['01-cancel.spec.ts'], include: ['spec'] });
  check('a pack with nothing to write is a 409', s === 409 && /nothing to write/.test(d.error));
  [s, d] = await post('/api/testing/pack', { files: ['02-edited.spec.ts'], include: ['spec'] });
  check('a hand-edited QA copy is not replaced unless you say so (409: nothing to write)', s === 409);
  [s, d] = await post('/api/testing/pack', { files: ['02-edited.spec.ts'], include: ['spec'], overwrite: ['02-edited.spec.ts'] });
  check('with the explicit choice it is prepared (201) in another worktree', s === 201 && d.worktree !== wt);

  console.log('--- records');
  const health = (await get('/api/health'))[1].db;
  check('schema is current and QA packs are counted', health.schemaVersion === health.expectedSchemaVersion && health.counts.qaPacks === 2, JSON.stringify(health.counts));
  srv.kill();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } process.exit(fails ? 1 : 0); }, 700);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
