'use strict';
// Engineering Hub: local, read-only toward repos. Binds to 127.0.0.1 only.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cfg = require('./config');
let store;
try { store = require('./store'); }
catch (e) { console.error('\nSTOP: ' + e.message + '\n'); process.exit(1); } // a damaged database is never replaced by an empty one
const backup = require('./backup');
const inbox = require('./inbox');
const mover = require('./mover');
const { collectWorktrees, cloneList } = require('./collectors/worktrees');
const { pool } = require('./collectors/git');
const stashinfo = require('./collectors/stashinfo');
const stashmgr = require('./stashmgr');
const { collectTasks, collectCompleted, fetchDetail } = require('./collectors/tasks');
const usage = require('./usage');
const sessionsMod = require('./sessions');
const ai = require('./ai');
const planner = require('./planner');
const scorecard = require('./scorecard');
const { dayScore } = require('./plan-score');

const UI = path.join(__dirname, 'ui');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const USER = (() => { try { return os.userInfo().username; } catch { return 'local-user'; } })();
const CATEGORIES = ['Completed by someone else', 'Superseded by another change', 'Merged elsewhere', 'Abandoned', 'Duplicate', 'Other'];
const SECTIONS = ['Analysis', 'Findings', 'Decisions', 'Open questions', 'Next step'];
const ALLOWED_HOSTS = new Set([`localhost:${cfg.port}`, `127.0.0.1:${cfg.port}`]);

let cache = { at: 0, data: null, running: null };
async function worktrees(force) {
  const fresh = cache.data && Date.now() - cache.at < 60000;
  if (fresh && !force) return cache.data;
  if (!cache.running) {
    cache.running = collectWorktrees()
      .then((d) => { cache.data = d; cache.at = Date.now(); return d; })
      .finally(() => { cache.running = null; });
  }
  return cache.running;
}

let tcache = { at: 0, data: null, running: null };
async function tasks(force) {
  const fresh = tcache.data && Date.now() - tcache.at < 5 * 60 * 1000;
  if (fresh && !force) return tcache.data;
  if (!tcache.running) {
    tcache.running = worktrees(false)
      .then((wt) => collectTasks(wt, new Set(store.noteStats().keys())))
      .then((d) => { tcache.data = d; tcache.at = Date.now(); return d; })
      .finally(() => { tcache.running = null; });
  }
  return tcache.running;
}

function annotate(data) {
  const active = store.activeByKey();
  return {
    ...data,
    worktrees: data.worktrees.map((w) => {
      const c = active.get(store.keyOf(w.path));
      if (!c) return w;
      const changed = (w.head || '') !== (c.head || '') || (w.dirtyFiles || 0) !== (c.dirtyFiles || 0);
      return { ...w, clearance: c, changedSinceCleared: changed };
    }),
  };
}

function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
  });
  res.end(body);
}
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), 'application/json');

function readBody(req, limit = 16384) {
  return new Promise((resolve, reject) => {
    let s = ''; let over = false;
    req.on('data', (d) => {
      if (over) return;
      s += d;
      if (s.length > limit) { over = true; s = ''; const e = new Error('The request is too large (limit ' + Math.round(limit / 1024) + ' KB).'); e.status = 413; reject(e); } // answered with 413, the connection is not cut
    });
    req.on('end', () => { if (over) return; try { resolve(s ? JSON.parse(s) : {}); } catch { const e = new Error('Invalid JSON'); e.status = 400; reject(e); } });
    req.on('error', reject);
  });
}

// Blocks other websites from posting to this local server (CSRF / DNS rebinding).
function guardWrite(req) {
  if (!ALLOWED_HOSTS.has(req.headers.host || '')) return 'Host not allowed';
  const origin = req.headers.origin;
  if (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ''))) return 'Origin not allowed';
  if (!(req.headers['content-type'] || '').startsWith('application/json')) return 'JSON required';
  if (req.headers['x-hub-request'] !== '1') return 'Missing X-Hub-Request header';
  return null;
}

const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);

async function createClearance(req, res) {
  const body = await readBody(req);
  const category = clean(body.category, 60);
  const reason = clean(body.reason, 1000);
  const reference = clean(body.reference, 200);
  const errors = {};
  if (!CATEGORIES.includes(category)) errors.category = 'Choose a category.';
  if (reason.length < 10) errors.reason = 'Explain why in at least 10 characters.';
  if (Object.keys(errors).length) return json(res, 400, { error: 'Validation failed', errors });
  const data = await worktrees(false);
  const key = store.keyOf(body.path);
  const w = data.worktrees.find((x) => store.keyOf(x.path) === key);
  if (!w) return json(res, 404, { error: 'Worktree not found. Refresh and try again.' });
  if (w.isMain) return json(res, 400, { error: 'Live checkouts cannot be cleared.' });
  const existing = store.activeByKey().get(key);
  if (existing && (w.head || '') === (existing.head || '') && (w.dirtyFiles || 0) === (existing.dirtyFiles || 0)) {
    return json(res, 409, { error: 'This worktree is already cleared.' });
  }
  const id = store.clear(w, { category, reason, reference }, USER);
  return json(res, 201, { id, clearance: store.get(id) });
}

