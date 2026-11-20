'use strict';
// Testing phase: turns the platform flow specs into what QA needs (flow card, QA-style spec, inventory row, Test Plans case draft), and shows
// where each flow stands in the QA repository. Reads only spec files, evidence summaries and QA's sources; never environment files, saved logins or traces.
// Writing into the QA repository happens only in buildPack(), only inside a new worktree, only to the four allowed paths, never a commit or a push.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const store = require('./store');
const sp = require('./lib/specparse');
const { gitx } = require('./collectors/git');

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SECRET = /(password|passwd|secret|api[_-]?key|bearer\s+[a-z0-9._-]{12,}|authorization:\s*\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.|[A-Za-z0-9+/]{40,}={0,2}\s*['"`])/i;
const SECRET_PATHS = /(^|[\\/])(\.env(\..*)?|\.auth|user\.json|trace\.zip|test-results|playwright-report|reports)([\\/]|$)/i;
const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

/* ---------- text rules (pure, unit tested) ---------- */
const canonImport = (stmt) => {
  const m = /^import\s+(type\s+)?\{([^}]*)\}\s+from\s+(['"])([^'"]+)\3;?$/.exec(stmt.trim());
  if (!m) return stmt.trim();
  return 'import ' + (m[1] || '') + '{ ' + m[2].split(',').map((s) => s.trim()).filter(Boolean).sort().join(', ') + " } from '" + m[4] + "';";
};
// Compare files ignoring line endings, trailing spaces, blank-line runs and the order of names inside an import.
const normalise = (t) => String(t).replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/^import\b[^;]*;/gm, (m) => canonImport(m)).replace(/\n{3,}/g, '\n\n').trim() + '\n';
const underscored = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '_');

// The rewrite QA applied by hand: library imports point into QA's copy, a tag list and a serial setting follow the imports, covers() receives the tags.
function portText(lpText, qa, tags) {
  let t = String(lpText).replace(/\r\n/g, '\n');
  t = t.replace(new RegExp('from (["\'])' + escapeRe(qa.importFrom) + '([\\w-]+)\\1', 'g'), (m, q, n) => "from '" + qa.importTo + n + "'");
  const imports = [...t.matchAll(/^import\b[^;]*;/gm)]; const last = imports[imports.length - 1];
  if (!last) return t;
  const at = last.index + last[0].length;
  const block = '\n\n/** Suite tags for every test in this file (level + area). */\nconst TAGS = [' + tags.map((x) => "'" + x + "'").join(', ') + '];\n\n// Tests share state, so they run serially: in file order on one worker, and a failure skips the rest.\ntest.describe.configure({ mode: \'serial\', timeout: ' + underscored(qa.serialTimeoutMs) + ' });';
  t = t.slice(0, at) + block + t.slice(at);
  // covers() carries the tags; a test that only records a product issue gets them as an explicit option. A line break after covers( is kept.
  t = t.replace(/\bcovers\((\s*)(?=['"`])/g, (m, ws) => (/\n/.test(ws) ? 'covers(TAGS,' + ws : 'covers(TAGS, '));
  return t.replace(/\{\s*annotation:\s*\[productIssue\(/g, '{ tag: TAGS, annotation: [productIssue(');
}
const tagsOfQa = (qaText) => { const m = /const TAGS = \[([^\]]*)\]/.exec(String(qaText || '')); return m ? [...m[1].matchAll(/(['"`])([^'"`]*)\1/g)].map((x) => x[2]) : null; };
const exportsOf = (libText) => new Set([...String(libText).matchAll(/^export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|class|enum|interface|type)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1])
  .concat([...String(libText).matchAll(/^export\s*\{([^}]*)\}/gm)].flatMap((m) => m[1].split(',').map((x) => x.trim().split(/\s+as\s+/).pop()).filter(Boolean))));

// A small line diff (longest common subsequence), shown with a little context. Enough for files of a few hundred lines.
function lineDiff(a, b, context = 2) {
  const A = String(a).split('\n'); const B = String(b).split('\n');
  const n = A.length; const m = B.length; const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0; let j = 0;
  while (i < n && j < m) { if (A[i] === B[j]) { out.push({ t: ' ', s: A[i] }); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) out.push({ t: '-', s: A[i++] }); else out.push({ t: '+', s: B[j++] }); }
  while (i < n) out.push({ t: '-', s: A[i++] }); while (j < m) out.push({ t: '+', s: B[j++] });
  const keep = new Array(out.length).fill(false);
  out.forEach((l, k) => { if (l.t !== ' ') for (let d = -context; d <= context; d++) if (out[k + d]) keep[k + d] = true; });
  const res = []; let skipped = false;
  out.forEach((l, k) => { if (keep[k]) { res.push(l); skipped = false; } else if (!skipped) { res.push({ t: '~', s: '...' }); skipped = true; } });
  return { changed: out.filter((l) => l.t !== ' ').length, lines: res };
}

/* ---------- evidence (the summary files your evidence runs write) ---------- */
function parseEvidence(summary, folder) {
  const get = (re) => { const m = re.exec(summary); return m ? m[1].trim() : ''; };
  const spec = get(/^#\s*Evidence:\s*(.+)$/m); const before = get(/^- Before[^:]*:\s*(.+?)\s{2,}-/m) || get(/^- Before[^:]*:\s*(.+)$/m); const after = get(/^- After[^:]*:\s*(.+?)\s{2,}-/m) || get(/^- After[^:]*:\s*(.+)$/m);
  const verdict = get(/^- Verdict:\s*\*\*(.+?)\*\*/m); const d = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(folder);
  return { run: folder, spec: spec.replace(/^.*[\\/]/, ''), coWorker: get(/^- Co-worker:\s*(.+)$/m), service: get(/^- Service:\s*([^(]+)/m).trim(), before, after, verdict, ok: /^EVIDENCE OK/i.test(verdict), at: d ? d[1] + '-' + d[2] + '-' + d[3] + ' ' + d[4] + ':' + d[5] : '' };
}
function readEvidence(dir) {
  const out = [];
  try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (!e.isDirectory()) continue; const f = path.join(dir, e.name, 'summary.md'); if (exists(f)) { try { out.push(parseEvidence(read(f), e.name)); } catch { /* unreadable run */ } } } } catch { /* no evidence folder */ }
  return out.sort((a, b) => b.run.localeCompare(a.run));
}

/* ---------- documents ---------- */
const sentences = (s) => String(s || '').split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
const idsText = (spec) => [...new Set(spec.tests.flatMap((t) => t.requirementIds))];
const SETUP_HINT = /(never makes|never make|leaves|every run|mints|seed|clean|shared data|api only|no azure maps|polled|needs a|requires a|already holds)/i;
function flowCard(spec, o = {}) {
  const ev = o.evidence || null; const qaState = o.qa || {};
  const L = [];
  const title = spec.tests.length === 1 ? spec.tests[0].title : spec.name.replace(/\.spec\.ts$|\.ui\.spec\.ts$/g, '').replace(/[-_]/g, ' ');
  L.push('# ' + title.replace(/^\[[^\]]*\]\s*/, ''), '');
  L.push('> Flow card written from the ' + cfg.testing.names.source + ' spec `' + spec.name + '`' + (o.date ? ' on ' + o.date : '') + '. It describes what the automated check does so QA can confirm it tests the right thing.', '');
  L.push('| | |', '|---|---|', '| Kind | ' + (spec.isUi ? 'UI flow' : 'API flow (no browser)') + ' |', '| Covers | ' + (idsText(spec).join(', ') || 'not stated') + ' |');
  if (spec.bugId) L.push('| Bug | AB#' + spec.bugId + ' |');
  const sources = [...new Set(spec.tests.map((t) => t.source).filter(Boolean))]; if (sources.length) L.push('| Source sections | ' + sources.join('; ').replace(/\|/g, '/') + ' |');
  L.push('| Tests in this flow | ' + spec.tests.length + ' |', '');
  if (spec.header) L.push('## Purpose', '', ...spec.header.split('\n\n'), '');
  const pre = sentences(spec.header).filter((s) => SETUP_HINT.test(s));
  L.push('## Preconditions and data', '', ...(pre.length ? pre.map((s) => '- ' + s) : ['- Runs against the standard test data of the flow suite; see the purpose above.']), '- Each run creates its own ids, so runs do not collide.', '');
  L.push('## Steps and expected results', '');
  spec.tests.forEach((t, ti) => {
    L.push('### ' + (spec.tests.length > 1 ? (ti + 1) + '. ' : '') + t.title.replace(/^\[[^\]]*\]\s*/, ''), '');
    if (t.requirementIds.length) L.push('Covers: ' + t.requirementIds.join(', '), '');
    t.steps.forEach((s, i) => { L.push((i + 1) + '. ' + s.title); s.expects.slice(0, 8).forEach((e) => L.push('   - Expected: ' + e)); });
    if (!t.steps.length) L.push('_The spec has no named steps; read the test title above._');
    L.push('');
  });
  const skips = spec.tests.flatMap((t) => t.skips.map((s) => ['The test is skipped when:', s])); const issues = spec.tests.flatMap((t) => t.productIssues.map((s) => ['Known product issue:', s]));
  if (skips.length || issues.length) L.push('## Known gaps', '', ...skips.concat(issues).map(([k, v]) => '- ' + k + ' ' + v), '');
  L.push('## Evidence', '');
  if (ev) L.push('- Before the fix (registry build): ' + (ev.before || 'not recorded'), '- After the fix (built from the change): ' + (ev.after || 'not recorded'), '- Verdict: ' + (ev.verdict || 'not recorded'), '- Run: ' + ev.run + (ev.at ? ' (' + ev.at + ')' : '') + (ev.service ? ', service ' + ev.service : ''));
  else L.push('- No evidence run has been recorded for this flow yet.');
  L.push('', '## Where it lives', '', '- ' + cfg.testing.names.source + ': `' + path.basename(cfg.testing.specsDir || 'specs') + '/' + spec.name + '`', '- ' + cfg.testing.names.qa + ': ' + (qaState.path ? '`' + qaState.path + '` (' + (qaState.label || qaState.status) + ')' : 'not ported yet'), '');
  return L.join('\n');
}
function testCaseDraft(spec, o = {}) {
  const L = []; const qaFile = (o.qaPath || '').replace(/^.*\//, '') || spec.name;
  spec.tests.forEach((t, ti) => {
    L.push('# Test case' + (spec.tests.length > 1 ? ' ' + (ti + 1) : '') + ': ' + t.title, '');
    L.push('Suite: ' + (o.suite || 'Regression') + ' / API', 'Priority: ' + (o.priority || '2'), 'Covers: ' + (t.requirementIds.join(', ') || 'not stated'), '');
    L.push('Associated automation (Test Case > Associated Automation tab):', '- Automated test storage: ' + qaFile, '- Automated test name: ' + t.title, '');
    L.push('| # | Action | Expected result |', '|---|--------|-----------------|');
    t.steps.forEach((s, i) => L.push('| ' + (i + 1) + ' | ' + s.title.replace(/\|/g, '/') + ' | ' + (s.expects.slice(0, 4).join('; ').replace(/\|/g, '/') || 'The step completes without error') + ' |'));
    L.push('');
  });
  return L.join('\n');
}
// Adds (or extends) a group of ported flow specs in the QA inventory document and keeps its summary table honest. CRLF files stay CRLF.
function inventoryPatch(doc, qaCfg, items) {
  const eol = doc.includes('\r\n') ? '\r\n' : '\n'; const text = doc.replace(/\r\n/g, '\n');
  const mod = '`' + qaCfg.specsDir.replace(/\/?$/, '/') + '`'; const head = '### ' + (qaCfg.inventoryHeading || 'Ported flow specs');
  const row = (i) => '| ' + mod + ' | `' + i.file + '` | ' + i.title.replace(/\|/g, '/') + ' | Active |';
  let body = text; let have = [];
  const at = body.indexOf(head);
  if (at >= 0) {
    const end = body.indexOf('\n###', at + 5); const sec = body.slice(at, end < 0 ? body.length : end);
    have = sec.split('\n').filter((l) => l.startsWith('| `'));
    const fresh = items.filter((i) => !have.some((l) => l.includes('`' + i.file + '`') && l.includes(i.title.replace(/\|/g, '/'))));
    if (!fresh.length) return { text: doc, changed: false, added: 0, note: 'Already listed.' };
    const insertAt = (end < 0 ? body.length : end); const trimmed = body.slice(0, insertAt).replace(/\n+$/, '\n');
    body = trimmed + fresh.map(row).join('\n') + '\n\n' + body.slice(insertAt).replace(/^\n+/, '');
    have = have.concat(fresh.map(row));
  } else {
    const sumAt = body.indexOf('### Inventory Summary');
    if (sumAt < 0) return { text: doc, changed: false, added: 0, note: 'The inventory summary heading was not found; add these rows by hand.', rows: items.map(row) };
    const block = head + '\n\n| Module | File | Test Case | Status |\n|--------|------|-----------|--------|\n' + items.map(row).join('\n') + '\n\n';
    body = body.slice(0, sumAt) + block + body.slice(sumAt); have = items.map(row);
  }
  // summary table: one row for this group, and the total follows
  const lines = body.split('\n'); const n = have.length;
  const sumLabel = qaCfg.inventorySummary || 'Ported flow specs'; const idx = lines.findIndex((l) => l.startsWith('| ' + sumLabel + ' |')); const tot = lines.findIndex((l) => /^\| \*\*Total\*\*/.test(l));
  if (tot >= 0) {
    const m = /^\| \*\*Total\*\* \| \*\*(\d+)\*\* \| \*\*(\d+)\*\* \|/.exec(lines[tot]);
    const old = idx >= 0 ? Number((/\|\s*(\d+)\s*\|\s*\d+\s*\|$/.exec(lines[idx]) || [, 0])[1]) : 0;
    if (m) { lines[tot] = '| **Total** | **' + (Number(m[1]) - old + n) + '** | **' + m[2] + '** |'; }
    const sumRow = '| ' + sumLabel + ' | ' + n + ' | 0 |';
    if (idx >= 0) lines[idx] = sumRow; else lines.splice(tot, 0, sumRow);
  }
  return { text: lines.join('\n').replace(/\n/g, eol), changed: true, added: n - have.length + (items.length), note: '' };
}

/* ---------- the catalogue and the pack ---------- */
function create(settings) {
  const S = settings || cfg.testing; const qa = S.qa;
  const qaPath = (rel) => path.join(qa.path, ...rel.split('/'));
  const guardPath = (p) => { if (SECRET_PATHS.test(p)) throw Object.assign(new Error('Refusing to read ' + p + ' (it may hold secrets).'), { status: 400 }); return p; };

  async function lastChange(repoDir, file) {
    const r = await gitx(repoDir, ['log', '-1', '--format=%cI', '--', file], 20000);
    return r.ok && r.out ? r.out.split('\n')[0] : null;
  }
  function qaLib() { // exported names per library file in QA's copy
    const dir = qaPath(qa.libDir); const out = {};
    try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.ts')) out[f.replace(/\.ts$/, '')] = exportsOf(read(guardPath(path.join(dir, f)))); } catch { /* no library */ }
    return out;
  }
  function portability(spec, lib) {
    if (spec.isUi) return { ok: false, why: 'A UI flow: QA keeps its own page objects, so it is described in a flow card instead of ported.' };
    const missing = [];
    for (const imp of spec.imports) {
      const m = /^\.\.\/lib\/([\w-]+)$/.exec(imp.from); if (!m) continue;
      if (!lib[m[1]]) { missing.push(m[1] === 'gremlin' ? 'gremlin (internal graph queries QA cannot reach)' : m[1] === 'routing' ? 'routing (internal route helpers)' : 'library file ' + m[1]); continue; }
      for (const n of imp.names) { const base = n.split(/\s+as\s+/)[0].trim(); if (!lib[m[1]].has(base)) missing.push(base + ' from ' + m[1]); }
    }
    return missing.length ? { ok: false, why: 'QA\'s library lacks: ' + [...new Set(missing)].join(', ') + '.' } : { ok: true, why: '' };
  }
  async function entryFor(file, evidence, lib) {
    const lpFile = path.join(S.specsDir, file); const lpText = read(guardPath(lpFile)); const spec = sp.parse(lpText, file);
    const qaRel = qa.specsDir + '/' + file; const qaFile = qaPath(qaRel); const qaText = qa.path && exists(qaFile) ? read(guardPath(qaFile)) : null;
    const tags = (qaText && tagsOfQa(qaText)) || qa.defaultTags; const port = portability(spec, lib);
    const ev = evidence.find((e) => e.spec === file) || null;
    let status; let label; let diff = null; let hint = null;
    if (!qa.path) { status = 'no-qa'; label = 'No QA repository set up'; }
    else if (qaText !== null) {
      const want = normalise(portText(lpText, qa, tags)); const have = normalise(qaText);
      if (want === have) { status = 'in-sync'; label = 'In QA, up to date'; }
      else {
        status = 'differs'; label = 'In QA, differs from ' + cfg.testing.names.source; diff = lineDiff(have, want);
        const [lpd, qad] = await Promise.all([lastChange(S.specsDir, file), lastChange(qa.path, qaRel)]);
        hint = lpd && qad ? (lpd > qad ? cfg.testing.names.source + ' changed after the port' : 'The QA copy was edited after the port') : null;
        if (hint) label += ' (' + hint + ')';
      }
    } else if (port.ok) { status = 'not-in-qa'; label = 'Not in QA yet (can be ported)'; }
    else { status = 'cannot-port'; label = 'Cannot port yet'; }
    return { file, name: spec.name, title: spec.tests.length === 1 ? spec.tests[0].title : spec.tests.length + ' tests', tests: spec.tests.length, steps: spec.tests.reduce((n, t) => n + t.steps.length, 0), requirementIds: idsText(spec), bugId: spec.bugId, isUi: spec.isUi,
      status, label, why: port.ok ? '' : port.why, portable: port.ok, qaPath: qaText !== null ? qaRel : null, diff, hint, evidence: ev, spec, lpText, qaText, tags };
  }
  async function catalogue() {
    if (!S.specsDir || !exists(S.specsDir)) return { configured: false, entries: [], note: 'No flow specs folder is set (testing.specsDir).' };
    const files = fs.readdirSync(S.specsDir).filter((f) => f.endsWith('.spec.ts')).sort();
    const evidence = readEvidence(S.evidenceDir); const lib = qa.path ? qaLib() : {};
    const entries = []; for (const f of files) entries.push(await entryFor(f, evidence, lib));
    return { configured: true, qaConfigured: !!qa.path && exists(qa.path), entries, evidenceRuns: evidence.length };
  }
  // The helper library: the source suite's files against the QA copy. Reported, never changed.
  function libStatus() {
    const lpDir = path.join(S.specsDir, '..', 'lib'); const out = [];
    let files = []; try { files = fs.readdirSync(lpDir).filter((f) => f.endsWith('.ts')).sort(); } catch { return out; }
    for (const f of files) {
      const qf = qaPath(qa.libDir + '/' + f);
      if (!qa.path || !exists(qf)) { out.push({ file: f, status: 'missing', label: 'Not in QA\'s copy' }); continue; }
      const d = lineDiff(normalise(read(qf)), normalise(read(guardPath(path.join(lpDir, f)))));
      out.push({ file: f, status: d.changed ? 'differs' : 'in-sync', label: d.changed ? 'QA\'s copy differs (' + d.changed + ' lines)' : 'Same as ' + cfg.testing.names.source, diffLines: d.changed });
    }
    return out;
  }
  const baseOf = (file) => file.replace(/\.ui\.spec\.ts$|\.spec\.ts$/, '');
  const today = () => new Date().toLocaleDateString('en-CA');
  async function detail(file) {
    if (!/^[\w.-]+\.spec\.ts$/.test(file)) throw Object.assign(new Error('Not a flow spec name.'), { status: 400 });
    const evidence = readEvidence(S.evidenceDir); const lib = qa.path ? qaLib() : {};
    if (!exists(path.join(S.specsDir, file))) throw Object.assign(new Error('That spec does not exist.'), { status: 404 });
    const e = await entryFor(file, evidence, lib);
    const card = flowCard(e.spec, { evidence: e.evidence, qa: { path: e.qaPath, status: e.status, label: e.label }, date: today() });
    return { ...slim(e), card, testCase: testCaseDraft(e.spec, { qaPath: e.qaPath || qa.specsDir + '/' + file }), portedSpec: e.portable ? portText(e.lpText, qa, e.tags) : null, tags: e.tags,
      diff: e.diff ? e.diff.lines : null, steps: e.spec.tests.map((t) => ({ title: t.title, steps: t.steps })) };
  }
  // What a pack would write: every file with its content, and a diff where the file exists. Nothing is written here.
  async function preview(files, o = {}) {
    if (!qa.path || !exists(qa.path)) throw Object.assign(new Error('No QA repository is set up (testing.qa.path).'), { status: 409 });
    const include = new Set(o.include && o.include.length ? o.include : ['card', 'spec', 'inventory', 'testcase']); const overwrite = new Set(o.overwrite || []);
    const evidence = readEvidence(S.evidenceDir); const lib = qaLib(); const out = []; const skipped = []; const warnings = []; const inv = [];
    for (const file of [...new Set(files || [])]) {
      if (!/^[\w.-]+\.spec\.ts$/.test(file) || !exists(path.join(S.specsDir, file))) { skipped.push({ file, why: 'Not a spec in the ' + cfg.testing.names.source + ' folder.' }); continue; }
      const e = await entryFor(file, evidence, lib); const base = baseOf(file);
      const add = (kind, rel, content) => {
        if (SECRET.test(content)) { skipped.push({ file, why: 'The ' + kind + ' contains text shaped like a secret, so it was not prepared.' }); return; }
        const abs = qaPath(rel); const had = exists(abs) ? read(abs).replace(/\r\n/g, '\n') : null; const body = content.replace(/\r\n/g, '\n');
        out.push({ kind, file, path: rel, content: body, exists: had !== null, same: had !== null && normalise(had) === normalise(body), diff: had !== null && normalise(had) !== normalise(body) ? lineDiff(had, body).lines : null });
      };
      const qaState = { path: e.qaPath || (e.portable && include.has('spec') ? qa.specsDir + '/' + file : null), status: e.status, label: e.qaPath ? e.label : (e.portable && include.has('spec') ? 'ported in this pack' : 'not ported') };
      if (include.has('card')) add('card', qa.cardsDir + '/' + base + '.md', flowCard(e.spec, { evidence: e.evidence, qa: qaState, date: today() }));
      if (include.has('testcase')) add('testcase', qa.cardsDir + '/' + base + '.testcase.md', testCaseDraft(e.spec, { qaPath: qaState.path }));
      if (include.has('spec')) {
        if (!e.portable) skipped.push({ file, why: 'Not ported: ' + e.why });
        else if (e.status === 'in-sync') { /* nothing to do */ }
        else if (e.status === 'differs' && !overwrite.has(file)) skipped.push({ file, why: 'QA\'s copy differs (' + e.label + '). It is left alone unless you choose to replace it.' });
        else add('spec', qa.specsDir + '/' + file, portText(e.lpText, qa, e.tags));
      }
      if (qaState.path) inv.push({ file, title: e.spec.tests.length === 1 ? e.spec.tests[0].title : e.spec.tests.map((t) => t.title).join(' / ').slice(0, 160) });
    }
    if (include.has('inventory') && inv.length) {
      const invPath = qa.inventoryFile; const abs = qaPath(invPath);
      if (exists(abs)) {
        const doc = read(abs); const r = inventoryPatch(doc, qa, inv);
        if (r.changed) out.push({ kind: 'inventory', file: null, path: invPath, content: r.text.replace(/\r\n/g, '\n'), crlf: doc.includes('\r\n'), exists: true, same: false, diff: lineDiff(doc.replace(/\r\n/g, '\n'), r.text.replace(/\r\n/g, '\n')).lines });
        else if (r.note && !/Already/.test(r.note)) warnings.push(r.note);
      } else warnings.push('The inventory file ' + invPath + ' was not found in the QA repository.');
    }
    return { files: out, skipped, warnings };
  }
  const slim = (e) => ({ file: e.file, title: e.title, tests: e.tests, steps: e.steps, requirementIds: e.requirementIds, bugId: e.bugId, isUi: e.isUi, status: e.status, label: e.label, why: e.why, portable: e.portable, qaPath: e.qaPath, hint: e.hint, diffLines: e.diff ? e.diff.changed : 0,
    evidence: e.evidence ? { run: e.evidence.run, at: e.evidence.at, before: e.evidence.before, after: e.evidence.after, verdict: e.evidence.verdict, ok: e.evidence.ok } : null });
  // Prepares the pack in a NEW worktree of the QA repository (the live clone is never touched). Files are left uncommitted; nothing is committed or pushed.
  async function buildPack(files, by, o = {}) {
    const pv = await preview(files, o);
    const writes = pv.files.filter((f) => !f.same && (!f.exists || f.kind === 'inventory' || (o.overwrite || []).includes(f.file)));
    if (!writes.length) throw Object.assign(new Error('There is nothing to write: everything is already in QA\'s repository or was skipped (' + pv.skipped.map((s) => s.file + ': ' + s.why).join(' | ') + ').'), { status: 409 });
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const id = o.taskId && /^\d{1,7}$/.test(String(o.taskId)) ? String(o.taskId) : null;
    const branch = cfg.branchPrefix + '/' + (id ? id + '-' : '') + 'qa-flows-' + stamp;
    const root = S.worktreeRoot || path.join(cfg.worktreeRoot, 'qa-automation'); const dir = path.join(root, (id ? id + '-' : '') + 'qa-flows-' + stamp);
    const base = (await gitx(qa.path, ['rev-parse', '--verify', '-q', 'origin/main^{commit}'], 20000));
    if (!base.ok || !base.out) throw Object.assign(new Error('The QA clone has no origin/main. Fetch it first (git fetch) and try again.'), { status: 409 });
    if (exists(dir)) throw Object.assign(new Error('The folder ' + dir + ' already exists. Try again in a moment.'), { status: 409 });
    fs.mkdirSync(root, { recursive: true });
    const w = await gitx(qa.path, ['worktree', 'add', '--no-track', '-b', branch, dir, 'origin/main'], 180000);
    if (!w.ok) throw Object.assign(new Error('git worktree add failed: ' + w.err), { status: 500 });
    const allowed = [qa.specsDir + '/', qa.cardsDir + '/', qa.inventoryFile];
    const written = [];
    for (const f of writes) {
      if (!allowed.some((a) => f.path === a || f.path.startsWith(a)) || f.path.includes('..') || SECRET_PATHS.test(f.path)) throw Object.assign(new Error('Refusing to write ' + f.path), { status: 400 });
      const target = path.join(dir, ...f.path.split('/')); if (!path.resolve(target).startsWith(path.resolve(dir) + path.sep)) throw Object.assign(new Error('Refusing to write outside the worktree.'), { status: 400 });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const text = f.kind === 'inventory' && f.crlf ? f.content.replace(/\n/g, '\r\n') : f.content;
      fs.writeFileSync(target, text); written.push({ kind: f.kind, path: f.path });
    }
    const packId = store.qaPackAdd({ by, specs: [...new Set(writes.map((f) => f.file).filter(Boolean))], branch, worktree: dir, base: base.out, files: written });
    return { id: packId, worktree: dir, branch, base: base.out.slice(0, 10), written, skipped: pv.skipped, warnings: pv.warnings };
  }
  return { catalogue, entryFor, detail, preview, buildPack, libStatus, qaLib, readEvidence: () => readEvidence(S.evidenceDir), slim, settings: S };
}

module.exports = { create, portText, normalise, canonImport, tagsOfQa, exportsOf, lineDiff, parseEvidence, readEvidence, flowCard, testCaseDraft, inventoryPatch, SECRET, SECRET_PATHS };
