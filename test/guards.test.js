const HUBROOT = require('path').resolve(__dirname, '..').replace(/\\/g, '/'); require('./_config')(); // neutral settings (HUB_LIVE_TESTS=1 uses your own settings and board for the checks marked live)
process.env.HUB_BACKUP_DIR = process.env.HUB_BACKUP_DIR || require('path').join(require('os').tmpdir(), 'hub-test-backups-' + process.pid); process.on('exit', () => { try { require('fs').rmSync(process.env.HUB_BACKUP_DIR, { recursive: true, force: true }); } catch { /* temp */ } }); // tests never write into your real backup folder
// Proves the hub (and the AI planner) cannot change anything in Azure DevOps. No network is used.
const fs = require('fs');
const os = require('os');
const path = require('path');
const HUB = HUBROOT;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardtest-'));
process.env.HUB_DATA_DIR = dir;
process.env.HUB_CLAUDE_BIN = HUB + '/test/stub-claude.js';
process.env.STUB_LOG = path.join(dir, 'calls.log');
process.env.STUB_MODE = 'ok';
// Credentials that must never reach the model's process:
Object.assign(process.env, { AZURE_DEVOPS_EXT_PAT: 'secret-pat', ADO_TOKEN: 'secret', AZDO_PERSONAL_ACCESS_TOKENS: 'secret', SYSTEM_ACCESSTOKEN: 'secret', AZURE_CLIENT_SECRET: 'secret' });
const { ado, checkRequest } = require(HUB + '/collectors/ado.js');
const planner = require(HUB + '/planner.js');

let fails = 0;
const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!ok) fails++; };
const blocked = (m, u, b) => { try { checkRequest(m, u, b); return false; } catch (e) { return e.code === 'READ_ONLY'; } };
const allowed = (m, u, b) => { try { checkRequest(m, u, b); return true; } catch { return false; } };
const O = require(HUB + '/config.js').org || 'https://dev.azure.com/example-org'; const ORG = O.split('/').pop(); // the organization from the settings in use

