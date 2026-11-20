'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let ADO = ''; // work item address prefix, set from /api/me (empty when Azure DevOps is not set up)
const idLink = (id) => (ADO ? '<a href="' + ADO + id + '" target="_blank" rel="noopener">#' + id + '</a>' : '#' + id);
const keyOf = (p) => String(p || '').split('/').join('\\').toLowerCase();

const S = { wts: [], clearances: [], me: { user: '', categories: [] }, view: 'worktrees', loaded: false,
  q: '', filter: 'all', repo: '', sortKey: 'attention', sortDir: 1, q2: '', filter2: 'active', generatedAt: null, errors: 0, moves: [], stashes: [], filter4: 'attention',
  tasksData: null, tab: 'work', status: 'open', completed: null, completedDays: 30, completedLoading: false, completedErr: null, usage: null, fT: 'all', fR: 'waiting', qT: '', typeT: '', sortT: 'attention', dirT: 1 };
let dlgMoveId = null;
// Pagination state per list. `sig` is the filter/sort/search signature: when it changes the list goes back to page 1.
S.pg = { wts: { page: 1, size: 25, sizes: [10, 25, 50, 100], sig: '' }, tasks: { page: 1, size: 24, sizes: [12, 24, 48, 96], sig: '' }, reviews: { page: 1, size: 25, sizes: [10, 25, 50, 100], sig: '' } };
function paginate(key, rows, sig, pagerId) {
  const p = S.pg[key];
  if (p.sig !== sig) { p.page = 1; p.sig = sig; }
  const pages = Math.max(1, Math.ceil(rows.length / p.size));
  if (p.page > pages) p.page = pages;
  const start = (p.page - 1) * p.size; const end = Math.min(rows.length, start + p.size);
  $(pagerId).innerHTML = rows.length <= p.sizes[0] ? '' : '<label>Per page<select data-psize="' + key + '" aria-label="Rows per page">' + p.sizes.map((s) => '<option' + (s === p.size ? ' selected' : '') + '>' + s + '</option>').join('') + '</select></label>'
    + '<span>' + (start + 1) + '–' + end + ' of ' + rows.length + '</span>'
    + '<button type="button" class="btn sm" data-pg="' + key + ':-1" aria-label="Previous page"' + (p.page <= 1 ? ' disabled' : '') + '>‹ Prev</button>'
    + '<span>Page ' + p.page + ' of ' + pages + '</span>'
    + '<button type="button" class="btn sm" data-pg="' + key + ':1" aria-label="Next page"' + (p.page >= pages ? ' disabled' : '') + '>Next ›</button>';
  return rows.slice(start, end);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- helpers ---------- */
function ago(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return Math.round(s / 60) + ' min ago';
  if (s < 129600) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' d ago';
}
const full = (iso) => (iso ? new Date(iso).toLocaleString() : '');
function badge(text, kind) { return '<span class="badge b-' + kind + '">' + esc(text) + '</span>'; }
function statusBadges(w) {
  const out = [];
  const t = w.where || 'Unknown';
  if (t.startsWith('Uncommitted')) out.push(badge('Uncommitted', 'warn'));
  else if (t.startsWith('Committed locally')) out.push(badge('Not pushed', 'bad'));
  else if (t === 'Pushed') out.push(badge('Pushed', 'ok'));
  else if (t.startsWith('Merged')) out.push(badge('Merged, still on disk', 'info'));
  else if (w.isMain) out.push(badge('Live checkout', 'neu'));
  else out.push(badge(t, 'neu'));
  if (w.stale && !t.startsWith('Merged')) out.push(badge('Stale ' + w.idleDays + ' d', 'neu'));
  if (w.changedSinceCleared) out.push(badge('Changed since cleared', 'warn'));
  if (w.missing) out.push(badge('Folder missing', 'bad'));
  if (w.prunable) out.push(badge('Prunable', 'bad'));
  return '<div class="badges">' + out.join('') + '</div>';
}
async function api(path, opts) {
  const o = Object.assign({ headers: {} }, opts || {});
  if (o.body) { o.method = 'POST'; o.headers = { 'Content-Type': 'application/json', 'X-Hub-Request': '1' }; o.body = JSON.stringify(o.body); }
  const r = await fetch(path, o);
  let data = {};
  try { data = await r.json(); } catch (e) { /* non-JSON */ }
  if (!r.ok) { const err = new Error(data.error || ('Request failed (' + r.status + ')')); err.fields = data.errors; err.status = r.status; throw err; }
  return data;
}
function toast(msg, opts) {
  opts = opts || {};
  const el = document.createElement('div');
  el.className = 'toast' + (opts.bad ? ' bad' : '');
  el.innerHTML = '<span>' + esc(msg) + '</span>' + (opts.action ? '<button type="button">' + esc(opts.action.label) + '</button>' : '');
  if (opts.action) el.querySelector('button').addEventListener('click', () => { el.remove(); opts.action.run(); });
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), opts.action ? 9000 : 4500);
}

/* ---------- data ---------- */
function activeRows() { return S.wts.filter((w) => !w.isMain && (!w.clearance || w.changedSinceCleared)); }
function isCleared(w) { return !!w.clearance && !w.changedSinceCleared; }
async function load(force, quiet) {
  if (force) { S.completed = null; S.completedErr = null; S.usage = null; if (S.plan) loadPlan(S.pd); } // Refresh also re-reads completed items, the usage report and the plan
  const btn = $('refresh');
  btn.classList.add('spin'); btn.disabled = true;
  try {
    const [wt, cl, mv, st] = await Promise.all([api('/api/worktrees' + (force ? '?refresh=1' : '')), api('/api/clearances'), api('/api/moves'), api('/api/stashes')]);
    S.moves = mv.moves; S.stashes = st.stashes;
    loadTasks(force); // Azure DevOps is slower; the task board fills in when it arrives
    loadHealth();
    S.wts = wt.worktrees; S.generatedAt = wt.generatedAt; S.errors = (wt.errors || []).length + (wt.missingClones || []).length;
    S.clearances = cl.clearances; S.loaded = true;
    $('banner').hidden = !S.errors;
    if (S.errors) $('banner').textContent = S.errors + ' clone(s) could not be read. Their worktrees are missing from this list.';
  } catch (e) {
    $('banner').hidden = false; $('banner').className = 'banner bad';
    $('banner').textContent = 'Could not load data: ' + e.message;
    if (!quiet) toast('Refresh failed: ' + e.message, { bad: true });
  } finally { btn.classList.remove('spin'); btn.disabled = false; render(); }
}

/* ---------- worktrees view ---------- */
const FILTERS = [['all', 'All'], ['attention', 'Needs attention'], ['uncommitted', 'Uncommitted'], ['unpushed', 'Not pushed'], ['pushed', 'Pushed'], ['stale', 'Stale / merged'], ['live', 'Live checkouts']];
function matchFilter(w, f) {
  switch (f) {
    case 'attention': return w.needsAttention || w.changedSinceCleared;
    case 'uncommitted': return w.dirtyFiles > 0;
    case 'unpushed': return (w.where || '').startsWith('Committed locally');
    case 'pushed': return w.where === 'Pushed';
    case 'stale': return w.stale;
    default: return true;
  }
}
const SORT = {
  attention: (w) => (w.needsAttention || w.changedSinceCleared ? 0 : 1) * 1e6 - (w.dirtyFiles || 0) * 100 - Math.min(w.idleDays || 0, 99),
  branch: (w) => (w.branch || '').toLowerCase(), repo: (w) => w.repoKey, task: (w) => w.taskId || 0, status: (w) => w.where || '',
  dirty: (w) => w.dirtyFiles || 0, idle: (w) => (w.idleDays == null ? -1 : w.idleDays), commit: (w) => (w.lastCommit ? w.lastCommit.date : ''),
};
const COLS = [['branch', 'Worktree'], ['task', 'Task'], ['status', 'Status'], ['dirty', 'Changes'], [null, 'Sync'], ['idle', 'Idle'], ['commit', 'Last commit'], [null, '']];

function renderKpis() {
  const a = activeRows();
  const k = [['Active worktrees', a.length, 'info'], ['Uncommitted work', a.filter((w) => w.dirtyFiles > 0).length, 'warn'],
    ['Committed, not pushed', a.filter((w) => (w.where || '').startsWith('Committed locally')).length, 'bad'],
    ['Stale or merged', a.filter((w) => w.stale).length, ''], ['Cleared by hand', S.wts.filter(isCleared).length, 'ok']];
  $('kpis').innerHTML = k.map((x) => '<div class="kpi ' + x[2] + '"><small>' + x[0] + '</small><b>' + x[1] + '</b></div>').join('');
}
function renderWorktrees() {
  renderKpis();
  $('filter').innerHTML = FILTERS.map((f) => '<button type="button" data-f="' + f[0] + '" aria-pressed="' + (S.filter === f[0]) + '">' + f[1] + '</button>').join('');
  const repos = [...new Set(S.wts.map((w) => w.repoKey))].sort();
  $('repo').innerHTML = '<option value="">All repositories</option>' + repos.map((r) => '<option' + (r === S.repo ? ' selected' : '') + '>' + esc(r) + '</option>').join('');
  $('head').innerHTML = COLS.map((c) => c[0]
    ? '<th class="sortable" data-k="' + c[0] + '">' + c[1] + (S.sortKey === c[0] ? '<span class="arr">' + (S.sortDir > 0 ? '▲' : '▼') + '</span>' : '') + '</th>'
    : '<th' + (c[1] ? '' : ' class="r"') + '>' + c[1] + '</th>').join('');
  const q = S.q.trim().toLowerCase();
  let rows = S.filter === 'live' ? S.wts.filter((w) => w.isMain) : activeRows().filter((w) => matchFilter(w, S.filter));
  if (S.repo) rows = rows.filter((w) => w.repoKey === S.repo);
  if (q) rows = rows.filter((w) => [w.repoKey, w.layer, w.branch, w.taskId, w.path, w.where].join(' ').toLowerCase().includes(q));
  const fn = SORT[S.sortKey] || SORT.attention;
  rows = rows.slice().sort((a, b) => { const x = fn(a), y = fn(b); return (x > y ? 1 : x < y ? -1 : 0) * S.sortDir; });
  if (!S.loaded) { $('rows').innerHTML = Array.from({ length: 6 }, () => '<tr>' + COLS.map(() => '<td><div class="skel"></div></td>').join('') + '</tr>').join(''); $('foot').textContent = 'Loading…'; return; }
  const shown = paginate('wts', rows, [S.filter, S.repo, S.q, S.sortKey, S.sortDir].join('|'), 'pagerW');
  $('rows').innerHTML = shown.map((w) => '<tr>'
    + '<td><div class="cell-main">' + esc(w.branch || '(no branch)') + '</div><div class="cell-sub">' + esc(w.repoKey) + ' · ' + esc(w.layer) + '</div><div class="mono path">' + esc(w.path) + '</div></td>'
    + '<td class="nowrap">' + (w.taskId ? idLink(w.taskId) : '<span class="muted">none</span>') + '</td>'
    + '<td>' + statusBadges(w) + '</td>'
    + '<td class="nowrap">' + (w.dirtyFiles ? '<b>' + w.dirtyFiles + '</b> file' + (w.dirtyFiles > 1 ? 's' : '') : '<span class="muted">clean</span>') + '</td>'
    + '<td class="nowrap">' + (w.onOrigin ? w.ahead + ' ahead · ' + w.behind + ' behind' : '<span class="muted">not on origin</span>') + '</td>'
    + '<td class="nowrap">' + (w.idleDays == null ? '' : w.idleDays + ' d') + '</td>'
    + '<td><span class="mono">' + esc(w.lastCommit ? w.lastCommit.hash : '') + '</span><div class="cell-sub">' + esc(w.lastCommit ? w.lastCommit.subject.slice(0, 70) : '') + '</div></td>'
    + '<td class="r nowrap">' + (w.isMain ? '' : '<button type="button" class="btn sm primary" data-move="' + esc(w.path) + '" title="Stash live changes, merge origin/main, bring this work into the live repo">Move to live…</button> <button type="button" class="btn sm" data-clear="' + esc(w.path) + '">Clear…</button>') + '</td></tr>').join('')
    || '<tr><td colspan="8"><div class="empty"><b>No worktrees match</b>Change the filter or search.</div></td></tr>';
  $('foot').textContent = 'Showing ' + rows.length + ' of ' + (S.filter === 'live' ? S.wts.filter((w) => w.isMain).length : activeRows().length)
    + ' · "Merged" and "sync" use the last fetched origin';
}

/* ---------- cleared view ---------- */
const FILTERS2 = [['active', 'Currently cleared'], ['restored', 'Restored'], ['all', 'All history']];
function renderCleared() {
  $('filter2').innerHTML = FILTERS2.map((f) => '<button type="button" data-f2="' + f[0] + '" aria-pressed="' + (S.filter2 === f[0]) + '">' + f[1] + '</button>').join('');
  const byKey = new Map(S.wts.map((w) => [keyOf(w.path), w]));
  const q = S.q2.trim().toLowerCase();
  let rows = S.clearances.filter((c) => S.filter2 === 'all' || (S.filter2 === 'active' ? !c.restoredAt : !!c.restoredAt));
  if (q) rows = rows.filter((c) => [c.reason, c.branch, c.repoKey, c.clearedBy, c.reference, c.category, c.taskId].join(' ').toLowerCase().includes(q));
  $('rows2').innerHTML = rows.map((c) => {
    const w = byKey.get(keyOf(c.path));
    let st;
    if (c.restoredAt) st = badge('Restored', 'neu') + '<div class="cell-sub">' + esc(c.restoredBy) + ' · ' + esc(ago(c.restoredAt)) + (c.restoreNote ? '<br>' + esc(c.restoreNote) : '') + '</div>';
    else if (!w) st = badge('Folder removed', 'ok');
    else if (w.changedSinceCleared) st = badge('Changed since cleared', 'warn');
    else st = badge('Cleared', 'ok') + '<div class="cell-sub">Folder still on disk</div>';
    return '<tr>'
      + '<td><div class="cell-main">' + esc(c.branch || '(no branch)') + '</div><div class="cell-sub">' + esc(c.repoKey) + '</div><div class="mono path">' + esc(c.path) + '</div></td>'
      + '<td class="nowrap">' + (c.taskId ? idLink(c.taskId) : '<span class="muted">none</span>') + '</td>'
      + '<td>' + badge(c.category, 'info') + (c.reference ? '<div class="cell-sub">Ref: ' + esc(c.reference) + '</div>' : '') + '</td>'
      + '<td style="max-width:360px">' + esc(c.reason) + '</td>'
      + '<td class="nowrap" title="' + esc(full(c.clearedAt)) + '">' + esc(c.clearedBy) + '<div class="cell-sub">' + esc(ago(c.clearedAt)) + '</div></td>'
      + '<td>' + st + '</td>'
      + '<td class="r nowrap">' + (c.restoredAt ? '' : '<button type="button" class="btn sm" data-restore="' + c.id + '">Restore</button>') + '</td></tr>';
  }).join('') || '<tr><td colspan="7"><div class="empty"><b>Nothing here</b>Worktrees you clear from the Worktrees page appear here with their reason.</div></td></tr>';
  $('foot2').textContent = rows.length + ' record' + (rows.length === 1 ? '' : 's') + '. Clearing only hides a worktree in this hub; folders and branches are never changed.';
}

/* ---------- dialog ---------- */
const dlg = $('dlg');
let dlgSubmit = null;
function openDialog(o) {
  $('dlgTitle').textContent = o.title; $('dlgBody').innerHTML = o.body;
  const ok = $('dlgOk'); ok.textContent = o.ok; ok.className = 'btn ' + (o.danger ? 'danger' : 'primary'); ok.disabled = false;
  $('dlgCancel').hidden = false; dlgMoveId = null;
  dlgSubmit = o.submit; dlg.showModal();
  const first = $('dlgBody').querySelector('[autofocus],select,textarea,input'); if (first) first.focus();
  if (o.onOpen) o.onOpen();
}
function fieldErrors(map) {
  $('dlgBody').querySelectorAll('.err').forEach((e) => e.remove());
  $('dlgBody').querySelectorAll('.invalid').forEach((e) => e.classList.remove('invalid'));
  Object.entries(map || {}).forEach(([k, msg]) => {
    const el = $('dlgBody').querySelector('[name="' + k + '"]'); if (!el) return;
    el.classList.add('invalid');
    const d = document.createElement('div'); d.className = 'err'; d.textContent = msg; (el.closest('.field') || el.parentNode).appendChild(d);
  });
}
$('dlgForm').addEventListener('submit', async (e) => {
  e.preventDefault(); if (!dlgSubmit) return;
  const data = Object.fromEntries(new FormData($('dlgForm')).entries());
  fieldErrors(null); $('dlgOk').disabled = true;
  try { const keep = await dlgSubmit(data); if (keep !== 'keep') dlg.close(); }
  catch (err) { $('dlgOk').disabled = false; if (err.fields) fieldErrors(err.fields); else toast(err.message, { bad: true }); }
});
$('dlgCancel').addEventListener('click', () => dlg.close());
$('dlgX').addEventListener('click', () => dlg.close());
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

