const HUBROOT = require('path').resolve(__dirname, '..').replace(/\\/g, '/'); require('./_config')(); // neutral settings (HUB_LIVE_TESTS=1 uses your own settings and board for the checks marked live)
process.env.HUB_BACKUP_DIR = process.env.HUB_BACKUP_DIR || require('path').join(require('os').tmpdir(), 'hub-test-backups-' + process.pid); process.on('exit', () => { try { require('fs').rmSync(process.env.HUB_BACKUP_DIR, { recursive: true, force: true }); } catch { /* temp */ } }); // tests never write into your real backup folder
// Worktree linking in the planner: multi-repo auto-link, AI suggestions, validation, rules mode, code context in drafts. Stub CLI, no network.
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plantwt-'));
process.env.HUB_DATA_DIR = dir;
process.env.HUB_CLAUDE_BIN = HUBROOT + '/test/stub-claude.js';
process.env.STUB_LOG = path.join(dir, 'calls.log');
process.env.STUB_MODE = 'ok';
const planner = require(HUBROOT + '/planner.js');

const pool = [
  { id: 5945, type: 'Bug', state: 'Active', title: 'Sample: Address line autolist displays duplicate entries', repos: ['portal'] },
  { id: 8246, type: 'User Story', state: 'Active', title: 'Dynamic menu and user profile integration for Customer Portal', repos: ['portal', 'platformsecurity'] },
];
const wts = [
  { path: 'E:\\wt\\portal\\alice-5945', repoKey: 'portal', layer: 'ui', branch: 'dev/5945-address-autolist', taskId: 5945, isMain: false, where: 'Uncommitted in worktree', dirtyFiles: 3, lastCommit: { subject: 'wip autolist' } },
  { path: 'E:\\Backend\\PlatformSecurity', repoKey: 'platformsecurity', layer: 'backend', branch: 'dev/5945-security-lookup', taskId: 5945, isMain: true, where: 'Live checkout', dirtyFiles: 1, lastCommit: { subject: 'lookup' } },
  { path: 'E:\\UI\\Order\\alice-responsive_poc', repoKey: 'order', layer: 'ui', branch: 'dev/responsive_poc', taskId: null, isMain: false, where: 'Uncommitted in worktree', dirtyFiles: 57, lastCommit: { subject: 'responsive layout' } },
  { path: 'E:\\Backend\\Portal', repoKey: 'portal', layer: 'backend', branch: 'main', taskId: null, isMain: true, where: 'Live checkout', dirtyFiles: 0 },
];
const ctxCalls = [];
const contextFn = async (list) => { ctxCalls.push(list.map((w) => w.repoKey)); return list.map((w) => ({ repoKey: w.repoKey, layer: w.layer, branch: w.branch, commits: ['a commit subject'], committedFiles: ['src/' + w.repoKey + '/File.cs'], uncommittedFiles: [] })); };
let fails = 0;
const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!ok) fails++; };
const calls = () => (fs.existsSync(process.env.STUB_LOG) ? fs.readFileSync(process.env.STUB_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

(async () => {
  console.log('--- automatic links by task id (one task, several repos)');
  planner.clearCache();
  let p = await planner.propose('Work on #5945 address autolist\nMake the responsive layout changes\nWrite the quotes retry handling', { pool, worktrees: wts, contextFn });
  const a = p.items[0];
  check('line with a work item links every worktree whose branch carries its id', a.taskId === 5945 && a.worktrees.length === 2, a.worktrees.map((w) => w.repoKey + ':' + w.source).join(','));
  check('both repos are present (UI worktree + backend live checkout)', ['portal', 'platformsecurity'].every((r) => a.worktrees.some((w) => w.repoKey === r)));
  check('automatic links are marked as task links', a.worktrees.every((w) => w.source === 'task'));
  check('link carries the live state of each worktree', a.worktrees[0].dirtyFiles === 3 && a.worktrees[0].where === 'Uncommitted in worktree');

  console.log('--- the assistant suggests a worktree for a line with no work item');
  const b = p.items[1];
  check('unmatched line gets the responsive worktree from the assistant', !b.taskId && b.worktrees.length === 1 && b.worktrees[0].repoKey === 'order' && b.worktrees[0].source === 'ai', JSON.stringify(b.worktrees.map((w) => w.branch + ':' + w.source)));
  const c = p.items[2];
  check('line with nothing matching has no worktree (the user is offered a picker)', c.worktrees.length === 0);
  check('live checkout on main is never offered', !p.items.some((i) => i.worktrees.some((w) => w.branch === 'main')));
  const cl = calls();
  check('the model was given the worktree list as quoted data', /<worktrees>\n\[/.test(cl[0].prompt) && /"branch":"dev\/responsive_poc"/.test(cl[0].prompt));
  check('worktree numbers shown to the model skip main', !/"branch":"main"/.test(cl[0].prompt));

  console.log('--- drafts get the code context');
  check('context was read only for the lines that need a draft and have worktrees', ctxCalls.length === 1 && ctxCalls[0].join() === 'order', JSON.stringify(ctxCalls));
  const draftCall = cl.find((x) => x.kind === 'draft');
  check('draft prompt carries a <code> block with the linked worktree', draftCall && /<code>\n/.test(draftCall.prompt) && /responsive_poc/.test(draftCall.prompt));
  check('the draft uses the code context', /Context repos: order/.test(b.draft.body), b.draft.body.slice(0, 140));
  check('a line with no worktree gets a plain draft without context', c.draft && !/Context repos/.test(c.draft.body));

  console.log('--- hallucinated worktree number');
  planner.clearCache();
  p = await planner.propose('Do the bogus-worktree thing', { pool, worktrees: wts, contextFn });
  check('number outside the list is dropped', p.items[0].worktrees.length === 0);
  check('the user is told', p.notes.some((n) => /worktree suggestion/.test(n)), p.notes.join(' | '));

  console.log('--- rules mode links by keywords');
  planner.clearCache();
  p = await planner.propose('Finish the responsive poc layout for order', { pool, worktrees: wts, mode: 'rules' });
  check('keyword overlap with the branch name links it, marked as rules', p.items[0].worktrees.length === 1 && p.items[0].worktrees[0].source === 'rules', JSON.stringify(p.items[0].worktrees.map((w) => w.branch + ':' + w.source)));
  p = await planner.propose('Work on #8246 menu', { pool, worktrees: wts, mode: 'rules' });
  check('a work item with no matching branch has no worktree', p.items[0].taskId === 8246 && p.items[0].worktrees.length === 0);

  console.log('--- many repos are capped, review and meeting lines are not linked');
  const many = Array.from({ length: 9 }, (_, i) => ({ path: 'E:\\r' + i, repoKey: 'repo' + i, layer: 'ui', branch: 'dev/5945-part' + i, taskId: 5945, isMain: false, dirtyFiles: 0 }));
  planner.clearCache();
  p = await planner.propose('Work on #5945\nReview PR 9820 responsive\n11am standup', { pool, worktrees: many, contextFn });
  check('at most 6 worktrees per line', p.items[0].worktrees.length === 6, String(p.items[0].worktrees.length));
  check('review and meeting lines get no worktrees', p.items[1].worktrees.length === 0 && p.items[2].worktrees.length === 0);

  console.log('--- redraft with code context');
  const r = await planner.redraft('Make the responsive layout changes', [wts[2], wts[0]], { pool, contextFn });
  check('redraft returns a draft that uses both repos', /Context repos: order,portal/.test(r.draft.body) && r.usage.calls === 1, r.draft.body.slice(0, 100));
  let err = null; try { await planner.redraft('  ', [], { pool, contextFn }); } catch (e) { err = e; }
  check('empty line rejected', err && err.status === 400);

  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); console.log('temp ' + dir); process.exit(1); });