(async () => {
  console.log('--- request filter');
  check('GET a work item is allowed', allowed('GET', O + '/Sample/_apis/wit/workitems/8246?api-version=7.1'));
  check('GET pull requests is allowed', allowed('GET', O + '/Sample/_apis/git/pullrequests?searchCriteria.status=active'));
  check('GET connectionData is allowed', allowed('GET', O + '/_apis/connectionData?api-version=7.1-preview'));
  check('WIQL search (POST) is allowed', allowed('POST', O + '/Sample/_apis/wit/wiql?$top=10', { query: "SELECT [System.Id] FROM workitems WHERE [System.State]='New'" }));
  check('batch read (POST) is allowed', allowed('POST', O + '/Sample/_apis/wit/workitemsbatch?api-version=7.1', { ids: [1, 2], fields: ['System.Title'], errorPolicy: 'Omit' }));
  check('PATCH a work item is blocked', blocked('PATCH', O + '/Sample/_apis/wit/workitems/8246'));
  check('PUT is blocked', blocked('PUT', O + '/Sample/_apis/wit/workitems/8246'));
  check('DELETE is blocked', blocked('DELETE', O + '/Sample/_apis/wit/workitems/8246'));
  check('POST that would create a work item is blocked', blocked('POST', O + '/Sample/_apis/wit/workitems/$Task?api-version=7.1', [{ op: 'add', path: '/fields/System.Title', value: 'x' }]));
  check('POST a work item comment is blocked', blocked('POST', O + '/Sample/_apis/wit/workItems/8246/comments', { text: 'hello' }));
  check('POST a pull request comment thread is blocked', blocked('POST', O + '/Sample/_apis/git/repositories/r/pullRequests/1/threads', { comments: [{ content: 'x' }] }));
  check('POST to create or vote on a pull request is blocked', blocked('POST', O + '/Sample/_apis/git/repositories/r/pullrequests', { title: 'x' }) && blocked('POST', O + '/Sample/_apis/git/repositories/r/pullRequests/1/reviewers/me', { vote: 10 }));
  check('POST a batch that carries a JSON patch is blocked', blocked('POST', O + '/Sample/_apis/wit/workitemsbatch', [{ op: 'add', path: '/fields/System.Title', value: 'x' }]));
  check('batch with an unexpected field is blocked', blocked('POST', O + '/Sample/_apis/wit/workitemsbatch', { ids: [1], operations: [{ op: 'add' }] }));
  check('WIQL that is not a SELECT is blocked', blocked('POST', O + '/Sample/_apis/wit/wiql', { query: 'DELETE FROM workitems' }));
  check('POST with no body is blocked', blocked('POST', O + '/Sample/_apis/wit/wiql'));
  check('a GET carrying a body is blocked', blocked('GET', O + '/Sample/_apis/wit/workitems/1', { x: 1 }));
  check('another host is blocked', blocked('GET', 'https://evil.example/' + ORG + '/Sample/_apis/wit/workitems/1'));
  check('another organization is blocked', blocked('GET', 'https://dev.azure.com/someoneelse/Sample/_apis/wit/workitems/1'));
  check('plain http is blocked', blocked('GET', 'http://dev.azure.com/' + ORG + '/Sample/_apis/wit/workitems/1'));
  check('lookalike host is blocked', blocked('GET', 'https://dev.azure.com.evil.example/' + ORG + '/Sample/_apis/wit/workitems/1'));

  console.log('--- the client itself refuses before any network call');
  const refused = async (...a) => { try { await ado(...a); return false; } catch (e) { return e.code === 'READ_ONLY'; } };
  check('ado() refuses a create even when asked politely', await refused('_apis/wit/workitems/$Task?api-version=7.1', { op: 'add' }));
  check('ado() refuses a foreign address', await refused('https://evil.example/x'));
  check('ado() cannot be told which method to use: it is GET without a body and POST with one, nothing else', /const method = body \? 'POST' : 'GET'/.test(fs.readFileSync(HUB + '/collectors/ado.js', 'utf8')) && ado.length <= 3);

  console.log('--- source scan: no write path exists anywhere in the hub');
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (['node_modules', 'data', 'test', 'ui'].includes(e.name)) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) files.push(p); } };
  walk(HUB);
  const src = new Map(files.map((f) => [path.relative(HUB, f).split(path.sep).join('/'), fs.readFileSync(f, 'utf8')]));
  const names = [...src.keys()];
  check('scanned the hub source', names.length >= 8, names.join(', '));
  const fetchers = [...names, 'bin/hub.js', 'hooks/session-start.js', 'hooks/stop-reminder.js'].filter((n, i, a) => a.indexOf(n) === i && fs.existsSync(HUB + '/' + n)).map((n) => [n, src.get(n) || fs.readFileSync(HUB + '/' + n, 'utf8')]).filter(([, s]) => /\bfetch\(/.test(s));
  const fetchArgs = (src) => [...src.matchAll(/\bfetch\(\s*([^,)]*)/g)].map((m) => m[1]);
  const others = fetchers.filter(([n]) => n !== 'collectors/ado.js');
  check('only collectors/ado.js sends requests to Azure DevOps (no other fetch() names dev.azure.com or any non-local address)', fetchers.some(([n]) => n === 'collectors/ado.js') && others.every(([, s]) => fetchArgs(s).every((a) => !/dev\.azure\.com/.test(a) && !/https?:\/\/(?!127\.0\.0\.1)/.test(a))), fetchers.map(([n]) => n).join());
  check('every other file that calls fetch() talks only to the hub on this machine (127.0.0.1)', others.every(([, s]) => fetchArgs(s).every((a) => /127\.0\.0\.1/.test(a) || (/^BASE\b/.test(a) && /BASE = 'http:\/\/127\.0\.0\.1/.test(s)))), others.map(([n]) => n).join());
  check('no PATCH, PUT or DELETE request anywhere', names.every((n) => !/method\s*:\s*['"`](PATCH|PUT|DELETE)['"`]/i.test(src.get(n))));
  check('no az boards/repos/devops write command anywhere', names.every((n) => !/\baz\b[^\n]*\b(boards|repos|devops|pipelines)\b[^\n]*\b(create|update|delete|add|remove|set|abandon|complete|approve|vote)\b/i.test(src.get(n))));
  const azCalls = names.filter((n) => /['"]az['"]/.test(src.get(n)));
  const setupAz = (src.get('bin/setup.js') || '').match(/['"]az['"]/g) || [];
  const setupAzOk = setupAz.length > 0 && setupAz.length === ((src.get('bin/setup.js') || '').match(/run\('az', \['--version'\]/g) || []).length;
  check('az is used only for the sign-in token in ado.js (and bin/setup.js only asks for its version)', azCalls.filter((n) => n !== 'bin/setup.js').join() === 'collectors/ado.js' && /get-access-token/.test(src.get('collectors/ado.js')) && (!azCalls.includes('bin/setup.js') || setupAzOk), azCalls.join());
  const posts = [];
  for (const n of names) for (const m of src.get(n).matchAll(/\bado\(\s*([`'"])([^`'"]+)\1\s*,/g)) posts.push(n + ': ' + m[2]);
  check('every ado() call that sends a body targets a read-only search', posts.length > 0 && posts.every((p) => /wiql|workitemsbatch/.test(p)), posts.join(' | '));
  check('ai.js never touches the Azure DevOps client', !/ado\b/.test(src.get('ai.js').replace(/\badoption/gi, '')));
  check('planner.js uses only fetchDetail (a GET) from the Azure DevOps side', /require\('\.\/collectors\/tasks'\)/.test(src.get('planner.js')) && !/collectors\/ado/.test(src.get('planner.js')) && !/\bado\(/.test(src.get('planner.js')));
  check('the model is started with no tools and no MCP servers', /'--tools', ''/.test(src.get('ai.js')) && /--strict-mcp-config/.test(src.get('ai.js')));

  console.log('--- reading code context can never change a repo');
  const ctxSrc = src.get('collectors/wtcontext.js') || '';
  const gitVerbs = [...ctxSrc.matchAll(/gitx\([^,]+,\s*\[\s*'([a-z-]+)'/g)].map((m) => m[1]);
  check('wtcontext.js runs only rev-parse, log, diff and status', gitVerbs.length >= 4 && gitVerbs.every((v) => ['rev-parse', 'log', 'diff', 'status'].includes(v)), gitVerbs.join(','));
  check('wtcontext.js names no write verb anywhere', !/'(checkout|reset|stash|commit|push|pull|fetch|merge|rebase|clean|add|rm|apply|worktree|branch|restore|switch)'/.test(ctxSrc));
  check('planner.js reaches git only through wtcontext', /require\('\.\/collectors\/wtcontext'\)/.test(src.get('planner.js')) && !/gitx|execFile|spawn/.test(src.get('planner.js')));

  console.log('--- stashes: only the stash manager and the mover change a repo');
  const infoSrc = src.get('collectors/stashinfo.js') || '';
  const infoVerbs = [...infoSrc.matchAll(/(?:gitx|git)\([^,]+,\s*\[\s*'([a-z-]+)'/g)].map((m) => m[1]);
  check('stashinfo.js runs only stash list, rev-parse, diff, ls-tree, merge-tree, merge-base, show', infoVerbs.length >= 6 && infoVerbs.every((v) => ['stash', 'rev-parse', 'diff', 'ls-tree', 'merge-tree', 'merge-base', 'show'].includes(v)), [...new Set(infoVerbs)].join(','));
  check('stashinfo.js only lists stashes (never drop, apply, pop, store, push, clear)', [...infoSrc.matchAll(/\[\s*'stash',\s*'([a-z-]+)'/g)].every((m) => m[1] === 'list') && !/'(update-ref|worktree|checkout|reset|commit|push|pull|fetch|merge|rebase|clean|add|rm|apply|branch|restore|switch)'/.test(infoSrc));
  const writers = names.filter((n) => /'(drop|store)'|\[\s*'update-ref'|'worktree',\s*'add'|'stash',\s*'(apply|pop|push|clear)'/.test(src.get(n)));
  check('stash drop/store, update-ref and worktree add appear only in stashmgr.js and mover.js', writers.every((n) => ['stashmgr.js', 'mover.js'].includes(n)) && writers.includes('stashmgr.js'), writers.join());
  check('stashmgr.js never pushes, commits or fetches', !/'(push|commit|fetch|pull|merge|rebase|reset|checkout|clean)'/.test(src.get('stashmgr.js')));
  check('sessions.js only reads files (no write, no network, no git)', !/writeFileSync|appendFileSync|unlinkSync|rmSync|fetch\(|child_process|execFile|spawn/.test(src.get('sessions.js')));

  console.log('--- the ratings only read');
  const scSrc = src.get('scorecard.js') || '';
  const scVerbs = [...scSrc.matchAll(/gitx\([^,]+,\s*\[\s*'([a-z-]+)'/g)].map((m) => m[1]);
  check('scorecard.js runs only git log and git config', scVerbs.length >= 2 && scVerbs.every((v) => ['log', 'config'].includes(v)), scVerbs.join(','));
  check('scorecard.js names no git write verb', !/'(checkout|reset|stash|commit|push|pull|fetch|merge|rebase|clean|add|rm|apply|worktree|branch|restore|switch)'/.test(scSrc));
  check('scorecard.js only reads the Azure DevOps hooks settings as text and never writes outside the hub data folder', !/writeFileSync\((?!RESULT_FILE|tmp)/.test(scSrc.replace(/const tmp = RESULT_FILE \+ '\.tmp'; fs\.writeFileSync\(tmp/, '')));
  check('the command-line tool and hooks never open the database', ['bin/hub.js', 'hooks/session-start.js', 'hooks/stop-reminder.js', 'lib/format.js', 'lib/task.js'].every((f) => { try { return !/DatabaseSync|require\('\.\.\/store'\)|require\('\.\/store'\)/.test(fs.readFileSync(HUB + '/' + f, 'utf8')); } catch { return false; } }));

  console.log('--- the model process gets no Azure credentials');
  const pool = [{ id: 5945, type: 'Bug', state: 'Active', title: 'Sample: Address line autolist displays duplicate entries', repos: ['portal'] }];
  const p = await planner.propose('Fix the address autolist duplicate entries bug\nA brand new thing nobody has filed', { pool });
  const calls = fs.readFileSync(process.env.STUB_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  check('the planner ran through the stub (parse + draft)', p.engine === 'ai' && calls.length === 2);
  check('the hub process itself had the credentials set (so the test is meaningful)', !!process.env.AZURE_DEVOPS_EXT_PAT && !!process.env.SYSTEM_ACCESSTOKEN);
  check('the model process saw none of them', calls.every((c) => c.azureEnv.length === 0), JSON.stringify(calls.map((c) => c.azureEnv)));

  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  // The database file is still open in this process (Windows will not delete it yet), so a helper removes the folder just after we exit.
  require('child_process').spawn(process.execPath, ['-e', "setTimeout(() => { try { require('fs').rmSync(process.argv[1], { recursive: true, force: true }); } catch {} }, 1500)", dir], { detached: true, stdio: 'ignore' }).unref();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
