const HUBROOT = require('path').resolve(__dirname, '..').replace(/\\/g, '/'); require('./_config')(); if (process.env.HUB_LIVE_TESTS) process.env.HUB_CONFIG = process.env.HUB_LIVE_CONFIG || HUBROOT + '/hub.config.json'; // the two live ratings checks need your full settings // neutral settings (HUB_LIVE_TESTS=1 uses your own settings and board for the checks marked live)
process.env.HUB_BACKUP_DIR = process.env.HUB_BACKUP_DIR || require('path').join(require('os').tmpdir(), 'hub-test-backups-' + process.pid); process.on('exit', () => { try { require('fs').rmSync(process.env.HUB_BACKUP_DIR, { recursive: true, force: true }); } catch { /* temp */ } }); // tests never write into your real backup folder
// Workflow ratings: exact scoring on synthetic data, config sanity, and one real read-only run through a throwaway hub.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const HUB = HUBROOT;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scoretest-'));
process.env.HUB_DATA_DIR = path.join(root, 'data'); process.env.HUB_BACKUP_DIR = path.join(root, 'bk');
const sc = require(HUB + '/scorecard.js');

let fails = 0;
const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!ok) fails++; };
const live = (n, ok, x) => (process.env.HUB_LIVE_TESTS ? check(n, ok, x) : console.log('SKIP ' + n + '  (needs a real Azure DevOps board: run with HUB_LIVE_TESTS=1)'));
const near = (a, b, e = 0.06) => a !== null && Math.abs(a - b) <= e;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const D = (s) => new Date(s + 'T12:00:00');

