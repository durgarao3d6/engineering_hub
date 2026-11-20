'use strict';
// Workflow ratings: re-rates the areas of an earlier review from measured data, baseline vs recent weeks, and shows whether the hub features
// meant to close each gap are actually used. No model is involved; every number comes from Azure DevOps (read-only), local git (read-only),
// the usage log, the learnings store or the hub's own database.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cfg = require('./config');
const store = require('./store');
const usage = require('./usage');
const { ado, BASE } = require('./collectors/ado');
const { gitx, pool } = require('./collectors/git');
const { cloneList } = require('./collectors/worktrees');

// Which ratings file: the one named in hub.config.json, else your own scorecard.config.local.json (git-ignored), else the generic scorecard.config.json.
const CONFIG_FILE = [cfg.scorecard.configFile, path.join(__dirname, 'scorecard.config.local.json'), path.join(__dirname, 'scorecard.config.json')].find((f) => f && fs.existsSync(f));
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const RESULT_FILE = path.join(cfg.dataDir, 'scorecard.json');
const DAY = 86400000;
const WEEKS_BACK = 6;
const WIQL_PROJECT = cfg.project.replace(/'/g, "''"); // the project name goes into the search text, quote-safe
const LEARNINGS = cfg.learningsDir; // optional: a folder of shared lesson files (empty = not measured)
const LP_FLOWS = cfg.scorecard.flowsDir; // optional: where repeatable bug specs live (empty = not measured)
const LP_EVIDENCE = cfg.scorecard.evidenceDir; // optional: where evidence runs are written
const DONE = new Set(['Resolved', 'Closed', 'Done', 'Removed']);
const TEST_FILE = /(\.test\.|\.spec\.|\/tests?\/|tests?\.cs$|__tests__)/i;
const TRAILER = /co-authored-by:[^\n]*(claude|anthropic)|generated with[^\n]*claude|🤖/i;

/* ---------- pure scoring (tested) ---------- */
function scoreMetric(def, value) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const t = (value - def.worst) / (def.best - def.worst);
  return Math.round(Math.max(0, Math.min(1, t)) * 100) / 10;
}
function scoreArea(area, values) { // values: { metricId: {value, n} | null }
  let sum = 0; let w = 0; const parts = [];
  for (const m of area.metrics) {
    const v = values[m.id]; const s = v ? scoreMetric(m, v.value) : null;
    parts.push({ id: m.id, value: v ? v.value : null, n: v ? v.n : 0, score: s, detail: v ? v.detail || '' : '' });
    if (s !== null) { sum += s * m.weight; w += m.weight; }
  }
  return { score: w ? Math.round((sum / w) * 10) / 10 : null, metrics: parts };
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r1 = (x) => (x === null ? null : Math.round(x * 10) / 10);

const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const isoWeek = (d) => { const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day); const y = t.getUTCFullYear(); return y + '-W' + String(Math.ceil((((t - Date.UTC(y, 0, 1)) / DAY) + 1) / 7)).padStart(2, '0'); };
function windows(now) {
  const today = startOfDay(now);
  // The baseline is either two fixed dates (from/to) or relative: `days` long, ending `endsDaysAgo` days before today (so it never overlaps the last 14 days).
  const B = CONFIG.baseline; let base;
  if (B.days) {
    const last = new Date(today.getTime() - (B.endsDaysAgo === undefined ? 14 : B.endsDaysAgo) * DAY);
    const first = new Date(last.getTime() - (B.days - 1) * DAY);
    const f = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    base = { id: 'baseline', label: B.label || 'Baseline: ' + f(first) + ' to ' + f(last), from: first, to: new Date(last.getTime() + DAY) };
  } else base = { id: 'baseline', label: B.label, from: new Date(B.from + 'T00:00:00'), to: new Date(new Date(B.to + 'T00:00:00').getTime() + DAY) };
  const recent = { id: 'recent', label: 'Last 14 days', from: new Date(today.getTime() - 13 * DAY), to: new Date(today.getTime() + DAY) };
  const mon = new Date(today); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
  const weeks = []; for (let k = WEEKS_BACK - 1; k >= 0; k--) { const from = new Date(mon.getTime() - k * 7 * DAY); weeks.push({ id: isoWeek(from), label: isoWeek(from), from, to: new Date(from.getTime() + 7 * DAY) }); }
  return { baseline: base, recent, weeks };
}
const inWin = (d, w) => d >= w.from && d < w.to;
const weeksIn = (w) => Math.max(1, (w.to - w.from) / (7 * DAY));

