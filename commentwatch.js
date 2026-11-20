'use strict';
// Comment watch: which of the work items you follow have comments you have not seen, which are for you, and who you are waiting on.
// Azure DevOps has no "unread" flag per person, so the hub keeps its own read marker. Everything here is local: nothing is ever written to
// Azure DevOps and no model is used. Azure DevOps data comes in through `deps` (a batch of comment counts and, only for items whose count
// rose, the newest comments of that one item), so this file has no network or shell access of its own.
const cfg = require('./config');
const store = require('./store');
const W = require('./lib/workdays');
const { htmlToText, clip } = require('./lib/text');

/* ---------- pure rules (unit tested) ---------- */
const norm = (s) => String(s == null ? '' : s).toLowerCase().trim();
const plain = (html) => clip(htmlToText(html), 600);

// Is this comment written by me? `me` is { id, name, unique } as Azure DevOps reports it.
function isMine(c, me) {
  if (!me || !c) return false;
  if (me.id && c.authorId && norm(c.authorId) === norm(me.id)) return true;
  if (me.unique && c.authorUnique && norm(c.authorUnique) === norm(me.unique)) return true;
  return !!(me.name && c.author && norm(c.author) === norm(me.name));
}
// Does the comment @mention me? Azure DevOps writes a mention as a link carrying the person's id, with the text "@Name".
function mentionsMe(c, me) {
  if (!me || !c) return false;
  const h = norm(c.html);
  if (me.id && h.includes('data-vss-mention') && h.includes(norm(me.id))) return true;
  return !!(me.name && norm(htmlToText(c.html)).includes('@' + norm(me.name)));
}
// The comments added since the last check. `thread` is newest first. Without a stored newest id, the count tells how many are new.
function newComments(thread, row, count) {
  if (row.last_comment_id != null) return thread.filter((c) => c.id > row.last_comment_id);
  const diff = Math.max(0, count - (row.count_polled || 0));
  return thread.slice(0, diff);
}
// New comments by other people, each with why it matters: a mention of me, or an answer after something I wrote.
function classifyEvents(news, thread, me) {
  const out = [];
  for (const c of news) {
    if (isMine(c, me)) continue;
    const mineBefore = thread.some((m) => isMine(m, me) && m.id < c.id);
    out.push({ commentId: c.id, author: c.author, at: c.at, snippet: clip(plain(c.html), 240), reason: mentionsMe(c, me) ? 'mention' : mineBefore ? 'reply' : null });
  }
  return out;
}
// A question I wrote that nobody has answered: my newest comment is the last one and ends with "?" or mentions a person.
function suggestAsk(thread, me) {
  const c = thread && thread[0];
  if (!c || !isMine(c, me)) return null;
  const text = plain(c.html);
  const m = /data-vss-mention[^>]*>\s*@?([^<]+?)\s*</i.exec(String(c.html || ''));
  if (!/\?\s*$/.test(text) && !m) return null;
  return { commentId: c.id, person: m ? m[1].trim() : '', question: clip(text, 300), at: c.at || null };
}
// All the words of the name I asked appear in the author's name ("Ravi" matches "Ravi Kumar"). Empty person: anyone.
function matchesPerson(person, author) {
  const words = norm(person).split(/\s+/).filter((w) => w.length >= 2);
  if (!words.length) return true;
  const a = norm(author);
  return words.every((w) => a.includes(w));
}
const askState = (a, today) => (a.closed_at ? 'closed' : a.replied_at ? 'replied' : a.nudge_at <= today ? 'nudge' : 'waiting');
const nudgeDate = (days) => W.addWorkingDays(W.today(), days, cfg.planner.workingDays);

