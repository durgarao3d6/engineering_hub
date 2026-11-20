const HUBROOT = require('path').resolve(__dirname, '..').replace(/\\/g, '/'); require('./_config')(); // neutral settings (HUB_LIVE_TESTS=1 uses your own settings and board for the checks marked live)
process.env.HUB_BACKUP_DIR = process.env.HUB_BACKUP_DIR || require('path').join(require('os').tmpdir(), 'hub-test-backups-' + process.pid); process.on('exit', () => { try { require('fs').rmSync(process.env.HUB_BACKUP_DIR, { recursive: true, force: true }); } catch { /* temp */ } }); // tests never write into your real backup folder
// Stash manager on throwaway repos: listing, verdicts, clear (recoverable), restore, purge, re-work, safety, and the HTTP API.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashtest-'));
const HUB = HUBROOT;
const liveA = path.join(root, 'A', 'live');
const liveB = path.join(root, 'B', 'live');
const liveC = path.join(root, 'C', 'live');
Object.assign(process.env, {
  HUB_DATA_DIR: path.join(root, 'hubdata'), HUB_BACKUP_DIR: path.join(root, 'bk'), HUB_ONLY_EXTRA: '1', HUB_NO_ADO: '1', HUB_WT_ROOT: path.join(root, 'wt'),
  HUB_EXTRA_CLONES: [liveA, liveB, liveC].join(';'),
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
});
const info = require(HUB + '/collectors/stashinfo.js');
const mgr = require(HUB + '/stashmgr.js');
const store = require(HUB + '/store.js');

const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const r = (p) => fs.readFileSync(p, 'utf8');
let fails = 0;
const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!ok) fails++; };
const five = (a) => ['1', '2', '3', '4', '5'].map((v, i) => (a && a[i] ? a[i] : v)).join('\n') + '\n';
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

function build(name) {
  const base = path.join(root, name); fs.mkdirSync(base, { recursive: true });
  const origin = path.join(base, 'origin.git'); g(base, 'init', '--bare', '-b', 'main', origin);
  const seed = path.join(base, 'seed'); g(base, 'clone', origin, seed);
  w(path.join(seed, 'a.txt'), five()); w(path.join(seed, 'b.txt'), five()); w(path.join(seed, 'x.txt'), five());
  g(seed, 'add', '.'); g(seed, 'commit', '-m', 'init'); g(seed, 'push', 'origin', 'HEAD:main');
  const live = path.join(base, 'live'); g(base, 'clone', origin, live);
  return { base, origin, seed, live };
}
const advance = (s, file, content, msg) => { g(s.seed, 'pull', '-q', '--ff-only', 'origin', 'main'); w(path.join(s.seed, file), content); g(s.seed, 'add', '.'); g(s.seed, 'commit', '-m', msg || 'main change'); g(s.seed, 'push', 'origin', 'HEAD:main'); g(s.live, 'fetch', '-q', 'origin'); };
const stash = (live, msg, ...extra) => { g(live, 'stash', 'push', ...extra, '-m', msg); return g(live, 'rev-parse', 'stash@{0}'); };

