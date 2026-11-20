/* Motion: the summary cards count up when their number first appears or changes, and slide in once. Nothing here changes data.
   Off for people who ask their system for less motion. Loaded last. */
'use strict';
(function () {
  const reduce = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const seen = new Map(); // card label -> { n: the number it last showed, at: when it first appeared }
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  function countTo(el, from, to) {
    if (reduce() || from === to) { el.textContent = String(to); return; }
    const t0 = performance.now(); const dur = Math.min(900, 350 + Math.abs(to - from) * 12);
    el.textContent = String(from);
    (function tick(now) {
      const p = Math.min(1, (now - t0) / dur);
      el.textContent = String(Math.round(from + (to - from) * ease(p)));
      if (p < 1) requestAnimationFrame(tick);
    })(t0);
  }
  function prepare(card) {
    if (card.dataset.kpiDone) return; card.dataset.kpiDone = '1';
    const num = card.querySelector('b'); const label = card.querySelector('small');
    if (!num || !label) return;
    const text = num.textContent.trim(); if (!/^\d{1,7}$/.test(text)) return; // only plain whole numbers count up
    const key = label.textContent.trim(); const to = Number(text); const prev = seen.get(key); const now = Date.now();
    // the page may redraw a card right after it appeared (several loads in a row): keep the entrance going instead of cutting it short
    if (prev === undefined || (prev.n === to && now - prev.at < 1500)) { if (prev === undefined) seen.set(key, { n: to, at: now }); card.classList.add('kpi-in'); card.style.setProperty('--i', String([...seen.keys()].indexOf(key) % 6)); countTo(num, 0, to); }
    else if (prev.n !== to) { seen.set(key, { n: to, at: now }); card.classList.add('kpi-pop'); countTo(num, prev.n, to); }
  }
  const scan = (root) => { if (root.nodeType !== 1) return; if (root.matches && root.matches('.kpi')) prepare(root); root.querySelectorAll && root.querySelectorAll('.kpi').forEach(prepare); };
  new MutationObserver((list) => { for (const m of list) m.addedNodes.forEach(scan); }).observe(document.body, { childList: true, subtree: true });
  scan(document.body);
})();
