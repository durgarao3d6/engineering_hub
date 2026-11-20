'use strict';
// The work planner: assigned work items scheduled across days, delegations to watch, and the daily revision against the latest fetch.
// A work item on a day is an ordinary plan line (table plan_items), so it shows up in Today's plan on its day.
// Everything here is recorded in the hub only: nothing is ever written to Azure DevOps (reassigning or closing there stays your job).
// Live work item data comes in through `deps` (the task board for items assigned to you, a read-only batch fetch for the rest).
const cfg = require('./config');
const store = require('./store');
const W = require('./lib/workdays');
const cwRules = require('./commentwatch'); // only its pure ask rules (is an ask waiting, replied or due)

const DONE_STATES = new Set(['Resolved', 'Closed', 'Done', 'Removed']);
const MAX_AHEAD_DAYS = 60;
const REASONS = ['Done', 'Cancelled', 'Other'];

/* ---------- pure rules (unit tested) ---------- */
const snapOf = (t) => (t ? { title: t.title || '', type: t.type || '', state: t.state || '', priority: t.priority || null, assignedTo: t.assignedTo || '', changedDate: t.changedDate || null } : null);
const isDone = (t) => !!t && DONE_STATES.has(t.state);
const dateOf = (iso) => (iso ? new Date(iso).toLocaleDateString('en-CA') : null);

// What differs between what you accepted and what Azure DevOps says now.
function changesOf(snap, live) {
  if (!snap || !live || !live.state) return [];
  const out = [];
  if ((snap.priority || null) !== (live.priority || null)) out.push({ kind: 'priority', from: snap.priority || null, to: live.priority || null });
  if (snap.state !== live.state) out.push({ kind: 'state', from: snap.state, to: live.state });
  if (snap.title !== live.title) out.push({ kind: 'title', from: snap.title, to: live.title });
  if ((snap.assignedTo || '') !== (live.assignedTo || '')) out.push({ kind: 'assignee', from: snap.assignedTo || '', to: live.assignedTo || '' });
  return out;
}
// "No longer yours": only when it WAS yours when you accepted it (an unassigned item you took on shows as a change instead).
const notMine = (live, me, snap) => !!(live && live.state && me && live.assignedTo && live.assignedTo !== me && (!snap || snap.assignedTo === me));
const changeText = (c) => (c.kind === 'priority' ? 'Priority P' + (c.from || '-') + ' to P' + (c.to || '-') : c.kind === 'state' ? 'State ' + c.from + ' to ' + c.to : c.kind === 'assignee' ? 'Reassigned from ' + (c.from || 'nobody') + ' to ' + (c.to || 'nobody') : 'Title changed');