function openClear(path) {
  const w = S.wts.find((x) => x.path === path); if (!w) return;
  const cats = S.me.categories.map((c) => '<option>' + esc(c) + '</option>').join('');
  openDialog({
    title: 'Clear worktree', ok: 'Clear worktree',
    body: '<div class="sum"><div class="cell-main">' + esc(w.branch) + '</div><div class="cell-sub">' + esc(w.repoKey) + ' · ' + esc(w.where) + (w.taskId ? ' · task #' + w.taskId : '') + '</div><div class="mono path">' + esc(w.path) + '</div></div>'
      + (w.dirtyFiles > 0 ? '<div class="note warn"><b>' + w.dirtyFiles + ' uncommitted file(s)</b> are still on disk. Clearing does not save or delete them. It will reappear if the files or commits change.</div>' : '')
      + '<div class="note">Clearing hides this worktree in the hub and records who cleared it and why. No git command is run and nothing is deleted.</div>'
      + '<div class="field"><label for="f-cat">Why is it being cleared?</label><select id="f-cat" name="category">' + '<option value="">Select a reason…</option>' + cats + '</select></div>'
      + '<div class="field"><label for="f-ref">Reference <span class="muted">(optional)</span></label><input id="f-ref" name="reference" maxlength="200" placeholder="PR number, work item, or person who finished it"></div>'
      + '<div class="field"><label for="f-reason">Details</label><textarea id="f-reason" name="reason" maxlength="1000" placeholder="For example: Shiva merged the fix in PR 9234, this branch is no longer needed."></textarea><div class="hint"><span>Required, at least 10 characters. Visible to everyone using this hub.</span><span id="cnt">0 / 1000</span></div></div>',
    onOpen: () => { const t = $('f-reason'); t.addEventListener('input', () => { $('cnt').textContent = t.value.length + ' / 1000'; }); },
    submit: async (d) => {
      const errs = {};
      if (!d.category) errs.category = 'Choose a reason category.';
      if ((d.reason || '').trim().length < 10) errs.reason = 'Explain why in at least 10 characters.';
      if (Object.keys(errs).length) { const e = new Error('Validation failed'); e.fields = errs; throw e; }
      const res = await api('/api/clearances', { body: { path: w.path, category: d.category, reason: d.reason, reference: d.reference } });
      await load(false, true);
      toast('Cleared ' + w.branch, { action: { label: 'Undo', run: () => restore(res.id, '') } });
    },
  });
}
function openRestore(id) {
  const c = S.clearances.find((x) => x.id === id); if (!c) return;
  openDialog({
    title: 'Restore worktree', ok: 'Restore',
    body: '<div class="sum"><div class="cell-main">' + esc(c.branch) + '</div><div class="cell-sub">Cleared by ' + esc(c.clearedBy) + ' · ' + esc(ago(c.clearedAt)) + ' · ' + esc(c.category) + '</div><div>' + esc(c.reason) + '</div></div>'
      + '<div class="field"><label for="f-note">Note <span class="muted">(optional)</span></label><input id="f-note" name="note" maxlength="500" placeholder="Why is it active again?"></div>',
    submit: async (d) => { await restore(c.id, d.note, true); },
  });
}
async function restore(id, note, quiet) {
  await api('/api/clearances/' + id + '/restore', { body: { note: note || '' } });
  await load(false, true);
  if (!quiet) toast('Restored to the active list');
  else toast('Restored to the active list');
}

/* ---------- task board ---------- */
async function loadTasks(force) {
  try { S.tasksData = await api('/api/tasks' + (force ? '?refresh=1' : '')); }
  catch (e) { S.tasksData = { ado: { ok: false, error: e.message }, tasks: [], reviews: [] }; }
  render();
}
const WHERE_BADGE = { 'PR open': ['PR open', 'info'], 'PR open (draft)': ['PR draft', 'neu'], 'In live repo': ['In live repo', 'info'], 'In live repo (uncommitted)': ['Live repo, uncommitted', 'warn'],
  'Uncommitted in worktree': ['Uncommitted', 'warn'], 'Committed locally': ['Not pushed', 'bad'], Pushed: ['Pushed', 'ok'], Merged: ['Merged', 'ok'], 'No code yet': ['No code yet', 'neu'], Completed: ['Completed', 'neu'] };
// Completed work items (Resolved/Closed/Done) are not part of the board: they are fetched only when the user opens the Completed view.
async function loadCompleted() {
  S.completedErr = null; S.completedLoading = true;
  try {
    const data = await api('/api/tasks/completed?days=' + S.completedDays);
    if (data.days === S.completedDays) S.completed = data; // ignore a late answer for a period that is no longer selected
  } catch (e) { S.completed = null; S.completedErr = e.message; }
  S.completedLoading = false; render();
}
function ensureCompleted() { if (!S.completed && !S.completedLoading && !S.completedErr) loadCompleted(); }
const STATE_KIND = { New: 'neu', Active: 'info', Resolved: 'ok', Done: 'ok', Closed: 'neu' };
const PROGRESS = ['In live repo', 'In live repo (uncommitted)', 'Uncommitted in worktree', 'Committed locally', 'Pushed'];
const FILTERS_T = [['attention', 'Needs attention'], ['progress', 'In progress'], ['pr', 'PR open'], ['new', 'No code yet'], ['merged', 'Merged'], ['all', 'All']];
const FILTERS_R = [['waiting', 'Waiting for my vote'], ['human', 'From people'], ['all', 'Everything']];
function matchT(t, f) {
  if (f === 'attention') return t.attention.length > 0;
  if (f === 'progress') return PROGRESS.includes(t.where);
  if (f === 'pr') return t.where.indexOf('PR open') === 0;
  if (f === 'new') return t.where === 'No code yet';
  if (f === 'merged') return t.where === 'Merged';
  return true;
}
const ms = (iso) => (iso ? Date.parse(iso) : 0);
const SORT_OPTS = [['attention', 'needs attention first'], ['last', 'latest activity'], ['id', 'newest ID first'], ['state', 'state'], ['where', 'code state'], ['notes', 'has notes first']];
const SORT_FN = {
  attention: (t) => -(t.attention.length * 1e13) - ms(t.lastActivity),
  last: (t) => -ms(t.lastActivity), id: (t) => -t.id, state: (t) => t.state || '', where: (t) => t.where,
  notes: (t) => -((t.noteCount || 0) * 1e13) - ms(t.lastActivity),
};
const COLS_R = ['Pull request', 'Title', 'Repo', 'Author', 'Opened', 'My vote'];

function cardHtml(t) {
  const wb = WHERE_BADGE[t.where] || [t.where, 'neu'];
  const kind = t.attention.length ? 'warn' : (wb[1] === 'bad' || wb[1] === 'info' || wb[1] === 'ok' ? wb[1] : 'neu');
  const prChips = t.prs.map((p) => '<a class="chip" href="' + esc(p.url) + '" target="_blank" rel="noopener" title="' + esc(p.title) + '">PR ' + p.id + (p.status === 'active' ? (p.isDraft ? ' draft' : ' open') : ' merged') + '</a>').join('');
  const repoChips = t.repos.map((r) => '<span class="chip">' + esc(r) + '</span>').join('');
  const warns = t.attention.slice(0, 2).map((a) => '<div class="tc-warn">⚠ ' + esc(a) + '</div>').join('') + (t.attention.length > 2 ? '<div class="tc-warn">+' + (t.attention.length - 2) + ' more</div>' : '');
  return '<article class="tcard k-' + kind + '" tabindex="0" role="button" data-open="' + t.id + '" aria-label="Open task ' + t.id + ': ' + esc(t.title) + '">'
    + '<div class="tc-top"><span class="tc-id">#' + t.id + '<span>' + esc(t.type) + '</span></span>' + badge(t.state || 'Unknown', STATE_KIND[t.state] || 'neu') + '</div>'
    + '<div class="tc-title">' + esc(t.title) + '</div>'
    + '<div class="tc-row">' + badge(wb[0], wb[1]) + (t.worktrees.length ? '<span class="muted">' + t.worktrees.length + ' checkout' + (t.worktrees.length > 1 ? 's' : '') + '</span>' : '') + '</div>'
    + warns
    + ((repoChips || prChips) ? '<div class="chips">' + repoChips + prChips + '</div>' : '')
    + '<div class="tc-foot"><span title="' + esc(full(t.lastActivity)) + '">' + (t.lastActivity ? 'Updated ' + esc(ago(t.lastActivity)) : 'No activity') + '</span>'
    + (t.noteCount ? '<span class="notepill"><svg viewBox="0 0 24 24"><path d="M5 4h14v12H8l-3 3zM9 9h6M9 12h4"/></svg>' + t.noteCount + ' note' + (t.noteCount > 1 ? 's' : '') + '</span>' : '<span>No notes</span>') + '</div>'
    + '</article>';
}

function renderTasks() {
  const D = S.tasksData; const work = S.tab === 'work';
  const note = $('adoNote');
  note.hidden = !(D && !D.ado.ok);
  if (D && !D.ado.ok) {
    note.className = 'banner bad';
    note.innerHTML = D.ado.notConfigured ? '<b>Azure DevOps is not set up.</b> Add <span class="mono">organization</span> and <span class="mono">project</span> to hub.config.json (see the README), then restart the hub. Until then the board shows local git data only; everything else works.'
      : '<b>Azure DevOps data is unavailable.</b> ' + esc(D.ado.error) + (D.ado.auth ? ' To fix it, open a terminal, run <span class="mono">az login</span> and finish the browser sign-in, then press Refresh here.' : ' The board below shows local git data only. Fix it, then press Refresh.');
  }
  $('tabT').innerHTML = [['work', 'My work'], ['reviews', 'Reviews']].map((x) => '<button type="button" data-tab="' + x[0] + '" aria-pressed="' + (S.tab === x[0]) + '">' + x[1] + '</button>').join('');
  const completedView = work && S.status === 'completed';
  $('statusT').innerHTML = [['open', 'Open (New + Active)'], ['completed', 'Completed']].map((x) => '<button type="button" data-status="' + x[0] + '" aria-pressed="' + (S.status === x[0]) + '">' + x[1] + '</button>').join('');
  $('statusT').hidden = !work; $('daysT').hidden = !completedView; $('filterT').hidden = completedView;
  if (completedView) { $('daysT').innerHTML = [7, 30, 90, 180, 365].map((d) => '<option value="' + d + '"' + (S.completedDays === d ? ' selected' : '') + '>Completed in the last ' + d + ' days</option>').join(''); ensureCompleted(); }
  const fl = work ? FILTERS_T : FILTERS_R; const cur = work ? S.fT : S.fR;
  $('filterT').innerHTML = fl.map((f) => '<button type="button" data-fT="' + f[0] + '" aria-pressed="' + (cur === f[0]) + '">' + f[1] + '</button>').join('');
  $('typeT').hidden = !work; $('sortT').hidden = !work; $('cardsT').hidden = !work; $('reviewsWrap').hidden = work;
  const tasks = D ? D.tasks : []; const reviews = D ? D.reviews : [];
  const q = S.qT.trim().toLowerCase();
  if (!D) {
    $('kpisT').innerHTML = '';
    $('cardsT').innerHTML = Array.from({ length: 6 }, () => '<div class="tcard"><div class="skel" style="width:40%"></div><div class="skel"></div><div class="skel" style="width:70%"></div><div class="skel" style="width:55%"></div></div>').join('');
    $('headT').innerHTML = ''; $('rowsT').innerHTML = '';
    $('footT').textContent = 'Loading from Azure DevOps…'; return;
  }
  const waiting = reviews.filter((r) => !r.isBot && !r.voted).length;
  $('kpisT').innerHTML = [['New', tasks.filter((t) => t.state === 'New').length, 'neu'], ['Active', tasks.filter((t) => t.state === 'Active').length, 'info'],
    ['Needs attention', tasks.filter((t) => t.attention.length).length, 'warn'], ['PRs open', tasks.filter((t) => t.where.indexOf('PR open') === 0).length, 'info'],
    ['Reviews waiting for me', waiting, waiting ? 'bad' : 'ok']].map((x) => '<div class="kpi ' + x[2] + '"><small>' + x[0] + '</small><b>' + x[1] + '</b></div>').join('');

  if (work) {
    const src = completedView ? ((S.completed && S.completed.tasks) || []) : tasks;
    const types = [...new Set(src.map((t) => t.type).filter(Boolean))].sort();
    $('typeT').innerHTML = '<option value="">All types</option>' + types.map((x) => '<option' + (x === S.typeT ? ' selected' : '') + '>' + esc(x) + '</option>').join('');
    $('sortT').innerHTML = SORT_OPTS.map((o) => '<option value="' + o[0] + '"' + (S.sortT === o[0] ? ' selected' : '') + '>Sort: ' + o[1] + '</option>').join('');
    let rows = src.filter((t) => completedView || matchT(t, S.fT));
    if (S.typeT) rows = rows.filter((t) => t.type === S.typeT);
    if (q) rows = rows.filter((t) => [t.id, t.title, t.state, t.type, t.where, t.assignedTo, t.repos.join(' ')].join(' ').toLowerCase().includes(q));
    const fn = SORT_FN[S.sortT] || SORT_FN.attention;
    rows = rows.slice().sort((a, b) => { const x = fn(a); const y = fn(b); return x > y ? 1 : x < y ? -1 : 0; });
    const openById = /^\d{3,6}$/.test(q) && !src.some((t) => String(t.id) === q)
      ? '<article class="tcard k-neu" tabindex="0" role="button" data-open="' + q + '"><div class="tc-title">Open task #' + q + '</div><div class="tc-warn" style="color:var(--muted)">Not on your board. Open it to read it and add notes.</div></article>' : '';
    const shown = paginate('tasks', rows, [S.status, S.completedDays, S.fT, S.typeT, S.qT, S.sortT].join('|'), 'pagerT');
    $('cardsT').innerHTML = openById + (shown.map(cardHtml).join('') || (completedView && !S.completed
      ? '<div class="empty card" style="grid-column:1/-1"><b>' + (S.completedErr ? 'Could not load completed items' : 'Loading completed items…') + '</b>' + esc(S.completedErr || 'Fetching from Azure DevOps.') + '</div>'
      : '<div class="empty card" style="grid-column:1/-1"><b>Nothing matches</b>Change the filter or search.</div>'));
    $('footT').textContent = completedView
      ? 'Completed items assigned to you, changed in the last ' + S.completedDays + ' days: ' + rows.length + ' of ' + src.length + (S.completed && S.completed.truncated ? ' (more than 300 exist: showing the 300 most recently changed, pick a shorter period)' : '') + ' · loaded on demand'
      : 'Filter "' + FILTERS_T.find((f) => f[0] === S.fT)[1] + '": ' + rows.length + ' of ' + tasks.length + ' tasks · Azure DevOps data from ' + new Date(D.generatedAt).toLocaleTimeString() + ' (refreshed every 5 minutes)';
  } else {
    $('headT').innerHTML = COLS_R.map((c) => '<th>' + c + '</th>').join('');
    let rows = reviews.filter((r) => (S.fR === 'all') || (S.fR === 'human' ? !r.isBot : (!r.isBot && !r.voted)));
    if (q) rows = rows.filter((r) => [r.id, r.title, r.repo, r.author].join(' ').toLowerCase().includes(q));
    rows = rows.slice().sort((a, b) => Date.parse(a.created) - Date.parse(b.created));
    const shown = paginate('reviews', rows, [S.fR, S.qT].join('|'), 'pagerT');
    $('rowsT').innerHTML = shown.map((r) => '<tr><td class="nowrap"><a href="' + esc(r.url) + '" target="_blank" rel="noopener">PR ' + r.id + '</a>' + (r.isDraft ? ' ' + badge('Draft', 'neu') : '') + '</td>'
      + '<td style="min-width:280px"><div class="cell-main">' + esc(r.title) + '</div></td><td>' + esc(r.repo) + '</td>'
      + '<td>' + esc(r.author) + (r.isBot ? ' ' + badge('Automated', 'neu') : '') + '</td>'
      + '<td class="nowrap" title="' + esc(full(r.created)) + '">' + esc(ago(r.created)) + '</td>'
      + '<td>' + badge(r.myVote, r.voted ? (r.myVote.indexOf('Approved') === 0 ? 'ok' : 'warn') : 'neu') + '</td></tr>').join('')
      || '<tr><td colspan="6"><div class="empty"><b>No pull requests here</b>Nothing is waiting for your review with this filter.</div></td></tr>';
    $('footT').textContent = 'Filter "' + FILTERS_R.find((f) => f[0] === S.fR)[1] + '": ' + rows.length + ' of ' + reviews.length + ' active PRs where you are a reviewer · oldest first.'
      + (rows.length < reviews.length ? ' The other ' + (reviews.length - rows.length) + ' are hidden by this filter: choose "Everything" above to see them.' : '');
  }
}

