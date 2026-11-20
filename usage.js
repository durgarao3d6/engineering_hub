'use strict';
// Token usage report. Reads a usage log (default ~/.claude/usage-dashboard/usage.jsonl, written by a usage-tracker hook, which reads the
// session transcripts: no model tokens are used to collect it). Costs are list-price estimates from prices.json.
const fs = require('fs');
const os = require('os');
const path = require('path');

const cfg = require('./config');

const FILE = cfg.usage.file; // optional: without the log the page says so
const HUB_DIR = __dirname;
// The hub was started in the turn whose prompt matches this; that turn and every later turn of the same session count as "building the hub".
// Optional (usage.hubBuildPrompt in hub.config.json): without it the "what building this hub cost" card is left out.
const HUB_START = cfg.usage.hubBuildPrompt ? new RegExp(cfg.escapeRe(cfg.usage.hubBuildPrompt), 'i') : null;
const ROOT_LC = String(cfg.workspaceRoot || '').toLowerCase().replace(/\//g, '\\');
const PROJECT_FILTER = (p) => !ROOT_LC || String(p || '').toLowerCase().replace(/\//g, '\\').startsWith(ROOT_LC); // sessions under the workspace folder (all sessions if none is set)

const bucket = () => ({ in: 0, out: 0, thinking: 0, cacheRead: 0, cacheWrite: 0, calls: 0, usd: 0, turns: 0 });
function add(b, m) {
  b.in += m.in || 0; b.out += m.out || 0; b.thinking += m.thinking || 0; b.cacheRead += m.cacheRead || 0;
  b.cacheWrite += (m.cw5 || 0) + (m.cw1h || 0); b.calls += m.calls || 0; b.usd += m.usd || 0;
}
function turnTotals(r) {
  const b = bucket(); add(b, r.main); (r.subagents || []).forEach((s) => add(b, s)); b.turns = 1; return b;
}
function merge(into, t) { for (const k of Object.keys(into)) into[k] += t[k] || 0; }
const total = (b) => b.in + b.out + b.cacheRead + b.cacheWrite;
const round = (b) => ({ ...b, usd: Math.round(b.usd * 1e4) / 1e4, total: total(b) });

let cache = { mtime: 0, rows: [] };
function rows() {
  let st; try { st = fs.statSync(FILE); } catch { return []; } // no usage log: an empty report, not an error
  if (st.mtimeMs !== cache.mtime) {
    const out = [];
    for (const l of fs.readFileSync(FILE, 'utf8').split('\n')) { if (!l) continue; try { out.push(JSON.parse(l)); } catch { /* skip a partial line */ } }
    cache = { mtime: st.mtimeMs, rows: out };
  }
  return cache.rows;
}

// Evidence that the hub itself never calls a model: no LLM API host or SDK appears in its source.
function hubModelCalls() {
  const hits = [];
  const scan = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'data' || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { scan(p); continue; }
      if (!/\.(js|html)$/.test(e.name) || e.name === 'usage.js') continue;
      if (/api\.anthropic\.com|api\.openai\.com|@anthropic-ai|openai|generativelanguage/i.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(HUB_DIR, p));
    }
  };
  scan(HUB_DIR);
  return hits;
}

function report() {
  const all = rows();
  const proj = all.filter((r) => PROJECT_FILTER(r.project));
  // --- hub build ---
  const startRow = !HUB_START ? null : proj.filter((r) => HUB_START.test(r.prompt || '')).sort((a, b) => a.start.localeCompare(b.start))[0];
  let build = null;
  if (startRow) {
    const turns = proj.filter((r) => r.sessionId === startRow.sessionId && r.start >= startRow.start).sort((a, b) => a.start.localeCompare(b.start));
    const totals = bucket(); const byModel = new Map();
    const list = turns.map((r) => {
      const t = turnTotals(r); merge(totals, t);
      const models = [...new Set([...(r.models || []), ...(r.subagents || []).flatMap((s) => s.models || [])])];
      const slot = (m) => { const k = m || 'unknown'; if (!byModel.has(k)) byModel.set(k, bucket()); return byModel.get(k); };
      const mainSlot = slot((r.models || [])[0]); add(mainSlot, r.main); mainSlot.turns += 1;
      (r.subagents || []).forEach((s) => add(slot((s.models || [])[0]), s));
      return { n: r.turnIndex, start: r.start, end: r.end, prompt: r.prompt, models, subagents: (r.subagents || []).length, ...round(t) };
    });
    build = { sessionId: startRow.sessionId, from: startRow.start, to: turns.length ? turns[turns.length - 1].end : null, turns: list, totals: round(totals),
      byModel: [...byModel.entries()].map(([model, b]) => ({ model, ...round(b) })).sort((a, b) => b.usd - a.usd) };
  }
  // --- whole workspace ---
  const totals = bucket(); const byDay = new Map(); const bySession = new Map();
  for (const r of proj) {
    const t = turnTotals(r); merge(totals, t);
    const day = (r.start || '').slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, bucket()); merge(byDay.get(day), t);
    let s = bySession.get(r.sessionId);
    if (!s) { s = { sessionId: r.sessionId, project: r.project, first: r.start, last: r.end, prompt: r.prompt, t: bucket(), models: new Set() }; bySession.set(r.sessionId, s); }
    merge(s.t, t); if (r.start < s.first) { s.first = r.start; s.prompt = r.prompt; } if (r.end > s.last) s.last = r.end;
    (r.models || []).forEach((m) => s.models.add(m));
  }
  const days = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 30).map(([day, b]) => ({ day, ...round(b) }));
  const sessions = [...bySession.values()].sort((a, b) => b.t.usd - a.t.usd).slice(0, 15)
    .map((s) => ({ sessionId: s.sessionId, project: s.project, first: s.first, last: s.last, prompt: s.prompt, models: [...s.models], ...round(s.t) }));
  const modelCalls = hubModelCalls();
  return {
    generatedAt: new Date().toISOString(), source: FILE, logFound: fs.existsSync(FILE), workspaceRoot: cfg.workspaceRoot, buildFound: !!build, build,
    hub: { modelCalls: modelCalls.length === 0 ? 0 : null, filesWithModelReferences: modelCalls },
    workspace: { turns: proj.length, sessions: bySession.size, totals: round(totals), days, topSessions: sessions },
    notes: [
      'Collecting this report costs no model tokens: the usage-tracker hook reads the transcripts Claude Code already writes. The hub\'s own model calls (Today\'s plan only) are recorded exactly in the hub database.',
      'Output includes thinking tokens ("of which thinking" is a subset). Cache reads are billed at a fraction of normal input.',
      'USD figures are list-price estimates (prices.json); claude.ai plans are not billed per token.',
      'The turn that is still running is not in the log until it ends.',
    ],
  };
}

module.exports = { report, rows, isTmsProject: PROJECT_FILTER };
