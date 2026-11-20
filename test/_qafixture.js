// A throwaway the source suite-like specs folder and QA-like repository, shared by the testing tests. Nothing here is real.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const HUBROOT = path.resolve(__dirname, '..').replace(/\\/g, '/');
const T = require(HUBROOT + '/testing.js');
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const qa = { importFrom: '../lib/', importTo: '../../shared/flows/', serialTimeoutMs: 180000, specsDir: 'tests/flows', libDir: 'shared/flows', cardsDir: 'docs/flow-cards', inventoryFile: 'docs/test-inventory.md', defaultTags: ['@regression', '@flows', '@api'] };
function build(dir) {
  /* ---------- fixtures: a the source suite-like specs folder and a QA-like repository ---------- */
  const HEAD_IMPORTS = "import { expect, test } from '@playwright/test';\nimport { Api } from '../lib/api';\nimport { Status } from '../lib/platform';\nimport { covers } from '../lib/spec';\n";
  const BT = String.fromCharCode(96);
  const spec1 = HEAD_IMPORTS + `
  /**
   * Flow 1: cancelling a loaded transport is refused (PlatformSpec 7.3). It uses a transport the platform already holds and never makes one, so every run leaves nothing behind.
   *
   * API only: no Azure Maps key is needed.
   */
  let api: Api;
  test.beforeAll(async () => (api = await Api.create()));
  
  test(
    '[PCX-4 CAN-10] Cancelling a transport that carries freight is refused with 409',
    covers('PlatformSpec 7.3 X2; TP spec 14.12 CAN-10', 'PCX-4', 'CAN-10'),
    async () => {
      const loaded = await test.step('Find a live transport that carries freight', async () => {
        const r = await api.get('tp', '/transports');
        expect(r.status).toBe(200);
        test.skip(!r, 'no live transport carrying freight exists on this platform');
        return r;
      });
      const r = await test.step(${BT}PUT /transports with status Cancelled for \${loaded.number}${BT}, () => api.put('tp', '/transports', { id: loaded.id }));
      await test.step('TP refuses with 409', async () => {
        expect(r.status).toBe(409);
        expect(r.body.detail, 'the refusal says why').toContain('freight must be reallocated first');
      });
    },
  );
  `;
  const spec2 = HEAD_IMPORTS + "\n/** Flow 2: edited by QA or newer in the source suite. */\ntest(\n  '[A-1] Second flow',\n  covers(\n    'Spec 1.1',\n    'A-1',\n  ),\n  async () => {\n    await test.step('Do the thing', async () => { expect(1).toBe(1); });\n  },\n);\n";
  const spec3 = HEAD_IMPORTS + "\n/** Flow 3: not in QA yet. */\ntest('[B-2] Third flow', covers('Spec 2', 'B-2'), async () => {\n  await test.step('Check it', async () => { expect(2).toBeGreaterThan(1); });\n});\n";
  const spec4 = "import { test } from '@playwright/test';\nimport { gremlin } from '../lib/gremlin';\nimport { covers } from '../lib/spec';\n\n/** Flow 4: reads the graph directly. */\ntest('[C-3] Graph flow', covers('Spec 3', 'C-3'), async () => { await gremlin('g.V()'); });\n";
  const spec5 = HEAD_IMPORTS.replace("{ Status }", "{ Status, brandNewHelper }") + "\n/** Flow 5: needs a helper QA does not have. */\ntest('[D-4] Newer helper flow', covers('Spec 4', 'D-4'), async () => { brandNewHelper(); });\n";
  const spec6 = "import { test } from '@playwright/test';\nimport { covers } from '../lib/spec';\n\n/** Flow 7: browser flow. */\ntest('[E-5] UI flow', covers('Spec 5', 'E-5'), async ({ page }) => { await page.goto('/'); });\n";
  const spec7 = HEAD_IMPORTS + "\n/**\n * Bug AB#9001: something is wrong.\n */\ntest(\n  '[AB#9001] The thing is wrong',\n  { annotation: [productIssue('AB#9001: wrong thing')] },\n  async () => {\n    await test.step('Look', async () => { expect(1).toBe(1); });\n  },\n);\n";
  const LP = path.join(dir, 'lp'); const LPS = path.join(LP, 'tests', 'flows', 'specs'); const LPL = path.join(LP, 'tests', 'flows', 'lib');
  w(path.join(LPS, '01-cancel.spec.ts'), spec1); w(path.join(LPS, '02-edited.spec.ts'), spec2); w(path.join(LPS, '03-new.spec.ts'), spec3); w(path.join(LPS, '04-graph.spec.ts'), spec4);
  w(path.join(LPS, '05-newer-helper.spec.ts'), spec5); w(path.join(LPS, '06-browser.ui.spec.ts'), spec6); w(path.join(LPS, 'bug-9001-thing.spec.ts'), spec7);
  for (const [n, t] of Object.entries({ api: 'export class Api {}\nexport const sleep = 1;\n', platform: 'export enum Status { A }\nexport const X = 1;\n', spec: 'export function covers(t: string[], s: string) { return {}; }\nexport const productIssue = (d: string) => ({ d });\n', gremlin: 'export async function gremlin() {}\n' })) w(path.join(LPL, n + '.ts'), t);
  const OLD = { GIT_COMMITTER_DATE: '2020-01-01T00:00:00', GIT_AUTHOR_DATE: '2020-01-01T00:00:00' };
  const run = (cwd, env, ...a) => execFileSync('git', a, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g(LP, 'init', '-q', '-b', 'main'); run(LP, OLD, 'add', '.'); run(LP, OLD, 'commit', '-q', '-m', 'lp old'); // everything old, then 02 changes later
  w(path.join(LPS, '02-edited.spec.ts'), spec2 + '// newer in the source suite\n'); run(LP, { GIT_COMMITTER_DATE: '2030-01-01T00:00:00', GIT_AUTHOR_DATE: '2030-01-01T00:00:00' }, 'commit', '-qam', 'lp newer');
  
  const QAO = path.join(dir, 'qa-origin.git'); g(dir, 'init', '--bare', '-b', 'main', QAO);
  const QAS = path.join(dir, 'qa-seed'); g(dir, 'clone', '-q', QAO, QAS);
  const ported = (t, tags) => T.portText(t, qa, tags);
  w(path.join(QAS, 'tests/flows/01-cancel.spec.ts'), ported(spec1, ['@regression', '@transport-management', '@api']));
  w(path.join(QAS, 'tests/flows/02-edited.spec.ts'), ported(spec2 + '', ['@regression', '@api']) + '// QA edited this copy by hand\n');
  w(path.join(QAS, 'tests/flows/bug-9001-thing.spec.ts'), ported(spec7, ['@regression', '@order', '@api']));
  for (const n of ['api', 'platform', 'spec']) w(path.join(QAS, 'shared/flows/' + n + '.ts'), fs.readFileSync(path.join(LPL, n + '.ts'), 'utf8').replace(', brandNewHelper', ''));
  w(path.join(QAS, 'shared/flows/platform.ts'), 'export enum Status { A }\nexport const X = 2;\n'); // QA's copy of platform differs
  w(path.join(QAS, 'docs/test-inventory.md'), '# QA\r\n\r\n### [4350] USG\r\n\r\n| Module | File | Test Case | Status |\r\n|--------|------|-----------|--------|\r\n| `a/` | `a.spec.ts` | A | Active |\r\n\r\n### Inventory Summary\r\n\r\n| USG | Test Cases | Skipped |\r\n|-----|-----------|---------|\r\n| [4350] API | 1 | 0 |\r\n| **Total** | **1** | **0** |\r\n\r\n> Note\r\n');
  w(path.join(QAS, 'README.md'), 'qa\n'); w(path.join(QAS, '.env'), 'SECRET=do-not-read\n');
  g(QAS, 'add', '-A'); run(QAS, { GIT_COMMITTER_DATE: '2025-01-01T00:00:00', GIT_AUTHOR_DATE: '2025-01-01T00:00:00' }, 'commit', '-q', '-m', 'qa initial'); g(QAS, 'push', '-q', 'origin', 'HEAD:main');
  const QA = path.join(dir, 'qa'); g(dir, 'clone', '-q', QAO, QA);
  const evid = path.join(dir, 'evidence'); w(path.join(evid, '20261105-1030-alice-01-cancel', 'summary.md'), '# Evidence: specs/01-cancel.spec.ts\n- Co-worker: Alice\n- Service: orders-api (registry image: acr/x:dev)\n- Code under test: C:\\secret\\local\\path\n- Spec source: main the source suite checkout\n- Before (registry image): FAILED (exit 1)  - before.log\n- After (built from the code): PASSED  - after.log\n- Verdict: **EVIDENCE OK - fails before the fix, passes after**\n- Restored to the registry image afterwards.\n');
  w(path.join(evid, '20261106-0900-alice-02-edited', 'summary.md'), '# Evidence: specs/02-edited.spec.ts\n- Co-worker: Alice\n- Service: web-ui (registry image: a)\n- Before (registry image): PASSED  - before.log\n- After (built from the code): PASSED  - after.log\n- Verdict: **INCONCLUSIVE - the spec already passes without the fix; it does not reproduce the bug**\n');
  
  
  return { LP, LPS, LPL, QA, QAO, evid, qa, specs: { spec1, spec2, spec3, spec4, spec5, spec6, spec7 } };
}
module.exports = { build, qa };
