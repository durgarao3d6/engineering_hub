const HUBROOT = require('path').resolve(__dirname, '..').replace(/\\/g, '/'); require('./_config')();
// Comment watch: the pure rules, then the watcher against a throwaway database with Azure DevOps faked.
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtest-'));
process.env.HUB_DATA_DIR = path.join(dir, 'data');
const store = require(HUBROOT + '/store.js');
const W = require(HUBROOT + '/lib/workdays.js');
const cw = require(HUBROOT + '/commentwatch.js');

let fails = 0;
const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!ok) fails++; };
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const ME = { id: 'AAAA-1111', name: 'Test User', unique: 'test.user@example.com' };
const c = (id, author, html, o) => ({ id, author, authorId: author === 'Test User' ? ME.id : 'id-' + author, authorUnique: '', at: '2030-03-06T0' + (id % 10) + ':00:00Z', html, ...o });

console.log('--- rules: who wrote it, who is mentioned');
check('my comment is recognised by id, by unique name and by display name', cw.isMine({ authorId: 'aaaa-1111' }, ME) && cw.isMine({ authorUnique: 'TEST.USER@example.com' }, ME) && cw.isMine({ author: 'test user' }, ME) && !cw.isMine({ author: 'Sam', authorId: 'x' }, ME) && !cw.isMine(null, ME) && !cw.isMine({ author: 'Test User' }, null));
check('a mention carries my id, or names me with @', cw.mentionsMe({ html: '<a href="#" data-vss-mention="version:2.0,aaaa-1111">@Someone</a> please look' }, ME) && cw.mentionsMe({ html: 'cc @Test User' }, ME) && !cw.mentionsMe({ html: '<a data-vss-mention="version:2.0,other">@Sam</a>' }, ME) && !cw.mentionsMe({ html: 'Test User is not mentioned with an @ here' }, ME));
check('a person is matched by all the words of the name', cw.matchesPerson('Ravi', 'Ravi Kumar') && cw.matchesPerson('ravi kumar', 'Kumar, Ravi') && !cw.matchesPerson('Ravi', 'Sam') && cw.matchesPerson('', 'Anyone'));

console.log('--- rules: which comments are new and why they matter');
const thread = [c(9, 'Sam', 'Done, see PR'), c(8, 'Pat', 'fyi <a data-vss-mention="version:2.0,AAAA-1111">@Test User</a>'), c(7, 'Test User', 'Can you check the config?'), c(6, 'Sam', 'old one')];
check('with a stored newest id, only newer comments are new', cw.newComments(thread, { last_comment_id: 7, count_polled: 4 }, 6).map((x) => x.id).join() === '9,8');
check('without one, the count says how many are new', cw.newComments(thread, { last_comment_id: null, count_polled: 2 }, 4).map((x) => x.id).join() === '9,8' && cw.newComments(thread, { last_comment_id: null, count_polled: 4 }, 4).length === 0);
const ev = cw.classifyEvents(thread.slice(0, 2), thread, ME);
check('a mention is flagged, an answer after my comment is a reply', ev.length === 2 && ev.find((e) => e.commentId === 8).reason === 'mention' && ev.find((e) => e.commentId === 9).reason === 'reply');
check('my own comments are never events, and a stranger with no history has no reason', cw.classifyEvents([c(11, 'Test User', 'x')], thread, ME).length === 0 && cw.classifyEvents([c(12, 'Zed', 'hello')], [c(12, 'Zed', 'hello')], ME)[0].reason === null);
check('the snippet is plain text without markup', !/[<>]/.test(ev.find((e) => e.commentId === 8).snippet) && ev.find((e) => e.commentId === 8).snippet.includes('@Test User'));

