'use strict';
// Runs the Claude Code CLI headless, with your own login, for the Morning plan only.
// The model gets no tools and no MCP servers; the answer is forced into a JSON schema; every call is recorded in `ai_calls`.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./store');

const CWD = path.join(os.tmpdir(), 'tms-hub-ai'); // outside every project, so no repo CLAUDE.md or project hooks apply
const MODELS = { parse: process.env.HUB_AI_PARSE_MODEL || 'haiku', draft: process.env.HUB_AI_DRAFT_MODEL || 'sonnet' };
const timeoutMs = () => Number(process.env.HUB_AI_TIMEOUT_MS || 120000);
const BUDGET_USD = process.env.HUB_AI_MAX_USD || '0.5';

function command() {
  const b = process.env.HUB_CLAUDE_BIN; // tests point this at a stub script
  if (b && b.toLowerCase().endsWith('.js')) return [process.execPath, [b]];
  return [b || 'claude', []];
}

// The model's process gets no Azure DevOps credentials at all (belt and braces: it also has no tools and no MCP servers).
const SECRET_ENV = /^(AZURE|AZ_|ADO_|AZDO|SYSTEM_ACCESSTOKEN|VSS_|TF_BUILD|SYSTEM_)/i;
function childEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!SECRET_ENV.test(k)) env[k] = v;
  return env;
}

function killTree(pid) {
  try { execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {}); } catch { /* already gone */ }
}

function tryJson(s) { try { return JSON.parse(s); } catch { return undefined; } }

function run({ purpose, model, system, prompt, schema }) {
  fs.mkdirSync(CWD, { recursive: true });
  const [bin, pre] = command();
  const args = [...pre, '-p', '--model', model, '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--tools', '', '--no-session-persistence',
    '--disable-slash-commands', '--strict-mcp-config', '--max-budget-usd', BUDGET_USD, '--system-prompt', system];
  return new Promise((resolve) => {
    const t0 = Date.now(); let out = ''; let err = ''; let done = false; let child;
    const finish = (r) => {
      if (done) return; done = true; clearTimeout(timer);
      const u = r.usage || {};
      store.aiCallAdd({ purpose, model: r.model || model, in: u.in, out: u.out, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, usd: u.usd, ms: u.ms || Date.now() - t0, ok: r.ok, error: r.error });
      resolve(r);
    };
    const timer = setTimeout(() => { if (child) killTree(child.pid); finish({ ok: false, error: 'The assistant did not answer within ' + Math.round(timeoutMs() / 1000) + ' seconds.' }); }, timeoutMs());
    try { child = spawn(bin, args, { cwd: CWD, env: childEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { return finish({ ok: false, error: e.message }); }
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ ok: false, error: e.code === 'ENOENT' ? 'Claude Code CLI was not found on this machine.' : e.message }));
    child.on('close', (code) => {
      const j = tryJson(out);
      if (!j) return finish({ ok: false, error: (err.trim() || out.trim() || 'The assistant returned nothing (exit ' + code + ').').split(/\r?\n/)[0].slice(0, 300) });
      const u = j.usage || {};
      const usage = { in: u.input_tokens || 0, out: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, usd: j.total_cost_usd || 0, ms: j.duration_ms || 0 };
      const actual = j.modelUsage ? Object.keys(j.modelUsage)[0] : model;
      if (j.is_error) return finish({ ok: false, usage, model: actual, error: String(j.result || j.subtype || 'The assistant reported an error.').slice(0, 300) });
      const data = j.structured_output !== undefined && j.structured_output !== null ? j.structured_output : tryJson(String(j.result || ''));
      if (data === undefined) return finish({ ok: false, usage, model: actual, error: 'The assistant did not return valid JSON.' });
      finish({ ok: true, data, usage, model: actual });
    });
    child.stdin.on('error', () => { /* the process may exit before reading */ });
    child.stdin.end(prompt);
  });
}

// One call with a validator and a single retry that tells the model what was wrong.
async function json(opts, validate) {
  let r = await run(opts);
  const bad = (x) => (x.ok ? validate(x.data) : x.error);
  let why = bad(r);
  if (!why) return { ...r, tries: 1 };
  if (!r.ok && /not found|did not answer|within/.test(String(r.error))) return { ...r, tries: 1 }; // retrying will not help
  const first = r;
  r = await run({ ...opts, prompt: opts.prompt + '\n\nYour previous answer was rejected: ' + String(why).slice(0, 200) + '. Answer again with only valid JSON that matches the schema.' });
  why = bad(r);
  const usage = ['in', 'out', 'cacheRead', 'cacheWrite', 'usd', 'ms'].reduce((a, k) => { a[k] = ((first.usage || {})[k] || 0) + ((r.usage || {})[k] || 0); return a; }, {});
  return why ? { ok: false, error: String(why), usage, tries: 2 } : { ...r, usage, tries: 2 };
}

let statusCache = { at: 0, v: null };
function status() {
  if (statusCache.v && Date.now() - statusCache.at < 5 * 60 * 1000) return Promise.resolve(statusCache.v);
  const [bin, pre] = command();
  return new Promise((resolve) => {
    execFile(bin, [...pre, '--version'], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      statusCache = { at: Date.now(), v: { available: !err, version: err ? null : String(stdout).trim().split(/\r?\n/)[0], error: err ? 'Claude Code CLI not found or not working.' : null } };
      resolve(statusCache.v);
    });
  });
}

const monthStart = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString(); };

module.exports = { run, json, status, MODELS, monthStats: () => store.aiCallStats(monthStart()) };
