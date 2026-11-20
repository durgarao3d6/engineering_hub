/* Stash manager page. Loaded after app.js and shares its helpers (S, $, esc, api, toast, openDialog, badge, ago, full, paginate). */
'use strict';
S.sm = { data: null, loading: false, err: '', sel: new Set(), tab: 'stashes', repo: '', verdict: '', age: '', q: '', sort: 'new', analysing: null, cancel: false, trashSel: new Set() };
S.pg.stash = { page: 1, size: 25, sizes: [10, 25, 50, 100], sig: '' };

const VERDICTS = [['', 'Any verdict'], ['cleanable', 'Safe or likely obsolete'], ['safe', 'Safe to clear'], ['obsolete', 'Likely obsolete'], ['rework', 'Needs rework'], ['old', 'Old, review'], ['review', 'Worth reviewing'], ['none', 'Not analysed yet']];
const VERDICT_KIND = { safe: 'ok', obsolete: 'info', rework: 'warn', old: 'neu', review: 'neu' };
const smKey = (r) => r.repoPath + '|' + r.hash;

async function loadStashMgr(keepSel) {
  const m = S.sm; m.loading = true; m.err = ''; m.failed = false; render();
  try {
    m.data = await api('/api/stash/overview');
    if (!keepSel) m.sel.clear();
    else { const live = new Set(smRows().map(smKey)); [...m.sel].forEach((k) => { if (!live.has(k)) m.sel.delete(k); }); }
  } catch (e) { m.err = e.message; }
  m.loading = false; render();
}
function smRows() {
  const d = S.sm.data; if (!d) return [];
  return d.repos.flatMap((r) => r.stashes.map((s) => ({ ...s, repoKey: r.repoKey, repoPath: r.path, layer: r.layer, mainRef: r.main })));
}
function smFiltered() {
  const m = S.sm; const q = m.q.trim().toLowerCase(); const now = Date.now();
  let rows = smRows().filter((r) => {
    if (m.repo && r.repoPath !== m.repo) return false;
    const k = r.verdict ? r.verdict.kind : 'none';
    if (m.verdict === 'cleanable' ? !(k === 'safe' || k === 'obsolete') : (m.verdict && k !== m.verdict)) return false;
    if (m.age && (now - Date.parse(r.createdAt)) / 86400000 < Number(m.age)) return false;
    if (q && !(r.subject + ' ' + r.branch + ' ' + (r.taskId || '') + ' ' + r.repoKey).toLowerCase().includes(q)) return false;
    return true;
  });
  const by = { new: (a, b) => b.createdAt.localeCompare(a.createdAt), old: (a, b) => a.createdAt.localeCompare(b.createdAt), files: (a, b) => (b.fileCount || 0) - (a.fileCount || 0), repo: (a, b) => a.repoKey.localeCompare(b.repoKey) || b.createdAt.localeCompare(a.createdAt) }[m.sort] || null;
  if (by) rows = rows.sort(by);
  return rows;
}
const dayAge = (iso) => Math.floor((Date.now() - Date.parse(iso)) / 86400000);

