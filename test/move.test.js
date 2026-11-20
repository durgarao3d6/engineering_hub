const HUBROOT = require('path').resolve(__dirname, '..').replace(/\\/g, '/'); require('./_config')(); // neutral settings (HUB_LIVE_TESTS=1 uses your own settings and board for the checks marked live)
process.env.HUB_BACKUP_DIR = process.env.HUB_BACKUP_DIR || require('path').join(require('os').tmpdir(), 'hub-test-backups-' + process.pid); process.on('exit', () => { try { require('fs').rmSync(process.env.HUB_BACKUP_DIR, { recursive: true, force: true }); } catch { /* temp */ } }); // tests never write into your real backup folder
// End-to-end test of mover.js on throwaway repos (never touches real repos).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'movetest-'));
process.env.HUB_DATA_DIR = path.join(root, 'hubdata');
Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' });
const mover = require(HUBROOT + '/mover.js');
const store = require(HUBROOT + '/store.js');

const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const r = (p) => fs.readFileSync(p, 'utf8');
let fails = 0;
const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!ok) fails++; };
const five = (a) => ['1', '2', '3', '4', '5'].map((v, i) => (a && a[i] ? a[i] : v)).join('\n') + '\n';

function build(name) {
  const base = path.join(root, name); fs.mkdirSync(base, { recursive: true });
  const origin = path.join(base, 'origin.git'); g(base, 'init', '--bare', '-b', 'main', origin);
  const seed = path.join(base, 'seed'); g(base, 'clone', origin, seed);
  w(path.join(seed, 'a.txt'), five()); w(path.join(seed, 'b.txt'), 'b\n'); w(path.join(seed, 'x.txt'), five()); w(path.join(seed, 'src/app.txt'), 'app\n'); w(path.join(seed, '.gitignore'), 'node_modules/\n');
  g(seed, 'add', '.'); g(seed, 'commit', '-m', 'init'); g(seed, 'push', 'origin', 'HEAD:main');
  const live = path.join(base, 'live'); g(base, 'clone', origin, live);
  const wt = path.join(base, 'wt', 'alice-9001');
  g(live, 'worktree', 'add', '--no-track', '-b', 'dev/9001-test', wt, 'origin/main');
  w(path.join(live, 'node_modules/pkg/index.js'), 'REAL INSTALL\n');
  fs.symlinkSync(path.join(live, 'node_modules'), path.join(wt, 'node_modules'), 'junction');
  return { base, origin, seed, live, wt };
}
const advanceMain = (s, file, content) => { w(path.join(s.seed, file), content); g(s.seed, 'add', '.'); g(s.seed, 'commit', '-m', 'main change ' + file); g(s.seed, 'push', 'origin', 'HEAD:main'); };
async function waitDone(id) { for (let i = 0; i < 480; i++) { const m = store.moveGet(id); if (m.status !== 'running') return m; await new Promise((x) => setTimeout(x, 250)); } throw new Error('move timed out'); }