/* ---------- task detail drawer: description from Azure DevOps, notes kept in the hub ---------- */
const drawer = $('drawer');
const drafts = {};
const RICH_OK = new Set(['P', 'BR', 'UL', 'OL', 'LI', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'CODE', 'PRE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'A', 'SPAN', 'DIV', 'HR', 'SUB', 'SUP']);
const RICH_DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON', 'LINK', 'META', 'SVG', 'VIDEO', 'AUDIO', 'TEMPLATE', 'NOSCRIPT']);
// Azure DevOps descriptions are HTML written by anyone. Rebuild them from an allow-list: no attributes except a safe link, images replaced by a note.
function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  const out = document.createElement('div'); let imgs = 0;
  const walk = (src, dst) => {
    for (const n of src.childNodes) {
      if (n.nodeType === 3) { dst.appendChild(document.createTextNode(n.textContent)); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toUpperCase();
      if (tag === 'IMG') { imgs++; continue; }
      if (RICH_DROP.has(tag)) continue;
      if (!RICH_OK.has(tag)) { walk(n, dst); continue; }
      const el = document.createElement(tag.toLowerCase());
      if (tag === 'A') { const h = n.getAttribute('href') || ''; if (/^https?:\/\//i.test(h)) { el.setAttribute('href', h); el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); } }
      walk(n, el); dst.appendChild(el);
    }
  };
  walk(doc.body, out);
  return { node: out, imgs, empty: !out.textContent.trim() && imgs === 0 };
}
const metaItem = (label, v) => (v ? '<div><small>' + label + '</small>' + v + '</div>' : '');

async function openTask(id) {
  S.dr = { id, data: null, editing: null, confirmDel: null };
  $('drKicker').textContent = 'Task #' + id; $('drTitle').textContent = 'Loading…'; $('drBoards').href = ADO + id; $('drBoards').hidden = !ADO;
  $('drBody').innerHTML = '<div class="skel" style="height:70px"></div><div class="skel" style="height:16px;width:80%"></div><div class="skel" style="height:16px;width:60%"></div>';
  if (!drawer.open) drawer.showModal();
  try {
    const data = await api('/api/tasks/' + id);
    if (!S.dr || S.dr.id !== id) return;
    S.dr.data = data; renderDrawer();
  } catch (e) { $('drTitle').textContent = 'Could not open task #' + id; $('drBody').innerHTML = '<div class="note bad">' + esc(e.message) + '</div>'; }
}
async function reloadDrawer() {
  const id = S.dr.id;
  S.dr.data = await api('/api/tasks/' + id);
  renderDrawer(); loadTasks(false); // refreshes the note counts on the cards
}
function noteHtml(n) {
  const sections = S.dr.data.sections;
  if (S.dr.editing === n.id) {
    return '<form class="note-item note-form" data-edit="' + n.id + '"><div class="row"><select name="section" aria-label="Section">' + sections.map((s) => '<option' + (s === n.section ? ' selected' : '') + '>' + esc(s) + '</option>').join('') + '</select></div>'
      + '<div class="field"><textarea name="body" maxlength="8000" aria-label="Note text">' + esc(n.body) + '</textarea></div>'
      + '<div class="row"><span></span><span><button type="button" class="btn sm" data-ncancel="1">Cancel</button> <button type="submit" class="btn sm primary">Save</button></span></div></form>';
  }
  const del = S.dr.confirmDel === n.id
    ? '<span class="muted">Delete this note?</span> <button type="button" class="linkbtn danger" data-ndelok="' + n.id + '">Yes, delete</button><button type="button" class="linkbtn" data-ndelno="1">Keep</button>'
    : '<button type="button" class="linkbtn" data-nedit="' + n.id + '">Edit</button><button type="button" class="linkbtn danger" data-ndel="' + n.id + '">Delete</button>';
  return '<div class="note-item"><div class="note-h">' + badge(n.section, 'info') + '<span class="muted">' + esc(n.author) + ' · <span title="' + esc(full(n.createdAt)) + '">' + esc(ago(n.createdAt)) + '</span>'
    + (n.updatedAt !== n.createdAt ? ' · edited ' + esc(ago(n.updatedAt)) : '') + '</span><span class="note-actions">' + del + '</span></div><div class="note-b">' + esc(n.body) + '</div></div>';
}
function renderDrawer() {
  const { id, data } = S.dr; const d = data.detail; const t = data.task;
  const keep = $('drBody').scrollTop;
  $('drKicker').textContent = ((d && d.type) || (t && t.type) || 'Task') + ' #' + id;
  $('drTitle').textContent = (d && d.title) || (t && t.title) || 'Task #' + id;
  $('drBoards').href = (d && d.url) || ADO + id; $('drBoards').hidden = !ADO && !(d && d.url);
  const sections = data.sections; const draft = drafts[id] || { section: sections[0], body: '' };
  let h = '';
  if (data.error) h += '<div class="note warn"><b>Could not load the description from Azure DevOps.</b> ' + esc(data.error) + ' Your notes below still work.</div>';
  if (d) {
    h += '<div class="meta">' + metaItem('State', badge(d.state, STATE_KIND[d.state] || 'neu') + (d.reason ? ' <span class="muted">' + esc(d.reason) + '</span>' : ''))
      + metaItem('Assigned to', esc(d.assignedTo || 'Unassigned')) + metaItem('Priority', d.priority ? 'P' + d.priority : '') + metaItem('Severity', esc(d.severity)) + metaItem('Story points', d.points ? esc(d.points) : '')
      + metaItem('Area', esc(d.areaPath)) + metaItem('Iteration', esc(d.iterationPath))
      + metaItem('Tags', d.tags.length ? '<div class="chips">' + d.tags.map((x) => '<span class="chip">' + esc(x) + '</span>').join('') + '</div>' : '')
      + metaItem('Created', esc(d.createdBy) + (d.createdDate ? ' · ' + esc(ago(d.createdDate)) : '')) + metaItem('Last changed', d.changedDate ? esc(ago(d.changedDate)) : '')
      + metaItem('Parent', d.parent ? idLink(d.parent) : '') + '</div>';
  }
  if (t) {
    const wb = WHERE_BADGE[t.where] || [t.where, 'neu'];
    h += '<div class="sec"><h3>Code and pull requests</h3><div class="tc-row">' + badge(wb[0], wb[1]) + '</div>'
      + t.attention.map((a) => '<div class="tc-warn" style="margin-top:6px">⚠ ' + esc(a) + '</div>').join('')
      + t.worktrees.map((w) => '<div class="wt-row"><div><b>' + esc(w.branch || '(no branch)') + '</b> <span class="muted">' + esc(w.repoKey) + ' · ' + (w.isMain ? 'live checkout' : 'worktree') + '</span><div class="mono path">' + esc(w.path) + '</div></div>' + statusBadges(w) + '</div>').join('')
      + t.prs.map((p) => '<div class="pr-row"><a href="' + esc(p.url) + '" target="_blank" rel="noopener">PR ' + p.id + '</a>' + badge(p.status === 'active' ? (p.isDraft ? 'Draft' : 'Open') : 'Merged', p.status === 'active' ? 'info' : 'ok')
        + '<span class="muted">' + esc(p.repo) + '</span>' + (p.status === 'active' && p.unresolved ? '<span class="muted">' + p.unresolved + ' open thread(s)</span>' : '')
        + (p.approvals ? '<span class="muted">' + p.approvals + ' approval(s)</span>' : '') + (p.changesRequested ? badge('Changes requested', 'warn') : '') + '</div>').join('')
      + (t.worktrees.length ? '<div style="margin-top:10px"><button type="button" class="btn sm" data-goto="' + id + '">Show in Worktrees</button></div>' : '') + '</div>';
  }
  if (d) {
    const order = d.type === 'Bug' ? [['Repro steps', d.repro], ['Description', d.description], ['Acceptance criteria', d.acceptance]] : [['Description', d.description], ['Acceptance criteria', d.acceptance], ['Repro steps', d.repro]];
    order.forEach((o, i) => { h += '<div class="sec" data-rich="' + i + '"><h3>' + o[0] + '</h3><div class="rich"></div></div>'; });
  }
  h += '<div class="hint-box">' + (ADO || (d && d.url) ? 'The full discussion and comments live in Azure Boards. <a href="' + esc((d && d.url) || ADO + id) + '" target="_blank" rel="noopener">Open this task in Azure Boards</a>. ' : '') + 'The notes below stay in this hub only and are not sent to Azure DevOps.</div>';
  const notes = data.notes;
  h += '<div class="sec"><h3>Your notes and analysis (' + notes.length + ')</h3>'
    + '<form id="noteForm" class="note-form"><div class="row"><select name="section" aria-label="Section">' + sections.map((s) => '<option' + (s === draft.section ? ' selected' : '') + '>' + esc(s) + '</option>').join('') + '</select></div>'
    + '<div class="field"><textarea name="body" maxlength="8000" placeholder="Write your analysis, what you found, a decision, an open question, or the next step…" aria-label="New note">' + esc(draft.body) + '</textarea></div>'
    + '<div class="row"><span class="muted" id="noteCnt">' + draft.body.length + ' / 8000</span><button type="submit" class="btn primary">Add note</button></div></form>'
    + '<div class="note-list">' + (notes.map(noteHtml).join('') || '<div class="muted">No notes yet. What you add here is kept for every session that uses this hub.</div>') + '</div></div>';
  h += '<div class="sec" id="drSessions"><h3>Claude sessions on this task</h3><div class="muted">Looking…</div></div>';
  $('drBody').innerHTML = h;
  loadSessions(id);
  let any = false;
  if (d) {
    const order = d.type === 'Bug' ? [d.repro, d.description, d.acceptance] : [d.description, d.acceptance, d.repro];
    $('drBody').querySelectorAll('[data-rich]').forEach((sec) => {
      const r = sanitizeHtml(order[Number(sec.dataset.rich)]);
      if (r.empty) { sec.remove(); return; }
      any = true; const box = sec.querySelector('.rich'); box.appendChild(r.node);
      if (r.imgs) { const n = document.createElement('div'); n.className = 'hint-box'; n.style.marginTop = '8px'; n.textContent = r.imgs + ' image(s) in this text are not shown here. Open the task in Azure Boards to see them.'; sec.appendChild(n); }
    });
    if (!any) { const n = document.createElement('div'); n.className = 'hint-box'; n.textContent = 'This work item has no description in Azure DevOps.'; $('drBody').querySelector('.hint-box').before(n); }
  }
  $('drBody').scrollTop = keep;
}
async function loadSessions(id) {
  let r;
  try { r = await api('/api/tasks/' + id + '/sessions'); } catch (e) { r = { error: e.message }; }
  const box = $('drSessions'); if (!box || !S.dr || S.dr.id !== id) return;
  let h = '<h3>Claude sessions on this task' + (r.totals && r.totals.sessions ? ' (' + r.totals.sessions + ')' : '') + '</h3>';
  if (r.error) h += '<div class="muted">Could not read sessions: ' + esc(r.error) + '</div>';
  else if (!r.sessions.length) h += '<div class="muted">No sessions found for this task. A session is linked when it ran on a branch named ' + esc((S.me && S.me.branchPrefix) || 'task') + '/' + id + '-…</div>';
  else {
    h += '<div class="muted" style="margin-bottom:8px">' + r.totals.sessions + ' session(s) · ' + r.totals.turns + ' prompts · about $' + r.totals.usd.toFixed(2) + ' (list-price estimate)</div>';
    h += r.sessions.map((s) => '<div class="wt-row"><div><b>' + esc(s.label || '(no prompt recorded)') + '</b><div class="muted">' + esc(ago(s.last)) + ' · ' + s.turns + ' prompts · $' + s.usd.toFixed(2) + ' · <span class="mono">' + esc(s.branch) + '</span>'
      + (s.otherTasks.length ? ' · also worked on ' + s.otherTasks.map((x) => '#' + esc(x)).join(', ') : '') + '</div><div class="mono path">' + esc(s.folder || '') + '</div></div>'
      + '<button type="button" class="btn sm" data-copycmd="claude --resume ' + esc(s.sessionId) + '" title="Run it from the folder shown">Copy resume command</button></div>').join('');
  }
  box.innerHTML = h;
}
function fieldErrs(form, map) {
  form.querySelectorAll('.err').forEach((e) => e.remove()); form.querySelectorAll('.invalid').forEach((e) => e.classList.remove('invalid'));
  Object.entries(map || {}).forEach(([k, msg]) => {
    const el = form.querySelector('[name="' + k + '"]'); if (!el) return;
    el.classList.add('invalid'); const d = document.createElement('div'); d.className = 'err'; d.textContent = msg; (el.closest('.field') || el.parentNode).appendChild(d);
  });
}
$('drBody').addEventListener('submit', async (e) => {
  e.preventDefault(); const f = e.target; if (!S.dr) return;
  const v = Object.fromEntries(new FormData(f).entries()); fieldErrs(f, null);
  const btn = f.querySelector('[type=submit]'); btn.disabled = true;
  try {
    if (f.id === 'noteForm') { await api('/api/notes', { body: { taskId: S.dr.id, section: v.section, body: v.body } }); delete drafts[S.dr.id]; toast('Note added'); }
    else if (f.dataset.edit) { await api('/api/notes/' + f.dataset.edit + '/update', { body: { section: v.section, body: v.body } }); S.dr.editing = null; toast('Note updated'); }
    await reloadDrawer();
  } catch (err) { if (err.fields) fieldErrs(f, err.fields); else toast(err.message, { bad: true }); btn.disabled = false; }
});
$('drBody').addEventListener('input', (e) => {
  const f = e.target.closest('#noteForm'); if (!f || !S.dr) return;
  drafts[S.dr.id] = { section: f.section.value, body: f.body.value };
  $('noteCnt').textContent = f.body.value.length + ' / 8000';
});
$('drBody').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b || !S.dr) return;
  const d = b.dataset;
  try {
    if (d.copycmd) { await navigator.clipboard.writeText(d.copycmd); toast('Command copied. Run it from the session folder.'); }
    else if (d.nedit) { S.dr.editing = Number(d.nedit); S.dr.confirmDel = null; renderDrawer(); const ta = $('drBody').querySelector('[data-edit] textarea'); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } }
    else if (d.ncancel) { S.dr.editing = null; renderDrawer(); }
    else if (d.ndel) { S.dr.confirmDel = Number(d.ndel); S.dr.editing = null; renderDrawer(); }
    else if (d.ndelno) { S.dr.confirmDel = null; renderDrawer(); }
    else if (d.ndelok) { await api('/api/notes/' + d.ndelok + '/delete', { body: {} }); S.dr.confirmDel = null; toast('Note deleted'); await reloadDrawer(); }
  } catch (err) { toast(err.message, { bad: true }); }
});
$('drClose').addEventListener('click', () => drawer.close());
drawer.addEventListener('click', (e) => { if (e.target === drawer) drawer.close(); });
// The close event can arrive late, after the drawer was already reopened for another task: only clear state if it is really closed.
drawer.addEventListener('close', () => { if (!drawer.open) S.dr = null; });

