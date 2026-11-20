'use strict';
// Daily plan score. Pure function so the formula is visible and testable. The weights are shown on the Workflow ratings page.
//   adherence  = done / (planned - dropped-with-a-reason)       how much of the plan was finished
//   coverage   = task lines with a work item / task lines        planning against real work items
//   carry-over = lines pushed to tomorrow / planned
//   score      = 60% adherence + 30% coverage + 10% (1 - carry-over)
const WEIGHTS = { adherence: 0.6, coverage: 0.3, carry: 0.1 };

function dayScore(items, { carriedIds = [], unplanned = [] } = {}) {
  const carried = new Set(carriedIds);
  const planned = items.length;
  const done = items.filter((i) => i.status === 'done').length;
  const dropped = items.filter((i) => i.status === 'skipped').length;
  const carriedN = items.filter((i) => carried.has(i.id) && i.status === 'todo').length;
  const taskLines = items.filter((i) => i.kind === 'task');
  const withItem = taskLines.filter((i) => i.taskId).length;
  const adherence = planned - dropped > 0 ? done / (planned - dropped) : 1;
  const coverage = taskLines.length ? withItem / taskLines.length : 1;
  const carry = planned ? carriedN / planned : 0;
  const score = Math.round(100 * (WEIGHTS.adherence * adherence + WEIGHTS.coverage * coverage + WEIGHTS.carry * (1 - carry)));
  const pct = (x) => Math.round(100 * x);
  return { score, planned, done, dropped, carried: carriedN, taskLines: taskLines.length, withWorkItem: withItem, missingWorkItems: taskLines.length - withItem,
    adherence: pct(adherence), coverage: pct(coverage), carryRate: pct(carry), unplanned: unplanned.slice(0, 8), weights: WEIGHTS };
}

module.exports = { dayScore, WEIGHTS };