/* ---------- the watcher ---------- */
function create(deps) {
  const S = { running: null, lastPollAt: null, lastOkAt: null, error: null, backoffUntil: 0, polled: 0 };
  const P = () => cfg.commentWatch;

  function watchedIds() {
    const ids = new Set(deps.watchedIds() || []);
    for (const id of store.cwUserWatched()) ids.add(id);
    for (const a of store.askList(true)) ids.add(a.task_id);
    return [...ids].filter((i) => Number.isInteger(i) && i > 0).slice(0, P().maxWatched);
  }

  function applyReplies(taskId, others) {
    for (const a of store.askList(true, taskId)) {
      if (a.replied_at) continue;
      const hit = others.find((c) => (!c.at || !a.asked_at || c.at >= a.asked_at) && matchesPerson(a.person, c.author));
      if (hit) store.askSet(a.id, { replied_at: hit.at || new Date().toISOString(), replied_by: hit.author });
    }
  }

  async function runPoll() {
    const me = await deps.getMe();
    const ids = watchedIds();
    const counts = ids.length ? await deps.fetchCounts(ids) : new Map();
    const now = new Date().toISOString(); let fetched = 0; let added = 0;
    for (const [id, info] of counts) {
      const row = store.cwGet(id) || { task_id: id, count_polled: 0, last_comment_id: null, last_polled_at: null, user_watch: 0, suggest_json: null, suggest_dismissed: null };
      row.title = info.title || row.title; row.state = info.state || row.state;
      if (!row.last_polled_at) { row.count_polled = info.count; row.last_polled_at = now; store.cwSave(row); continue; } // first sight: what is there is "seen", nothing floods
      if (info.count < row.count_polled) row.count_polled = info.count; // a comment was deleted
      else if (info.count > row.count_polled) {
        let thread;
        try { thread = await deps.fetchThread(id, Math.min(20, info.count - row.count_polled + 3)); fetched++; } catch { continue; } // retried at the next check
        const cs = thread.comments || [];
        const news = newComments(cs, row, info.count);
        const events = classifyEvents(news, cs, me);
        for (const e of events) added += store.cwEventAdd(id, e);
        applyReplies(id, news.filter((c) => !isMine(c, me)));
        row.last_comment_id = Math.max(row.last_comment_id || 0, ...cs.map((c) => c.id || 0)) || row.last_comment_id;
        row.count_polled = info.count;
        const sg = suggestAsk(cs, me);
        row.suggest_json = sg && row.suggest_dismissed !== sg.commentId && !store.askList(true, id).length ? JSON.stringify(sg) : null;
      }
      row.last_polled_at = now; store.cwSave(row);
    }
    return { watched: ids.length, fetched, added };
  }

  async function poll() {
    if (S.running) return S.running;
    S.running = (async () => {
      S.lastPollAt = new Date().toISOString();
      try { const r = await runPoll(); S.lastOkAt = S.lastPollAt; S.error = null; S.backoffUntil = 0; S.polled++; return r; }
      catch (e) { S.error = String((e && e.message) || e); S.backoffUntil = Date.now() + Math.min(60, P().pollMinutes * 2) * 60000; return { error: S.error }; }
      finally { S.running = null; }
    })();
    return S.running;
  }

  function start() { // a first check shortly after start, then every few minutes during working hours
    if (!P().enabled) return;
    setTimeout(() => { poll(); }, 30000).unref();
    setInterval(() => {
      const h = new Date().getHours();
      if (h < P().hoursFrom || h >= P().hoursTo || Date.now() < S.backoffUntil) return;
      if (S.lastPollAt && Date.now() - Date.parse(S.lastPollAt) < P().pollMinutes * 60000 - 5000) return;
      poll();
    }, 60000).unref();
  }

  /* ---------- views ---------- */
  function asksView() {
    const today = W.today(); const titles = new Map(store.cwAll().map((r) => [r.task_id, r.title || '']));
    return store.askList(false).map((a) => ({ id: a.id, taskId: a.task_id, title: titles.get(a.task_id) || '', person: a.person, question: a.question, askedAt: a.asked_at, nudgeAt: a.nudge_at, repliedAt: a.replied_at, repliedBy: a.replied_by, closedAt: a.closed_at, source: a.source, state: askState(a, today) }));
  }
  function view() {
    const rows = new Map(store.cwAll().map((r) => [r.task_id, r]));
    const byTask = new Map();
    for (const e of store.cwUnreadAll()) { if (!byTask.has(e.task_id)) byTask.set(e.task_id, []); byTask.get(e.task_id).push(e); }
    const items = [...byTask].map(([taskId, evs]) => {
      const r = rows.get(taskId) || {};
      const reasons = [...new Set(evs.map((e) => e.reason).filter(Boolean))];
      return { taskId, title: r.title || '', state: r.state || '', unread: evs.length, forYou: reasons.length > 0, reasons, lastAt: evs[0].at, events: evs.slice(0, 5).map((e) => ({ commentId: e.comment_id, author: e.author, at: e.at, snippet: e.snippet, reason: e.reason })) };
    }).sort((a, b) => (b.forYou - a.forYou) || String(b.lastAt || '').localeCompare(String(a.lastAt || '')));
    const asks = asksView().filter((a) => !a.closedAt);
    const suggestions = [...rows.values()].filter((r) => r.suggest_json).map((r) => ({ taskId: r.task_id, title: r.title || '', ...JSON.parse(r.suggest_json) }));
    const c = (k) => asks.filter((a) => a.state === k).length;
    const counts = { items: items.length, comments: items.reduce((n, i) => n + i.unread, 0), forYou: items.filter((i) => i.forYou).length, waiting: c('waiting'), replied: c('replied'), nudge: c('nudge'), suggestions: suggestions.length };
    const map = {}; for (const i of items) map[i.taskId] = { unread: i.unread, forYou: i.forYou };
    const askMap = {}; for (const a of asks) { if (!askMap[a.taskId] || ['replied', 'nudge'].includes(a.state)) askMap[a.taskId] = a.state; }
    return { enabled: P().enabled, lastPollAt: S.lastPollAt, lastOkAt: S.lastOkAt, error: S.error, checking: !!S.running, pollMinutes: P().pollMinutes, counts, attention: counts.items + counts.replied + counts.nudge, items, asks, suggestions, map, askMap };
  }
  const summary = () => { const v = view(); return { map: v.map, askMap: v.askMap, attention: v.attention, counts: v.counts, error: v.error }; };
  function forTask(id) {
    const r = store.cwGet(id) || {};
    const today = W.today();
    return { watching: !!r.user_watch, unread: store.cwEvents(id, true).map((e) => ({ commentId: e.comment_id, author: e.author, at: e.at, snippet: e.snippet, reason: e.reason })), asks: store.askList(false, id).map((a) => ({ id: a.id, person: a.person, question: a.question, askedAt: a.asked_at, nudgeAt: a.nudge_at, repliedAt: a.replied_at, repliedBy: a.replied_by, closedAt: a.closed_at, state: askState(a, today) })), suggestion: r.suggest_json ? JSON.parse(r.suggest_json) : null };
  }

  /* ---------- your actions (local only) ---------- */
  const bad = (m) => { const e = new Error(m); e.status = 400; return e; };
  function addAsk(b) {
    const taskId = Number(b.taskId); const question = String(b.question || '').trim().slice(0, 600); const person = String(b.person || '').trim().slice(0, 120);
    if (!Number.isInteger(taskId) || taskId < 1) throw bad('Choose a work item.');
    if (!question) throw bad('Write what you asked.');
    const days = b.nudgeDays == null || b.nudgeDays === '' ? P().nudgeDays : Number(b.nudgeDays);
    if (!Number.isInteger(days) || days < 1 || days > 30) throw bad('Nudge after 1 to 30 working days.');
    const id = store.askAdd({ taskId, person, question, nudgeAt: nudgeDate(days), source: b.source === 'suggested' ? 'suggested' : 'user' });
    const r = store.cwGet(taskId); if (r && r.suggest_json) { r.suggest_json = null; store.cwSave(r); }
    return id;
  }
  function closeAsk(id) { const a = store.askGet(id); if (!a) return false; store.askSet(id, { closed_at: new Date().toISOString() }); return true; }
  function snoozeAsk(id, days) {
    const a = store.askGet(id); if (!a) return false;
    const n = Number(days); if (!Number.isInteger(n) || n < 1 || n > 30) throw bad('Snooze 1 to 30 working days.');
    store.askSet(id, { nudge_at: nudgeDate(n) }); return true;
  }
  function setWatch(taskId, on) {
    const r = store.cwGet(taskId) || { task_id: taskId, count_polled: 0, last_comment_id: null, last_polled_at: null, user_watch: 0 };
    r.user_watch = on ? 1 : 0; store.cwSave(r); return true;
  }
  function acceptSuggestion(taskId, nudgeDays) {
    const r = store.cwGet(taskId); if (!r || !r.suggest_json) return null;
    const s = JSON.parse(r.suggest_json);
    return addAsk({ taskId, person: s.person, question: s.question, nudgeDays, source: 'suggested' });
  }
  function dismissSuggestion(taskId) {
    const r = store.cwGet(taskId); if (!r || !r.suggest_json) return false;
    r.suggest_dismissed = JSON.parse(r.suggest_json).commentId; r.suggest_json = null; store.cwSave(r); return true;
  }
  const markRead = (taskId) => store.cwMarkRead(taskId == null ? null : taskId);

  return { poll, start, view, summary, forTask, addAsk, closeAsk, snoozeAsk, setWatch, acceptSuggestion, dismissSuggestion, markRead, status: () => ({ ...S, running: !!S.running }) };
}

module.exports = { create, isMine, mentionsMe, newComments, classifyEvents, suggestAsk, matchesPerson, askState, nudgeDate };
