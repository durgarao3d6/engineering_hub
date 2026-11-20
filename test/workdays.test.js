const HUBROOT = require('path').resolve(__dirname, '..').replace(/\\/g, '/'); require('./_config')();
// Working-day arithmetic: weekends, month and year ends, custom working weeks.
const w = require(HUBROOT + '/lib/workdays.js');
let fails = 0;
const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!ok) fails++; };

// 2026-11-20 is a Friday, 2026-11-21 Saturday, 2026-11-22 Sunday, 2026-11-23 Monday.
check('dates validate strictly', w.valid('2026-11-20') && !w.valid('2026-02-30') && !w.valid('2026-1-5') && !w.valid('x') && !w.valid('2026-13-01'));
check('addDays crosses month and year ends', w.addDays('2026-11-30', 1) === '2026-12-01' && w.addDays('2026-12-31', 1) === '2027-01-01' && w.addDays('2026-03-01', -1) === '2026-02-28' && w.addDays('2028-02-28', 1) === '2028-02-29');
check('weekdays are working days, weekends are not', w.isWorking('2026-11-20') && !w.isWorking('2026-11-21') && !w.isWorking('2026-11-22') && w.isWorking('2026-11-23'));
check('a custom week (Sunday to Thursday) works', w.isWorking('2026-11-22', [0, 1, 2, 3, 4]) && !w.isWorking('2026-11-20', [0, 1, 2, 3, 4]) && !w.isWorking('2026-11-21', [0, 1, 2, 3, 4]));
check('next 5 working days from a Friday skip the weekend', w.nextWorkingDays('2026-11-20', 5).join() === '2026-11-20,2026-11-23,2026-11-24,2026-11-25,2026-11-26');
check('from a Saturday it starts on Monday', w.nextWorkingDays('2026-11-21', 3).join() === '2026-11-23,2026-11-24,2026-11-25');
check('across a year end', w.nextWorkingDays('2026-12-30', 4).join() === '2026-12-30,2026-12-31,2027-01-01,2027-01-04');
check('asking for 0 days gives an empty list', w.nextWorkingDays('2026-11-20', 0).length === 0);
check('firstWorkingDay: Friday stays, Sunday moves to Monday', w.firstWorkingDay('2026-11-20') === '2026-11-20' && w.firstWorkingDay('2026-11-22') === '2026-11-23');
check('addWorkingDays: Friday + 1 = Monday, + 5 = next Friday', w.addWorkingDays('2026-11-20', 1) === '2026-11-23' && w.addWorkingDays('2026-11-20', 5) === '2026-11-27');
check('addWorkingDays 0 from a weekend gives the next working day', w.addWorkingDays('2026-11-21', 0) === '2026-11-23' && w.addWorkingDays('2026-11-20', 0) === '2026-11-20');
check('addWorkingDays 10 is two working weeks', w.addWorkingDays('2026-11-16', 10) === '2026-11-30');
check('workingDaysBetween counts working days after the first date', w.workingDaysBetween('2026-11-20', '2026-11-23') === 1 && w.workingDaysBetween('2026-11-20', '2026-11-27') === 5 && w.workingDaysBetween('2026-11-23', '2026-11-23') === 0 && w.workingDaysBetween('2026-11-25', '2026-11-20') === 0);
check('workingDaysBetween over a weekend only', w.workingDaysBetween('2026-11-20', '2026-11-22') === 0);
check('today() is a valid date', w.valid(w.today()));
check('daylight-saving changes do not shift dates', w.addDays('2026-03-28', 2) === '2026-03-30' && w.addDays('2026-10-24', 2) === '2026-10-26' && w.addDays('2026-11-01', 1) === '2026-11-02');

console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
process.exit(fails ? 1 : 0);
