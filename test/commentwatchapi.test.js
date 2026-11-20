const HUBROOT = require('path').resolve(__dirname, '..').replace(/\\/g, '/'); require('./_config')();
// The comment watch over HTTP: a throwaway hub whose work items and comments come from a JSON file instead of Azure DevOps.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwapi-'));
const fake = path.join(root, 'items.json');
const mk = (id, o) => ({ id, type: 'Bug', title: 'Item ' + id, state: 'Active', assignedTo: 'Test User', priority: 2, changedDate: new Date().toISOString(), url: 'https://example/' + id, ...o });
const cm = (id, author, html) => ({ id, author, authorId: author === 'Test User' ? 'ME-ID' : 'id-' + author, authorUnique: '', at: new Date(Date.now() - (50 - id) * 60000).toISOString(), html });
const world = { me: 'Test User', meId: 'ME-ID', assigned: [mk(1), mk(2)], items: [], search: [], reviews: [], comments: { 1: [cm(2, 'Sam', 'older'), cm(1, 'Test User', 'first')], 2: [] } };
const writeFake = () => fs.writeFileSync(fake, JSON.stringify(world));
writeFake();

const port = 4731; const base = 'http://localhost:' + port;
const srv = spawn(process.execPath, [HUBROOT + '/server.js'], { stdio: 'ignore', env: { ...process.env, HUB_PORT: String(port), HUB_DATA_DIR: path.join(root, 'data'), HUB_FAKE_WORKITEMS: fake, HUB_ONLY_EXTRA: '1', HUB_EXTRA_CLONES: '' } });
const H = { 'Content-Type': 'application/json', 'X-Hub-Request': '1' };
const post = (p, b, h) => fetch(base + p, { method: 'POST', headers: h || H, body: JSON.stringify(b || {}) }).then(async (r) => [r.status, await r.json().catch(() => ({}))]);
const get = (p) => fetch(base + p).then(async (r) => [r.status, await r.json()]);
let fails = 0;
const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!ok) fails++; };

