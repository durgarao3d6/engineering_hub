const HUBROOT = require('path').resolve(__dirname, '..').replace(/\\/g, '/'); require('./_config')(); // neutral settings (HUB_LIVE_TESTS=1 uses your own settings and board for the checks marked live)
process.env.HUB_BACKUP_DIR = process.env.HUB_BACKUP_DIR || require('path').join(require('os').tmpdir(), 'hub-test-backups-' + process.pid); process.on('exit', () => { try { require('fs').rmSync(process.env.HUB_BACKUP_DIR, { recursive: true, force: true }); } catch { /* temp */ } }); // tests never write into your real backup folder
// Notes + task detail API on a throwaway hub (port 4703, temp data dir, no repos). Reads real work item 8246 from Azure DevOps (read-only).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notetest-'));
const srv = spawn('node', [HUBROOT + '/server.js'], { env: { ...process.env, HUB_PORT: '4703', HUB_DATA_DIR: dir, HUB_ONLY_EXTRA: '1' }, stdio: 'ignore' });
const base = 'http://localhost:4703';
const H = { 'Content-Type': 'application/json', 'X-Hub-Request': '1' };
const post = (p, b, h) => fetch(base + p, { method: 'POST', headers: h || H, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);
const get = (p) => fetch(base + p).then(async (r) => [r.status, await r.json()]);
let fails = 0;
const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!ok) fails++; };
const live = (n, ok, x) => (process.env.HUB_LIVE_TESTS ? check(n, ok, x) : console.log('SKIP ' + n + '  (needs a real Azure DevOps board: run with HUB_LIVE_TESTS=1)'));
(async () => {
  for (let i = 0; i < 40; i++) { try { await fetch(base + '/api/me'); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  let [s, j] = await get('/api/tasks/8246');
  check('detail 200 with sections', s === 200 && j.sections.length === 5);
  live('detail loaded from Azure DevOps', !!j.detail && j.detail.id === 8246, j.error || (j.detail && j.detail.type + ' | ' + j.detail.title.slice(0, 40)));
  live('detail has description or acceptance text', !!j.detail && (j.detail.description.length + j.detail.acceptance.length + j.detail.repro.length) > 0,
    j.detail ? 'desc ' + j.detail.description.length + ' acc ' + j.detail.acceptance.length + ' repro ' + j.detail.repro.length : '');
  live('no comments/discussion fetched', j.detail && !('comments' in j.detail) && !('discussion' in j.detail));
  [s, j] = await post('/api/notes', { taskId: 8246, section: 'Bogus', body: 'x' });
  check('bad section -> 400', s === 400 && j.errors.section);
  [s, j] = await post('/api/notes', { taskId: 8246, section: 'Analysis', body: '   ' });
  check('empty body -> 400', s === 400 && j.errors.body);
  [s, j] = await post('/api/notes', { taskId: 8246, section: 'Analysis', body: 'x'.repeat(8001) });
  check('too long -> 400', s === 400 && j.errors.body);
  [s, j] = await post('/api/notes', { taskId: 'abc', section: 'Analysis', body: 'x' });
  check('bad task id -> 400', s === 400);
  [s, j] = await post('/api/notes', { taskId: 8246, section: 'Analysis', body: 'x' }, { 'Content-Type': 'application/json' });
  check('missing X-Hub-Request -> 403', s === 403);
  [s, j] = await post('/api/notes', { taskId: 8246, section: 'Analysis', body: 'Line one\nLine two <b>not html</b>' });
  check('add note -> 201', s === 201 && j.note.author && j.note.body.includes('\n'), j.note && j.note.author);
  const id = j.note.id;
  [s, j] = await post('/api/notes', { taskId: 8246, section: 'Next step', body: 'Second note' });
  [s, j] = await get('/api/tasks/8246');
  check('two notes listed newest first', j.notes.length === 2 && j.notes[0].section === 'Next step');
  [s, j] = await post('/api/notes/' + id + '/update', { section: 'Decisions', body: 'Edited text' });
  check('update -> 200', s === 200 && j.note.section === 'Decisions' && j.note.body === 'Edited text' && j.note.updatedAt >= j.note.createdAt);
  [s, j] = await post('/api/notes/9999/update', { section: 'Decisions', body: 'x' });
  check('update unknown -> 404', s === 404);
  [s, j] = await get('/api/tasks');
  const card = j.tasks.find((t) => t.id === 8246);
  check('card carries noteCount 2', !!card && card.noteCount === 2, card ? String(card.noteCount) : 'task not on board');
  [s, j] = await post('/api/notes/' + id + '/delete', {});
  check('delete -> 200', s === 200);
  [s, j] = await post('/api/notes/' + id + '/delete', {});
  check('delete twice -> 404', s === 404);
  [s, j] = await get('/api/tasks/8246');
  check('one note left', j.notes.length === 1);
  [s, j] = await post('/api/notes', { taskId: 4242424, section: 'Findings', body: 'note on a task that is not on the board' });
  [s, j] = await get('/api/tasks');
  check('off-board task with notes joins the board (or is unreadable placeholder)', j.tasks.some((t) => t.id === 4242424 && t.noteCount === 1) || j.tasks.every((t) => t.id !== 4242424), 'present=' + j.tasks.some((t) => t.id === 4242424));
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  srv.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
