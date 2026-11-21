'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { discover } = require('../integrations/agents');
const { safeRepoPath } = require('../integrations/github');
let passed = 0;
function test(name, fn) { try { fn(); passed++; console.log('PASS ' + name); } catch(e) { console.error('FAIL ' + name, e); process.exitCode = 1; } }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-integrations-'));
try {
  fs.mkdirSync(path.join(dir, 'deep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'deep', 'rollout.jsonl'), '{"secret":"should-not-appear"}\n');
  fs.writeFileSync(path.join(dir, 'deep', 'other.txt'), 'ignored');
  test('Codex discovers session metadata without reading transcript', () => {
    const d = discover('codex', [dir]);
    assert.equal(d.sessions.length, 1);
    assert.equal(d.sessions[0].id, 'deep/rollout.jsonl');
    assert.ok(!JSON.stringify(d).includes('should-not-appear'));
  });
  test('Gemini discovers JSON session files', () => {
    fs.writeFileSync(path.join(dir, 'deep', 'session.json'), '{"private":"not-exported"}');
    const d = discover('gemini', [dir]);
    assert.equal(d.sessions.length, 1);
    assert.ok(!JSON.stringify(d).includes('not-exported'));
  });
  test('No session directory returns unconfigured', () => {
    const d = discover('codex', [path.join(dir, 'missing')]);
    assert.equal(d.configured, false);
    assert.equal(d.sessions.length, 0);
  });
  test('Unsupported provider rejected', () => assert.throws(() => discover('other'), /Unsupported/));
  test('GitHub path validation rejects relative paths', () => assert.throws(() => safeRepoPath('.'), /absolute/));
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
if (process.exitCode) process.exit(process.exitCode);
console.log('ALL PASSED: ' + passed);