(async () => {
  /* ---- A: happy path, live dirty, origin advanced, junction in worktree ---- */
  console.log('--- A: normal move');
  let s = build('A');
  w(path.join(s.wt, 'a.txt'), five([null, 'wt-change'])); w(path.join(s.wt, 'c.txt'), 'new file\n');
  advanceMain(s, 'b.txt', 'b\nb2\n');
  w(path.join(s.live, 'src/app.txt'), 'app live edit\n'); w(path.join(s.live, 'live-note.txt'), 'note\n');
  const originBefore = g(s.origin, 'rev-parse', 'main'); const originRefs = g(s.origin, 'for-each-ref');
  let p = await mover.plan(s.wt);
  check('plan ok', p.ok, JSON.stringify(p.blockers));
  check('plan sees live branch main, 2 dirty', p.live.branch === 'main' && p.live.dirtyFiles === 2);
  check('plan merge = fast-forward after fetch? (before fetch: up-to-date)', ['up-to-date', 'fast-forward'].includes(p.merge.kind), p.merge.kind);
  let id = await mover.start(s.wt, 'tester', 'demo');
  let m = await waitDone(id);
  console.log('   ', m.status, '-', m.summary); m.steps.forEach((x) => console.log('     [' + x.status + '] ' + x.name + ' - ' + x.detail));
  check('status done', m.status === 'done', m.status);
  check('live is on the task branch', g(s.live, 'branch', '--show-current') === 'dev/9001-test');
  check('worktree change applied (a.txt)', r(path.join(s.live, 'a.txt')).includes('wt-change'));
  check('new file applied (c.txt)', fs.existsSync(path.join(s.live, 'c.txt')));
  check('origin/main merged first (b.txt has b2)', r(path.join(s.live, 'b.txt')).includes('b2'));
  check('changes are unstaged', g(s.live, 'diff', '--cached', '--name-only') === '');
  check('live edit NOT on branch (stashed)', r(path.join(s.live, 'src/app.txt')).trim() === 'app' &&!fs.existsSync(path.join(s.live, 'live-note.txt')));
  check('worktree folder removed', !fs.existsSync(s.wt));
  check('worktree unregistered', !g(s.live, 'worktree', 'list').includes('alice-9001'));
  check('real node_modules untouched by removal', r(path.join(s.live, 'node_modules/pkg/index.js')) === 'REAL INSTALL\n');
  const sl = g(s.live, 'stash', 'list'); check('stash exists with hub message', sl.includes('hub-move ' + id), sl);
  const sfiles = g(s.live, 'stash', 'show', '--include-untracked', '--name-only', 'stash@{0}');
  check('stash holds tracked + untracked live changes', sfiles.includes('src/app.txt') && sfiles.includes('live-note.txt'), sfiles.replace(/\n/g, ','));
  let sts = await mover.stashStates(store.stashList());
  check('hub recorded 1 stash, state stashed', sts.length === 1 && sts[0].state === 'stashed' && sts[0].fileCount === 2, JSON.stringify(sts.map((x) => x.state)));
  check('patch kept', fs.existsSync(m.patchPath));
  check('nothing pushed (origin main unchanged)', g(s.origin, 'rev-parse', 'main') === originBefore && g(s.origin, 'for-each-ref') === originRefs);
  check('no stray AI attribution in history', !/claude|co-authored/i.test(g(s.live, 'log', '--format=%B', '-n', '5')));
  g(s.live, 'stash', 'drop'); sts = await mover.stashStates(store.stashList());
  check('state becomes gone after drop', sts[0].state === 'gone');

  /* ---- B: merge conflict -> merge skipped, patch still applied ---- */
  console.log('--- B: origin/main conflicts with branch commits');
  s = build('B');
  w(path.join(s.wt, 'x.txt'), five(['branch'])); g(s.wt, 'add', '.'); g(s.wt, 'commit', '-m', 'branch change');
  w(path.join(s.wt, 'a.txt'), five([null, 'wt-change']));
  advanceMain(s, 'x.txt', five(['main']));
  g(s.live, 'fetch', 'origin'); // so plan can see it
  p = await mover.plan(s.wt);
  check('plan predicts conflicts in x.txt', p.merge.kind === 'conflicts' && p.merge.files.includes('x.txt'), JSON.stringify(p.merge));
  id = await mover.start(s.wt, 'tester', 'demo'); m = await waitDone(id);
  m.steps.forEach((x) => console.log('     [' + x.status + '] ' + x.name + ' - ' + x.detail));
  check('status done-with-warnings', m.status === 'done-with-warnings', m.status);
  check('merge aborted cleanly (no MERGE_HEAD, no unmerged)', !fs.existsSync(path.join(s.live, '.git/MERGE_HEAD')) && g(s.live, 'diff', '--name-only', '--diff-filter=U') === '');
  check('branch commit kept, x.txt = branch', r(path.join(s.live, 'x.txt')).startsWith('branch'));
  check('uncommitted change still applied', r(path.join(s.live, 'a.txt')).includes('wt-change'));
  check('live was clean -> no stash created', g(s.live, 'stash', 'list') === '');

  /* ---- C: patch conflicts with new main ---- */
  console.log('--- C: saved changes conflict with origin/main');
  s = build('C');
  w(path.join(s.wt, 'a.txt'), five([null, null, 'wt']));
  advanceMain(s, 'a.txt', five([null, null, 'main']));
  id = await mover.start(s.wt, 'tester', 'demo'); m = await waitDone(id);
  m.steps.forEach((x) => console.log('     [' + x.status + '] ' + x.name + ' - ' + x.detail));
  check('status done-with-warnings (conflict markers)', m.status === 'done-with-warnings', m.status);
  check('markers present in a.txt', r(path.join(s.live, 'a.txt')).includes('<<<<<<<'));
  check('nothing staged after conflict apply', g(s.live, 'diff', '--cached', '--name-only') === '');

  /* ---- E: real merge commit (branch has its own commit, main moved on elsewhere) ---- */
  console.log('--- E: merge commit label');
  s = build('E');
  w(path.join(s.wt, 'x.txt'), five(['branch'])); g(s.wt, 'add', '.'); g(s.wt, 'commit', '-m', 'branch change');
  advanceMain(s, 'b.txt', 'b\nb2\n');
  id = await mover.start(s.wt, 'tester', 'demo'); m = await waitDone(id);
  check('status done', m.status === 'done', m.status);
  check('labelled as a new merge commit', /new merge commit/.test(m.summary), m.summary.slice(-90));
  check('HEAD has two parents', g(s.live, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length === 3);

  /* ---- D: blockers ---- */
  console.log('--- D: blockers');
  s = build('D');
  p = await mover.plan(s.live); check('live checkout refused', !p.ok && p.blockers.join().includes('live checkout'), p.blockers.join());
  p = await mover.plan(path.join(root, 'nope')); check('missing folder refused', !p.ok);
  g(s.wt, 'checkout', '--detach'); p = await mover.plan(s.wt); check('detached refused', !p.ok && p.blockers.join().includes('detached'), p.blockers.join());
  g(s.wt, 'checkout', 'dev/9001-test');
  fs.writeFileSync(path.join(s.live, '.git/MERGE_HEAD'), g(s.live, 'rev-parse', 'HEAD') + '\n');
  p = await mover.plan(s.wt); check('live mid-merge refused', !p.ok && p.blockers.join().includes('MERGE_HEAD'), p.blockers.join());
  fs.unlinkSync(path.join(s.live, '.git/MERGE_HEAD'));
  g(s.live, 'worktree', 'lock', s.wt); p = await mover.plan(s.wt); check('locked refused', !p.ok && p.blockers.join().includes('locked'), p.blockers.join());
  g(s.live, 'worktree', 'unlock', s.wt);

  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { console.log('(left temp dir ' + root + ')'); }
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); console.log('temp dir ' + root); process.exit(1); });
