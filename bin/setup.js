#!/usr/bin/env node
'use strict';
// Creates hub.config.json and checks that the hub can run on this machine. Never overwrites an existing settings file
// (unless you pass --force) and never touches the hub's data. The check only reads.
//
//   node bin/setup.js --scan "C:\work\repos" --org https://dev.azure.com/<org> --project "<name>" --prefix dev --name "Your name"
//   node bin/setup.js --from-repo-map ..\.claude\repo-map.json --name "Your name"
//   node bin/setup.js --check
const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf('--' + n); return i < 0 ? undefined : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const out = (s) => process.stdout.write(s + '\n');

const HELP = `Engineering Hub setup

Create the settings file:
  node bin/setup.js --scan "<folder>[;<folder>]" [--org https://dev.azure.com/<org> --project "<project>"] [--prefix dev] [--name "Your name"] [--title "..."]
  node bin/setup.js --from-repo-map <repo-map.json> [--name "Your name"]     (an existing repo map: org, project, prefix and clones are read from it)
    --scan      folders that contain your git repositories (found up to 3 levels deep)
    --org       Azure DevOps organization address; leave out to run without the board
    --prefix    task branch prefix: branches are <prefix>/<work item id>-<short name> (default: task)
    --out       settings file to write (default: hub.config.json next to server.js)
    --force     replace an existing settings file (the old one is kept as .bak)
Check this machine (read-only):
  node bin/setup.js --check
`;

function run(bin, a, timeout = 15000) {
  return new Promise((resolve) => {
    const [b, pre] = process.platform === 'win32' && !/^(git|node)$/.test(bin) ? ['cmd', ['/c', bin]] : [bin, []];
    execFile(b, [...pre, ...a], { timeout, windowsHide: true }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || '').trim() }));
  });
}

function write() {
  const outFile = path.resolve(flag('out') && flag('out') !== true ? flag('out') : path.join(ROOT, 'hub.config.json'));
  if (fs.existsSync(outFile) && !flag('force')) { out('Not changed: ' + outFile + ' already exists. Edit it by hand, or run again with --force (the old file is kept as .bak).'); process.exit(1); }
  const cfg = { _note: 'Created by bin/setup.js. Every setting is listed in hub.config.example.json. Relative paths are relative to this file.' };
  const set = (k, v) => { if (v && v !== true) cfg[k] = v; };
  const mapFile = flag('from-repo-map');
  if (mapFile && mapFile !== true) {
    let m; try { m = JSON.parse(fs.readFileSync(path.resolve(mapFile), 'utf8')); } catch (e) { out('Could not read ' + mapFile + ': ' + e.message); process.exit(1); }
    set('organization', m.org); set('project', m.project); set('branchPrefix', m.branchPrefix);
    cfg.repoMapFile = path.relative(path.dirname(outFile), path.resolve(mapFile)).replace(/\\/g, '/');
  }
  set('organization', flag('org')); set('project', flag('project')); set('branchPrefix', flag('prefix')); set('userName', flag('name')); set('title', flag('title'));
  const scan = flag('scan');
  if (scan && scan !== true) cfg.scanFolders = scan.split(';').map((s) => s.trim()).filter(Boolean);
  if (!cfg.scanFolders && !cfg.repoMapFile) { out('Tell me where your repositories are: --scan "<folder>" (or --from-repo-map <file>). Run with --help for details.'); process.exit(1); }
  if (fs.existsSync(outFile)) fs.copyFileSync(outFile, outFile + '.bak');
  fs.writeFileSync(outFile, JSON.stringify(cfg, null, 2) + '\n');
  out('Wrote ' + outFile);
  return outFile;
}

