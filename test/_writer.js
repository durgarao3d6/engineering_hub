// Helper for datasafety.test.js: a second process that writes to the same database through the store (concurrency test).
//   node _writer.js <count> <tag> [plans]   with "plans" every loop saves a plan (a read-then-write transaction), the path that can fail under contention
const store = require('../store.js');
const n = Number(process.argv[2] || 100); const tag = process.argv[3] || 'w'; const heavy = process.argv[4] === 'plans';
for (let i = 0; i < n; i++) {
  if (heavy) { store.planSave('2026-11-19', 'raw ' + tag, [{ text: tag + ' line ' + i, kind: 'task' }]); continue; }
  store.noteAdd(1000 + (i % 7), 'Findings', tag + ' note ' + i, tag);
  if (i % 25 === 0) store.planSave('2026-11-19', 'raw', [{ text: tag + ' line ' + i, kind: 'task' }]);
}
console.log('done ' + tag);