// Reasons a delegation needs you. `live` is the work item as Azure DevOps shows it now (null when it could not be fetched).
function delegationFlags(d, live, today, P, me) {
  const out = [];
  const days = P.workingDays;
  const done = isDone(live);
  if (d.mode === 'monitor') {
    if (d.nextCheck && d.nextCheck <= today) out.push({ kind: 'check-overdue', text: d.nextCheck < today ? 'Check was due ' + d.nextCheck : 'Check is due today' });
    if (d.expectBy && d.expectBy < today && !done) out.push({ kind: 'expect-overdue', text: 'Expected by ' + d.expectBy + ' and not finished' });
    if (live && live.state) {
      const seen = d.lastSeen;
      if (seen) for (const c of changesOf(seen, live)) {
        if (c.kind === 'assignee' && c.to === d.person) continue; // the hand-over you planned: that is not news
        if (c.kind === 'state' && done) continue; // "ready to close" below says it better
        if (c.kind === 'state' || c.kind === 'assignee') out.push({ kind: 'ado-changed', text: changeText(c) });
      }
      if (me && live.assignedTo === me && d.person !== me) {
        if (seen && seen.assignedTo && seen.assignedTo !== me) out.push({ kind: 'back-to-me', text: 'Assigned back to you in Azure DevOps' });
        else out.push({ kind: 'not-reassigned', soft: true, text: 'Still assigned to you in Azure DevOps: reassign it to ' + d.person + ' in Azure Boards' }); // a hint on the card, not an alert
      }
      const last = dateOf(live.changedDate);
      if (!done && last && d.checkEveryDays && W.workingDaysBetween(last, today, days) >= 2 * d.checkEveryDays) out.push({ kind: 'quiet', text: 'No activity in Azure DevOps for ' + W.workingDaysBetween(last, today, days) + ' working days' });
      if (done) out.push({ kind: 'ready-to-close', text: 'Now ' + live.state + ' in Azure DevOps: ready to close' });
    }
  } else if (d.mode === 'fire_and_forget') {
    const since = dateOf(d.createdAt);
    const waited = since ? W.workingDaysBetween(since, today, days) : 0;
    if (!done && d.wakeAfterDays && waited >= d.wakeAfterDays && live) out.push({ kind: 'woke', text: 'Still ' + (live.state || 'open') + ' ' + waited + ' working days after you handed it over' });
  }
  return out;
}
// Assigned items that are not scheduled, delegated or parked: priority first (P1 highest), then most recently changed.
function inboxOf(assigned, scheduledIds, delegatedIds, laterIds) {
  return assigned.filter((t) => t.assignedToMe !== false && !isDone(t) && !scheduledIds.has(t.id) && !delegatedIds.has(t.id) && !laterIds.has(t.id))
    .sort((a, b) => (a.priority || 99) - (b.priority || 99) || String(b.changedDate || '').localeCompare(String(a.changedDate || '')) || a.id - b.id);
}
// Order for a day by priority (P1 first, unknown last); ties keep the current order.
function priorityOrder(lines, liveById) {
  return lines.map((l, i) => ({ l, i, p: (l.taskId && liveById.get(l.taskId) && liveById.get(l.taskId).priority) || 99 })).sort((a, b) => a.p - b.p || a.i - b.i).map((x) => x.l.id);
}
// The columns: today, then the next `horizon` working days.
function columnDates(today, P) { return [today, ...W.nextWorkingDays(W.addDays(today, 1), P.horizonDays, P.workingDays)]; }
const weekday = (s) => W.parse(s).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const columnLabel = (s, today) => (s === today ? 'Today' : s === W.addDays(today, 1) ? 'Tomorrow' : weekday(s));