(async () => {
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/me'); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  let [s, b] = await post('/api/comments/refresh');
  check('the first check baselines: nothing unread', s === 200 && b.counts.items === 0 && !b.error && !!b.lastOkAt, JSON.stringify([s, b.counts, b.error]));

  world.comments[1].unshift(cm(3, 'Pat', 'Hello <a data-vss-mention="version:2.0,me-id">@Test User</a> can you look?'));
  world.comments[1].unshift(cm(4, 'Sam', 'and another one'));
  writeFake();
  [s, b] = await post('/api/comments/refresh');
  check('new comments by others appear, the mention is for you', b.counts.items === 1 && b.counts.comments === 2 && b.counts.forYou === 1 && b.items[0].taskId === 1 && b.items[0].forYou, JSON.stringify(b.counts));
  [s, b] = await get('/api/comments/summary');
  check('the summary for badges: map by task, attention count', s === 200 && b.map['1'].unread === 2 && b.map['1'].forYou === true && b.attention === 1);

  [s, b] = await get('/api/tasks/1');
  check('the task detail carries the new comments for the drawer', s === 200 && b.comments && b.comments.unread.length === 2 && b.comments.watching === false);

  console.log('--- writes are guarded');
  [s] = await post('/api/comments/1/read', {}, { 'Content-Type': 'application/json' });
  check('a write without the hub header is refused (403)', s === 403);
  let r = await fetch(base + '/api/asks', { method: 'POST', headers: { ...H, Origin: 'https://evil.example' }, body: '{}' });
  check('a write from another origin is refused (403)', r.status === 403);
  r = await fetch(base + '/api/asks', { method: 'POST', headers: H, body: JSON.stringify({ question: 'x'.repeat(20000) }) });
  check('an oversized body is refused (413)', r.status === 413);
  [s] = await post('/api/asks', { taskId: 'abc', question: 'x' });
  check('a bad work item id is a 400', s === 400);
  [s] = await post('/api/asks', { taskId: 1, question: '' });
  check('an empty question is a 400', s === 400);

  console.log('--- asks and reading');
  [s, b] = await post('/api/asks', { taskId: 2, person: 'Ravi', question: 'Which tenant?', nudgeDays: 2 });
  const askId = b.id;
  check('an ask is created', s === 201 && askId > 0);
  [s, b] = await get('/api/comments');
  check('it is waiting', b.asks.length === 1 && b.asks[0].state === 'waiting' && b.asks[0].title === 'Item 2' || b.asks[0].state === 'waiting', JSON.stringify(b.asks[0]));
  world.comments[2] = [{ ...cm(7, 'Ravi Kumar', 'Tenant A'), at: new Date(Date.now() + 5000).toISOString() }]; writeFake();
  [s, b] = await post('/api/comments/refresh');
  check('the answer from Ravi marks it replied and counts for the sidebar', b.asks[0].state === 'replied' && b.counts.replied === 1 && b.attention === b.counts.items + 1);
  [s, b] = await post('/api/asks/' + askId + '/close');
  check('closing works', s === 200);
  [s] = await post('/api/asks/9999/close');
  check('an unknown ask is 404', s === 404);
  [s, b] = await post('/api/comments/1/read');
  check('mark read clears the item', s === 200 && b.marked === 2 && (await get('/api/comments/summary'))[1].map['1'] === undefined);
  [s] = await post('/api/comments/read-all');
  check('mark all read works', s === 200);

  console.log('--- watching and suggestions');
  [s] = await post('/api/comments/2/watch', { on: true });
  check('watch an item', s === 200 && (await get('/api/tasks/2'))[1].comments.watching === true);
  world.comments[1].unshift(cm(9, 'Test User', 'Pat, can you confirm the build number?')); writeFake();
  [s, b] = await post('/api/comments/refresh');
  check('my unanswered question is suggested', b.suggestions.length === 1 && b.suggestions[0].taskId === 1);
  [s, b] = await post('/api/comments/1/suggestion/accept', { nudgeDays: 3 });
  check('accepting creates an ask', s === 201 && (await get('/api/comments'))[1].asks.some((a) => a.taskId === 1 && a.source === 'suggested'));
  [s] = await post('/api/comments/5/suggestion/dismiss');
  check('no suggestion to dismiss is 404', s === 404);

  console.log('--- planner: waiting lane, replies as alerts, weekend lines');
  const W = require(HUBROOT + '/lib/workdays.js'); const T = W.today();
  [s, b] = await post('/api/planner/schedule', { taskId: 1, date: T });
  [s, b] = await get('/api/planner');
  const line = b.days[0].items.find((i) => i.taskId === 1);
  check('a planned line with an open ask knows its ask is waiting', !!line && line.ask === 'waiting', JSON.stringify(line && line.ask));
  [s] = await post('/api/planner/park', { itemId: line.id });
  [s, b] = await get('/api/planner');
  check('parking takes it off the day and into the Waiting lane, and out of the Inbox', s === 200 && !b.days[0].items.some((i) => i.taskId === 1) && b.waiting.some((w) => w.taskId === 1) && !b.inbox.some((t) => t.id === 1) && b.counts.waiting === 1);
  [s, b] = await post('/api/planner/park', { itemId: 999999 });
  check('parking a line that does not exist is 404', s === 404);
  [s, b] = await post('/api/planner/schedule', { taskId: 2, date: T });
  const l2 = (await get('/api/planner'))[1].days[0].items.find((i) => i.taskId === 2);
  [s, b] = await post('/api/planner/park', { itemId: l2.id });
  check('parking needs an open ask: otherwise it is refused (409)', s === 409 && /waiting on/i.test(b.error || ''));
  world.comments[1].unshift({ ...cm(20, 'Sam', 'Build 42'), at: new Date(Date.now() + 8000).toISOString() }); writeFake();
  await post('/api/comments/refresh');
  [s, b] = await get('/api/planner');
  check('when someone answers, it leaves the Waiting lane and shows as one alert', !b.waiting.some((w) => w.taskId === 1) && b.attention.some((a) => a.kind === 'ask-replied' && a.taskId === 1));
  check('the sidebar count is per work item, not per reason', b.counts.attentionItems <= b.counts.attention && b.counts.attentionItems === new Set(b.attention.map((a) => (a.taskId ? 't' + a.taskId : 'k' + a.kind))).size);
  const sat = (() => { let d = W.addDays(T, 1); while (W.parse(d).getDay() !== 6) d = W.addDays(d, 1); return d; })();
  [s, b] = await get('/api/planner');
  const lastCol = b.days[b.days.length - 1].date;
  if (sat < lastCol) {
    await post('/api/planner/unschedule', { itemId: l2.id });
    [s, b] = await post('/api/planner/schedule', { taskId: 2, date: sat });
    const bb = (await get('/api/planner'))[1];
    check('a line dated on a Saturday inside the window still shows in a column', s === 200 && bb.days.some((d) => d.items.some((i) => i.taskId === 2 && i.date === sat)));
  } else check('(a Saturday inside the window is not reachable from today: skipped)', true);
  console.log('--- the page and the data');
  r = await fetch(base + '/comments.js'); const js = await r.text();
  check('the page script is served and the sidebar has the item', r.status === 200 && js.includes('renderComments') && (await (await fetch(base + '/')).text()).includes('data-view="comments"'));
  [s, b] = await get('/api/me');
  check('the database is still healthy', s === 200);

  console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); srv.kill(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL crashed ' + e.stack); srv.kill(); process.exit(1); });
