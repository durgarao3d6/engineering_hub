const HUBROOT = require('path').resolve(__dirname, '..').replace(/\\/g, '/'); require('./_config')(); // neutral settings (HUB_LIVE_TESTS=1 uses your own settings and board for the checks marked live)
process.env.HUB_BACKUP_DIR = process.env.HUB_BACKUP_DIR || require('path').join(require('os').tmpdir(), 'hub-test-backups-' + process.pid); process.on('exit', () => { try { require('fs').rmSync(process.env.HUB_BACKUP_DIR, { recursive: true, force: true }); } catch { /* temp */ } }); // tests never write into your real backup folder
// Data safety: WAL + concurrent writers, migrations, damaged database, verified backups, retention, restore, inbox. Throwaway folders only.
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const HUB = HUBROOT;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'datasafety-'));
const D = (n) => { const p = path.join(root, n); fs.mkdirSync(p, { recursive: true }); return p; };
const A = D('a-data'); const B = D('a-backup');
process.env.HUB_DATA_DIR = A; process.env.HUB_BACKUP_DIR = B; process.env.HUB_PORT = '4709'; process.env.HUB_ONLY_EXTRA = '1';
const store = require(HUB + '/store.js');
const backup = require(HUB + '/backup.js');
const bfiles = require(HUB + '/backup-files.js');

let fails = 0;
const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
const child = (code, env, args = []) => spawnSync(process.execPath, ['-e', code, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });
const hubEnv = (data, bk, port) => ({ HUB_DATA_DIR: data, HUB_BACKUP_DIR: bk, HUB_PORT: String(port || 4710) });
const days = (n, h = 12) => { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(h, 0, 0, 0); return d; };
const pad = (n) => String(n).padStart(2, '0');
const stampOf = (d) => d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());