/* ---------- move to live repo ---------- */
function planHtml(p, w) {
  const wt = p.worktree || {}; const lv = p.live || {}; const mg = p.merge || {};
  let h = '<div class="sum"><div class="cell-main">' + esc(wt.branch || w.branch) + '</div><div class="cell-sub">' + esc(w.repoKey) + (w.taskId ? ' · task #' + w.taskId : '') + '</div><div class="mono path">' + esc(w.path) + '</div></div>';
  if (p.blockers.length) h += '<div class="note bad"><b>This worktree cannot be moved</b><ul>' + p.blockers.map((b) => '<li>' + esc(b) + '</li>').join('') + '</ul></div>';
  if (!p.ok) return h;
  const li = [];
  li.push('Fetch <b>origin/main</b>' + (mg.lastFetched ? ' <span class="muted">(last fetched ' + esc(ago(mg.lastFetched)) + ')</span>' : ''));
  li.push(wt.dirtyFiles ? 'Save the worktree\'s <b>' + wt.dirtyFiles + ' uncommitted file(s)</b> as a patch' + (wt.commitsAhead ? '; its ' + wt.commitsAhead + ' commit(s) stay on the branch' : '')
    : 'The worktree has no uncommitted files' + (wt.commitsAhead ? '; its ' + wt.commitsAhead + ' commit(s) stay on the branch' : ''));
  li.push(lv.dirtyFiles ? 'Stash <b>' + lv.dirtyFiles + ' file(s)</b> in the live repo (now on <b>' + esc(lv.branch) + '</b>). It is recorded under <b>Stashes</b> so it stays visible' : 'The live repo is clean, so nothing is stashed');
  li.push('Remove the worktree folder (node_modules links are unlinked, never followed)');
  li.push('Switch the live repo from <b>' + esc(lv.branch) + '</b> to <b>' + esc(wt.branch) + '</b>');
  li.push('Merge origin/main. ' + esc(mg.text || '') + ' <span class="muted">(Predicted from the last fetch; the move fetches first, so the result can differ.)</span>');
  li.push(wt.dirtyFiles ? 'Apply the patch <b>unstaged</b>, so you can run localhost and check' : 'Nothing to apply');
  h += '<div class="field"><label>What will happen in <span class="mono">' + esc(lv.path) + '</span></label><ol class="plan">' + li.map((x) => '<li>' + x + '</li>').join('') + '</ol></div>';
  if (lv.dirtyFiles && lv.files.length) h += '<details><summary>Live files that will be stashed</summary><div class="mono">' + lv.files.map(esc).join('<br>') + (lv.dirtyFiles > lv.files.length ? '<br>…' : '') + '</div></details>';
  (p.warnings || []).forEach((x) => { h += '<div class="note warn">' + esc(x) + '</div>'; });
  h += '<div class="note">Nothing is pushed. If a service is running from this live repo, stop it first.</div>';
  h += '<label class="check"><input type="checkbox" id="f-ack"><span>I understand this changes the live repo at <b>' + esc(lv.path) + '</b>.</span></label>';
  return h;
}
function stepsHtml(m) {
  return m.steps.map((s) => '<div class="pstep ' + esc(s.status) + '"><span class="dot"></span><div><b>' + esc(s.name) + '</b><div class="d">' + esc(s.detail) + '</div></div></div>').join('')
    || '<div class="muted">Starting…</div>';
}
function finalNote(m) {
  const kind = m.status === 'done' ? 'ok' : (m.status === 'done-with-warnings' ? 'warn' : 'bad');
  return '<div class="note ' + kind + '"><b>' + esc(m.status === 'done' ? 'Done' : (m.status === 'done-with-warnings' ? 'Done, with something to check' : 'Stopped')) + '.</b> ' + esc(m.summary || '')
    + (m.patchPath ? '<div class="mono">Patch kept: ' + esc(m.patchPath) + '</div>' : '') + '</div>';
}
async function openMove(path) {
  const w = S.wts.find((x) => x.path === path); if (!w) return;
  openDialog({
    title: 'Move to live repo', ok: 'Move to live repo', body: '<div class="sum"><div class="skel"></div><div class="skel" style="margin-top:8px;width:60%"></div></div><div class="muted">Checking the worktree and the live repo…</div>',
    submit: async () => {
      const res = await api('/api/moves', { body: { path: w.path, ack: true } });
      $('dlgTitle').textContent = 'Moving to live repo…'; $('dlgBody').innerHTML = stepsHtml({ steps: [] });
      $('dlgOk').textContent = 'Running…'; $('dlgOk').disabled = true; $('dlgCancel').hidden = true;
      dlgSubmit = async () => {};
      watchMove(res.id);
      return 'keep';
    },
  });
  $('dlgOk').disabled = true;
  let plan;
  try { plan = await api('/api/moves/plan?path=' + encodeURIComponent(w.path)); }
  catch (e) { $('dlgBody').innerHTML = '<div class="note bad">' + esc(e.message) + '</div>'; return; }
  $('dlgBody').innerHTML = planHtml(plan, w);
  const ack = $('f-ack');
  if (ack) ack.addEventListener('change', () => { $('dlgOk').disabled = !(plan.ok && ack.checked); });
}
async function watchMove(id) {
  dlgMoveId = id;
  let m;
  for (;;) {
    try { m = await api('/api/moves/' + id); } catch (e) { await sleep(1500); continue; }
    if (dlg.open && dlgMoveId === id) $('dlgBody').innerHTML = stepsHtml(m) + (m.status !== 'running' ? finalNote(m) : '');
    if (m.status !== 'running') break;
    await sleep(700);
  }
  if (dlg.open && dlgMoveId === id) { $('dlgTitle').textContent = 'Move finished'; $('dlgOk').textContent = 'Close'; $('dlgOk').disabled = false; }
  await load(true, true);
  toast(m.status === 'failed' ? 'Move stopped. See Live moves for details.' : 'Moved ' + m.branch + ' to the live repo', { bad: m.status === 'failed' });
}

const MOVE_BADGE = { running: ['Running', 'info'], done: ['Done', 'ok'], 'done-with-warnings': ['Done, check warnings', 'warn'], failed: ['Failed', 'bad'], interrupted: ['Interrupted', 'bad'] };
function renderMoves() {
  $('rows3').innerHTML = S.moves.map((m) => {
    const b = MOVE_BADGE[m.status] || [m.status, 'neu'];
    return '<tr><td class="nowrap" title="' + esc(full(m.startedAt)) + '">' + esc(ago(m.startedAt)) + '<div class="cell-sub">' + esc(m.startedBy) + '</div></td>'
      + '<td><div class="cell-main">' + esc(m.branch) + '</div><div class="cell-sub">' + esc(m.repoKey) + (m.prevLiveBranch ? ' · live was on ' + esc(m.prevLiveBranch) : '') + '</div><div class="mono path">' + esc(m.wtPath) + '<br>to ' + esc(m.livePath) + '</div></td>'
      + '<td>' + badge(b[0], b[1]) + '</td>'
      + '<td style="max-width:560px">' + esc(m.summary || 'In progress…') + '<details><summary>Steps</summary>' + stepsHtml(m) + '</details>'
      + (m.patchPath ? '<div class="cell-sub">Patch: <span class="mono">' + esc(m.patchPath) + '</span></div>' : '') + '</td></tr>';
  }).join('') || '<tr><td colspan="4"><div class="empty"><b>No moves yet</b>Use "Move to live…" on a worktree to bring its work into the live repo.</div></td></tr>';
  $('foot3').textContent = S.moves.length + ' move' + (S.moves.length === 1 ? '' : 's') + ' (latest 200). Each move keeps its patch so nothing is lost if a step fails.';
}

const stashNeeds = (s) => s.state === 'stashed' || s.state === 'unknown';
function renderStashes() { if (typeof renderStashMgr === 'function') renderStashMgr(); }
function openHandled(id) {
  const s = S.stashes.find((x) => x.id === id); if (!s) return;
  openDialog({
    title: 'Mark stashed work as handled', ok: 'Mark handled',
    body: '<div class="sum"><div class="cell-main">' + esc(s.repoKey) + ' · ' + s.fileCount + ' file(s) from ' + esc(s.prevBranch) + '</div><div class="mono path">' + esc(s.livePath) + '</div></div>'
      + (s.state === 'stashed' ? '<div class="note warn">This stash is still in the stash list. Marking it handled only removes the reminder; the stash itself is untouched.</div>' : '')
      + '<div class="field"><label for="f-note">Note <span class="muted">(optional)</span></label><input id="f-note" name="note" maxlength="500" placeholder="For example: applied to branch X / not needed any more"></div>',
    submit: async (d) => { await api('/api/stashes/' + id + '/handled', { body: { note: d.note } }); await load(false, true); toast('Marked as handled'); },
  });
}

/* ---------- today's plan ---------- */
S.plan = null; S.ai = null; S.pd = '';
S.pp = { text: '', items: null, meta: null, busy: false, err: '', composing: false, chg: null, editing: null };
const PKINDS = [['task', 'Task'], ['review', 'Review'], ['meeting', 'Meeting'], ['other', 'Other']];
const PTYPES = ['Task', 'Bug', 'User Story'];
const dateLabel = (d) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const shiftDate = (d, n) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return x.toLocaleDateString('en-CA'); };
const cap1 = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);

async function loadPlan(date) {
  try { S.plan = await api('/api/plan' + (date ? '?date=' + date : '')); S.pd = S.plan.date; }
  catch (e) { S.plan = { error: e.message, items: [], recent: [] }; }
  render();
}
async function loadAi() {
  try { S.ai = await api('/api/ai/status'); } catch (e) { S.ai = { available: false, error: e.message }; }
  render();
}
async function copyText(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg || 'Copied'); }
  catch (e) { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); toast(msg || 'Copied'); } catch (x) { toast('Copy failed: select the text by hand', { bad: true }); } t.remove(); }
}
const kindSelect = (cls, kind) => '<select class="' + cls + '" aria-label="Kind">' + PKINDS.map((k) => '<option value="' + k[0] + '"' + (k[0] === kind ? ' selected' : '') + '>' + k[1] + '</option>').join('') + '</select>';
const typeSelect = (cls, type) => '<select class="' + cls + '" aria-label="Work item type">' + PTYPES.map((t) => '<option' + (t === type ? ' selected' : '') + '>' + t + '</option>').join('') + '</select>';

function dateBarHtml(P) {
  const isToday = P.date === P.today;
  return '<div class="datebar"><button type="button" class="btn sm" data-pa="date" data-v="prev" aria-label="Previous day">‹</button><b>' + esc(dateLabel(P.date)) + '</b>'
    + '<button type="button" class="btn sm" data-pa="date" data-v="next" aria-label="Next day">›</button>'
    + (isToday ? badge('Today', 'info') : '<button type="button" class="btn sm" data-pa="date" data-v="today">Back to today</button>')
    + '<span style="flex:1"></span>' + (P.items.length && !S.pp.items ? '<button type="button" class="btn" data-pa="compose">Add more to this plan</button>' : '') + '</div>';
}
function aiLineHtml() {
  const a = S.ai; if (!a) return '';
  if (!a.available) return '<div class="note warn" style="margin-bottom:14px"><b>The AI assistant is not available</b> (' + esc(a.error || 'Claude Code was not found') + '). You can still build your checklist with <b>Match without AI</b>, which uses work item numbers and keywords.</div>';
  const m = a.month || { calls: 0, total: 0, usd: 0 };
  return '<div class="ai-line">Assistant: ' + esc(a.models.parse) + ' reads your plan, ' + esc(a.models.draft) + ' drafts missing work items. This month: ' + m.calls + ' call' + (m.calls === 1 ? '' : 's') + ', ' + fmtTok(m.total) + ' tokens, about ' + fmtUsd(m.usd) + '. <a href="#usage">Token usage</a></div>';
}
function composeHtml(hasItems) {
  const busy = S.pp.busy;
  return '<div class="card compose"><h3>' + (hasItems ? 'Add to today\'s plan' : 'What is your plan for today?') + '</h3>'
    + '<div class="muted">Write it the way you would say it. Mention work item numbers like #5945 or "PR 9820" if you know them. Lines with no work item get a draft title and description for your lead.</div>'
    + '<textarea id="planText" maxlength="4000" placeholder="e.g. Fix the address autolist bug (5945), review Shiva\'s PR 9820, continue the customer portal menu work, 11am standup, and add retry handling for the quotes service">' + esc(S.pp.text) + '</textarea>'
    + (S.pp.err ? '<div class="note bad" style="margin-bottom:10px">' + esc(S.pp.err) + '</div>' : '')
    + '<div class="row"><button type="button" class="btn primary" data-pa="build"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Reading your plan… (5 to 15 seconds)' : 'Build my checklist') + '</button>'
    + '<button type="button" class="btn" data-pa="rules"' + (busy ? ' disabled' : '') + ' title="No AI: matches by work item number and keywords">Match without AI</button>'
    + '<button type="button" class="btn" data-pa="bring"' + (busy ? ' disabled' : '') + '>Bring in yesterday\'s unfinished</button>'
    + (hasItems ? '<button type="button" class="btn" data-pa="cancelCompose">Cancel</button>' : '') + '<span class="grow"></span><span class="muted" id="planCnt">' + S.pp.text.length + ' / 4000 · Ctrl+Enter</span></div></div>';
}
/* ---- worktree links: a task can span several repos, so a line links to a list of worktrees ---- */
const WT_SRC = { task: 'from the task ID', ai: 'suggested', rules: 'by keywords', user: 'chosen by you' };
const wtFromRow = (w, source) => ({ path: w.path, repoKey: w.repoKey, layer: w.layer, branch: w.branch, isMain: !!w.isMain, where: w.where || null, dirtyFiles: w.dirtyFiles || 0, source, missing: false });
function wtChipHtml(w, rm) {
  const st = w.missing ? badge('no longer on disk', 'bad') : (w.dirtyFiles ? '<span class="muted">' + w.dirtyFiles + ' uncommitted</span>' : '');
  return '<span class="chip wtchip' + (w.missing ? ' gone' : '') + '" title="' + esc(w.path) + '"><b>' + esc(w.repoKey) + '</b> <span class="muted">' + esc(w.layer || '') + (w.isMain ? ' · live checkout' : '') + '</span> ' + esc(w.branch) + ' ' + st
    + ' <span class="muted">· ' + (WT_SRC[w.source] || '') + '</span>' + (rm && w.source !== 'task' ? ' <button type="button" class="x" ' + rm + ' aria-label="Unlink this worktree" title="Unlink">×</button>' : '') + '</span>';
}
function wtStripHtml(it, i) {
  const ws = it.worktrees || [];
  let h = '<div class="wtstrip"><span class="wtlab">Code</span>';
  if (ws.length) h += '<span class="wtchips">' + ws.map((w, k) => wtChipHtml(w, 'data-pa="wtrm" data-i="' + i + '" data-k="' + k + '"')).join('') + '</span>';
  else h += '<span class="muted">No worktree found for this task. If you already started, choose it. A task that spans several repos can have one per repo.</span>';
  h += '<button type="button" class="btn sm' + (ws.length ? '' : ' primary') + '" data-pa="wtpick" data-i="' + i + '">' + (ws.length ? 'Link another worktree…' : 'Choose worktree(s)…') + '</button>';
  if (!it.task && it.draft && ws.length) h += '<button type="button" class="btn sm" data-pa="redraft" data-i="' + i + '"' + (it.busy ? ' disabled' : '') + ' title="Rewrite the draft using the commits and changed files of these worktrees">' + (it.busy ? 'Rewriting…' : 'Improve draft with this code') + '</button>';
  return h + '</div>';
}
// Multi-select picker over every worktree the hub knows. `current` rows keep their source; ones linked by task ID cannot be unticked.
function openWtPicker({ title, current, taskId, onDone }) {
  const cur = new Map((current || []).map((w) => [w.path.toLowerCase(), w]));
  const all = S.wts.filter((w) => w.branch && !(w.isMain && /^(main|master|develop)$/i.test(w.branch)) && !(w.clearance && !w.changedSinceCleared));
  const sugg = taskId ? all.filter((w) => w.taskId === taskId) : []; const suggPaths = new Set(sugg.map((w) => w.path));
  const row = (w) => { const c = cur.get(w.path.toLowerCase()); const locked = c && c.source === 'task';
    return '<label class="wtrow" data-s="' + esc((w.repoKey + ' ' + w.branch + ' ' + w.path).toLowerCase()) + '"><input type="checkbox" value="' + esc(w.path) + '"' + (c ? ' checked' : '') + (locked ? ' disabled' : '') + '><span><b>' + esc(w.branch) + '</b> ' + (w.isMain ? badge('live checkout', 'neu') + ' ' : '')
      + '<span class="muted">' + esc(w.where || '') + (w.dirtyFiles ? ' · ' + w.dirtyFiles + ' uncommitted' : '') + (locked ? ' · linked by task ID' : '') + '</span><div class="mono path">' + esc(w.path) + '</div></span></label>'; };
  const byRepo = new Map(); all.filter((w) => !suggPaths.has(w.path)).forEach((w) => { if (!byRepo.has(w.repoKey)) byRepo.set(w.repoKey, []); byRepo.get(w.repoKey).push(w); });
  openDialog({ title, ok: 'Use these worktrees',
    body: '<div class="note">A task can span several repos: tick one worktree in each repo you are working in.</div><div class="field"><input id="wtq" placeholder="Search repo, branch or folder" aria-label="Search worktrees" autocomplete="off"></div>'
      + (sugg.length ? '<div class="wtgrp"><h4>Suggested for this task</h4>' + sugg.map(row).join('') + '</div>' : '')
      + ([...byRepo.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([repo, rows]) => '<div class="wtgrp"><h4>' + esc(repo) + ' <span class="muted">' + esc(rows[0].layer || '') + '</span></h4>' + rows.map(row).join('') + '</div>').join('') || '<div class="muted">No worktrees found.</div>'),
    onOpen: () => { $('wtq').addEventListener('input', (e) => { const q = e.target.value.trim().toLowerCase();
      $('dlgBody').querySelectorAll('.wtrow').forEach((r) => { r.hidden = !!q && !r.dataset.s.includes(q); });
      $('dlgBody').querySelectorAll('.wtgrp').forEach((g) => { g.hidden = ![...g.querySelectorAll('.wtrow')].some((r) => !r.hidden); }); }); },
    submit: async () => {
      const paths = [...new Set([...$('dlgBody').querySelectorAll('input[type=checkbox]:checked')].map((c) => c.value))];
      await onDone(paths.map((p) => { const w = S.wts.find((x) => x.path === p); const c = cur.get(p.toLowerCase()); return { ...wtFromRow(w, c ? c.source : 'user') }; }));
    } });
}

