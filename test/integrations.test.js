'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { discover } = require('../integrations/agents');
const { safeRepoPath, classify, gh, inspect } = require('../integrations/github');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-integrations-'));
fs.mkdirSync(path.join(dir, 'deep'), { recursive: true });
fs.writeFileSync(path.join(dir, 'deep', 'rollout.jsonl'), '{"secret":"should-not-appear"}\n');
fs.writeFileSync(path.join(dir, 'deep', 'other.txt'), 'ignored');
fs.writeFileSync(path.join(dir, 'deep', 'session-1.json'), '{"private":"not-exported"}');
fs.writeFileSync(path.join(dir, 'deep', 'logs.json'), '[]');
fs.writeFileSync(path.join(dir, 'deep', 'settings.json'), '{}');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('Codex discovers session metadata without reading transcript', () => {
  const d = discover('codex', [dir]);
  assert.equal(d.sessions.length, 1);
  assert.equal(d.sessions[0].id, 'deep/rollout.jsonl');
  assert.ok(!JSON.stringify(d).includes('should-not-appear'));
});
test('Gemini counts only chat sessions (session-*.json), not logs or settings', () => {
  const d = discover('gemini', [dir]);
  assert.deepEqual(d.sessions.map((s) => s.id), ['deep/session-1.json']);
  assert.ok(!JSON.stringify(d).includes('not-exported'));
});
test('No session directory returns unconfigured and no error', () => {
  const d = discover('codex', [path.join(dir, 'missing')]);
  assert.equal(d.configured, false);
  assert.equal(d.sessions.length, 0);
  assert.equal(d.errors.length, 0);
});
test('A folder that cannot be read is reported in errors', () => {
  const orig = fs.readdirSync;
  fs.readdirSync = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
  try {
    const d = discover('codex', [dir]);
    assert.ok(d.errors.length === 1 && /could not be read/.test(d.errors[0]), JSON.stringify(d.errors));
  } finally { fs.readdirSync = orig; }
});
test('Unsupported provider rejected', () => assert.throws(() => discover('other'), /Unsupported/));

test('GitHub path validation rejects relative paths', () => assert.throws(() => safeRepoPath('.'), /absolute/));
test('gh error: not installed', () => assert.equal(classify({ code: 'ENOENT' }).kind, 'notinstalled'));
test('gh error: no GitHub remote says so', () => {
  const e = classify({ stderr: 'none of the git remotes configured for this repository point to a known GitHub host.' });
  assert.equal(e.kind, 'noremote');
  assert.match(e.message, /not on GitHub/);
});
test('gh error: not signed in', () => assert.equal(classify({ stderr: 'To get started with GitHub CLI, please run:  gh auth login' }).kind, 'auth'));
test('gh error: no access', () => assert.equal(classify({ stderr: 'GraphQL: Could not resolve to a Repository' }).kind, 'access'));
test('gh error: timeout', () => assert.equal(classify({ killed: true }).kind, 'timeout'));
test('an unknown gh failure keeps its first line only', () => {
  const e = classify({ stderr: 'something odd happened\nsecond line' });
  assert.equal(e.kind, 'other');
  assert.match(e.message, /something odd happened/);
  assert.ok(!/second line/.test(e.message));
});
test('only repo view and pr list can run; anything else is refused before a process starts', async () => {
  let started = 0;
  const run = async () => { started++; return { stdout: '{}' }; };
  for (const bad of [['pr', 'merge', '1'], ['api', 'repos/x/y'], ['repo', 'delete', 'x'], ['pr', 'close', '2'], ['issue', 'list']]) {
    await assert.rejects(() => gh(bad, process.cwd(), run), (e) => e.kind === 'refused');
  }
  assert.equal(started, 0);
});
test('inspect asks gh only for the two read commands and returns the result', async () => {
  const seen = [];
  const run = async (cmd, argv, opts) => {
    seen.push(argv.slice(0, 2).join(' '));
    assert.equal(opts.cwd, path.resolve(dir));
    return { stdout: argv[0] === 'repo' ? '{"nameWithOwner":"a/b"}' : '[{"number":1}]' };
  };
  const r = await inspect(dir, run);
  assert.deepEqual(seen.sort(), ['pr list', 'repo view']);
  assert.equal(r.readOnly, true);
  assert.equal(r.repository.nameWithOwner, 'a/b');
  assert.equal(r.pullRequests[0].number, 1);
});
test('inspect turns a gh failure into a classified error', async () => {
  const run = async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); };
  await assert.rejects(() => inspect(dir, run), (e) => e.kind === 'notinstalled');
});

(async () => {
  let passed = 0, failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('PASS ' + name); }
    catch (e) { failed++; console.log('FAIL ' + name + '  ' + (e && e.message)); }
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  if (failed) process.exit(1);
  console.log('ALL PASSED: ' + passed);
})();