async function check() {
  const rows = []; let failed = 0;
  const add = (level, name, detail) => { rows.push([level, name, detail]); if (level === 'FAIL') failed++; };
  const major = Number(process.versions.node.split('.')[0]);
  let sqlite = true; try { require('node:sqlite'); } catch { sqlite = false; }
  add(major >= 24 && sqlite ? 'PASS' : 'FAIL', 'Node.js 24 or newer with built-in SQLite', 'found ' + process.version + (sqlite ? '' : ', but node:sqlite is missing'));
  const git = await run('git', ['--version']);
  add(git.ok ? 'PASS' : 'FAIL', 'Git', git.ok ? git.out : 'git was not found on the PATH');
  let cfg;
  try { cfg = require('../config'); } catch (e) { add('FAIL', 'Settings file', e.message); }
  if (cfg) {
    add(cfg.configFile ? 'PASS' : 'WARN', 'Settings file', cfg.configFile || 'none yet (create one with --scan)');
    cfg.problems.forEach((p) => add('WARN', 'Setting', p));
    const { cloneList } = require('../collectors/worktrees');
    const clones = cloneList(); const missing = clones.filter((c) => !fs.existsSync(c.path));
    add(clones.length ? 'PASS' : 'FAIL', 'Repositories', clones.length + ' found' + (missing.length ? ', ' + missing.length + ' listed but missing on disk (e.g. ' + missing[0].path + ')' : ''));
    const parentOk = (p) => fs.existsSync(p) || fs.existsSync(path.dirname(p));
    add(parentOk(cfg.dataDir) ? 'PASS' : 'FAIL', 'Data folder', cfg.dataDir + (fs.existsSync(cfg.dataDir) ? ' (exists, your data stays here)' : ' (will be created)'));
    add(parentOk(cfg.backupDir) ? 'PASS' : 'WARN', 'Backup folder', cfg.backupDir);
    const busy = await new Promise((r) => { const s = net.createServer(); s.once('error', () => r(true)); s.once('listening', () => s.close(() => r(false))); s.listen(cfg.port, '127.0.0.1'); });
    let running = false;
    if (busy) { try { const h = await fetch('http://127.0.0.1:' + cfg.port + '/api/health', { signal: AbortSignal.timeout(2000) }); running = h.ok; } catch { /* not the hub */ } }
    add(busy && !running ? 'WARN' : 'PASS', 'Port ' + cfg.port, busy ? (running ? 'the hub is already running here' : 'in use by another program: change "port" in the settings') : 'free');
    if (cfg.adoConfigured) {
      const az = await run('az', ['--version'], 30000);
      add(az.ok ? 'PASS' : 'WARN', 'Azure CLI', az.ok ? az.out.split('\n')[0] : 'not found: install it, then run az login (the board needs it)');
      if (az.ok) {
        try { const { ado, BASE } = require('../collectors/ado'); const me = (await ado(BASE + '/_apis/connectionData?api-version=7.1-preview')).authenticatedUser; add('PASS', 'Azure DevOps sign-in', 'read-only check passed for ' + (me.providerDisplayName || 'your account')); }
        catch (e) { add('WARN', 'Azure DevOps sign-in', e.message + (e.code === 'AUTH' ? '' : ' (the board will be empty until this works)')); }
      }
    } else add('PASS', 'Azure DevOps', 'not configured: worktrees, stashes, notes, plan and sessions still work (add organization and project to enable the board)');
    const cl = await run('claude', ['--version'], 20000); // the planner needs it; opening ai.js here would also open the database, and this check must not
    add(cl.ok ? 'PASS' : 'WARN', 'Claude CLI (morning planner)', cl.ok ? 'found ' + cl.out.split('\n')[0] : 'not found: the planner falls back to matching without AI');
  }
  const w = Math.max(...rows.map((r) => r[1].length));
  for (const [l, n, d] of rows) out((l === 'PASS' ? ' ok   ' : l === 'WARN' ? ' note ' : ' FAIL ') + n.padEnd(w + 2) + d);
  out('\nTo start: node "' + path.join(ROOT, 'server.js') + '"   then open http://localhost:' + (cfg ? cfg.port : 4700));
  out('Optional, to share task notes with Claude sessions, add this to your Claude Code settings.json hooks:');
  const hook = (f) => 'node ' + path.join(ROOT, 'hooks', f).replace(/\\/g, '/');
  out(JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: hook('session-start.js'), timeout: 8 }] }], Stop: [{ hooks: [{ type: 'command', command: hook('stop-reminder.js'), timeout: 8 }] }] } }, null, 2));
  return failed;
}

(async () => {
  if (flag('help') || (!args.length) || !(flag('scan') || flag('from-repo-map') || flag('check'))) { out(HELP); return; }
  if (flag('scan') || flag('from-repo-map')) write();
  if (flag('check') || flag('scan') || flag('from-repo-map')) {
    if (!flag('check')) out('');
    process.exitCode = (await check()) ? 1 : 0;
  }
})().catch((e) => { out('Setup stopped: ' + e.message); process.exit(1); });
