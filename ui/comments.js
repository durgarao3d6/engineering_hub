/* Comments: unread comments on the work items you follow, who you are waiting on, and the badges that show it everywhere.
   Loaded after app.js. Everything here reads from the hub; the hub reads Azure DevOps (never writes), so "read" is the hub's own marker. */
'use strict';
S.cw = { map: {}, askMap: {}, attention: 0, counts: null, error: null, data: null, loading: false, sig: '', total: -1, tab: 'unread' };
const CW_BASE_TITLE = document.title;

/* ---------- badges used on cards and lines ---------- */
function cwBadge(id) {
  const m = S.cw.map[id]; const a = S.cw.askMap[id]; let h = '';
  if (m) h += '<span class="cw-badge' + (m.forYou ? ' you' : '') + '" title="' + (m.forYou ? 'A mention of you or an answer to something you wrote. ' : '') + 'Comments added since you last looked">' + (m.forYou ? 'For you · ' : '') + m.unread + ' new</span>';
  if (a === 'replied') h += '<span class="cw-badge ok" title="Someone you asked has answered">Replied</span>';
  else if (a === 'nudge') h += '<span class="cw-badge warn" title="You asked and got no answer yet">Nudge due</span>';
  return h;
}
function cwNotify(total) {
  try {
    if (S.cw.total >= 0 && total > S.cw.total && localStorage.getItem('hub.cwNotify') === '1' && window.Notification && Notification.permission === 'granted') {
      new Notification(document.title.replace(/^\(\d+\) /, '') + ': new comments', { body: (total - S.cw.total) + ' more to read. Open the Comments page.', tag: 'hub-comments' });
    }
  } catch { /* notifications are optional */ }
}
async function loadCwSummary() {
  try {
    const s = await api('/api/comments/summary');
    const sig = JSON.stringify([s.map, s.askMap, s.attention, s.error]);
    const changed = sig !== S.cw.sig;
    if (S.cw.total >= 0 && s.attention > S.cw.total) cwNotify(s.attention);
    Object.assign(S.cw, { map: s.map, askMap: s.askMap, attention: s.attention, counts: s.counts, error: s.error, sig, total: s.attention }); // updated in place: other code holds this object
    const nav = $('navCountComments'); if (nav) nav.textContent = s.attention || '';
    document.title = (s.attention ? '(' + s.attention + ') ' : '') + CW_BASE_TITLE.replace(/^\(\d+\) /, '');
    if (changed && !(S.pl && S.pl.drag) && !(drawer && drawer.open)) { if (S.view === 'comments') { if (!S.cw.loading) loadComments(true); } else render(); }
  } catch { /* the hub is restarting or Azure DevOps is down: the badges stay as they were */ }
}

