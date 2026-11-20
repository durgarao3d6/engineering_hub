'use strict';
// Plain-text rendering of a task's shared context, used by the hub command-line tool and by the session hooks.
function ago(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return Math.round(s / 60) + ' min ago';
  if (s < 129600) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' d ago';
}
const oneLine = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

function formatContext(c, max = 3600) {
  const L = [];
  L.push('Task #' + c.id + (c.title ? ' - ' + c.title : '') + ([c.type, c.state].filter(Boolean).length ? '  [' + [c.type, c.state].filter(Boolean).join(' / ') + ']' : ''));
  if (c.where) L.push('Work state: ' + c.where + ((c.attention || []).length ? ' | needs attention: ' + c.attention.join('; ') : ''));
  if ((c.prs || []).length) L.push('PRs: ' + c.prs.map((p) => 'PR ' + p.id + ' (' + p.status + ', ' + p.repo + (p.unresolved ? ', ' + p.unresolved + ' open thread(s)' : '') + ')').join('; '));
  if ((c.worktrees || []).length) L.push('Worktrees and checkouts (a task can span several repos):\n' + c.worktrees.map((w) => '  - ' + w.repoKey + ' (' + (w.layer || '') + ') ' + w.branch + (w.isMain ? ' [live checkout]' : '') + (w.dirtyFiles ? ', ' + w.dirtyFiles + ' uncommitted file(s)' : '') + '\n    ' + w.path).join('\n'));
  else L.push('Worktrees: none linked yet.');
  if ((c.plan || []).length) L.push('On your plan: ' + c.plan.map((p) => p.date + ' "' + oneLine(p.text, 80) + '" (' + p.status + ')').join('; '));
  if (c.sessions && c.sessions.totals && c.sessions.totals.sessions) {
    const t = c.sessions.totals; const r = c.sessions.recent[0];
    L.push('Earlier Claude sessions on this task: ' + t.sessions + ' (' + t.turns + ' prompts); latest ' + ago(r && r.last) + (r && r.label ? ', started with "' + oneLine(r.label, 70) + '"' : '') + '.');
  }
  if ((c.notes || []).length) {
    L.push('Notes from earlier sessions (newest first):');
    c.notes.forEach((n) => L.push('  - [' + n.section + '] ' + ago(n.createdAt) + ', ' + n.author + ': ' + oneLine(n.body, 380)));
  } else L.push('Notes: none yet.');
  if (!c.adoReachable) L.push('(Azure DevOps could not be reached just now, so the title and state may be missing.)');
  const out = L.join('\n');
  return out.length > max ? out.slice(0, max - 30) + '\n... (shortened)' : out;
}

module.exports = { formatContext, ago, oneLine };