function reviewRowHtml(it, i) {
  const t = it.task; let h = '<div class="prow" data-i="' + i + '"><div class="prow-n">' + (i + 1) + '</div><div>'
    + '<div class="prow-top"><input class="p-text" value="' + esc(it.text) + '" maxlength="200" aria-label="Plan line">' + kindSelect('p-kind', it.kind)
    + '<button type="button" class="icon-btn" data-pa="rm" data-i="' + i + '" title="Remove this line" aria-label="Remove this line"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>';
  if (t) {
    h += '<div class="pcard' + (it.needsConfirm ? ' confirm' : '') + '"><div class="t"><span class="muted">#' + t.id + ' · ' + esc(t.type) + '</span> ' + badge(t.state || '?', STATE_KIND[t.state] || 'neu') + '<b>' + esc(t.title) + '</b>'
      + '<span class="muted">' + (it.needsConfirm ? 'Please confirm this is the right work item' : 'Matched') + (it.reason ? ' · ' + esc(it.reason) : '') + (it.confidence && it.confidence < 1 ? ' · ' + Math.round(it.confidence * 100) + '% sure' : '') + '</span></div>'
      + '<div class="a"><button type="button" class="btn sm" data-open="' + t.id + '">Open</button><button type="button" class="btn sm" data-pa="chg" data-i="' + i + '">Change</button></div></div>';
  } else if (it.kind === 'task' && it.draft) {
    h += '<div class="pdraft"><div><b>No matching work item.</b> <span class="muted">This draft is for your lead to create. Edit it if needed.</span></div>'
      + '<div class="g">' + typeSelect('d-type', it.draft.type) + '<input class="d-title" value="' + esc(it.draft.title) + '" maxlength="120" aria-label="Draft title"></div>'
      + '<textarea class="d-body" aria-label="Draft description">' + esc(it.draft.body) + '</textarea>'
      + '<div><button type="button" class="btn sm" data-pa="chg" data-i="' + i + '">I already have a work item for this</button></div></div>';
  } else if (it.kind === 'review' && it.pr) h += '<div class="cmeta" style="margin-top:8px">' + badge('PR ' + it.pr, 'info') + '</div>';
  if (it.kind === 'task') h += wtStripHtml(it, i);
  if (S.pp.chg === i) {
    h += '<div class="pick"><b>Pick the work item</b>' + (it.alternatives || []).map((a) => a ? '<div class="opt"><span>#' + a.id + ' ' + badge(a.state || '?', STATE_KIND[a.state] || 'neu') + ' ' + esc(a.title) + '</span><button type="button" class="btn sm" data-pa="pick" data-i="' + i + '" data-id="' + a.id + '">Use this</button></div>' : '').join('')
      + '<div class="opt"><span>Another work item number <input id="pickId" inputmode="numeric" placeholder="e.g. 5945"></span><button type="button" class="btn sm primary" data-pa="attach" data-i="' + i + '">Attach</button></div>'
      + '<div class="opt"><span class="muted">Or leave this line without a work item</span><button type="button" class="btn sm" data-pa="none" data-i="' + i + '">No work item</button></div></div>';
  }
  return h + '</div></div>';
}
function reviewHtml() {
  const items = S.pp.items; const m = S.pp.meta || {}; const u = m.usage || {};
  const missing = items.filter((x) => x.kind === 'task' && !x.task).length;
  return '<div class="card review"><div class="hd"><h3>Review your checklist ' + badge(m.engine === 'ai' ? 'AI assistant' : 'Matched by rules', m.engine === 'ai' ? 'info' : 'neu') + '</h3>'
    + '<p class="muted">Check each line and its work item. Nothing is saved until you press Save. Saving to <b>' + esc(dateLabel(S.plan.date)) + '</b>.'
    + (u.calls ? ' This read used ' + u.calls + ' call' + (u.calls > 1 ? 's' : '') + ', ' + fmtTok(u.total) + ' tokens (about ' + fmtUsd(u.usd) + ').' : (m.cached ? ' Served from the last identical request, no tokens used.' : ''))
    + '</p></div>' + (m.notes || []).map((n) => '<div class="note warn" style="margin:10px 18px 0">' + esc(n) + '</div>').join('')
    + items.map(reviewRowHtml).join('')
    + '<div class="foot-row"><span class="muted">' + items.length + ' line' + (items.length === 1 ? '' : 's') + (missing ? ' · ' + missing + ' without a work item (drafts for your lead)' : '') + '</span>'
    + '<span><button type="button" class="btn" data-pa="startover">Start over</button> <button type="button" class="btn primary" data-pa="save"' + (items.length ? '' : ' disabled') + '>Save plan</button></span></div></div>';
}
function draftChip(i) {
  const d = i.draft; if (!d || i.task) return '';
  return d.state === 'requested' ? badge('Requested from lead ' + (d.requestedAt ? ago(d.requestedAt) : ''), 'info') : badge('No work item yet · draft ready', 'warn');
}
function checklistHtml(P) {
  const items = P.items; const live = items.filter((i) => i.status !== 'skipped'); const done = live.filter((i) => i.status === 'done').length;
  const pct = live.length ? Math.round(100 * done / live.length) : 0;
  const drafts = items.filter((i) => i.draft && !i.task && i.draft.state === 'drafted').length;
  const rows = items.map((i) => {
    const t = i.task; const cls = i.status === 'done' ? ' done' : (i.status === 'skipped' ? ' skipped' : '');
    const edit = S.pp.editing === i.id;
    return '<div class="crow' + cls + '" data-id="' + i.id + '"><input type="checkbox" data-pa="toggle" data-id="' + i.id + '"' + (i.status === 'done' ? ' checked' : '') + (i.status === 'skipped' ? ' disabled' : '') + ' aria-label="Done">'
      + '<div><div class="tx">' + (edit ? '<input class="e-text" value="' + esc(i.text) + '" maxlength="200" aria-label="Edit line">' : esc(i.text)) + '</div><div class="cmeta">'
      + badge(cap1(i.kind), 'neu')
      + (t ? '<span class="chip tlink" role="button" tabindex="0" data-open="' + t.id + '" title="Open details">#' + t.id + (t.title ? ' ' + esc(t.title.slice(0, 70)) : '') + '</span>' + (t.state ? badge(t.state, STATE_KIND[t.state] || 'neu') : '') + (t.where && WHERE_BADGE[t.where] ? badge(WHERE_BADGE[t.where][0], WHERE_BADGE[t.where][1]) : '') + (t.noteCount ? '<span class="notepill">' + t.noteCount + ' note' + (t.noteCount > 1 ? 's' : '') + '</span>' : '') : '')
      + draftChip(i)
      + (i.looksDone ? badge('Looks done: ' + ((t && t.where === 'Merged') ? 'PR merged' : 'work item is ' + (t && t.state)), 'ok') + '<button type="button" class="linkbtn" data-pa="toggle" data-id="' + i.id + '" data-v="done">Mark done</button>' : '')
      + (i.status === 'skipped' ? '<span class="muted">Dropped' + (i.skipReason ? ': ' + esc(i.skipReason) : '') + '</span>' : '')
      + (i.carriedFrom ? '<span class="muted">carried over</span>' : '') + '</div>'
      + (i.kind === 'task' && i.status !== 'skipped' ? '<div class="cmeta"><span class="wtlab">Code</span>' + ((i.worktrees || []).length ? i.worktrees.map((w) => wtChipHtml(w, 'data-pa="wtunlink" data-id="' + i.id + '" data-p="' + esc(w.path) + '"')).join('') : '<span class="muted">No worktree linked</span>') + '</div>' : '') + '</div>'
      + '<div class="acts">' + (edit ? '<button type="button" class="linkbtn" data-pa="editsave" data-id="' + i.id + '">Save</button><button type="button" class="linkbtn" data-pa="editcancel">Cancel</button>'
        : (i.status === 'todo' ? '<button type="button" class="linkbtn" data-pa="toggle" data-id="' + i.id + '" data-v="done">Mark done</button>' : (i.status === 'done' ? '<button type="button" class="linkbtn" data-pa="toggle" data-id="' + i.id + '" data-v="todo">Reopen</button>' : ''))
        + '<button type="button" class="linkbtn" data-pa="edit" data-id="' + i.id + '">Edit</button>'
        + (i.kind === 'task' ? '<button type="button" class="linkbtn" data-pa="wtlink" data-id="' + i.id + '">Link worktree</button>' : '')
        + (i.kind === 'task' && !t ? '<button type="button" class="linkbtn" data-pa="draft" data-id="' + i.id + '">' + (i.draft ? 'Draft' : 'Draft for lead') + '</button><button type="button" class="linkbtn" data-pa="attachSaved" data-id="' + i.id + '">Attach work item</button>' : '')
        + (i.status === 'skipped' ? '<button type="button" class="linkbtn" data-pa="restore" data-id="' + i.id + '">Restore</button>' : (i.status === 'todo' ? '<button type="button" class="linkbtn" data-pa="skip" data-id="' + i.id + '">Drop</button>' : ''))
        + '<button type="button" class="linkbtn danger" data-pa="del" data-id="' + i.id + '">Delete</button>') + '</div></div>';
  }).join('');
  return '<div><div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px"><b>' + done + ' of ' + live.length + ' done</b><span>'
    + (drafts ? '<button type="button" class="btn sm" data-pa="leadmsg">Copy ' + drafts + ' draft' + (drafts > 1 ? 's' : '') + ' as one message for my lead</button> ' : '')
    + '<button type="button" class="btn sm primary" data-pa="close">Close the day</button></span></div>'
    + '<div class="progress"><span style="width:' + pct + '%"></span></div><div class="card">' + rows
    + '<div class="addline"><input id="addLine" placeholder="Add a line… (type #5945 to link a work item)" maxlength="200" aria-label="Add a line"><button type="button" class="btn" data-pa="addline">Add</button></div></div></div>';
}
function scoreHtml(s) {
  const cls = s.score >= 75 ? '' : (s.score >= 50 ? ' mid' : ' low');
  return '<div class="card score"><div class="score-n' + cls + '" title="60% adherence + 30% work item coverage + 10% no carry-over">' + s.score + '</div><div><b>Day score</b><div class="muted">' + s.done + ' of ' + (s.planned - s.dropped) + ' finished'
    + (s.dropped ? ', ' + s.dropped + ' dropped on purpose' : '') + '</div></div><div class="st"><div><small>Adherence</small><b>' + s.adherence + '%</b></div><div><small>Work item coverage</small><b>' + s.coverage + '%</b></div>'
    + '<div><small>Carried over</small><b>' + s.carried + '</b></div><div><small>No work item</small><b>' + s.missingWorkItems + '</b></div></div>'
    + (s.unplanned && s.unplanned.length ? '<div style="flex-basis:100%"><small class="muted">YOU ALSO WORKED ON (NOT IN THE PLAN)</small><div class="chips" style="margin-top:4px">' + s.unplanned.map((u) => '<span class="chip tlink" role="button" tabindex="0" data-open="' + u.id + '">#' + u.id + ' ' + esc(String(u.title).slice(0, 50)) + '</span>').join('') + '</div></div>' : '') + '</div>';
}
function recentHtml(P) {
  const r = (P.recent || []).filter((d) => d.date !== P.date || true);
  if (!r.length) return '';
  return '<div style="margin-top:18px"><small class="muted">RECENT DAYS</small><div class="recent">' + r.map((d) => '<button type="button" data-pa="date" data-v="' + d.date + '"' + (d.date === P.date ? ' aria-current="true"' : '') + '>' + esc(new Date(d.date + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' }))
    + (d.score ? '<b>' + d.score.score + '</b>' : '<span class="muted"> open</span>') + '</button>').join('') + '</div></div>';
}

function renderPlan(force) {
  const body = $('planBody');
  if (!S.plan) { body.innerHTML = '<div class="skel" style="height:44px;margin-bottom:12px"></div><div class="skel" style="height:160px"></div>'; loadPlan(S.pd); if (!S.ai) loadAi(); return; }
  if (!S.ai) loadAi();
  const a = document.activeElement; // do not wipe what you are typing when the page refreshes in the background
  if (!force && a && body.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
  const P = S.plan;
  if (P.error) { body.innerHTML = '<div class="note bad">Could not load the plan: ' + esc(P.error) + ' <button type="button" class="btn sm" data-pa="reload">Try again</button></div>'; return; }
  let h = dateBarHtml(P) + aiLineHtml();
  if (S.pp.items) h += reviewHtml();
  else if (!P.items.length || S.pp.composing) h += composeHtml(P.items.length > 0);
  if (P.day && P.day.closedAt && P.day.score) h += scoreHtml(P.day.score);
  if (P.items.length && !S.pp.items) h += checklistHtml(P);
  h += recentHtml(P);
  body.innerHTML = h;
}

async function buildPlan(rules) {
  const text = S.pp.text.trim();
  if (!text) { toast('Write your plan first', { bad: true }); return; }
  S.pp.busy = true; S.pp.err = ''; renderPlan(true);
  try {
    const r = await api('/api/plan/parse', { body: { text: S.pp.text, mode: rules ? 'rules' : 'auto' } });
    S.pp.meta = r; S.pp.chg = null;
    S.pp.items = r.items.map((x) => ({ ...x, draft: x.draft ? { ...x.draft } : null, // _p remembers what was proposed, so saving can record what you accepted or changed
      _p: { taskId: x.taskId, confidence: x.confidence, kind: x.kind, engine: r.engine, draft: x.draft ? { title: x.draft.title, body: x.draft.body } : null, worktrees: (x.worktrees || []).filter((w) => w.source !== 'task').map((w) => w.path) } }));
  } catch (e) { S.pp.err = e.message; }
  S.pp.busy = false; renderPlan(true); loadAi();
}
async function attachById(id, apply) {
  const n = Number(String(id).replace(/\D/g, ''));
  if (!Number.isInteger(n) || n < 1) { toast('Enter a work item number', { bad: true }); return false; }
  try { const r = await api('/api/tasks/' + n); if (!r.detail) { toast(r.error || 'That work item could not be read', { bad: true }); return false; } apply(n, r.detail); return true; }
  catch (e) { toast(e.message, { bad: true }); return false; }
}
async function planAct(a, el) {
  const I = Number(el.dataset.i); const id = Number(el.dataset.id); const it = S.pp.items && S.pp.items[I];
  const reload = async () => { await loadPlan(S.pd); };
  switch (a) {
    case 'reload': return loadPlan(S.pd);
    case 'date': { const v = el.dataset.v; const t = S.plan ? S.plan.date : S.pd; S.pp.items = null; S.pp.composing = false; S.pp.chg = null; S.pp.editing = null;
      return loadPlan(v === 'prev' ? shiftDate(t, -1) : v === 'next' ? shiftDate(t, 1) : v === 'today' ? '' : v); }
    case 'compose': S.pp.composing = true; return renderPlan(true);
    case 'cancelCompose': S.pp.composing = false; S.pp.err = ''; return renderPlan(true);
    case 'build': return buildPlan(false);
    case 'rules': return buildPlan(true);
    case 'bring': {
      try {
        const y = await api('/api/plan?date=' + shiftDate(S.plan.date, -1));
        const left = y.items.filter((x) => x.status === 'todo');
        if (!left.length) return toast('Nothing unfinished from the day before');
        S.pp.text = (S.pp.text ? S.pp.text.trim() + '\n' : '') + left.map((x) => x.text + (x.taskId ? ' (#' + x.taskId + ')' : '')).join('\n');
        return renderPlan(true);
      } catch (e) { return toast(e.message, { bad: true }); }
    }
    case 'startover': S.pp.items = null; S.pp.meta = null; S.pp.chg = null; return renderPlan(true);
    case 'rm': S.pp.items.splice(I, 1); S.pp.chg = null; return renderPlan(true);
    case 'chg': S.pp.chg = S.pp.chg === I ? null : I; return renderPlan(true);
    case 'pick': { const alt = (it.alternatives || []).find((x) => x && x.id === id); if (alt) { it.task = alt; it.taskId = alt.id; it.confidence = 1; it.needsConfirm = false; it.reason = 'You picked this'; it.draft = null; S.pp.chg = null; } return renderPlan(true); }
    case 'none': it.task = null; it.taskId = null; it.confidence = 0; it.needsConfirm = false; if (it.kind === 'task') it.draft = it.draft || { type: 'Task', title: cap1(it.text).slice(0, 120), body: '' }; S.pp.chg = null; return renderPlan(true);
    case 'attach': { const v = ($('pickId') || {}).value;
      if (await attachById(v, (n, d) => { it.task = { id: n, type: d.type, state: d.state, title: d.title }; it.taskId = n; it.confidence = 1; it.needsConfirm = false; it.reason = 'You entered this ID'; it.draft = null; S.pp.chg = null; })) renderPlan(true); return; }
    case 'wtpick': return openWtPicker({ title: 'Choose worktrees for this line', current: it.worktrees, taskId: it.taskId,
      onDone: async (rows) => { it.worktrees = rows; renderPlan(true); } });
    case 'wtrm': it.worktrees.splice(Number(el.dataset.k), 1); return renderPlan(true);
    case 'redraft': {
      it.busy = true; renderPlan(true);
      try { const r = await api('/api/plan/redraft', { body: { text: it.text, worktrees: it.worktrees.map((w) => w.path) } }); it.draft = r.draft; toast('Draft rewritten using ' + it.worktrees.length + ' worktree' + (it.worktrees.length > 1 ? 's' : '')); }
      catch (e) { toast(e.message, { bad: true }); }
      it.busy = false; renderPlan(true); loadAi(); return;
    }
    case 'wtlink': {
      const t = S.plan.items.find((x) => x.id === id); if (!t) return undefined;
      return openWtPicker({ title: 'Link worktrees to this line', current: t.worktrees.filter((w) => !w.missing), taskId: t.taskId,
        onDone: async (rows) => { await api('/api/plan/items/' + id + '/update', { body: { worktrees: rows.map((w) => ({ path: w.path, source: w.source })) } }); await loadPlan(S.pd); toast('Worktrees linked'); } });
    }
    case 'wtunlink': {
      const t = S.plan.items.find((x) => x.id === id); if (!t) return undefined;
      const keep = t.worktrees.filter((w) => w.source !== 'task' && !w.missing && w.path !== el.dataset.p).map((w) => ({ path: w.path, source: w.source }));
      try { await api('/api/plan/items/' + id + '/update', { body: { worktrees: keep } }); await reload(); } catch (e) { toast(e.message, { bad: true }); }
      return undefined;
    }
    case 'save': {
      try {
        const body = { date: S.plan.date, rawText: S.pp.text, items: S.pp.items.map((x) => ({ text: x.text, kind: x.kind, taskId: x.taskId, confidence: x.confidence, draft: !x.taskId && x.kind === 'task' ? x.draft : null,
          worktrees: x.kind === 'task' ? (x.worktrees || []).map((w) => ({ path: w.path, source: w.source })) : [], proposal: x._p || null })) };
        S.plan = await api('/api/plan/save', { body });
        toast('Plan saved: ' + body.items.length + ' line' + (body.items.length > 1 ? 's' : ''));
        S.pp.items = null; S.pp.meta = null; S.pp.text = ''; S.pp.composing = false; S.pp.chg = null; render();
      } catch (e) { toast(e.message, { bad: true }); }
      return;
    }
    case 'toggle': {
      const cur = S.plan.items.find((x) => x.id === id); const next = el.dataset.v === 'done' ? 'done' : (el.checked ? 'done' : 'todo');
      try { await api('/api/plan/items/' + id + '/update', { body: { status: next } }); await reload(); } catch (e) { toast(e.message, { bad: true }); if (cur) renderPlan(true); }
      return;
    }
    case 'edit': S.pp.editing = id; renderPlan(true); { const inp = $('planBody').querySelector('.e-text'); if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); } } return;
    case 'editcancel': S.pp.editing = null; return renderPlan(true);
    case 'editsave': { const v = ($('planBody').querySelector('.e-text') || {}).value;
      try { await api('/api/plan/items/' + id + '/update', { body: { text: v } }); S.pp.editing = null; await reload(); } catch (e) { toast(e.message, { bad: true }); } return; }
    case 'restore': try { await api('/api/plan/items/' + id + '/update', { body: { status: 'todo' } }); await reload(); } catch (e) { toast(e.message, { bad: true }); } return;
    case 'skip': return openSkip(id);
    case 'del': return openDelete(id);
    case 'draft': return openDraft(id);
    case 'attachSaved': return openAttach(id);
    case 'leadmsg': return copyLeadMessage();
    case 'close': return openCloseDay();
    case 'addline': return addLine();
    default: return undefined;
  }
}
async function addLine() {
  const el = $('addLine'); const raw = (el.value || '').trim(); if (!raw) return;
  const m = /#(\d{3,6})\b/.exec(raw); const text = raw.replace(/#\d{3,6}\b/, '').replace(/\s+/g, ' ').trim() || raw;
  try { S.plan = await api('/api/plan/items', { body: { date: S.plan.date, text, kind: 'task', taskId: m ? Number(m[1]) : null } }); render(); const n = $('addLine'); if (n) n.focus(); }
  catch (e) { toast(e.message, { bad: true }); }
}
function openSkip(id) {
  const it = S.plan.items.find((x) => x.id === id); if (!it) return;
  openDialog({ title: 'Drop this line', ok: 'Drop it', body: '<div class="sum"><div class="cell-main">' + esc(it.text) + '</div></div><div class="field"><label for="f-why">Why? <span class="muted">(optional)</span></label><input id="f-why" name="why" maxlength="300" placeholder="For example: someone else did it, or it is no longer needed"></div>',
    submit: async (d) => { await api('/api/plan/items/' + id + '/update', { body: { status: 'skipped', skipReason: d.why } }); await loadPlan(S.pd); } });
}
function openDelete(id) {
  const it = S.plan.items.find((x) => x.id === id); if (!it) return;
  openDialog({ title: 'Delete this line', ok: 'Delete', danger: true, body: '<div class="sum"><div class="cell-main">' + esc(it.text) + '</div></div><div class="note warn">This removes the line and its draft from the plan. It does not touch any work item.</div>',
    submit: async () => { await api('/api/plan/items/' + id + '/delete', { body: {} }); await loadPlan(S.pd); } });
}
function openAttach(id) {
  const it = S.plan.items.find((x) => x.id === id); if (!it) return;
  openDialog({ title: 'Attach a work item', ok: 'Attach', body: '<div class="sum"><div class="cell-main">' + esc(it.text) + '</div></div><div class="field"><label for="f-wi">Work item number</label><input id="f-wi" name="wi" inputmode="numeric" placeholder="e.g. 5945"></div>',
    submit: async (d) => {
      const n = Number(String(d.wi).replace(/\D/g, ''));
      if (!Number.isInteger(n) || n < 1) { const e = new Error('Enter a work item number'); e.fields = { wi: 'Enter a work item number.' }; throw e; }
      await api('/api/plan/items/' + id + '/update', { body: { taskId: n } }); await loadPlan(S.pd); toast('Attached #' + n);
    } });
}
async function openDraft(id) {
  let it = S.plan.items.find((x) => x.id === id); if (!it) return;
  if (!it.draft) { try { await api('/api/plan/items/' + id + '/update', { body: { draft: { type: 'Task', title: cap1(it.text).slice(0, 120), body: '' } } }); await loadPlan(S.pd); it = S.plan.items.find((x) => x.id === id); } catch (e) { return toast(e.message, { bad: true }); } }
  const d = it.draft;
  openDialog({ title: 'Draft work item for your lead', ok: 'Save changes',
    body: '<div class="note">Azure DevOps is not changed from here. Copy this to your lead, then record what happened below.</div>'
      + '<div class="field"><label>Type</label>' + typeSelect('', d.type).replace('<select class=""', '<select name="type"') + '</div>'
      + '<div class="field"><label for="d-t">Title</label><input id="d-t" name="title" value="' + esc(d.title) + '" maxlength="120"></div>'
      + '<div class="field"><label for="d-b">Description</label><textarea id="d-b" name="body" style="min-height:190px">' + esc(d.body) + '</textarea></div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn sm" id="d-c1">Copy title</button><button type="button" class="btn sm" id="d-c2">Copy description</button><button type="button" class="btn sm" id="d-c3">Copy both</button>'
      + ((it.worktrees || []).filter((w) => !w.missing).length ? '<button type="button" class="btn sm" id="d-ai" title="Rewrite title and description using the commits and changed files of the linked worktrees">Improve with linked code</button>' : '<span class="muted">Link a worktree to this line and the draft can use your code.</span>') + '</div>'
      + '<div class="sum"><b>Status: ' + (d.state === 'created' ? 'created by your lead as #' + d.createdTaskId : d.state === 'requested' ? 'requested ' + esc(ago(d.requestedAt)) : 'draft only') + '</b>'
      + (d.state !== 'created' ? '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:6px">' + (d.state === 'drafted' ? '<button type="button" class="btn sm" id="d-req">Mark as requested</button>' : '')
        + '<input id="d-id" inputmode="numeric" placeholder="ID your lead created" style="width:170px;font:inherit;padding:5px 9px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--fg)"><button type="button" class="btn sm primary" id="d-link">Link it to this line</button></div>' : '') + '</div>',
    onOpen: () => {
      const val = () => ({ title: $('d-t').value, body: $('d-b').value, type: $('dlgBody').querySelector('[name=type]').value });
      const lines = () => { const v = val(); return { t: v.title, b: v.body }; };
      $('d-c1').onclick = () => copyText(lines().t, 'Title copied');
      $('d-c2').onclick = () => copyText(lines().b, 'Description copied');
      $('d-c3').onclick = () => copyText(lines().t + '\n\n' + lines().b, 'Title and description copied');
      if ($('d-ai')) $('d-ai').onclick = async () => {
        $('d-ai').disabled = true; $('d-ai').textContent = 'Rewriting…';
        try { const r = await api('/api/plan/redraft', { body: { text: it.text, worktrees: it.worktrees.filter((w) => !w.missing).map((w) => w.path) } }); $('d-t').value = r.draft.title; $('d-b').value = r.draft.body; const sel = $('dlgBody').querySelector('[name=type]'); if (sel) sel.value = r.draft.type; toast('Draft rewritten. Review it, then Save changes.'); loadAi(); }
        catch (e) { toast(e.message, { bad: true }); }
        $('d-ai').disabled = false; $('d-ai').textContent = 'Improve with linked code';
      };
      const saveFirst = async () => { await api('/api/plan/items/' + id + '/update', { body: { draft: val() } }); };
      if ($('d-req')) $('d-req').onclick = async () => { try { await saveFirst(); await api('/api/plan/items/' + id + '/update', { body: { draftState: 'requested' } }); dlg.close(); await loadPlan(S.pd); toast('Marked as requested'); } catch (e) { toast(e.message, { bad: true }); } };
      if ($('d-link')) $('d-link').onclick = async () => { try { await saveFirst(); await api('/api/plan/items/' + id + '/update', { body: { draftState: 'created', createdTaskId: $('d-id').value.replace(/\D/g, '') } }); dlg.close(); await loadPlan(S.pd); toast('Linked: the line now points to the new work item'); } catch (e) { toast(e.message, { bad: true }); } };
    },
    submit: async (v) => { await api('/api/plan/items/' + id + '/update', { body: { draft: { type: v.type, title: v.title, body: v.body } } }); await loadPlan(S.pd); toast('Draft saved'); } });
}
function copyLeadMessage() {
  const list = S.plan.items.filter((i) => i.draft && !i.task && i.draft.state === 'drafted');
  if (!list.length) return toast('No drafts waiting');
  const ind = (s) => String(s || '').split('\n').map((l) => '   ' + l).join('\n');
  const msg = 'Hi,\n\nCould you please create these work items for me? I have written a title and description for each.\n\n'
    + list.map((i, n) => (n + 1) + '. [' + i.draft.type + '] ' + i.draft.title + (i.draft.body ? '\n' + ind(i.draft.body) : '')).join('\n\n') + '\n\nThanks';
  copyText(msg, 'Message for your lead copied');
  toast(list.length + ' draft' + (list.length > 1 ? 's' : '') + ' copied. Mark them as requested?', { action: { label: 'Mark requested', run: async () => {
    try { for (const i of list) await api('/api/plan/items/' + i.id + '/update', { body: { draftState: 'requested' } }); await loadPlan(S.pd); toast('Marked as requested'); } catch (e) { toast(e.message, { bad: true }); } } } });
}
function openCloseDay() {
  const P = S.plan; const todo = P.items.filter((i) => i.status === 'todo');
  const body = todo.length
    ? '<div class="muted">Choose what happens to each unfinished line.</div>' + todo.map((i) => '<div class="cl-row"><div>' + esc(i.text) + '</div><select name="a-' + i.id + '" data-cid="' + i.id + '"><option value="carry">Carry to tomorrow</option><option value="drop">Drop it</option><option value="keep">Leave it</option></select><input name="r-' + i.id + '" maxlength="300" placeholder="Why drop it?" hidden></div>').join('')
    : '<div class="note ok">Everything is done or dropped. Close the day to see your score.</div>';
  openDialog({ title: 'Close the day', ok: 'Close the day', body,
    onOpen: () => { $('dlgBody').querySelectorAll('select[data-cid]').forEach((s) => s.addEventListener('change', () => { const r = $('dlgBody').querySelector('[name="r-' + s.dataset.cid + '"]'); r.hidden = s.value !== 'drop'; if (!r.hidden) r.focus(); })); },
    submit: async (v) => {
      const carry = []; const drop = [];
      for (const i of todo) { const a = v['a-' + i.id]; if (a === 'carry') carry.push(i.id); else if (a === 'drop') { const r = (v['r-' + i.id] || '').trim(); if (!r) { const e = new Error('Give a reason for each dropped line'); e.fields = { ['r-' + i.id]: 'Give a reason.' }; throw e; } drop.push({ id: i.id, reason: r }); } }
      const res = await api('/api/plan/close', { body: { date: P.date, carry, drop } });
      S.plan = res; S.pp.items = null; render();
      const s = res.score;
      $('dlgTitle').textContent = 'Day closed: score ' + s.score;
      $('dlgBody').innerHTML = '<div class="sum"><b>' + s.done + ' of ' + (s.planned - s.dropped) + ' finished</b><div class="muted">Adherence ' + s.adherence + '% · work item coverage ' + s.coverage + '% · ' + s.carried + ' carried over · ' + s.missingWorkItems + ' line(s) without a work item</div></div>'
        + (res.carriedTo ? '<div class="note">Carried lines are on the plan for ' + esc(dateLabel(res.carriedTo)) + '.</div>' : '')
        + (s.unplanned.length ? '<div class="note warn">You also worked on ' + s.unplanned.length + ' thing' + (s.unplanned.length > 1 ? 's' : '') + ' that were not in the plan: ' + s.unplanned.map((u) => '#' + u.id).join(', ') + '</div>' : '');
      $('dlgOk').textContent = 'Done'; dlgSubmit = async () => {}; $('dlgCancel').hidden = true; return 'keep';
    } });
}

$('planBody').addEventListener('click', (e) => {
  if (e.target.matches('input[type=checkbox][data-pa]')) return; // handled on change
  const b = e.target.closest('[data-pa]'); if (!b || b.matches('input[type=checkbox]')) return;
  planAct(b.dataset.pa, b);
});
$('planBody').addEventListener('change', (e) => {
  const t = e.target;
  if (t.matches('input[type=checkbox][data-pa]')) return planAct(t.dataset.pa, t);
  const row = t.closest('[data-i]'); if (!row || !S.pp.items) return; const it = S.pp.items[Number(row.dataset.i)]; if (!it) return;
  if (t.classList.contains('p-kind')) { it.kind = t.value; if (it.kind === 'task' && !it.task && !it.draft) it.draft = { type: 'Task', title: cap1(it.text).slice(0, 120), body: '' }; renderPlan(true); }
  else if (t.classList.contains('d-type') && it.draft) it.draft.type = t.value;
});
$('planBody').addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'planText') { S.pp.text = t.value; const c = $('planCnt'); if (c) c.textContent = t.value.length + ' / 4000 · Ctrl+Enter'; return; }
  const row = t.closest('[data-i]'); if (!row || !S.pp.items) return; const it = S.pp.items[Number(row.dataset.i)]; if (!it) return;
  if (t.classList.contains('p-text')) it.text = t.value;
  else if (t.classList.contains('d-title') && it.draft) it.draft.title = t.value;
  else if (t.classList.contains('d-body') && it.draft) it.draft.body = t.value;
});
$('planBody').addEventListener('keydown', (e) => {
  const t = e.target;
  if (t.id === 'planText' && (e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); buildPlan(false); }
  else if (t.id === 'addLine' && e.key === 'Enter') { e.preventDefault(); addLine(); }
  else if (t.id === 'pickId' && e.key === 'Enter') { e.preventDefault(); const b = $('planBody').querySelector('[data-pa=attach]'); if (b) planAct('attach', b); }
  else if (t.classList.contains('e-text')) { if (e.key === 'Enter') { e.preventDefault(); planAct('editsave', $('planBody').querySelector('[data-pa=editsave]')); } else if (e.key === 'Escape') { e.preventDefault(); S.pp.editing = null; renderPlan(true); } }
  else if (t.matches('.tlink[data-open]') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openTask(Number(t.dataset.open)); }
});