/* ---------- stash manager ---------- */
const stashFacts = new Map();   // repo|hash|mainSha -> analysis (a stash never changes; main moves, so main's sha is part of the key)
const taskStateCache = new Map(); // task id -> { at, state }
const factsKey = (repo, hash, main) => repo.toLowerCase() + '|' + hash + '|' + (main ? main.sha : '-');
async function taskState(id) {
  if (process.env.HUB_NO_ADO) return null; // tests never call Azure DevOps
  const hit = taskStateCache.get(id);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.state;
  let state = null;
  try { const d = await Promise.race([fetchDetail(id), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]); state = d && d.state; } catch { /* unknown */ }
  if (state) taskStateCache.set(id, { at: Date.now(), state });
  return state;
}
const stashUsedNames = async () => [...new Set((await worktrees(false)).worktrees.map((w) => (/([a-z]+)-\d+$/i.exec(w.path.replace(/[\\/]+$/, '')) || [])[1]).filter(Boolean))];
function shapeStash(repo, st, facts, vd, hubRows) {
  const hub = hubRows.get(repo.path.toLowerCase() + '|' + st.hash) || null;
  return { hash: st.hash, ref: st.ref, createdAt: st.createdAt, subject: st.subject, branch: st.branch, note: st.note, taskId: st.taskId,
    fileCount: facts ? facts.files.length + facts.untracked.length : null, untrackedCount: facts ? facts.untracked.length : null, added: facts ? facts.added : null, removed: facts ? facts.removed : null,
    files: facts ? [...facts.files, ...facts.untracked].slice(0, 60) : null, conflicts: facts ? facts.conflicts : null, verdict: vd,
    hub: hub ? { id: hub.id, moveId: hub.moveId, handledAt: hub.handledAt, handledNote: hub.handledNote } : null };
}
async function stashOverview() {
  const clones = cloneList().filter((c) => fs.existsSync(c.path));
  const hubRows = new Map(store.stashList().map((h) => [h.livePath.toLowerCase() + '|' + h.hash, h]));
  const listed = await pool(clones, 6, async (c) => ({ c, l: await stashinfo.list(c.path), main: await stashinfo.mainRef(c.path) }));
  const repos = [];
  for (const { c, l, main } of listed) {
    if (!l.ok || !l.stashes.length) { if (!l.ok) repos.push({ repoKey: c.repoKey, path: c.path, layer: c.layer, count: 0, error: l.error, stashes: [] }); continue; }
    const stashes = l.stashes.map((st) => {
      const facts = stashFacts.get(factsKey(c.path, st.hash, main)) || null;
      const ts = st.taskId && taskStateCache.get(st.taskId);
      return shapeStash(c, st, facts, facts ? stashinfo.verdict(facts, st, { taskState: ts && ts.state }) : null, hubRows);
    });
    repos.push({ repoKey: c.repoKey, path: c.path, layer: c.layer, count: stashes.length, main: main ? main.ref : null, stashes });
  }
  repos.sort((a, b) => b.count - a.count);
  return { generatedAt: new Date().toISOString(), total: repos.reduce((n, r) => n + r.count, 0), staleDays: stashinfo.STALE_DAYS, repos, trash: store.stashTrash(), history: store.stashActionList(100) };
}
async function stashAnalyse(body) {
  const repo = stashmgr.findClone(body.repo); if (!repo) { const e = new Error('That repository is not one of your clones.'); e.status = 404; throw e; }
  const hashes = (Array.isArray(body.hashes) ? body.hashes : []).filter((h) => /^[0-9a-f]{40}$/.test(h)).slice(0, 12);
  const l = await stashinfo.list(repo.path); if (!l.ok) { const e = new Error(l.error); e.status = 500; throw e; }
  const main = await stashinfo.mainRef(repo.path);
  const hubRows = new Map(store.stashList().map((h) => [h.livePath.toLowerCase() + '|' + h.hash, h]));
  const picked = l.stashes.filter((s) => hashes.includes(s.hash));
  await Promise.all([...new Set(picked.map((s) => s.taskId).filter(Boolean))].map((id) => taskState(id)));
  const out = await pool(picked, 4, async (st) => {
    const k = factsKey(repo.path, st.hash, main);
    let facts = stashFacts.get(k);
    if (!facts) { facts = await stashinfo.analyse(repo.path, st, main); stashFacts.set(k, facts); }
    const ts = st.taskId && taskStateCache.get(st.taskId);
    return shapeStash(repo, st, facts, stashinfo.verdict(facts, st, { taskState: ts && ts.state }), hubRows);
  });
  return { stashes: out };
}
async function stashRoutes(req, res, p, url) {
  const q = (k) => url.searchParams.get(k) || '';
  if (req.method === 'GET') {
    if (p === '/api/stash/overview') return json(res, 200, await stashOverview()), true;
    if (p === '/api/stash/diff') {
      const repo = stashmgr.findClone(q('repo')); const h = q('hash');
      if (!repo || !/^[0-9a-f]{40}$/.test(h)) return json(res, 400, { error: 'Unknown repository or stash.' }), true;
      const st = (await stashinfo.list(repo.path)).stashes.find((s) => s.hash === h);
      if (!st) return json(res, 404, { error: 'That stash is no longer in the list.' }), true;
      if (q('file')) { const fd = await stashinfo.fileDiff(repo.path, st, q('file')); return fd ? json(res, 200, fd) : json(res, 404, { error: 'That file is not in this stash.' }), true; }
      return json(res, 200, await stashinfo.summary(repo.path, st)), true;
    }
    if (p === '/api/stash/patch') {
      const repo = stashmgr.findClone(q('repo')); const h = q('hash');
      if (!repo || !/^[0-9a-f]{40}$/.test(h)) return json(res, 400, { error: 'Unknown repository or stash.' }), true;
      const st = (await stashinfo.list(repo.path)).stashes.find((s) => s.hash === h);
      if (!st) return json(res, 404, { error: 'That stash is no longer in the list.' }), true;
      const body = await stashinfo.fullPatch(repo.path, st);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="stash-' + h.slice(0, 10) + '.patch"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(body); return true;
    }
    if (p === '/api/stash/rework-plan') {
      const pl = await stashmgr.reworkPlan(q('repo'), q('hash'), q('taskId'), q('name'), await stashUsedNames());
      return json(res, 200, pl), true;
    }
    return false;
  }
  if (req.method !== 'POST') return false;
  const body = await readBody(req, 16384);
  if (p === '/api/stash/analyse') return json(res, 200, await stashAnalyse(body)), true;
  if (p === '/api/stash/clear') {
    const hashes = Array.isArray(body.hashes) ? body.hashes : [];
    if (!hashes.length || hashes.length > 100) return json(res, 400, { error: 'Choose between 1 and 100 stashes.' }), true;
    const results = [];
    for (const h of hashes) { // one at a time: each drop shifts the indexes of the others, so each is found again by its hash
      try { results.push({ hash: h, ok: true, ...(await stashmgr.clear(body.repo, h, clean(body.reason, 1000), USER)) }); }
      catch (e) { results.push({ hash: h, ok: false, error: e.message }); if (e.status === 409 && /Move to live|Another stash|middle of/.test(e.message)) break; }
    }
    return json(res, 200, { results, cleared: results.filter((r) => r.ok).length }), true;
  }
  if (p === '/api/stash/restore') return json(res, 200, await stashmgr.restore(body.repo, body.hash, USER)), true;
  if (p === '/api/stash/purge') {
    if (body.confirm !== 'delete') return json(res, 400, { error: 'Type delete to confirm.' }), true;
    const hashes = Array.isArray(body.hashes) ? body.hashes : [];
    const results = [];
    for (const h of hashes.slice(0, 100)) { try { results.push({ hash: h, ok: true, ...(await stashmgr.purge(body.repo, h, USER)) }); } catch (e) { results.push({ hash: h, ok: false, error: e.message }); } }
    return json(res, 200, { results }), true;
  }
  if (p === '/api/stash/rework') return json(res, 201, await stashmgr.rework(body.repo, body.hash, body.taskId, clean(body.name, 30), USER, await stashUsedNames())), true;
  return false;
}