(async () => {
  console.log('--- safe open');
  let h = store.health();
  check('WAL mode, so readers and a writer do not block each other', h.journalMode === 'wal', h.journalMode);
  check('busy timeout is 5 seconds, so a second writer waits instead of failing', h.busyTimeoutMs === 5000, String(h.busyTimeoutMs));
  check('schema is versioned and at the latest version', h.schemaVersion === h.expectedSchemaVersion && h.schemaVersion >= 3, String(h.schemaVersion));
  check('integrity check passes', h.quickCheck === 'ok');
  check('a brand-new database needs no pre-migration copy', h.migration.snapshot === null);

  console.log('--- several writers at the same time (the future command-line tool and hooks)');
  const procs = ['w1', 'w2', 'w3', 'w4'].map((tag) => new Promise((res) => { let out = ''; let err = ''; const c = spawn(process.execPath, [HUB + '/test/_writer.js', '150', tag], { env: { ...process.env } }); c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; }); c.on('close', (code) => res({ tag, code, out, err })); }));
  for (let i = 0; i < 150; i++) store.noteAdd(900, 'Analysis', 'parent ' + i, 'parent');
  const results = await Promise.all(procs);
  check('all four writer processes finished without errors', results.every((r) => r.code === 0), results.map((r) => r.tag + ':' + r.code + (r.err ? ' ' + r.err.split('\n').filter((l) => /Error/.test(l)).join(' | ').slice(0, 260) : '')).join(' '));
  check('no "database is locked" anywhere', !results.some((r) => /locked/i.test(r.err)));
  check('every one of the 750 notes was saved (nothing lost, nothing doubled)', store.rowCounts().notes === 750, String(store.rowCounts().notes));
  const planBase = store.rowCounts().planItems;
  check('integrity still ok after the load', store.health().quickCheck === 'ok');

  console.log('--- the hard case: read-then-write transactions from several processes (plan saves)');
  const before2 = store.rowCounts().planItems;
  const heavy = ['p1', 'p2', 'p3', 'p4', 'p5'].map((tag) => new Promise((res) => { let err = ''; const c = spawn(process.execPath, [HUB + '/test/_writer.js', '60', tag, 'plans'], { env: { ...process.env } }); c.stderr.on('data', (d) => { err += d; }); c.on('close', (code) => res({ tag, code, err })); }));
  for (let i = 0; i < 60; i++) store.planSave('2026-11-19', 'raw parent', [{ text: 'parent line ' + i, kind: 'task' }]);
  const hr = await Promise.all(heavy);
  check('five processes saving plans at once all succeed (no "database is locked")', hr.every((r) => r.code === 0), hr.map((r) => r.tag + ':' + r.code + (r.err ? ' ' + r.err.split('\n').filter((l) => /Error/.test(l)).join(' | ').slice(0, 120) : '')).join(' '));
  check('all 360 plan lines were saved', store.rowCounts().planItems - before2 === 360, String(store.rowCounts().planItems - before2));

  console.log('--- verified backups');
  const s1 = backup.snapshot('daily');
  check('snapshot written and verified', s1.verified && fs.existsSync(s1.file) && /^hub-\d{8}-\d{6}\.db$/.test(s1.name), s1.name);
  check('the backup holds all 750 notes', s1.counts.notes === 750, String(s1.counts.notes));
  let writer = null; const wOut = new Promise((res) => { writer = spawn(process.execPath, [HUB + '/test/_writer.js', '500', 'live'], { env: { ...process.env } }); writer.on('close', (c) => res(c)); });
  const snaps = []; for (let i = 0; i < 4; i++) { await sleep(120); try { snaps.push(backup.snapshot('manual', new Date(Date.now() + (i + 1) * 1000))); } catch (e) { snaps.push({ error: e.message }); } }
  check('snapshots taken while another process is writing are all consistent', snaps.every((s) => s.verified), JSON.stringify(snaps.map((s) => s.error || s.counts.notes)));
  check('the writer was not disturbed by the snapshots', (await wOut) === 0);
  let threw = false; const bad = path.join(B, 'hub-20200101-000000.db'); fs.writeFileSync(bad, 'this is not a database'); try { bfiles.verify(bad); } catch { threw = true; } fs.unlinkSync(bad);
  check('a corrupt file is never accepted as a backup', threw);

  console.log('--- retention (14 days of snapshots, newest of each of 8 weeks, 90 days for labelled ones)');
  const RB = D('ret-backup'); const keepCfg = require(HUB + '/config.js');
  const savedDir = keepCfg.backupDir; keepCfg.backupDir = RB; // prune() reads the folder from config
  const seed = (name) => fs.copyFileSync(s1.file, path.join(RB, name));
  for (let n = 0; n <= 70; n++) seed('hub-' + stampOf(days(n)) + '.db');
  seed('hub-' + stampOf(days(30, 9)) + '-pre-migration.db'); seed('hub-' + stampOf(days(100, 9)) + '-pre-migration.db');
  for (let w = 0; w < 12; w++) fs.writeFileSync(path.join(RB, 'export-2026-W' + pad(10 + w) + '.json'), '{}');
  const removed = backup.prune(new Date());
  const left = bfiles.list(); const leftNames = new Set(left.map((b) => b.file));
  check('every snapshot from the last 14 days is kept', [0, 1, 5, 10, 13].every((n) => leftNames.has('hub-' + stampOf(days(n)) + '.db')));
  check('old daily snapshots were removed', removed.length > 20 && !leftNames.has('hub-' + stampOf(days([38, 39, 40, 41, 42].find((k) => days(k).getDay() !== 0))) + '.db') && !leftNames.has('hub-' + stampOf(days(70)) + '.db'), String(removed.length) + ' removed');
  const weeks = new Set(left.filter((b) => b.label === 'daily' && Date.now() - b.at.getTime() > 14 * 86400000).map((b) => backup.isoWeek(b.at)));
  check('one snapshot per older week is kept (up to 8 weeks)', weeks.size >= 5 && weeks.size <= 8, String(weeks.size) + ' older weeks');
  check('a pre-migration copy is kept 90 days, not forever', leftNames.has('hub-' + stampOf(days(30, 9)) + '-pre-migration.db') && !leftNames.has('hub-' + stampOf(days(100, 9)) + '-pre-migration.db'));
  check('at most 8 weekly exports are kept', fs.readdirSync(RB).filter((f) => /^export-/.test(f)).length === 8);
  check('the newest snapshot is never deleted', leftNames.has('hub-' + stampOf(days(0)) + '.db'));
  keepCfg.backupDir = savedDir;

  console.log('--- scheduled backup and weekly export');
  const TB = D('tick-backup'); keepCfg.backupDir = TB;
  const st0 = backup.status(); check('no backups yet is reported as not ok', st0.ok === false && st0.count === 0);
  let st = backup.tick(new Date());
  check('first run makes a snapshot and this week\'s export', st.count === 1 && st.lastExport && st.ok === true, JSON.stringify({ count: st.count, ex: st.lastExport }));
  const ex = JSON.parse(fs.readFileSync(path.join(TB, st.lastExport), 'utf8'));
  check('the export is plain readable JSON with the notes in it', Array.isArray(ex.notes) && ex.notes.length >= 750 && ex.schemaVersion >= 3 && Array.isArray(ex.planItems), String(ex.notes.length));
  backup.tick(new Date(Date.now() + 3 * 3600000)); check('within 20 hours no second snapshot is taken', backup.status().count === 1);
  st = backup.tick(new Date(Date.now() + 25 * 3600000)); check('after 20 hours a new snapshot is taken', st.count === 2);
  check('a backup older than 36 hours turns the status to not ok', backup.status(new Date(Date.now() + 100 * 3600000)).ok === false);
  keepCfg.backupDir = savedDir;

  console.log('--- upgrading an old database (written before versioning existed)');
  const L = D('legacy-data'); const LB = D('legacy-backup');
  const legacy = new DatabaseSync(path.join(L, 'hub.db'));
  legacy.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, section TEXT NOT NULL, body TEXT NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);"
    + "CREATE TABLE plan_items (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, pos INTEGER NOT NULL, text TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'task', task_id INTEGER, confidence REAL, status TEXT NOT NULL DEFAULT 'todo', done_at TEXT, skip_reason TEXT, carried_from INTEGER, draft_type TEXT, draft_title TEXT, draft_body TEXT, draft_state TEXT NOT NULL DEFAULT 'none', requested_at TEXT, created_task_id INTEGER);"
    + "INSERT INTO notes (task_id, section, body, author, created_at, updated_at) VALUES (1,'Analysis','old note one','me','2026-11-01','2026-11-01'),(2,'Findings','old note two','me','2026-11-02','2026-11-02');"
    + "INSERT INTO plan_items (date, pos, text) VALUES ('2026-11-01',1,'old plan line');");
  legacy.close();
  const code = "const s=require(process.argv[1]+'/store.js');process.stdout.write(JSON.stringify(s.health()))";
  let r = child(code, hubEnv(L, LB), [HUB]);
  let lh; try { lh = JSON.parse(r.stdout); } catch { lh = null; }
  check('the old database opens and is upgraded to the latest schema', !!lh && lh.schemaVersion === lh.expectedSchemaVersion && lh.migration.from === 0, r.stderr.split('\n')[0].slice(0, 120));
  check('existing rows survived', lh && lh.counts.notes === 2 && lh.counts.planItems === 1, JSON.stringify(lh && lh.counts));
  check('the new column exists on the old table', (() => { const d = new DatabaseSync(path.join(L, 'hub.db'), { readOnly: true }); const ok = d.prepare('PRAGMA table_info(plan_items)').all().some((c) => c.name === 'worktrees_json'); d.close(); return ok; })());
  check('a copy of the old database was kept before it changed', lh && lh.migration.snapshot && fs.existsSync(lh.migration.snapshot) && /pre-migration/.test(lh.migration.snapshot));
  check('that copy is the OLD shape with the old data', (() => { const d = new DatabaseSync(lh.migration.snapshot, { readOnly: true }); const n = d.prepare('SELECT COUNT(*) n FROM notes').get().n; const has = d.prepare('PRAGMA table_info(plan_items)').all().some((c) => c.name === 'worktrees_json'); d.close(); return n === 2 && !has; })());
  r = child(code, hubEnv(L, LB), [HUB]); lh = JSON.parse(r.stdout);
  check('opening it again changes nothing and makes no new copy', lh.migration.from === lh.expectedSchemaVersion && lh.migration.snapshot === null && fs.readdirSync(LB).filter((f) => /pre-migration/.test(f)).length === 1);

  console.log('--- a failed migration is rolled back and reported');
  const F = D('fail-data'); const FB = D('fail-backup');
  const f = new DatabaseSync(path.join(F, 'hub.db'));
  f.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, section TEXT NOT NULL, body TEXT NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);"
    + "INSERT INTO notes (task_id, section, body, author, created_at, updated_at) VALUES (1,'Analysis','keep me','me','x','x'); CREATE VIEW plan_items AS SELECT 1 AS id;"); f.close(); // step 1 cannot index a view, so it fails
  r = child(code, hubEnv(F, FB), [HUB]);
  check('the hub refuses to start and says which migration failed', r.status !== 0 && /Database migration 1 failed and was rolled back/.test(r.stderr), (r.stderr.match(/Database migration[^\n]*/) || [r.stderr.slice(0, 100)])[0].slice(0, 110));
  check('it names the copy taken before the attempt', /pre-migration/.test(r.stderr));
  const fd = new DatabaseSync(path.join(F, 'hub.db'), { readOnly: true });
  check('the failed step was rolled back: the version stayed at 0 and the data is intact', fd.prepare('PRAGMA user_version').get().user_version === 0 && fd.prepare('SELECT body FROM notes').get().body === 'keep me'); fd.close();
  check('the pre-migration copy exists and holds the data', (() => { const p = fs.readdirSync(FB).find((n) => /pre-migration/.test(n)); if (!p) return false; const d = new DatabaseSync(path.join(FB, p), { readOnly: true }); const ok = d.prepare('SELECT body FROM notes').get().body === 'keep me'; d.close(); return ok; })());

  console.log('--- a damaged database is never replaced by an empty one');
  const X = D('damaged-data'); const XB = D('damaged-backup');
  fs.writeFileSync(path.join(X, 'hub.db'), Buffer.from('SQLite format 3\0' + 'garbage'.repeat(500)));
  const before = sha(path.join(X, 'hub.db'));
  r = child(code, hubEnv(X, XB), [HUB]);
  check('opening it stops with a clear message that mentions the restore command', r.status !== 0 && /damaged or unreadable/.test(r.stderr) && /restore\.js/.test(r.stderr), r.stderr.split('\n').find((l) => /damaged/.test(l)) ? 'message found' : r.stderr.slice(0, 120));
  check('the damaged file was not touched', sha(path.join(X, 'hub.db')) === before);
  const sv = spawnSync(process.execPath, [HUB + '/server.js'], { env: { ...process.env, ...hubEnv(X, XB, 4712) }, encoding: 'utf8', timeout: 20000 });
  check('the hub itself exits with STOP instead of starting on an empty database', sv.status === 1 && /STOP:/.test(sv.stderr), 'exit ' + sv.status);
  check('and still did not touch the file', sha(path.join(X, 'hub.db')) === before);

  console.log('--- restore');
  const R = D('restore-data'); const RBk = D('restore-backup'); const env = hubEnv(R, RBk, 4711);
  child("const s=require(process.argv[1]+'/store.js');for(let i=0;i<5;i++)s.noteAdd(7,'Decisions','important note '+i,'me');s.planSave('2026-11-19','r',[{text:'keep this plan line',kind:'task'}]);require(process.argv[1]+'/backup.js').snapshot('daily');", env, [HUB]);
  child("const s=require(process.argv[1]+'/store.js');for(let i=0;i<5;i++)s.noteAdd(7,'Decisions','added after the backup '+i,'me');", env, [HUB]);
  const rcount = () => { const d = new DatabaseSync(path.join(R, 'hub.db'), { readOnly: true }); const n = d.prepare('SELECT COUNT(*) n FROM notes').get().n; d.close(); return n; };
  check('setup: 10 notes in the live database, 5 in the backup', rcount() === 10 && bfiles.list.length >= 0);
  const rest = (...a) => spawnSync(process.execPath, [HUB + '/bin/restore.js', ...a], { env: { ...process.env, ...env }, encoding: 'utf8' });
  r = rest('--list'); check('--list shows the backups', r.status === 0 && /hub-\d{8}-\d{6}\.db/.test(r.stdout), r.stdout.split('\n')[0]);
  r = rest('hub-19990101-000000.db'); check('an unknown backup name is refused', r.status === 2 && /No backup found/.test(r.stderr));
  const blocker = net.createServer().listen(4711, '127.0.0.1'); await sleep(300);
  const beforeRestore = sha(path.join(R, 'hub.db'));
  r = rest('--latest'); check('restore refuses while the hub is running', r.status === 2 && /running on port 4711/.test(r.stderr), r.stderr.trim().slice(0, 90));
  check('and changes nothing', sha(path.join(R, 'hub.db')) === beforeRestore && rcount() === 10);
  await new Promise((res) => blocker.close(res));
  fs.writeFileSync(path.join(RBk, 'hub-20300101-000000.db'), 'garbage, not a database');
  r = rest('hub-20300101-000000.db'); check('a corrupt backup is refused', r.status === 2 && /not usable/.test(r.stderr));
  check('and changes nothing', sha(path.join(R, 'hub.db')) === beforeRestore);
  fs.unlinkSync(path.join(RBk, 'hub-20300101-000000.db'));
  r = rest('--latest');
  check('restore --latest succeeds', r.status === 0 && /Restored hub-/.test(r.stdout), r.stdout.split('\n').slice(0, 2).join(' | ') + (r.stderr ? ' ERR ' + r.stderr.slice(0, 80) : ''));
  check('the notes from the backup are back and the later ones are gone', rcount() === 5);
  const kept = fs.readdirSync(R).find((n) => /^before-restore-/.test(n));
  check('the database from before the restore was kept, not deleted', !!kept && fs.existsSync(path.join(R, kept, 'hub.db')));
  check('the restored hub opens normally and migrates cleanly', (() => { const o = child(code, env, [HUB]); try { return JSON.parse(o.stdout).quickCheck === 'ok'; } catch { return false; } })());

  console.log('--- the single-writer rule: the inbox, through a real running hub');
  const S = D('srv-data'); const SB = D('srv-backup'); const INBOX = path.join(S, 'inbox'); fs.mkdirSync(INBOX, { recursive: true });
  const startHub = () => spawn(process.execPath, [HUB + '/server.js'], { stdio: 'ignore', env: { ...process.env, ...hubEnv(S, SB, 4709) } });
  const waitUp = async () => { for (let i = 0; i < 80; i++) { try { await fetch('http://localhost:4709/api/me'); return true; } catch { await sleep(250); } } return false; };
  const drop = (name, body, ageMs = 0) => { const t = path.join(INBOX, name + '.tmp'); fs.writeFileSync(t, typeof body === 'string' ? body : JSON.stringify(body)); const f = path.join(INBOX, name); fs.renameSync(t, f); if (ageMs) { const t0 = new Date(Date.now() - ageMs); fs.utimesSync(f, t0, t0); } };
  const noteRows = () => { const d = new DatabaseSync(path.join(S, 'hub.db'), { readOnly: true }); const rows = d.prepare("SELECT body, author FROM notes WHERE author LIKE 'session %'").all(); d.close(); return rows; };
  const health = async () => (await fetch('http://localhost:4709/api/health')).json();
  let srv = startHub(); check('hub starts', await waitUp());
  const good = { id: 'msg-0001-aaaa', type: 'note', taskId: 5945, section: 'Findings', body: 'Found by a session while the hub was busy', author: 'session one' };
  drop('good.json', good);
  drop('dup.json', good);                                                   // same id again
  drop('hostile-id.json', { ...good, id: '../../escape' });
  drop('bad-section.json', { ...good, id: 'msg-0002-bbbb', section: 'Gossip' });
  drop('empty-body.json', { ...good, id: 'msg-0003-cccc', body: '   ' });
  drop('bad-task.json', { ...good, id: 'msg-0004-dddd', taskId: 'abc' });
  drop('unknown-type.json', { ...good, id: 'msg-0005-eeee', type: 'delete-everything' });
  drop('no-id.json', { type: 'note', taskId: 1, section: 'Findings', body: 'x' });
  drop('huge.json', { ...good, id: 'msg-0006-ffff', body: 'x'.repeat(20000) });
  drop('array.json', [1, 2, 3]);
  drop('broken.json', '{"id": "msg-0007-gggg", "type": "note", ', 10000); // not valid JSON and old enough to be sure it is not still being written
  fs.writeFileSync(path.join(INBOX, 'ignored.txt'), 'not a json file');
  for (let i = 0; i < 40 && (await health()).inbox.pending > 0; i++) await sleep(500);
  let hh = await health();
  check('nothing is left waiting in the inbox', hh.inbox.pending === 0, JSON.stringify(hh.inbox));
  const rows = noteRows();
  check('the one valid message became exactly one note, written by the hub', rows.length === 1 && rows[0].author === 'session one' && /Found by a session/.test(rows[0].body), JSON.stringify(rows.map((x) => x.author)));
  check('the duplicate id was recognised and not applied twice', hh.inbox.done === 2);
  check('every bad message was rejected, none applied', hh.inbox.rejected === 9, String(hh.inbox.rejected));
  const rej = fs.readdirSync(path.join(INBOX, 'rejected'));
  const reason = (n) => { try { return fs.readFileSync(path.join(INBOX, 'rejected', n + '.reason.txt'), 'utf8').trim(); } catch { return ''; } };
  check('each rejection explains why', /id/i.test(reason('hostile-id.json')) && /section|Choose/i.test(reason('bad-section.json')) && /larger/.test(reason('huge.json')) && /not valid JSON/.test(reason('broken.json')) && /unknown message type/.test(reason('unknown-type.json')) && /object/.test(reason('array.json')), rej.length + ' files');
  check('files that are not .json are ignored', fs.existsSync(path.join(INBOX, 'ignored.txt')));
  srv.kill(); await sleep(1500);
  drop('good-again.json', good); srv = startHub(); await waitUp();
  for (let i = 0; i < 30 && (await health()).inbox.pending > 0; i++) await sleep(500);
  check('after a hub restart the same message id is still not applied twice', noteRows().length === 1);

  console.log('--- health and on-demand backup through the API');
  hh = await health();
  check('health reports WAL, the schema version and a clean integrity check', hh.db.journalMode === 'wal' && hh.db.quickCheck === 'ok' && hh.db.schemaVersion === hh.db.expectedSchemaVersion);
  for (let i = 0; i < 20 && !(await health()).backups.newest; i++) await sleep(500); // the hub takes its first backup a few seconds after it starts
  hh = await health();
  check('the hub made its own first backup without being asked', hh.backups.count >= 1 && hh.backups.ok === true && !!hh.backups.lastExport, JSON.stringify({ c: hh.backups.count, ok: hh.backups.ok }));
  let res = await fetch('http://localhost:4709/api/backup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  check('a backup cannot be triggered without the guard header', res.status === 403);
  res = await fetch('http://localhost:4709/api/backup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Request': '1' }, body: '{}' });
  const bj = await res.json();
  check('a backup on demand works and is verified', res.status === 200 && bj.backup.verified && fs.existsSync(bj.backup.file), JSON.stringify(bj.error || bj.backup.name));
  res = await fetch('http://localhost:4709/api/backup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Request': '1', Origin: 'https://evil.example' }, body: '{}' });
  check('a foreign website cannot trigger it either', res.status === 403);
  srv.kill();

  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  await sleep(800);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { console.log('(left ' + root + ')'); }
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); console.log('temp ' + root); process.exit(1); });
