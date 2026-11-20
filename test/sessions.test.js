const HUBROOT = require('path').resolve(__dirname, '..').replace(/\\/g, '/'); require('./_config')(); // neutral settings (HUB_LIVE_TESTS=1 uses your own settings and board for the checks marked live)
process.env.HUB_BACKUP_DIR = process.env.HUB_BACKUP_DIR || require('path').join(require('os').tmpdir(), 'hub-test-backups-' + process.pid); process.on('exit', () => { try { require('fs').rmSync(process.env.HUB_BACKUP_DIR, { recursive: true, force: true }); } catch { /* temp */ } }); // tests never write into your real backup folder
// Sessions are linked to tasks through the git branch recorded in the transcript. Throwaway folder, no real data.
const fs = require('fs');
const os = require('os');
const path = require('path');
const HUB = HUBROOT;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sesstest-'));
const sessions = require(HUB + '/sessions.js');

let fails = 0;
const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!ok) fails++; };

const line = (o) => JSON.stringify(o);
const mk = (proj, id, lines) => { fs.mkdirSync(path.join(dir, proj), { recursive: true }); fs.writeFileSync(path.join(dir, proj, id + '.jsonl'), lines.join('\n') + '\n'); };
mk('C--work-UI-a', 'aaaa', [
  line({ type: 'user', cwd: 'C:\\work\\wt\\alice-5945', gitBranch: 'dev/5945-address-autolist', timestamp: '2026-11-10T09:00:00Z', message: { content: 'SECRET CONVERSATION TEXT' } }),
  line({ type: 'assistant', cwd: 'C:\\work\\wt\\alice-5945', gitBranch: 'dev/5945-address-autolist', timestamp: '2026-11-10T10:00:00Z' }),
]);
mk('C--work-UI-b', 'bbbb', [
  line({ cwd: 'C:\\work\\wt\\bob-5945', gitBranch: 'dev/5945-address-autolist', timestamp: '2026-11-15T09:00:00Z' }),
  line({ cwd: 'C:\\work\\wt\\bob-5945', gitBranch: 'dev/7763-contacts', timestamp: '2026-11-15T12:00:00Z' }),
]);
mk('C--work', 'cccc', [line({ cwd: 'C:\\work', gitBranch: 'main', timestamp: '2026-11-16T09:00:00Z' })]);
mk('C--work-x', 'dddd', [line({ cwd: 'C:\\work', gitBranch: 'dev/59451-other-task', timestamp: '2026-11-17T09:00:00Z' })]);
fs.writeFileSync(path.join(dir, 'C--work', 'notes.txt'), 'not a transcript');

const rows = [
  { sessionId: 'aaaa', prompt: 'Fix the autolist duplicates', start: '2026-11-10T09:00:00Z', main: { usd: 1.5 }, subagents: [{ usd: 0.25 }] },
  { sessionId: 'aaaa', prompt: 'second prompt', start: '2026-11-10T09:30:00Z', main: { usd: 0.5 }, subagents: [] },
  { sessionId: 'bbbb', prompt: 'Continue keyboard nav', start: '2026-11-15T09:00:00Z', main: { usd: 2 } },
];

const r = sessions.forTask(5945, { projectsDir: dir, rows });
check('two sessions found for task 5945', r.sessions.length === 2, r.sessions.map((s) => s.sessionId).join());
check('newest first', r.sessions[0].sessionId === 'bbbb');
check('turns and cost come from the usage log (subagents included)', r.sessions[1].turns === 2 && r.sessions[1].usd === 2.25, JSON.stringify(r.sessions[1]));
check('label is the first prompt', r.sessions[1].label === 'Fix the autolist duplicates');
check('working folder and times are taken from the transcript', r.sessions[1].folder === 'C:\\work\\wt\\alice-5945' && r.sessions[1].first === '2026-11-10T09:00:00Z' && r.sessions[1].last === '2026-11-10T10:00:00Z');
check('a session that also touched another task says so', r.sessions[0].otherTasks.join() === '7763');
check('totals add up', r.totals.sessions === 2 && r.totals.turns === 3 && r.totals.usd === 4.25, JSON.stringify(r.totals));
check('task 59451 is not confused with 5945', sessions.forTask(59451, { projectsDir: dir, rows }).sessions.length === 1 && sessions.forTask(5945, { projectsDir: dir, rows }).sessions.every((s) => s.sessionId !== 'dddd'));
check('a session on main is never linked', sessions.forTask(1, { projectsDir: dir, rows }).sessions.length === 0);
check('the second task is found through the multi-branch session', sessions.forTask(7763, { projectsDir: dir, rows }).sessions.length === 1);
check('conversation text is never returned', !JSON.stringify(r).includes('SECRET CONVERSATION TEXT'));
check('a missing projects folder gives an empty list, not an error', sessions.forTask(5945, { projectsDir: path.join(dir, 'nope'), rows }).sessions.length === 0);
check('a non-numeric id is rejected quietly', sessions.forTask('abc', { projectsDir: dir, rows }).sessions.length === 0);

// cache refreshes when a transcript grows
fs.appendFileSync(path.join(dir, 'C--work-UI-a', 'aaaa.jsonl'), line({ cwd: 'x', gitBranch: 'dev/5945-address-autolist', timestamp: '2026-11-12T10:00:00Z' }) + '\n');
check('a grown transcript is rescanned', sessions.forTask(5945, { projectsDir: dir, rows }).sessions.find((s) => s.sessionId === 'aaaa').last === '2026-11-12T10:00:00Z');

console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
process.exit(fails ? 1 : 0);