/* ---------- morning plan ---------- */
const localDate = (d = new Date()) => d.toLocaleDateString('en-CA'); // YYYY-MM-DD in the user's own time zone
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !Number.isNaN(Date.parse(s + 'T00:00:00')) && Math.abs(Date.parse(s + 'T00:00:00') - Date.now()) < 400 * 86400000;
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return localDate(d); };
const KINDS = ['task', 'review', 'meeting', 'other'];
const DRAFT_TYPES = ['Bug', 'Task', 'User Story'];

async function planPool() {
  const map = new Map();
  const add = (t) => { if (t.title && t.title !== '(work item not readable)') map.set(t.id, { id: t.id, type: t.type, state: t.state, title: t.title, repos: t.repos || [] }); };
  const d = await tasks(false); d.tasks.forEach(add);
  try { const c = await collectCompleted(30, (await worktrees(false)).worktrees); c.tasks.forEach((t) => { if (!map.has(t.id)) add(t); }); } catch { /* completed items are optional */ }
  return [...map.values()];
}

// Worktree links must point at a worktree the hub actually knows (never an arbitrary path: the hub runs git there).
const wtKey = (p) => store.keyOf(p);
async function wtMap() { return new Map((await worktrees(false)).worktrees.map((w) => [wtKey(w.path), w])); }
async function worktreesInput(list) {
  if (list == null) return { value: [] };
  if (!Array.isArray(list) || list.length > 8) return { error: 'Link at most 8 worktrees to a line.' };
  const map = await wtMap(); const out = []; const seen = new Set();
  for (const l of list) {
    const cur = map.get(wtKey(l && l.path));
    if (!cur) return { error: 'That worktree is not known. Refresh and try again.' };
    if (seen.has(wtKey(cur.path))) continue; seen.add(wtKey(cur.path));
    if (l.source === 'task') continue; // links by task id are worked out from the branch name each time, so they are not stored
    out.push({ path: cur.path, repoKey: cur.repoKey, layer: cur.layer, branch: cur.branch, source: ['ai', 'rules', 'user'].includes(l.source) ? l.source : 'user' });
  }
  return { value: out };
}