function smRowHtml(r) {
  const v = r.verdict; const k = smKey(r);
  const files = r.files ? '<div class="cell-main"><b>' + r.fileCount + '</b> file' + (r.fileCount === 1 ? '' : 's') + (r.untrackedCount ? ' <span class="muted">(' + r.untrackedCount + ' new)</span>' : '') + '</div><div class="cell-sub">+' + r.added + ' −' + r.removed + '</div>' : '<span class="muted">—</span>';
  const verdict = '<div class="badges">' + (v ? badge(v.label, VERDICT_KIND[v.kind] || 'neu') : '<span class="muted">Not analysed</span>') + (r.hub ? badge('Made by Move to live', 'info') : '') + '</div>';
  const why = (v ? esc(v.why) : '<button type="button" class="linkbtn" data-sm-analyse="' + esc(k) + '">Analyse this one</button>')
    + (r.hub && !r.hub.handledAt ? ' <button type="button" class="linkbtn" data-sm-handled="' + r.hub.id + '">Mark handled</button>' : '');
  return '<tr><td><input type="checkbox" data-sel="' + esc(k) + '" aria-label="Select this stash"' + (S.sm.sel.has(k) ? ' checked' : '') + '></td>'
    + '<td title="' + esc((r.branch || '(no branch)') + ' · ' + r.repoKey) + '"><div class="cell-main">' + esc(r.note || r.subject) + '</div><div class="cell-sub">' + esc(r.repoKey) + ' · <span class="mono">' + esc(r.branch || '(no branch)') + '</span>'
    + (r.taskId ? ' · <a href="#" data-open="' + r.taskId + '">#' + r.taskId + '</a>' : '') + '</div></td>'
    + '<td title="' + esc(full(r.createdAt)) + '"><div class="cell-main">' + esc(ago(r.createdAt)) + '</div><div class="cell-sub">' + r.ref + '</div></td>'
    + '<td>' + files + '</td><td>' + verdict + '</td><td class="col-note">' + why + '</td>'
    + '<td class="r"><button type="button" class="btn sm" data-sm-diff="' + esc(k) + '">Diff</button> <button type="button" class="btn sm" data-sm-rework="' + esc(k) + '">Re-work…</button> <button type="button" class="btn sm" data-sm-clear="' + esc(k) + '">Clear…</button></td></tr>';
}

function renderStashMgr() {
  const m = S.sm; const box = $('stashBody'); const d = m.data;
  if (!d) { box.innerHTML = m.err ? errorBar({ title: 'The stash list didn\'t load.', detail: m.err, retry: 'stash' }) : skeleton('chart', 1) + skeleton('rows', 6); return; }
  const trash = d.trash; const all = smRows(); const analysed = all.filter((r) => r.verdict).length;
  let h = '<div class="toolbar"><div class="seg" role="group" aria-label="Stash section">'
    + [['stashes', 'Stashes (' + d.total + ')'], ['trash', 'Trash (' + trash.length + ')'], ['history', 'History']].map((t) => '<button type="button" data-sm-tab="' + t[0] + '" aria-pressed="' + (m.tab === t[0]) + '">' + t[1] + '</button>').join('')
    + '</div><span class="muted">' + analysed + ' of ' + all.length + ' analysed</span><span style="flex:1"></span><button type="button" class="btn sm" data-sm-reload="1">Refresh</button></div>';
  if (m.tab === 'trash') h += trashHtml(trash);
  else if (m.tab === 'history') h += historyHtml(d.history);
  else h = h + '<div id="vizStash" style="margin-bottom:16px"></div>' + stashesHtml(all);
  box.innerHTML = h;
  if (m.tab === 'stashes' && typeof vizStash === 'function') { try { vizStash($('vizStash'), all); } catch (e) { $('vizStash').textContent = ''; } }
  if (m.tab === 'stashes') autoAnalyse();
}

