/* Charts: weekly rating by area (small multiples) and stashes by age and verdict (stacked bars). Plain SVG drawn at the size the card really has
   (they redraw when it changes, so text stays readable from phone to wide screens), a validated palette (styles.css, .viz-root), hover and keyboard
   readouts, and a table view for each chart. Loaded after app.js; stash.js calls vizStash(). */
'use strict';
const SVG = 'http://www.w3.org/2000/svg';
function vz(tag, attrs, parent, text) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text; // labels come from settings and Azure DevOps: always text, never markup
  if (parent) parent.appendChild(n);
  return n;
}
function hx(tag, cls, text, parent) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; if (parent) parent.appendChild(n); return n; }
const vizNum = (n) => (n === null || n === undefined ? '-' : String(Math.round(n * 10) / 10));
const vizReduced = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- one tooltip for every chart ---------- */
let vizTipEl = null;
function vizTip() { if (!vizTipEl) { vizTipEl = hx('div', 'viz-tip'); vizTipEl.setAttribute('role', 'status'); vizTipEl.hidden = true; document.body.appendChild(vizTipEl); } return vizTipEl; }
// rows: [{ key: css colour or '', value, label }]  title: string
function vizShow(x, y, title, rows) {
  const t = vizTip(); t.textContent = '';
  hx('div', 'viz-tip-t', title, t);
  rows.forEach((r) => { const row = hx('div', 'viz-tip-r', undefined, t); if (r.key) { const k = hx('span', 'viz-tip-k', undefined, row); k.style.background = r.key; } hx('b', 'viz-tip-v', r.value, row); if (r.label) hx('span', 'viz-tip-l', r.label, row); });
  t.hidden = false;
  const w = t.offsetWidth; const h = t.offsetHeight;
  t.style.left = Math.max(8, Math.min(innerWidth - w - 8, x + 14)) + 'px';
  t.style.top = Math.max(8, Math.min(innerHeight - h - 8, y - h - 10 < 8 ? y + 18 : y - h - 10)) + 'px';
}
const vizHide = () => { if (vizTipEl) vizTipEl.hidden = true; };

// Text on a coloured mark: the ink (dark or light) with the better contrast against that mark.
function vizLum(hex) { const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim()); if (!m) return 0.5; const c = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
function vizInkOn(fill, dark, light) { const L = vizLum(fill); const cd = (L + 0.05) / (vizLum(dark) + 0.05); const cl = (vizLum(light) + 0.05) / (L + 0.05); return cd >= cl ? dark : light; }
const vizVar = (root, name) => getComputedStyle(root).getPropertyValue(name).trim();

/* ---------- the card: title, text, table-view switch, and a body that redraws when its width changes ---------- */
function vizCard(host, title, sub, onTable, draw) {
  host.textContent = '';
  const root = hx('section', 'viz-root viz-card', undefined, host); root.setAttribute('aria-label', title);
  const head = hx('div', 'viz-head', undefined, root); const hl = hx('div', undefined, undefined, head);
  hx('h3', 'viz-title', title, hl); const subEl = hx('div', 'viz-sub', sub, hl);
  const tb = hx('button', 'btn sm', 'Table view', head); tb.type = 'button'; tb.setAttribute('aria-pressed', 'false');
  const body = hx('div', 'viz-body', undefined, root); const table = hx('div', 'viz-table', undefined, root); table.hidden = true;
  let lastW = 0; let timer = null; let first = true;
  const run = () => { if (!body.isConnected || body.hidden) return; lastW = body.clientWidth; draw(body, root, first); first = false; };
  tb.addEventListener('click', () => { const on = table.hidden; table.hidden = !on; body.hidden = on; tb.setAttribute('aria-pressed', String(on)); tb.textContent = on ? 'Chart view' : 'Table view'; vizHide(); if (on && onTable) onTable(table); else run(); });
  if (window.ResizeObserver) new ResizeObserver(() => { if (!body.isConnected || body.hidden) return; if (Math.abs(body.clientWidth - lastW) < 12) return; clearTimeout(timer); timer = setTimeout(run, 120); }).observe(body);
  requestAnimationFrame(run);
  return { root, body, table, sub: subEl, redraw: run };
}
function vizTable(parent, headers, rows, caption) {
  parent.textContent = ''; const wrap = hx('div', 'scroll', undefined, parent); const t = hx('table', 'grid', undefined, wrap);
  if (caption) hx('caption', 'viz-sub', caption, t);
  const hr = hx('tr', undefined, undefined, hx('thead', undefined, undefined, t)); headers.forEach((h, i) => { const th = hx('th', i ? 'r' : '', h, hr); th.scope = 'col'; });
  const tb = hx('tbody', undefined, undefined, t); rows.forEach((r) => { const tr = hx('tr', undefined, undefined, tb); r.forEach((c, i) => { const td = hx(i ? 'td' : 'th', i ? 'r' : '', c, tr); if (!i) td.scope = 'row'; }); });
  t.dataset.cols = headers.map((_, i) => (i === 0 ? 'main' : 'num')).join(',');
}