/* ---------- the page ---------- */
const CW_TABS = [['unread', 'New comments'], ['waiting', 'Waiting on others'], ['all', 'All asks']];
async function loadComments(quiet) {
  const m = S.cw; if (m.loading) return; m.loading = true; if (!quiet) renderComments();
  try { m.data = await api('/api/comments'); } catch (e) { m.error = e.message; }
  m.loading = false; renderComments();
}
function cwWhen(iso) { return iso ? ago(iso) : ''; }
function cwItemHtml(i) {
  const reasons = i.reasons.map((r) => badge(r === 'mention' ? 'Mentions you' : 'Answer to you', 'warn')).join('');
  return '<article class="cw-item' + (i.forYou ? ' you' : '') + '"><div class="cw-head"><a class="tlink" href="#" data-open="' + i.taskId + '"><b>#' + i.taskId + '</b> ' + esc(i.title || 'Work item') + '</a>' + (i.state ? badge(i.state, STATE_KIND[i.state] || 'neu') : '') + reasons
    + '<span class="cw-n">' + i.unread + ' new</span></div>'
    + i.events.map((e) => '<div class="cw-ev"><b>' + esc(e.author || 'Someone') + '</b> <span class="muted" title="' + esc(full(e.at)) + '">' + esc(cwWhen(e.at)) + '</span>' + (e.reason ? ' ' + badge(e.reason === 'mention' ? '@you' : 'reply', 'warn') : '') + '<div class="cw-snip">' + esc(e.snippet) + '</div></div>').join('')
    + (i.unread > i.events.length ? '<div class="muted">and ' + (i.unread - i.events.length) + ' older new comment' + (i.unread - i.events.length > 1 ? 's' : '') + '</div>' : '')
    + '<div class="cw-act"><button type="button" class="btn sm" data-cw="read" data-id="' + i.taskId + '">Mark read</button><button type="button" class="btn sm" data-cw="ask" data-id="' + i.taskId + '" data-title="' + esc(i.title) + '">I asked someone…</button>' + (ADO ? '<a class="btn sm" href="' + esc(ADO + i.taskId) + '" target="_blank" rel="noopener">Open in Azure Boards</a>' : '') + '</div></article>';
}
function cwAskHtml(a) {
  const st = { waiting: ['Waiting', 'neu'], replied: ['Replied', 'ok'], nudge: ['Nudge due', 'warn'], closed: ['Closed', 'neu'] }[a.state];
  return '<article class="cw-item ask-' + a.state + '"><div class="cw-head"><a class="tlink" href="#" data-open="' + a.taskId + '"><b>#' + a.taskId + '</b> ' + esc(a.title || 'Work item') + '</a>' + badge(st[0], st[1]) + (a.person ? '<span class="muted">asked ' + esc(a.person) + '</span>' : '') + '<span class="cw-n" title="' + esc(full(a.askedAt)) + '">' + esc(cwWhen(a.askedAt)) + '</span></div>'
    + '<div class="cw-snip">' + esc(a.question) + '</div>'
    + (a.state === 'replied' ? '<div class="muted">' + esc(a.repliedBy || 'Someone') + ' replied ' + esc(cwWhen(a.repliedAt)) + '.</div>' : a.state === 'waiting' || a.state === 'nudge' ? '<div class="muted">Nudge ' + (a.state === 'nudge' ? 'was due ' : 'on ') + esc(a.nudgeAt) + '.</div>' : '')
    + (a.state === 'closed' ? '' : '<div class="cw-act"><button type="button" class="btn sm" data-cw="close" data-id="' + a.id + '">' + (a.state === 'replied' ? 'Got it, close' : 'Close') + '</button>' + (a.state !== 'replied' ? '<button type="button" class="btn sm" data-cw="snooze" data-id="' + a.id + '">Snooze 2 days</button>' : '') + '</div>') + '</article>';
}
function renderComments() {
  const box = $('commentsBody'); const m = S.cw; const d = m.data;
  if (!d) { box.innerHTML = m.error ? '<div class="note warn">' + esc(m.error) + '</div>' : '<div class="muted">Loading…</div>'; return; }
  const c = d.counts; const asks = d.asks;
  const forYou = d.items.filter((i) => i.forYou); const others = d.items.filter((i) => !i.forYou);
  const due = asks.filter((a) => a.state === 'nudge' || a.state === 'replied'); const waiting = asks.filter((a) => a.state === 'waiting');
  let h = '<div class="kpis">' + [['Items with new comments', c.items, c.items ? 'warn' : ''], ['For you', c.forYou, c.forYou ? 'warn' : ''], ['Replies to your asks', c.replied, c.replied ? 'ok' : ''], ['Nudge due', c.nudge, c.nudge ? 'warn' : ''], ['Waiting on others', c.waiting, '']].map((k) => '<div class="kpi ' + k[2] + '"><small>' + esc(k[0]) + '</small><b>' + k[1] + '</b></div>').join('') + '</div>';
  h += '<div class="cw-bar"><span class="muted">' + (d.error ? '<b>Azure DevOps could not be read at the last check:</b> ' + esc(d.error) + '. ' : '') + (d.lastOkAt ? 'Last checked ' + esc(ago(d.lastOkAt)) + ', every ' + d.pollMinutes + ' minutes in working hours. ' : 'Not checked yet. ') + 'New means since you last marked it read here; reading on Azure Boards cannot be seen by the hub.</span>'
    + '<span class="cw-bar-r"><label class="cw-sw"><input type="checkbox" id="cwNotify"' + (localStorage.getItem('hub.cwNotify') === '1' ? ' checked' : '') + '> Browser notifications</label>'
    + '<button type="button" class="btn sm" data-cw="refresh"' + (d.checking ? ' disabled' : '') + '>' + (d.checking ? 'Checking…' : 'Check now') + '</button>' + (c.items ? '<button type="button" class="btn sm" data-cw="readall">Mark all read</button>' : '') + '</span></div>';
  h += '<div class="toolbar"><div class="seg" role="group" aria-label="Comments section">' + CW_TABS.map((t) => '<button type="button" aria-pressed="' + (m.tab === t[0]) + '" data-cwtab="' + t[0] + '">' + t[1] + (t[0] === 'unread' ? ' (' + c.items + ')' : t[0] === 'waiting' ? ' (' + (c.waiting + c.replied + c.nudge) + ')' : '') + '</button>').join('') + '</div></div>';
  if (m.tab === 'unread') {
    h += (d.suggestions.length ? '<div class="cw-sec"><h3>You may be waiting on someone</h3>' + d.suggestions.map((s) => '<article class="cw-item"><div class="cw-head"><a class="tlink" href="#" data-open="' + s.taskId + '"><b>#' + s.taskId + '</b> ' + esc(s.title || '') + '</a></div><div class="cw-snip">' + esc(s.question) + '</div><div class="muted">Your last comment has no answer yet' + (s.person ? ', and mentions ' + esc(s.person) : '') + '. Track it?</div><div class="cw-act"><button type="button" class="btn sm primary" data-cw="accept" data-id="' + s.taskId + '">Track this ask</button><button type="button" class="btn sm" data-cw="dismiss" data-id="' + s.taskId + '">Not needed</button></div></article>').join('') + '</div>' : '');
    h += (forYou.length ? '<div class="cw-sec"><h3>For you</h3>' + forYou.map(cwItemHtml).join('') + '</div>' : '') + (others.length ? '<div class="cw-sec"><h3>New comments</h3>' + others.map(cwItemHtml).join('') + '</div>' : '');
    if (!d.items.length && !d.suggestions.length) h += '<div class="empty">Nothing new, enjoy the quiet. Comments from other people on your work items, plans and delegations show up here.</div>';
  } else if (m.tab === 'waiting') {
    h += due.length ? '<div class="cw-sec"><h3>Needs you</h3>' + due.map(cwAskHtml).join('') + '</div>' : '';
    h += waiting.length ? '<div class="cw-sec"><h3>Waiting on others</h3>' + waiting.slice().sort((a, b) => a.askedAt.localeCompare(b.askedAt)).map(cwAskHtml).join('') + '</div>' : '';
    if (!due.length && !waiting.length) h += '<div class="empty">You are not waiting on anyone. Press "I asked someone…" on a work item to keep track of an answer.</div>';
  } else {
    h += asks.length ? asks.map(cwAskHtml).join('') : '<div class="empty">No asks yet.</div>';
  }
  box.innerHTML = h;
}
async function cwDo(btn) {
  const act = btn.dataset.cw; const id = Number(btn.dataset.id);
  try {
    if (act === 'read') await api('/api/comments/' + id + '/read', { body: {} });
    else if (act === 'readall') await api('/api/comments/read-all', { body: {} });
    else if (act === 'close') await api('/api/asks/' + id + '/close', { body: {} });
    else if (act === 'snooze') await api('/api/asks/' + id + '/snooze', { body: { days: 2 } });
    else if (act === 'accept') await api('/api/comments/' + id + '/suggestion/accept', { body: {} });
    else if (act === 'dismiss') await api('/api/comments/' + id + '/suggestion/dismiss', { body: {} });
    else if (act === 'refresh') { btn.disabled = true; btn.textContent = 'Checking…'; S.cw.data = await api('/api/comments/refresh', { body: {} }); renderComments(); await loadCwSummary(); return; }
    else if (act === 'ask') return cwAskDialog(id, btn.dataset.title || '');
    else if (act === 'watch') { await api('/api/comments/' + id + '/watch', { body: { on: btn.dataset.on === '1' } }); if (S.dr && S.dr.id === id) { S.dr.data = await api('/api/tasks/' + id); renderDrawer(); } toast(btn.dataset.on === '1' ? 'Watching #' + id : 'Stopped watching #' + id); return; }
    await loadCwSummary(); if (S.view === 'comments') loadComments(true);
    if (S.view === 'planner' && typeof loadPlanner === 'function') loadPlanner(true);
    if (drawer.open && S.dr && S.dr.id === id) { S.dr.data = await api('/api/tasks/' + id); renderDrawer(); }
  } catch (e) { toast(e.message, { bad: true }); }
}
function cwAskDialog(taskId, title) {
  openDialog({ title: 'I asked someone about #' + taskId, body: '<p class="muted">' + esc(title) + '</p><div class="field"><label>Who did you ask? (optional, a reply from this person is matched by name)</label><input name="person" maxlength="120" placeholder="e.g. Ravi"></div>'
    + '<div class="field"><label>What did you ask?</label><textarea name="question" maxlength="600" required></textarea></div><div class="field"><label>Nudge me after (working days)</label><input name="days" type="number" min="1" max="30" value="2"></div>',
  ok: 'Track this ask', submit: async (f) => { await api('/api/asks', { body: { taskId, person: f.person.value, question: f.question.value, nudgeDays: Number(f.days.value) } }); await loadCwSummary(); if (S.view === 'comments') loadComments(true); if (drawer.open && S.dr && S.dr.id === taskId) { S.dr.data = await api('/api/tasks/' + taskId); renderDrawer(); } toast('Tracking this ask'); } });
}

