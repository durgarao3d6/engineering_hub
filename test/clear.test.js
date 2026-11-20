const HUBROOT = require('path').resolve(__dirname, '..').replace(/\\/g, '/'); require('./_config')(); // neutral settings (HUB_LIVE_TESTS=1 uses your own settings and board for the checks marked live)
process.env.HUB_BACKUP_DIR = process.env.HUB_BACKUP_DIR || require('path').join(require('os').tmpdir(), 'hub-test-backups-' + process.pid); process.on('exit', () => { try { require('fs').rmSync(process.env.HUB_BACKUP_DIR, { recursive: true, force: true }); } catch { /* temp */ } }); // tests never write into your real backup folder
// Exercises the clearance API on a throwaway hub (port 4701) with a throwaway repository and worktree.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hubtest-'));
Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' });
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const origin = path.join(dir, 'origin.git'); g(dir, 'init', '--bare', '-b', 'main', origin);
const seed = path.join(dir, 'seed'); g(dir, 'clone', origin, seed); fs.writeFileSync(path.join(seed, 'a.txt'), 'a\n'); g(seed, 'add', '.'); g(seed, 'commit', '-m', 'init'); g(seed, 'push', 'origin', 'HEAD:main');
const liveRepo = path.join(dir, 'live'); g(dir, 'clone', origin, liveRepo);
g(liveRepo, 'worktree', 'add', '--no-track', '-b', 'dev/7001-sample', path.join(dir, 'wt', 'alice-7001'), 'origin/main');
const srv = spawn('node', [HUBROOT + '/server.js'], { env: { ...process.env, HUB_PORT: '4701', HUB_DATA_DIR: path.join(dir, 'hubdata'), HUB_ONLY_EXTRA: '1', HUB_EXTRA_CLONES: liveRepo }, stdio: 'ignore' });
const base = 'http://localhost:4701';
const H = { 'Content-Type': 'application/json', 'X-Hub-Request': '1' };
const post = (p, b, h) => fetch(base + p, { method: 'POST', headers: h || H, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);
let fails = 0;
const check = (name, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' ' + extra : '')); if (!ok) fails++; };
(async () => {
  for (let i = 0; i < 40; i++) { try { await fetch(base + '/api/me'); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  const wt = await (await fetch(base + '/api/worktrees')).json();
  const target = wt.worktrees.find((w) => !w.isMain);
  const live = wt.worktrees.find((w) => w.isMain);
  check('found a worktree to test with', !!target, target && target.branch);
  if (!target) { srv.kill(); process.exit(1); }
  let r = await post('/api/clearances', { path: target.path, category: 'Other', reason: 'short' });
  check('reason too short -> 400', r[0] === 400 && r[1].errors.reason);
  r = await post('/api/clearances', { path: target.path, category: 'Bogus', reason: 'long enough reason' });
  check('bad category -> 400', r[0] === 400 && r[1].errors.category);
  r = await post('/api/clearances', { path: live.path, category: 'Other', reason: 'live checkout attempt' });
  check('live checkout -> 400', r[0] === 400);
  r = await post('/api/clearances', { path: 'E:\\nope', category: 'Other', reason: 'unknown path here' });
  check('unknown path -> 404', r[0] === 404);
  r = await post('/api/clearances', { path: target.path, category: 'Other', reason: 'x' }, { 'Content-Type': 'application/json' });
  check('missing X-Hub-Request -> 403', r[0] === 403);
  r = await fetch(base + '/api/clearances', { method: 'POST', headers: { ...H, Origin: 'https://evil.example' }, body: '{}' });
  check('foreign Origin -> 403', r.status === 403);
  r = await post('/api/clearances', { path: target.path, category: 'Completed by someone else', reason: 'Merged by a colleague in another PR', reference: 'PR 1234' });
  check('valid clear -> 201', r[0] === 201, JSON.stringify(r[1].clearance && r[1].clearance.clearedBy));
  const id = r[1].id;
  let w2 = (await (await fetch(base + '/api/worktrees')).json()).worktrees.find((w) => w.path === target.path);
  check('worktree annotated as cleared', w2.clearance && !w2.changedSinceCleared);
  r = await post('/api/clearances', { path: target.path, category: 'Other', reason: 'clear it again please' });
  check('double clear -> 409', r[0] === 409);
  const list = (await (await fetch(base + '/api/clearances')).json()).clearances;
  check('history has 1 active record', list.length === 1 && !list[0].restoredAt);
  r = await post('/api/clearances/' + id + '/restore', { note: 'back in play' });
  check('restore -> 200', r[0] === 200);
  r = await post('/api/clearances/' + id + '/restore', {});
  check('restore twice -> 409', r[0] === 409);
  w2 = (await (await fetch(base + '/api/worktrees')).json()).worktrees.find((w) => w.path === target.path);
  check('worktree active again', !w2.clearance);
  for (const f of ['/', '/app.js', '/styles.css']) check('static ' + f, (await fetch(base + f)).status === 200);
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  srv.kill();
  setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } process.exit(fails ? 1 : 0); }, 500);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
