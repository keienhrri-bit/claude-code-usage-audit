// Controlled comparison: label stretches of work as "self" (the main agent did it) and
// "delegated" (it handed the work off), then compare what the main agent spent on each.
//
// Arm spec:  <label>=<A>..<B>                     all main sessions in a time window
//            <label>=session:<id-prefix>          one whole session
//            <label>=session:<id-prefix>@<A>..<B> part of one session
// The same label may be given several times; the stretches are added up.

import { emptyBucket, add } from './analyze.js';
import { parseTime, parseUntil, fmt } from './time.js';
import { isColdStart } from './cache.js';

export function parseArm(zone, spec) {
  const eq = spec.indexOf('=');
  if (eq < 1) throw new Error(`Bad --arm "${spec}": expected label=window or label=session:<id>`);
  const label = spec.slice(0, eq).trim();
  let rest = spec.slice(eq + 1).trim();
  let session = null;
  if (rest.startsWith('session:')) {
    const at = rest.indexOf('@');
    session = (at > 0 ? rest.slice(8, at) : rest.slice(8)).trim().toLowerCase();
    rest = at > 0 ? rest.slice(at + 1) : '';
  }
  let from = null;
  let to = null;
  if (rest) {
    const [a, b] = rest.split('..');
    if (b == null) throw new Error(`Bad window in --arm "${spec}": use A..B`);
    from = parseTime(zone, a.trim());
    to = parseUntil(zone, b.trim());
  }
  if (!session && from == null) throw new Error(`--arm "${spec}" needs a window or a session`);
  return { label, session, from, to };
}

export function compareArms(a, arms) {
  const zone = a.opts.zone;
  const out = new Map();
  const all = a.allTurns;
  for (const arm of arms) {
    if (!out.has(arm.label)) out.set(arm.label, { main: emptyBucket(), subagent: emptyBucket(), tasks: 0, rewrites: 0, rewriteExcess: 0, minutes: 0, stretches: [] });
    const r = out.get(arm.label);
    const inWin = (ts) => (arm.from == null || ts >= arm.from) && (arm.to == null || ts <= arm.to);
    const sessOk = (t) => !arm.session || String(t.sessionId).toLowerCase().startsWith(arm.session);
    const mains = all.filter((t) => t.kind === 'main' && sessOk(t) && inWin(t.ts));
    const mainSessions = new Set(mains.map((t) => t.sessionId));
    for (const t of mains) add(r.main, t);
    for (const t of all) {
      if (t.kind !== 'subagent' || !inWin(t.ts)) continue;
      if (arm.session ? mainSessions.has(t.parentSessionId) : true) add(r.subagent, t);
    }
    const mainSet = new Set(mains);
    r.tasks += a.tasksAll.filter((k) => mainSet.has(k.launchTurn)).length;
    for (const ev of a.rewritesAll) {
      if (mainSet.has(ev.turn) && !isColdStart(ev)) {
        r.rewrites++;
        r.rewriteExcess += ev.excess || 0;
      }
    }
    if (mains.length) {
      const first = Math.min(...mains.map((t) => t.ts));
      const last = Math.max(...mains.map((t) => t.ts));
      r.minutes += (last - first) / 60000;
      r.stretches.push(`${fmt(zone, first)}..${fmt(zone, last)}${arm.session ? ` (${arm.session})` : ''}`);
    } else {
      r.stretches.push(`(no main-agent turns for ${arm.session || ''}${arm.from != null ? ` ${fmt(zone, arm.from)}..${fmt(zone, arm.to)}` : ''})`);
    }
  }
  const labels = [...out.keys()];
  const base = out.get(labels[0]);
  const rows = labels.map((label) => {
    const r = out.get(label);
    return {
      label,
      stretches: r.stretches,
      mainTurns: Math.round(r.main.turns),
      mainRaw: Math.round(r.main.raw),
      mainOutput: Math.round(r.main.output),
      mainUsd: Math.round(r.main.usd * 1e4) / 1e4,
      subagentRaw: Math.round(r.subagent.raw),
      subagentUsd: Math.round(r.subagent.usd * 1e4) / 1e4,
      tasksLaunched: r.tasks,
      cacheRewrites: r.rewrites,
      cacheRewriteExcessUsd: Math.round(r.rewriteExcess * 1e4) / 1e4,
      activeMinutes: Math.round(r.minutes),
      mainUsdVsFirst: base.main.usd ? Math.round((r.main.usd / base.main.usd) * 1000) / 1000 : null,
      mainRawVsFirst: base.main.raw ? Math.round((r.main.raw / base.main.raw) * 1000) / 1000 : null,
    };
  });
  return {
    note: 'Main-agent usage per arm. Subagent usage found in the logs is listed separately; work done by other CLIs (Codex, agy, ...) is only included if their logs were loaded. A single pair of tasks is an anecdote: repeat each arm on several similar tasks before drawing a conclusion.',
    arms: rows,
  };
}