function stashesHtml(all) {
  const m = S.sm; const rows = smFiltered();
  const sig = [m.repo, m.verdict, m.age, m.q, m.sort].join('|');
  const page = paginate('stash', rows, sig, 'pagerStashTmp');
  const pagerHtml = $('pagerStashTmp').innerHTML;
  const sel = [...m.sel];
  let h = '<div class="toolbar"><div class="search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input type="search" id="smQ" value="' + esc(m.q) + '" placeholder="Search message, branch, task ID, repo" aria-label="Search stashes"></div>'
    + '<select id="smRepo" aria-label="Repository"><option value="">All repositories</option>' + S.sm.data.repos.map((r) => '<option value="' + esc(r.path) + '"' + (m.repo === r.path ? ' selected' : '') + '>' + esc(r.repoKey) + ' (' + r.count + ')</option>').join('') + '</select>'
    + '<select id="smVerdict" aria-label="Verdict">' + VERDICTS.map((v) => '<option value="' + v[0] + '"' + (m.verdict === v[0] ? ' selected' : '') + '>' + v[1] + '</option>').join('') + '</select>'
    + '<select id="smAge" aria-label="Age">' + [['', 'Any age'], ['30', 'Older than 30 days'], ['60', 'Older than 60 days'], ['90', 'Older than 90 days']].map((v) => '<option value="' + v[0] + '"' + (m.age === v[0] ? ' selected' : '') + '>' + v[1] + '</option>').join('') + '</select>'
    + '<select id="smSort" aria-label="Sort">' + [['new', 'Newest first'], ['old', 'Oldest first'], ['files', 'Most files'], ['repo', 'By repository']].map((v) => '<option value="' + v[0] + '"' + (m.sort === v[0] ? ' selected' : '') + '>' + v[1] + '</option>').join('') + '</select></div>';
  const pending = rows.filter((r) => !r.verdict).length;
  h += '<div class="toolbar">' + (m.analysing ? '<span class="muted">Analysing… ' + m.analysing.done + ' of ' + m.analysing.total + '</span> <button type="button" class="btn sm" data-sm-cancel="1">Stop</button>'
    : (pending ? '<button type="button" class="btn sm" data-sm-analyse-all="1">Analyse the ' + pending + ' shown that are not analysed</button>' : '<span class="muted">Everything shown is analysed.</span>'))
    + '<span style="flex:1"></span>' + (sel.length ? '<span><b>' + sel.length + '</b> selected</span> <button type="button" class="btn sm danger" data-sm-clear-sel="1">Clear selected…</button> <button type="button" class="btn sm" data-sm-unsel="1">Unselect</button>' : '')
    + (rows.length ? ' <button type="button" class="btn sm" data-sm-sel-shown="1">Select the ' + rows.length + ' shown</button>' : '') + '</div>';
  h += '<div class="card"><div class="scroll"><table class="grid" data-drop="date,sync,text,short,note"><thead><tr><th style="width:28px"></th><th>Stash</th><th>Made</th><th>Changes</th><th>Verdict</th><th>Why</th><th class="r">Action</th></tr></thead><tbody>'
    + (page.map(smRowHtml).join('') || '<tr><td colspan="7"><div class="empty"><b>' + (all.length ? 'No stash matches these filters' : 'No stashes in any clone') + '</b>' + (all.length ? 'Change or clear the filters above.' : 'Nothing to review.') + '</div></td></tr>')
    + '</tbody></table></div><div class="foot pager-bar"><span>Clearing is recoverable: a copy stays in the Trash tab until you empty it. Verdicts are advice from comparing with main; nothing is cleared automatically.</span><div class="pager">' + pagerHtml + '</div></div></div>';
  return h;
}

function trashHtml(trash) {
  const m = S.sm;
  const rows = trash.map((t) => '<tr><td><input type="checkbox" data-tsel="' + esc(t.repoPath + '|' + t.hash) + '" aria-label="Select"' + (m.trashSel.has(t.repoPath + '|' + t.hash) ? ' checked' : '') + '></td>'
    + '<td title="' + esc(t.patchPath || '') + '"><div class="cell-main">' + esc((t.message || '').replace(/^(WIP on|On) [^:]+:\s*/, '') || t.hash.slice(0, 7)) + '</div><div class="cell-sub">' + esc(t.repoKey) + ' · ' + t.fileCount + ' file(s)</div>'
    + '</td>'
    + '<td class="nowrap" title="' + esc(full(t.at)) + '">' + esc(ago(t.at)) + '<div class="cell-sub">' + esc(t.by) + '</div></td><td class="col-note">' + esc(t.reason || '') + '</td>'
    + '<td class="r nowrap"><button type="button" class="btn sm" data-sm-restore="' + esc(t.repoPath + '|' + t.hash) + '">Restore</button></td></tr>').join('');
  const sel = m.trashSel.size;
  return '<div class="toolbar"><span class="muted">Cleared stashes are kept here (a hidden git ref and a patch file). Restore puts one back on the stash list.</span><span style="flex:1"></span>'
    + (sel ? '<button type="button" class="btn sm danger" data-sm-purge="1">Delete ' + sel + ' for good…</button>' : '<span class="muted">Select entries to delete them for good.</span>') + '</div>'
    + '<div class="card"><div class="scroll"><table class="grid"><thead><tr><th style="width:28px"></th><th>Stash</th><th>Cleared</th><th>Reason</th><th class="r">Action</th></tr></thead><tbody>'
    + (rows || '<tr><td colspan="5"><div class="empty"><b>The trash is empty</b>Stashes you clear are kept here until you delete them.</div></td></tr>') + '</tbody></table></div></div>';
}
const ACTION_BADGE = { cleared: ['Cleared', 'warn'], restored: ['Restored', 'ok'], purged: ['Deleted for good', 'bad'], reworked: ['Re-worked', 'info'] };
function historyHtml(hist) {
  return '<div class="card"><div class="scroll"><table class="grid"><thead><tr><th>When</th><th>What</th><th>Stash</th><th>Reason or result</th></tr></thead><tbody>'
    + (hist.map((a) => { const b = ACTION_BADGE[a.action] || [a.action, 'neu'];
      return '<tr><td class="nowrap" title="' + esc(full(a.at)) + '">' + esc(ago(a.at)) + '<div class="cell-sub">' + esc(a.by) + '</div></td><td>' + badge(b[0], b[1]) + '</td>'
        + '<td><div class="cell-main">' + esc((a.message || '').replace(/^(WIP on|On) [^:]+:\s*/, '') || a.hash.slice(0, 7)) + '</div><div class="cell-sub">' + esc(a.repoKey) + ' · ' + a.fileCount + ' file(s) · <span class="mono">' + a.hash.slice(0, 10) + '</span></div></td>'
        + '<td class="col-note" title="' + esc(a.worktree || '') + '">' + esc(a.reason || '') + '</td></tr>'; }).join('')
      || '<tr><td colspan="4"><div class="empty"><b>No stash actions yet</b>Clears, restores and re-works are listed here with their reasons.</div></td></tr>') + '</tbody></table></div></div>';
}