/* ---------- data safety: database health and backups ---------- */
S.health = null;
async function loadHealth() {
  try { S.health = await api('/api/health'); } catch (e) { S.health = { error: e.message }; }
  renderSafety();
}
function renderSafety() {
  const b = $('safety'); const h = S.health; if (!b) return;
  let cls = 'warn'; let txt = 'Backups: checking…';
  if (h && h.error) txt = 'Data safety: unknown';
  else if (h) {
    const bk = h.backups; const dbOk = h.db.quickCheck === 'ok';
    if (!dbOk) { cls = 'bad'; txt = 'Database needs attention'; }
    else if (!bk.newest) { cls = 'warn'; txt = 'No backup yet'; }
    else if (bk.lastError) { cls = 'bad'; txt = 'Backup failed'; }
    else { cls = bk.ok ? 'ok' : 'warn'; txt = 'Backed up ' + ago(bk.newest.at); }
  }
  b.className = 'safety ' + cls; $('safetyText').textContent = txt;
}
function openSafety() {
  const h = S.health; if (!h || h.error) { toast('Could not read the data safety status', { bad: true }); return; }
  const d = h.db; const bk = h.backups; const c = d.counts;
  openDialog({ title: 'Data safety', ok: 'Back up now',
    body: '<div class="sum"><b>Database</b><div class="muted">' + esc(d.journalMode.toUpperCase()) + ' mode · schema v' + d.schemaVersion + ' · integrity ' + esc(d.quickCheck) + ' · ' + Math.max(1, Math.round(d.sizeBytes / 1024)) + ' KB</div>'
      + '<div>' + c.notes + ' notes · ' + c.planItems + ' plan lines · ' + c.moves + ' moves · ' + c.stashes + ' stashes · ' + c.clearances + ' clearances</div></div>'
      + '<div class="sum"><b>Backups</b> <span class="muted">(daily, verified, in a folder outside the hub)</span><div class="mono path">' + esc(bk.dir) + '</div>'
      + (bk.recent.length ? bk.recent.map((x) => '<div>' + esc(ago(x.at)) + ' <span class="muted">· ' + Math.round(x.bytes / 1024) + ' KB · ' + esc(x.label) + '</span></div>').join('') : '<div class="muted">No backups yet.</div>')
      + '<div class="muted" style="margin-top:6px">Weekly readable export: ' + esc(bk.lastExport || 'none yet') + '</div>' + (bk.lastError ? '<div class="note bad" style="margin-top:6px">' + esc(bk.lastError) + '</div>' : '') + '</div>'
      + '<div class="note">Only the hub writes to the database. Other programs use the local API, or drop a small JSON file in <span class="mono">' + esc(h.inbox.dir) + '</span> (' + h.inbox.pending + ' waiting, ' + h.inbox.rejected + ' rejected so far).</div>'
      + '<div class="note warn">If the database is ever damaged: stop the hub, then run <span class="mono">node "' + esc(((S.me && S.me.hubDir) || '.') + '\\bin\\restore.js') + '" --latest</span>. The damaged file is kept, not deleted.</div>',
    submit: async () => { const r = await api('/api/backup', { body: {} }); toast('Backup saved: ' + r.backup.name); await loadHealth(); } });
}
$('safety').addEventListener('click', openSafety);