function draftInput(d) {
  if (!d) return null;
  const title = clean(d.title, 120); if (!title) return null;
  return { type: DRAFT_TYPES.includes(d.type) ? d.type : 'Task', title, body: String(d.body == null ? '' : d.body).replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, 4000),
    state: ['drafted', 'requested'].includes(d.state) ? d.state : 'drafted', requestedAt: d.requestedAt || null };
}
function itemInput(it) {
  const text = clean(it && it.text, 200); if (!text) return { error: 'Every line needs text.' };
  const kind = KINDS.includes(it.kind) ? it.kind : 'task';
  const taskId = it.taskId == null || it.taskId === '' ? null : Number(it.taskId);
  if (taskId !== null && (!Number.isInteger(taskId) || taskId < 1)) return { error: 'Invalid work item id.' };
  return { text, kind, taskId, confidence: it.confidence == null ? null : Math.max(0, Math.min(1, Number(it.confidence) || 0)), draft: taskId ? null : draftInput(it.draft), carriedFrom: it.carriedFrom || null };
}

// Joins plan lines with what the board knows about their work item.
async function planView(date) {
  const items = store.planItems(date);
  const pool = new Map((await planPool()).map((t) => [t.id, t]));
  const board = new Map(((tcache.data && tcache.data.tasks) || []).map((t) => [t.id, t]));
  const missing = [...new Set(items.map((i) => i.taskId || i.draft && i.draft.createdTaskId).filter((id) => id && !pool.has(id)))].slice(0, 10);
  await Promise.all(missing.map(async (id) => { try { const d = await fetchDetail(id); pool.set(id, { id, type: d.type, state: d.state, title: d.title, repos: [] }); } catch { /* shown as a bare id */ } }));
  const stats = store.noteStats();
  const done = new Set(['Resolved', 'Closed', 'Done']);
  // worktree links: the ones saved on the line (checked against what exists now) plus those whose branch carries the task id
  const wtNow = await wtMap(); const wtByTask = new Map();
  for (const w of wtNow.values()) { if (w.taskId) { if (!wtByTask.has(w.taskId)) wtByTask.set(w.taskId, []); wtByTask.get(w.taskId).push(w); } }
  const wtView = (w, source) => ({ path: w.path, repoKey: w.repoKey, layer: w.layer, branch: w.branch, isMain: !!w.isMain, where: w.where || null, dirtyFiles: w.dirtyFiles || 0, source, missing: false });
  return items.map((i) => {
    const links = []; const seen = new Set();
    for (const l of i.worktreeLinks || []) { const cur = wtNow.get(wtKey(l.path)); if (!seen.has(wtKey(l.path))) { seen.add(wtKey(l.path)); links.push(cur ? wtView(cur, l.source || 'user') : { path: l.path, repoKey: l.repoKey, layer: l.layer, branch: l.branch, isMain: false, where: null, dirtyFiles: 0, source: l.source || 'user', missing: true }); } }
    if (i.taskId) for (const w of wtByTask.get(i.taskId) || []) if (!seen.has(wtKey(w.path))) { seen.add(wtKey(w.path)); links.push(wtView(w, 'task')); }
    const id = i.taskId; const c = id ? pool.get(id) : null; const b = id ? board.get(id) : null;
    const task = id ? { id, type: c ? c.type : '', state: c ? c.state : '', title: c ? c.title : '', where: b ? b.where : null, attention: b ? b.attention : [], noteCount: (stats.get(id) || {}).count || 0 } : null;
    const looksDone = i.status === 'todo' && !!task && ((b && (b.where === 'Merged')) || (c && done.has(c.state)));
    return { ...i, worktrees: links, task, looksDone };
  });
}

async function planResponse(date) {
  return { date, today: localDate(), day: store.planDay(date), items: await planView(date), recent: store.planRecent(14) };
}

// The ratings are measured from Azure DevOps (read-only), local git, the usage log and this hub. The board and worktrees give the "now" metrics.
async function runScorecard() {
  let ctx = { tasks: [], worktrees: [] };
  try { ctx = { tasks: (await tasks(false)).tasks, worktrees: (await worktrees(false)).worktrees }; } catch { /* the now-metrics are left out */ }
  return scorecard.run(ctx);
}

async function parsePlan(req, res) {
  const body = await readBody(req);
  const text = String(body.text == null ? '' : body.text);
  if (text.length > 4000) return json(res, 400, { error: 'The plan is too long. Keep it under 4000 characters.' });
  try { return json(res, 200, await planner.propose(text, { pool: await planPool(), mode: body.mode === 'rules' ? 'rules' : 'auto', worktrees: (await worktrees(false)).worktrees })); }
  catch (e) { return json(res, e.status || 500, { error: e.message }); }
}

// Rewrites one draft using the code context of the chosen worktrees (paths only, read-only git).
async function redraftLine(req, res) {
  const body = await readBody(req);
  const paths = Array.isArray(body.worktrees) ? body.worktrees : [];
  if (paths.length > 8) return json(res, 400, { error: 'Choose at most 8 worktrees.' });
  const map = await wtMap(); const links = [];
  for (const p of paths) { const cur = map.get(wtKey(p)); if (!cur) return json(res, 400, { error: 'That worktree is not known. Refresh and try again.' }); links.push(cur); }
  try { return json(res, 200, await planner.redraft(String(body.text || ''), links, { pool: await planPool() })); }
  catch (e) { return json(res, e.status || 502, { error: 'The assistant could not rewrite the draft: ' + e.message }); }
}

