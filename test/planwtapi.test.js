const HUBROOT = require('path').resolve(__dirname, '..').replace(/\\/g, '/'); require('./_config')(); // neutral settings (HUB_LIVE_TESTS=1 uses your own settings and board for the checks marked live)
process.env.HUB_BACKUP_DIR = process.env.HUB_BACKUP_DIR || require('path').join(require('os').tmpdir(), 'hub-test-backups-' + process.pid); process.on('exit', () => { try { require('fs').rmSync(process.env.HUB_BACKUP_DIR, { recursive: true, force: true }); } catch { /* temp */ } }); // tests never write into your real backup folder
// Worktree links through the HTTP API, with two real throwaway git repos (one task, two repos). Stub CLI; reads work item 8246 from Azure DevOps (read-only).
if (!process.env.HUB_LIVE_TESTS) { console.log('SKIP the whole file: it parses a plan against a real work item (run with HUB_LIVE_TESTS=1 against your own board)'); console.log('ALL PASSED'); process.exit(0); }
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'planwt-'));
Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' });
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
function repo(name) {
  const origin = path.join(root, name + '.git'); g(root, 'init', '--bare', '-b', 'main', origin);
  const seed = path.join(root, name + '-seed'); g(root, 'clone', origin, seed); w(path.join(seed, 'README.md'), name + '\n'); g(seed, 'add', '.'); g(seed, 'commit', '-m', 'init'); g(seed, 'push', 'origin', 'HEAD:main');
  const live = path.join(root, name + '-live'); g(root, 'clone', origin, live); return live;
}
const A = repo('alpha'); const B = repo('beta');
const wtA = path.join(root, 'wt', 'alice-8246');
g(A, 'worktree', 'add', '--no-track', '-b', 'dev/8246-menu-ui', wtA, 'origin/main');
w(path.join(wtA, 'src/Menu.tsx'), 'menu\n'); g(wtA, 'add', '.'); g(wtA, 'commit', '-m', 'Add dynamic menu component'); w(path.join(wtA, 'src/Profile.tsx'), 'profile\n'); // one committed, one uncommitted
g(B, 'checkout', '-b', 'dev/8246-menu-api'); w(path.join(B, 'Api/MenuEndpoint.cs'), 'api\n'); // live checkout of a second repo, dirty

const srv = spawn('node', [HUBROOT + '/server.js'], { stdio: 'ignore', env: { ...process.env, HUB_PORT: '4707', HUB_DATA_DIR: path.join(root, 'hubdata'), HUB_ONLY_EXTRA: '1',
  HUB_EXTRA_CLONES: A + ';' + B, HUB_CLAUDE_BIN: HUBROOT + '/test/stub-claude.js', STUB_MODE: 'ok', STUB_LOG: path.join(root, 'calls.log') } });
