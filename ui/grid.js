/* Grid system: every table.grid gets fixed column widths by column type, one-line cells with full text on hover, badges that never wrap,
   a sticky header, keyboard row navigation and a density switch. It reads the table the page already drew and changes no data.
   Column types are guessed from the header text (the list below); a table can say it outright with data-cols="select,main,state,...". Loaded last. */
'use strict';
(function () {
  // type -> how the column sizes itself. px = fixed; pct = share of the table; min = smallest width before the grid hides it or scrolls sideways.
  const TYPES = {
    select: { px: 44 }, id: { px: 92 }, state: { px: 232 }, num: { px: 92 }, short: { px: 128 }, sync: { px: 164 }, date: { px: 124 },
    actions: { px: 216, measure: true }, main: { pct: 34, min: 220 }, note: { pct: 22, min: 160 }, text: { pct: 12, min: 120 },
  };
  const HEADERS = {
    main: ['what was asked', 'first prompt', 'worktree', 'worktree and live repo', 'stash', 'flow', 'title', 'item', 'work item', 'name', 'task title', 'session'],
    id: ['task', 'pr', 'pull request', 'id', '#', 'work item id'],
    state: ['status', 'verdict', 'state', 'my vote', 'qa status', 'evidence', 'what'],
    actions: ['action', 'actions'],
    num: ['cache reads', 'cache writes', 'est. cost', 'idle', 'steps', 'tokens', 'cost', 'calls', 'in', 'out', 'files', 'count', 'turns', 'input', 'output', 'cache', 'total', 'age', 'size', 'measure', 'baseline', 'last 14 days', 'changes'],
    short: [],
    sync: ['sync'],
    date: ['made', 'cleared', 'opened', 'updated', 'when', 'created', 'last used', 'started', 'date', 'at', 'restored', 'handled'],
    note: ['last commit', 'reason', 'reason or result', 'note', 'notes', 'subject', 'description', 'summary', 'result', 'details', 'why', 'purpose'],
    text: ['folder', 'repo', 'repository', 'author', 'model', 'person', 'area', 'by', 'user', 'kind', 'type', 'section', 'branch', 'layer'],
  };
  const LOOKUP = new Map(); for (const [t, list] of Object.entries(HEADERS)) for (const h of list) LOOKUP.set(h, t);
  LOOKUP.set('changes', 'short'); // "13 files", "clean": short text, left aligned

  const cols = (table) => [...table.querySelectorAll('thead tr:first-child > th')];
  function typeOf(th, i, table) {
    const forced = (table.dataset.cols || '').split(',').map((s) => s.trim());
    if (forced[i] && TYPES[forced[i]]) return forced[i];
    const text = th.textContent.replace(/[▲▼]/g, '').trim().toLowerCase();
    if (!text) {
      const cell = table.querySelector('tbody tr:not(:has(.empty)) > :nth-child(' + (i + 1) + ')');
      if (cell && cell.querySelector('input[type=checkbox]')) return 'select';
      if (cell && cell.querySelector('button, .btn')) return 'actions';
      return th.classList.contains('r') ? 'actions' : 'select';
    }
    return LOOKUP.get(text) || 'text';
  }

  let applying = false;
  function enhance(table) {
    const heads = cols(table); if (!heads.length) return;
    const kinds = heads.map((th, i) => typeOf(th, i, table));
    const sig = kinds.join(',') + '|' + heads.length;
    applying = true;
    // colgroup (rebuilt only when the column kinds change)
    if (table.dataset.gridSig !== sig) {
      table.querySelector(':scope > colgroup')?.remove();
      const cg = document.createElement('colgroup');
      kinds.forEach((k, i) => { const c = document.createElement('col'); c.className = 'col-' + k; const t = TYPES[k]; if (t.px) c.style.width = t.px + 'px'; else c.style.width = t.pct + '%'; cg.appendChild(c); });
      table.prepend(cg); table.dataset.gridSig = sig; table.classList.add('gx');
      const mins = kinds.reduce((n, k) => n + (TYPES[k].px || TYPES[k].min), 0); table.style.setProperty('--gx-min', mins + 'px');
      heads.forEach((th) => { th.style.width = ''; });
    }
    const rows = [...table.querySelectorAll('tbody > tr')];
    const real = rows.filter((r) => !r.querySelector(':scope > td[colspan]'));
    heads.forEach((th, i) => { th.classList.add('col-' + kinds[i]); if (!th.title && th.scrollWidth > th.clientWidth) th.title = th.textContent.replace(/[▲▼]/g, '').trim(); });
    for (const tr of real) {
      tr.querySelectorAll(':scope > td').forEach((td, i) => { const k = kinds[i]; if (k && !td.classList.contains('col-' + k)) td.classList.add('col-' + k); });
      tr.querySelectorAll(':scope > td.col-note').forEach((td) => { if (td.children.length === 0 && td.textContent.trim()) { const d = document.createElement('div'); d.className = 'gx-clamp'; d.textContent = td.textContent; td.textContent = ''; td.appendChild(d); } });
      if (!tr.hasAttribute('tabindex') && tr.querySelector('a, button, [data-open]')) tr.tabIndex = 0;
    }
    // the actions column is as wide as its widest button row
    const ai = kinds.indexOf('actions');
    if (ai >= 0 && real.length) {
      let w = 0; real.forEach((tr) => { const td = tr.children[ai]; if (td) { let sum = 0; td.querySelectorAll(':scope > .btn, :scope > button, :scope > a.btn').forEach((b) => { sum += b.offsetWidth + 8; }); w = Math.max(w, sum); } });
      if (w) { const col = table.querySelector('colgroup').children[ai]; if (col) col.style.width = Math.min(280, Math.max(104, w + 24)) + 'px'; }
    }
    // the table's own stripe of ids for keyboard users
    table.setAttribute('role', 'table');
    applying = false;
    fitColumns(table, kinds);
    fitBadges(table);
    const card = table.closest('.card'); if (card && roAll && !watched.has(card)) { watched.add(card); roAll.observe(card); }
  }

  // Not enough room: the least important columns step aside (note, date, text, sync, short, num), never id, main, state or actions.
  const DROP = ['note', 'date', 'text', 'sync', 'short', 'num'];
  function fitColumns(table, kinds) {
    const heads = cols(table); const group = table.querySelector(':scope > colgroup'); if (!group) return;
    const width = (i) => { const k = kinds[i]; const px = parseFloat(group.children[i] && group.children[i].style.width); return k === 'actions' || TYPES[k].px ? (TYPES[k].px ? (px || TYPES[k].px) : px) : TYPES[k].min; };
    const avail = (table.closest('.card') || table.parentElement).clientWidth || 1000;
    const custom = (table.dataset.drop || '').split(',').map((x) => x.trim()).filter(Boolean); const order = [...custom, ...DROP.filter((k) => !custom.includes(k))];
    const off = new Set(); let sum = kinds.reduce((n, k, i) => n + width(i), 0);
    for (const k of order) for (let i = kinds.length - 1; i >= 0; i--) if (kinds[i] === k && sum > avail) { off.add(i); sum -= width(i); }
    applying = true;
    kinds.forEach((k, i) => { const hide = off.has(i); heads[i].classList.toggle('gx-off', hide); if (group.children[i]) group.children[i].classList.toggle('gx-off', hide); });
    table.querySelectorAll('tbody > tr').forEach((tr) => { if (tr.querySelector(':scope > td[colspan]')) return; [...tr.children].forEach((td, i) => td.classList.toggle('gx-off', off.has(i))); });
    table.style.setProperty('--gx-min', sum + 'px'); applying = false;
  }

  // Badges stay on one line: the ones that do not fit are replaced by "+N" (with their names on hover).
  function fitBadges(table) {
    table.querySelectorAll('td.col-state').forEach((td) => {
      td.querySelectorAll('.gx-more').forEach((m) => m.remove());
      const badges = [...td.querySelectorAll('.badge')]; badges.forEach((b) => b.classList.remove('gx-hide'));
      const box = td.querySelector('.badges') || td; const over = () => box.scrollWidth > box.clientWidth + 1;
      if (badges.length < 2 || !over()) return;
      const more = document.createElement('span'); more.className = 'badge b-neu gx-more'; (td.querySelector('.badges') || td).appendChild(more);
      let hidden = [];
      for (let i = badges.length - 1; i >= 1; i--) {
        badges[i].classList.add('gx-hide'); hidden.unshift(badges[i].textContent.trim());
        more.textContent = '+' + hidden.length;
        if (!over()) break;
      }
      more.title = hidden.join(', '); more.setAttribute('aria-label', hidden.length + ' more: ' + hidden.join(', '));
    });
  }

  /* ---- keep tables enhanced as the page redraws them ---- */
  const dirty = new Set(); let queued = false;
  const flush = () => { queued = false; for (const t of dirty) if (t.isConnected) enhance(t); dirty.clear(); };
  const mark = (n) => { const t = n.nodeType === 1 && (n.closest ? n.closest('table.grid') : null); if (t) { dirty.add(t); if (!queued) { queued = true; requestAnimationFrame(flush); } } };
  const scanTree = (root) => { if (root.nodeType !== 1) return; if (root.matches && root.matches('table.grid')) mark(root); else if (root.querySelectorAll) root.querySelectorAll('table.grid').forEach(mark); mark(root); };
  new MutationObserver((list) => { if (applying) return; for (const m of list) { if (m.target.closest && m.target.closest('colgroup')) continue; mark(m.target); m.addedNodes.forEach(scanTree); } }).observe(document.body, { childList: true, subtree: true });
  scanTree(document.body);
  const watched = new WeakSet(); let roAll = null;
  if (window.ResizeObserver) { const ro = roAll = new ResizeObserver(() => { document.querySelectorAll('table.grid.gx').forEach((t) => { const k = [...t.querySelectorAll('thead tr:first-child > th')].map((th) => ([...th.classList].find((c) => c.startsWith('col-')) || 'col-text').slice(4)); fitColumns(t, k); fitBadges(t); }); }); ro.observe(document.querySelector('.main') || document.body); }

  /* ---- full text on hover for anything that was cut ---- */
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest && e.target.closest('.grid .cell-main, .grid .cell-sub, .grid td, .grid th'); if (!el || el.title) return;
    const clipped = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 2;
    if (clipped) { const t = el.textContent.replace(/\s+/g, ' ').trim(); if (t) el.title = t; }
  });

  /* ---- keyboard: up and down move between rows, Enter does the row's main thing ---- */
  document.addEventListener('keydown', (e) => {
    const tr = e.target.closest && e.target.closest('table.grid tbody > tr'); if (!tr || e.target !== tr) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { let n = e.key === 'ArrowDown' ? tr.nextElementSibling : tr.previousElementSibling; while (n && n.tabIndex < 0) n = e.key === 'ArrowDown' ? n.nextElementSibling : n.previousElementSibling; if (n) { e.preventDefault(); n.focus(); } }
    else if (e.key === 'Enter') { const a = tr.querySelector('[data-open], .tlink, button.primary, a[href]'); if (a) { e.preventDefault(); a.click(); } }
  });

  /* ---- density: comfortable or compact rows, remembered ---- */
  const setDensity = (d) => { document.documentElement.dataset.density = d; try { localStorage.setItem('hub.density', d); } catch { /* optional */ } const b = document.getElementById('density'); if (b) { b.setAttribute('aria-pressed', String(d === 'compact')); b.textContent = d === 'compact' ? 'Compact rows' : 'Comfortable rows'; } requestAnimationFrame(() => document.querySelectorAll('table.grid.gx').forEach(fitBadges)); };
  let saved = 'comfortable'; try { saved = localStorage.getItem('hub.density') || saved; } catch { /* optional */ }
  const host = document.querySelector('.top-actions');
  if (host) { const b = document.createElement('button'); b.type = 'button'; b.id = 'density'; b.className = 'btn sm'; b.title = 'How tall the table rows are'; b.addEventListener('click', () => setDensity(document.documentElement.dataset.density === 'compact' ? 'comfortable' : 'compact')); host.prepend(b); }
  setDensity(saved === 'compact' ? 'compact' : 'comfortable');
})();