/* ---------- metrics: each takes the gathered inputs and a window, returns {value, n} or null ---------- */
const fileCount = (list, w) => list.filter((t) => t < w.to.getTime()).length; // files that already existed by the end of the window (by creation time)
const METRICS = {
  firstBuildFail(I, w) { const p = I.prs.filter((x) => inWin(x.created, w) && x.builds > 0); const f = p.filter((x) => x.firstFailed).length; return p.length ? { value: r1(100 * f / p.length), n: p.length, detail: f + ' of ' + p.length + ' PRs' } : null; },
  botThreads(I, w) { const p = I.prs.filter((x) => inWin(x.created, w) && x.threads); return p.length ? { value: r1(mean(p.map((x) => x.threads.bot))), n: p.length, detail: p.reduce((s, x) => s + x.threads.bot, 0) + ' threads on ' + p.length + ' PRs' } : null; },
  reopened(I, w) { if (!I.reopen) return null; const e = I.reopen.events.filter((x) => inWin(x.at, w)); return { value: r1(e.length / weeksIn(w)), n: I.reopen.bugs, detail: e.length + ' reopened in the window' }; },
  secondPr(I, w) { const b = I.bugs.filter((x) => inWin(x.first, w)); const f = b.filter((x) => x.followUp).length; return b.length ? { value: r1(100 * f / b.length), n: b.length, detail: f + ' of ' + b.length + ' bugs' } : null; },
  testRatio(I, w) { const p = I.prs.filter((x) => inWin(x.created, w) && x.bug && x.testsKnown); const t = p.filter((x) => x.touchesTests).length; return p.length ? { value: r1(100 * t / p.length), n: p.length, detail: t + ' of ' + p.length + ' bug-fix PRs' } : null; },
  promptsInLongSessions(I, w) { const s = I.sessions.filter((x) => inWin(x.first, w)); const tot = s.reduce((a, x) => a + x.turns, 0); const long = s.filter((x) => x.turns > 80).reduce((a, x) => a + x.turns, 0); return tot ? { value: r1(100 * long / tot), n: s.length, detail: long + ' of ' + tot + ' prompts' } : null; },
  longSessions(I, w) { const s = I.sessions.filter((x) => inWin(x.first, w)); const l = s.filter((x) => x.turns > 80).length; return s.length ? { value: r1(100 * l / s.length), n: s.length, detail: l + ' of ' + s.length + ' sessions' } : null; },
  learningsPerWeek(I, w) { if (!I.learnings) return { value: null, n: 0, detail: 'not configured' }; const e = I.learnings.filter((d) => inWin(d, w)); return { value: r1(e.length / weeksIn(w)), n: e.length, detail: e.length + ' entries' }; },
  attribution(I, w) { const c = I.commits.filter((x) => inWin(x.at, w)); const f = c.filter((x) => x.flagged).length; return c.length ? { value: r1(100 * f / c.length), n: c.length, detail: f + ' of ' + c.length + ' commits' } : null; },
  decisionsPerWeek(I, w) { if (!I.hub.first || w.to <= I.hub.first) return null; const e = I.hub.notes.filter((n) => inWin(n.at, w) && /^(Decisions|Findings)$/.test(n.section)); return { value: r1(e.length / weeksIn(w)), n: e.length }; },
  planDays(I, w) { if (!I.hub.first || w.to <= I.hub.first) return null; const d = I.hub.planDays.filter((x) => x.closed && inWin(x.date, w)); return { value: r1(d.length / weeksIn(w)), n: d.length }; },
  planAdherence(I, w) { const d = I.hub.planDays.filter((x) => x.closed && inWin(x.date, w) && x.score); return d.length ? { value: r1(mean(d.map((x) => x.score.adherence))), n: d.length } : null; },
  planCoverage(I, w) { const d = I.hub.planDays.filter((x) => x.closed && inWin(x.date, w) && x.score); return d.length ? { value: r1(mean(d.map((x) => x.score.coverage))), n: d.length } : null; },
  // dated by file creation time, so the baseline and every week get a real value
  guardHooks: (I, w) => { const v = fileCount(I.files.guards, w); return { value: v, n: 4, detail: v + ' of 4 in place' }; },
  bugSpecs: (I, w) => { if (!I.files.specs) return { value: null, n: 0, detail: 'not configured' }; const v = fileCount(I.files.specs, w); return { value: v, n: 1, detail: v + ' spec files' }; },
  evidenceRuns: (I, w) => { if (!I.files.evidence) return { value: null, n: 0, detail: 'not configured' }; const v = fileCount(I.files.evidence, w); return { value: v, n: 1, detail: v + ' runs' }; },
  // measured now only (there is no history to compare with): shown for the recent window
  branchCoverage: (I, w) => (w.id === 'recent' && I.current.branchCoverage !== null ? { value: I.current.branchCoverage, n: I.current.worktrees, detail: 'of ' + I.current.worktrees + ' worktrees' } : null),
  staleWorktrees: (I, w) => (w.id === 'recent' && I.current.staleWorktrees !== null ? { value: I.current.staleWorktrees, n: I.current.worktrees, detail: 'of ' + I.current.worktrees + ' worktrees' } : null),
  notesCoverage: (I, w) => (w.id === 'recent' && I.current.notesCoverage !== null ? { value: I.current.notesCoverage, n: I.current.tasksWithCode, detail: 'of ' + I.current.tasksWithCode + ' tasks with code' } : null),
};

