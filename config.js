'use strict';
// The one place that reads settings. Nothing else in the hub reads hub.config.json or knows an organisation, project,
// branch prefix, drive or user name. See hub.config.example.json and the README ("Configuration").
// Environment variables override the file (they are what the tests use): HUB_CONFIG, HUB_DATA_DIR, HUB_BACKUP_DIR, HUB_PORT,
// HUB_EXTRA_CLONES (semicolon separated), HUB_ONLY_EXTRA=1 (ignore the clones in the file).
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const FILE = process.env.HUB_CONFIG ? path.resolve(process.env.HUB_CONFIG) : path.join(ROOT, 'hub.config.json');
const KNOWN = ['_note', 'title', 'brand', 'userName', 'organization', 'project', 'branchPrefix', 'scanFolders', 'clones', 'repoMapFile', 'workspaceRoot', 'worktreeRoot',
  'dataDir', 'backupDir', 'port', 'coWorkerNames', 'azureDevOps', 'botPullRequests', 'planner', 'testing', 'usage', 'sessions', 'learningsDir', 'scorecard'];

const problems = []; // things the user should know; shown on the page and by `setup --check`
let raw = {};
let fileFound = false;
if (fs.existsSync(FILE)) {
  fileFound = true;
  try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {
    throw new Error('The hub settings file ' + FILE + ' is not valid JSON: ' + e.message + '. Fix it, or create a new one with: node "' + path.join(ROOT, 'bin', 'setup.js') + '" --help');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The hub settings file ' + FILE + ' must contain a JSON object.');
  for (const k of Object.keys(raw)) if (!KNOWN.includes(k)) problems.push('Unknown setting "' + k + '" in ' + path.basename(FILE) + ' (a typo?). Known settings are listed in hub.config.example.json.');
} else if (!process.env.HUB_CONFIG) {
  problems.push('No settings file yet. Create one with: node "' + path.join(ROOT, 'bin', 'setup.js') + '" --scan "<folder with your repos>" [--org https://dev.azure.com/<org> --project <name>]');
} else {
  problems.push('HUB_CONFIG points to a file that does not exist: ' + FILE);
}

const str = (v, d = '') => (typeof v === 'string' && v.trim() ? v.trim() : d);
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);
const rel = (p) => (p ? (path.isAbsolute(p) ? p : path.resolve(path.dirname(FILE), p)) : '');
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const norm = (p) => path.resolve(p).replace(/\//g, '\\').toLowerCase();

/* ---------- repositories ---------- */
const SKIP = new Set(['node_modules', 'bin', 'obj', 'dist', 'build']);
// A real clone has a .git FOLDER. A worktree has a .git FILE, so it is never mistaken for a clone.
function discover(folder, depth, out) {
  let entries = [];
  try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
  if (entries.some((e) => e.name === '.git' && e.isDirectory())) { out.push(folder); return; }
  if (depth <= 0) return;
  for (const e of entries) if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.')) discover(path.join(folder, e.name), depth - 1, out);
}
function buildRepos() {
  const repos = {}; const seen = new Set();
  const add = (key, p, layer, azdoRepo) => {
    const k = norm(p); if (seen.has(k)) return; seen.add(k);
    let name = key; let n = 2;
    while (repos[name] && repos[name].clones[layer]) name = key + '-' + n++;
    if (!repos[name]) repos[name] = { azdoRepo: azdoRepo || path.basename(p), clones: {} };
    repos[name].clones[layer] = p;
  };
  const mapFile = rel(str(raw.repoMapFile));
  if (mapFile) {
    try {
      const m = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
      for (const [key, r] of Object.entries(m.repos || {})) for (const [layer, p] of Object.entries(r.clones || {})) if (p) add(key, p, layer, r.azdoRepo);
    } catch (e) { problems.push('Could not read repoMapFile ' + mapFile + ': ' + e.message); }
  }
  for (const c of Array.isArray(raw.clones) ? raw.clones : []) {
    if (c && typeof c.path === 'string' && c.path.trim()) add(str(c.key, path.basename(c.path)), rel(c.path), str(c.layer, 'repo'), str(c.azdoRepo) || undefined);
    else problems.push('A "clones" entry has no path.');
  }
  for (const f of list(raw.scanFolders)) {
    const dir = rel(f);
    if (!fs.existsSync(dir)) { problems.push('scanFolders: the folder ' + dir + ' does not exist.'); continue; }
    const found = []; discover(dir, 3, found);
    if (!found.length) problems.push('scanFolders: no git repositories found under ' + dir + ' (looked 3 levels deep).');
    for (const p of found) add(path.basename(p).toLowerCase(), p, 'repo');
  }
  return repos;
}
const repos = process.env.HUB_ONLY_EXTRA ? {} : buildRepos();
const extraClones = (process.env.HUB_EXTRA_CLONES || '').split(';').filter(Boolean);
const allPaths = [...Object.values(repos).flatMap((r) => Object.values(r.clones)), ...extraClones];

function commonParent(paths) {
  if (!paths.length) return '';
  const parts = paths.map((p) => path.resolve(p).split(path.sep));
  let i = 0; while (parts.every((x) => x[i] !== undefined && x[i].toLowerCase() === parts[0][i].toLowerCase())) i++;
  const out = parts[0].slice(0, i).join(path.sep);
  return out && out.length > 3 ? out : '';
}

/* ---------- values ---------- */
const organization = str(raw.organization).replace(/\/+$/, '');
const project = str(raw.project);
const ado = raw.azureDevOps && typeof raw.azureDevOps === 'object' ? raw.azureDevOps : {};
let adoHost = '';
if (organization) {
  try {
    const u = new URL(organization); adoHost = u.hostname.toLowerCase();
    if (adoHost !== 'dev.azure.com' || u.pathname.split('/').filter(Boolean).length !== 1) problems.push('organization must look like https://dev.azure.com/<name>.');
  } catch { problems.push('organization is not a valid address: ' + organization); }
}
if (organization && !project) problems.push('project is missing: set "project" to the Azure DevOps project name, or leave out "organization" to run without the board.');
const adoConfigured = !!(organization && project && ado.enabled !== false && adoHost === 'dev.azure.com');
const prefix = str(raw.branchPrefix, 'task').replace(/^\/+|\/+$/g, '');
if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(prefix)) problems.push('branchPrefix "' + prefix + '" has characters that cannot be used in a branch name.');
const workspaceRoot = rel(str(raw.workspaceRoot)) || commonParent(allPaths);
const usageCfg = raw.usage && typeof raw.usage === 'object' ? raw.usage : {};
const scoreCfg = raw.scorecard && typeof raw.scorecard === 'object' ? raw.scorecard : {};
const flowCfg = scoreCfg.flowTests || scoreCfg.localPlatform; // "localPlatform" is the old name of "flowTests" and still works
const lp = flowCfg && typeof flowCfg === 'object' ? flowCfg : null;
const HOME = os.homedir();
const title = str(raw.title, 'Engineering Hub');
// Testing phase: where the flow specs and the evidence runs are, and how a spec is rewritten for a QA repository. Everything is optional.
const tCfg = raw.testing && typeof raw.testing === 'object' ? raw.testing : {};
const qCfg = tCfg.qa && typeof tCfg.qa === 'object' ? tCfg.qa : {};
const slash = (p) => String(p || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
// Work planner settings, each with a sensible default.
const plCfg = raw.planner && typeof raw.planner === 'object' ? raw.planner : {};
const int = (v, d, lo, hi) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : d; };
const wd = Array.isArray(plCfg.workingDays) ? [...new Set(plCfg.workingDays.filter((x) => Number.isInteger(x) && x >= 0 && x <= 6))] : null;
if (Array.isArray(plCfg.workingDays) && (!wd || !wd.length)) problems.push('planner.workingDays needs at least one weekday number (0 = Sunday ... 6 = Saturday); the default Monday to Friday is used.');
// Comment watch: unread comments on the work items you follow, and who you are waiting on. Read-only against Azure DevOps, no model.
const cwCfg = raw.commentWatch && typeof raw.commentWatch === 'object' ? raw.commentWatch : {};
// Pull requests that are automated (dependency updates, tool accounts): they are shown as "Automated" and left out of "waiting for you".
const botCfg = raw.botPullRequests && typeof raw.botPullRequests === 'object' ? raw.botPullRequests : {};
const botTitleRe = (() => {
  const pats = list(botCfg.titlePatterns).length ? list(botCfg.titlePatterns) : ['^(NuGet Package Update|Npm Package Update|Bump |Dependabot)'];
  const ok = [];
  for (const p of pats) { try { new RegExp(p, 'i'); ok.push('(?:' + p + ')'); } catch { problems.push('botPullRequests.titlePatterns: "' + p + '" is not a valid pattern and is ignored.'); } }
  return new RegExp(ok.length ? ok.join('|') : '(?!)', 'i');
})();