const base = 'http://localhost:4707';
const H = { 'Content-Type': 'application/json', 'X-Hub-Request': '1' };
const post = (p, b) => fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);
const get = (p) => fetch(base + p).then(async (r) => [r.status, await r.json()]);
let fails = 0;
const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!ok) fails++; };
const today = new Date().toLocaleDateString('en-CA');
(async () => {
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/me'); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  let [s, j] = await get('/api/worktrees');
  const rows = j.worktrees.filter((x) => x.taskId === 8246);
  check('hub sees both repos\' branches for task 8246', rows.length === 2 && rows.some((x) => x.isMain) && rows.some((x) => !x.isMain), rows.map((x) => x.repoKey + ':' + x.branch).join(','));

  console.log('--- parse links both repos automatically');
  [s, j] = await post('/api/plan/parse', { text: 'Work on #8246 dynamic menu\nSomething new with no branch at all' });
  check('parse ok', s === 200 && j.items.length === 2, JSON.stringify({ s, err: j.error }));
  const it0 = j.items[0]; const it1 = j.items[1];
  check('task line has a worktree in each repo, marked as task links', it0.taskId === 8246 && it0.worktrees.length === 2 && it0.worktrees.every((x) => x.source === 'task'), it0.worktrees.map((x) => x.repoKey + ':' + x.source).join(','));
  check('live checkout and worktree are both offered', it0.worktrees.some((x) => x.isMain) && it0.worktrees.some((x) => !x.isMain));
  check('line with no match has no worktree and gets a draft (the UI offers a picker)', it1.worktrees.length === 0 && !!it1.draft);

  console.log('--- save with a hand-picked worktree');
  const beta = it0.worktrees.find((x) => x.isMain); const alpha = it0.worktrees.find((x) => !x.isMain);
  [s, j] = await post('/api/plan/save', { date: today, rawText: 't', items: [
    { text: it0.text, kind: 'task', taskId: 8246, worktrees: it0.worktrees.map((x) => ({ path: x.path, source: x.source })) },
    { text: it1.text, kind: 'task', draft: it1.draft, worktrees: [{ path: alpha.path, source: 'user' }, { path: alpha.path, source: 'user' }] }] });
  check('save -> 201', s === 201, JSON.stringify(j.error));
  const items = j.items;
  check('task links are not stored but still shown (worked out from the branch names)', items[0].worktrees.length === 2 && items[0].worktrees.every((x) => x.source === 'task' && !x.missing));
  check('hand-picked link is stored once even if sent twice', items[1].worktrees.length === 1 && items[1].worktrees[0].source === 'user' && items[1].worktrees[0].path === alpha.path);
  check('live state is current (dirty files counted)', items[1].worktrees[0].dirtyFiles === 1, JSON.stringify(items[1].worktrees[0].dirtyFiles));

  console.log('--- validation');
  [s, j] = await post('/api/plan/save', { date: today, items: [{ text: 'x', worktrees: [{ path: 'E:\\not\\a\\known\\worktree' }] }] });
  check('unknown worktree path -> 400 (the hub never runs git in an arbitrary folder)', s === 400 && /not known/.test(j.error), j.error);
  [s, j] = await post('/api/plan/save', { date: today, items: [{ text: 'x', worktrees: 'nope' }] }); check('worktrees must be a list -> 400', s === 400);
  [s, j] = await post('/api/plan/save', { date: today, items: [{ text: 'x', worktrees: Array.from({ length: 9 }, () => ({ path: alpha.path })) }] }); check('more than 8 links -> 400', s === 400);
  [s, j] = await post('/api/plan/items/' + items[1].id + '/update', { worktrees: [{ path: 'C:\\Windows' }] }); check('update with an unknown path -> 400', s === 400);

  console.log('--- change links on a saved line');
  [s, j] = await post('/api/plan/items/' + items[1].id + '/update', { worktrees: [{ path: alpha.path, source: 'user' }, { path: beta.path, source: 'user' }] });
  check('link a second repo to the same line', s === 200 && j.item.worktrees.length === 2 && j.item.worktrees.map((x) => x.repoKey).sort().join() === 'alpha-live,beta-live', j.item && j.item.worktrees.map((x) => x.repoKey).join());
  [s, j] = await post('/api/plan/items/' + items[1].id + '/update', { worktrees: [] }); check('unlink everything', s === 200 && j.item.worktrees.length === 0);
  [s, j] = await post('/api/plan/items/' + items[1].id + '/update', { worktrees: [{ path: alpha.path, source: 'user' }, { path: beta.path, source: 'user' }] });

  console.log('--- redraft with real code context');
  [s, j] = await post('/api/plan/redraft', { text: it1.text, worktrees: [alpha.path, beta.path] });
  check('redraft ok and mentions both repos', s === 200 && /Context repos: alpha-live,beta-live/.test(j.draft.body), j.error || j.draft.body.slice(0, 120));
  const log = fs.readFileSync(path.join(root, 'calls.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const last = log[log.length - 1];
  check('the model saw commit subjects and file NAMES from both repos', /Add dynamic menu component/.test(last.prompt) && /src\/Menu\.tsx/.test(last.prompt) && /src\/Profile\.tsx/.test(last.prompt) && /Api\/MenuEndpoint\.cs/.test(last.prompt));
  check('and never file contents', !/"menu\\n"|profile\\n|"api\\n"/.test(last.prompt));
  [s, j] = await post('/api/plan/redraft', { text: it1.text, worktrees: ['E:\\nope'] }); check('redraft with an unknown path -> 400', s === 400);
  [s, j] = await post('/api/plan/redraft', { text: '  ', worktrees: [] }); check('redraft of an empty line -> 400', s === 400);

  console.log('--- a linked worktree disappears');
  g(A, 'worktree', 'remove', '--force', wtA);
  await get('/api/worktrees?refresh=1');
  [s, j] = await get('/api/plan?date=' + today);
  const l2 = j.items[1].worktrees;
  check('the removed worktree is flagged missing, the other still resolves', l2.some((x) => x.missing && x.repoKey === 'alpha-live') && l2.some((x) => !x.missing && x.repoKey === 'beta-live'), JSON.stringify(l2.map((x) => x.repoKey + ':' + (x.missing ? 'missing' : 'ok'))));
  check('the task-id link of the removed worktree is gone too', j.items[0].worktrees.length === 1 && j.items[0].worktrees[0].repoKey === 'beta-live');

  console.log('--- links survive carry-over');
  [s, j] = await post('/api/plan/close', { date: today, carry: [items[1].id] });
  const tmr = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toLocaleDateString('en-CA'); })();
  [s, j] = await get('/api/plan?date=' + tmr);
  check('carried line keeps its hand-picked links', j.items.length === 1 && j.items[0].worktrees.length === 2, JSON.stringify(j.items[0] && j.items[0].worktrees.map((x) => x.repoKey)));

  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  srv.kill(); await new Promise((r) => setTimeout(r, 500)); try { fs.rmSync(root, { recursive: true, force: true }); } catch { console.log('(left ' + root + ')'); }
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); console.log('temp ' + root); process.exit(1); });