/* ---------- the drawer ---------- */
function cwDrawerHtml(data, id) {
  S.cw.openId = id; const c = data.comments; if (!c) return '';
  let h = '<div class="sec" id="drComments"><h3>Comments in Azure Boards' + (c.unread.length ? ' · ' + c.unread.length + ' new' : '') + '</h3>';
  if (c.unread.length) h += c.unread.map((e) => '<div class="cw-ev"><b>' + esc(e.author || 'Someone') + '</b> <span class="muted" title="' + esc(full(e.at)) + '">' + esc(cwWhen(e.at)) + '</span>' + (e.reason ? ' ' + badge(e.reason === 'mention' ? '@you' : 'reply', 'warn') : '') + '<div class="cw-snip">' + esc(e.snippet) + '</div></div>').join('') + '<div class="muted">They are marked read when you close this panel.</div>';
  else h += '<div class="muted">No new comments since you last looked.</div>';
  if (c.suggestion) h += '<div class="note"><b>Track this ask?</b> ' + esc(c.suggestion.question) + '<div class="cw-act"><button type="button" class="btn sm primary" data-cw="accept" data-id="' + id + '">Track this ask</button><button type="button" class="btn sm" data-cw="dismiss" data-id="' + id + '">Not needed</button></div></div>';
  h += (c.asks.length ? '<div class="cw-asks">' + c.asks.map((a) => '<div class="cw-ask ' + a.state + '">' + badge({ waiting: 'Waiting', replied: 'Replied', nudge: 'Nudge due', closed: 'Closed' }[a.state], { waiting: 'neu', replied: 'ok', nudge: 'warn', closed: 'neu' }[a.state]) + ' <span>' + (a.person ? esc(a.person) + ': ' : '') + esc(a.question) + '</span>' + (a.state !== 'closed' ? ' <button type="button" class="linkbtn" data-cw="close" data-id="' + a.id + '">Close</button>' : '') + '</div>').join('') + '</div>' : '');
  h += '</div>';
  return h;
}
drawer.addEventListener('close', () => { // what the panel showed counts as read once it is closed
  const id = S.cw.openId; S.cw.openId = null;
  if (id && S.cw.map[id]) api('/api/comments/' + id + '/read', { body: {} }).then(loadCwSummary, () => {});
});

/* ---------- events ---------- */
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-cw]'); if (b) { e.preventDefault(); cwDo(b); return; }
  const t = e.target.closest('[data-cwtab]'); if (t) { S.cw.tab = t.dataset.cwtab; renderComments(); }
});
document.addEventListener('change', async (e) => {
  if (e.target.id !== 'cwNotify') return;
  try {
    if (e.target.checked) {
      if (!window.Notification) { toast('This browser cannot show notifications', { bad: true }); e.target.checked = false; return; }
      const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      if (p !== 'granted') { e.target.checked = false; toast('Notifications are blocked in this browser', { bad: true }); return; }
      localStorage.setItem('hub.cwNotify', '1'); toast('You will get a notification while this tab is open');
    } else localStorage.removeItem('hub.cwNotify');
  } catch { /* storage may be unavailable */ }
});
loadCwSummary(); setInterval(loadCwSummary, 60000);
if (S.view === 'comments') loadComments();