// Pure: inputs + windows -> the full result. Used by the real run and by the tests with synthetic inputs.
function compute(I, now = new Date(), config = CONFIG) {
  const W = windows(now);
  const all = [W.baseline, W.recent, ...W.weeks];
  const areas = config.areas.map((a) => {
    const per = {}; const trend = [];
    for (const w of all) {
      const values = {}; for (const m of a.metrics) values[m.id] = METRICS[m.id] ? METRICS[m.id](I, w) : null;
      per[w.id] = scoreArea(a, values);
    }
    for (const w of W.weeks) trend.push({ week: w.id, score: per[w.id].score });
    return { id: a.id, label: a.label, original: a.original, gap: a.gap, features: a.features, next: a.next, baseline: per.baseline, recent: per.recent, trend,
      metrics: a.metrics.map((m) => ({ id: m.id, label: m.label, unit: m.unit, worst: m.worst, best: m.best, weight: m.weight, source: m.source, current: !!m.current, hub: !!m.hub,
        baseline: per.baseline.metrics.find((x) => x.id === m.id), recent: per.recent.metrics.find((x) => x.id === m.id) })) };
  });
  const avg = (key) => r1(mean(areas.map((a) => a[key].score).filter((s) => s !== null)));
  const orig = r1(mean(areas.map((a) => a.original).filter((s) => s !== null && s !== undefined)));
  // the fair comparison: only areas that have both your own earlier rating and a measured baseline
  const comparable = areas.filter((a) => a.original !== null && a.original !== undefined && a.baseline.score !== null);
  const overallTrend = W.weeks.map((w, i) => ({ week: w.id, score: r1(mean(areas.map((a) => a.trend[i].score).filter((s) => s !== null))) }));
  return { generatedAt: now.toISOString(), windows: all.map((w) => ({ id: w.id, label: w.label, from: w.from.toISOString(), to: w.to.toISOString() })),
    overall: { original: orig, originalComparable: r1(mean(comparable.map((a) => a.original))), baseline: avg('baseline'), recent: avg('recent'), recentComparable: r1(mean(comparable.map((a) => a.recent.score).filter((s) => s !== null))), trend: overallTrend }, areas };
}

