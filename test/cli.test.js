const HUBROOT = require('path').resolve(__dirname, '..').replace(/\\/g, '/'); require('./_config')(); // neutral settings (HUB_LIVE_TESTS=1 uses your own settings and board for the checks marked live)
process.env.HUB_BACKUP_DIR = process.env.HUB_BACKUP_DIR || require('path').join(require('os').tmpdir(), 'hub-test-backups-' + process.pid); process.on('exit', () => { try { require('fs').rmSync(process.env.HUB_BACKUP_DIR, { recursive: true, force: true }); } catch { /* temp */ } }); // tests never write into your real backup folder
// Command-line tool, Claude session hooks and plan feedback, against a throwaway hub. Reads work items 8246 and 7136 from Azure DevOps (read-only).
const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const HUB = HUBROOT;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clitest-'));
const D = (n) => { const p = path.join(root, n); fs.mkdirSync(p, { recursive: true }); return p; };
const data = D('data'); const bk = D('backup'); const hookTmp = D('hooktmp'); const PORT = 4713;
const baseEnv = { ...process.env, HUB_DATA_DIR: data, HUB_BACKUP_DIR: bk, HUB_PORT: String(PORT), HUB_ONLY_EXTRA: '1', HUB_CLAUDE_BIN: HUB + '/test/stub-claude.js', STUB_MODE: 'ok', HUB_HOOK_TMP: hookTmp };
Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' });