/* ---------- analysis ---------- */
async function analyseRows(rows, onProgress) {
  const m = S.sm; const byRepo = new Map();
  rows.filter((r) => !r.verdict).forEach((r) => { if (!byRepo.has(r.repoPath)) byRepo.set(r.repoPath, []); byRepo.get(r.repoPath).push(r.hash); });
  let done = 0; const total = [...byRepo.values()].reduce((n, a) => n + a.length, 0);
  for (const [repo, hashes] of byRepo) {
    for (let i = 0; i < hashes.length; i += 8) {
      if (m.cancel) return;
      let res;
      try { res = await api('/api/stash/analyse', { body: { repo, hashes: hashes.slice(i, i + 8) } }); } catch (e) { toast('Analysis failed: ' + e.message, { bad: true }); m.cancel = true; m.failed = true; return; }
      const r = m.data.repos.find((x) => x.path === repo);
      if (r) res.stashes.forEach((s) => { const k = r.stashes.findIndex((x) => x.hash === s.hash); if (k >= 0) r.stashes[k] = s; });
      done += res.stashes.length; if (onProgress) onProgress(done, total);
    }
  }
}
let autoBusy = false;
async function autoAnalyse() { // the page you are looking at analyses itself
  const m = S.sm; if (autoBusy || m.analysing || m.failed || m.tab !== 'stashes') return;
  const rows = smFiltered(); const p = S.pg.stash; const page = rows.slice((p.page - 1) * p.size, p.page * p.size);
  if (!page.some((r) => !r.verdict)) return;
  autoBusy = true; m.cancel = false;
  try { await analyseRows(page); } finally { autoBusy = false; }
  if (S.view === 'stashes' && m.tab === 'stashes') { const keep = document.activeElement && document.activeElement.id === 'smQ'; renderStashMgr(); if (keep) { const q = $('smQ'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } } }
}
async function analyseAll() {
  const m = S.sm; const rows = smFiltered().filter((r) => !r.verdict); if (!rows.length) return;
  m.cancel = false; m.analysing = { done: 0, total: rows.length }; renderStashMgr();
  await analyseRows(rows, (done, total) => { m.analysing = { done, total }; if (S.view === 'stashes') renderStashMgr(); });
  m.analysing = null; renderStashMgr();
}

/* ---------- dialogs and actions ---------- */
const findRow = (k) => smRows().find((r) => smKey(r) === k);
const plain = (r) => (r.note || r.subject || r.hash.slice(0, 7));