/* ---------- workflow ratings ---------- */
S.ratings = null; let ratingsTimer = null;
async function loadRatings() {
  try { S.ratings = await api('/api/scorecard'); } catch (e) { S.ratings = { error: e.message }; }
  render();
  if (S.ratings && S.ratings.status === 'running') { clearTimeout(ratingsTimer); ratingsTimer = setTimeout(loadRatings, 1500); }
}
async function runRatings() {
  try { await api('/api/scorecard/run', { body: {} }); } catch (e) { toast(e.message, { bad: true }); return; }
  loadRatings();
}
const scKind = (s) => (s === null || s === undefined ? 'na' : s >= 7 ? 'ok' : s >= 4 ? 'warn' : 'bad');
const scTxt = (s) => (s === null || s === undefined ? '–' : String(s));
function scChip(label, s, base) {
  const d = base !== undefined && base !== null && s !== null && s !== undefined ? Math.round((s - base) * 10) / 10 : null;
  return '<div class="sc ' + scKind(s) + '"><small>' + label + '</small><b>' + scTxt(s) + '</b>' + (d === null || d === 0 ? '' : '<span class="d ' + (d > 0 ? 'up' : 'down') + '">' + (d > 0 ? '▲ +' : '▼ ') + d + '</span>') + '</div>';
}
function featureChips(a, ad) {
  const c = (t) => '<span class="chip">' + t + '</span>'; const used = (n) => (n > 0 ? 'ok' : 'warn');
  const out = [];
  const add = (label, n, unit) => out.push(badge(label + ': ' + n + (unit ? ' ' + unit : ''), used(n)));
  if (a.id === 'design') { add('Move to live', ad.moves.count, 'used'); add('Clear', ad.clearances.count, 'used'); }
  if (a.id === 'lessons') add('Hub notes', ad.notes.count, 'written');
  if (a.id === 'sessions') { add('Hub notes', ad.notes.count, 'on ' + ad.notes.tasks + ' tasks'); out.push(badge('Session hooks: ' + (ad.hooks.sessionStart && ad.hooks.stop ? 'installed' : ad.hooks.sessionStart || ad.hooks.stop ? 'half installed' : 'not installed'), ad.hooks.sessionStart && ad.hooks.stop ? 'ok' : 'bad')); }
  if (a.id === 'planning') { add('Plans saved', ad.plans.days, 'days'); add('Closed', ad.plans.closed, 'days'); }
  if (a.id === 'rules') out.push(c('guards run in the test suite'));
  return out.join(' ');
}
function renderRatings() {
  const R = S.ratings; const body = $('ratingsBody');
  if (!R) { body.innerHTML = '<div class="skel" style="height:80px;margin-bottom:12px"></div><div class="skel" style="height:240px"></div>'; loadRatings(); return; }
  if (R.error) { body.innerHTML = '<div class="note bad">Could not load the ratings: ' + esc(R.error) + '</div>'; return; }
  const res = R.result; const running = R.status === 'running';
  const head = '<div class="datebar"><span class="muted">' + (res ? 'Calculated ' + esc(ago(res.generatedAt)) + '. Measured from Azure DevOps (read-only), local git, the usage log, the learnings store and this hub. No AI model is used.' : 'Not calculated yet.') + '</span><span style="flex:1"></span>'
    + '<button type="button" class="btn primary" data-ra="run"' + (running ? ' disabled' : '') + '>' + (running ? esc(R.step || 'Calculating') + '…' : (res ? 'Recalculate' : 'Calculate now')) + '</button></div>'
    + (R.error ? '' : '') + (S.ratings.error ? '' : '');
  if (!res) { body.innerHTML = head + '<div class="empty card"><b>' + (running ? 'Calculating…' : 'No ratings yet') + '</b>' + (running ? esc(R.step || '') : 'The first calculation reads your pull requests, builds and review threads, takes about 10 seconds, and changes nothing.') + '</div>' + (R.error ? '<div class="note bad">' + esc(R.error) + '</div>' : ''); return; }
  const o = res.overall;
  let h = head + (res.notes || []).map((n) => '<div class="note warn" style="margin-bottom:12px">' + esc(n) + '</div>').join('');
  h += '<div class="card" style="padding:16px 18px;margin-bottom:16px"><div class="area-h"><div><h3 style="margin:0">Overall</h3><div class="muted">Mean of the areas. Compared like for like: only areas that have both your own earlier rating and a measured baseline.</div></div>'
    + '<div class="scorechips">' + scChip('My review', o.originalComparable) + scChip('Baseline', o.baseline, o.originalComparable) + scChip('Last 14 days', o.recentComparable, o.baseline) + '</div></div>'
    + '<div class="muted" style="margin-top:6px">Same areas in all three numbers. Areas with no history (workflow design is measured now only, planning has no baseline) are left out of this comparison, so the change is real, not a change in what is averaged. Including them, today\'s mean is ' + scTxt(o.recent) + '.</div>'
    + '<div class="spark" style="margin-top:10px">' + o.trend.map((t) => '<div class="' + (t.score === null ? 'nil' : '') + '" style="height:' + (t.score === null ? 3 : Math.max(4, t.score * 4.4)) + 'px" title="' + esc(t.week) + ': ' + scTxt(t.score) + '"></div>').join('') + '</div>'
    + '<div class="spark-l">' + o.trend.map((t) => '<span>' + esc(t.week.slice(5)) + '</span>').join('') + '</div></div>';
  h += '<div class="areas">' + res.areas.map((a) => {
    const diff = a.original != null && a.baseline.score !== null && Math.abs(a.baseline.score - a.original) > 1.2;
    return '<div class="card area"><div class="area-h"><div><h3>' + esc(a.label) + '</h3><div class="muted">' + esc(a.gap) + '</div></div>'
      + '<div class="scorechips">' + scChip('My review', a.original) + scChip('Baseline', a.baseline.score, a.original) + scChip('Last 14 d', a.recent.score, a.baseline.score) + '</div></div>'
      + '<div><div class="spark">' + a.trend.map((t) => '<div class="' + (t.score === null ? 'nil' : '') + '" style="height:' + (t.score === null ? 3 : Math.max(4, t.score * 4.4)) + 'px" title="' + esc(t.week) + ': ' + scTxt(t.score) + '"></div>').join('') + '</div><div class="spark-l">' + a.trend.map((t) => '<span>' + esc(t.week.slice(5)) + '</span>').join('') + '</div></div>'
      + '<table class="mini"><thead><tr><th>Measure</th><th>Baseline</th><th>Last 14 days</th></tr></thead><tbody>'
      + a.metrics.map((m) => { const cell = (x) => (x.value === null ? '<span class="muted">no data</span>' : esc(x.detail || (x.value + ' ' + m.unit)) + ' <span class="muted">(' + x.value + ' ' + esc(m.unit) + (x.n && x.n < 5 ? ', small sample' : '') + ')</span> ' + badge(scTxt(x.score), scKind(x.score)));
        return '<tr><td>' + esc(m.label) + '<div class="muted" style="font-size:11px">' + esc(m.source) + (m.current ? ' · measured now only' : '') + '</div></td><td>' + (m.current ? '<span class="muted">not measurable</span>' : cell(m.baseline)) + '</td><td>' + cell(m.recent) + '</td></tr>'; }).join('')
      + '</tbody></table>'
      + (diff ? '<div class="note warn">Measured baseline ' + a.baseline.score + ' vs your earlier rating ' + a.original + (a.metrics.some((m) => m.id === 'attribution') ? ': the scan found AI-attribution trailers in some of your commits that the review did not know about. Check they were not pushed.' : '.') + '</div>' : '')
      + '<div class="hubuse"><b>Hub:</b> ' + a.features.map((f) => '<span class="chip">' + esc(f) + '</span>').join(' ') + ' ' + featureChips(a, res.adoption) + '</div>'
      + '<div class="next"><b>Next:</b> ' + esc(a.next) + '</div></div>';
  }).join('') + '</div>';
  const pa = res.plannerAccuracy; const pc = (x) => (x === null || x === undefined ? '–' : x + '%');
  h += '<div class="usage-sec"><h2>Is the planner getting it right? <span class="muted" style="font-weight:400">(recorded for free every time you save a plan)</span></h2>'
    + (pa.lines < 10 ? '<div class="note">Not enough data yet (' + pa.lines + ' line' + (pa.lines === 1 ? '' : 's') + ' so far). Save a few plans and this fills in on its own.</div>' : '')
    + '<div class="pa-grid"><div><small>Matches accepted unchanged</small><b>' + pc(pa.matches.acceptedPct) + '</b> <span class="muted">of ' + pa.matches.n + '</span></div>'
    + '<div><small>High confidence (80%+)</small><b>' + pc(pa.high.acceptedPct) + '</b> <span class="muted">of ' + pa.high.n + '</span></div>'
    + '<div><small>Medium (60 to 80%)</small><b>' + pc(pa.medium.acceptedPct) + '</b> <span class="muted">of ' + pa.medium.n + '</span></div>'
    + '<div><small>Low (under 60%)</small><b>' + pc(pa.low.acceptedPct) + '</b> <span class="muted">of ' + pa.low.n + '</span></div>'
    + '<div><small>AI vs rules mode</small><b>' + pc(pa.ai.acceptedPct) + ' / ' + pc(pa.rules.acceptedPct) + '</b></div>'
    + '<div><small>Changed, removed, added</small><b>' + pa.changed + ' / ' + pa.removed + ' / ' + pa.added + '</b></div>'
    + '<div><small>Drafts you edited</small><b>' + pc(pa.draftsEdited.editedPct) + '</b> <span class="muted">of ' + pa.draftsEdited.n + '</span></div>'
    + '<div><small>Worktree suggestions kept</small><b>' + pa.worktrees.kept + '</b> <span class="muted">of ' + pa.worktrees.proposed + ' (+' + pa.worktrees.added + ' added)</span></div></div></div>';
  h += '<div class="foot-plain"><b>How to read this.</b> Each measure is scored 0 to 10 by a straight line between a worst and a best value (editable in <span class="mono">scorecard.config.json</span>); an area is the weighted mean of its measures. Thresholds were set so the baseline lands near your earlier ratings (when you set any), so compare trends rather than absolute numbers. '
    + 'Samples are small (' + res.inputs.prs + ' pull requests, ' + res.inputs.bugsWithPrs + ' bugs with PRs, ' + res.inputs.commitsScanned + ' commits, ' + res.inputs.sessions + ' sessions): treat movements as hints, not proof. A rise after a hub feature was introduced is correlation, not cause. Measures marked "measured now only" have no history. Hub measures have no baseline because the hub did not exist yet.</div>';
  body.innerHTML = h;
}
$('ratingsBody').addEventListener('click', (e) => { const b = e.target.closest('[data-ra]'); if (b && b.dataset.ra === 'run') runRatings(); });