(async () => {
  console.log('--- build the repositories');
  const A = build('A');
  // S1: will be identical to main after main takes the same edit
  w(path.join(A.live, 'a.txt'), five([null, 'same-edit'])); const S1 = stash(A.live, 'identical to main later');
  // S2: plain change that applies cleanly
  w(path.join(A.live, 'b.txt'), five([null, null, 'clean-edit'])); const S2 = stash(A.live, 'clean edit');
  // S3: will conflict with main
  w(path.join(A.live, 'x.txt'), five([null, null, null, 'mine'])); const S3 = stash(A.live, 'conflicting edit');
  // S4: untracked only
  w(path.join(A.live, 'brand-new.txt'), 'new\n'); const S4 = stash(A.live, 'untracked only', '-u');
  // S5: made on a task branch that later lands in main
  g(A.live, 'checkout', '-q', '-b', 'dev/9100-foo'); w(path.join(A.live, 'foo.txt'), 'foo\n'); g(A.live, 'add', '.'); g(A.live, 'commit', '-q', '-m', 'foo work');
  w(path.join(A.live, 'b.txt'), five([null, null, null, null, 'late-wip'])); const S5 = stash(A.live, 'late wip');
  g(A.live, 'push', '-q', 'origin', 'dev/9100-foo:main'); g(A.live, 'checkout', '-q', 'main');
  advance(A, 'a.txt', five([null, 'same-edit']), 'takes the same edit as S1');
  advance(A, 'x.txt', five([null, null, null, 'theirs']), 'conflicts with S3');
  const originRefs = g(A.origin, 'for-each-ref');
  const liveHead = g(A.live, 'rev-parse', 'HEAD'); const liveStatus = g(A.live, 'status', '--porcelain');

  console.log('--- listing');
  const l = await info.list(A.live);
  check('lists the 5 stashes, newest first', l.ok && l.stashes.length === 5 && l.stashes[0].hash === S5 && l.stashes[4].hash === S1, l.stashes.map((s) => s.ref).join());
  check('subject parsed: branch and task id', l.stashes[0].branch === 'dev/9100-foo' && l.stashes[0].taskId === 9100 && l.stashes[1].branch === 'main' && l.stashes[1].taskId === null, JSON.stringify(l.stashes[0]));
  check('a folder that is not a repository fails cleanly', (await info.list(root)).ok === false);

  console.log('--- analysis and verdicts');
  const main = await info.mainRef(A.live);
  check('main reference found', main && main.ref === 'origin/main');
  const by = Object.fromEntries(l.stashes.map((s) => [s.hash, s]));
  const V = {}; const F = {};
  for (const h of [S1, S2, S3, S4, S5]) { F[h] = await info.analyse(A.live, by[h], main); V[h] = info.verdict(F[h], by[h], {}); }
  check('S1 identical to main -> safe to clear', F[S1].identical === true && V[S1].kind === 'safe', JSON.stringify(V[S1]));
  check('S2 clean edit applies cleanly -> worth reviewing', F[S2].identical === false && F[S2].conflicts.length === 0 && V[S2].kind === 'review', JSON.stringify(V[S2]));
  check('S3 conflicts with main -> needs rework, file named', V[S3].kind === 'rework' && F[S3].conflicts.includes('x.txt'), JSON.stringify(F[S3].conflicts));
  check('S4 untracked-only: file counted, not identical', F[S4].untracked.join() === 'brand-new.txt' && F[S4].files.length === 0 && V[S4].kind === 'review', JSON.stringify(V[S4]));
  check('S5 branch merged but the stash is new and differs -> worth reviewing (may be live work)', F[S5].branchMerged === true && V[S5].kind === 'review' && /recent/.test(V[S5].why), JSON.stringify(V[S5]));
  check('the same stash 30 days old -> likely obsolete', F[S5].branchMerged === true && info.verdict(F[S5], { ...by[S5], createdAt: new Date(Date.now() - 30 * 86400000).toISOString() }, {}).kind === 'obsolete');
  check('a new stash whose files mostly match main on a merged branch -> likely obsolete', info.verdict({ ...F[S5], sameAsMain: 1 }, by[S5], {}).kind === 'obsolete');
  check('task state Closed -> likely obsolete (even when the branch is unknown)', info.verdict({ ...F[S2], branchMerged: null }, { ...by[S2], taskId: 77 }, { taskState: 'Closed' }).kind === 'obsolete');
  const oldSt = { ...by[S2], createdAt: new Date(Date.now() - 90 * 86400000).toISOString() };
  check('older than 60 days and clean -> old, review', info.verdict(F[S2], oldSt, {}).kind === 'old');
  check('old but conflicting stays "needs rework"', info.verdict(F[S3], { ...oldSt }, {}).kind === 'rework');
  check('line counts are recorded', F[S2].added === 1 && F[S2].removed === 1, F[S2].added + '/' + F[S2].removed);
  const sm = await info.summary(A.live, by[S2]);
  check('summary: totals counted by git', sm.totals.files === 1 && sm.totals.added === 1 && sm.totals.removed === 1 && sm.files[0].file === 'b.txt' && sm.files[0].status === 'M', JSON.stringify(sm.totals));
  const fd = await info.fileDiff(A.live, by[S2], 'b.txt');
  check('one file\'s diff shows the change', /\+clean-edit/.test(fd.diff) && fd.truncated === false && fd.binary === false);
  const sm4 = await info.summary(A.live, by[S4]);
  check('summary lists untracked files with size', sm4.untracked.length === 1 && sm4.untracked[0].file === 'brand-new.txt' && sm4.untracked[0].size === 4 && sm4.totals.untracked === 1, JSON.stringify(sm4.untracked));
  check('an untracked file shows as added lines', /^\+new/.test((await info.fileDiff(A.live, by[S4], 'brand-new.txt')).diff));
  check('a file that is not in the stash is refused', (await info.fileDiff(A.live, by[S2], 'a.txt; rm -rf')) === null);
  check('full patch carries the change and can be applied', /\+clean-edit/.test(await info.fullPatch(A.live, by[S2])));
  // a big stash: many large files, far over the old 240 KB cap. Nothing may be cut from the totals, and every file opens on its own.
  const E = build('E');
  const big = (n) => Array.from({ length: 4000 }, (_, i) => 'line ' + n + ' ' + i + ' ' + 'x'.repeat(30)).join('\n') + '\n';
  for (let i = 0; i < 6; i++) w(path.join(E.live, 'big' + i + '.txt'), big(i));
  g(E.live, 'add', '.'); g(E.live, 'commit', '-q', '-m', 'big files'); for (let i = 0; i < 6; i++) w(path.join(E.live, 'big' + i + '.txt'), big(i + 100));
  const SE = stash(E.live, 'big stash'); const bigSt = (await info.list(E.live)).stashes[0];
  const bs = await info.summary(E.live, bigSt);
  const patch = await info.fullPatch(E.live, bigSt);
  check('big stash: the patch is far larger than the old cap', patch.length > 600 * 1024, String(patch.length));
  check('big stash: the summary still counts every file and line', bs.totals.files === 6 && bs.totals.added === 24000 && bs.totals.removed === 24000, JSON.stringify(bs.totals));
  check('big stash: every file opens on its own, complete', (await Promise.all(bs.files.map((f) => info.fileDiff(E.live, bigSt, f.file)))).every((x) => x && x.truncated === false && x.diff.length > 100000));
  check('big stash: the full patch contains every file', bs.files.every((f) => patch.includes('+++ b/' + f.file)));
  void SE;
  check('analysis changed nothing in the repo', g(A.live, 'rev-parse', 'HEAD') === liveHead && g(A.live, 'status', '--porcelain') === liveStatus && g(A.live, 'stash', 'list').split('\n').length === 5);

  console.log('--- clear (recoverable)');
  let e = await rejects(() => mgr.clear(A.live, S2, 'no', 'tester'));
  check('a reason is required', e && e.status === 400 && /reason/i.test(e.message));
  e = await rejects(() => mgr.clear(A.live, 'abc', 'long enough reason', 'tester'));
  check('a bad id is rejected', e && e.status === 400);
  e = await rejects(() => mgr.clear(root, S2, 'long enough reason', 'tester'));
  check('a folder that is not one of your clones is refused', e && e.status === 404);
  const c2 = await mgr.clear(A.live, S2, 'superseded by the real fix', 'tester');
  const after = (await info.list(A.live)).stashes;
  check('the middle stash is gone and the others are untouched', after.length === 4 && !after.some((s) => s.hash === S2) && [S1, S3, S4, S5].every((h) => after.some((s) => s.hash === h)));
  check('a hidden ref keeps the commit', g(A.live, 'rev-parse', 'refs/hub-trash/' + S2) === S2);
  check('a patch file with the change was saved', fs.existsSync(c2.patchPath) && /clean-edit/.test(r(c2.patchPath)), c2.patchPath);
  check('the clear is in the history with its reason', store.stashActionList()[0].action === 'cleared' && store.stashActionList()[0].reason === 'superseded by the real fix' && store.stashActionList()[0].files.includes('b.txt'));
  check('it shows in the trash', store.stashTrash().length === 1 && store.stashTrash()[0].hash === S2);
  e = await rejects(() => mgr.clear(A.live, S2, 'long enough reason', 'tester'));
  check('clearing it again says it is gone (404)', e && e.status === 404);
  check('clearing changed no working files and pushed nothing', g(A.live, 'status', '--porcelain') === liveStatus && g(A.origin, 'for-each-ref') === originRefs);

  console.log('--- the index shifts after each drop: clear two more by hash');
  await mgr.clear(A.live, S4, 'untracked scratch', 'tester');
  await mgr.clear(A.live, S1, 'already in main', 'tester');
  const left = (await info.list(A.live)).stashes;
  check('exactly S3 and S5 remain, each at its new index', left.length === 2 && left[0].hash === S5 && left[1].hash === S3 && left[1].ref === 'stash@{1}');
  check('the untracked-only stash patch contains the new file', /brand-new\.txt/.test(r(store.stashTrash().find((t) => t.hash === S4).patchPath)));

  console.log('--- restore');
  const rs = await mgr.restore(A.live, S2, 'tester');
  const back = (await info.list(A.live)).stashes;
  check('restored with the same hash', back.some((s) => s.hash === S2) && rs.hash === S2);
  check('the hidden ref is removed after restoring', (() => { try { g(A.live, 'rev-parse', '--verify', '-q', 'refs/hub-trash/' + S2); return false; } catch { return true; } })());
  check('it is out of the trash', !store.stashTrash().some((t) => t.hash === S2));
  e = await rejects(() => mgr.restore(A.live, S2, 'tester'));
  check('restoring something not in the trash is refused', e && e.status === 404);
  const popped = g(A.live, 'stash', 'show', '-p', S2);
  check('the restored stash still holds the change', /clean-edit/.test(popped));

  console.log('--- empty trash');
  const pe = await rejects(() => mgr.purge(A.live, S2, 'tester'));
  check('a stash on the list cannot be purged', pe && pe.status === 404);
  const patch4 = store.stashTrash().find((t) => t.hash === S4).patchPath;
  await mgr.purge(A.live, S4, 'tester');
  check('purge removes the ref and the patch but keeps the history row', !fs.existsSync(patch4) && !store.stashTrash().some((t) => t.hash === S4) && store.stashActionsFor(A.live, S4).map((a) => a.action).join() === 'cleared,purged');
  check('trash still has S1', store.stashTrash().length === 1 && store.stashTrash()[0].hash === S1);

  console.log('--- re-work to a worktree');
  const plan = await mgr.reworkPlan(A.live, S5, null, null, []);
  check('plan: task id from the branch, first free co-worker name', plan.taskId === 9100 && plan.name === 'Alice' && plan.folder === 'alice-9100' && plan.branch === 'dev/9100-rework-' + S5.slice(0, 7), JSON.stringify(plan));
  check('plan: second name when the first is used', (await mgr.reworkPlan(A.live, S5, null, null, ['alice'])).name === 'Bob');
  const rw = await mgr.rework(A.live, S5, null, null, 'tester', []);
  check('worktree created and the stash applied', rw.applied === true && fs.existsSync(path.join(rw.path, 'b.txt')) && /late-wip/.test(r(path.join(rw.path, 'b.txt'))), JSON.stringify(rw));
  check('it sits on a new branch made from the stash base, no upstream', g(rw.path, 'branch', '--show-current') === rw.branch && g(rw.path, 'rev-parse', 'HEAD') === F[S5].base && (() => { try { g(rw.path, 'config', '--get', 'branch.' + rw.branch + '.remote'); return false; } catch { return true; } })());
  check('the change is unstaged in the worktree', g(rw.path, 'diff', '--cached', '--name-only') === '' && g(rw.path, 'status', '--porcelain').includes('b.txt'));
  check('the original stash is still on the list', (await info.list(A.live)).stashes.some((s) => s.hash === S5));
  check('the live checkout is untouched', g(A.live, 'branch', '--show-current') === 'main' && g(A.live, 'status', '--porcelain') === liveStatus);
  check('the re-work is in the history', store.stashActionList()[0].action === 'reworked' && store.stashActionList()[0].worktree === rw.path);
  e = await rejects(() => mgr.rework(A.live, S5, null, 'Alice', 'tester', []));
  check('the same name and task again is refused (folder exists)', e && e.status === 409, e && e.message);
  e = await rejects(() => mgr.rework(A.live, S3, '12', 'bad name!', 'tester', []));
  check('a bad name is refused', e && e.status === 400);
  const rw3 = await mgr.rework(A.live, S3, 4242, 'Carol', 'tester', []);
  check('a stash that conflicts with main still applies on its own base', rw3.applied === true && /mine/.test(r(path.join(rw3.path, 'x.txt'))) && path.basename(rw3.path) === 'carol-4242', rw3.path);

  console.log('--- refuses while a merge is in progress');
  const B = build('B');
  w(path.join(B.live, 'a.txt'), five(['mine'])); const SB = stash(B.live, 'b stash');
  g(B.live, 'checkout', '-q', '-b', 'side'); w(path.join(B.live, 'b.txt'), five(['side'])); g(B.live, 'commit', '-qam', 'side');
  g(B.live, 'checkout', '-q', 'main'); w(path.join(B.live, 'b.txt'), five(['main-side'])); g(B.live, 'commit', '-qam', 'main');
  try { g(B.live, 'merge', 'side'); } catch { /* conflict expected */ }
  e = await rejects(() => mgr.clear(B.live, SB, 'long enough reason', 'tester'));
  check('clear is refused mid-merge', e && e.status === 409 && /merge/i.test(e.message), e && e.message);
  check('the stash is still there', (await info.list(B.live)).stashes.length === 1);
  g(B.live, 'merge', '--abort');

  console.log('--- the hub-made stash record is marked handled when cleared');
  const C = build('C');
  w(path.join(C.live, 'a.txt'), five(['live edit'])); const SC = stash(C.live, 'hub-move 1: live changes');
  const sid = store.stashAdd({ moveId: 1, repoKey: path.basename(C.base), livePath: C.live, hash: SC, message: 'hub-move 1', prevBranch: 'main', files: ['a.txt'] });
  await mgr.clear(C.live, SC, 'moved on, not needed', 'tester');
  check('the move-made stash is handled with the reason', !!store.stashGet(sid).handledAt && /moved on/.test(store.stashGet(sid).handledNote));

  console.log('--- HTTP API');
  const port = 4702; const base = 'http://localhost:' + port;
  const srv = spawn('node', [HUB + '/server.js'], { env: { ...process.env, HUB_PORT: String(port) }, stdio: 'ignore' });
  const H = { 'Content-Type': 'application/json', 'X-Hub-Request': '1' };
  const post = (p, b, h) => fetch(base + p, { method: 'POST', headers: h || H, body: JSON.stringify(b) }).then(async (x) => [x.status, await x.json()]);
  try {
    for (let i = 0; i < 40; i++) { try { await fetch(base + '/api/me'); break; } catch { await new Promise((x) => setTimeout(x, 250)); } }
    const ov = await (await fetch(base + '/api/stash/overview')).json();
    check('overview lists the repos that have stashes with counts', ov.total === ov.repos.reduce((n, x) => n + x.count, 0) && ov.repos.some((x) => x.path === liveA && x.count === 3), ov.repos.map((x) => x.repoKey + ':' + x.count).join());
    const ra = ov.repos.find((x) => x.path === liveA);
    check('overview rows carry age and branch, no verdict before analysis', ra.stashes.every((s) => s.createdAt && 'branch' in s && s.verdict === null));
    const an = await post('/api/stash/analyse', { repo: liveA, hashes: ra.stashes.map((s) => s.hash).concat(['zz']) });
    check('analyse returns verdicts for the stashes asked for', an[0] === 200 && an[1].stashes.length === 3 && an[1].stashes.every((s) => s.verdict && s.fileCount >= 1), JSON.stringify(an[1].stashes.map((s) => s.verdict && s.verdict.kind)));
    const ov2 = await (await fetch(base + '/api/stash/overview')).json();
    check('verdicts are cached for the next overview', ov2.repos.find((x) => x.path === liveA).stashes.every((s) => s.verdict));
    check('analyse refuses an unknown repository', (await post('/api/stash/analyse', { repo: root, hashes: [] }))[0] === 404);
    const df = await (await fetch(base + '/api/stash/diff?repo=' + encodeURIComponent(liveA) + '&hash=' + S3)).json();
    check('diff endpoint returns the complete summary', df.totals.files === 1 && df.files[0].file === 'x.txt' && df.totals.added === 1);
    const dfile = await (await fetch(base + '/api/stash/diff?repo=' + encodeURIComponent(liveA) + '&hash=' + S3 + '&file=x.txt')).json();
    check('diff endpoint returns one file on request', /\+mine/.test(dfile.diff));
    check('diff endpoint refuses a file that is not in the stash', (await fetch(base + '/api/stash/diff?repo=' + encodeURIComponent(liveA) + '&hash=' + S3 + '&file=a.txt')).status === 404);
    const pr = await fetch(base + '/api/stash/patch?repo=' + encodeURIComponent(liveA) + '&hash=' + S3);
    check('patch endpoint downloads the full patch as a file', pr.status === 200 && /attachment/.test(pr.headers.get('content-disposition')) && /\+mine/.test(await pr.text()));
    check('diff endpoint refuses a bad hash', (await fetch(base + '/api/stash/diff?repo=' + encodeURIComponent(liveA) + '&hash=nothex')).status === 400);
    check('write without the hub header -> 403', (await post('/api/stash/clear', { repo: liveA, hashes: [S3], reason: 'long enough' }, { 'Content-Type': 'application/json' }))[0] === 403);
    check('clear with a short reason -> every item fails with the reason message', (await post('/api/stash/clear', { repo: liveA, hashes: [S3], reason: 'x' }))[1].results[0].ok === false);
    check('clear with no hashes -> 400', (await post('/api/stash/clear', { repo: liveA, hashes: [], reason: 'long enough' }))[0] === 400);
    const cl = await post('/api/stash/clear', { repo: liveA, hashes: [S5, S3], reason: 'api test clear of two' });
    check('bulk clear reports each stash', cl[0] === 200 && cl[1].cleared === 2 && cl[1].results.every((x) => x.ok), JSON.stringify(cl[1]));
    const ov3 = await (await fetch(base + '/api/stash/overview')).json();
    check('trash lists them; history lists the clears', ov3.trash.filter((t) => [S5, S3].includes(t.hash)).length === 2 && ov3.history.filter((h) => h.action === 'cleared').length >= 2);
    check('purge needs the typed confirmation', (await post('/api/stash/purge', { repo: liveA, hashes: [S5], confirm: 'yes' }))[0] === 400);
    const rs2 = await post('/api/stash/restore', { repo: liveA, hash: S5 });
    check('restore over the API', rs2[0] === 200 && (await info.list(A.live)).stashes.some((s) => s.hash === S5));
    const pl = await (await fetch(base + '/api/stash/rework-plan?repo=' + encodeURIComponent(liveA) + '&hash=' + S5)).json();
    check('rework plan over the API', pl.taskId === 9100 && /alice|bob/i.test(pl.name), JSON.stringify(pl));
    check('foreign Origin -> 403', (await fetch(base + '/api/stash/clear', { method: 'POST', headers: { ...H, Origin: 'http://evil.example' }, body: '{}' })).status === 403);
  } finally { srv.kill(); }

  check('nothing was ever pushed to any origin', g(A.origin, 'for-each-ref') === originRefs);
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  setTimeout(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp */ } process.exit(fails ? 1 : 0); }, 500);
})().catch((e) => { console.error(e); process.exit(1); });
