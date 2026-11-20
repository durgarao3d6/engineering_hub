'use strict';
// Working-day arithmetic on plain local dates ('YYYY-MM-DD'). `days` lists the working weekdays, 0 = Sunday ... 6 = Saturday.
const WEEK = [1, 2, 3, 4, 5];
const parse = (s) => new Date(s + 'T12:00:00'); // noon: no daylight-saving surprises
const fmt = (d) => d.toLocaleDateString('en-CA');
const valid = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !Number.isNaN(parse(s).getTime()) && fmt(parse(s)) === s;
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return fmt(d); };
const isWorking = (s, days = WEEK) => days.includes(parse(s).getDay());
const today = () => fmt(new Date());

// The first `count` working days starting at `from` (included when it is a working day).
function nextWorkingDays(from, count, days = WEEK) {
  const out = []; let d = from; let guard = 0;
  while (out.length < count && guard++ < 400) { if (isWorking(d, days)) out.push(d); d = addDays(d, 1); }
  return out;
}
// `n` working days after `start` (n = 0 gives start itself when it is a working day, else the next working day).
function addWorkingDays(start, n, days = WEEK) {
  let d = start; let left = n; let guard = 0;
  if (!isWorking(d, days)) { while (!isWorking(d, days) && guard++ < 400) d = addDays(d, 1); }
  while (left > 0 && guard++ < 800) { d = addDays(d, 1); if (isWorking(d, days)) left--; }
  return d;
}
// Working days after `a` up to and including `b` (0 when b is not after a).
function workingDaysBetween(a, b, days = WEEK) {
  let n = 0; let d = a; let guard = 0;
  while (d < b && guard++ < 2000) { d = addDays(d, 1); if (isWorking(d, days)) n++; }
  return n;
}
// Today if it is a working day, otherwise the next one.
const firstWorkingDay = (from, days = WEEK) => nextWorkingDays(from, 1, days)[0];

module.exports = { WEEK, parse, fmt, valid, addDays, isWorking, today, nextWorkingDays, addWorkingDays, workingDaysBetween, firstWorkingDay };