function openClearStashes(keys) {
  const rows = keys.map(findRow).filter(Boolean); if (!rows.length) return;
  const risky = rows.filter((r) => !r.verdict || !(r.verdict.kind === 'safe' || r.verdict.kind === 'obsolete'));
  const repos = [...new Set(rows.map((r) => r.repoKey))];
  openDialog({
    title: rows.length === 1 ? 'Clear this stash' : 'Clear ' + rows.length + ' stashes', ok: 'Clear ' + rows.length, danger: true,
    body: '<div class="sum"><div class="cell-main">' + rows.length + ' stash(es) in ' + repos.length + ' repositor' + (repos.length === 1 ? 'y' : 'ies') + '</div>'
      + rows.slice(0, 8).map((r) => '<div class="cell-sub">' + esc(r.repoKey) + ' · ' + esc(plain(r)).slice(0, 80) + ' · ' + esc(ago(r.createdAt)) + '</div>').join('') + (rows.length > 8 ? '<div class="cell-sub">and ' + (rows.length - 8) + ' more</div>' : '') + '</div>'
      + (risky.length ? '<div class="note warn"><b>' + risky.length + ' of these ' + (risky.length === 1 ? 'is' : 'are') + ' not marked safe or likely obsolete.</b> Look at the diff first if you are not sure.</div>' : '')
      + '<div class="note">Recoverable: each stash leaves the stash list but a copy (a patch file and a hidden git ref) stays in the Trash tab until you delete it for good. Nothing is pushed.</div>'
      + '<div class="field"><label for="f-reason">Reason</label><textarea id="f-reason" name="reason" maxlength="1000" placeholder="For example: already merged in PR 1234 / experiment I abandoned"></textarea><div class="hint"><span>At least 5 characters</span></div></div>',
    submit: async (d) => {
      if (String(d.reason || '').trim().length < 5) { const e = new Error('Give a reason (at least 5 characters).'); e.fields = { reason: e.message }; throw e; }
      const byRepo = new Map(); rows.forEach((r) => { if (!byRepo.has(r.repoPath)) byRepo.set(r.repoPath, []); byRepo.get(r.repoPath).push(r.hash); });
      let ok = 0; const bad = [];
      for (const [repo, hashes] of byRepo) { const res = await api('/api/stash/clear', { body: { repo, hashes, reason: d.reason } }); ok += res.cleared; res.results.filter((x) => !x.ok).forEach((x) => bad.push(x.error)); }
      keys.forEach((k) => S.sm.sel.delete(k));
      await loadStashMgr(true);
      if (bad.length) toast(ok + ' cleared, ' + bad.length + ' failed: ' + bad[0], { bad: true }); else toast(ok + ' stash(es) cleared. They are in the Trash tab.');
    },
  });
}

