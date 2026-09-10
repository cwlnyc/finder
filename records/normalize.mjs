// Day/week arithmetic for public-records feeds.
//
// Socrata serves "floating timestamps" like 2026-08-14T00:00:00.000 with no zone.
// JS parses those as LOCAL time but parses a bare 2026-08-14 as UTC, so the same
// record can land on two different days depending on which form the portal emits.
// A permit issued on the 14th means the calendar day, not an instant, so every
// date here is carried as a 'YYYY-MM-DD' string and never becomes a Date.

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  return m === 2 && isLeap(y) ? 29 : DAYS_IN_MONTH[m - 1];
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

function makeDay(y, m, d) {
  if (!Number.isInteger(y) || y < 1900 || y > 2200) return null;
  if (!Number.isInteger(m) || m < 1 || m > 12) return null;
  if (!Number.isInteger(d) || d < 1 || d > daysInMonth(y, m)) return null;
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const US = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s.*)?$/;

/**
 * Normalize whatever the portal gave us to a 'YYYY-MM-DD' calendar day.
 * Returns null for empty, malformed, or impossible dates (e.g. 02/30/2026).
 */
export function parseDay(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (s === '') return null;

  const iso = ISO.exec(s);
  if (iso) return makeDay(+iso[1], +iso[2], +iso[3]);

  const us = US.exec(s);
  if (us) return makeDay(+us[3], +us[1], +us[2]);

  return null;
}

// Days since the epoch, computed from the calendar directly so no Date object
// (and therefore no local timezone) is ever involved.
function toEpochDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

function fromEpochDay(n) {
  const dt = new Date(n * 86400000);
  return makeDay(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function addDays(day, n) {
  return fromEpochDay(toEpochDay(day) + n);
}

/** Whole days from `a` to `b`; negative when b precedes a. */
export function daysBetween(a, b) {
  return toEpochDay(b) - toEpochDay(a);
}

export function compareDay(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The Monday that starts `day`'s week.
 *
 * getUTCDay() calls Sunday 0, so the naive `day - getUTCDay()` rolls Sunday
 * forward into the week that hasn't started yet and quietly splits every
 * weekend across two buckets. (dow + 6) % 7 puts Monday at 0 and Sunday at 6.
 */
export function weekStart(day) {
  const dow = new Date(toEpochDay(day) * 86400000).getUTCDay();
  return addDays(day, -((dow + 6) % 7));
}

/** Today as a calendar day, in the given IANA zone (default New York). */
export function today(timeZone = 'America/New_York', now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
