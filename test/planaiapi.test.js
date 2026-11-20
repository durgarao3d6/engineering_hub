const HUBROOT = require('path').resolve(__dirname, '..').replace(/\\/g, '/'); require('./_config')();
// AI auto-planning over HTTP: a throwaway hub with fake work items, fake discussions and the stub CLI.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const W = require(HUBROOT + '/lib/workdays.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paiapi-'));
const fake = path.join(root, 'items.json');
const mk = (id, o) => ({ id, type: 'Bug', title: 'Item ' + id, state: 'Active', assignedTo: 'Test User', priority: 2, changedDate: '2030-03-05T10:00:00Z', url: 'https://example/' + id, ...o });
const world = { me: 'Test User', reviews: [], assigned: [mk(1, { priority: 1, title: 'Crash on save' }), mk(2), mk(3, { priority: 3 }), mk(4), mk(5, { priority: 4 })],
  items: [], search: [mk(50, { title: 'Billing export fails', assignedTo: '', tags: 'billing' })],
  details: { 1: { description: '<p>Production outage when saving. Contact lee@example.com.</p>' }, 2: { description: '<p>Update the header.</p>' }, 3: { description: '<p>Already fixed in release 5 per Sam.</p>' }, 4: { description: '<p>Unclear what is wanted. Needs more info.</p>' }, 5: { description: '<p>Tidy.</p>' }, 50: { description: '<p>Export fails.</p>' } },
  comments: { 1: [{ author: 'Pat', at: '2030-03-04T09:00:00Z', html: '<p>Customer is blocked, call me on lee@example.com</p>' }], 3: [{ author: 'Sam', at: '2030-03-04T09:00:00Z', html: '<p>This was already fixed.</p>' }] } };
fs.writeFileSync(fake, JSON.stringify(world));
const port = 4724; const base = 'http://localhost:' + port;
const log = path.join(root, 'calls.log');
const srv = spawn(process.execPath, [HUBROOT + '/server.js'], { stdio: 'ignore', env: { ...process.env, HUB_PORT: String(port), HUB_DATA_DIR: path.join(root, 'data'), HUB_FAKE_WORKITEMS: fake, HUB_ONLY_EXTRA: '1', HUB_EXTRA_CLONES: '',
  HUB_CLAUDE_BIN: HUBROOT + '/test/stub-claude.js', STUB_MODE: 'ok', STUB_LOG: log, STUB_STATE: path.join(root, 'state'), AZURE_DEVOPS_EXT_PAT: 'secret', SYSTEM_ACCESSTOKEN: 'secret' } });
const H = { 'Content-Type': 'application/json', 'X-Hub-Request': '1' };
const post = (p, b, h) => fetch(base + p, { method: 'POST', headers: h || H, body: JSON.stringify(b || {}) }).then(async (r) => [r.status, await r.json().catch(() => ({}))]);
const get = (p) => fetch(base + p).then(async (r) => [r.status, await r.json()]);
let fails = 0;
const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!ok) fails++; };
const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