/* ---------- 1. weekly rating by area: small multiples ---------- */
function vizRatings(host, R) {
  const areas = (R.areas || []).filter((a) => a.trend && a.trend.length);
  const weeks = areas.length ? areas[0].trend.map((t) => t.week) : [];
  vizCard(host, 'Weekly rating by area', 'Score out of 10 for each of the last ' + weeks.length + ' weeks. The grey line is the area\'s baseline. Weeks with no data are left blank, not drawn as zero.', (t) => {
    vizTable(t, ['Area', 'Baseline', ...weeks.map((w) => w.slice(5)), 'Last 14 days'], areas.map((a) => [a.label, vizNum(a.baseline && a.baseline.score), ...a.trend.map((p) => vizNum(p.score)), vizNum(a.recent && a.recent.score)]), 'Weekly score by area');
  }, (body, root, first) => drawRatings(body, areas, weeks, first));
}
function drawRatings(body, areas, weeks, first) {
  body.textContent = '';
  const grid = hx('div', 'viz-grid', undefined, body);
  if (!areas.length) { hx('div', 'empty', 'No weekly scores yet. They appear after the first calculation.', grid); return; }
  const cells = areas.map((a) => { const cell = hx('div', 'viz-cell', undefined, grid); return { a, hd: hx('div', 'viz-cell-h', undefined, cell), box: hx('div', 'viz-box', undefined, cell) }; });
  const W = Math.max(200, Math.min(460, Math.round(cells[0].box.clientWidth || 240))); const H = Math.round(Math.max(128, Math.min(180, W * 0.56)));
  const L = 30; const Rr = 16; const T = 20; const B = 28; const pw = W - L - Rr; const ph = H - T - B; const n = weeks.length;
  const X = (i) => L + (n === 1 ? pw / 2 : (i * pw) / (n - 1)); const Y = (s) => T + ph * (1 - s / 10);
  const step = W >= 340 ? 1 : W >= 270 ? 2 : n; // week labels: the first, the last, and the ones between that fit
  cells.forEach(({ a, hd, box }) => {
    const base = a.baseline && a.baseline.score !== null && a.baseline.score !== undefined ? a.baseline.score : null;
    const pts = a.trend.map((p, i) => ({ i, week: p.week, score: p.score === null || p.score === undefined ? null : p.score }));
    const have = pts.filter((p) => p.score !== null); const rec = a.recent && a.recent.score !== null && a.recent.score !== undefined ? a.recent.score : null;
    hx('b', undefined, a.label, hd);
    const delta = rec !== null && base !== null ? Math.round((rec - base) * 10) / 10 : null;
    const sub = hx('span', 'viz-cell-d', undefined, hd);
    if (base !== null) { const key = hx('span', 'viz-key', undefined, hd); hx('i', 'viz-key-line', undefined, key); hx('span', undefined, 'baseline ' + vizNum(base), key); } else hx('span', 'viz-key', 'no baseline yet', hd);
    if (rec === null) sub.textContent = 'No recent score';
    else { hx('span', undefined, 'Last 14 days ' + vizNum(rec), sub); if (delta !== null) { const d = hx('span', 'viz-delta ' + (delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'), delta > 0 ? '▲ +' + vizNum(delta) + ' vs baseline' : delta < 0 ? '▼ ' + vizNum(delta) + ' vs baseline' : '= baseline', sub); d.title = 'Compared with this area\'s baseline score of ' + vizNum(base); } }
    const svg = vz('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, class: 'viz-svg', role: 'img', tabindex: '0', 'aria-label': a.label + ': weekly scores ' + (have.map((p) => p.week.slice(5) + ' ' + vizNum(p.score)).join(', ') || 'none yet') + (base !== null ? '; baseline ' + vizNum(base) : '') }, box);
    [0, 5, 10].forEach((g) => { vz('line', { x1: L, x2: L + pw, y1: Y(g), y2: Y(g), class: g === 0 ? 'viz-axis' : 'viz-gridline' }, svg); vz('text', { x: L - 8, y: Y(g) + 4, 'text-anchor': 'end', class: 'viz-tick' }, svg, String(g)); });
    if (base !== null) { vz('line', { x1: L, x2: L + pw, y1: Y(base), y2: Y(base), class: 'viz-ref' }, svg); }
    if (!have.length) vz('text', { x: L + pw / 2, y: T + ph / 2, 'text-anchor': 'middle', class: 'viz-tick viz-halo' }, svg, 'No weekly data yet');
    // runs of consecutive weeks: an area under each and one line through each; a gap stays a gap
    const runs = []; let cur = null;
    pts.forEach((p) => { if (p.score === null) { cur = null; return; } if (!cur) { cur = []; runs.push(cur); } cur.push(p); });
    const g = vz('g', { class: 'viz-data' }, svg);
    runs.forEach((r) => {
      if (r.length < 2) return;
      vz('path', { d: 'M ' + X(r[0].i).toFixed(1) + ' ' + Y(0) + ' ' + r.map((p) => 'L ' + X(p.i).toFixed(1) + ' ' + Y(p.score).toFixed(1)).join(' ') + ' L ' + X(r[r.length - 1].i).toFixed(1) + ' ' + Y(0) + ' Z', class: 'viz-area' }, g);
      vz('path', { d: r.map((p, k) => (k ? 'L ' : 'M ') + X(p.i).toFixed(1) + ' ' + Y(p.score).toFixed(1)).join(' '), class: 'viz-line', pathLength: '1' }, g);
    });
    have.forEach((p) => vz('circle', { cx: X(p.i), cy: Y(p.score), r: 4.5, class: 'viz-dot' }, g));
    if (first && !vizReduced()) svg.classList.add('viz-anim');
    const last = have[have.length - 1]; if (last) vz('text', { x: Math.min(X(last.i), W - 10), y: Y(last.score) - 10, 'text-anchor': 'middle', class: 'viz-val viz-halo' }, svg, vizNum(last.score));
    weeks.forEach((wk, i) => { if (i === 0 || i === n - 1 || (i % step === 0 && i < n - 1 && n - 1 - i >= step)) vz('text', { x: X(i), y: H - 8, 'text-anchor': i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle', class: 'viz-tick' }, svg, wk.slice(5)); });
    const cross = vz('line', { y1: T, y2: T + ph, class: 'viz-cross', visibility: 'hidden' }, svg); const ring = vz('circle', { r: 8, class: 'viz-ring', visibility: 'hidden' }, svg);
    let at = have.length ? have[have.length - 1].i : -1;
    const show = (i, pt) => {
      if (i < 0) return; at = i; const p = pts[i]; cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.setAttribute('visibility', 'visible');
      if (p.score !== null) { ring.setAttribute('cx', X(i)); ring.setAttribute('cy', Y(p.score)); ring.setAttribute('visibility', 'visible'); } else ring.setAttribute('visibility', 'hidden');
      const r = svg.getBoundingClientRect(); const px = pt ? pt.x : r.left + X(i) * (r.width / W); const py = pt ? pt.y : r.top + r.height / 2;
      vizShow(px, py, a.label + ' · ' + p.week, [{ key: 'var(--viz-1)', value: p.score === null ? 'no data' : vizNum(p.score), label: 'weekly score' }].concat(base !== null ? [{ key: 'var(--viz-ref)', value: vizNum(base), label: 'baseline' }] : []).concat(a.original !== null && a.original !== undefined ? [{ key: '', value: vizNum(a.original), label: 'your earlier rating' }] : []));
    };
    const hide = () => { cross.setAttribute('visibility', 'hidden'); ring.setAttribute('visibility', 'hidden'); vizHide(); };
    const slot = (e) => { const r = svg.getBoundingClientRect(); const x = ((e.clientX - r.left) / r.width) * W; let best = 0; for (let i = 0; i < n; i++) if (Math.abs(X(i) - x) < Math.abs(X(best) - x)) best = i; return best; };
    svg.addEventListener('pointermove', (e) => show(slot(e), { x: e.clientX, y: e.clientY })); svg.addEventListener('pointerleave', hide);
    svg.addEventListener('focus', () => show(at < 0 ? 0 : at)); svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') { e.preventDefault(); show(Math.max(0, (at < 0 ? 0 : at) - 1)); } else if (e.key === 'ArrowRight') { e.preventDefault(); show(Math.min(n - 1, (at < 0 ? 0 : at) + 1)); } else if (e.key === 'Escape') hide(); });
  });
}

/* ---------- 2. stashes by age and verdict: stacked bars ---------- */
const VIZ_VERDICTS = [['safe', 'Safe to clear', '--viz-1'], ['obsolete', 'Likely obsolete', '--viz-2'], ['rework', 'Needs rework', '--viz-3'], ['old', 'Old, review', '--viz-4'], ['review', 'Worth reviewing', '--viz-5'], ['none', 'Not analysed yet', '--viz-none']];
const VIZ_AGES = [['Under 7 days', 'Under 7 d', 0, 7], ['7 to 30 days', '7 to 30 d', 7, 30], ['30 to 60 days', '30 to 60 d', 30, 60], ['60 to 90 days', '60 to 90 d', 60, 90], ['Over 90 days', 'Over 90 d', 90, Infinity]];
function vizStash(host, rows) {
  const day = 86400000; const now = Date.now();
  const grid = VIZ_AGES.map(() => Object.fromEntries(VIZ_VERDICTS.map((v) => [v[0], 0])));
  rows.forEach((r) => { const age = (now - Date.parse(r.createdAt)) / day; const bi = VIZ_AGES.findIndex((b) => age >= b[2] && age < b[3]); const k = r.verdict ? r.verdict.kind : 'none'; grid[bi < 0 ? 0 : bi][VIZ_VERDICTS.some((v) => v[0] === k) ? k : 'none']++; });
  const totals = grid.map((g) => Object.values(g).reduce((a, b) => a + b, 0)); const total = totals.reduce((a, b) => a + b, 0);
  const unknown = grid.reduce((n, g) => n + g.none, 0); const cleanable = grid.reduce((n, g) => n + g.safe + g.obsolete, 0);
  vizCard(host, 'Stashes by age and verdict', total + ' stashes. ' + (total - unknown) + ' analysed' + (total - unknown ? ', ' + cleanable + ' safe or likely obsolete' : '') + '. Click a part to filter the list below.', (t) => {
    vizTable(t, ['Age', ...VIZ_VERDICTS.map((v) => v[1]), 'Total'], VIZ_AGES.map((b, i) => [b[0], ...VIZ_VERDICTS.map((v) => String(grid[i][v[0]])), String(totals[i])]), 'Stashes by age and verdict');
  }, (body, root) => drawStash(body, root, grid, totals, total, unknown));
}
function drawStash(body, root, grid, totals, total, unknown) {
  body.textContent = '';
  if (!total) { hx('div', 'empty', 'No stashes in any clone. Nothing to tidy.', body); return; }
  if (unknown) {
    const note = hx('div', 'viz-note', undefined, body); hx('span', undefined, unknown + ' of ' + total + ' stashes have not been analysed yet, so the picture is incomplete.', note);
    const b = hx('button', 'btn sm', 'Analyse the rest', note); b.type = 'button'; b.addEventListener('click', () => { const m = S.sm; m.repo = ''; m.verdict = ''; m.age = ''; m.q = ''; if (typeof analyseAll === 'function') analyseAll(); });
  }
  // legend: every series, clickable (it filters the list)
  const leg = hx('div', 'viz-legend', undefined, body); leg.setAttribute('role', 'group'); leg.setAttribute('aria-label', 'Verdict legend, press to filter the list');
  VIZ_VERDICTS.forEach((v) => { const c = grid.reduce((n, g) => n + g[v[0]], 0); const b = hx('button', 'viz-leg', undefined, leg); b.type = 'button'; b.setAttribute('aria-pressed', String(S.sm.verdict === v[0])); const k = hx('span', 'viz-swatch', undefined, b); k.style.background = 'var(' + v[2] + ')'; hx('span', undefined, v[1], b); hx('span', 'viz-leg-n', String(c), b); b.addEventListener('click', () => vizPick(v[0])); });
  const W = Math.max(260, body.clientWidth || 700); const compact = W < 520;
  const dark = vizVar(root, '--viz-ink-dark') || '#1d1814'; const light = vizVar(root, '--viz-ink-light') || '#fffdf9';
  const barH = compact ? 22 : 24; const rowH = compact ? 56 : 42; const labelW = compact ? 0 : Math.min(130, Math.round(W * 0.18)); const right = 52; const top = 4; const H = top + rowH * VIZ_AGES.length + 4;
  const max = Math.max(...totals, 1); const scale = (W - labelW - right - (compact ? 8 : 0)) / max;
  const svg = vz('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, class: 'viz-svg viz-bars', role: 'group', 'aria-label': 'Stashes by age and verdict' }, body);
  VIZ_AGES.forEach((b, i) => {
    const y = top + i * rowH + (compact ? 22 : (rowH - barH) / 2); const x0 = compact ? 4 : labelW;
    const g = vz('g', { class: 'viz-row', tabindex: '0', role: 'group', 'aria-label': b[0] + ': ' + totals[i] + ' stashes, ' + VIZ_VERDICTS.filter((v) => grid[i][v[0]]).map((v) => grid[i][v[0]] + ' ' + v[1].toLowerCase()).join(', ') }, svg);
    if (compact) vz('text', { x: 4, y: y - 7, class: 'viz-cat' }, g, b[0]); else vz('text', { x: labelW - 12, y: y + barH / 2 + 4, 'text-anchor': 'end', class: 'viz-cat' }, g, W < 640 ? b[1] : b[0]);
    vz('rect', { x: x0, y, width: Math.max(0, W - x0 - right + 6), height: barH, rx: 6, class: 'viz-track' }, g);
    const segs = VIZ_VERDICTS.map((v) => ({ v, n: grid[i][v[0]] })).filter((s) => s.n > 0); let x = x0; const nodes = [];
    segs.forEach((s, k) => {
      const w = s.n * scale; const lastSeg = k === segs.length - 1; const drawW = Math.max(3, w - (lastSeg ? 0 : 2)); const r = 5;
      const path = lastSeg && drawW > r * 2 ? 'M ' + x + ' ' + y + ' H ' + (x + drawW - r) + ' a ' + r + ' ' + r + ' 0 0 1 ' + r + ' ' + r + ' V ' + (y + barH - r) + ' a ' + r + ' ' + r + ' 0 0 1 ' + (-r) + ' ' + r + ' H ' + x + ' Z' : 'M ' + x + ' ' + y + ' h ' + drawW + ' v ' + barH + ' h ' + (-drawW) + ' Z';
      const fill = vizVar(root, s.v[2]);
      const seg = vz('path', { d: path, class: 'viz-seg', style: 'fill:var(' + s.v[2] + ')', 'data-k': s.v[0] }, g);
      if (w >= String(s.n).length * 8 + 14) vz('text', { x: x + 7, y: y + barH / 2 + 4, class: 'viz-seg-t', style: 'fill:' + vizInkOn(fill, dark, light), 'pointer-events': 'none' }, g, String(s.n));
      const hit = vz('rect', { x, y: y - 6, width: Math.max(10, w), height: barH + 12, class: 'viz-hit', 'data-k': s.v[0] }, g); nodes.push({ seg, hit, s });
      const tip = (e) => { const pt = e && e.clientX ? { x: e.clientX, y: e.clientY } : (() => { const rr = seg.getBoundingClientRect(); return { x: rr.left + rr.width / 2, y: rr.top }; })(); seg.classList.add('hot'); vizShow(pt.x, pt.y, b[0], [{ key: 'var(' + s.v[2] + ')', value: String(s.n), label: s.v[1] }, { key: '', value: Math.round((100 * s.n) / totals[i]) + '%', label: 'of ' + totals[i] + ' stashes this age' }]); };
      hit.addEventListener('pointermove', tip); hit.addEventListener('pointerleave', () => { seg.classList.remove('hot'); vizHide(); }); hit.addEventListener('click', () => vizPick(s.v[0]));
      nodes[nodes.length - 1].tip = tip; x += w;
    });
    vz('text', { x: Math.max(x, x0) + 9, y: y + barH / 2 + 4.5, class: 'viz-val viz-end' }, g, String(totals[i]));
    let cur = -1; const clear = () => { nodes.forEach((n2) => n2.seg.classList.remove('hot')); vizHide(); };
    g.addEventListener('focus', () => { if (nodes.length) { cur = 0; nodes[0].tip(); } }); g.addEventListener('blur', () => { cur = -1; clear(); });
    g.addEventListener('keydown', (e) => { if (!nodes.length) return; if (e.key === 'ArrowRight') { e.preventDefault(); clear(); cur = Math.min(nodes.length - 1, cur + 1); nodes[cur].tip(); } else if (e.key === 'ArrowLeft') { e.preventDefault(); clear(); cur = Math.max(0, cur - 1); nodes[cur].tip(); } else if (e.key === 'Enter' && cur >= 0) vizPick(nodes[cur].s.v[0]); else if (e.key === 'Escape') clear(); });
  });
}
function vizPick(kind) { const m = S.sm; m.verdict = m.verdict === kind ? '' : kind; if (typeof render === 'function') render(); }
document.addEventListener('scroll', () => vizHide(), true);