async function openDiff(k) {
  const r = findRow(k); if (!r) return;
  openDialog({ title: 'Stash diff', ok: 'Close', body: '<div class="sum"><div class="cell-main">' + esc(plain(r)) + '</div><div class="cell-sub">' + esc(r.repoKey) + ' · ' + esc(r.branch) + ' · ' + esc(full(r.createdAt)) + '</div></div><div id="diffBox" class="muted">Loading…</div>', submit: async () => {} });
  try {
    const qs = '?repo=' + encodeURIComponent(r.repoPath) + '&hash=' + r.hash;
    const d = await api('/api/stash/diff' + qs); const t = d.totals;
    const ST = { A: 'new', M: 'changed', D: 'deleted' };
    const all = d.files.map((f) => ({ ...f, kind: 'tracked' })).concat(d.untracked.map((f) => ({ file: f.file, status: 'A', added: 0, removed: 0, size: f.size, kind: 'untracked' })));
    const cmd = 'git -C "' + r.repoPath + '" stash show -p --include-untracked ' + r.hash;
    $('diffBox').innerHTML = '<div class="note"><b>' + t.files + ' file(s)</b> · <b>+' + t.added + '</b> added · <b>−' + t.removed + '</b> removed' + (t.untracked ? ' · ' + t.untracked + ' new untracked file(s)' : '') + '. Counted by git, nothing is cut. Open a file to see its change.</div>'
      + '<div class="toolbar" style="margin:10px 0"><a class="btn sm" href="/api/stash/patch' + qs + '" download>Download the full patch</a><button type="button" class="btn sm" data-dcopy="' + esc(cmd) + '">Copy the git command</button></div>'
      + '<div class="scroll" style="max-height:48vh"><table class="grid"><tbody>' + all.map((f, i) => '<tr><td class="mono">' + esc(f.file) + '</td><td>' + esc(ST[f.status] || f.status) + '</td><td class="nowrap">'
        + (f.kind === 'untracked' ? esc(String(f.size)) + ' bytes' : f.binary ? 'binary' : '<span style="color:var(--ok)">+' + f.added + '</span> <span style="color:var(--bad)">−' + f.removed + '</span>')
        + '</td><td class="r"><button type="button" class="btn sm" data-fdiff="' + i + '">Show</button></td></tr><tr hidden id="fd-' + i + '"><td colspan="4"></td></tr>').join('') + '</tbody></table></div>';
    $('diffBox').onclick = async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.dcopy) { copyText(b.dataset.dcopy, 'Command copied'); return; }
      if (b.dataset.fdiff === undefined) return;
      const row = $('fd-' + b.dataset.fdiff); const cell = row.firstChild;
      if (!row.hidden) { row.hidden = true; b.textContent = 'Show'; return; }
      row.hidden = false; b.textContent = 'Hide';
      if (cell.dataset.loaded) return;
      cell.innerHTML = '<span class="muted">Loading…</span>';
      try {
        const f = await api('/api/stash/diff' + qs + '&file=' + encodeURIComponent(all[Number(b.dataset.fdiff)].file));
        cell.innerHTML = f.binary ? '<div class="muted">Binary file: no text change to show.</div>'
          : '<pre class="diffpre">' + f.diff.split('\n').map((l) => '<span class="' + (l[0] === '+' && !l.startsWith('+++') ? 'dl-add' : l[0] === '-' && !l.startsWith('---') ? 'dl-del' : l.startsWith('@@') ? 'dl-hunk' : '') + '">' + esc(l) + '</span>').join('\n') + '</pre>'
          + (f.truncated ? '<div class="note warn">This file is very long and was cut. Download the full patch for all of it.</div>' : '');
        cell.dataset.loaded = '1';
      } catch (err) { cell.innerHTML = '<div class="note bad">' + esc(err.message) + '</div>'; }
    };
  } catch (e) { $('diffBox').innerHTML = '<div class="note bad">' + esc(e.message) + '</div>'; }
}

async function openRework(k) {
  const r = findRow(k); if (!r) return;
  let pl;
  try { pl = await api('/api/stash/rework-plan?repo=' + encodeURIComponent(r.repoPath) + '&hash=' + r.hash); } catch (e) { toast(e.message, { bad: true }); return; }
  openDialog({
    title: 'Re-work this stash', ok: 'Create worktree',
    body: '<div class="sum"><div class="cell-main">' + esc(plain(r)) + '</div><div class="cell-sub">' + esc(r.repoKey) + ' · made ' + esc(ago(r.createdAt)) + ' on ' + esc(r.branch || 'unknown') + '</div></div>'
      + '<div class="note">Creates a new worktree on the commit this stash was made from and applies the stash there, so it cannot conflict. The stash stays on the list. You merge or rebase onto main yourself when ready.</div>'
      + '<div class="field"><label for="f-name">Co-worker name</label><input id="f-name" name="name" maxlength="21" value="' + esc(pl.name) + '"></div>'
      + '<div class="field"><label for="f-task">Task id <span class="muted">(optional)</span></label><input id="f-task" name="taskId" inputmode="numeric" maxlength="7" value="' + esc(pl.taskId || '') + '"><div class="hint"><span>Folder <span class="mono">' + esc(pl.folder) + '</span> under <span class="mono">' + esc(pl.dir) + '</span>, branch <span class="mono">' + esc(pl.branch) + '</span></span></div></div>',
    submit: async (d) => {
      const res = await api('/api/stash/rework', { body: { repo: r.repoPath, hash: r.hash, name: d.name, taskId: d.taskId } });
      if (res.applied) toast('Worktree created at ' + res.path); else toast(res.warning, { bad: true });
      await loadStashMgr(true); if (typeof load === 'function') load(false, true);
    },
  });
}