(async () => {
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/me'); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  const T = W.today();

  console.log('--- guards');
  let [s] = await post('/api/planner/ai/estimate', {}, { 'Content-Type': 'application/json' });
  check('an estimate without the hub header is refused (403)', s === 403);
  let r = await fetch(base + '/api/planner/ai/run', { method: 'POST', headers: { ...H, Origin: 'https://evil.example' }, body: '{}' });
  check('from another origin (403)', r.status === 403);
  r = await fetch(base + '/api/planner/ai/apply', { method: 'POST', headers: H, body: JSON.stringify({ runId: 'x', picks: [{ note: 'x'.repeat(40000) }] }) });
  check('an oversized body is refused (413)', r.status === 413);

  console.log('--- estimate, run, review');
  let est; [s, est] = await post('/api/planner/ai/estimate', {});
  check('estimate reads the items and the discussion but calls no model', s === 200 && est.items === 5 && est.toAnalyse === 5 && calls().length === 0 && est.runId && est.estimatedUsd > 0, JSON.stringify([s, est.items, calls().length]));
  check('the topics scope is included only when saved topics exist, so billing item 50 is not offered yet', !est.sample.some((x) => x.id === 50));
  let run; [s, run] = await post('/api/planner/ai/run', { runId: est.runId });
  const pm = Object.fromEntries((run.items || []).map((i) => [i.id, i]));
  check('run returns a proposal: engine ai, one placement per item, groups for fixed and needs-info', s === 200 && run.engine === 'ai' && run.items.length === est.items && pm[3].where === 'fixed' && pm[4].where === 'needs-info', JSON.stringify(run.items && run.items.map((i) => i.id + ':' + i.where)));
  check('nothing has been scheduled by running (only Apply does that)', (await get('/api/planner'))[1].days.every((d) => d.items.length === 0));
  const L = calls();
  check('the model saw descriptions and discussion with addresses masked, and no Azure credentials', /Production outage/.test(L[0].prompt) && /Customer is blocked/.test(L[0].prompt) && !/lee@example\.com/.test(L.map((c) => c.prompt).join('')) && L.every((c) => c.azureEnv.length === 0 && c.toolsArg === ''));
  [s, r] = await post('/api/planner/ai/run', { runId: 'nope' });
  check('an unknown or expired estimate is a 404', s === 404);

  console.log('--- apply');
  const day = pm[1].date;
  [s, r] = await post('/api/planner/ai/apply', { runId: est.runId, picks: [{ id: 1, where: 'day', date: day }, { id: 2, where: 'later' }, { id: 5, where: 'day', date: W.addDays(T, 400) }] });
  check('apply schedules what you picked and reports each result', s === 200 && r.applied === 2 && r.failed === 1 && r.results.find((x) => x.id === 5).ok === false, JSON.stringify(r.results));
  const [, b] = await get('/api/planner');
  check('the picked item is on its day and the other is in Later', b.days.find((d) => d.date === day).items.some((i) => i.taskId === 1) && b.later.some((l) => l.taskId === 2));
  const [, plan] = await get('/api/plan?date=' + day);
  check('and it is a normal line in Today\'s plan for that day', day !== T || plan.items.some((i) => i.taskId === 1) || (await get('/api/plan?date=' + day))[1].items.some((i) => i.taskId === 1));
  [s] = await post('/api/planner/ai/apply', { runId: est.runId, picks: [] });
  check('a proposal applies once (409)', s === 409);
  [s] = await post('/api/planner/ai/apply', { runId: 'nope', picks: [] });
  check('an expired proposal is a 404', s === 404);
  [s] = await post('/api/planner/ai/apply', { runId: est.runId, picks: 'all' });
  check('picks must be a list (400 or 409 for an already applied run)', s === 400 || s === 409);

  console.log('--- caching and the no-AI mode, over HTTP');
  fs.rmSync(log, { force: true });
  [s, est] = await post('/api/planner/ai/estimate', { includeDiscussion: true });
  check('tomorrow\'s run only has the remaining items to look at, and they are cached', s === 200 && est.cached === est.items);
  [s, run] = await post('/api/planner/ai/run', { runId: est.runId, mode: 'priority' });
  check('priority-only mode makes no model call', s === 200 && run.engine === 'rules' && calls().length === 0);
  [s, r] = await post('/api/planner/ai/discard', { runId: est.runId });
  check('discard works', s === 200 && r.ok);
  [s, r] = await post('/api/planner/ai/estimate', { maxItems: 0, days: 'x' });
  check('odd numbers fall back to sane limits instead of failing', s === 200 && r.items >= 1);

  console.log('--- records and usage');
  const usage = (await get('/api/usage'))[1];
  check('the model calls are listed on the usage report with their purposes', usage.hubAi.recent.some((x) => x.purpose === 'plan-analyse') && usage.hubAi.recent.some((x) => x.purpose === 'plan-arrange'));
  const health = (await get('/api/health'))[1].db;
  check('schema is current and AI runs are counted', health.schemaVersion === health.expectedSchemaVersion && health.counts.aiRuns >= 1, JSON.stringify(health.counts));
  srv.kill();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  setTimeout(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp */ } process.exit(fails ? 1 : 0); }, 600);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