/* ---------- token usage report ---------- */
const fmtTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n));
const fmtUsd = (n) => '$' + n.toFixed(2);
const shortModel = (m) => String(m || '').replace('claude-', '');
async function loadUsage() {
  try { S.usage = await api('/api/usage'); } catch (e) { S.usage = { error: e.message }; }
  render();
}
function renderUsage() {
  const U = S.usage; const body = $('usageBody');
  if (!U) { body.innerHTML = '<div class="kpis">' + Array.from({ length: 4 }, () => '<div class="kpi"><div class="skel" style="width:60%"></div><div class="skel" style="margin-top:10px;width:40%"></div></div>').join('') + '</div>'; loadUsage(); return; }
  if (U.error) { body.innerHTML = '<div class="note bad">Could not build the usage report: ' + esc(U.error) + '</div>'; return; }
  const b = U.build; let h = '';
  const refs = U.hub.filesWithModelReferences || [];
  const hi = U.hubAi || { month: { calls: 0, total: 0, usd: 0 }, all: { calls: 0, total: 0, usd: 0 }, recent: [] };
  h += U.hub.modelCalls === 0
    ? '<div class="note ok" style="margin-bottom:16px"><b>The hub spends model tokens only on Today\'s plan.</b> This month: ' + hi.month.calls + ' call' + (hi.month.calls === 1 ? '' : 's') + ', ' + fmtTok(hi.month.total) + ' tokens, about ' + fmtUsd(hi.month.usd)
      + ' (all time: ' + hi.all.calls + ' calls, about ' + fmtUsd(hi.all.usd) + '). Nothing else in the hub calls a model: reading git, Azure DevOps and this report cost no tokens. Building or changing the hub in a Claude session is counted below.</div>'
    : '<div class="note warn" style="margin-bottom:16px"><b>Check these files:</b> they mention a model API: ' + refs.map(esc).join(', ') + '</div>';
  if (hi.recent.length) {
    h += '<div class="usage-sec"><h2>The hub\'s own model calls (Today\'s plan)</h2><div class="card"><div class="scroll" style="min-height:0"><table class="grid"><thead><tr><th>When</th><th>What</th><th>Model</th><th class="num">Output</th><th class="num">Cache reads</th><th class="num">Est. cost</th><th>Result</th></tr></thead><tbody>'
      + hi.recent.map((c) => '<tr><td class="nowrap" title="' + esc(full(c.at)) + '">' + esc(ago(c.at)) + '</td><td>' + esc(c.purpose === 'plan-parse' ? 'Read and match the plan' : c.purpose === 'plan-draft' ? 'Draft missing work items' : c.purpose) + '</td><td>' + esc(shortModel(c.model)) + '</td><td class="num">' + fmtTok(c.out) + '</td><td class="num">' + fmtTok(c.cacheRead) + '</td><td class="num">' + fmtUsd(c.usd) + '</td><td>' + (c.ok ? badge('OK', 'ok') : badge('Failed', 'bad') + ' <span class="muted">' + esc((c.error || '').slice(0, 60)) + '</span>') + '</td></tr>').join('')
      + '</tbody></table></div></div></div>';
  }
  if (b) {
    const t = b.totals; const sum = t.total || 1;
    const seg = [['c-read', 'Cache reads', t.cacheRead], ['c-write', 'Cache writes', t.cacheWrite], ['c-in', 'Fresh input', t.in], ['c-out', 'Output', t.out]];
    h += '<div class="usage-sec"><h2>Building the hub (this Claude session, from ' + esc(full(b.from)) + ')</h2>'
      + '<div class="kpis">'
      + '<div class="kpi info"><small>Total tokens processed</small><b>' + fmtTok(t.total) + '</b><span class="sub">' + Math.round(100 * t.cacheRead / sum) + '% are cheap cache reads</span></div>'
      + '<div class="kpi ok"><small>Output written by Claude</small><b>' + fmtTok(t.out) + '</b><span class="sub">of which thinking ' + fmtTok(t.thinking) + '</span></div>'
      + '<div class="kpi warn"><small>Estimated cost</small><b>' + fmtUsd(t.usd) + '</b><span class="sub">list price, not billed per token on claude.ai plans</span></div>'
      + '<div class="kpi"><small>Model calls</small><b>' + t.calls + '</b><span class="sub">' + b.turns.length + ' turns</span></div></div>'
      + '<div class="card" style="padding:14px 16px"><div class="stack">' + seg.map((s) => '<span class="' + s[0] + '" style="width:' + (100 * s[2] / sum).toFixed(2) + '%" title="' + s[1] + '"></span>').join('') + '</div>'
      + '<div class="legend">' + seg.map((s) => '<span><i class="' + s[0] + '"></i>' + s[1] + ' <b>' + fmtTok(s[2]) + '</b> <span class="muted">(' + (100 * s[2] / sum).toFixed(1) + '%)</span></span>').join('') + '</div></div>'
      + '<h2 style="margin-top:18px">By model</h2><div class="card"><div class="scroll" style="min-height:0"><table class="grid"><thead><tr><th>Model</th><th class="num">Calls</th><th class="num">Output</th><th class="num">Cache reads</th><th class="num">Cache writes</th><th class="num">Est. cost</th></tr></thead><tbody>'
      + b.byModel.map((m) => '<tr><td>' + esc(shortModel(m.model)) + '</td><td class="num">' + m.calls + '</td><td class="num">' + fmtTok(m.out) + '</td><td class="num">' + fmtTok(m.cacheRead) + '</td><td class="num">' + fmtTok(m.cacheWrite) + '</td><td class="num">' + fmtUsd(m.usd) + '</td></tr>').join('')
      + '</tbody></table></div></div>'
      + '<h2 style="margin-top:18px">Turn by turn</h2><div class="card"><div class="scroll" style="min-height:0"><table class="grid"><thead><tr><th>When</th><th>What was asked</th><th>Model</th><th class="num">Calls</th><th class="num">Output</th><th class="num">Cache reads</th><th class="num">Est. cost</th></tr></thead><tbody>'
      + b.turns.map((x) => '<tr><td class="nowrap" title="' + esc(full(x.start)) + '">' + esc(ago(x.start)) + '</td><td style="max-width:420px">' + esc(x.prompt) + '</td><td>' + esc(x.models.map(shortModel).join(', ')) + (x.subagents ? ' <span class="muted">+' + x.subagents + ' agents</span>' : '') + '</td>'
        + '<td class="num">' + x.calls + '</td><td class="num">' + fmtTok(x.out) + '</td><td class="num">' + fmtTok(x.cacheRead) + '</td><td class="num">' + fmtUsd(x.usd) + '</td></tr>').join('')
      + '</tbody></table></div></div></div>';
  } else h += '<div class="note warn">The hub-building session was not found in the usage log.</div>';
  const w = U.workspace; const max = Math.max(...w.days.slice(0, 14).map((d) => d.usd), 0.01);
  h += '<div class="usage-sec"><h2>Whole workspace (' + (S.me && S.me.workspaceRoot ? 'all sessions under ' + esc(S.me.workspaceRoot) : 'all sessions') + ')</h2><div class="kpis">'
    + '<div class="kpi info"><small>Sessions</small><b>' + w.sessions + '</b></div><div class="kpi"><small>Turns</small><b>' + w.turns + '</b></div>'
    + '<div class="kpi ok"><small>Output written</small><b>' + fmtTok(w.totals.out) + '</b></div><div class="kpi warn"><small>Estimated cost</small><b>' + fmtUsd(w.totals.usd) + '</b></div></div>'
    + '<h2>Cost per day (last 14 days)</h2><div class="card" style="padding:12px 16px">' + (w.days.slice(0, 14).map((d) => '<div class="dbar"><span>' + esc(d.day) + '</span><div class="bar"><span style="width:' + (100 * d.usd / max).toFixed(1) + '%"></span></div><span class="v">' + fmtUsd(d.usd) + '</span></div>').join('') || '<div class="muted">No data.</div>') + '</div>'
    + '<h2 style="margin-top:18px">Most expensive sessions</h2><div class="card"><div class="scroll" style="min-height:0"><table class="grid"><thead><tr><th>Started</th><th>First prompt</th><th>Folder</th><th class="num">Turns</th><th class="num">Output</th><th class="num">Est. cost</th></tr></thead><tbody>'
    + w.topSessions.map((s) => '<tr><td class="nowrap" title="' + esc(full(s.first)) + '">' + esc(ago(s.first)) + '</td><td style="max-width:380px">' + esc(s.prompt) + '</td><td class="mono path">' + esc(s.project) + '</td><td class="num">' + s.turns + '</td><td class="num">' + fmtTok(s.out) + '</td><td class="num">' + fmtUsd(s.usd) + '</td></tr>').join('')
    + '</tbody></table></div></div></div>'
    + '<div class="foot-plain"><ul style="margin:0;padding-left:18px">' + U.notes.map((n) => '<li>' + esc(n) + '</li>').join('') + '</ul>Source: <span class="mono">' + esc(U.source) + '</span> · generated ' + esc(ago(U.generatedAt)) + '</div>';
  body.innerHTML = h;
}

/* ---------- shell ---------- */
const TITLES = { plan: ['Today\'s plan', 'Say what you plan to do. I turn it into a checklist tied to your work items.'], tasks: ['Task board', 'Your work items and pull requests with their real code state from git.'], worktrees: ['Worktrees', 'Every worktree across all your clones, with its real git state.'], cleared: ['Cleared worktrees', 'Worktrees you marked as done or handled by someone else, with the reason.'],
  ratings: ['Workflow ratings', 'Measured, not guessed: baseline vs recent weeks, and whether the hub is closing each gap.'],
  usage: ['Token usage', 'What building and using this hub costs in model tokens, and the wider workspace for comparison.'],
  moves: ['Live moves', 'Work moved from a worktree into the live repo, step by step.'], stashes: ['Stashes', 'Every git stash in every clone: see what each one is, clear what is not needed, re-work what is.'] };
function render() {
  document.querySelectorAll('#menu a').forEach((a) => (a.dataset.view === S.view ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  $('title').textContent = TITLES[S.view][0]; $('subtitle').textContent = TITLES[S.view][1];
  $('viewPlan').hidden = S.view !== 'plan'; $('viewTasks').hidden = S.view !== 'tasks';
  $('navCountPlan').textContent = S.plan && S.plan.items && S.plan.date === S.plan.today ? (S.plan.items.filter((i) => i.status === 'todo').length || '') : '';
  $('navCountTasks').textContent = S.tasksData ? (S.tasksData.tasks.filter((t) => t.attention.length).length || '') : '';
  $('viewWorktrees').hidden = S.view !== 'worktrees'; $('viewCleared').hidden = S.view !== 'cleared';
  $('viewMoves').hidden = S.view !== 'moves'; $('viewStashes').hidden = S.view !== 'stashes'; $('viewUsage').hidden = S.view !== 'usage'; $('viewRatings').hidden = S.view !== 'ratings';
  const pend = S.stashes.filter(stashNeeds).length;
  $('navCountStash').textContent = pend || ''; $('navCountMoves').textContent = S.moves.length || '';
  $('stashBanner').hidden = !(S.view === 'worktrees' && pend);
  if (pend) $('stashBanner').innerHTML = '<b>' + pend + ' stash' + (pend > 1 ? 'es' : '') + '</b> made by Move to live still hold earlier live-repo changes. <a href="#stashes">Review stashes</a>';
  $('navCountActive').textContent = S.loaded ? activeRows().length : '';
  $('navCountCleared').textContent = S.loaded ? S.clearances.filter((c) => !c.restoredAt).length || '' : '';
  $('updated').textContent = S.generatedAt ? 'Updated ' + new Date(S.generatedAt).toLocaleTimeString() : '';
  $('who').textContent = S.me.user ? 'Signed in as ' + S.me.user : '';
  const sb = $('setupBanner'); const probs = (S.me && S.me.problems) || []; sb.hidden = !probs.length;
  if (probs.length) sb.innerHTML = '<b>Setup needed.</b> ' + probs.map(esc).join(' ');
  if (S.view === 'plan') renderPlan(); else if (S.view === 'tasks') renderTasks(); else if (S.view === 'worktrees') renderWorktrees(); else if (S.view === 'cleared') renderCleared(); else if (S.view === 'moves') renderMoves(); else if (S.view === 'usage') renderUsage(); else if (S.view === 'ratings') renderRatings(); else renderStashes();
}
function route() { const h = location.hash.slice(1); S.view = TITLES[h] ? h : 'plan'; render(); if (S.view === 'stashes' && S.sm && !S.sm.data && !S.sm.loading && typeof loadStashMgr === 'function') loadStashMgr(); }

document.addEventListener('click', (e) => {
  const card = e.target.closest('[data-open]');
  if (card && !e.target.closest('a')) { openTask(Number(card.dataset.open)); return; }
  const t = e.target.closest('button,th'); if (!t) return;
  if (t.dataset.pg) { const [k, d] = t.dataset.pg.split(':'); S.pg[k].page += Number(d); render(); }
  else if (t.dataset.status) { S.status = t.dataset.status; render(); }
  else if (t.dataset.tab) { S.tab = t.dataset.tab; render(); }
  else if (t.dataset.ft) { if (S.tab === 'work') S.fT = t.dataset.ft; else S.fR = t.dataset.ft; render(); }
  else if (t.dataset.kt) { S.dirT = S.sortT === t.dataset.kt ? -S.dirT : 1; S.sortT = t.dataset.kt; render(); }
  else if (t.dataset.goto) { if (drawer.open) drawer.close(); S.q = t.dataset.goto; S.filter = 'all'; $('q').value = S.q; location.hash = '#worktrees'; }
  else if (t.dataset.move) openMove(t.dataset.move);
  else if (t.dataset.handled) openHandled(Number(t.dataset.handled));
  else if (t.dataset.copy) { navigator.clipboard.writeText(t.dataset.copy).then(() => toast('Command copied'), () => toast('Copy failed: select the command by hand', { bad: true })); }
  else if (t.dataset.clear) openClear(t.dataset.clear);
  else if (t.dataset.restore) openRestore(Number(t.dataset.restore));
  else if (t.dataset.f) { S.filter = t.dataset.f; render(); }
  else if (t.dataset.f2) { S.filter2 = t.dataset.f2; render(); }
  else if (t.tagName === 'TH' && t.dataset.k) { S.sortDir = S.sortKey === t.dataset.k ? -S.sortDir : 1; S.sortKey = t.dataset.k; render(); }
});
$('q').addEventListener('input', (e) => { S.q = e.target.value; renderWorktrees(); });
$('qT').addEventListener('input', (e) => { S.qT = e.target.value; renderTasks(); });
$('cardsT').addEventListener('keydown', (e) => {
  const c = e.target.closest('[data-open]');
  if (c && e.target === c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openTask(Number(c.dataset.open)); }
});
$('qT').addEventListener('keydown', (e) => { const v = S.qT.trim(); if (e.key === 'Enter' && /^\d{3,6}$/.test(v)) openTask(Number(v)); });
document.addEventListener('change', (e) => {
  const k = e.target.dataset && e.target.dataset.psize;
  if (k) { S.pg[k].size = Number(e.target.value); S.pg[k].page = 1; render(); }
  if (e.target.id === 'daysT') { S.completedDays = Number(e.target.value); S.completed = null; S.completedErr = null; render(); }
});
$('sortT').addEventListener('change', (e) => { S.sortT = e.target.value; renderTasks(); });
$('typeT').addEventListener('change', (e) => { S.typeT = e.target.value; renderTasks(); });
$('q2').addEventListener('input', (e) => { S.q2 = e.target.value; renderCleared(); });
$('repo').addEventListener('change', (e) => { S.repo = e.target.value; renderWorktrees(); });
$('refresh').addEventListener('click', () => load(true));
window.addEventListener('hashchange', route);
$('theme').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme:dark)').matches);
  document.documentElement.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('hub-theme', document.documentElement.dataset.theme); } catch (e) { /* storage blocked */ }
});
try { const t = localStorage.getItem('hub-theme'); if (t) document.documentElement.dataset.theme = t; } catch (e) { /* storage blocked */ }

(async function init() {
  route();
  try {
    S.me = await api('/api/me');
    if (S.me.adoConfigured) ADO = S.me.organization + '/' + encodeURIComponent(S.me.project) + '/_workitems/edit/';
    document.title = S.me.title; document.querySelector('.brand b').textContent = S.me.brand; document.querySelector('.logo').textContent = (S.me.brand.trim()[0] || 'H').toUpperCase();
  } catch (e) { /* shown by load() */ }
  await load(false);
  setInterval(() => { if (!dlg.open) load(false, true); }, 60000);
})();