// What happened to a proposed line between the assistant's proposal and the saved plan: a free accuracy record from real use.
function feedbackRow(date, x, prop) {
  const proposed = Number.isInteger(prop.taskId) ? prop.taskId : null; const final = x.taskId || null;
  const outcome = !proposed && !final ? 'no-match-agreed' : proposed === final ? 'accepted' : (proposed && final) ? 'changed' : proposed ? 'removed' : 'added';
  const pw = (Array.isArray(prop.worktrees) ? prop.worktrees : []).map(wtKey); const fw = (x.worktrees || []).map((w) => wtKey(w.path));
  return { date, engine: ['ai', 'rules'].includes(prop.engine) ? prop.engine : 'ai', text: x.text, proposedTask: proposed, finalTask: final, confidence: Math.max(0, Math.min(1, Number(prop.confidence) || 0)),
    proposedKind: KINDS.includes(prop.kind) ? prop.kind : null, finalKind: x.kind, outcome,
    draftEdited: !!(prop.draft && x.draft && (clean(prop.draft.title, 120) !== x.draft.title || String(prop.draft.body || '').trim() !== x.draft.body)),
    wtProposed: pw.length, wtKept: pw.filter((k) => fw.includes(k)).length, wtAdded: fw.filter((k) => !pw.includes(k)).length };
}

async function savePlan(req, res) {
  const body = await readBody(req, 262144); // up to 50 lines, each with a draft
  const date = body.date || localDate();
  if (!validDate(date)) return json(res, 400, { error: 'Invalid date.' });
  if (!Array.isArray(body.items) || !body.items.length) return json(res, 400, { error: 'There are no lines to save.' });
  if (body.items.length > 50) return json(res, 400, { error: 'At most 50 lines per plan.' });
  const items = [];
  const feedback = [];
  for (const it of body.items) {
    const x = itemInput(it); if (x.error) return json(res, 400, { error: x.error });
    const w = await worktreesInput(it.worktrees); if (w.error) return json(res, 400, { error: w.error });
    x.worktrees = w.value; items.push(x);
    if (it.proposal && typeof it.proposal === 'object') feedback.push(feedbackRow(date, x, it.proposal));
  }
  store.planSave(date, String(body.rawText || '').slice(0, 20000), items);
  try { store.feedbackAdd(feedback); } catch { /* feedback is a bonus: never fail a save because of it */ }
  return json(res, 201, await planResponse(date));
}

async function addPlanItem(req, res) {
  const body = await readBody(req);
  const date = body.date || localDate();
  if (!validDate(date)) return json(res, 400, { error: 'Invalid date.' });
  const x = itemInput(body); if (x.error) return json(res, 400, { error: x.error });
  const w = await worktreesInput(body.worktrees); if (w.error) return json(res, 400, { error: w.error });
  x.worktrees = w.value;
  store.planSave(date, '', [x]);
  return json(res, 201, await planResponse(date));
}

async function updatePlanItem(req, res, id) {
  const body = await readBody(req);
  const cur = store.planItem(id); if (!cur) return json(res, 404, { error: 'Plan line not found.' });
  const f = {};
  if (body.text !== undefined) { const t = clean(body.text, 200); if (!t) return json(res, 400, { error: 'The line cannot be empty.' }); f.text = t; }
  if (body.kind !== undefined) { if (!KINDS.includes(body.kind)) return json(res, 400, { error: 'Invalid kind.' }); f.kind = body.kind; }
  if (body.status !== undefined) {
    if (!['todo', 'done', 'skipped'].includes(body.status)) return json(res, 400, { error: 'Invalid status.' });
    f.status = body.status; f.doneAt = body.status === 'done' ? new Date().toISOString() : null; f.skipReason = body.status === 'skipped' ? clean(body.skipReason, 300) || null : null;
  }
  if (body.taskId !== undefined) {
    const t = body.taskId === null || body.taskId === '' ? null : Number(body.taskId);
    if (t !== null && (!Number.isInteger(t) || t < 1)) return json(res, 400, { error: 'Invalid work item id.' });
    f.taskId = t;
  }
  if (body.worktrees !== undefined) { const w = await worktreesInput(body.worktrees); if (w.error) return json(res, 400, { error: w.error }); f.worktrees = w.value; }
  if (body.draft !== undefined) {
    const d = draftInput(body.draft); if (!d) return json(res, 400, { error: 'A draft needs a title.' });
    f.draftType = d.type; f.draftTitle = d.title; f.draftBody = d.body; if (cur.draft && cur.draft.state === 'none') f.draftState = 'drafted';
  }
  if (body.draftState !== undefined) {
    if (!cur.draft) return json(res, 400, { error: 'This line has no draft.' });
    if (!['drafted', 'requested', 'created'].includes(body.draftState)) return json(res, 400, { error: 'Invalid draft state.' });
    f.draftState = body.draftState;
    f.requestedAt = body.draftState === 'drafted' ? null : (cur.draft.requestedAt || new Date().toISOString());
    if (body.draftState === 'created') {
      const n = Number(body.createdTaskId);
      if (!Number.isInteger(n) || n < 1) return json(res, 400, { error: 'Enter the work item id your lead created.' });
      f.createdTaskId = n; f.taskId = n; // attaches the reference
    }
  }
  store.planItemUpdate(id, f);
  tcache.at = 0;
  return json(res, 200, { item: (await planView(cur.date)).find((i) => i.id === id) });
}