/* ---------- gathering ---------- */
// 'system' = Azure DevOps's own notes (build service); 'bot' = the AI reviewer; 'human' = a person. Only 'bot' counts as an AI review thread.
const threadKind = (name, uniq) => (/build service/i.test(String(name || '')) ? 'system' : (!String(uniq || '').includes('@') || /azdoaitools/i.test(String(name || '')) ? 'bot' : 'human'));

async function gatherAdo(from, progress) {
  const out = { prs: [], bugs: [], reopen: null, meta: {} };
  const me = (await ado(BASE + '/_apis/connectionData?api-version=7.1-preview')).authenticatedUser;
  progress('Reading your pull requests from Azure DevOps');
  const list = (await ado(`_apis/git/pullrequests?searchCriteria.creatorId=${me.id}&searchCriteria.status=all&searchCriteria.minTime=${from.toISOString()}&$top=500&api-version=7.1`)).value.filter((p) => p.status !== 'abandoned');
  out.meta.prs = list.length;
  progress('Reading builds');
  const nums = new Map(list.map((p) => [p.pullRequestId, p]));
  const builds = []; let token = null;
  do { // all pull-request builds of the project since the start; only those of your PRs are kept
    const j = await ado(`_apis/build/builds?reasonFilter=pullRequest&minTime=${from.toISOString()}&$top=1000&api-version=7.1` + (token ? '&continuationToken=' + encodeURIComponent(token) : ''), undefined, true);
    builds.push(...j.value); token = j.__token || null;
  } while (token);
  const first = new Map(); // pr -> definition -> earliest build
  for (const b of builds) {
    const m = /^refs\/pull\/(\d+)\/merge$/.exec(b.sourceBranch || ''); if (!m || b.status !== 'completed' || !nums.has(Number(m[1]))) continue;
    const n = Number(m[1]); if (!first.has(n)) first.set(n, new Map());
    const cur = first.get(n).get(b.definition.name); if (!cur || b.queueTime < cur.queueTime) first.get(n).set(b.definition.name, b);
  }
  progress('Reading review threads and linked work items (' + list.length + ' pull requests)');
  const typeIds = new Set();
  await pool(list, 8, async (p) => {
    const rec = { n: p.pullRequestId, repo: p.repository.name, created: new Date(p.creationDate), builds: first.has(p.pullRequestId) ? first.get(p.pullRequestId).size : 0, firstFailed: false, threads: null, bug: false, ids: [], testsKnown: false, touchesTests: false };
    if (first.has(p.pullRequestId)) rec.firstFailed = [...first.get(p.pullRequestId).values()].some((b) => ['failed', 'partiallySucceeded'].includes(b.result));
    try {
      const t = await ado(`_apis/git/repositories/${p.repository.id}/pullRequests/${p.pullRequestId}/threads?api-version=7.1`);
      let bot = 0; let human = 0;
      for (const th of t.value) { const cs = (th.comments || []).filter((c) => c.commentType === 'text'); if (!cs.length || th.isDeleted) continue; const a = cs[0].author || {}; if ((a.uniqueName || '').toLowerCase() === (p.createdBy.uniqueName || '').toLowerCase()) continue; const k = threadKind(a.displayName, a.uniqueName); if (k === 'bot') bot++; else if (k === 'human') human++; }
      rec.threads = { bot, human };
    } catch { /* unknown for this PR */ }
    try { rec.ids = (await ado(`_apis/git/repositories/${p.repository.id}/pullRequests/${p.pullRequestId}/workitems?api-version=7.1`)).value.map((x) => Number(x.id)); } catch { /* none */ }
    rec.ids.forEach((i) => typeIds.add(i)); rec._pr = p; out.prs.push(rec);
  });
  progress('Reading work item types');
  const types = new Map(); const ids = [...typeIds];
  for (let i = 0; i < ids.length; i += 200) { const r = await ado('_apis/wit/workitemsbatch?api-version=7.1', { ids: ids.slice(i, i + 200), fields: ['System.WorkItemType'], errorPolicy: 'Omit' }); r.value.filter(Boolean).forEach((w) => types.set(w.id, w.fields['System.WorkItemType'])); }
  progress('Checking which bug-fix PRs changed tests');
  await pool(out.prs, 8, async (rec) => {
    rec.bug = rec.ids.some((i) => types.get(i) === 'Bug'); if (!rec.bug) return;
    try {
      const it = await ado(`_apis/git/repositories/${rec._pr.repository.id}/pullRequests/${rec.n}/iterations?api-version=7.1`);
      const ch = await ado(`_apis/git/repositories/${rec._pr.repository.id}/pullRequests/${rec.n}/iterations/${it.value[it.value.length - 1].id}/changes?$compareTo=0&$top=2000&api-version=7.1`);
      rec.touchesTests = (ch.changeEntries || []).some((c) => TEST_FILE.test((c.item && c.item.path) || '')); rec.testsKnown = true;
    } catch { /* unknown */ }
  });
  const byBug = new Map();
  for (const rec of out.prs) for (const i of rec.ids) if (types.get(i) === 'Bug') { if (!byBug.has(i)) byBug.set(i, []); byBug.get(i).push(rec); }
  for (const [id, recs] of byBug) {
    recs.sort((a, b) => a.created - b.created);
    out.bugs.push({ id, first: recs[0].created, followUp: recs.slice(1).some((r) => r.repo === recs[0].repo && r.created - recs[0].created > DAY) });
  }
  progress('Checking bug history for reopened bugs');
  try {
    const q = await ado('_apis/wit/wiql?$top=400&api-version=7.1', { query: `SELECT [System.Id] FROM workitems WHERE [System.TeamProject]='${WIQL_PROJECT}' AND [System.WorkItemType]='Bug' AND [System.AssignedTo]=@Me AND [System.ChangedDate] >= '${from.toISOString().slice(0, 10)}'` });
    const events = [];
    await pool(q.workItems.map((w) => w.id), 8, async (id) => {
      const u = await ado(`_apis/wit/workItems/${id}/updates?$top=200&api-version=7.1`);
      for (const x of u.value) { const s = x.fields && x.fields['System.State']; if (s && DONE.has(s.oldValue) && !DONE.has(s.newValue)) events.push({ bug: id, at: new Date((x.fields['System.ChangedDate'] && x.fields['System.ChangedDate'].newValue) || x.revisedDate) }); }
    });
    out.reopen = { events, bugs: q.workItems.length };
  } catch { out.reopen = null; }
  return out;
}

