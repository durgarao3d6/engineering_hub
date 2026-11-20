/* Work planner page. Loaded after app.js; shares S, $, esc, api, toast, openDialog, badge, ago, full, openTask, STATE_KIND. */
'use strict';
S.pl = { data: null, loading: false, err: '', lane: 'monitor', drag: null, search: null, busyAuto: false };
const PL_REASONS = ['Done', 'Cancelled', 'Other'];
const plToday = () => (S.pl.data && S.pl.data.today) || new Date().toLocaleDateString('en-CA');
const priChip = (p) => (p ? '<span class="pri p' + p + '" title="Priority ' + p + '">P' + p + '</span>' : '');
const plChangeText = (c) => (c.kind === 'priority' ? 'Priority P' + (c.from || '-') + ' to P' + (c.to || '-') : c.kind === 'state' ? 'State ' + c.from + ' to ' + c.to : c.kind === 'assignee' ? 'Assigned ' + (c.from || 'nobody') + ' to ' + (c.to || 'nobody') : 'Title changed');

async function loadPlanner(silent) {
  const p = S.pl; if (p.loading) return; p.loading = true; p.err = '';
  if (!silent) render();
  try { p.data = await api('/api/planner'); S.pl.revisedToday = !!p.data.revision; }
  catch (e) { p.err = e.message; }
  p.loading = false;
  render();
  // the first time you open the planner each day it revises by itself (it only reads and flags; nothing is moved)
  if (!p.err && p.data && !p.data.revision && !p.busyAuto && S.view === 'planner') { p.busyAuto = true; try { p.data = await api('/api/planner/revise', { body: {} }); } catch (e) { /* the button is still there */ } p.busyAuto = false; render(); }
}
async function plAct(path, body, msg) { // one write, then refresh the board; Today's plan is reloaded the next time it is shown
  try { const r = await api(path, { body: body || {} }); S.plan = null; if (msg) toast(msg); await loadPlanner(true); return r; }
  catch (e) { toast(e.message, { bad: true }); return null; }
}

/* ---------- cards ---------- */
function plTaskLine(t, taskId) {
  if (!t) return '<span class="muted">#' + taskId + ' could not be read just now</span>';
  return '<a class="tlink" href="#" data-open="' + t.id + '">#' + t.id + '</a> ' + esc(t.title || '') + (typeof cwBadge === 'function' ? ' ' + cwBadge(t.id) : '');
}
function lineCard(c) {
  const t = c.task; const done = c.status !== 'todo';
  const flags = (c.closedInAdo ? badge('Done in Azure DevOps', 'ok') : '') + (c.notMine ? badge('Now ' + esc(t && t.assignedTo), 'warn') : '') + (c.changes || []).map((x) => '<span class="chg" title="Changed in Azure DevOps since you planned it">' + esc(plChangeText(x)) + '</span>').join('');
  return '<div class="pl-card' + (done ? ' done' : '') + '" draggable="' + (done ? 'false' : 'true') + '" data-line="' + c.id + '">'
    + '<div class="pl-t">' + (c.taskId ? plTaskLine(t, c.taskId) : esc(c.text)) + '</div>'
    + '<div class="pl-m">' + (t ? typeBadge(t.type) + priChip(t.priority) + badge(t.state, STATE_KIND[t.state] || 'neu') : badge(c.kind, 'neu')) + flags + (c.status === 'done' ? badge('Done', 'ok') : c.status === 'skipped' ? '<span class="muted">' + esc(c.skipReason || 'Dropped') + '</span>' : '') + '</div>'
    + (done ? '' : '<div class="pl-a"><button type="button" class="linkbtn" data-pl-move="' + c.id + '">Move to…</button>'
      + (c.taskId ? '<button type="button" class="linkbtn" data-pl-delegate="' + c.taskId + '">Delegate…</button>' : '')
      + '<button type="button" class="linkbtn" data-pl-done="' + c.id + '">Done</button>'
      + (c.ask ? '<button type="button" class="linkbtn" data-pl-park="' + c.id + '" title="Take it off the day while you wait for the answer">Park</button>' : '')
      + (c.changes && c.changes.length ? '<button type="button" class="linkbtn" data-pl-ack="' + c.id + '">Accept change</button>' : '')
      + '<button type="button" class="linkbtn danger" data-pl-remove="' + c.id + '">Remove</button></div>') + '</div>';
}
function taskCard(t, extra) { // a work item that is not on a day yet (Inbox, topics, Later)
  return '<div class="pl-card" draggable="true" data-task="' + t.id + '">'
    + '<div class="pl-t"><a class="tlink" href="#" data-open="' + t.id + '">#' + t.id + '</a> ' + esc(t.title || '') + '</div>'
    + '<div class="pl-m">' + typeBadge(t.type) + priChip(t.priority) + badge(t.state || '', STATE_KIND[t.state] || 'neu') + (extra || '') + '</div>'
    + '<div class="pl-a"><button type="button" class="linkbtn" data-pl-plan="' + t.id + '">Plan on…</button><button type="button" class="linkbtn" data-pl-delegate="' + t.id + '">Delegate…</button></div></div>';
}