async function closePlanDay(req, res) {
  const body = await readBody(req);
  const date = body.date || localDate();
  if (!validDate(date) || !store.planDay(date)) return json(res, 404, { error: 'There is no plan for that day.' });
  let items = store.planItems(date);
  const own = new Set(items.map((i) => i.id));
  for (const d of Array.isArray(body.drop) ? body.drop : []) {
    if (!own.has(d.id)) continue;
    const r = clean(d.reason, 300); if (!r) return json(res, 400, { error: 'Give a reason for each line you drop.' });
    store.planItemUpdate(d.id, { status: 'skipped', skipReason: r });
  }
  items = store.planItems(date);
  const carry = (Array.isArray(body.carry) ? body.carry : []).filter((id) => own.has(id) && (items.find((i) => i.id === id) || {}).status === 'todo');
  if (carry.length) {
    const next = addDays(date, 1);
    store.planSave(next, '', carry.map((id) => { const i = items.find((x) => x.id === id); return { text: i.text, kind: i.kind, taskId: i.taskId, confidence: i.confidence, carriedFrom: i.id, worktrees: i.worktreeLinks, draft: i.draft && !i.taskId ? { type: i.draft.type, title: i.draft.title, body: i.draft.body, state: i.draft.state === 'created' ? 'drafted' : i.draft.state, requestedAt: i.draft.requestedAt } : null }; }));
  }
  // Unplanned work = tasks where YOU did something that day (opened or merged a PR, committed, wrote a note) that no plan line refers to.
  // A work item merely changed in Azure DevOps by someone else or by automation does not count.
  const planned = new Set(items.map((i) => i.taskId).filter(Boolean));
  const noteLast = store.noteStats();
  const myDays = (t) => [...t.prs.flatMap((p) => [p.created, p.closed]), ...t.worktrees.map((w) => w.lastCommit), (noteLast.get(t.id) || {}).last].filter(Boolean).map((d) => localDate(new Date(d)));
  const unplanned = ((tcache.data && tcache.data.tasks) || []).filter((t) => !planned.has(t.id) && myDays(t).includes(date)).map((t) => ({ id: t.id, title: t.title }));
  const score = dayScore(items, { carriedIds: carry, unplanned });
  store.planClose(date, score);
  return json(res, 200, { score, carriedTo: carry.length ? addDays(date, 1) : null, ...(await planResponse(date)) });
}

function noteInput(body) {
  const section = clean(body.section, 40);
  const text = String(body.body == null ? '' : body.body).replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  const errors = {};
  if (!SECTIONS.includes(section)) errors.section = 'Choose a section.';
  if (!text) errors.body = 'Write something first.';
  if (text.length > 8000) errors.body = 'Notes are limited to 8000 characters.';
  return { section, text, errors };
}

async function addNote(req, res) {
  const body = await readBody(req);
  const taskId = Number(body.taskId);
  if (!Number.isInteger(taskId) || taskId < 1) return json(res, 400, { error: 'Invalid task id.' });
  const n = noteInput(body);
  if (Object.keys(n.errors).length) return json(res, 400, { error: 'Validation failed', errors: n.errors });
  const known = tcache.data && tcache.data.tasks.some((t) => t.id === taskId);
  const id = store.noteAdd(taskId, n.section, n.text, clean(body.author, 60) || USER); // the command-line tool passes who wrote it (e.g. "claude session")
  if (!known) tcache.at = 0; // a task that is not on the board yet joins it, because it now has notes
  return json(res, 201, { note: store.noteGet(id) });
}

// A note that arrived through the inbox (written by another program while it could not reach the API). Same rules as a note typed in the UI.
function ingestNote(msg) {
  const taskId = Number(msg.taskId);
  if (!Number.isInteger(taskId) || taskId < 1) throw new Error('taskId must be a positive whole number');
  const n = noteInput({ section: msg.section, body: msg.body });
  if (Object.keys(n.errors).length) throw new Error(Object.values(n.errors).join(' '));
  const author = clean(msg.author, 60) || 'session';
  const id = store.noteAddFromInbox(msg.id, taskId, n.section, n.text, author);
  if (id === null) return 'duplicate';
  if (!(tcache.data && tcache.data.tasks.some((t) => t.id === taskId))) tcache.at = 0;
  return 'applied';
}

async function updateNote(req, res, id) {
  const body = await readBody(req);
  if (!store.noteGet(id)) return json(res, 404, { error: 'Note not found.' });
  const n = noteInput(body);
  if (Object.keys(n.errors).length) return json(res, 400, { error: 'Validation failed', errors: n.errors });
  store.noteUpdate(id, n.section, n.text);
  return json(res, 200, { note: store.noteGet(id) });
}