(async () => {
  console.log('--- scoring one measure');
  const low = { worst: 30, best: 0 }; const high = { worst: 40, best: 100 };
  check('lower is better: best value scores 10, worst scores 0', sc.scoreMetric(low, 0) === 10 && sc.scoreMetric(low, 30) === 0);
  check('halfway scores 5', sc.scoreMetric(low, 15) === 5 && sc.scoreMetric(high, 70) === 5);
  check('beyond the ends is clamped, not extrapolated', sc.scoreMetric(low, 60) === 0 && sc.scoreMetric(low, -5) === 10 && sc.scoreMetric(high, 150) === 10 && sc.scoreMetric(high, 0) === 0);
  check('higher is better works too', sc.scoreMetric(high, 100) === 10 && near(sc.scoreMetric(high, 85.7), 7.6));
  check('no data gives no score, never a made-up one', sc.scoreMetric(low, null) === null && sc.scoreMetric(low, undefined) === null && sc.scoreMetric(low, NaN) === null);

  console.log('--- scoring an area');
  const area = { metrics: [{ id: 'a', worst: 30, best: 0, weight: 1 }, { id: 'b', worst: 0, best: 10, weight: 0.5 }, { id: 'c', worst: 0, best: 10, weight: 1 }] };
  let r = sc.scoreArea(area, { a: { value: 0, n: 5 }, b: { value: 4, n: 5 }, c: null });
  check('weighted mean of the measures that have data (10 x1 and 4 x0.5 = 8)', r.score === 8, String(r.score));
  check('a missing measure is ignored, not counted as zero', r.metrics.find((m) => m.id === 'c').score === null);
  check('no measure with data means no area score', sc.scoreArea(area, { a: null, b: null, c: null }).score === null);

  console.log('--- windows');
  const now = new Date(2026, 10, 19, 15, 0, 0); const W = sc.windows(now);
  check('baseline is exactly 20 Oct to 18 Nov, inclusive', W.baseline.from.getTime() === new Date(2026, 9, 20).getTime() && W.baseline.to.getTime() === new Date(2026, 10, 19).getTime());
  check('recent is the last 14 days including today', Math.round((W.recent.to - W.recent.from) / 86400000) === 14 && W.recent.to.getTime() === new Date(2026, 10, 20).getTime());
  check('six weekly windows, Monday to Monday, contiguous, the last one holds today', W.weeks.length === 6 && W.weeks.every((w, i) => w.from.getDay() === 1 && (i === 0 || w.from.getTime() === W.weeks[i - 1].to.getTime())) && now >= W.weeks[5].from && now < W.weeks[5].to);

  console.log('--- the measures, on synthetic inputs');
  const pr = (created, o) => ({ n: 1, repo: 'r', created: D(created), builds: 1, firstFailed: false, threads: { bot: 2, human: 0 }, bug: false, ids: [], testsKnown: false, touchesTests: false, ...o });
  const I = {
    prs: [pr('2026-11-02', { firstFailed: true, threads: { bot: 6, human: 0 } }), pr('2026-11-03', { threads: { bot: 2, human: 1 } }), pr('2026-11-04', { builds: 0, threads: null }),
      pr('2026-11-10', { bug: true, testsKnown: true, touchesTests: true }), pr('2026-11-11', { bug: true, testsKnown: true, touchesTests: false }), pr('2026-11-12', { bug: true, testsKnown: false }),
      pr('2026-11-17', { firstFailed: true, bug: true, testsKnown: true, touchesTests: true }), pr('2026-11-18', { threads: { bot: 0, human: 0 } })],
    bugs: [{ id: 1, first: D('2026-11-10'), followUp: true }, { id: 2, first: D('2026-11-11'), followUp: false }, { id: 3, first: D('2026-11-17'), followUp: false }],
    reopen: { bugs: 40, events: [{ bug: 1, at: D('2026-11-05') }, { bug: 2, at: D('2026-11-06') }, { bug: 3, at: D('2026-11-17') }] },
    sessions: [{ first: D('2026-11-02'), turns: 10 }, { first: D('2026-11-03'), turns: 120 }, { first: D('2026-11-04'), turns: 5 }, { first: D('2026-11-17'), turns: 30 }],
    learnings: ['2026-10-25', '2026-10-26', '2026-10-27', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-18'].map(D),
    commits: [...Array(47).fill(0).map(() => ({ at: D('2026-11-05'), flagged: false })), { at: D('2026-11-06'), flagged: true }, { at: D('2026-11-07'), flagged: true }, { at: D('2026-11-18'), flagged: false }],
    hub: { first: D('2026-11-19'), notes: [], planDays: [], current: {} },
    current: { worktrees: 20, branchCoverage: 70, staleWorktrees: 8, tasksWithCode: 10, notesCoverage: 30 },
    files: { guards: [new Date(2026, 9, 1).getTime(), new Date(2026, 9, 10).getTime(), new Date(2026, 10, 19).getTime(), new Date(2026, 10, 19).getTime()], specs: [new Date(2026, 9, 27).getTime(), new Date(2026, 9, 28).getTime(), new Date(2026, 10, 19, 9).getTime()], evidence: [] },
  };
  const res = sc.compute(I, now);
  const m = (area, id, win) => res.areas.find((a) => a.id === area)[win].metrics.find((x) => x.id === id);
  // The baseline is 20 Oct to 18 Nov inclusive = 30 days (4.29 weeks). Recent = 6 Nov to 19 Nov (14 days).
  check('first-build failures, baseline: 2 of the 7 PRs that had a build (the PR with no build is not counted)', near(m('prepr', 'firstBuildFail', 'baseline').value, 28.6, 0.1) && m('prepr', 'firstBuildFail', 'baseline').n === 7, JSON.stringify(m('prepr', 'firstBuildFail', 'baseline')));
  check('first-build failures, recent: 1 of 5, measured separately from the baseline', m('prepr', 'firstBuildFail', 'recent').value === 20 && m('prepr', 'firstBuildFail', 'recent').n === 5, JSON.stringify(m('prepr', 'firstBuildFail', 'recent')));
  check('AI review threads per PR: 16 threads on the 7 PRs that have thread data', near(m('prepr', 'botThreads', 'baseline').value, 16 / 7, 0.06) && m('prepr', 'botThreads', 'baseline').n === 7, JSON.stringify(m('prepr', 'botThreads', 'baseline')));
  check('test ratio counts only bug-fix PRs whose files are known: 2 of 3', near(m('proving', 'testRatio', 'baseline').value, 66.7, 0.1) && m('proving', 'testRatio', 'baseline').n === 3, JSON.stringify(m('proving', 'testRatio', 'baseline')));
  check('reopened bugs are per week of the window: 3 events in 4.29 weeks', near(m('prepr', 'reopened', 'baseline').value, 3 / (30 / 7), 0.06), String(m('prepr', 'reopened', 'baseline').value));
  check('second PR share: 1 of 3 bugs', near(m('prepr', 'secondPr', 'baseline').value, 33.3, 0.1), String(m('prepr', 'secondPr', 'baseline').value));
  check('prompts in long sessions: 120 of 165 prompts', near(m('sessions', 'promptsInLongSessions', 'baseline').value, 72.7, 0.1), String(m('sessions', 'promptsInLongSessions', 'baseline').value));
  check('sessions over 80 prompts: 1 of 4', near(m('sessions', 'longSessions', 'baseline').value, 25, 0.1), String(m('sessions', 'longSessions', 'baseline').value));
  check('learnings per week of the window: 9 in 4.29 weeks', near(m('lessons', 'learningsPerWeek', 'baseline').value, 9 / (30 / 7), 0.06), String(m('lessons', 'learningsPerWeek', 'baseline').value));
  check('attribution is a share of commits: 2 of 50', m('rules', 'attribution', 'baseline').value === 4 && m('rules', 'attribution', 'baseline').detail === '2 of 50 commits', m('rules', 'attribution', 'baseline').detail);
  check('file-based counts use creation time: 2 guards existed by the baseline end, 4 by now', m('rules', 'guardHooks', 'baseline').value === 2 && m('rules', 'guardHooks', 'recent').value === 4);
  check('bug specs: 2 existed in the baseline, 3 now; evidence runs 0', m('proving', 'bugSpecs', 'baseline').value === 2 && m('proving', 'bugSpecs', 'recent').value === 3 && m('proving', 'evidenceRuns', 'recent').value === 0);
  check('hub measures have no baseline (the hub did not exist yet)', m('planning', 'planDays', 'baseline').value === null && m('lessons', 'decisionsPerWeek', 'baseline').value === null);
  check('"measured now only" measures appear only in the recent window', m('design', 'branchCoverage', 'baseline').value === null && m('design', 'branchCoverage', 'recent').value === 70 && m('design', 'staleWorktrees', 'recent').value === 8);
  check('an area with no data in a window has no score (planning, design baseline)', res.areas.find((a) => a.id === 'planning').baseline.score === null && res.areas.find((a) => a.id === 'design').baseline.score === null);
  check('six weekly trend points per area', res.areas.every((a) => a.trend.length === 6));
  const orig = res.areas.filter((a) => a.original != null && a.baseline.score !== null).map((a) => a.original);
  check('overall compares only areas that have both my rating and a measured baseline', near(res.overall.originalComparable, orig.reduce((x, y) => x + y, 0) / orig.length, 0.06) && res.overall.original !== res.overall.originalComparable);

  console.log('--- with hub activity');
  const I2 = { ...I, hub: { first: D('2026-11-10'), notes: [{ at: D('2026-11-12'), section: 'Decisions' }, { at: D('2026-11-13'), section: 'Findings' }, { at: D('2026-11-14'), section: 'Analysis' }],
    planDays: [{ date: D('2026-11-17'), closed: true, score: { adherence: 80, coverage: 100 } }, { date: D('2026-11-18'), closed: true, score: { adherence: 60, coverage: 50 } }, { date: D('2026-11-19'), closed: false, score: null }], current: {} } };
  const res2 = sc.compute(I2, now); const m2 = (area, id, win) => res2.areas.find((a) => a.id === area)[win].metrics.find((x) => x.id === id);
  check('plan adherence and coverage are averaged over closed days only', m2('planning', 'planAdherence', 'recent').value === 70 && m2('planning', 'planCoverage', 'recent').value === 75);
  check('plans closed per week', near(m2('planning', 'planDays', 'recent').value, 1, 0.01), String(m2('planning', 'planDays', 'recent').value));
  check('only Decisions and Findings notes count as lessons', m2('lessons', 'decisionsPerWeek', 'recent').n === 2);

  console.log('--- configuration sanity');
  const cfg = sc.CONFIG;
  check('every measure in the config has a calculation', cfg.areas.every((a) => a.metrics.every((x) => typeof sc.METRICS[x.id] === 'function')), cfg.areas.flatMap((a) => a.metrics).filter((x) => !sc.METRICS[x.id]).map((x) => x.id).join());
  check('worst and best differ and weights are positive', cfg.areas.every((a) => a.metrics.every((x) => x.worst !== x.best && x.weight > 0)));
  check('area ids are unique and every area explains the gap, the hub features and the next step', new Set(cfg.areas.map((a) => a.id)).size === cfg.areas.length && cfg.areas.every((a) => a.gap && a.features.length && a.next));
  check('the earlier ratings are present', ['rules', 'lessons', 'design', 'proving', 'prepr', 'sessions'].every((id) => typeof cfg.areas.find((a) => a.id === id).original === 'number'));

  console.log('--- real run through a throwaway hub (read-only against Azure DevOps, git, usage log)');
  const realEnv = { ...process.env, HUB_PORT: '4714' }; delete realEnv.HUB_ONLY_EXTRA; // the real repos, read-only, so commit history can be scanned
  const srv = spawn(process.execPath, [HUB + '/server.js'], { stdio: 'ignore', env: realEnv });
  const base = 'http://localhost:4714';
  for (let i = 0; i < 80; i++) { try { await fetch(base + '/api/me'); break; } catch { await sleep(250); } }
  let x = await fetch(base + '/api/scorecard/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  check('running it needs the guard header', x.status === 403);
  x = await fetch(base + '/api/scorecard/run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Request': '1' }, body: '{}' });
  check('start -> 202 and it is running', x.status === 202 && (await x.json()).status === 'running');
  x = await fetch(base + '/api/scorecard/run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Request': '1' }, body: '{}' });
  check('asking again while it runs does not start a second run', (await x.json()).status === 'running');
  let st; for (let i = 0; i < 120; i++) { st = await (await fetch(base + '/api/scorecard')).json(); if (st.status === 'idle' && st.result) break; await sleep(1000); }
  const R = st.result;
  check('a result arrives', !!R && st.error === null, st.error || '');
  live('Azure DevOps was readable (no warnings)', R && R.notes.length === 0, R && R.notes.join(' | '));
  check('all seven areas are scored or honestly empty', R && R.areas.length === 7 && R.areas.every((a) => a.trend.length === 6));
  live('it read real data', R && R.inputs.prs > 10 && R.inputs.sessions > 50 && R.inputs.commitsScanned > 20 && R.inputs.learnings > 20, JSON.stringify(R && R.inputs));
  live('the baseline lands within about two points of the earlier ratings where both exist', R && R.areas.filter((a) => a.original != null && a.baseline.score !== null).every((a) => Math.abs(a.baseline.score - a.original) <= 2), R && R.areas.map((a) => a.id + ' ' + a.original + '->' + a.baseline.score).join(', '));
  check('planner accuracy and hub adoption are included', R && R.plannerAccuracy && typeof R.plannerAccuracy.lines === 'number' && R.adoption && typeof R.adoption.hooks.sessionStart === 'boolean');
  check('the result is saved to disk', fs.existsSync(path.join(root, 'data', 'scorecard.json')));
  const db = new DatabaseSync(path.join(root, 'data', 'hub.db'), { readOnly: true }); const snaps = db.prepare('SELECT COUNT(*) n FROM scorecard_snapshots').get().n; db.close();
  live('this week\'s snapshot rows are saved for the trend', snaps >= 4, String(snaps));
  srv.kill();

  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  await sleep(800); try { fs.rmSync(root, { recursive: true, force: true }); } catch { console.log('(left ' + root + ')'); }
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); console.log('temp ' + root); process.exit(1); });
