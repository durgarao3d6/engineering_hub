/* Testing page: flow specs, evidence, QA status, and the QA pack. Loaded after app.js (shares S, $, esc, api, toast, openDialog, badge, ago, copyText, paginate). */
'use strict';
S.ts = { data: null, loading: false, err: '', sel: new Set(), filter: 'all', q: '' };
S.pg.testing = { page: 1, size: 25, sizes: [10, 25, 50], sig: '' };
const QA_BADGE = { 'in-sync': ['In QA, up to date', 'ok'], differs: ['In QA, differs', 'warn'], 'not-in-qa': ['Not in QA, can be ported', 'info'], 'cannot-port': ['Cannot port yet', 'neu'], 'no-qa': ['No QA repository', 'neu'] };
const TS_FILTERS = [['all', 'All'], ['port', 'Can be ported'], ['differs', 'Differs from QA'], ['cannot-port', 'Cannot port'], ['noev', 'No evidence']];

async function loadTesting() {
  const t = S.ts; if (t.loading) return; t.loading = true; t.err = ''; render();
  try { t.data = await api('/api/testing'); t.sel.clear(); } catch (e) { t.err = e.message; }
  t.loading = false; render();
}
function tsRows() {
  const t = S.ts; if (!t.data) return [];
  const q = t.q.trim().toLowerCase();
  return t.data.entries.filter((e) => {
    if (t.filter === 'port' && e.status !== 'not-in-qa') return false;
    if (t.filter === 'differs' && e.status !== 'differs') return false;
    if (t.filter === 'cannot-port' && e.status !== 'cannot-port') return false;
    if (t.filter === 'noev' && e.evidence) return false;
    return !q || (e.file + ' ' + e.title + ' ' + e.requirementIds.join(' ') + ' ' + (e.bugId || '')).toLowerCase().includes(q);
  });
}
function evBadge(e) {
  if (!e.evidence) return badge('No evidence yet', 'neu');
  return e.evidence.ok ? badge('Evidence OK', 'ok') + '<div class="cell-sub">' + esc(e.evidence.at) + '</div>' : badge(/INCONCLUSIVE/.test(e.evidence.verdict) ? 'Inconclusive' : 'Not proven', 'warn') + '<div class="cell-sub">' + esc(e.evidence.at) + '</div>';
}
function renderTesting() {
  const t = S.ts; const box = $('testingBody'); const d = t.data;
  if (!d) { box.innerHTML = t.err ? errorBar({ title: 'The flow list didn\'t load.', detail: t.err, retry: 'testing' }) : skeleton('tiles', 4) + skeleton('rows', 6); return; }
  if (!d.configured) { box.innerHTML = '<div class="note warn">' + esc(d.note || 'No flow specs folder is set.') + ' Set <span class="mono">testing.specsDir</span> in hub.config.json.</div>'; return; }
  const rows = tsRows(); const sig = [t.filter, t.q].join('|'); const page = paginate('testing', rows, sig, 'pagerTestingTmp'); const pager = $('pagerTestingTmp').innerHTML;
  const sel = t.sel.size;
  const cnt = (f) => d.entries.filter(f).length;
  let h = '<div class="kpis">' + [['Flows', d.entries.length, 'info'], ['Can be ported', cnt((e) => e.status === 'not-in-qa'), 'info'], ['In QA, up to date', cnt((e) => e.status === 'in-sync'), 'ok'], ['Differ from QA', cnt((e) => e.status === 'differs'), cnt((e) => e.status === 'differs') ? 'warn' : ''], ['No evidence yet', cnt((e) => !e.evidence), cnt((e) => !e.evidence) ? 'warn' : '']].map((x) => '<div class="kpi ' + x[2] + '"><small>' + x[0] + '</small><b>' + x[1] + '</b></div>').join('') + '</div>'
    + '<div class="toolbar"><div class="search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input type="search" id="tsQ" value="' + esc(t.q) + '" placeholder="Search file, title, requirement id, bug" aria-label="Search flows"></div>'
    + '<div class="seg" role="group" aria-label="Filter">' + TS_FILTERS.map((f) => '<button type="button" data-ts-f="' + f[0] + '" aria-pressed="' + (t.filter === f[0]) + '">' + f[1] + '</button>').join('') + '</div><span style="flex:1"></span><button type="button" class="btn sm" data-ts-all="1">Select the ' + rows.length + ' shown</button></div>'
    + (sel ? '<div class="selbar" role="region" aria-label="Selected flows"><span><b>' + sel + '</b> flow' + (sel > 1 ? 's' : '') + ' selected</span><span class="selbar-r"><button type="button" class="btn sm" data-ts-none="1">Clear selection</button><button type="button" class="btn sm primary" data-ts-pack="1" title="Prepare flow cards, ported specs, inventory rows and Test Plans drafts in a new QA worktree">Build QA pack…</button></span></div>' : '');
  if (!d.qaConfigured) h += '<div class="note warn" style="margin-bottom:12px">No QA repository is set up (<span class="mono">testing.qa.path</span>), so the QA status and the pack are off. Flow cards still work.</div>';
  h += '<div class="card"><div class="scroll"><table class="grid" data-cols="select,main,num,state,state,actions"><thead><tr><th style="width:28px"></th><th>Flow</th><th>Steps</th><th>In ' + esc(d.names.qa) + '</th><th>Evidence</th><th class="r">Action</th></tr></thead><tbody>'
    + (page.map((e) => '<tr><td><input type="checkbox" data-ts-sel="' + esc(e.file) + '"' + (t.sel.has(e.file) ? ' checked' : '') + ' aria-label="Select ' + esc(e.file) + '"></td>'
      + '<td title="' + esc([e.file, e.bugId ? 'AB#' + e.bugId : '', ...e.requirementIds].filter(Boolean).join(' · ')) + '"><div class="cell-main">' + esc(e.title.replace(/^\[[^\]]*\]\s*/, '')) + '</div><div class="cell-sub"><span class="mono">' + esc(e.file) + '</span>' + (e.bugId ? ' · AB#' + e.bugId : '') + (e.requirementIds.length ? ' · ' + esc(e.requirementIds.slice(0, 4).join(', ')) : '') + '</div></td>'
      + '<td class="nowrap">' + e.steps + ' step(s)<div class="cell-sub">' + e.tests + ' test(s)</div></td>'
      + '<td><div class="badges">' + badge((QA_BADGE[e.status] || [e.label, 'neu'])[0], (QA_BADGE[e.status] || [0, 'neu'])[1]) + '</div><div class="cell-sub">' + esc(e.status === 'differs' ? e.label.replace('In QA, differs from ' + d.names.source, '').trim() + ' · ' + e.diffLines + ' line(s)' : e.why || '') + '</div></td>'
      + '<td>' + evBadge(e) + '</td><td class="r nowrap"><button type="button" class="btn sm" data-ts-open="' + esc(e.file) + '">Open</button></td></tr>').join('')
      || '<tr><td colspan="6"><div class="empty"><b>No flow matches</b>Change the filter or the search.</div></td></tr>')
    + '</tbody></table></div><div class="foot pager-bar"><span>' + d.entries.length + ' flow(s) · ' + d.evidenceRuns + ' evidence run(s) recorded · nothing here changes QA\'s repository until you build a pack.</span><div class="pager">' + pager + '</div></div></div>';
  if (d.library && d.library.length) h += '<div class="card" style="margin-top:16px;padding:14px 16px"><h3 style="margin:0 0 8px">Helper library: ' + esc(d.names.source) + ' vs the ' + esc(d.names.qa) + ' copy</h3><div class="muted" style="margin-bottom:8px">The hub only reports this. A flow that needs a newer helper cannot be ported until the QA copy is updated.</div>'
    + d.library.map((l) => '<div class="pl-row"><span class="mono">' + esc(l.file) + '</span><span>' + badge(l.label, l.status === 'in-sync' ? 'ok' : l.status === 'differs' ? 'warn' : 'neu') + '</span></div>').join('') + '</div>';
  if (d.packs && d.packs.length) h += '<div class="card" style="margin-top:16px;padding:14px 16px"><h3 style="margin:0 0 8px">Recent QA packs</h3>' + d.packs.map((p) => '<div class="pl-row"><span><b>' + esc(p.branch) + '</b> <span class="muted">' + p.files.length + ' file(s) · ' + esc(ago(p.at)) + '</span><div class="mono path">' + esc(p.worktree) + '</div></span><button type="button" class="btn sm" data-ts-copy="' + esc(p.worktree) + '">Copy path</button></div>').join('') + '</div>';
  const a = document.activeElement; if (a && a.id === 'tsQ') { box.innerHTML = h; const q = $('tsQ'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); } else box.innerHTML = h;
}