console.log('--- rules: asks');
check('a question I wrote that nobody answered is suggested', !!cw.suggestAsk([c(20, 'Test User', 'Can you check this?')], ME) && cw.suggestAsk([c(20, 'Test User', 'Can you check this?')], ME).question === 'Can you check this?');
check('a mention of a person is suggested with that name', cw.suggestAsk([c(21, 'Test User', '<a data-vss-mention="version:2.0,zz">@Ravi Kumar</a> look at the config')], ME).person === 'Ravi Kumar');
check('no suggestion when someone answered, when it is a statement, or for others\' comments', cw.suggestAsk([c(22, 'Sam', 'yes'), c(21, 'Test User', 'Can you?')], ME) === null && cw.suggestAsk([c(23, 'Test User', 'Fixed it.')], ME) === null && cw.suggestAsk([c(24, 'Sam', 'Why?')], ME) === null && cw.suggestAsk([], ME) === null);
const a0 = { closed_at: null, replied_at: null, nudge_at: '2030-03-10' };
check('an ask is waiting, then due, replied, or closed', cw.askState(a0, '2030-03-09') === 'waiting' && cw.askState(a0, '2030-03-10') === 'nudge' && cw.askState({ ...a0, replied_at: 'x' }, '2030-03-11') === 'replied' && cw.askState({ ...a0, closed_at: 'x', replied_at: 'x' }, '2030-03-11') === 'closed');