function openPurge() {
  const keys = [...S.sm.trashSel];
  openDialog({
    title: 'Delete ' + keys.length + ' stash(es) for good', ok: 'Delete for good', danger: true,
    body: '<div class="note warn"><b>This cannot be undone.</b> The hidden git ref and the patch file are deleted. Git may still hold the data until its next clean-up, but you could not restore it from here. The history row stays.</div>'
      + '<div class="field"><label for="f-confirm">Type <b>delete</b> to confirm</label><input id="f-confirm" name="confirm" autocomplete="off"></div>',
    submit: async (d) => {
      if (d.confirm !== 'delete') { const e = new Error('Type delete to confirm.'); e.fields = { confirm: e.message }; throw e; }
      const trash = S.sm.data.trash; const byRepo = new Map();
      keys.forEach((k) => { const t = trash.find((x) => x.repoPath + '|' + x.hash === k); if (!t) return; if (!byRepo.has(t.repoPath)) byRepo.set(t.repoPath, []); byRepo.get(t.repoPath).push(t.hash); });
      for (const [repo, hashes] of byRepo) await api('/api/stash/purge', { body: { repo, hashes, confirm: 'delete' } });
      S.sm.trashSel.clear(); await loadStashMgr(true); toast('Deleted for good');
    },
  });
}

/* ---------- events ---------- */
(() => {
  const box = $('stashBody');
  box.addEventListener('click', async (e) => {
    if (e.target.closest('a[data-open]')) { e.preventDefault(); openTask(Number(e.target.closest('a[data-open]').dataset.open)); return; }
    const b = e.target.closest('button'); if (!b) return; const d = b.dataset; const m = S.sm;
    try {
      if (d.smTab) { m.tab = d.smTab; renderStashMgr(); }
      else if (d.smReload) { m.cancel = true; await loadStashMgr(true); }
      else if (d.smDiff) openDiff(d.smDiff);
      else if (d.smRework) openRework(d.smRework);
      else if (d.smClear) openClearStashes([d.smClear]);
      else if (d.smClearSel) openClearStashes([...m.sel]);
      else if (d.smUnsel) { m.sel.clear(); renderStashMgr(); }
      else if (d.smSelShown) { smFiltered().forEach((r) => m.sel.add(smKey(r))); renderStashMgr(); }
      else if (d.smAnalyse) { const r = findRow(d.smAnalyse); if (r) { m.cancel = false; m.failed = false; await analyseRows([r]); renderStashMgr(); } }
      else if (d.smAnalyseAll) analyseAll();
      else if (d.smCancel) { m.cancel = true; m.analysing = null; renderStashMgr(); }
      else if (d.smHandled) openHandled(Number(d.smHandled));
      else if (d.smRestore) {
        const t = m.data.trash.find((x) => x.repoPath + '|' + x.hash === d.smRestore); if (!t) return;
        await api('/api/stash/restore', { body: { repo: t.repoPath, hash: t.hash } }); toast('Restored to the stash list'); await loadStashMgr(true);
      } else if (d.smPurge) openPurge();
    } catch (err) { toast(err.message, { bad: true }); }
  });
  box.addEventListener('change', (e) => {
    const m = S.sm; const t = e.target;
    if (t.dataset.sel) { if (t.checked) m.sel.add(t.dataset.sel); else m.sel.delete(t.dataset.sel); renderStashMgr(); }
    else if (t.dataset.tsel) { if (t.checked) m.trashSel.add(t.dataset.tsel); else m.trashSel.delete(t.dataset.tsel); renderStashMgr(); }
    else if (t.id === 'smRepo') { m.repo = t.value; renderStashMgr(); }
    else if (t.id === 'smVerdict') { m.verdict = t.value; renderStashMgr(); }
    else if (t.id === 'smAge') { m.age = t.value; renderStashMgr(); }
    else if (t.id === 'smSort') { m.sort = t.value; renderStashMgr(); }
  });
  box.addEventListener('input', (e) => {
    if (e.target.id !== 'smQ') return;
    S.sm.q = e.target.value; const pos = e.target.selectionStart; renderStashMgr();
    const q = $('smQ'); if (q) { q.focus(); q.setSelectionRange(pos, pos); }
  });
})();

if (S.view === 'stashes') loadStashMgr();
