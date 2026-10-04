'use strict';

// Central (business) time + Nepal display time helpers.
// All business-day logic (entry dates, month windows, filters) uses America/Chicago.
// Display shows BOTH timezones.

const CENTRAL_TZ = 'America/Chicago';
const NEPAL_TZ = 'Asia/Kathmandu';

function tzParts(date, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}:${get('second')}`,
    datetime: `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`,
  };
}

// 'YYYY-MM-DD' business date in Central Time for a given instant (default: now)
function centralDateKey(d = new Date()) {
  return tzParts(d, CENTRAL_TZ).date;
}

// First/last Central dates of the month containing `d`
function centralMonthRange(d = new Date()) {
  const { date } = tzParts(d, CENTRAL_TZ); // YYYY-MM-DD
  const [y, m] = date.split('-').map(Number);
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const end = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { start, end, monthLabel: `${y}-${String(m).padStart(2, '0')}` };
}

// Last fully completed Central month (e.g. if now is Oct 2026 Central -> 2026-09)
function lastCompletedCentralMonth(d = new Date()) {
  const { date } = tzParts(d, CENTRAL_TZ);
  let [y, m] = date.split('-').map(Number);
  m -= 1;
  if (m < 1) { m = 12; y -= 1; }
  const mm = String(m).padStart(2, '0');
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    start: `${y}-${mm}-01`,
    end: `${y}-${mm}-${String(lastDay).padStart(2, '0')}`,
    monthLabel: `${y}-${mm}`,
  };
}

// Current Central calendar year range
function centralYearRange(d = new Date()) {
  const y = tzParts(d, CENTRAL_TZ).date.split('-')[0];
  return { start: `${y}-01-01`, end: `${y}-12-31`, year: y };
}

function isValidMonthKey(s) {
  return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

// { start, end, monthLabel } for a 'YYYY-MM' key
function monthRangeFromKey(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    start: `${monthKey}-01`,
    end: `${monthKey}-${String(lastDay).padStart(2, '0')}`,
    monthLabel: monthKey,
  };
}
function formatBoth(iso) {
  const d = new Date(iso);
  const c = tzParts(d, CENTRAL_TZ);
  const n = tzParts(d, NEPAL_TZ);
  return {
    central: { date: c.date, time: c.time, datetime: c.datetime },
    nepal: { date: n.date, time: n.time, datetime: n.datetime },
  };
}

function isValidDateKey(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s + 'T00:00:00Z').getTime());
}

module.exports = { CENTRAL_TZ, NEPAL_TZ, centralDateKey, centralMonthRange, lastCompletedCentralMonth, centralYearRange, isValidMonthKey, monthRangeFromKey, formatBoth, isValidDateKey };
