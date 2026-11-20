// Sets HUB_CONFIG for a test run.
//  - default: the neutral fixture (example organization, throwaway everything), so tests run on any machine;
//  - HUB_LIVE_TESTS=1: the same fixture with YOUR organization and project taken from your hub.config.json, so the checks marked
//    "live" can read your real Azure DevOps board (they use work items of the author's board; adjust or ignore them elsewhere).
// Either way every test uses its own temporary data and backup folders, never yours.
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = function useTestConfig() {
  if (process.env.HUB_CONFIG) return;
  const fixture = path.join(__dirname, 'fixtures', 'hub.config.json');
  if (!process.env.HUB_LIVE_TESTS) { process.env.HUB_CONFIG = fixture; return; }
  const mine = JSON.parse(fs.readFileSync(process.env.HUB_LIVE_CONFIG || path.join(__dirname, '..', 'hub.config.json'), 'utf8'));
  const c = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  c.organization = mine.organization; c.project = mine.project;
  c.scorecard = { configFile: path.join(__dirname, 'fixtures', 'scorecard.config.json') };
  const f = path.join(os.tmpdir(), 'hub-live-config-' + process.pid + '.json');
  fs.writeFileSync(f, JSON.stringify(c));
  process.env.HUB_CONFIG = f;
  process.on('exit', () => { try { fs.unlinkSync(f); } catch { /* temp */ } });
};
