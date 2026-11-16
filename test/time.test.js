import test from 'node:test';
import assert from 'node:assert/strict';
import { makeZone, parseTime, parseUntil, dayKey, fmt } from '../src/time.js';

const JAN = Date.UTC(2026, 0, 5, 12, 0);
const JUL = Date.UTC(2026, 6, 5, 12, 0);

test('fixed offsets in several spellings', () => {
  assert.equal(makeZone('UTC').offsetMinutes(JAN), 0);
  assert.equal(makeZone('z').offsetMinutes(JAN), 0);
  assert.equal(makeZone('+08:00').offsetMinutes(JAN), 480);
  assert.equal(makeZone('UTC+8').offsetMinutes(JAN), 480);
  assert.equal(makeZone('GMT-3').offsetMinutes(JAN), -180);
  assert.equal(makeZone('-0530').offsetMinutes(JAN), -330);
});

test('IANA zones follow daylight saving time', () => {
  assert.equal(makeZone('Asia/Tokyo').offsetMinutes(JAN), 540);
  const ny = makeZone('America/New_York');
  assert.equal(ny.offsetMinutes(JAN), -300);
  assert.equal(ny.offsetMinutes(JUL), -240);
});

test('unknown zone is an error', () => {
  assert.throws(() => makeZone('Mars/Olympus_Mons'), /Unknown time zone/);
});

test('naive times are wall clock in the zone, explicit offsets are absolute', () => {
  const utc = makeZone('UTC');
  const cst = makeZone('+08:00');
  assert.equal(parseTime(utc, '2026-01-05'), Date.UTC(2026, 0, 5));
  assert.equal(parseTime(cst, '2026-01-05T08:00'), Date.UTC(2026, 0, 5, 0, 0));
  assert.equal(parseTime(cst, '2026-01-05 08:00:30'), Date.UTC(2026, 0, 5, 0, 0, 30));
  assert.equal(parseTime(cst, '2026-01-05T08:00:00Z'), Date.UTC(2026, 0, 5, 8, 0));
  assert.equal(parseTime(utc, '2026-01-05T08:00:00+02:00'), Date.UTC(2026, 0, 5, 6, 0));
  assert.equal(parseTime(utc, ''), null);
  assert.equal(parseTime(utc, null), null);
  assert.throws(() => parseTime(utc, '05/01/2026'), /Bad time/);
});

test('a bare --until date runs to the end of that day', () => {
  const cst = makeZone('+08:00');
  assert.equal(parseUntil(cst, '2026-01-05'), Date.UTC(2026, 0, 5, 16, 0) - 1);
  assert.equal(parseUntil(cst, '2026-01-05T10:00'), Date.UTC(2026, 0, 5, 2, 0));
});

test('day keys and formatting use the zone', () => {
  const late = Date.UTC(2026, 0, 5, 17, 30);
  assert.equal(dayKey(makeZone('UTC'), late), '2026-01-05');
  assert.equal(dayKey(makeZone('+08:00'), late), '2026-01-06');
  assert.equal(fmt(makeZone('+08:00'), late), '2026-01-06 01:30');
});