/* ---------- one flow ---------- */
const mdBlock = (title, text, copyKey) => '<div class="field"><label>' + title + ' <button type="button" class="linkbtn" data-ts-copytext="' + copyKey + '">Copy</button></label><pre class="diffpre" style="max-height:34vh">' + esc(text) + '</pre></div>';
async function tsOpen(file) {
  S.ts.copy = {};
  openDialog({ title: file, ok: 'Close', body: '<div id="tsDet" class="muted">Loading…</div>', submit: async () => {} });
  try {
    const d = await api('/api/testing/spec?file=' + encodeURIComponent(file)); S.ts.copy = { card: d.card, testcase: d.testCase, spec: d.portedSpec || '' };
    const qa = QA_BADGE[d.status] || [d.label, 'neu'];
    $('tsDet').innerHTML = '<div class="sum"><div class="cell-main">' + esc(d.title) + '</div><div class="cell-sub">' + badge(qa[0], qa[1]) + ' ' + esc(d.label) + (d.why ? ' · ' + esc(d.why) : '') + '</div>'
      + '<div class="cell-sub">' + (d.evidence ? 'Evidence: before ' + esc(d.evidence.before) + ', after ' + esc(d.evidence.after) + ', ' + esc(d.evidence.verdict) : 'No evidence recorded yet.' + (S.ts.data && S.ts.data.evidenceCommand ? ' Run it yourself: <span class="mono">' + esc(S.ts.data.evidenceCommand.split('<spec>').join(file)) + '</span>' : '')) + '</div></div>'
      + mdBlock('Flow card (for QA)', d.card, 'card') + mdBlock('Azure Test Plans test case draft', d.testCase, 'testcase')
      + (d.portedSpec ? mdBlock('Spec rewritten in QA\'s form', d.portedSpec, 'spec') : '<div class="note">This flow is not rewritten for QA: ' + esc(d.why || 'see the card') + '</div>')
      + (d.diff ? '<div class="field"><label>Difference from the QA copy (- QA, + rewrite of the ' + esc(S.ts.data.names.source) + ' spec)</label><pre class="diffpre">' + d.diff.map((l) => '<span class="' + (l.t === '+' ? 'dl-add' : l.t === '-' ? 'dl-del' : l.t === '~' ? 'dl-hunk' : '') + '">' + esc(l.t + ' ' + l.s) + '</span>').join('\n') + '</pre></div>' : '');
  } catch (e) { $('tsDet').innerHTML = '<div class="note bad">' + esc(e.message) + '</div>'; }
}