/* ---------- the planner, with live data supplied from outside ---------- */
// deps: { getTasks(force) -> { ado, me, tasks }, fetchMany(ids) -> Map(id -> item), today() }
function create(deps) {
  const P = cfg.planner;
  const today = () => (deps.today ? deps.today() : W.today());
  const err = (status, message) => Object.assign(new Error(message), { status });
  const checkDate = (d, allowPast) => {
    if (!W.valid(d)) throw err(400, 'Pick a valid date.');
    if (!allowPast && d < today()) throw err(400, 'Pick today or a later day.');
    if (d > W.addDays(today(), MAX_AHEAD_DAYS)) throw err(400, 'Plans go at most ' + MAX_AHEAD_DAYS + ' days ahead.');
  };

  async function liveMap(extraIds, force) {
    const data = await deps.getTasks(!!force);
    const map = new Map((data.tasks || []).map((t) => [t.id, t]));
    const need = [...new Set(extraIds)].filter((id) => !map.has(id));
    if (need.length && data.ado && data.ado.ok !== false) {
      try { const got = await deps.fetchMany(need); for (const [id, t] of got) map.set(id, t); } catch { /* shown as "could not be read" */ }
    }
    return { map, data };
  }

  async function board(force) {
    const t0 = today();
    const dates = columnDates(t0, P);
    const last = dates[dates.length - 1];
    const lines = store.plannerItems(W.addDays(t0, -14), W.addDays(t0, MAX_AHEAD_DAYS));
    const delegations = store.delegationList('open');
    const later = store.laterList();
    const openAsks = store.askList(true);
    const ids = [...lines.filter((l) => l.taskId).map((l) => l.taskId), ...delegations.map((d) => d.taskId), ...later.map((l) => l.task_id), ...openAsks.map((a) => a.task_id)];
    const { map, data } = await liveMap(ids, force);
    const me = data.me || '';
    const attention = [];
    const askStates = new Map(); // task id -> the state of its open ask (a reply or a due nudge wins over waiting)
    for (const a of openAsks) { const s = cwRules.askState(a, t0); const prev = askStates.get(a.task_id); if (!prev || s === 'replied' || s === 'nudge') askStates.set(a.task_id, s); }
    const card = (l) => {
      const live = l.taskId ? map.get(l.taskId) || null : null;
      const changes = l.status === 'todo' ? changesOf(l.snap, live) : [];
      const c = { ask: l.taskId ? askStates.get(l.taskId) || null : null, id: l.id, date: l.date, text: l.text, kind: l.kind, status: l.status, taskId: l.taskId, skipReason: l.skipReason, task: live ? { id: live.id, type: live.type, title: live.title, state: live.state, priority: live.priority, assignedTo: live.assignedTo, url: live.url } : null,
        changes, closedInAdo: l.status === 'todo' && isDone(live), notMine: l.status === 'todo' && notMine(live, me, l.snap) };
      if (l.status === 'todo' && l.taskId) {
        const title = (live && live.title) || l.text;
        if (c.closedInAdo) attention.push({ kind: 'done-in-ado', taskId: l.taskId, itemId: l.id, title, text: 'Now ' + live.state + ' in Azure DevOps, still planned for ' + l.date });
        else if (c.notMine) attention.push({ kind: 'reassigned', taskId: l.taskId, itemId: l.id, title, text: 'Assigned to ' + live.assignedTo + ' in Azure DevOps, still planned for ' + l.date });
        else if (changes.length) attention.push({ kind: 'changed', taskId: l.taskId, itemId: l.id, title, text: changes.map(changeText).join('; ') });
      }
      return c;
    };
    const inCol = (l, i) => { if (l.date === dates[i]) return true; if (dates.includes(l.date) || l.date < t0) return false; return l.date < dates[i] && (i === 0 || l.date > dates[i - 1]); };
    const days = dates.map((d, di) => {
      const items = lines.filter((l) => inCol(l, di)).map(card);
      const open = items.filter((i) => i.status === 'todo').length;
      return { date: d, label: columnLabel(d, t0), weekend: !W.isWorking(d, P.workingDays), items, open, over: open > P.dayCapacity };
    });
    const earlier = lines.filter((l) => l.date < t0 && l.status === 'todo').map(card);
    const beyond = lines.filter((l) => l.date > last && l.status === 'todo').map(card);
    const scheduled = store.plannerScheduledIds(t0);
    const delegatedIds = new Set(delegations.map((d) => d.taskId));
    const laterIds = new Set(later.map((l) => l.task_id));
    const waitingAsks = openAsks.filter((a) => askStates.get(a.task_id) === 'waiting' && cwRules.askState(a, t0) === 'waiting'); // parked: you are waiting for an answer
    const waitingIds = new Set(waitingAsks.map((a) => a.task_id));
    const inbox = inboxOf((data.tasks || []).filter((t) => t.assignedToMe), scheduled, delegatedIds, new Set([...laterIds, ...waitingIds]));
    // topics you cover: open items matching a saved keyword that are not on your own list (unassigned or owned by others)
    const topics = store.topicList(); let topicInbox = []; let topicError = null;
    if (topics.length) {
      try {
        const mine = new Set(inbox.map((t) => t.id));
        const hits = await deps.searchTopics(topics.map((t) => t.keyword), !!force);
        topicInbox = hits.filter((t) => !isDone(t) && !mine.has(t.id) && !scheduled.has(t.id) && !delegatedIds.has(t.id) && !laterIds.has(t.id)
          && !(data.tasks || []).some((x) => x.id === t.id && x.assignedToMe)).sort((a, b) => (a.priority || 99) - (b.priority || 99) || String(b.changedDate || '').localeCompare(String(a.changedDate || '')) || a.id - b.id);
        for (const tp of topics) tp.hits = hits.filter((h) => (h.matched || []).some((m) => m.toLowerCase() === tp.keyword.toLowerCase())).length;
      } catch (e) { topicError = e.message; }
    }
    const laterItems = later.filter((l) => !waitingIds.has(l.task_id)).map((l) => { const t = map.get(l.task_id); return { taskId: l.task_id, addedAt: l.added_at, task: t ? { id: t.id, type: t.type, title: t.title, state: t.state, priority: t.priority, url: t.url } : null, closedInAdo: isDone(t) }; });
    const dCards = delegations.map((d) => {
      const live = map.get(d.taskId) || null;
      const flags = delegationFlags(d, live, t0, P, me);
      for (const f of flags) if (!f.soft && (d.mode === 'monitor' || f.kind === 'woke')) attention.push({ kind: f.kind, taskId: d.taskId, delegationId: d.id, title: (live && live.title) || '#' + d.taskId, text: d.person + ': ' + f.text });
      return { ...d, task: live ? { id: live.id, type: live.type, title: live.title, state: live.state, priority: live.priority, assignedTo: live.assignedTo, changedDate: live.changedDate, url: live.url } : null, flags, readable: !!(live && live.state) };
    });
    for (const a of openAsks) {
      const s = cwRules.askState(a, t0); if (s === 'waiting') continue;
      const live = map.get(a.task_id);
      attention.push({ kind: s === 'replied' ? 'ask-replied' : 'ask-nudge', taskId: a.task_id, askId: a.id, title: (live && live.title) || '#' + a.task_id, text: s === 'replied' ? (a.replied_by || 'Someone') + ' answered your question' : 'No answer yet to: ' + a.question.slice(0, 80) });
    }
    if (inbox.length) attention.push({ kind: 'inbox', text: inbox.length + ' assigned item' + (inbox.length > 1 ? 's' : '') + ' not planned yet' });
    if (topicInbox.length) attention.push({ kind: 'topic-hits', text: topicInbox.length + ' open item' + (topicInbox.length > 1 ? 's' : '') + ' match your topics and are not planned' });
    const closed = store.delegationList('closed').slice(0, 15);
    const names = new Set([...(data.tasks || []).map((t) => t.assignedTo), ...(data.reviews || []).map((r) => r.author), ...store.delegationList().map((d) => d.person)].filter((n) => n && n !== me));
    return { generatedAt: new Date().toISOString(), today: t0, me, ado: data.ado, capacity: P.dayCapacity, settings: { monitorEveryDays: P.monitorEveryDays, wakeAfterWorkingDays: P.wakeAfterWorkingDays, dayCapacity: P.dayCapacity },
      revision: store.revisionGet(t0), days, earlier, beyond, inbox: inbox.map((t) => ({ id: t.id, type: t.type, title: t.title, state: t.state, priority: t.priority, assignedTo: t.assignedTo || '', url: t.url, changedDate: t.changedDate })), later: laterItems,
      delegations: { monitor: dCards.filter((d) => d.mode === 'monitor'), fireAndForget: dCards.filter((d) => d.mode === 'fire_and_forget'), closed },
      topics, topicError, topicInbox: topicInbox.map((t) => ({ id: t.id, type: t.type, title: t.title, state: t.state, priority: t.priority, assignedTo: t.assignedTo || '', matched: t.matched || [], url: t.url, changedDate: t.changedDate })),
      people: [...names].sort(), attention,
      waiting: waitingAsks.map((a) => { const t = map.get(a.task_id); return { askId: a.id, taskId: a.task_id, person: a.person, question: a.question, askedAt: a.asked_at, nudgeAt: a.nudge_at, task: t ? { id: t.id, type: t.type, title: t.title, state: t.state, priority: t.priority } : null }; }),
      counts: { attention: attention.length, attentionItems: new Set(attention.map((a) => (a.taskId ? 't' + a.taskId : 'k' + a.kind))).size, waiting: waitingAsks.length, inbox: inbox.length, topicInbox: topicInbox.length, monitor: dCards.filter((d) => d.mode === 'monitor').length, fireAndForget: dCards.filter((d) => d.mode === 'fire_and_forget').length } };
  }

  async function itemFor(taskId) { // the live work item, or a 404 when it does not exist
    const { map } = await liveMap([taskId], false);
    const t = map.get(taskId);
    if (!t || !t.state) throw err(404, 'Work item #' + taskId + ' was not found in Azure DevOps (or could not be read just now).');
    return t;
  }
  const lineText = (t) => t.title || ('Work item #' + t.id);

  async function schedule(taskId, date, by) {
    const t = await itemFor(taskId);
    if (store.delegationByTask(taskId)) throw err(409, 'This item is delegated. Take it back first.');
    if (date === 'later') { store.laterAdd(taskId); return { later: true }; }
    checkDate(date);
    const r = store.plannerAdd(date, today(), taskId, lineText(t), snapOf(t));
    if (r.existing) throw err(409, 'Already planned for ' + r.existing.date + '. Move it instead.');
    store.laterRemove(taskId);
    return { id: r.id, date };
  }
  function itemOr404(id) { const it = store.planItem(id); if (!it) throw err(404, 'That plan line no longer exists.'); return it; }
  async function move(itemId, date, position) {
    const it = itemOr404(itemId);
    if (it.status !== 'todo') throw err(409, 'Only open lines can be moved.');
    if (date === 'later') {
      if (!it.taskId) throw err(400, 'Only work item lines can go to Later.');
      store.planItemDelete(itemId); store.laterAdd(it.taskId); return { later: true };
    }
    checkDate(date);
    const r = store.plannerMove(itemId, date, position);
    if (r.error) throw err(409, 'That line cannot be moved.');
    return { date };
  }
  // Parking: the line leaves the day and the item waits (it needs an open ask, so you know who you are waiting on). A reply or a due nudge brings it back as an alert.
  function park(itemId) {
    const it = itemOr404(itemId);
    if (it.status !== 'todo' || !it.taskId) throw err(409, 'Only an open work item line can be parked.');
    if (!store.askList(true, it.taskId).length) throw err(409, 'Record who you are waiting on first ("I asked someone" on the work item), then park it.');
    store.planItemDelete(itemId); store.laterAdd(it.taskId); return { parked: true };
  }
  function unschedule(itemId) { const it = itemOr404(itemId); if (it.status !== 'todo') throw err(409, 'Only open lines can be removed from the plan.'); store.planItemDelete(itemId); return { ok: true }; }
  async function bringToToday() {
    const t0 = today(); const open = store.plannerItems(W.addDays(t0, -14), W.addDays(t0, -1)).filter((l) => l.status === 'todo');
    for (const l of open) store.plannerMove(l.id, t0);
    return { moved: open.length };
  }
  async function sortDay(date) {
    checkDate(date, true);
    const lines = store.plannerItems(date, date).filter((l) => l.status === 'todo');
    const { map } = await liveMap(lines.filter((l) => l.taskId).map((l) => l.taskId), false);
    store.plannerSetOrder(date, priorityOrder(lines, map)); return { sorted: lines.length };
  }
  async function ack(itemId) { // accept what changed: the snapshot becomes today's picture
    const lines = itemId ? [itemOr404(itemId)] : store.plannerItems(today(), W.addDays(today(), MAX_AHEAD_DAYS)).filter((l) => l.status === 'todo');
    const { map } = await liveMap(lines.filter((l) => l.taskId).map((l) => l.taskId), false);
    let n = 0; for (const l of lines) { const live = l.taskId && map.get(l.taskId); if (live && live.state) { store.planItemUpdate(l.id, { snap: snapOf(live) }); n++; } }
    return { accepted: n };
  }
  async function revise() {
    const b = await board(true);
    const changed = b.attention.filter((a) => a.kind === 'changed' || a.kind === 'done-in-ado' || a.kind === 'reassigned').length;
    store.revisionSet(b.today, b.inbox.length, changed);
    b.revision = store.revisionGet(b.today);
    return b;
  }

  // ---- topics and keyword search
  const cleanKeyword = (k) => { const s = String(k || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim(); if (s.length < 2 || s.length > 60) throw err(400, 'A topic is 2 to 60 characters.'); return s; };
  function addTopic(keyword, by) {
    const k = cleanKeyword(keyword); const r = store.topicAdd(k, by, 20);
    if (r.full) throw err(409, 'You can keep at most 20 topics. Remove one first.');
    if (r.exists) throw err(409, 'That topic is already on the list.');
    return { id: r.id, keyword: k };
  }
  function removeTopic(id) { if (!store.topicRemove(id)) throw err(404, 'That topic does not exist.'); return { ok: true }; }
  async function search(q) { // an ad-hoc search: nothing is saved
    const k = cleanKeyword(q);
    const hits = await deps.searchTopics([k], true);
    const t0 = today(); const scheduled = store.plannerScheduledIds(t0); const delegated = new Set(store.delegationList('open').map((d) => d.taskId)); const later = new Set(store.laterList().map((l) => l.task_id));
    return { keyword: k, items: hits.map((t) => ({ id: t.id, type: t.type, title: t.title, state: t.state, priority: t.priority, assignedTo: t.assignedTo || '', url: t.url, planned: scheduled.has(t.id), delegated: delegated.has(t.id), later: later.has(t.id) })) };
  }

  function cleanPerson(p) { const s = String(p || '').replace(/\s+/g, ' ').trim(); if (s.length < 2 || s.length > 80) throw err(400, 'Name the person (2 to 80 characters).'); return s; }
  async function delegate(o, by) {
    const t = await itemFor(o.taskId);
    const mode = o.mode === 'monitor' || o.mode === 'fire_and_forget' ? o.mode : null;
    if (!mode) throw err(400, 'Choose Monitor or Fire and forget.');
    const person = cleanPerson(o.person);
    const t0 = today();
    const every = mode === 'monitor' ? Math.min(30, Math.max(1, Number(o.checkEveryDays) || P.monitorEveryDays)) : null;
    const wake = mode === 'fire_and_forget' ? Math.min(120, Math.max(1, Number(o.wakeAfterDays) || P.wakeAfterWorkingDays)) : null;
    if (o.expectBy) { if (!W.valid(o.expectBy)) throw err(400, 'The expected date is not valid.'); }
    const id = store.delegationAdd({ taskId: o.taskId, person, mode, note: String(o.note || '').trim().slice(0, 500), expectBy: o.expectBy || null, checkEveryDays: every, wakeAfterDays: wake,
      nextCheck: mode === 'monitor' ? W.addWorkingDays(t0, every, P.workingDays) : null, lastSeen: snapOf(t), createdAt: deps.today ? t0 + 'T12:00:00.000Z' : undefined }, by);
    if (id === null) throw err(409, 'This item is already delegated.');
    // its open plan lines are closed as dropped, so the day score is not penalised
    for (const l of store.plannerItems(t0, W.addDays(t0, MAX_AHEAD_DAYS))) if (l.taskId === o.taskId && l.status === 'todo') store.planItemUpdate(l.id, { status: 'skipped', skipReason: 'Delegated to ' + person + ' (' + (mode === 'monitor' ? 'monitor' : 'fire and forget') + ')' });
    store.laterRemove(o.taskId);
    return { id };
  }
  const openDelegation = (id) => { const d = store.delegationGet(id); if (!d) throw err(404, 'That delegation does not exist.'); if (d.status !== 'open') throw err(409, 'That delegation is closed.'); return d; };
  async function check(id, nextInDays, note) {
    const d = openDelegation(id); if (d.mode !== 'monitor') throw err(409, 'Only monitored items have checks.');
    const t = (await liveMap([d.taskId], false)).map.get(d.taskId);
    const n = Math.min(30, Math.max(1, Number(nextInDays) || d.checkEveryDays || P.monitorEveryDays));
    store.delegationUpdate(id, { nextCheck: W.addWorkingDays(today(), n, P.workingDays), lastSeen: t && t.state ? snapOf(t) : d.lastSeen });
    store.eventAdd(id, 'checked', (note ? String(note).slice(0, 300) + '. ' : '') + 'Next check in ' + n + ' working day' + (n > 1 ? 's' : ''));
    return { nextCheck: W.addWorkingDays(today(), n, P.workingDays) };
  }
  async function setMode(id, mode, o) {
    const d = openDelegation(id);
    if (mode !== 'monitor' && mode !== 'fire_and_forget') throw err(400, 'Choose Monitor or Fire and forget.');
    if (d.mode === mode) return { mode };
    const t = (await liveMap([d.taskId], false)).map.get(d.taskId);
    if (mode === 'monitor') { const every = Math.min(30, Math.max(1, Number(o && o.checkEveryDays) || P.monitorEveryDays)); store.delegationUpdate(id, { mode, checkEveryDays: every, nextCheck: W.addWorkingDays(today(), every, P.workingDays), wakeAfterDays: null, lastSeen: t && t.state ? snapOf(t) : d.lastSeen }); }
    else store.delegationUpdate(id, { mode, checkEveryDays: null, nextCheck: null, wakeAfterDays: Math.min(120, Math.max(1, Number(o && o.wakeAfterDays) || P.wakeAfterWorkingDays)) });
    store.eventAdd(id, 'mode changed', d.mode + ' to ' + mode);
    return { mode };
  }
  function closeDelegation(id, reason, note, by) {
    openDelegation(id);
    if (!REASONS.includes(reason)) throw err(400, 'Choose a reason: ' + REASONS.join(', ') + '.');
    store.delegationClose(id, by, reason + (note ? ': ' + String(note).slice(0, 300) : '')); return { ok: true };
  }
  async function takeBack(id, to, by) {
    const d = openDelegation(id);
    if (to && to !== 'inbox') { if (to !== 'later') checkDate(to); }
    store.delegationClose(id, by, 'Taken back');
    store.eventAdd(id, 'taken back', to && to !== 'inbox' ? 'planned for ' + to : 'back in Inbox');
    if (to && to !== 'inbox') await schedule(d.taskId, to, by);
    return { ok: true };
  }
  async function addCheckin(id, date) {
    const d = openDelegation(id); const day = date || today(); checkDate(day);
    const t = (await liveMap([d.taskId], false)).map.get(d.taskId);
    const r = store.plannerAdd(day, today(), d.taskId, 'Check on #' + d.taskId + (t && t.title ? ': ' + t.title : '') + ' (delegated to ' + d.person + ')', t && t.state ? snapOf(t) : null);
    if (r.existing) throw err(409, 'A line for this item is already planned for ' + r.existing.date + '.');
    return { id: r.id, date: day };
  }
  async function recordReassigned(taskId, person, by) { // "No longer yours": record who has it now
    return delegate({ taskId, person: person || '', mode: 'monitor' }, by);
  }
  function history(id) { return store.eventList(id, 50); }

  return { addTopic, removeTopic, search, board, schedule, move, unschedule, park, bringToToday, sortDay, ack, revise, delegate, check, setMode, closeDelegation, takeBack, addCheckin, recordReassigned, history };
}

module.exports = { create, snapOf, changesOf, notMine, delegationFlags, inboxOf, priorityOrder, columnDates, columnLabel, isDone, DONE_STATES, REASONS, MAX_AHEAD_DAYS };
