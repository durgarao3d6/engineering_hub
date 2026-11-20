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
  const kind = /^ANALYSE_ITEMS/.test(system) ? 'analyse' : /^ARRANGE_PLAN/.test(system) ? 'arrange' : /draft Azure DevOps/.test(system) ? 'draft' : 'items';
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
  let kn = 1; // how many calls of THIS kind so far (for the "bad once" modes)
  if (process.env.STUB_STATE) { const kf = process.env.STUB_STATE + '.' + kind; try { kn = Number(fs.readFileSync(kf, 'utf8')) + 1; } catch { kn = 1; } fs.writeFileSync(kf, String(kn)); }
  if (kind === 'analyse') {
    const items = JSON.parse(between('items'));
    if (mode === 'analyse-bad-once' && kn === 1) return reply({ analyses: [{ id: 999999 }] });
    return reply({ analyses: items.map((it) => {
      const text = [it.title, it.description, it.acceptance, it.repro, ...(it.discussion || []).map((d) => d.text)].join(' ');
      const fixed = /already fixed|was merged|no longer needed/i.test(text); const needs = /needs? more info|unclear what/i.test(text);
      const wait = /waiting (?:for|on) ([A-Z][a-z]+)/.exec(text); const urgent = /production|outage|critical/i.test(text);
      return { id: mode === 'analyse-unknown-id' ? 999999 : it.id, summary: 'Summary of ' + it.title, kind: it.type === 'Bug' ? 'bug' : 'task', size: text.length > 1500 ? 'l' : text.length > 600 ? 'm' : 's', urgency: urgent ? 'high' : 'normal',
        blockers: [], waitingOn: wait ? wait[1] : null, needsInfo: needs, question: needs ? 'What exactly is expected?' : null, looksFixed: fixed, fixedWhy: fixed ? 'The discussion says it is fixed' : null,
        delegateHint: /Sam will take/i.test(text) ? { kind: 'monitor', why: 'Sam said he will take it' } : null, evidence: text.slice(0, 80), confidence: 0.8 };
    }) });
  }
  if (kind === 'arrange') {
    const days = JSON.parse(between('days')); const items = JSON.parse(between('analyses'));
    if (mode === 'arrange-bad-day' || (mode === 'arrange-bad-day-once' && kn === 1)) return reply({ placements: items.map((i) => ({ id: i.id, where: 'day', date: '1999-01-01', reason: 'bad day' })), notes: '' });
    if (mode === 'arrange-unknown') return reply({ placements: [{ id: 999999, where: 'later', date: null, reason: 'x' }], notes: '' });
    if (mode === 'arrange-dup') return reply({ placements: [{ id: items[0].id, where: 'later', date: null, reason: 'a' }, { id: items[0].id, where: 'later', date: null, reason: 'b' }], notes: '' });
    if (mode === 'arrange-overfill') return reply({ placements: items.map((i) => ({ id: i.id, where: 'day', date: days[0].date, reason: 'all on the first day' })), notes: 'overfilled on purpose' });
    if (mode === 'arrange-ignore-flags') return reply({ placements: items.map((i, k) => ({ id: i.id, where: 'day', date: days[k % days.length].date, reason: 'ignores flags' })), notes: '' });
    const room = days.map((d) => ({ ...d })); const sorted = [...items].sort((a, b) => (a.priority || 99) - (b.priority || 99) || a.id - b.id);
    return reply({ placements: sorted.map((i) => {
      const a = i.analysis;
      if (a.looksFixed) return { id: i.id, where: 'fixed', date: null, reason: a.fixedWhy };
      if (a.needsInfo) return { id: i.id, where: 'needs-info', date: null, reason: a.question };
      if (a.delegateHint) return { id: i.id, where: 'delegate', date: null, reason: a.delegateHint.why };
      if (a.waitingOn && a.urgency !== 'high' && a.urgency !== 'critical') return { id: i.id, where: 'waiting', date: null, reason: 'Waiting on ' + a.waitingOn };
      const d = room.find((x) => x.freeRoom > 0); if (!d) return { id: i.id, where: 'later', date: null, reason: 'No room' };
      d.freeRoom--; return { id: i.id, where: 'day', date: d.date, reason: 'P' + i.priority + ' on the earliest day with room' };
    }), notes: 'stub arrangement' });
  }
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