console.log('--- the watcher');
let me = ME; let items = new Map(); const threads = new Map(); const calls = { counts: 0, thread: 0 }; let failCounts = false; let failThread = null;
const deps = {
  watchedIds: () => [...items.keys()],
  getMe: async () => me,
  fetchCounts: async (ids) => { calls.counts++; if (failCounts) throw new Error('Azure DevOps rejected the sign-in'); return new Map(ids.filter((i) => items.has(i)).map((i) => [i, { count: (threads.get(i) || []).length, title: items.get(i), state: 'Active' }])); },
  fetchThread: async (id, n) => { calls.thread++; if (failThread === id) throw new Error('boom'); const t = (threads.get(id) || []).slice(0, n); return { total: (threads.get(id) || []).length, comments: t }; },
};
const w = cw.create(deps);
(async () => {
  items = new Map([[101, 'Login fails'], [102, 'Export slow']]);
  threads.set(101, [c(3, 'Sam', 'old 3'), c(2, 'Pat', 'old 2'), c(1, 'Test User', 'old 1')]); threads.set(102, []);
  await w.poll();
  check('the first check baselines: existing comments are seen, nothing floods, no thread was fetched', w.view().counts.items === 0 && calls.thread === 0 && store.cwGet(101).count_polled === 3);
  await w.poll();
  check('a check with nothing new fetches no thread', calls.thread === 0 && w.view().counts.comments === 0);

  threads.set(101, [c(5, 'Sam', 'Please confirm <a data-vss-mention="version:2.0,AAAA-1111">@Test User</a>'), c(4, 'Pat', 'one more thing')].concat(threads.get(101)));
  await w.poll();
  let v = w.view();
  check('two new comments by others make one unread item with 2 unread, for you', v.counts.items === 1 && v.items[0].unread === 2 && v.items[0].forYou && v.items[0].taskId === 101 && v.items[0].title === 'Login fails', JSON.stringify(v.counts));
  check('only that item\'s thread was fetched', calls.thread === 1);
  check('the mention comes with its reason and a plain snippet', v.items[0].events[0].reason === 'mention' && v.items[0].events[0].author === 'Sam' && !/[<>]/.test(v.items[0].events[0].snippet));
  check('the summary map is what the badges use', JSON.stringify(w.summary().map) === JSON.stringify({ 101: { unread: 2, forYou: true } }) && w.summary().attention === 1);

  await w.poll();
  check('checking again does not count the same comments twice', w.view().items[0].unread === 2);
  check('mark read clears it', w.markRead(101) === 2 && w.view().counts.items === 0 && w.forTask(101).unread.length === 0);
  await w.poll();
  check('and it stays read', w.view().counts.items === 0);

  threads.set(101, [c(6, 'Test User', 'Thanks, will do.')].concat(threads.get(101)));
  await w.poll();
  check('my own comment is not unread', w.view().counts.items === 0 && store.cwGet(101).last_comment_id === 6);

  console.log('--- asks');
  const askId = w.addAsk({ taskId: 102, person: 'Ravi', question: 'Which tenant is affected?' });
  check('an ask starts as waiting, nudge date is working days ahead', w.view().asks[0].state === 'waiting' && W.isWorking(w.view().asks[0].nudgeAt, [1, 2, 3, 4, 5]) && w.view().asks[0].nudgeAt > W.today());
  threads.set(102, [c(2, 'Sam', 'not Ravi, unrelated')]); await w.poll();
  check('a comment by someone else does not answer an ask for Ravi (but is unread)', w.view().asks[0].state === 'waiting' && w.view().items.some((i) => i.taskId === 102));
  threads.set(102, [c(3, 'Ravi Kumar', 'Tenant A only')].concat(threads.get(102))); await w.poll();
  check('a comment by Ravi marks the ask replied', w.view().asks[0].state === 'replied' && w.view().asks[0].repliedBy === 'Ravi Kumar' && w.view().counts.replied === 1);
  check('the attention total counts unread items and replies', w.summary().attention === w.view().counts.items + 1 && w.summary().askMap[102] === 'replied');
  check('closing the ask takes it off the list', w.closeAsk(askId) && w.view().asks.length === 0 && w.forTask(102).asks[0].state === 'closed');

  const a2 = w.addAsk({ taskId: 101, question: 'Anyone know?', nudgeDays: 1 });
  store.askSet(a2, { nudge_at: W.addDays(W.today(), -1) });
  check('an ask past its nudge date is due', w.view().asks[0].state === 'nudge' && w.view().counts.nudge === 1);
  check('snoozing moves the nudge date', w.snoozeAsk(a2, 3) && w.view().asks[0].state === 'waiting');
  check('bad asks are refused', (await rejects(() => w.addAsk({ taskId: 0, question: 'x' }))).status === 400 && (await rejects(() => w.addAsk({ taskId: 5, question: '  ' }))).status === 400 && (await rejects(() => w.addAsk({ taskId: 5, question: 'x', nudgeDays: 99 }))).status === 400 && (await rejects(() => w.snoozeAsk(a2, 0))).status === 400);
  check('unknown asks are not found', w.closeAsk(9999) === false && w.snoozeAsk(9999, 1) === false);

  console.log('--- suggestions');
  threads.set(101, [c(8, 'Test User', 'Can someone confirm the version?')].concat(threads.get(101))); w.closeAsk(a2);
  await w.poll();
  check('my unanswered question is offered as an ask', w.view().suggestions.length === 1 && w.view().suggestions[0].taskId === 101);
  check('dismissing it hides it, and the same comment is not offered again', w.dismissSuggestion(101) && w.view().suggestions.length === 0 && (await w.poll(), w.view().suggestions.length === 0));
  threads.set(101, [c(9, 'Test User', 'Or should I ask ops?')].concat(threads.get(101))); await w.poll();
  const sid = w.acceptSuggestion(101, 2);
  check('accepting makes an ask and clears the suggestion', sid > 0 && w.view().suggestions.length === 0 && w.view().asks.some((x) => x.id === sid && x.source === 'suggested'));

  console.log('--- watching and failing safely');
  items.set(103, 'Other'); threads.set(103, [c(1, 'Sam', 'x')]);
  w.setWatch(103, true);
  await w.poll();
  check('a watched item is baselined at its first check, not flooded', !w.view().items.some((i) => i.taskId === 103) && store.cwGet(103).user_watch === 1);
  items.delete(103); const only = cw.create({ ...deps, watchedIds: () => [] }); await only.poll();
  check('items you chose to watch are included even when no other rule picks them', store.cwUserWatched().includes(103));
  w.setWatch(103, false); check('and can be dropped', !store.cwUserWatched().includes(103));

  failCounts = true; const before = w.view().counts.items; const r = await w.poll();
  check('when Azure DevOps fails the error is reported, nothing is lost or invented', !!r.error && w.view().error.includes('rejected') && w.view().counts.items === before);
  failCounts = false; await w.poll();
  check('and it recovers on the next check', w.view().error === null);
  threads.set(102, [c(10, 'Sam', 'another')].concat(threads.get(102))); failThread = 102; await w.poll();
  const kept = store.cwGet(102).count_polled; failThread = null; await w.poll();
  check('a failed thread fetch is retried next time (the count was not advanced)', kept < threads.get(102).length && w.view().items.some((i) => i.taskId === 102 && i.events.some((e) => e.commentId === 10)));
  check('the data is in the export and the counts', store.exportAll().commentEvents.length > 0 && store.exportAll().asks.length >= 3 && store.rowCounts().asks >= 3 && store.rowCounts().commentEvents > 0);

  console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL crashed ' + e.stack); process.exit(1); });