async function restoreClearance(req, res, id) {
  const body = await readBody(req);
  if (!store.get(id)) return json(res, 404, { error: 'Clearance not found.' });
  if (!store.restore(id, clean(body.note, 500), USER)) return json(res, 409, { error: 'Already restored.' });
  return json(res, 200, { ok: true });
}

async function knownWorktree(p) {
  const d = await worktrees(false);
  const key = store.keyOf(p);
  return d.worktrees.find((x) => store.keyOf(x.path) === key && !x.isMain) || null;
}

async function startMove(req, res) {
  const body = await readBody(req);
  if (body.ack !== true) return json(res, 400, { error: 'Confirm that you understand the live repo will change.' });
  const w = await knownWorktree(body.path);
  if (!w) return json(res, 404, { error: 'Worktree not found. Refresh and try again.' });
  try {
    const id = await mover.start(w.path, USER, w.repoKey);
    cache.at = 0; tcache.at = 0; // the worktree list and task states change as soon as the move starts
    return json(res, 202, { id });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message, blockers: e.blockers });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (req.method === 'GET') {
      if (p === '/api/me') return json(res, 200, { user: USER, categories: CATEGORIES, title: cfg.title, brand: cfg.brand, userName: cfg.userName, organization: cfg.org, project: cfg.project, adoConfigured: cfg.adoConfigured,
        branchPrefix: cfg.branchPrefix, workspaceRoot: cfg.workspaceRoot, hubDir: cfg.root, configFile: cfg.configFile, problems: cfg.problems });
      if (p === '/api/worktrees') return json(res, 200, annotate(await worktrees(url.searchParams.get('refresh') === '1')));
      if (p === '/api/clearances') return json(res, 200, { clearances: store.list() });
      if (p === '/api/tasks') {
        const d = await tasks(url.searchParams.get('refresh') === '1');
        const stats = store.noteStats();
        return json(res, 200, { ...d, tasks: d.tasks.map((t) => ({ ...t, noteCount: (stats.get(t.id) || {}).count || 0, lastNoteAt: (stats.get(t.id) || {}).last || null })) });
      }
      if (p === '/api/tasks/completed') {
        const days = Number(url.searchParams.get('days') || 90);
        if (!Number.isInteger(days) || days < 1 || days > 730) return json(res, 400, { error: 'days must be between 1 and 730' });
        try {
          const d = await collectCompleted(days, (await worktrees(false)).worktrees);
          const stats = store.noteStats();
          return json(res, 200, { ...d, tasks: d.tasks.map((t) => ({ ...t, noteCount: (stats.get(t.id) || {}).count || 0, lastNoteAt: (stats.get(t.id) || {}).last || null })) });
        } catch (e) { return json(res, 502, { error: e.message, auth: e.code === 'AUTH' }); }
      }
      const cx = /^\/api\/context\/(\d+)$/.exec(p);
      if (cx) { // what a Claude session should know about a task before it starts: read-only, never slow (Azure DevOps lookup is capped at 3 s)
        const id = Number(cx[1]);
        let d = null; try { d = await Promise.race([fetchDetail(id), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]); } catch { /* local data only */ }
        const t = (tcache.data && tcache.data.tasks.find((x) => x.id === id)) || null;
        const wts = [...(await wtMap()).values()].filter((w) => w.taskId === id).map((w) => ({ path: w.path, repoKey: w.repoKey, layer: w.layer, branch: w.branch, isMain: !!w.isMain, where: w.where, dirtyFiles: w.dirtyFiles || 0 }));
        return json(res, 200, { id, url: `${cfg.org}/${cfg.project}/_workitems/edit/${id}`, title: (d && d.title) || (t && t.title) || '', type: (d && d.type) || (t && t.type) || '', state: (d && d.state) || (t && t.state) || '',
          assignedTo: (d && d.assignedTo) || '', where: t ? t.where : null, attention: t ? t.attention : [], prs: t ? t.prs.map((x) => ({ id: x.id, status: x.status, repo: x.repo, unresolved: x.unresolved })) : [],
          worktrees: wts, notes: store.noteList(id).slice(0, 10), plan: store.planItemsForTask(id, 5), sessions: (() => { try { const s = sessionsMod.forTask(id); return { totals: s.totals, recent: s.sessions.slice(0, 3).map((x) => ({ sessionId: x.sessionId, last: x.last, turns: x.turns, label: x.label })) }; } catch { return null; } })(), adoReachable: !!d });
      }
      if (p === '/api/scorecard') return json(res, 200, scorecard.status());
      if (p === '/api/health') return json(res, 200, { db: store.health(), backups: backup.status(), inbox: inbox.counts() });
      if (p === '/api/usage') return json(res, 200, { ...usage.report(), hubAi: { month: ai.monthStats(), all: store.aiCallStats('0'), recent: store.aiCallList(10) } });
      if (p === '/api/ai/status') return json(res, 200, { ...(await ai.status()), models: ai.MODELS, month: ai.monthStats() });
      if (p === '/api/plan') {
        const date = url.searchParams.get('date') || localDate();
        if (!validDate(date)) return json(res, 400, { error: 'Invalid date.' });
        return json(res, 200, await planResponse(date));
      }
      const ts = /^\/api\/tasks\/(\d+)\/sessions$/.exec(p);
      if (ts) return json(res, 200, sessionsMod.forTask(ts[1]));
      const td = /^\/api\/tasks\/(\d+)$/.exec(p);
      if (td) {
        const id = Number(td[1]);
        let detail = null; let error = null;
        try { detail = await fetchDetail(id); } catch (e) { error = e.message; }
        const d = tcache.data;
        return json(res, 200, { id, detail, error, task: (d && d.tasks.find((t) => t.id === id)) || null, notes: store.noteList(id), sections: SECTIONS });
      }
      if (p === '/api/moves/plan') {
        const w = await knownWorktree(url.searchParams.get('path'));
        if (!w) return json(res, 404, { error: 'Worktree not found. Refresh and try again.' });
        return json(res, 200, await mover.plan(w.path));
      }
      if (p === '/api/moves') return json(res, 200, { moves: store.moveList(), busy: mover.isBusy() });
      const mv = /^\/api\/moves\/(\d+)$/.exec(p);
      if (mv) { const m = store.moveGet(Number(mv[1])); return m ? json(res, 200, m) : json(res, 404, { error: 'Not found' }); }
      if (p.startsWith('/api/stash/') && await stashRoutes(req, res, p, url)) return;
      if (p === '/api/stashes') return json(res, 200, { stashes: await mover.stashStates(store.stashList()) });
      const file = p === '/' ? 'index.html' : path.basename(p);
      const full = path.join(UI, file);
      if (!TYPES[path.extname(full)] || !fs.existsSync(full)) return send(res, 404, 'not found', 'text/plain');
      return send(res, 200, fs.readFileSync(full), TYPES[path.extname(full)]);
    }
    if (req.method === 'POST') {
      const bad = guardWrite(req);
      if (bad) return json(res, 403, { error: bad });
      if (p.startsWith('/api/stash/') && await stashRoutes(req, res, p, url)) return;
      if (p === '/api/clearances') return await createClearance(req, res);
      if (p === '/api/moves') return await startMove(req, res);
      if (p === '/api/scorecard/run') { await readBody(req); return json(res, 202, await runScorecard()); }
      if (p === '/api/backup') {
        await readBody(req);
        try { const r = backup.snapshot('manual'); backup.exportWeekly(new Date(), true); return json(res, 200, { backup: r, status: backup.status() }); }
        catch (e) { return json(res, 500, { error: e.message }); }
      }
      if (p === '/api/plan/parse') return await parsePlan(req, res);
      if (p === '/api/plan/redraft') return await redraftLine(req, res);
      if (p === '/api/plan/save') return await savePlan(req, res);
      if (p === '/api/plan/items') return await addPlanItem(req, res);
      if (p === '/api/plan/close') return await closePlanDay(req, res);
      const pu = /^\/api\/plan\/items\/(\d+)\/update$/.exec(p);
      if (pu) return await updatePlanItem(req, res, Number(pu[1]));
      const pd = /^\/api\/plan\/items\/(\d+)\/delete$/.exec(p);
      if (pd) { await readBody(req); return store.planItemDelete(Number(pd[1])) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Plan line not found.' }); }
      if (p === '/api/notes') return await addNote(req, res);
      const nu = /^\/api\/notes\/(\d+)\/update$/.exec(p);
      if (nu) return await updateNote(req, res, Number(nu[1]));
      const nd = /^\/api\/notes\/(\d+)\/delete$/.exec(p);
      if (nd) { await readBody(req); return store.noteDelete(Number(nd[1])) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Note not found.' }); }
      const sh = /^\/api\/stashes\/(\d+)\/handled$/.exec(p);
      if (sh) {
        const body = await readBody(req);
        if (!store.stashGet(Number(sh[1]))) return json(res, 404, { error: 'Stash record not found.' });
        if (!store.stashHandle(Number(sh[1]), clean(body.note, 500), USER)) return json(res, 409, { error: 'Already marked as handled.' });
        return json(res, 200, { ok: true });
      }
      const m = /^\/api\/clearances\/(\d+)\/restore$/.exec(p);
      if (m) return await restoreClearance(req, res, Number(m[1]));
    }
    return json(res, 404, { error: 'Not found' });
  } catch (e) {
    return json(res, (e && e.status) || 500, { error: String((e && e.message) || e) });
  }
});

server.listen(cfg.port, '127.0.0.1', () => {
  console.log(cfg.title + ' on http://localhost:' + cfg.port);
  for (const p of cfg.problems) console.log('Setup note: ' + p);
  if (store.health().migration.snapshot) console.log('Database upgraded (schema ' + store.health().migration.from + ' to ' + store.health().migration.to + '). Copy kept at ' + store.health().migration.snapshot);
  backup.start();
  inbox.start({ note: ingestNote });
  setTimeout(async () => { // refresh the ratings once a week without being asked (read-only, no model, about 10 seconds)
    try { const r = scorecard.status().result; if (!r || Date.now() - Date.parse(r.generatedAt) > 7 * 86400000) await runScorecard(); } catch { /* next start */ }
  }, 20000).unref();
});