async function gatherCommits(from, progress) {
  progress('Scanning commit messages in local repos');
  const clones = [...new Set(cloneList().map((c) => c.path))].filter((p) => fs.existsSync(p));
  let me = ''; for (const c of clones.slice(0, 5)) { const r = await gitx(c, ['config', 'user.email'], 8000); if (r.out) { me = r.out.toLowerCase(); break; } }
  const commits = []; const seen = new Set();
  await pool(clones, 6, async (c) => {
    const r = await gitx(c, ['log', '--branches', '--since=' + from.toISOString(), '--format=%H%x1f%ae%x1f%cI%x1f%B%x1e'], 90000);
    for (const rec of (r.out || '').split('\x1e')) {
      const [sha, email, at, ...msg] = rec.trim().split('\x1f'); if (!sha || seen.has(sha)) continue;
      if (me && String(email).toLowerCase() !== me) continue; seen.add(sha);
      commits.push({ at: new Date(at), flagged: TRAILER.test(msg.join('\x1f')) });
    }
  });
  return commits;
}

function gatherSessions() {
  const rows = usage.rows().filter((r) => usage.isTmsProject(r.project));
  const by = new Map();
  for (const r of rows) {
    const s = by.get(r.sessionId) || { first: new Date(r.start), turns: 0 };
    s.turns = Math.max(s.turns, r.turnIndex || 0); if (new Date(r.start) < s.first) s.first = new Date(r.start); by.set(r.sessionId, s);
  }
  return { sessions: [...by.values()] };
}

