'use strict';
// Task board model: Azure DevOps work items + PRs joined with local git state. Read-only.
const { ado, BASE } = require('./ado');
const cfg = require('../config');
const { pool } = require('./git');

const BRANCH_ID = cfg.branchRe;
const WIQL_PROJECT = cfg.project.replace(/'/g, "''"); // the project name goes into the search text, quote-safe
const DONE_STATES = new Set(['Closed', 'Done', 'Removed', 'Resolved']);
const FIELDS = ['System.Id', 'System.WorkItemType', 'System.Title', 'System.State', 'System.AssignedTo', 'System.ChangedDate', 'System.AreaPath', 'Microsoft.VSTS.Common.Priority'];
const VOTES = { 10: 'Approved', 5: 'Approved with suggestions', 0: 'No vote', '-5': 'Waiting for author', '-10': 'Rejected' };
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
// Automated pull requests (dependency updates, tool accounts): which repositories and title patterns count is set in hub.config.json ("botPullRequests").
const isBot = (pr) => !String((pr.createdBy && pr.createdBy.uniqueName) || '').includes('@') || cfg.botPr.repos.includes(pr.repository.name) || cfg.botPr.titleRe.test(pr.title || '');
const prUrl = (pr) => `${BASE}/${cfg.project}/_git/${encodeURIComponent(pr.repository.name)}/pullrequest/${pr.pullRequestId}`;

async function remote(wtRows, noteIds) {
  const me = (await ado(BASE + '/_apis/connectionData?api-version=7.1-preview')).authenticatedUser;
  const [assigned, mine, reviewer] = await Promise.all([
    ado('_apis/wit/wiql?$top=300&api-version=7.1', { query: "SELECT [System.Id] FROM workitems WHERE [System.TeamProject]='" + WIQL_PROJECT + "' AND [System.AssignedTo]=@Me AND [System.State] NOT IN ('Closed','Done','Removed','Resolved')" }),
    ado(`_apis/git/pullrequests?searchCriteria.creatorId=${me.id}&searchCriteria.status=all&searchCriteria.minTime=${daysAgo(45)}&$top=200&api-version=7.1`),
    ado(`_apis/git/pullrequests?searchCriteria.reviewerId=${me.id}&searchCriteria.status=active&$top=200&api-version=7.1`),
  ]);
  const myPrs = mine.value.filter((p) => p.status !== 'abandoned');
  // PRs that matter: still open, or closed in the last 14 days
  const relevant = myPrs.filter((p) => p.status === 'active' || (p.closedDate && p.closedDate > daysAgo(14)));
  const prItems = new Map(); // prId -> work item ids
  await pool(relevant, 8, async (p) => {
    let ids = [];
    try { ids = (await ado(`_apis/git/repositories/${p.repository.id}/pullRequests/${p.pullRequestId}/workitems?api-version=7.1`)).value.map((x) => Number(x.id)); } catch { /* keep branch match only */ }
    const m = BRANCH_ID.exec(p.sourceRefName || ''); if (m) ids.push(Number(m[1]));
    prItems.set(p.pullRequestId, [...new Set(ids)]);
  });
  const unresolved = new Map();
  await pool(relevant.filter((p) => p.status === 'active'), 6, async (p) => {
    try {
      const t = await ado(`_apis/git/repositories/${p.repository.id}/pullRequests/${p.pullRequestId}/threads?api-version=7.1`);
      unresolved.set(p.pullRequestId, t.value.filter((th) => !th.isDeleted && (th.status === 'active' || th.status === 'pending')
        && (th.comments || []).some((c) => c.commentType === 'text')).length);
    } catch { /* unknown */ }
  });

  const ids = new Set(assigned.workItems.map((w) => w.id));
  wtRows.forEach((w) => { if (w.taskId) ids.add(w.taskId); });
  (noteIds || []).forEach((i) => ids.add(i)); // tasks the user wrote notes on stay on the board
  prItems.forEach((v) => v.forEach((i) => ids.add(i)));
  const wis = new Map(); const all = [...ids];
  for (let i = 0; i < all.length; i += 200) {
    const r = await ado('_apis/wit/workitemsbatch?api-version=7.1', { ids: all.slice(i, i + 200), fields: FIELDS, errorPolicy: 'Omit' });
    r.value.filter(Boolean).forEach((w) => wis.set(w.id, w.fields)); // unknown ids (e.g. a branch number that is not a work item) come back null
  }
  return { me, assigned: new Set(assigned.workItems.map((w) => w.id)), myPrs: relevant, prItems, unresolved, wis, reviewer: reviewer.value };
}

function whereOf(t) {
  const act = t.prs.find((p) => p.status === 'active');
  if (act) return act.isDraft ? 'PR open (draft)' : 'PR open';
  const live = t.worktrees.find((w) => w.isMain);
  if (live) return live.dirtyFiles ? 'In live repo (uncommitted)' : 'In live repo';
  const wt = t.worktrees.filter((w) => !w.isMain);
  if (wt.some((w) => w.dirtyFiles > 0)) return 'Uncommitted in worktree';
  if (wt.some((w) => (w.where || '').startsWith('Committed locally'))) return 'Committed locally';
  if (wt.some((w) => w.where === 'Pushed')) return 'Pushed';
  if (t.prs.some((p) => p.status === 'completed')) return 'Merged';
  return 'No code yet';
}

function build(wtRows, R, noteIds) {
  const tasks = new Map();
  const get = (id) => {
    if (!tasks.has(id)) tasks.set(id, { id, type: '', title: '', state: '', assignedTo: '', areaPath: '', priority: null, changedDate: null, url: `${BASE}/${cfg.project}/_workitems/edit/${id}`, assignedToMe: false, worktrees: [], prs: [], repos: [] });
    return tasks.get(id);
  };
  const seenWt = new Set();
  for (const w of wtRows) {
    if (!w.taskId) continue;
    const k = (w.path || '').toLowerCase(); if (seenWt.has(k)) continue; seenWt.add(k);
    get(w.taskId).worktrees.push({ path: w.path, branch: w.branch, where: w.where, dirtyFiles: w.dirtyFiles || 0, isMain: !!w.isMain, repoKey: w.repoKey, layer: w.layer, idleDays: w.idleDays, stale: !!w.stale, lastCommit: w.lastCommit ? w.lastCommit.date : null });
  }
  if (R) {
    R.assigned.forEach((id) => { get(id).assignedToMe = true; });
    for (const p of R.myPrs) {
      const ids = R.prItems.get(p.pullRequestId) || [];
      const pr = { id: p.pullRequestId, repo: p.repository.name, status: p.status, isDraft: !!p.isDraft, title: p.title, url: prUrl(p), created: p.creationDate, closed: p.closedDate || null,
        unresolved: R.unresolved.has(p.pullRequestId) ? R.unresolved.get(p.pullRequestId) : null,
        changesRequested: (p.reviewers || []).some((r) => r.vote < 0), approvals: (p.reviewers || []).filter((r) => r.vote >= 5).length };
      ids.forEach((id) => get(id).prs.push(pr));
    }
    for (const [id, f] of R.wis) {
      const t = get(id);
      t.type = f['System.WorkItemType']; t.title = f['System.Title']; t.state = f['System.State'];
      t.assignedTo = f['System.AssignedTo'] ? f['System.AssignedTo'].displayName : ''; t.areaPath = f['System.AreaPath'];
      t.priority = f['Microsoft.VSTS.Common.Priority'] || null; t.changedDate = f['System.ChangedDate'];
    }
  }
  if (noteIds) noteIds.forEach((id) => get(id)); // a task with notes never vanishes from the board, even if Azure DevOps cannot read it
  const out = [];
  for (const t of tasks.values()) {
    // keep: assigned to me, has code/PR activity. Items that exist only through an old merged PR are kept for 14 days by the query window.
    if (R && !t.title) t.title = '(work item not readable)';
    t.repos = [...new Set([...t.worktrees.map((w) => w.repoKey), ...t.prs.map((p) => p.repo)].filter(Boolean))];
    t.where = whereOf(t);
    const a = [];
    const dirty = t.worktrees.filter((w) => !w.isMain && w.dirtyFiles > 0).length;
    if (dirty) a.push('Uncommitted work in ' + dirty + ' worktree(s)');
    if (t.worktrees.some((w) => !w.isMain && (w.where || '').startsWith('Committed locally'))) a.push('Commits not pushed');
    for (const p of t.prs.filter((x) => x.status === 'active')) {
      if (p.unresolved) a.push('PR ' + p.id + ': ' + p.unresolved + ' unresolved thread(s)');
      if (p.changesRequested) a.push('PR ' + p.id + ': a reviewer asked for changes');
    }
    if (t.prs.some((p) => p.status === 'completed') && !t.prs.some((p) => p.status === 'active') && t.state && !DONE_STATES.has(t.state)) a.push('PR merged but the work item is still ' + t.state);
    if (t.worktrees.some((w) => !w.isMain && (w.where || '').startsWith('Merged'))) a.push('Merged worktree still on disk');
    t.attention = a;
    const dates = [t.changedDate, ...t.prs.map((p) => p.closed || p.created), ...t.worktrees.map((w) => w.lastCommit)].filter(Boolean).sort();
    t.lastActivity = dates.length ? dates[dates.length - 1] : null;
    const doneItem = DONE_STATES.has(t.state);
    const noted = !!(noteIds && noteIds.has(t.id));
    const openPr = t.prs.some((p) => p.status === 'active');
    // Completed work items (Resolved/Closed/Done) are not on the board: they load on demand. Notes and open PRs keep an item visible.
    if (R && doneItem && !noted && !openPr) continue;
    if (R && !t.state && !noted && !t.worktrees.length) continue; // a work item Azure DevOps cannot read, known only from an old PR link
    if (noted || t.assignedToMe || t.worktrees.length || openPr || t.where === 'Merged') out.push(t);
  }
  return out;
}

function reviewsOf(R) {
  return R.reviewer.filter((p) => !(p.createdBy && p.createdBy.id === R.me.id)).map((p) => {
    const mine = (p.reviewers || []).find((r) => r.id === R.me.id);
    return { id: p.pullRequestId, repo: p.repository.name, title: p.title, author: p.createdBy ? p.createdBy.displayName : '', isBot: isBot(p), isDraft: !!p.isDraft,
      created: p.creationDate, myVote: mine ? (VOTES[mine.vote] || String(mine.vote)) : 'No vote', voted: !!(mine && mine.vote !== 0), url: prUrl(p) };
  });
}

async function collectTasks(wtData, noteIds) {
  const rows = (wtData && wtData.worktrees) || [];
  const ids = new Set(noteIds || []);
  const out = { generatedAt: new Date().toISOString(), ado: { ok: true }, me: null, tasks: [], reviews: [] };
  let R = null;
  if (!cfg.adoConfigured) out.ado = { ok: false, notConfigured: true, error: 'Azure DevOps is not set up.' };
  else {
    try { R = await remote(rows, [...ids]); out.me = R.me.providerDisplayName; }
    catch (e) { out.ado = { ok: false, auth: e.code === 'AUTH', error: e.message }; }
  }
  out.tasks = build(rows, R, ids);
  if (R) out.reviews = reviewsOf(R);
  return out;
}

// Full work item for the detail panel. Comments/discussion are deliberately NOT fetched: they stay in Azure Boards.
const DETAIL_FIELDS = ['System.Id', 'System.WorkItemType', 'System.Title', 'System.State', 'System.Reason', 'System.AssignedTo', 'System.CreatedBy', 'System.CreatedDate', 'System.ChangedDate',
  'System.AreaPath', 'System.IterationPath', 'System.Tags', 'System.Parent', 'System.Description', 'Microsoft.VSTS.Common.AcceptanceCriteria', 'Microsoft.VSTS.TCM.ReproSteps',
  'Microsoft.VSTS.Common.Priority', 'Microsoft.VSTS.Common.Severity', 'Microsoft.VSTS.Scheduling.StoryPoints'];
const dcache = new Map();
async function fetchDetail(id) {
  const hit = dcache.get(id);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.data;
  const w = await ado(`_apis/wit/workitems/${id}?fields=${DETAIL_FIELDS.join(',')}&api-version=7.1`);
  const f = w.fields || {};
  const person = (p) => (p && (p.displayName || p.uniqueName)) || '';
  const data = {
    id, type: f['System.WorkItemType'] || '', title: f['System.Title'] || '', state: f['System.State'] || '', reason: f['System.Reason'] || '',
    assignedTo: person(f['System.AssignedTo']), createdBy: person(f['System.CreatedBy']), createdDate: f['System.CreatedDate'] || null, changedDate: f['System.ChangedDate'] || null,
    areaPath: f['System.AreaPath'] || '', iterationPath: f['System.IterationPath'] || '', tags: (f['System.Tags'] || '').split(';').map((s) => s.trim()).filter(Boolean),
    parent: f['System.Parent'] || null, priority: f['Microsoft.VSTS.Common.Priority'] || null, severity: f['Microsoft.VSTS.Common.Severity'] || '', points: f['Microsoft.VSTS.Scheduling.StoryPoints'] || null,
    description: f['System.Description'] || '', acceptance: f['Microsoft.VSTS.Common.AcceptanceCriteria'] || '', repro: f['Microsoft.VSTS.TCM.ReproSteps'] || '',
    url: `${BASE}/${cfg.project}/_workitems/edit/${id}`,
  };
  dcache.set(id, { at: Date.now(), data });
  return data;
}

// Completed items (Resolved/Closed/Done) assigned to me and changed in the last `days` days. Fetched only when the user asks.
const ccache = new Map();
async function collectCompleted(days, wtRows) {
  const hit = ccache.get(days);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.data;
  const LIMIT = 300;
  const q = await ado(`_apis/wit/wiql?$top=${LIMIT}&api-version=7.1`, { query: `SELECT [System.Id] FROM workitems WHERE [System.TeamProject]='${WIQL_PROJECT}' AND [System.AssignedTo]=@Me AND [System.State] IN ('Resolved','Closed','Done') AND [System.ChangedDate] >= @Today - ${days} ORDER BY [System.ChangedDate] DESC` });
  const ids = q.workItems.map((w) => w.id); const tasks = [];
  for (let i = 0; i < ids.length; i += 200) {
    const r = await ado('_apis/wit/workitemsbatch?api-version=7.1', { ids: ids.slice(i, i + 200), fields: FIELDS, errorPolicy: 'Omit' });
    for (const w of r.value.filter(Boolean)) {
      const f = w.fields; const id = w.id;
      const wts = (wtRows || []).filter((x) => x.taskId === id).map((x) => ({ path: x.path, branch: x.branch, where: x.where, dirtyFiles: x.dirtyFiles || 0, isMain: !!x.isMain, repoKey: x.repoKey, layer: x.layer, idleDays: x.idleDays, stale: !!x.stale, lastCommit: x.lastCommit ? x.lastCommit.date : null }));
      tasks.push({ id, type: f['System.WorkItemType'], title: f['System.Title'], state: f['System.State'], assignedTo: f['System.AssignedTo'] ? f['System.AssignedTo'].displayName : '', assignedToMe: true,
        areaPath: f['System.AreaPath'], priority: f['Microsoft.VSTS.Common.Priority'] || null, changedDate: f['System.ChangedDate'], url: `${BASE}/${cfg.project}/_workitems/edit/${id}`,
        worktrees: wts, prs: [], repos: [...new Set(wts.map((x) => x.repoKey))], where: 'Completed', attention: [], lastActivity: f['System.ChangedDate'], completed: true });
    }
  }
  tasks.sort((a, b) => Date.parse(b.changedDate) - Date.parse(a.changedDate));
  const data = { generatedAt: new Date().toISOString(), days, truncated: ids.length >= LIMIT, tasks };
  ccache.set(days, { at: Date.now(), data });
  return data;
}

module.exports = { collectTasks, collectCompleted, fetchDetail };