module.exports = {
  escapeRe,
  root: ROOT,
  configFile: fileFound ? FILE : null,
  configured: fileFound,
  problems,
  title,
  brand: str(raw.brand, (() => { if (!/\s*Engineering Hub$/i.test(title)) return title; const base = title.replace(/\s*Engineering Hub$/i, '').trim(); return base ? base + ' Hub' : 'Hub'; })()), // "Acme Engineering Hub" -> "Acme Hub"; any other title is used as is
  userName: str(raw.userName, (() => { try { return os.userInfo().username; } catch { return 'me'; } })()),
  // Azure DevOps (read-only; optional)
  org: organization, // https://dev.azure.com/<name>, or '' when the board is not used
  project,
  adoConfigured,
  botPr: { repos: list(botCfg.repos), titleRe: botTitleRe },
  testing: {
    names: { source: str(tCfg.names && tCfg.names.source, 'Source specs'), qa: str(tCfg.names && tCfg.names.qa, 'QA repository') }, // how your own folders are called in the page and in the generated files
    evidenceCommand: str(tCfg.evidenceCommand), // optional: the command you run to record evidence for one spec; <spec> is replaced by the file name
    specsDir: rel(str(tCfg.specsDir)) || (lp ? rel(str(lp.flowsDir)) : ''), // the flow specs (Playwright, TypeScript)
    evidenceDir: rel(str(tCfg.evidenceDir)) || (lp ? rel(str(lp.evidenceDir)) : ''), // where your evidence runs are written
    worktreeRoot: rel(str(tCfg.worktreeRoot)),
    qa: {
      path: rel(str(qCfg.path)), // the QA automation repository clone; empty = no QA pack
      specsDir: slash(str(qCfg.specsDir, 'tests/flows')), libDir: slash(str(qCfg.libDir, 'tests/lib')), cardsDir: slash(str(qCfg.cardsDir, 'docs/flow-cards')),
      inventoryFile: slash(str(qCfg.inventoryFile, 'docs/test-inventory.md')),
      inventoryHeading: str(qCfg.inventoryHeading), inventorySummary: str(qCfg.inventorySummary), // empty = built from testing.names.source
      defaultTags: list(qCfg.defaultTags).length ? list(qCfg.defaultTags) : ['@regression'],
      importFrom: str(qCfg.importFrom, '../lib/'), importTo: str(qCfg.importTo, '../lib/'),
      serialTimeoutMs: int(qCfg.serialTimeoutMs, 180000, 1000, 3600000),
    },
  },
  commentWatch: {
    enabled: cwCfg.enabled !== false,
    pollMinutes: int(cwCfg.pollMinutes, 10, 2, 240),
    hoursFrom: int(cwCfg.hoursFrom, 7, 0, 23), hoursTo: int(cwCfg.hoursTo, 20, 1, 24), // the background check runs only between these hours
    nudgeDays: int(cwCfg.nudgeDays, 2, 1, 30), // working days before an ask without a reply is flagged
    maxWatched: int(cwCfg.maxWatched, 400, 10, 2000),
  },
  planner: {
    dayCapacity: int(plCfg.dayCapacity, 5, 1, 50), // soft limit: a day above it is flagged
    workingDays: wd && wd.length ? wd.sort() : [1, 2, 3, 4, 5],
    horizonDays: int(plCfg.horizonDays, 5, 1, 14), // working days shown as columns
    monitorEveryDays: int(plCfg.monitorEveryDays, 2, 1, 30),
    wakeAfterWorkingDays: int(plCfg.wakeAfterWorkingDays, 10, 1, 120),
    searchTypes: list(plCfg.searchTypes), // work item types a keyword search may return (empty = all)
    ai: {
      enabled: !(plCfg.ai && plCfg.ai.enabled === false),
      maxItems: int(plCfg.ai && plCfg.ai.maxItems, 30, 1, 60),
      includeDiscussion: !(plCfg.ai && plCfg.ai.includeDiscussion === false), // discussion text goes to the model unless this is false
      commentsPerItem: int(plCfg.ai && plCfg.ai.commentsPerItem, 8, 1, 20),
      analyseModel: str(plCfg.ai && plCfg.ai.analyseModel), arrangeModel: str(plCfg.ai && plCfg.ai.arrangeModel), // empty = the hub's cheap and stronger defaults
      maxBudgetUsd: plCfg.ai && Number(plCfg.ai.maxBudgetUsd) > 0 ? Number(plCfg.ai.maxBudgetUsd) : 0,
    },
  },
  adoResource: str(ado.signInAppId, '499b84ac-1321-427f-aa17-267ca6975798'), // the public Azure DevOps application id used by `az account get-access-token`
  // Branches and worktrees
  branchPrefix: prefix,
  branchPrefixEsc: escapeRe(prefix),
  branchRe: new RegExp(escapeRe(prefix) + '/(?:[a-z]+_)?(\\d{3,6})', 'i'), // <prefix>/<id>-... or <prefix>/<type>_<id>_...: group 1 is the work item id
  repoMap: { repos },
  extraClones,
  workspaceRoot,
  worktreeRoot: rel(str(raw.worktreeRoot)) || (workspaceRoot ? path.join(workspaceRoot, 'wt') : path.join(HOME, 'hub-worktrees')),
  coWorkerNames: list(raw.coWorkerNames).length ? list(raw.coWorkerNames) : ['Alice', 'Bob', 'Carol', 'Dave', 'Erin', 'Frank', 'Grace', 'Heidi'],
  // Data
  dataDir: process.env.HUB_DATA_DIR || rel(str(raw.dataDir)) || path.join(ROOT, 'data'),
  port: Number(process.env.HUB_PORT || raw.port || 4700),
  // Backups live outside the hub folder on purpose, so deleting or breaking the hub folder does not take the backups with it.
  backupDir: process.env.HUB_BACKUP_DIR || rel(str(raw.backupDir)) || path.join(HOME, 'EngineeringHub-Backups'),
  keepDailyDays: 14,
  keepWeeklyWeeks: 8,
  staleDays: 7,
  // Optional inputs for the Token usage and Workflow ratings pages: a missing one just means "no data".
  usage: { file: rel(str(usageCfg.file)) || path.join(HOME, '.claude', 'usage-dashboard', 'usage.jsonl'), hubBuildPrompt: str(usageCfg.hubBuildPrompt) },
  sessionsDir: process.env.HUB_CLAUDE_PROJECTS || rel(str(raw.sessions && raw.sessions.projectsDir)) || path.join(HOME, '.claude', 'projects'),
  learningsDir: rel(str(raw.learningsDir)),
  scorecard: {
    configFile: rel(str(scoreCfg.configFile)),
    guardFiles: list(scoreCfg.guardFiles).map(rel), settingsFiles: list(scoreCfg.settingsFiles).map(rel),
    flowsDir: lp ? rel(str(lp.flowsDir)) : '', evidenceDir: lp ? rel(str(lp.evidenceDir)) : '',
  },
};
