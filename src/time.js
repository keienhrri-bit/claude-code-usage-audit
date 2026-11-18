// Time zone helpers. A zone is "local", "UTC", a fixed offset ("+05:30", "UTC+8", "-0530")
// or an IANA name ("Europe/Berlin"). Everything internal is epoch milliseconds.

const DAY_MS = 86400000;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const ABS_TIME_RE = /^(\d{4}|[+-]\d{6})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:[zZ]|[+-]\d{2}:?\d{2})$/;
const OFFSET_RE = /^(?:UTC|GMT)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i;

export function makeZone(spec = 'local') {
  const s = String(spec || 'local').trim();
  if (s.toLowerCase() === 'local') {
    return {
      name: 'local',
      offsetMinutes: (ms) => -new Date(ms).getTimezoneOffset(),
    };
  }
  if (/^(utc|gmt|z)$/i.test(s)) return fixed('UTC', 0);
  const m = s.match(OFFSET_RE);
  if (m) {
    const mins = (Number(m[2]) * 60 + Number(m[3] || 0)) * (m[1] === '-' ? -1 : 1);
    return fixed(s, mins);
  }
  let dtf;
  try {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: s, hourCycle: 'h23', era: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    throw new Error(`Unknown time zone: ${s}`);
  }
  return {
    name: s,
    offsetMinutes(ms) {
      const p = Object.fromEntries(dtf.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
      const year = p.era === 'BC' ? 1 - Number(p.year) : Number(p.year);
      const asUtc = utcMillis(year, +p.month, +p.day, +p.hour, +p.minute, +p.second);
      return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
    },
  };
}

function fixed(name, mins) {
  return { name, offsetMinutes: () => mins };
}

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

// Wall-clock parts of an instant in the zone.
export function wall(zone, ms) {
  const d = new Date(ms + zone.offsetMinutes(ms) * 60000);
  return {
    y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(),
    h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(),
  };
}

export function dayKey(zone, ms) {
  const w = wall(zone, ms);
  return `${w.y}-${pad(w.mo)}-${pad(w.d)}`;
}

export function fmt(zone, ms) {
  const w = wall(zone, ms);
  return `${w.y}-${pad(w.mo)}-${pad(w.d)} ${pad(w.h)}:${pad(w.mi)}`;
}

function utcMillis(y, mo, d, h, mi, se) {
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  return date.setUTCHours(h, mi, se);
}

// Validate the calendar fields before Date can normalize an impossible date.
function checkParts(s, y, mo, d, h = 0, mi = 0, se = 0) {
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const maxDay = mo === 2 && leap ? 29 : DAYS_IN_MONTH[mo - 1];
  if (mo < 1 || mo > 12 || d < 1 || d > maxDay || h > 23 || mi > 59 || se > 59) {
    throw new Error(`Bad time: ${s} (no such date or time)`);
  }
  return utcMillis(y, mo, d, h, mi, se);
}

// Parse a time string. Strings with an explicit offset or "Z" are absolute;
// naive strings ("2026-01-05", "2026-01-05T10:00") are wall-clock time in the zone.
export function parseTime(zone, str) {
  if (str == null || str === '') return null;
  const s = String(str).trim();
  const absolute = s.match(ABS_TIME_RE);
  if (absolute) {
    const [, y, mo, d, h, mi, se = '00', fraction = ''] = absolute;
    const endOfDay = h === '24' && mi === '00' && se === '00' && !/[1-9]/.test(fraction);
    checkParts(s, +y, +mo, +d, endOfDay ? 0 : +h, +mi, +se);
    const v = Date.parse(s);
    if (Number.isNaN(v)) throw new Error(`Bad time: ${s}`);
    return v;
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) throw new Error(`Bad time: ${s} (use YYYY-MM-DD or YYYY-MM-DDTHH:MM)`);
  const asUtc = checkParts(s, +m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  if (!m[4]) return localDayStart(zone, asUtc);
  // Refine the UTC guess using the offset at that instant.
  let guess = asUtc - zone.offsetMinutes(asUtc) * 60000;
  guess = asUtc - zone.offsetMinutes(guess) * 60000;
  return guess;
}

// The surrounding offsets give the two possible instants for midnight at a clock change.
// If neither is an exact match, find the instant when the clock jumps into the new day.
function localDayStart(zone, midnight) {
  const before = midnight - zone.offsetMinutes(midnight - DAY_MS) * 60000;
  const after = midnight - zone.offsetMinutes(midnight + DAY_MS) * 60000;
  let first = Math.min(before, after);
  let last = Math.max(before, after);
  const at = (ms) => ms + zone.offsetMinutes(ms) * 60000;
  if (at(first) >= midnight) return first;
  if (at(last) === midnight) return last;
  while (last - first > 1) {
    const mid = Math.floor((first + last) / 2);
    if (at(mid) < midnight) first = mid;
    else last = mid;
  }
  return last;
}

// A bare --until date includes everything before the next local calendar day begins.
export function parseUntil(zone, str) {
  if (str == null || str === '') return null;
  const s = String(str).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const midnight = checkParts(s, +m[1], +m[2], +m[3]);
    return localDayStart(zone, midnight + DAY_MS) - 1;
  }
  return parseTime(zone, s);
}
