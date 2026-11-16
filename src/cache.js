// Cache rewrite detection.
//
// A "rewrite" is a turn that writes a large block to the prompt cache although the previous turn
// of the same session had that prefix cached: cache_read falls well below the previous turn's
// cached context (cache_read + cache writes) while cache writes are large. The first turn of a
// session is a cold start, reported separately.
//
// Cause, in this order:
//   compaction            a compact_boundary record precedes the turn (Claude Code)
//   model-switch          the model differs from the previous turn (caches are per model)
//   waiting-on-subagent   gap > cache TTL and a subagent of this session ran during the gap
//   idle-5m / idle-1h     gap > TTL of the previous turn's cache writes
//   unexplained           none of the above (tool list or system prompt changed, server eviction, ...)
// Rewrites inside a subagent's own session get the prefix "subagent:". Cold starts are
// "session-start" (main) or "subagent-start".

export const DEFAULT_CACHE_OPTS = { minTokens: 20000, readRatio: 0.5 };

// Cold starts are the first turn of a session or subagent: there was nothing to reuse yet, so they
// are reported next to the rewrites, never inside the rewrite totals.
export const COLD_START_CAUSES = new Set(['session-start', 'subagent-start']);
export const isColdStart = (ev) => COLD_START_CAUSES.has(ev.cause);

export function detectRewrites(sessions, opts = {}) {
  const { minTokens, readRatio } = { ...DEFAULT_CACHE_OPTS, ...opts };
  // subagent activity per parent session, for the waiting-on-subagent test
  const childTimes = new Map();
  for (const list of sessions.values()) {
    for (const t of list) {
      if (t.kind !== 'subagent' || !t.parentSessionId) continue;
      if (!childTimes.has(t.parentSessionId)) childTimes.set(t.parentSessionId, []);
      childTimes.get(t.parentSessionId).push(t.ts);
    }
  }
  for (const arr of childTimes.values()) arr.sort((a, b) => a - b);

  const events = [];
  for (const [sid, list] of sessions) {
    let ttl = 300; // seconds; follows the TTL of the most recent cache write in the session
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      const writes = t.cacheWrite5m + t.cacheWrite1h;
      if (i === 0) {
        if (writes >= minTokens) {
          events.push(makeEvent(t, null, t.kind === 'subagent' ? 'subagent-start' : 'session-start', null, ttl));
        }
      } else {
        const p = list[i - 1];
        const prevCtx = p.cacheRead + p.cacheWrite5m + p.cacheWrite1h;
        if (writes >= minTokens && t.cacheRead < readRatio * prevCtx) {
          const gap = (t.ts - p.ts) / 1000;
          let cause;
          if (t.compactBefore) cause = 'compaction';
          else if (t.model !== p.model) cause = 'model-switch';
          else if (gap > ttl) {
            const kids = childTimes.get(sid);
            cause = kids && anyBetween(kids, p.ts, t.ts) ? 'waiting-on-subagent' : ttl >= 3600 ? 'idle-1h' : 'idle-5m';
          } else cause = 'unexplained';
          if (t.kind === 'subagent') cause = `subagent:${cause}`;
          events.push(makeEvent(t, p, cause, gap, ttl));
        }
      }
      if (t.cacheWrite1h > 0) ttl = 3600;
      else if (t.cacheWrite5m > 0) ttl = 300;
    }
  }
  return events;
}

function anyBetween(sorted, a, b) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= a) lo = mid + 1;
    else hi = mid;
  }
  return lo < sorted.length && sorted[lo] < b;
}

function makeEvent(t, p, cause, gapSec, ttl) {
  return {
    turn: t,
    cause,
    gapSeconds: gapSec == null ? null : Math.round(gapSec),
    ttlSeconds: ttl,
    rewriteTokens: t.cacheWrite5m + t.cacheWrite1h,
    prevContext: p ? p.cacheRead + p.cacheWrite5m + p.cacheWrite1h : 0,
  };
}

// Extra cost of a rewrite compared with reading the same tokens from cache.
export function excessCost(ev, price) {
  if (!price) return null;
  const t = ev.turn;
  const cr = price.cacheRead ?? price.input * 0.1;
  const w5 = price.cacheWrite5m ?? price.input * 1.25;
  const w1 = price.cacheWrite1h ?? price.input * 2;
  return (t.cacheWrite5m * (w5 - cr) + t.cacheWrite1h * (w1 - cr)) / 1e6;
}
