// Time zone helpers. A zone is "local", "UTC", a fixed offset ("+05:30", "UTC+8", "-0530")
// or an IANA name ("Europe/Berlin"). Everything internal is epoch milliseconds.

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
      timeZone: s, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    throw new Error(`Unknown time zone: ${s}`);
  }
  return {
    name: s,
    offsetMinutes(ms) {
      const p = Object.fromEntries(dtf.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
      const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
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

// Date.UTC rolls 2026-02-30 over to March 2; reject such dates and times instead.
function checkParts(s, y, mo, d, h = 0, mi = 0, se = 0) {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, se);
  const v = new Date(asUtc);
  if (v.getUTCFullYear() !== y || v.getUTCMonth() !== mo - 1 || v.getUTCDate() !== d || h > 23 || mi > 59 || se > 59) {
    throw new Error(`Bad time: ${s} (no such date or time)`);
  }
  return asUtc;
}

// Parse a time string. Strings with an explicit offset or "Z" are absolute;
// naive strings ("2026-01-05", "2026-01-05T10:00") are wall-clock time in the zone.
export function parseTime(zone, str) {
  if (str == null || str === '') return null;
  const s = String(str).trim();
  if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(s) && /\d{4}-\d{2}-\d{2}T/.test(s)) {
    const p = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
    if (p) checkParts(s, +p[1], +p[2], +p[3], +p[4], +p[5], +(p[6] || 0));
    const v = Date.parse(s);
    if (Number.isNaN(v)) throw new Error(`Bad time: ${s}`);
    return v;
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) throw new Error(`Bad time: ${s} (use YYYY-MM-DD or YYYY-MM-DDTHH:MM)`);
  const asUtc = checkParts(s, +m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  // Two passes handle DST edges well enough for reporting.
  let guess = asUtc - zone.offsetMinutes(asUtc) * 60000;
  guess = asUtc - zone.offsetMinutes(guess) * 60000;
  return guess;
}

// "--until 2026-01-06" means through the end of that day: up to the next local midnight, which
// is 23 or 25 hours away on a daylight-saving change.
export function parseUntil(zone, str) {
  if (str == null || str === '') return null;
  const s = String(str).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    parseTime(zone, s); // validates the date
    const next = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + 1));
    const nextDay = `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
    return parseTime(zone, nextDay) - 1;
  }
  return parseTime(zone, s);
}