let fails = 0;
const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!ok) fails++; };
const live = (n, ok, x) => (process.env.HUB_LIVE_TESTS ? check(n, ok, x) : console.log('SKIP ' + n + '  (needs a real Azure DevOps board: run with HUB_LIVE_TESTS=1)'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = (args, env = {}, input) => spawnSync(process.execPath, [HUB + '/bin/hub.js', ...args], { env: { ...baseEnv, ...env }, encoding: 'utf8', input, timeout: 30000 });
const hook = (name, payload, env = {}) => { const t0 = Date.now(); const r = spawnSync(process.execPath, [HUB + '/hooks/' + name + '.js'], { env: { ...baseEnv, ...env }, encoding: 'utf8', input: JSON.stringify(payload), timeout: 30000 }); r.ms = Date.now() - t0; return r; };
const startHub = () => spawn(process.execPath, [HUB + '/server.js'], { stdio: 'ignore', env: baseEnv });
const up = async () => { for (let i = 0; i < 80; i++) { try { await fetch('http://localhost:' + PORT + '/api/me'); return true; } catch { await sleep(250); } } return false; };
const notes = () => { const d = new DatabaseSync(path.join(data, 'hub.db'), { readOnly: true }); const r = d.prepare('SELECT task_id, section, body, author FROM notes WHERE deleted_at IS NULL ORDER BY id').all(); d.close(); return r; };
const post = (p, b) => fetch('http://localhost:' + PORT + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Request': '1' }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);

// a git folder on a task branch, and one that is not a task
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const taskDir = D('repo-8246'); g(taskDir, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(taskDir, 'a.txt'), 'x'); g(taskDir, 'add', '.'); g(taskDir, 'commit', '-q', '-m', 'init'); g(taskDir, 'checkout', '-q', '-b', 'dev/8246-menu-ui');
const plainDir = D('some-folder'); const folderTask = D('alice-7136');

(async () => {
  let srv = startHub(); check('hub starts', await up());

  console.log('--- command-line tool');
  let r = cli(['status']); check('status', r.status === 0 && /Hub is running/.test(r.stdout) && /wal/.test(r.stdout), r.stdout.trim().slice(0, 100));
  r = cli(['note', '8246', 'The menu is built in Portal; roles come from Security.', '--section', 'Findings', '--author', 'session abc']);
  check('note is added through the hub', r.status === 0 && /Note #\d+ added to task #8246/.test(r.stdout), r.stdout.trim() + r.stderr.trim());
  check('and stored with the author the tool passed', notes().some((n) => n.task_id === 8246 && n.author === 'session abc' && n.section === 'Findings'));
  r = cli(['note', '8246', 'x', '--section', 'Gossip']); check('an unknown section is refused', r.status === 1 && /Section must be one of/.test(r.stderr));
  r = cli(['note', '8246', '   ']); check('an empty note is refused', r.status === 1 && /empty/.test(r.stderr));
  r = cli(['note', 'abc', 'text']); check('a bad task number is refused', r.status === 1 && /task number/.test(r.stderr));
  r = cli(['note', '8246', '-', '--section', 'Decisions'], {}, 'Decision taken\nover several lines, from stdin');
  check('text can come from stdin', r.status === 0 && notes().some((n) => /several lines/.test(n.body) && n.section === 'Decisions'));
  r = cli(['note', '8246', 'x'.repeat(9000)]); check('an oversized note is refused by the hub', r.status === 1 && /8000|large/.test(r.stderr), r.stderr.trim().slice(0, 80));
  r = cli(['context', '8246']);
  live('context shows the task title and state from Azure DevOps', r.status === 0 && /Task #8246/.test(r.stdout) && /Billing Portal/i.test(r.stdout), r.stdout.split('\n')[0].slice(0, 100));
  check('context shows earlier notes with who wrote them', /roles come from Security/.test(r.stdout) && /session abc/.test(r.stdout) && /\[Findings\]/.test(r.stdout));
  check('context stays short enough to put in a session', r.stdout.length < 3800, String(r.stdout.length));
  r = cli(['plan']); check('plan works with no plan yet', r.status === 0 && /No plan/.test(r.stdout));
  r = cli(['frobnicate']); check('an unknown command is refused', r.status === 1);
  r = cli(['status'], { HUB_PORT: '4799' }); check('hub not running: a clear message and exit 1', r.status === 1 && /not running/.test(r.stderr));
  let c = await (await fetch('http://localhost:' + PORT + '/api/context/8246')).json();
  live('context API has notes, worktrees list, plan list and the Azure DevOps flag', Array.isArray(c.notes) && Array.isArray(c.worktrees) && Array.isArray(c.plan) && c.adoReachable === true && c.notes.length >= 2);

  console.log('--- hook: session start');
  r = hook('session-start', { session_id: 's-task', cwd: taskDir });
  check('prints the shared context for the task the branch names', r.status === 0 && /Test Hub: shared context for task #8246/.test(r.stdout) && /roles come from Security/.test(r.stdout), r.stdout.split('\n')[0]);
  check('and tells the session how to record notes', /hub\.js" note 8246/.test(r.stdout));
  check('and remembers when the session started', JSON.parse(fs.readFileSync(path.join(hookTmp, 's-task.json'), 'utf8')).taskId === 8246);
  r = hook('session-start', { session_id: 's-folder', cwd: folderTask });
  check('also finds the task from a worktree folder name', r.status === 0 && /task #7136/.test(r.stdout), r.stdout.split('\n')[0]);
  r = hook('session-start', { session_id: 's-none', cwd: plainDir });
  check('a folder with no task prints nothing', r.status === 0 && r.stdout === '');
  r = hook('session-start', { session_id: 's-down', cwd: taskDir }, { HUB_PORT: '4799' });
  check('hub not running: prints nothing, exits 0, does not hang', r.status === 0 && r.stdout === '' && r.ms < 8000, r.ms + ' ms');
  r = spawnSync(process.execPath, [HUB + '/hooks/session-start.js'], { env: baseEnv, encoding: 'utf8', input: 'not json at all' });
  check('garbage input never breaks a session', r.status === 0);

  console.log('--- hook: stop reminder (once per session, only when it is useful)');
  const marker = (id, o) => fs.writeFileSync(path.join(hookTmp, id + '.json'), JSON.stringify({ session: id, taskId: 7136, startedAt: Date.now() - 15 * 60000, cwd: folderTask, ...o }));
  marker('s-quiet', {}); r = hook('stop-reminder', { session_id: 's-quiet' });
  check('worked 15 min on a task, no note: asked to add one (exit 2)', r.status === 2 && /no hub note was added for task #7136/.test(r.stderr) && /hub\.js" note 7136/.test(r.stderr), r.stderr.split('\n')[0].slice(0, 90));
  r = hook('stop-reminder', { session_id: 's-quiet' }); check('asked only once per session', r.status === 0);
  marker('s-active', {}); r = hook('stop-reminder', { session_id: 's-active', stop_hook_active: true }); check('never loops when the stop was already blocked', r.status === 0);
  marker('s-young', { startedAt: Date.now() - 2 * 60000 }); r = hook('stop-reminder', { session_id: 's-young' }); check('a short session is left alone', r.status === 0);
  marker('s-notask', { taskId: null }); r = hook('stop-reminder', { session_id: 's-notask' }); check('a session with no task is left alone', r.status === 0);
  r = hook('stop-reminder', { session_id: 's-never-started' }); check('a session the start hook never saw is left alone', r.status === 0);
  marker('s-down2', {}); r = hook('stop-reminder', { session_id: 's-down2' }, { HUB_PORT: '4799' }); check('hub not running: the session may stop', r.status === 0 && r.ms < 8000);
  marker('s-wrote', {}); cli(['note', '7136', 'Checked the unlink request; fix is in the shipping profile service.', '--section', 'Analysis']);
  r = hook('stop-reminder', { session_id: 's-wrote' }); check('a note written during the session means no reminder', r.status === 0);

  console.log('--- hub not running: notes wait in the inbox');
  srv.kill(); await sleep(1500);
  r = cli(['note', '8246', 'Written while the hub was down.', '--section', 'Next step', '--author', 'session offline']);
  const inboxFiles = fs.readdirSync(path.join(data, 'inbox')).filter((f) => /^cli-.*\.json$/.test(f));
  check('the note is saved to the inbox folder, not lost', r.status === 0 && /inbox/.test(r.stdout) && inboxFiles.length === 1, r.stdout.split('\n')[0].slice(0, 80));
  check('the tool never opened the database to do it', !notes().some((n) => n.author === 'session offline'));
  srv = startHub(); await up();
  for (let i = 0; i < 30 && !notes().some((n) => n.author === 'session offline'); i++) await sleep(500);
  check('the hub adds it when it starts, as the same author', notes().some((n) => n.author === 'session offline' && n.section === 'Next step'));
  check('and files it as done', fs.readdirSync(path.join(data, 'inbox', 'done')).length >= 1);

  console.log('--- plan feedback: what was accepted, changed or removed');
  const prop = (o) => ({ taskId: null, confidence: 0.8, kind: 'task', engine: 'ai', draft: null, worktrees: [], ...o });
  [, c] = await post('/api/plan/save', { date: new Date().toLocaleDateString('en-CA'), rawText: 'x', items: [
    { text: 'accepted line', kind: 'task', taskId: 8246, proposal: prop({ taskId: 8246 }) },
    { text: 'changed line', kind: 'task', taskId: 7136, proposal: prop({ taskId: 8246, confidence: 0.55 }) },
    { text: 'removed line', kind: 'task', draft: { title: 'Portal: edited title', body: 'edited body' }, proposal: prop({ taskId: 8246, confidence: 0.9 }) },
    { text: 'added line', kind: 'task', taskId: 7136, proposal: prop({ taskId: null, confidence: 0 }) },
    { text: 'agreed no match', kind: 'task', draft: { title: 'Area: same title', body: 'same body' }, proposal: prop({ draft: { title: 'Area: same title', body: 'same body' } }) },
    { text: 'draft edited', kind: 'task', draft: { title: 'Area: new title', body: 'b' }, proposal: prop({ draft: { title: 'Area: old title', body: 'b' } }) },
    { text: 'rules line', kind: 'task', taskId: 8246, proposal: prop({ taskId: 8246, engine: 'rules', confidence: 0.5, worktrees: ['E:\\gone\\one', 'E:\\gone\\two'] }) },
    { text: 'no proposal at all', kind: 'task', taskId: 8246 }] });
  const fd = new DatabaseSync(path.join(data, 'hub.db'), { readOnly: true }); const fb = fd.prepare('SELECT * FROM plan_feedback ORDER BY id').all(); fd.close();
  const by = (t) => fb.find((x) => x.text === t);
  check('seven proposed lines were recorded (the one with no proposal was not)', fb.length === 7, String(fb.length));
  check('accepted', by('accepted line').outcome === 'accepted');
  check('changed to another work item', by('changed line').outcome === 'changed' && by('changed line').proposed_task === 8246 && by('changed line').final_task === 7136);
  check('removed (the match was dropped)', by('removed line').outcome === 'removed');
  check('added (the assistant found none, the user attached one)', by('added line').outcome === 'added');
  check('agreed there is no match, draft untouched', by('agreed no match').outcome === 'no-match-agreed' && by('agreed no match').draft_edited === 0);
  check('an edited draft is noticed', by('draft edited').draft_edited === 1);
  check('engine and confidence are kept', by('rules line').engine === 'rules' && by('rules line').confidence === 0.5);
  check('links the user did not keep are counted', by('rules line').wt_proposed === 2 && by('rules line').wt_kept === 0);

  srv.kill(); await sleep(800);
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { console.log('(left ' + root + ')'); }
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); console.log('temp ' + root); process.exit(1); });
