// Helper for config.test.js: loads config.js in a fresh process and prints what it decided as JSON.
try {
  const cfg = require('../config');
  const probe = process.argv[2] ? process.argv[2].split('|') : [];
  console.log(JSON.stringify({
    configured: cfg.configured, problems: cfg.problems, title: cfg.title, brand: cfg.brand, org: cfg.org, project: cfg.project, adoConfigured: cfg.adoConfigured,
    prefix: cfg.branchPrefix, branchMatches: probe.map((p) => { const m = cfg.branchRe.exec(p); return m ? m[1] : null; }),
    clones: Object.entries(cfg.repoMap.repos).map(([k, r]) => [k, r.azdoRepo, r.clones]), extra: cfg.extraClones, names: cfg.coWorkerNames,
    bot: { repos: cfg.botPr.repos, a: cfg.botPr.titleRe.test('NuGet Package Update 5'), b: cfg.botPr.titleRe.test('Fix the login page') },
    workspaceRoot: cfg.workspaceRoot, worktreeRoot: cfg.worktreeRoot, dataDir: cfg.dataDir, backupDir: cfg.backupDir, port: cfg.port, learningsDir: cfg.learningsDir,
  }));
} catch (e) { console.log(JSON.stringify({ error: e.message })); }