function gatherLearnings() {
  if (!LEARNINGS) return null; // not configured: the metric shows "no data" instead of a false zero
  try { return fs.readdirSync(LEARNINGS).filter((f) => f.endsWith('.md')).map((f) => { const m = /^added:\s*(\d{4}-\d{2}-\d{2})/m.exec(fs.readFileSync(path.join(LEARNINGS, f), 'utf8')); return m ? new Date(m[1] + 'T12:00:00') : null; }).filter(Boolean); }
  catch { return []; }
}

function gatherHub(ctx) {
  const nr = store.noteRows('0'); const pdays = store.planDays('0'); const u = store.usageCounts();
  const firsts = [u.notes.first, u.plans.first, u.moves.first, u.clearances.first, u.aiCalls.first].filter(Boolean).map((x) => new Date(x)).sort((a, b) => a - b);
  const tasks = (ctx && ctx.tasks) || []; const wts = ((ctx && ctx.worktrees) || []).filter((w) => !w.isMain && !(w.clearance && !w.changedSinceCleared));
  const noted = new Set(nr.map((n) => n.task_id));
  const withCode = tasks.filter((t) => t.where && t.where !== 'No code yet' && t.where !== 'Merged');
  return { first: firsts[0] || null, notes: nr.map((n) => ({ at: new Date(n.created_at), section: n.section, task: n.task_id })),
    planDays: pdays.map((d) => ({ date: new Date(d.date + 'T12:00:00'), closed: !!d.closedAt, score: d.score })),
    current: { worktrees: wts.length, branchCoverage: wts.length ? r1(100 * wts.filter((w) => w.taskId).length / wts.length) : null, staleWorktrees: wts.length ? wts.filter((w) => w.stale).length : null,
      tasksWithCode: withCode.length, notesCoverage: withCode.length ? r1(100 * withCode.filter((t) => noted.has(t.id)).length / withCode.length) : null } };
}

// Creation times (birthtime), so "how many existed by then" works for any window.
function gatherFiles() {
  const born = (p) => { try { return fs.statSync(p).birthtimeMs; } catch { return null; } };
  const inDir = (dir, re, dirsOnly) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => (dirsOnly ? e.isDirectory() : e.isFile()) && re.test(e.name)).map((e) => born(path.join(dir, e.name))).filter(Boolean); } catch { return []; } };
  const guards = [...cfg.scorecard.guardFiles, path.join(__dirname, 'test', 'guards.test.js'), path.join(__dirname, 'collectors', 'ado.js')].map(born).filter(Boolean);
  return { guards, specs: LP_FLOWS ? inDir(LP_FLOWS, /^bug-.*\.spec\.ts$/) : null, evidence: LP_EVIDENCE ? inDir(LP_EVIDENCE, /./, true) : null };
}

