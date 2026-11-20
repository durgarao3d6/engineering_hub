'use strict';
// Fake `claude` CLI for hub tests. Mode comes from STUB_MODE; STUB_LOG records every call (flags + prompt); STUB_STATE counts calls.
const fs = require('fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('stub-claude 0.0.1'); process.exit(0); }
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const mode = process.env.STUB_MODE || 'ok';
let stdin = '';
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  const system = arg('--system-prompt') || '';
  const kind = /draft Azure DevOps/.test(system) ? 'draft' : 'items';
  let n = 1;
  if (process.env.STUB_STATE) { try { n = Number(fs.readFileSync(process.env.STUB_STATE, 'utf8')) + 1; } catch { n = 1; } fs.writeFileSync(process.env.STUB_STATE, String(n)); }
  if (process.env.STUB_LOG) fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ kind, n, model: arg('--model'), toolsArg: args[args.indexOf('--tools') + 1], flags: args.filter((a) => a.startsWith('--')), azureEnv: Object.keys(process.env).filter((k) => /^(AZURE|AZ_|ADO_|AZDO|SYSTEM_|VSS_)/i.test(k)), prompt: stdin, cwd: process.cwd() }) + '\n');
  const reply = (data, extra) => {
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(data), structured_output: data,
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 }, total_cost_usd: 0.001, duration_ms: 5, modelUsage: { ['stub-' + arg('--model')]: {} }, ...extra }));
  };
  if (mode === 'timeout') return setTimeout(() => process.exit(0), 20000);
  if (mode === 'error') return console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'stub says no', usage: {}, total_cost_usd: 0 }));
  if (mode === 'badjson-always' || (mode === 'badjson-once' && n === 1)) return console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'sorry, here is some prose', usage: { input_tokens: 5, output_tokens: 5 }, total_cost_usd: 0.0005, duration_ms: 3 }));

  const between = (tag) => { const m = new RegExp('<' + tag + '>\\n([\\s\\S]*?)\\n</' + tag + '>').exec(stdin); return m ? m[1] : ''; };
  if (kind === 'draft') {
    const tasks = JSON.parse(between('tasks'));
    const codeRaw = between('code'); const code = codeRaw ? JSON.parse(codeRaw) : [];
    return reply({ drafts: tasks.map((t) => {
      const c = code.find((x) => x.index === t.index); const repos = c ? [...new Set(c.worktrees.map((w) => w.repoKey))] : [];
      const files = c ? c.worktrees.flatMap((w) => [...(w.committedFiles || []), ...(w.uncommittedFiles || [])]) : [];
      return { index: t.index, type: 'Task', title: 'Area: ' + t.text, description: 'Needs work: ' + t.text + '. Details to be confirmed.' + (repos.length ? ' Context repos: ' + repos.join(',') + '. Files: ' + files.slice(0, 3).join(',') + '.' : ''), acceptanceCriteria: ['It works as described', 'It is tested'] };
    }) });
  }
  const plan = between('plan'); const cands = JSON.parse(between('candidates'));
  let wts = []; try { wts = JSON.parse(between('worktrees')); } catch { /* none supplied */ }
  const lines = plan.split(/\r?\n|;/).map((l) => l.replace(/^[\s\-*\d.)]+/, '').trim()).filter(Boolean);
  const items = lines.map((line, i) => {
    const kind = /\bPR\b|review/i.test(line) ? 'review' : /meeting|standup|sync/i.test(line) ? 'meeting' : 'task';
    let matchedId = null; let confidence = 0;
    const byNum = cands.find((c) => new RegExp('\\b' + c.id + '\\b').test(line));
    if (byNum) { matchedId = byNum.id; confidence = 0.95; }
    else if (kind === 'task') {
      const words = new Set(line.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
      const best = cands.map((c) => ({ c, hits: c.title.toLowerCase().split(/\W+/).filter((w) => words.has(w)).length })).sort((a, b) => b.hits - a.hits)[0];
      if (best && best.hits >= 2) { matchedId = best.c.id; confidence = /maybe/i.test(line) ? 0.4 : 0.8; }
    }
    if (mode === 'halluc' && i === 0 && kind === 'task') { matchedId = 999999; confidence = 0.99; }
    let worktrees = [];
    if (/responsive/i.test(line)) worktrees = wts.filter((w) => /responsive/i.test(w.branch)).map((w) => w.i);
    if (/bogus-worktree/i.test(line)) worktrees = [999];
    return { text: line, kind, matchedId, confidence, alternatives: [], reason: matchedId ? 'stub match' : '', worktrees };
  });
  reply({ items });
});