/* ---------- the pack ---------- */
function tsPack() {
  const files = [...S.ts.sel]; if (!files.length) return;
  const differs = files.filter((f) => (S.ts.data.entries.find((e) => e.file === f) || {}).status === 'differs');
  openDialog({ title: 'Build QA pack for ' + files.length + ' flow(s)', ok: 'Preview',
    body: '<div class="note">Nothing is written yet. The next step shows every file. Files go into a <b>new worktree and branch</b> of the QA repository, uncommitted; the live QA clone is not touched and nothing is pushed.</div>'
      + '<div class="field"><label>Include</label><div class="radios">' + [['card', 'Flow card (Markdown)'], ['spec', 'Spec rewritten in QA\'s form'], ['inventory', 'Inventory rows for docs/qa-setup-pattern.md'], ['testcase', 'Test Plans test case draft']].map((x) => '<label><input type="checkbox" name="inc-' + x[0] + '" checked> ' + x[1] + '</label>').join('') + '</div></div>'
      + (differs.length ? '<div class="field"><label>QA\'s copy differs for ' + differs.length + ' of these</label><div class="radios">' + differs.map((f) => '<label><input type="checkbox" name="ow-' + esc(f) + '"> Replace QA\'s copy of <span class="mono">' + esc(f) + '</span> (it is shown as a diff first)</label>').join('') + '</div></div>' : '')
      + '<div class="field"><label for="f-tid">Work item number <span class="muted">(optional, used in the branch name)</span></label><input id="f-tid" name="taskId" inputmode="numeric" maxlength="7"></div>',
    submit: async (v) => {
      const include = ['card', 'spec', 'inventory', 'testcase'].filter((k) => v['inc-' + k] !== undefined);
      const overwrite = differs.filter((f) => v['ow-' + f] !== undefined);
      const body = { files, include, overwrite, taskId: v.taskId || undefined };
      const pv = await api('/api/testing/preview', { body });
      setTimeout(() => tsConfirm(body, pv), 50);
    } });
}
function tsConfirm(body, pv) {
  const kind = { card: 'Flow card', spec: 'Ported spec', inventory: 'Inventory', testcase: 'Test case draft' };
  openDialog({ title: pv.files.length + ' file(s) to prepare', ok: pv.files.length ? 'Prepare in a new worktree' : 'Nothing to prepare',
    body: pv.files.map((f, i) => '<details' + (f.diff && f.kind !== 'card' ? ' open' : '') + '><summary><b>' + kind[f.kind] + '</b> <span class="mono">' + esc(f.path) + '</span> ' + (f.same ? badge('already there', 'ok') : f.exists ? badge('changed', 'warn') : badge('new', 'info')) + '</summary>'
      + (f.diff ? '<pre class="diffpre">' + f.diff.map((l) => '<span class="' + (l.t === '+' ? 'dl-add' : l.t === '-' ? 'dl-del' : l.t === '~' ? 'dl-hunk' : '') + '">' + esc(l.t + ' ' + l.s) + '</span>').join('\n') + '</pre>' : '<pre class="diffpre">' + esc(f.content.slice(0, 6000)) + (f.content.length > 6000 ? '\n…' : '') + '</pre>') + '</details>').join('')
      + (pv.skipped.length ? '<div class="note warn" style="margin-top:10px"><b>Left out:</b><br>' + pv.skipped.map((s) => esc(s.file + ': ' + s.why)).join('<br>') + '</div>' : '')
      + (pv.warnings.length ? '<div class="note warn" style="margin-top:10px">' + pv.warnings.map(esc).join('<br>') + '</div>' : ''),
    submit: async () => {
      if (!pv.files.length) return;
      const r = await api('/api/testing/pack', { body });
      S.ts.data = null; loadTesting();
      setTimeout(() => openDialog({ title: 'QA pack prepared', ok: 'Done', body: '<div class="note">Prepared <b>' + r.written.length + ' file(s)</b> on branch <span class="mono">' + esc(r.branch) + '</span> (from origin/main ' + esc(r.base) + '). Nothing is committed and nothing is pushed.</div>'
        + '<div class="sum"><div class="mono path">' + esc(r.worktree) + '</div></div><div class="muted" style="margin-top:8px">Review the files there. When you are happy, tell Claude to commit (one commit, AB#&lt;id&gt;: short description) or commit it yourself, then push and open the pull request when you decide.</div>'
        + '<button type="button" class="btn sm" id="tsCopyPath" style="margin-top:8px;width:auto;display:inline-flex">Copy the path</button>', onOpen: () => { $('tsCopyPath').addEventListener('click', () => copyText(r.worktree, 'Path copied')); }, submit: async () => {} }), 80);
    } });
}

/* ---------- events ---------- */
(() => {
  const box = $('testingBody');
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || !b.dataset) return; const D = b.dataset; const t = S.ts;
    if (D.tsReload) return loadTesting();
    if (D.tsF) { t.filter = D.tsF; return renderTesting(); }
    if (D.tsOpen) return tsOpen(D.tsOpen);
    if (D.tsPack !== undefined) return tsPack();
    if (D.tsNone !== undefined) { t.sel.clear(); return renderTesting(); }
    if (D.tsAll !== undefined) { tsRows().forEach((r) => t.sel.add(r.file)); return renderTesting(); }
    if (D.tsCopy) return copyText(D.tsCopy, 'Path copied');
  });
  box.addEventListener('change', (e) => { const f = e.target.dataset && e.target.dataset.tsSel; if (!f) return; if (e.target.checked) S.ts.sel.add(f); else S.ts.sel.delete(f); renderTesting(); });
  box.addEventListener('input', (e) => { if (e.target.id !== 'tsQ') return; S.ts.q = e.target.value; renderTesting(); });
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-ts-copytext]'); if (b && S.ts.copy) copyText(S.ts.copy[b.dataset.tsCopytext] || '', 'Copied'); });
})();
if (S.view === 'testing') loadTesting();