/* ---------- planner accuracy and hub adoption (shown beside the ratings) ---------- */
function plannerAccuracy() {
  const f = store.feedbackList('0'); const n = f.length;
  const pct = (a, b) => (b ? Math.round(1000 * a / b) / 10 : null);
  const withMatch = f.filter((x) => x.proposed_task); const band = (lo, hi) => withMatch.filter((x) => x.confidence >= lo && x.confidence < hi);
  const acc = (rows) => ({ n: rows.length, acceptedPct: pct(rows.filter((x) => x.outcome === 'accepted').length, rows.length) });
  return { lines: n, since: n ? f[0].at : null, matches: acc(withMatch), high: acc(band(0.8, 1.01)), medium: acc(band(0.6, 0.8)), low: acc(band(0, 0.6)),
    ai: acc(withMatch.filter((x) => x.engine === 'ai')), rules: acc(withMatch.filter((x) => x.engine === 'rules')),
    changed: withMatch.filter((x) => x.outcome === 'changed').length, removed: withMatch.filter((x) => x.outcome === 'removed').length, added: f.filter((x) => x.outcome === 'added').length,
    draftsEdited: (() => { const d = f.filter((x) => x.final_task === null && x.final_kind === 'task'); return { n: d.length, editedPct: pct(d.filter((x) => x.draft_edited).length, d.length) }; })(),
    worktrees: { proposed: f.reduce((s, x) => s + x.wt_proposed, 0), kept: f.reduce((s, x) => s + x.wt_kept, 0), added: f.reduce((s, x) => s + x.wt_added, 0) } };
}
function hooksInstalled() { // are the session hooks registered? (reads the settings files as text, only looks for the hook file names)
  const has = (needle) => [path.join(os.homedir(), '.claude', 'settings.json'), ...cfg.scorecard.settingsFiles].some((f) => { try { return fs.readFileSync(f, 'utf8').replace(/\\\\/g, '/').includes(needle); } catch { return false; } });
  return { sessionStart: has('hub/hooks/session-start.js'), stop: has('hub/hooks/stop-reminder.js') };
}
function adoption() {
  const u = store.usageCounts();
  return { hooks: hooksInstalled(),
 notes: { count: u.notes.c, tasks: u.notes.tasks, first: u.notes.first }, plans: { days: u.plans.c, closed: u.closedPlans.c, first: u.plans.first }, moves: { count: u.moves.c, first: u.moves.first },
    clearances: { count: u.clearances.c, first: u.clearances.first }, aiCalls: { count: u.aiCalls.c, first: u.aiCalls.first } };
}

/* ---------- running ---------- */
let state = { status: 'idle', step: '', startedAt: null, error: null };
function readResult() { try { return JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8')); } catch { return null; } }
function status() { return { ...state, result: readResult() }; }

async function run(ctx, now = new Date()) {
  if (state.status === 'running') return state;
  state = { status: 'running', step: 'Starting', startedAt: new Date().toISOString(), error: null };
  const progress = (s) => { state.step = s; };
  (async () => {
    try {
      const from = new Date(Math.min(windows(now).baseline.from.getTime(), windows(now).weeks[0].from.getTime()) - DAY);
      const I = { prs: [], bugs: [], reopen: null, sessions: [], learnings: [], commits: [], hub: null, current: {}, files: { guards: [], specs: [], evidence: [] } };
      let adoErr = null;
      try { Object.assign(I, await gatherAdo(from, progress)); } catch (e) { adoErr = e.message; }
      try { I.commits = await gatherCommits(from, progress); } catch { I.commits = []; }
      progress('Reading session logs, lessons and hub activity');
      Object.assign(I, gatherSessions()); I.learnings = gatherLearnings();
      I.hub = gatherHub(ctx); I.current = I.hub.current; I.files = gatherFiles();
      progress('Scoring');
      const result = compute(I, now);
      result.notes = [];
      if (adoErr) result.notes.push('Azure DevOps could not be read (' + adoErr + '), so pull request and bug metrics are missing.');
      result.inputs = { prs: I.prs.length, bugsWithPrs: I.bugs.length, bugsChecked: I.reopen ? I.reopen.bugs : null, sessions: I.sessions.length, commitsScanned: I.commits.length, learnings: I.learnings ? I.learnings.length : null };
      result.plannerAccuracy = plannerAccuracy(); result.adoption = adoption();
      result.planDays = store.planDays('0').slice(-14);
      const wk = isoWeek(now); result.areas.forEach((a) => { if (a.recent.score !== null) store.snapshotUpsert(wk, a.id, a.recent.score, a.recent.metrics); });
      fs.mkdirSync(cfg.dataDir, { recursive: true }); const tmp = RESULT_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(result)); fs.renameSync(tmp, RESULT_FILE);
      state = { status: 'idle', step: '', startedAt: null, error: null };
    } catch (e) { state = { status: 'idle', step: '', startedAt: null, error: e.message }; }
  })();
  return state;
}

module.exports = { scoreMetric, scoreArea, compute, windows, run, status, METRICS, CONFIG, plannerAccuracy, adoption, isoWeek };