/* ---------- page ---------- */
function attentionHtml(d) {
  const groups = []; const byTask = new Map();
  for (const a of d.attention) { if (!a.taskId) { groups.push({ taskId: null, title: '', list: [a] }); continue; } let g = byTask.get(a.taskId); if (!g) { g = { taskId: a.taskId, title: a.title || '', list: [] }; byTask.set(a.taskId, g); groups.push(g); } g.list.push(a); }
  const rowOf = (a, grouped) => {
    const btn = (k, v, label) => '<button type="button" class="linkbtn" data-' + k + '="' + v + '">' + label + '</button>';
    let acts = '';
    if (a.kind === 'done-in-ado') acts = btn('pl-done', a.itemId, 'Mark done') + btn('pl-remove', a.itemId, 'Remove from plan');
    else if (a.kind === 'reassigned') acts = btn('pl-reassigned', a.taskId, 'Record as delegation') + btn('pl-remove', a.itemId, 'Remove from plan');
    else if (a.kind === 'changed') acts = btn('pl-ack', a.itemId, 'Accept');
    else if (a.kind === 'ask-replied') acts = btn('cw', 'close', 'Got it, close').replace('data-cw="close"', 'data-cw="close" data-id="' + a.askId + '"') + btn('cw-plan', a.taskId, 'Plan today');
    else if (a.kind === 'ask-nudge') acts = '<button type="button" class="linkbtn" data-cw="snooze" data-id="' + a.askId + '">Snooze 2 days</button><button type="button" class="linkbtn" data-cw="close" data-id="' + a.askId + '">Close</button>' + btn('cw-plan', a.taskId, 'Plan today');
    else if (a.delegationId) acts = btn('pl-checked', a.delegationId, 'Checked…') + btn('pl-close', a.delegationId, 'Close…') + btn('pl-takeback', a.delegationId, 'Take back…');
    return '<li><span class="a-k">' + esc({ 'done-in-ado': 'Finished', reassigned: 'Reassigned', changed: 'Changed', 'check-overdue': 'Check due', 'ado-changed': 'Changed', quiet: 'Quiet', 'ready-to-close': 'Ready to close', 'back-to-me': 'Back to you', woke: 'Still open', 'expect-overdue': 'Slipped past its date', inbox: 'Inbox', 'topic-hits': 'Topics', 'ask-replied': 'Replied', 'ask-nudge': 'Nudge due' }[a.kind] || a.kind) + '</span> '
      + '<span class="a-t">' + (a.taskId && !grouped ? '<a class="tlink" href="#" data-open="' + a.taskId + '">#' + a.taskId + '</a> ' + esc((a.title || '').slice(0, 70)) + ': ' : '') + esc(a.text) + '</span><span class="pl-aa">' + acts + '</span>';
  };
  const rows = groups.map((g) => (g.list.length === 1 ? '<li>' + rowOf(g.list[0], false) + '</li>' : '<li class="pl-grp"><a class="tlink" href="#" data-open="' + g.taskId + '">#' + g.taskId + '</a> ' + esc((g.title || '').slice(0, 70)) + '<ul>' + g.list.map((a) => '<li>' + rowOf(a, true) + '</li>').join('') + '</ul></li>')).join('');
  const n = groups.length;
  return '<div class="card pl-attn"><div class="hd"><h3>Needs your attention ' + (n ? badge(String(n), 'warn') : '') + '</h3></div>'
    + (rows ? '<ul>' + rows + '</ul>' : '<div class="muted" style="padding:6px 16px 14px">All clear. Nothing needs you right now.</div>') + '</div>';
}
function waitingHtml(d) { // items you parked because you are waiting for an answer: not on a day, not in the Inbox
  if (!d.waiting || !d.waiting.length) return '';
  return '<div class="card pl-wait"><div class="hd"><h3>Waiting on others ' + badge(String(d.waiting.length), 'neu') + '</h3><span class="muted">They come back as an alert when someone answers or the nudge date arrives.</span></div><ul>'
    + d.waiting.map((w) => '<li><a class="tlink" href="#" data-open="' + w.taskId + '">#' + w.taskId + '</a> ' + esc(((w.task && w.task.title) || '').slice(0, 70)) + ' <span class="muted">' + (w.person ? 'asked ' + esc(w.person) + ': ' : '') + esc(w.question.slice(0, 80)) + ' · nudge ' + esc(w.nudgeAt) + '</span><span class="pl-aa"><button type="button" class="linkbtn" data-cw="close" data-id="' + w.askId + '">Close ask</button></span></li>').join('') + '</ul></div>';
}
function inboxColumn(d) {
  const p = S.pl; const s = p.search;
  const topics = (d.topics || []).map((t) => '<span class="chip">' + esc(t.keyword) + (t.hits !== undefined ? ' <b>' + t.hits + '</b>' : '') + ' <button type="button" class="x" data-pl-topic-del="' + t.id + '" aria-label="Remove topic ' + esc(t.keyword) + '" title="Remove this topic">×</button></span>').join('');
  let h = '<div class="pl-col pl-inbox" data-drop="inbox"><div class="pl-ch"><b>Inbox</b><span class="muted">' + d.inbox.length + ' assigned to you</span></div>'
    + d.inbox.map((t) => taskCard(t)).join('') + (d.inbox.length ? '' : '<div class="muted pl-empty">Everything assigned to you is planned.</div>')
    + '<div class="pl-sec"><b>Topics you cover</b><div class="muted">Open items whose title or tags contain a topic, assigned to anyone or nobody.</div>'
    + '<form class="pl-form" data-pl-form="topic"><input name="keyword" maxlength="60" placeholder="Add a topic, e.g. a module name" aria-label="New topic"><button class="btn sm" type="submit">Add</button></form>'
    + '<div class="chips">' + (topics || '<span class="muted">No topics yet.</span>') + '</div>' + (d.topicError ? '<div class="note warn">The topic search failed: ' + esc(d.topicError) + '</div>' : '')
    + (d.topicInbox || []).map((t) => taskCard(t, (t.assignedTo ? badge(t.assignedTo, 'neu') : badge('Unassigned', 'warn')) + (t.matched || []).map((m) => '<span class="chip">' + esc(m) + '</span>').join(''))).join('') + '</div>'
    + '<div class="pl-sec"><b>Search</b><form class="pl-form" data-pl-form="search"><input name="q" maxlength="60" value="' + esc((s && s.q) || '') + '" placeholder="Find open items by keyword" aria-label="Search work items"><button class="btn sm" type="submit">Search</button></form>'
    + (s ? (s.busy ? '<div class="muted">Searching…</div>' : s.error ? '<div class="note bad">' + esc(s.error) + '</div>' : '<div class="muted">' + s.items.length + ' open item(s) for “' + esc(s.q) + '” <button type="button" class="linkbtn" data-pl-topic-add="' + esc(s.q) + '">Add as topic</button> <button type="button" class="linkbtn" data-pl-search-clear="1">Clear</button></div>'
      + s.items.map((t) => (t.planned || t.delegated || t.later ? '<div class="pl-card dim"><div class="pl-t"><a class="tlink" href="#" data-open="' + t.id + '">#' + t.id + '</a> ' + esc(t.title) + '</div><div class="pl-m">' + badge(t.planned ? 'Already planned' : t.delegated ? 'Delegated' : 'In Later', 'ok') + '</div></div>'
        : taskCard(t, (t.assignedTo ? badge(t.assignedTo, 'neu') : badge('Unassigned', 'warn'))))).join('')) : '') + '</div></div>';
  return h;
}
function dayColumn(day, d) {
  return '<div class="pl-col' + (day.weekend ? ' weekend' : '') + '" data-drop="' + day.date + '"><div class="pl-ch"><b>' + esc(day.label) + '</b><span class="muted">' + esc(day.date.slice(5)) + '</span>'
    + '<span class="cap' + (day.over ? ' over' : '') + '" title="Open lines against your day capacity of ' + d.capacity + '">' + day.open + '/' + d.capacity + '</span>'
    + (day.open > 1 ? '<button type="button" class="linkbtn" data-pl-sort="' + day.date + '" title="Order this day by priority">Sort</button>' : '') + '</div>'
    + day.items.map(lineCard).join('') + (day.items.length ? '' : '<div class="muted pl-empty">Nothing planned.</div>') + '</div>';
}
function laterColumn(d) {
  return '<div class="pl-col" data-drop="later"><div class="pl-ch"><b>Later</b><span class="muted">' + (d.later.length + d.beyond.length) + '</span></div>'
    + d.later.map((l) => (l.task ? taskCard(l.task, l.closedInAdo ? badge('Done in Azure DevOps', 'ok') : '') : '<div class="pl-card dim">#' + l.taskId + ' could not be read</div>')).join('')
    + d.beyond.map(lineCard).map((x, i) => x.replace('<div class="pl-m">', '<div class="pl-m"><span class="chip">' + esc(d.beyond[i].date) + '</span>')).join('')
    + (d.later.length + d.beyond.length ? '' : '<div class="muted pl-empty">Park items here to decide later.</div>') + '</div>';
}
function lanesHtml(d) {
  const p = S.pl; const D = d.delegations;
  const tab = (k, label, n) => '<button type="button" data-pl-lane="' + k + '" aria-pressed="' + (p.lane === k) + '">' + label + ' (' + n + ')</button>';
  let body = '';
  if (p.lane === 'monitor') {
    body = D.monitor.map((x) => delegCard(x)).join('') || '<div class="muted pl-empty">Nothing is being monitored. Use Delegate… on any item and choose Monitor.</div>';
  } else if (p.lane === 'ff') {
    body = (D.fireAndForget.map((x) => delegRow(x)).join('')) || '<div class="muted pl-empty">No fire and forget hand-overs.</div>';
  } else {
    body = D.closed.map((x) => '<div class="pl-row"><span><a class="tlink" href="#" data-open="' + x.taskId + '">#' + x.taskId + '</a> ' + esc(x.person) + ' · ' + esc(x.mode === 'monitor' ? 'monitored' : 'fire and forget') + '</span><span class="muted">' + esc(x.closedReason || '') + ' · ' + esc(ago(x.closedAt)) + '</span></div>').join('') || '<div class="muted pl-empty">Nothing closed yet.</div>';
  }
  return '<div class="card pl-lanes"><div class="hd" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px"><h3 style="margin:0">Delegated</h3><div class="seg" role="group" aria-label="Delegation lane">' + tab('monitor', 'Monitor', D.monitor.length) + tab('ff', 'Fire and forget', D.fireAndForget.length) + tab('closed', 'Closed', D.closed.length) + '</div></div><div class="pl-lb">' + body + '</div></div>';
}
function flagChips(x) { return (x.flags || []).map((f) => '<span class="chg' + (f.soft ? ' soft' : '') + '">' + esc(f.text) + '</span>').join(''); }
function delegCard(x) {
  const t = x.task;
  return '<div class="pl-dcard"><div class="pl-t">' + plTaskLine(t, x.taskId) + '</div>'
    + '<div class="pl-m">' + badge('with ' + x.person, 'info') + (t ? badge(t.state, STATE_KIND[t.state] || 'neu') + priChip(t.priority) : '') + '<span class="muted">since ' + esc(ago(x.createdAt)) + (t && t.changedDate ? ' · last change in Azure DevOps ' + esc(ago(t.changedDate)) : '') + '</span></div>'
    + '<div class="pl-m"><span class="muted">Next check ' + esc(x.nextCheck || '-') + (x.expectBy ? ' · expected by ' + esc(x.expectBy) : '') + '</span>' + flagChips(x) + '</div>' + (x.note ? '<div class="muted pl-note">' + esc(x.note) + '</div>' : '')
    + '<div class="pl-a"><button type="button" class="linkbtn" data-pl-checked="' + x.id + '">Checked…</button><button type="button" class="linkbtn" data-pl-checkin="' + x.id + '">Add check-in to today</button>'
    + '<button type="button" class="linkbtn" data-pl-mode="' + x.id + ':fire_and_forget">Make fire and forget</button><button type="button" class="linkbtn" data-pl-history="' + x.id + '">History</button>'
    + '<button type="button" class="linkbtn" data-pl-takeback="' + x.id + '">Take back…</button><button type="button" class="linkbtn danger" data-pl-close="' + x.id + '">Close…</button></div></div>';
}
function delegRow(x) {
  const t = x.task;
  return '<div class="pl-row"><span>' + plTaskLine(t, x.taskId) + ' <span class="muted">with ' + esc(x.person) + ' · since ' + esc(ago(x.createdAt)) + (t ? ' · ' + esc(t.state) : '') + '</span>' + flagChips(x) + '</span>'
    + '<span class="pl-a"><button type="button" class="linkbtn" data-pl-mode="' + x.id + ':monitor">Make monitor</button><button type="button" class="linkbtn" data-pl-takeback="' + x.id + '">Take back…</button><button type="button" class="linkbtn danger" data-pl-close="' + x.id + '">Close…</button></span></div>';
}
function renderPlanner() {
  const p = S.pl; const box = $('plannerBody'); const d = p.data;
  if (!d) { box.innerHTML = p.err ? errorBar({ title: 'The planner didn\'t load.', detail: p.err, retry: 'planner' }) : skeleton('list', 3) + skeleton('cards', 3); return; }
  const a = document.activeElement; if (a && box.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.value) return; // do not wipe what you are typing
  const rev = d.revision ? 'Revised today at ' + new Date(d.revision.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Not revised today';
  let h = '<div class="toolbar"><span class="muted">' + esc(rev) + ' · ' + esc(d.ado && d.ado.ok === false ? (d.ado.notConfigured ? 'Azure DevOps is not set up' : 'Azure DevOps data is unavailable') : 'latest fetch from Azure DevOps') + '</span><span style="flex:1"></span>'
    + (d.earlier.length ? '<button type="button" class="btn sm" data-pl-bring="1">Bring ' + d.earlier.length + ' unfinished to today</button>' : '')
    + (d.attention.some((x) => x.kind === 'changed') ? '<button type="button" class="btn sm" data-pl-ack-all="1">Accept all changes</button>' : '')
    + '<span class="pl-scroll" role="group" aria-label="Scroll the board"><button type="button" class="btn sm" data-pl-scroll="-1" aria-label="Scroll the board left" title="Scroll left">‹</button><button type="button" class="btn sm" data-pl-scroll="1" aria-label="Scroll the board right" title="Scroll right">›</button></span>'
    + '<button type="button" class="btn sm" data-plai-open="1" title="Read the descriptions and discussions of your unplanned items and propose where each belongs">Plan with AI…</button>'
    + '<button type="button" class="btn sm primary" data-pl-revise="1">Revise now</button></div>';
  if (d.ado && d.ado.ok === false) h += d.ado.notConfigured ? errorBar({ kind: 'info', title: 'Azure DevOps is not set up, so the Inbox is empty.', detail: 'Planned lines and delegations still work.' }) : errorBar({ kind: 'azure', title: 'I can\'t reach Azure DevOps right now. Your plans and delegations are safe.', detail: d.ado.error || '', auth: d.ado.auth, retry: 'planner' });
  h += aiPanelHtml(d);
  h += attentionHtml(d) + waitingHtml(d);
  h += '<div class="pl-board">' + inboxColumn(d) + (d.earlier.length ? '<div class="pl-col earlier" data-drop="' + plToday() + '"><div class="pl-ch"><b>Earlier, unfinished</b><span class="muted">' + d.earlier.length + '</span></div>' + d.earlier.map(lineCard).join('') + '</div>' : '')
    + d.days.map((day) => dayColumn(day, d)).join('') + laterColumn(d) + '</div>' + lanesHtml(d);
  const keep = box.scrollLeft; const board0 = box.querySelector('.pl-board'); const bl = board0 ? board0.scrollLeft : 0;
  box.innerHTML = h; const board1 = box.querySelector('.pl-board'); if (board1) board1.scrollLeft = bl; box.scrollLeft = keep;
  $('navCountPlanner').textContent = d.counts.attentionItems || '';
  plRailSetup();
}
// A scroll bar that stays at the bottom of the window while the board is in view, however far down the board starts.
function plRailSetup() {
  const bd = $('plannerBody').querySelector('.pl-board'); if (!bd) return;
  const rail = document.createElement('div'); rail.className = 'pl-rail'; rail.innerHTML = '<div></div>'; bd.after(rail);
  const inner = rail.firstChild;
  const size = () => { inner.style.width = bd.scrollWidth + 'px'; rail.hidden = bd.scrollWidth <= bd.clientWidth + 1; rail.scrollLeft = bd.scrollLeft; };
  size();
  rail.addEventListener('scroll', () => { if (bd.scrollLeft !== rail.scrollLeft) bd.scrollLeft = rail.scrollLeft; });
  bd.addEventListener('scroll', () => { if (rail.scrollLeft !== bd.scrollLeft) rail.scrollLeft = bd.scrollLeft; });
  if (typeof ResizeObserver === 'function') new ResizeObserver(size).observe(bd);
}

/* ---------- dialogs ---------- */
function dayOptions(d, selected) {
  const opts = d.days.map((x) => '<option value="' + x.date + '"' + (x.date === selected ? ' selected' : '') + '>' + esc(x.label) + ' (' + esc(x.date) + ', ' + x.open + ' open)</option>').join('');
  return opts + '<option value="later"' + (selected === 'later' ? ' selected' : '') + '>Later (decide later)</option><option value="custom">Pick another date…</option>';
}
function pickDate(d) { const v = d.dayChoice; if (v === 'custom') return d.customDate; return v; }
function openPlanOn(taskId, lineId) {
  const d = S.pl.data;
  openDialog({ title: lineId ? 'Move to…' : 'Plan on…', ok: lineId ? 'Move' : 'Plan it',
    body: '<div class="field"><label for="f-day">Day</label><select id="f-day" name="dayChoice">' + dayOptions(d, d.days[0].date) + '</select></div><div class="field" id="customWrap" hidden><label for="f-cd">Date</label><input id="f-cd" name="customDate" type="date" min="' + plToday() + '"></div>',
    onOpen: () => { const sel = $('f-day'); sel.addEventListener('change', () => { $('customWrap').hidden = sel.value !== 'custom'; }); },
    submit: async (v) => {
      const date = pickDate(v); if (!date) { const e = new Error('Pick a date.'); e.fields = { customDate: e.message }; throw e; }
      const r = lineId ? await api('/api/planner/move', { body: { itemId: lineId, date } }) : await api('/api/planner/schedule', { body: { taskId, date } });
      void r; S.plan = null; await loadPlanner(true); toast(date === 'later' ? 'Parked in Later' : 'Planned for ' + date);
    } });
}
function openDelegate(taskId) {
  const d = S.pl.data; const s = d.settings;
  const known = [...(d.inbox || []), ...(d.topicInbox || [])].find((x) => x.id === taskId);
  openDialog({ title: 'Delegate #' + taskId, ok: 'Delegate',
    body: '<div class="note">The hub records this and watches it. It never changes Azure DevOps: reassign the item in Azure Boards yourself' + (S.me && S.me.adoConfigured && known && known.url ? ' (<a href="' + esc(known.url) + '" target="_blank" rel="noopener">open it</a>)' : '') + '.</div>'
      + '<div class="field"><label for="f-p">Who has it</label><input id="f-p" name="person" list="plPeople" maxlength="80" autocomplete="off" placeholder="Name"><datalist id="plPeople">' + (d.people || []).map((n) => '<option value="' + esc(n) + '">').join('') + '</datalist></div>'
      + '<div class="field"><label>Kind</label><div class="radios"><label><input type="radio" name="mode" value="monitor" checked> <b>Monitor</b> <span class="muted">I need to keep watching and act</span></label><label><input type="radio" name="mode" value="fire_and_forget"> <b>Fire and forget</b> <span class="muted">hand over; only wake me if it stays unfinished</span></label></div></div>'
      + '<div class="field" id="monOpts"><label for="f-ce">Check every (working days)</label><input id="f-ce" name="checkEveryDays" type="number" min="1" max="30" value="' + s.monitorEveryDays + '"><label for="f-eb" style="margin-top:8px">Expected by <span class="muted">(optional)</span></label><input id="f-eb" name="expectBy" type="date" min="' + plToday() + '"></div>'
      + '<div class="field" id="ffOpts" hidden><label for="f-wa">Wake me after (working days)</label><input id="f-wa" name="wakeAfterDays" type="number" min="1" max="120" value="' + s.wakeAfterWorkingDays + '"></div>'
      + '<div class="field"><label for="f-n">What you expect <span class="muted">(optional)</span></label><textarea id="f-n" name="note" maxlength="500" placeholder="For example: fix and open a PR by Friday"></textarea></div>',
    onOpen: () => { document.querySelectorAll('#dlgBody input[name=mode]').forEach((r) => r.addEventListener('change', () => { const m = document.querySelector('#dlgBody input[name=mode]:checked').value; $('monOpts').hidden = m !== 'monitor'; $('ffOpts').hidden = m !== 'fire_and_forget'; })); },
    submit: async (v) => {
      if (!String(v.person || '').trim()) { const e = new Error('Name the person.'); e.fields = { person: e.message }; throw e; }
      await api('/api/planner/delegate', { body: { taskId, person: v.person, mode: v.mode, note: v.note, expectBy: v.expectBy || null, checkEveryDays: Number(v.checkEveryDays) || undefined, wakeAfterDays: Number(v.wakeAfterDays) || undefined } });
      S.plan = null; await loadPlanner(true); toast('Delegated. Remember to reassign it in Azure Boards.');
    } });
}
function openChecked(id) {
  const x = [...S.pl.data.delegations.monitor].find((y) => y.id === id); if (!x) return;
  openDialog({ title: 'Checked on #' + x.taskId, ok: 'Save check',
    body: '<div class="field"><label for="f-nd">Next check in (working days)</label><input id="f-nd" name="nextInDays" type="number" min="1" max="30" value="' + (x.checkEveryDays || S.pl.data.settings.monitorEveryDays) + '"></div><div class="field"><label for="f-cn">Note <span class="muted">(optional)</span></label><textarea id="f-cn" name="note" maxlength="300" placeholder="What you heard"></textarea></div>',
    submit: async (v) => { await api('/api/planner/delegations/' + id + '/check', { body: { nextInDays: Number(v.nextInDays) || 1, note: v.note } }); await loadPlanner(true); toast('Checked'); } });
}
function openCloseDelegation(id) {
  openDialog({ title: 'Close this delegation', ok: 'Close it',
    body: '<div class="note">This only closes it in the hub. The work item in Azure DevOps is not changed.</div><div class="field"><label for="f-r">Why</label><select id="f-r" name="reason">' + PL_REASONS.map((r) => '<option>' + r + '</option>').join('') + '</select></div><div class="field"><label for="f-rn">Note <span class="muted">(optional)</span></label><input id="f-rn" name="note" maxlength="300"></div>',
    submit: async (v) => { await api('/api/planner/delegations/' + id + '/close', { body: { reason: v.reason, note: v.note } }); await loadPlanner(true); toast('Closed'); } });
}
function openTakeBack(id) {
  const d = S.pl.data;
  openDialog({ title: 'Take it back', ok: 'Take back',
    body: '<div class="field"><label for="f-tb">Where does it go</label><select id="f-tb" name="dayChoice"><option value="inbox">Inbox (decide later)</option>' + dayOptions(d, d.days[0].date) + '</select></div><div class="field" id="customWrap" hidden><label for="f-cd">Date</label><input id="f-cd" name="customDate" type="date" min="' + plToday() + '"></div>',
    onOpen: () => { const sel = $('f-tb'); sel.addEventListener('change', () => { $('customWrap').hidden = sel.value !== 'custom'; }); },
    submit: async (v) => { const to = v.dayChoice === 'custom' ? v.customDate : v.dayChoice; await api('/api/planner/delegations/' + id + '/take-back', { body: { to } }); S.plan = null; await loadPlanner(true); toast('Taken back'); } });
}
async function openHistory(id) {
  openDialog({ title: 'Delegation history', ok: 'Close', body: '<div id="plHist" class="muted">Loading…</div>', submit: async () => {} });
  try { const r = await api('/api/planner/delegations/' + id + '/history'); $('plHist').innerHTML = r.events.map((e) => '<div class="pl-row"><span><b>' + esc(e.kind) + '</b> ' + esc(e.detail || '') + '</span><span class="muted" title="' + esc(full(e.at)) + '">' + esc(ago(e.at)) + '</span></div>').join('') || 'No history.'; }
  catch (e) { $('plHist').innerHTML = '<div class="note bad">' + esc(e.message) + '</div>'; }
}

/* ---------- events ---------- */
(() => {
  const box = $('plannerBody');
  const lineOf = (id) => { const d = S.pl.data; return [...d.days.flatMap((x) => x.items), ...d.earlier, ...d.beyond].find((c) => c.id === id); };
  box.addEventListener('click', async (e) => {
    const a = e.target.closest('a[data-open]'); if (a) { e.preventDefault(); openTask(Number(a.dataset.open)); return; }
    const b = e.target.closest('button'); if (!b || !S.pl.data) return; const D = b.dataset; const n = (k) => Number(D[k]);
    if (D.plScroll) { const bd = box.querySelector('.pl-board'); if (bd) bd.scrollBy({ left: Number(D.plScroll) * Math.max(280, Math.round(bd.clientWidth * 0.7)) }); return; }
    if (D.plReload) return loadPlanner();
    if (D.plRevise !== undefined) { try { S.pl.data = await api('/api/planner/revise', { body: {} }); S.plan = null; render(); toast('Revised with the latest fetch'); } catch (err) { toast(err.message, { bad: true }); } return; }
    if (D.plBring !== undefined) return plAct('/api/planner/bring-to-today', {}, 'Moved to today');
    if (D.plAckAll !== undefined) return plAct('/api/planner/ack', {}, 'Changes accepted');
    if (D.plAck) return plAct('/api/planner/ack', { itemId: n('plAck') }, 'Change accepted');
    if (D.plMove) return openPlanOn(null, n('plMove'));
    if (D.plPlan) return openPlanOn(n('plPlan'), null);
    if (D.plDelegate) return openDelegate(n('plDelegate'));
    if (D.plDone) { const r = await plAct('/api/plan/items/' + n('plDone') + '/update', { status: 'done' }, 'Marked done'); return r; }
    if (D.plPark) return plAct('/api/planner/park', { itemId: n('plPark') }, 'Parked: it comes back when there is an answer');
    if (D.cwPlan) { const r = await plAct('/api/planner/schedule', { taskId: n('cwPlan'), date: plToday() }, 'Planned for today'); return r; }
    if (D.plRemove) return plAct('/api/planner/unschedule', { itemId: n('plRemove') }, 'Removed from the plan');
    if (D.plSort) return plAct('/api/planner/sort', { date: D.plSort }, 'Sorted by priority');
    if (D.plLane) { S.pl.lane = D.plLane; return renderPlanner(); }
    if (D.plChecked) return openChecked(n('plChecked'));
    if (D.plClose) return openCloseDelegation(n('plClose'));
    if (D.plTakeback) return openTakeBack(n('plTakeback'));
    if (D.plHistory) return openHistory(n('plHistory'));
    if (D.plCheckin) return plAct('/api/planner/delegations/' + n('plCheckin') + '/checkin', {}, 'Check-in added to today');
    if (D.plMode) { const [id, mode] = D.plMode.split(':'); return plAct('/api/planner/delegations/' + id + '/mode', { mode }, 'Changed'); }
    if (D.plReassigned) { const t = [...S.pl.data.days.flatMap((x) => x.items), ...S.pl.data.beyond].find((c) => c.taskId === n('plReassigned')); return plAct('/api/planner/reassigned', { taskId: n('plReassigned'), person: (t && t.task && t.task.assignedTo) || '' }, 'Recorded as a delegation you monitor'); }
    if (D.plTopicDel) return plAct('/api/planner/topics/' + n('plTopicDel') + '/remove', {}, 'Topic removed');
    if (D.plTopicAdd) return plAct('/api/planner/topics', { keyword: D.plTopicAdd }, 'Topic added');
    if (D.plSearchClear !== undefined) { S.pl.search = null; return renderPlanner(); }
  });
  box.addEventListener('submit', async (e) => {
    const f = e.target.closest('form[data-pl-form]'); if (!f) return; e.preventDefault();
    const v = Object.fromEntries(new FormData(f).entries());
    if (f.dataset.plForm === 'topic') return plAct('/api/planner/topics', { keyword: v.keyword }, 'Topic added');
    const q = String(v.q || '').trim(); if (q.length < 2) return toast('Type at least 2 characters', { bad: true });
    S.pl.search = { q, busy: true, items: [] }; renderPlanner();
    try { const r = await api('/api/planner/search', { body: { q } }); S.pl.search = { q, items: r.items }; } catch (err) { S.pl.search = { q, items: [], error: err.message }; }
    renderPlanner();
  });
  // drag and drop (the Move to… button does the same thing for the keyboard)
  box.addEventListener('dragstart', (e) => { const c = e.target.closest('.pl-card[draggable=true]'); if (!c) return; S.pl.drag = { line: c.dataset.line ? Number(c.dataset.line) : null, task: c.dataset.task ? Number(c.dataset.task) : null }; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', 'card'); } catch (x) { /* some browsers */ } c.classList.add('dragging'); });
  box.addEventListener('dragend', () => { S.pl.drag = null; box.querySelectorAll('.dragging,.over-drop').forEach((x) => x.classList.remove('dragging', 'over-drop')); });
  box.addEventListener('dragover', (e) => { // near the left or right edge of the board while dragging: the board scrolls by itself
    const bd = box.querySelector('.pl-board'); if (bd && S.pl.drag) { const r = bd.getBoundingClientRect(); if (e.clientX < r.left + 70) bd.scrollLeft -= 28; else if (e.clientX > r.right - 70) bd.scrollLeft += 28; }
    const col = e.target.closest('.pl-col[data-drop]'); if (!col || !S.pl.drag) return; if (col.dataset.drop === 'inbox') return; e.preventDefault(); box.querySelectorAll('.over-drop').forEach((x) => { if (x !== col) x.classList.remove('over-drop'); }); col.classList.add('over-drop'); });
  box.addEventListener('drop', async (e) => {
    const col = e.target.closest('.pl-col[data-drop]'); const dr = S.pl.drag; if (!col || !dr || col.dataset.drop === 'inbox') return; e.preventDefault();
    const date = col.dataset.drop; const cards = [...col.querySelectorAll('.pl-card[data-line]:not(.dragging)')];
    const at = cards.findIndex((c) => e.clientY < c.getBoundingClientRect().top + c.offsetHeight / 2); const position = at < 0 ? undefined : at + 1;
    S.pl.drag = null;
    if (dr.line) await plAct('/api/planner/move', { itemId: dr.line, date, position }, date === 'later' ? 'Parked in Later' : 'Moved to ' + date);
    else if (dr.task) await plAct('/api/planner/schedule', { taskId: dr.task, date }, date === 'later' ? 'Parked in Later' : 'Planned for ' + date);
  });
})();
if (S.view === 'planner') loadPlanner();

/* ---------- AI planning: it proposes, you apply ---------- */
const PLAI_GROUPS = [['needs-info', 'Needs information', 'Cannot start without an answer. Ask the question, then plan it.'], ['waiting', 'Waiting on someone', 'Blocked on a reply or action from someone else.'], ['fixed', 'Looks fixed already', 'The discussion says it is done. Check and close it in Azure Boards.'], ['delegate', 'Consider delegating', 'The text shows someone else owns it. Choose who, or leave it.'], ['later', 'Later', 'Does not fit the days offered.']];
const plaiOk = () => { try { return localStorage.getItem('plai-ok') === '1'; } catch (e) { return false; } };
const plaiRemember = () => { try { localStorage.setItem('plai-ok', '1'); } catch (e) { /* storage blocked */ } };
function plaiSelFor(it, days) {
  const day = it.where === 'day';
  return { on: day || it.where === 'later', where: it.where === 'fixed' || it.where === 'needs-info' || it.where === 'waiting' ? 'inbox' : it.where, date: it.date || days[0].date, person: '', kind: (it.analysis && it.analysis.delegateHint && it.analysis.delegateHint.kind) || 'monitor' };
}
function plaiRow(it, days) {
  const sel = S.pl.ai.sel[it.id]; const a = it.analysis;
  const opts = days.map((d) => '<option value="day:' + d.date + '"' + (sel.where === 'day' && sel.date === d.date ? ' selected' : '') + '>' + esc(d.label) + ' ' + esc(d.date.slice(5)) + '</option>').join('')
    + '<option value="later"' + (sel.where === 'later' ? ' selected' : '') + '>Later</option><option value="delegate"' + (sel.where === 'delegate' ? ' selected' : '') + '>Delegate…</option><option value="inbox"' + (sel.where === 'inbox' ? ' selected' : '') + '>Leave in Inbox</option>';
  return '<div class="pl-ai-row"><input type="checkbox" data-plai-on="' + it.id + '"' + (sel.on ? ' checked' : '') + ' aria-label="Include #' + it.id + '">'
    + '<div class="pl-ai-main"><div class="pl-t"><a class="tlink" href="#" data-open="' + it.id + '">#' + it.id + '</a> ' + esc(it.title || '') + '</div>'
    + '<div class="pl-m">' + badge(it.type || '', 'neu') + priChip(it.priority) + (a ? '<span class="chip" title="Estimated size">size ' + esc(a.size) + '</span>' + (a.urgency === 'high' || a.urgency === 'critical' ? badge(a.urgency, 'bad') : '') : '')
    + (it.owner ? badge(it.owner, 'neu') : badge('Unassigned', 'warn')) + (it.source === 'adjusted' ? '<span class="chg" title="The plan was corrected by the hub\'s rules">adjusted</span>' : it.source === 'rules' ? '<span class="chg soft">by priority</span>' : '') + '</div>'
    + '<div class="muted pl-note">' + esc(it.reason || '') + '</div>'
    + (a && a.summary ? '<div class="muted pl-note"><b>Read:</b> ' + esc(a.summary) + '</div>' : '')
    + (a && a.evidence ? '<div class="muted pl-note"><i>“' + esc(a.evidence) + '”</i></div>' : '')
    + (sel.where === 'delegate' ? '<div class="pl-form"><input data-plai-person="' + it.id + '" value="' + esc(sel.person) + '" placeholder="Who has it" list="plPeople" maxlength="80"><select data-plai-kind="' + it.id + '"><option value="monitor"' + (sel.kind === 'monitor' ? ' selected' : '') + '>Monitor</option><option value="fire_and_forget"' + (sel.kind === 'fire_and_forget' ? ' selected' : '') + '>Fire and forget</option></select></div>' : '') + '</div>'
    + '<select class="pl-ai-dest" data-plai-dest="' + it.id + '" aria-label="Where #' + it.id + ' goes">' + opts + '</select></div>';
}
function aiPanelHtml(d) {
  const ai = S.pl.ai; if (!ai) return '';
  if (ai.busy) return '<div class="card pl-ai"><div class="hd"><h3>AI planning</h3><p class="muted">' + esc(ai.busy) + '</p></div><div class="skel" style="height:60px;margin:0 16px 16px"></div></div>';
  if (!ai.run) return '';
  const r = ai.run; const days = r.days;
  const inGroup = (w) => r.items.filter((i) => i.where === w);
  const sections = days.map((dy) => { const rows = r.items.filter((i) => i.where === 'day' && i.date === dy.date); return rows.length ? '<div class="pl-ai-sec"><b>' + esc(dy.label) + '</b> <span class="muted">' + esc(dy.date) + ' · ' + rows.length + ' of ' + (dy.room) + ' free</span>' + rows.map((i) => plaiRow(i, days)).join('') + '</div>' : ''; }).join('')
    + PLAI_GROUPS.map(([k, label, hint]) => { const rows = inGroup(k); return rows.length ? '<div class="pl-ai-sec"><b>' + label + '</b> <span class="muted">' + rows.length + ' · ' + esc(hint) + '</span>' + rows.map((i) => plaiRow(i, days)).join('') + '</div>' : ''; }).join('');
  const chosen = r.items.filter((i) => ai.sel[i.id] && ai.sel[i.id].on).length;
  return '<div class="card pl-ai"><div class="hd" style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center"><div><h3 style="margin:0">Proposed plan ' + badge(r.engine === 'ai' ? 'AI' : 'By priority', r.engine === 'ai' ? 'info' : 'neu') + '</h3>'
    + '<p class="muted" style="margin:4px 0 0">' + r.items.length + ' items · ' + (r.usage && r.usage.usd ? 'cost about $' + r.usage.usd.toFixed(3) + ' · ' : '') + 'nothing is planned until you press Apply.</p></div>'
    + '<span><button type="button" class="btn sm" data-plai-all="1">Select all</button> <button type="button" class="btn sm" data-plai-none="1">Select none</button> <button type="button" class="btn sm" data-plai-discard="1">Discard</button> <button type="button" class="btn sm primary" data-plai-apply="1"' + (chosen ? '' : ' disabled') + '>Apply ' + chosen + ' selected</button></span></div>'
    + (r.notes && r.notes.length ? r.notes.map((n) => '<div class="note warn" style="margin:8px 16px 0">' + esc(n) + '</div>').join('') : '')
    + '<div class="pl-ai-body">' + sections + '</div></div>';
}
function plaiOpen() {
  const first = !plaiOk();
  openDialog({ title: 'Plan with AI', ok: 'Read the items',
    body: '<div class="note">The assistant reads each unplanned item\'s <b>description and discussion</b> and proposes a day, a size and what is blocking it. It only proposes: nothing is planned until you press Apply. It never changes Azure DevOps.</div>'
      + '<div class="field"><label for="f-sc">Which items</label><select id="f-sc" name="scope"><option value="assigned+topics">Assigned to you, plus your topics</option><option value="assigned">Assigned to you only</option></select></div>'
      + '<div class="field"><label for="f-dy">Days to fill</label><input id="f-dy" name="days" type="number" min="1" max="10" value="5"><div class="hint"><span>Working days from today, up to each day\'s free room.</span></div></div>'
      + '<div class="field"><label for="f-mx">At most this many items</label><input id="f-mx" name="maxItems" type="number" min="1" max="60" value="30"></div>'
      + '<div class="field"><label><input type="checkbox" name="includeDiscussion" value="1" checked> Include the discussion (comments)</label></div>'
      + (first ? '<div class="note warn"><label><input type="checkbox" name="ack" value="1"> I understand that the text of these work items and their discussion is sent to Claude, using my own login.</label></div>' : ''),
    submit: async (v) => {
      if (first && !v.ack) { const e = new Error('Tick the box to continue.'); e.fields = { ack: e.message }; throw e; }
      const est = await api('/api/planner/ai/estimate', { body: { scope: v.scope, days: Number(v.days) || 5, maxItems: Number(v.maxItems) || 30, includeDiscussion: !!v.includeDiscussion } });
      plaiRemember(); setTimeout(() => plaiConfirm(est), 50);
    } });
}
function plaiConfirm(est) {
  openDialog({ title: 'Ready to plan ' + est.items + ' items', ok: est.toAnalyse ? 'Run AI planning' : 'Run AI planning (no new reading needed)',
    body: '<div class="sum"><div class="cell-main">' + est.items + ' items · ' + est.toAnalyse + ' to read · ' + est.cached + ' already read before</div><div class="cell-sub">Days offered: ' + est.days.map((x) => esc(x.label) + ' (' + x.room + ' free)').join(', ') + '</div>'
      + '<div class="cell-sub">Discussion: ' + (est.includeDiscussion ? 'included' : 'not included') + ' · about ' + Math.round(est.charsToSend / 1000) + ' thousand characters to send</div><div class="cell-sub">Estimated cost: about <b>$' + est.estimatedUsd.toFixed(3) + '</b> (' + esc(est.models.analyse) + ' reads, ' + esc(est.models.arrange) + ' arranges). Only changed items are read again next time.</div></div>'
      + (est.problems && est.problems.length ? '<div class="note warn">' + est.problems.slice(0, 3).map(esc).join('<br>') + '</div>' : '')
      + '<div class="muted" style="margin-top:8px">No tokens? Plan by priority only: fills the days with your P1 items first. <button type="button" class="linkbtn" id="plaiPrio">Plan by priority only</button></div>',
    onOpen: () => { $('plaiPrio').addEventListener('click', () => { dlg.close(); plaiRun(est, 'priority'); }); },
    submit: async () => { setTimeout(() => plaiRun(est, 'ai'), 50); } });
}
async function plaiRun(est, mode) {
  S.pl.ai = { busy: mode === 'ai' ? 'Reading the items and arranging the days… (about 20 to 60 seconds)' : 'Planning by priority…', sel: {} }; renderPlanner();
  try {
    const run = await api('/api/planner/ai/run', { body: { runId: est.runId, mode } });
    const sel = {}; run.items.forEach((i) => { sel[i.id] = plaiSelFor(i, run.days); });
    S.pl.ai = { run, sel, estRunId: est.runId };
  } catch (e) { S.pl.ai = null; toast(e.message, { bad: true }); }
  renderPlanner();
}
async function plaiApply() {
  const ai = S.pl.ai; if (!ai || !ai.run) return;
  const picks = []; let missing = null;
  for (const it of ai.run.items) {
    const s = ai.sel[it.id]; if (!s || !s.on || s.where === 'inbox') continue;
    if (s.where === 'delegate' && !String(s.person || '').trim()) { missing = it; break; }
    picks.push({ id: it.id, where: s.where, date: s.where === 'day' ? s.date : undefined, person: s.where === 'delegate' ? s.person : undefined, kind: s.where === 'delegate' ? s.kind : undefined });
  }
  if (missing) return toast('Name who has #' + missing.id + ' or change where it goes.', { bad: true });
  if (!picks.length) return toast('Nothing selected.', { bad: true });
  try {
    const r = await api('/api/planner/ai/apply', { body: { runId: ai.estRunId, picks } });
    S.pl.ai = null; S.plan = null; await loadPlanner(true);
    toast(r.applied + ' planned' + (r.failed ? ', ' + r.failed + ' could not be (' + (r.results.find((x) => !x.ok) || {}).error + ')' : ''), r.failed ? { bad: true } : undefined);
  } catch (e) { toast(e.message, { bad: true }); }
}
(() => {
  const box = $('plannerBody');
  box.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b || !b.dataset) return; const D = b.dataset; const ai = S.pl.ai;
    if (D.plaiOpen !== undefined) return plaiOpen();
    if (D.plaiApply !== undefined) return plaiApply();
    if (D.plaiDiscard !== undefined) { if (ai && ai.estRunId) { try { await api('/api/planner/ai/discard', { body: { runId: ai.estRunId } }); } catch (x) { /* already gone */ } } S.pl.ai = null; return renderPlanner(); }
    if (D.plaiAll !== undefined && ai && ai.run) { ai.run.items.forEach((i) => { ai.sel[i.id].on = true; }); return renderPlanner(); }
    if (D.plaiNone !== undefined && ai && ai.run) { ai.run.items.forEach((i) => { ai.sel[i.id].on = false; }); return renderPlanner(); }
  });
  box.addEventListener('change', (e) => {
    const ai = S.pl.ai; if (!ai || !ai.run) return; const t = e.target; const D = t.dataset || {};
    if (D.plaiOn) { ai.sel[D.plaiOn].on = t.checked; return renderPlanner(); }
    if (D.plaiDest) {
      const s = ai.sel[D.plaiDest]; const v = t.value;
      if (v.startsWith('day:')) { s.where = 'day'; s.date = v.slice(4); } else s.where = v;
      s.on = s.where !== 'inbox'; return renderPlanner();
    }
    if (D.plaiKind) ai.sel[D.plaiKind].kind = t.value;
  });
  box.addEventListener('input', (e) => { const ai = S.pl.ai; const D = e.target.dataset || {}; if (ai && ai.run && D.plaiPerson) ai.sel[D.plaiPerson].person = e.target.value; });
})();
