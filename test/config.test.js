// Settings: defaults, validation, repository discovery, branch prefixes, running without Azure DevOps, and the setup tool.
// Every case runs in a fresh process with its own temporary settings file; nothing of yours is read or written.
const HUBROOT = require('path').resolve(__dirname, '..').replace(/\\/g, '/'); require('./_config')();
const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgtest-'));
let fails = 0;
const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!ok) fails++; };
const mk = (...p) => { const d = path.join(root, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const repo = (...p) => { const d = mk(...p); fs.mkdirSync(path.join(d, '.git')); return d; };
const write = (name, obj) => { const f = path.join(root, name); fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); return f; };
function dump(file, probe, env) {
  const r = spawnSync(process.execPath, [path.join(__dirname, '_cfgdump.js'), probe || ''], { encoding: 'utf8', env: { ...process.env, HUB_CONFIG: file, HUB_ONLY_EXTRA: '', HUB_EXTRA_CLONES: '', HUB_DATA_DIR: '', HUB_BACKUP_DIR: '', HUB_PORT: '', ...(env || {}) } });
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { error: 'no output: ' + r.stderr }; }
}

(async () => {
  console.log('--- defaults and problems');
  let c = dump(path.join(root, 'nope.json'));
  check('a missing settings file is not fatal and says what to do', !c.error && !c.configured && c.problems.some((p) => /does not exist/.test(p)), JSON.stringify(c.problems));
  c = dump(write('empty.json', '{}'));
  check('an empty file gives safe defaults (no board, prefix "task", no repositories)', !c.error && c.configured && c.adoConfigured === false && c.prefix === 'task' && c.clones.length === 0 && c.title === 'Engineering Hub' && c.brand === 'Hub' && c.port === 4700, JSON.stringify(c).slice(0, 200));
  check('default co-worker names are neutral', c.names.join() === 'Alice,Bob,Carol,Dave,Erin,Frank,Grace,Heidi');
  c = dump(write('bad.json', '{ nope'));
  check('a file that is not JSON stops with a clear message', /not valid JSON/.test(c.error || ''), c.error);
  c = dump(write('arr.json', '[1]'));
  check('a file that is not an object stops with a clear message', /must contain a JSON object/.test(c.error || ''), c.error);
  c = dump(write('typo.json', { projeckt: 'x' }));
  check('an unknown setting is reported as a possible typo', c.problems.some((p) => /Unknown setting "projeckt"/.test(p)));

  console.log('--- Azure DevOps settings');
  c = dump(write('ado1.json', { organization: 'https://dev.azure.com/acme/', project: 'Shop' }));
  check('organization and project switch the board on (trailing slash removed)', c.adoConfigured === true && c.org === 'https://dev.azure.com/acme' && c.project === 'Shop' && c.problems.length === 0, JSON.stringify(c.problems));
  c = dump(write('ado2.json', { organization: 'https://dev.azure.com/acme' }));
  check('organization without a project is reported and keeps the board off', c.adoConfigured === false && c.problems.some((p) => /project is missing/.test(p)));
  c = dump(write('ado3.json', { organization: 'https://example.com/acme', project: 'Shop' }));
  check('an address that is not dev.azure.com/<name> is reported and keeps the board off', c.adoConfigured === false && c.problems.some((p) => /dev\.azure\.com/.test(p)));
  c = dump(write('ado4.json', { organization: 'https://dev.azure.com/acme', project: 'Shop', azureDevOps: { enabled: false } }));
  check('azureDevOps.enabled=false keeps the board off even with an organization', c.adoConfigured === false);

  console.log('--- branch prefixes become safe patterns');
  const probes = 'dev/1234-fix|dev/bug_5555_x|feat/team/7777-a|my.team/8888-b|myXteam/8888-b|devx/1234-no|dev/12-short|main';
  c = dump(write('p1.json', { branchPrefix: 'dev' }), probes);
  check('prefix "dev": matches dev/<id> and dev/<type>_<id>, not look-alikes or short ids', c.branchMatches.join() === '1234,5555,,,,,,', c.branchMatches.join('|'));
  c = dump(write('p2.json', { branchPrefix: 'feat/team' }), probes);
  check('a prefix with a slash works', c.branchMatches[2] === '7777' && c.branchMatches[0] === null, c.branchMatches.join('|'));
  c = dump(write('p3.json', { branchPrefix: 'my.team' }), probes);
  check('a dot in the prefix is literal, not "any character"', c.branchMatches[3] === '8888' && c.branchMatches[4] === null, c.branchMatches.join('|'));
  c = dump(write('p4.json', { branchPrefix: 'bad prefix!' }));
  check('a prefix that cannot be a branch name is reported', c.problems.some((p) => /branchPrefix/.test(p)));

  console.log('--- finding repositories');
  const rA = repo('scan', 'alpha'); const rB = repo('scan', 'group', 'beta'); mk('scan', 'plain-folder', 'x');
  const wtLike = mk('scan', 'alpha-worktree'); fs.writeFileSync(path.join(wtLike, '.git'), 'gitdir: ../alpha/.git/worktrees/x'); // a worktree has a .git FILE
  repo('scan', 'node_modules', 'pkg'); repo('scan', 'deep', 'a', 'b', 'c', 'toodeep');
  c = dump(write('scan.json', { scanFolders: [path.join(root, 'scan')] }));
  const found = c.clones.flatMap(([, , cl]) => Object.values(cl)).sort();
  check('scanFolders finds real clones (nested too) and nothing else', found.join('|') === [rA, rB].sort().join('|'), found.join('|'));
  check('worktrees, node_modules and repositories deeper than 3 levels are not clones', !found.includes(wtLike) && !found.some((p) => /node_modules|toodeep/.test(p)));
  check('keys are the folder names', c.clones.map(([k]) => k).sort().join() === 'alpha,beta');
  c = dump(write('scan2.json', { scanFolders: [path.join(root, 'missing-folder')] }));
  check('a scan folder that does not exist is reported', c.problems.some((p) => /does not exist/.test(p)));
  c = dump(write('scan3.json', { scanFolders: [mk('empty-scan')] }));
  check('a scan folder with no repositories is reported', c.problems.some((p) => /no git repositories/.test(p)));
  const rC = repo('other', 'gamma'); const rC2 = repo('other2', 'gamma');
  c = dump(write('clones.json', { clones: [{ key: 'gamma', path: rC, layer: 'ui', azdoRepo: 'Gamma' }, { key: 'gamma', path: rC2, layer: 'ui' }, { key: 'gamma', path: rC2, layer: 'ui' }, { path: '' }] }));
  check('explicit clones: same key and layer gets a suffix, a repeated path is ignored, an entry without a path is reported', c.clones.map(([k]) => k).sort().join() === 'gamma,gamma-2' && c.clones.find(([k]) => k === 'gamma')[1] === 'Gamma' && c.problems.some((p) => /no path/.test(p)), JSON.stringify(c.clones));
  const mapFile = write('map.json', { org: 'x', repos: { svc: { azdoRepo: 'Svc', clones: { ui: null, backend: rA } }, web: { clones: { ui: rB } } } });
  c = dump(write('mapcfg.json', { repoMapFile: mapFile }));
  check('repoMapFile (the repo-map format) still works, null clones skipped', c.clones.length === 2 && c.clones.find(([k]) => k === 'svc')[2].backend === rA, JSON.stringify(c.clones));
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  c = dump(write('sub/rel.json', { scanFolders: ['../scan'], dataDir: 'mydata', backupDir: '../bk', learningsDir: 'lessons' }));
  check('relative paths are relative to the settings file', c.clones.length === 2 && c.dataDir === path.join(root, 'sub', 'mydata') && c.backupDir === path.join(root, 'bk') && c.learningsDir === path.join(root, 'sub', 'lessons'), JSON.stringify([c.dataDir, c.backupDir]));
  c = dump(write('only.json', { scanFolders: [path.join(root, 'scan')] }), '', { HUB_ONLY_EXTRA: '1', HUB_EXTRA_CLONES: rC });
  check('the test switches HUB_ONLY_EXTRA and HUB_EXTRA_CLONES still work', c.clones.length === 0 && c.extra.join() === rC);
  c = dump(write('env.json', { port: 4801, dataDir: 'd1', backupDir: 'b1' }), '', { HUB_PORT: '4802', HUB_DATA_DIR: path.join(root, 'envdata'), HUB_BACKUP_DIR: path.join(root, 'envbk') });
  check('environment variables win over the file', c.port === 4802 && c.dataDir === path.join(root, 'envdata') && c.backupDir === path.join(root, 'envbk'));
  c = dump(write('ws.json', { scanFolders: [path.join(root, 'scan')] }));
  check('workspace root defaults to the common parent of the repositories; worktrees go beside it', c.workspaceRoot === path.join(root, 'scan') && c.worktreeRoot === path.join(root, 'scan', 'wt'), c.workspaceRoot);

  console.log('--- automated pull requests and names');
  c = dump(write('bot.json', { botPullRequests: { repos: ['Tools'], titlePatterns: ['^Bump ', '(unclosed'] }, coWorkerNames: ['Zed', 'Yan'] }));
  check('a bad title pattern is reported and ignored, good ones still apply', c.problems.some((p) => /not a valid pattern/.test(p)) && c.bot.repos.join() === 'Tools' && c.bot.a === false, JSON.stringify(c.bot));
  check('co-worker names come from the file', c.names.join() === 'Zed,Yan');
  c = dump(write('bot2.json', '{}'));
  check('default automated-PR patterns catch package updates but not normal work', c.bot.a === true && c.bot.b === false);

  console.log('--- running without Azure DevOps (a real server, one scanned repository)');
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const live = path.join(root, 'srv', 'myrepo'); fs.mkdirSync(live, { recursive: true });
  git(live, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(live, 'a.txt'), 'a\n'); git(live, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'add', '.'); git(live, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init');
  const port = 4721;
  const srv = spawn(process.execPath, [HUBROOT + '/server.js'], { stdio: 'ignore', env: { ...process.env, HUB_CONFIG: write('srv.json', { title: 'My Hub', brand: 'My Hub', scanFolders: [path.join(root, 'srv')], branchPrefix: 'wip' }), HUB_PORT: String(port), HUB_DATA_DIR: path.join(root, 'srvdata'), HUB_ONLY_EXTRA: '', HUB_EXTRA_CLONES: '' } });
  const base = 'http://localhost:' + port;
  try {
    for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/me'); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
    const me = await (await fetch(base + '/api/me')).json();
    check('/api/me carries the settings the page needs', me.title === 'My Hub' && me.adoConfigured === false && me.branchPrefix === 'wip' && me.organization === '' && Array.isArray(me.problems), JSON.stringify({ t: me.title, a: me.adoConfigured, p: me.branchPrefix }));
    const wt = await (await fetch(base + '/api/worktrees')).json();
    check('worktrees work without any Azure DevOps settings', wt.worktrees.length === 1 && wt.worktrees[0].isMain && wt.worktrees[0].repoKey === 'myrepo', JSON.stringify(wt.worktrees.map((w) => w.repoKey)));
    const tk = await (await fetch(base + '/api/tasks')).json();
    check('the task board answers "not set up" instead of failing', tk.ado.ok === false && tk.ado.notConfigured === true && Array.isArray(tk.tasks), JSON.stringify(tk.ado));
    const so = await (await fetch(base + '/api/stash/overview')).json();
    check('stashes work too', so.total === 0 && Array.isArray(so.repos));
    const us = await fetch(base + '/api/usage'); check('the usage page does not break when there is no usage log', us.status === 200, String(us.status));
    const page = await (await fetch(base + '/')).text();
    const uiSrc = ['app.js', 'stash.js', 'index.html'].map((f) => fs.readFileSync(HUBROOT + '/ui/' + f, 'utf8')).join('\n');
    check('the page source names no organization and no drive-letter folders (they come from the settings)', !/dev\.azure\.com\/[A-Za-z]/.test(page + uiSrc) && !/\b[A-Za-z]:\\\\[A-Za-z]/.test(uiSrc));
    const h = await (await fetch(base + '/api/health')).json();
    check('data went to the configured folder only', h.db.file.startsWith(path.join(root, 'srvdata')));
  } finally { srv.kill(); }

  console.log('--- the setup tool');
  const setup = (...a) => spawnSync(process.execPath, [HUBROOT + '/bin/setup.js', ...a], { encoding: 'utf8', env: { ...process.env, HUB_CONFIG: '' } });
  const out1 = path.join(root, 'made', 'hub.config.json'); fs.mkdirSync(path.dirname(out1), { recursive: true });
  let r = setup('--out', out1, '--scan', path.join(root, 'scan') + ';' + path.join(root, 'srv'), '--org', 'https://dev.azure.com/acme', '--project', 'Shop', '--prefix', 'dev', '--name', 'Sam');
  const made = fs.existsSync(out1) ? JSON.parse(fs.readFileSync(out1, 'utf8')) : {};
  check('--scan writes a settings file with what was given', made.organization === 'https://dev.azure.com/acme' && made.project === 'Shop' && made.branchPrefix === 'dev' && made.userName === 'Sam' && made.scanFolders.length === 2, r.stdout.split('\n')[0]);
  const before = fs.readFileSync(out1, 'utf8');
  r = setup('--out', out1, '--scan', path.join(root, 'scan'));
  check('it never overwrites an existing file without --force', r.status === 1 && /already exists/.test(r.stdout) && fs.readFileSync(out1, 'utf8') === before);
  r = setup('--out', out1, '--scan', path.join(root, 'scan'), '--force');
  check('--force replaces it and keeps the old one as .bak', fs.existsSync(out1 + '.bak') && fs.readFileSync(out1 + '.bak', 'utf8') === before && JSON.parse(fs.readFileSync(out1, 'utf8')).scanFolders.length === 1);
  const out2 = path.join(root, 'made', 'fromMap.json');
  r = setup('--out', out2, '--from-repo-map', mapFile, '--name', 'Sam');
  const m2 = fs.existsSync(out2) ? JSON.parse(fs.readFileSync(out2, 'utf8')) : {};
  check('--from-repo-map reads the map and points at it with a relative path', m2.repoMapFile === '../map.json' && m2.userName === 'Sam', JSON.stringify(m2));
  r = setup('--out', path.join(root, 'made', 'none.json'));
  check('without any folder it explains what is needed and writes nothing', !fs.existsSync(path.join(root, 'made', 'none.json')) && /Engineering Hub setup|Tell me where/.test(r.stdout));
  r = spawnSync(process.execPath, [HUBROOT + '/bin/setup.js', '--check'], { encoding: 'utf8', env: { ...process.env, HUB_CONFIG: write('chk.json', { scanFolders: [path.join(root, 'scan')] }), HUB_PORT: '4722', HUB_DATA_DIR: path.join(root, 'chkdata') } });
  check('--check runs, reports each item and prints the hook settings with this folder\'s real path', /Node\.js 24/.test(r.stdout) && /Repositories +2 found/.test(r.stdout) && /session-start\.js/.test(r.stdout) && r.stdout.includes(HUBROOT + '/hooks/session-start.js'), r.stdout.split('\n').slice(0, 4).join(' | '));
  check('--check never created the data folder', !fs.existsSync(path.join(root, 'chkdata')));

  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  setTimeout(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp */ } process.exit(fails ? 1 : 0); }, 800);
})().catch((e) => { console.error(e); process.exit(1); });
