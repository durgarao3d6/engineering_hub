const HUBROOT = require('path').resolve(__dirname, '..').replace(/\\/g, '/'); require('./_config')(); // neutral settings (HUB_LIVE_TESTS=1 uses your own settings and board for the checks marked live)
process.env.HUB_BACKUP_DIR = process.env.HUB_BACKUP_DIR || require('path').join(require('os').tmpdir(), 'hub-test-backups-' + process.pid); process.on('exit', () => { try { require('fs').rmSync(process.env.HUB_BACKUP_DIR, { recursive: true, force: true }); } catch { /* temp */ } }); // tests never write into your real backup folder
// Plan API over HTTP: throwaway hub (port 4704), stub CLI, temp database. Reads the real board from Azure DevOps (read-only) for candidates.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planapi-'));
const srv = spawn('node', [HUBROOT + '/server.js'], { stdio: 'ignore', env: { ...process.env, HUB_PORT: '4704', HUB_DATA_DIR: dir, HUB_ONLY_EXTRA: '1',
  HUB_CLAUDE_BIN: HUBROOT + '/test/stub-claude.js', STUB_MODE: 'ok' } });
const base = 'http://localhost:4704';
const H = { 'Content-Type': 'application/json', 'X-Hub-Request': '1' };
const post = (p, b, h) => fetch(base + p, { method: 'POST', headers: h || H, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);
const get = (p) => fetch(base + p).then(async (r) => [r.status, await r.json()]);
let fails = 0;
const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!ok) fails++; };
const live = (n, ok, x) => (process.env.HUB_LIVE_TESTS ? check(n, ok, x) : console.log('SKIP ' + n + '  (needs a real Azure DevOps board: run with HUB_LIVE_TESTS=1)'));
const today = new Date().toLocaleDateString('en-CA');
const tomorrow = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toLocaleDateString('en-CA'); })();
(async () => {
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/me'); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  let [s, j] = await get('/api/ai/status');
  check('ai status available with the stub', s === 200 && j.available === true && j.month.calls === 0, JSON.stringify(j.models));

  console.log('--- parse');
  [s, j] = await post('/api/plan/parse', { text: 'x' }, { 'Content-Type': 'application/json' });
  check('parse without X-Hub-Request -> 403', s === 403);
  [s, j] = await post('/api/plan/parse', { text: '   ' });
  check('empty plan -> 400', s === 400);
  [s, j] = await post('/api/plan/parse', { text: 'x'.repeat(5000) });
  check('plan over 4000 characters -> 400', s === 400);
  [s, j] = await post('/api/plan/parse', { text: 'x'.repeat(25000) });
  check('plan over the body limit -> 413', s === 413, String(s));
  [s, j] = await post('/api/plan/parse', { text: 'x'.repeat(40000) });
  check('huge request body -> 413, connection not cut', s === 413, String(s));
  [s, j] = await post('/api/plan/parse', { text: 'Work on 8246\nSomething completely brand new zzz thing' });
  check('parse ok', s === 200 && j.engine === 'ai' && j.items.length === 2, JSON.stringify({ s, engine: j.engine, n: j.items && j.items.length, err: j.error }));
  const proposal = j;
  live('explicit id matched to the real work item', proposal.items[0].taskId === 8246 && /Customer Portal/i.test(proposal.items[0].task.title), proposal.items[0].task && proposal.items[0].task.title);
  check('new task has a draft', !!proposal.items[1].draft && proposal.items[1].draft.title.startsWith('Area:'));
  [s, j] = await get('/api/ai/status');
  check('both model calls were recorded', j.month.calls === 2 && j.month.usd > 0, JSON.stringify(j.month));

  console.log('--- save');
  [s, j] = await post('/api/plan/save', { date: 'nope', items: [{ text: 'a' }] }); check('bad date -> 400', s === 400);
  [s, j] = await post('/api/plan/save', { date: today, items: [] }); check('no lines -> 400', s === 400);
  [s, j] = await post('/api/plan/save', { date: today, items: [{ text: 'a', taskId: 'abc' }] }); check('bad work item id -> 400', s === 400);
  [s, j] = await post('/api/plan/save', { date: today, items: [{ text: '  ' }] }); check('blank line -> 400', s === 400);
  const lines = [...proposal.items.map((i) => ({ text: i.text, kind: i.kind, taskId: i.taskId, confidence: i.confidence, draft: i.draft })),
    { text: 'Review PR 9820', kind: 'review' }, { text: '11am standup', kind: 'meeting' }, { text: 'Another unplanned task', kind: 'task', draft: { type: 'Bug', title: 'Portal: another thing', body: 'Details' } }];
  [s, j] = await post('/api/plan/save', { date: today, rawText: 'raw text', items: lines });
  check('save -> 201 with five lines', s === 201 && j.items.length === 5, String(j.items && j.items.length));
  const it = j.items;
  live('linked line carries the work item card', it[0].task && it[0].task.id === 8246 && it[0].task.title.length > 0);
  check('unlinked line keeps its draft', it[1].draft && it[1].draft.state === 'drafted' && !it[1].task);
  [s, j] = await get('/api/plan?date=' + today); check('GET returns the saved day', j.day && j.day.rawText === 'raw text' && j.items.length === 5);

  console.log('--- update');
  [s, j] = await post('/api/plan/items/' + it[0].id + '/update', { status: 'done' }); check('mark done', s === 200 && j.item.status === 'done' && j.item.doneAt);
  [s, j] = await post('/api/plan/items/' + it[0].id + '/update', { status: 'weird' }); check('invalid status -> 400', s === 400);
  [s, j] = await post('/api/plan/items/' + it[0].id + '/update', { text: '  ' }); check('empty text -> 400', s === 400);
  [s, j] = await post('/api/plan/items/' + it[0].id + '/update', { taskId: 'x' }); check('bad task id -> 400', s === 400);
  [s, j] = await post('/api/plan/items/' + it[2].id + '/update', { draftState: 'requested' }); check('no draft -> 400', s === 400);
  [s, j] = await post('/api/plan/items/' + it[1].id + '/update', { draftState: 'requested' }); check('draft -> requested stamps the time', s === 200 && j.item.draft.state === 'requested' && j.item.draft.requestedAt);
  [s, j] = await post('/api/plan/items/' + it[1].id + '/update', { draftState: 'created' }); check('created without an id -> 400', s === 400);
  [s, j] = await post('/api/plan/items/' + it[1].id + '/update', { draftState: 'created', createdTaskId: 5945 });
  check('lead created #5945: reference attached', s === 200 && j.item.taskId === 5945 && j.item.draft.state === 'created' && j.item.task.id === 5945, JSON.stringify(j.item && j.item.task && j.item.task.title));
  [s, j] = await post('/api/plan/items/' + it[1].id + '/update', { status: 'done' });
  [s, j] = await post('/api/plan/items/9999/update', { status: 'done' }); check('unknown line -> 404', s === 404);
  [s, j] = await post('/api/plan/items/' + it[4].id + '/update', { draft: { title: 'Portal: edited title', body: 'edited body', type: 'Task' } }); check('edit a draft', s === 200 && j.item.draft.title === 'Portal: edited title');
  [s, j] = await post('/api/plan/items', { date: today, text: 'Manual extra line', kind: 'task' }); check('add a line by hand', s === 201 && j.items.length === 6);
  const manual = j.items[5];
  [s, j] = await post('/api/plan/items/' + manual.id + '/delete', {}); check('delete a line', s === 200);
  [s, j] = await post('/api/plan/items/' + manual.id + '/delete', {}); check('delete twice -> 404', s === 404);

  console.log('--- close the day');
  [s, j] = await post('/api/plan/close', { date: '2019-01-01' }); check('close a day with no plan -> 404', s === 404);
  [s, j] = await post('/api/plan/close', { date: today, drop: [{ id: it[3].id, reason: '' }] }); check('drop without a reason -> 400', s === 400);
  [s, j] = await post('/api/plan/close', { date: today, carry: [it[4].id, it[0].id], drop: [{ id: it[3].id, reason: 'Meeting cancelled' }] });
  check('close -> 200 with a score', s === 200 && j.score && typeof j.score.score === 'number', JSON.stringify(j.score));
  check('score numbers add up (5 lines, 2 done, 1 dropped, 1 carried)', j.score.planned === 5 && j.score.done === 2 && j.score.dropped === 1 && j.score.carried === 1, JSON.stringify([j.score.planned, j.score.done, j.score.dropped, j.score.carried]));
  live('adherence 2/4 = 50 and coverage counts linked task lines', j.score.adherence === 50 && j.score.taskLines === 3 && j.score.withWorkItem === 2 && j.score.missingWorkItems === 1, JSON.stringify([j.score.adherence, j.score.coverage]));
  check('unplanned list is only your own activity (not items merely changed in Azure DevOps)', Array.isArray(j.score.unplanned) && j.score.unplanned.length <= 3, String(j.score.unplanned.length));
  check('day is closed and listed in recent days', !!j.day.closedAt && j.recent.some((d) => d.date === today && d.score));
  [s, j] = await get('/api/plan?date=' + tomorrow);
  check('only the unfinished carried line moved to tomorrow, with its draft', j.items.length === 1 && j.items[0].carriedFrom === it[4].id && j.items[0].draft && j.items[0].draft.title === 'Portal: edited title', JSON.stringify(j.items.map((x) => x.text)));
  check('a done line is never carried', !j.items.some((x) => x.text === it[0].text));

  console.log('--- guards');
  let r = await fetch(base + '/api/plan/save', { method: 'POST', headers: { ...H, Origin: 'https://evil.example' }, body: '{}' }); check('foreign origin -> 403', r.status === 403);
  [s, j] = await get('/api/plan?date=2019-01-01'); check('date far in the past -> 400', s === 400);

  const { dayScore } = require(HUBROOT + '/plan-score.js');
  const perfect = dayScore([{ id: 1, status: 'done', kind: 'task', taskId: 5 }, { id: 2, status: 'done', kind: 'meeting' }]);
  check('perfect day scores 100', perfect.score === 100, String(perfect.score));
  const empty = dayScore([]); check('empty plan does not divide by zero', empty.score === 100 && empty.planned === 0);
  const bad = dayScore([{ id: 1, status: 'todo', kind: 'task' }, { id: 2, status: 'todo', kind: 'task' }], { carriedIds: [1, 2] });
  check('nothing done, nothing linked, all carried scores 0', bad.score === 0, String(bad.score));

  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  srv.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
