import crypto from 'node:crypto';
import { emptyBucket, add } from './analyze.js';
import { fmt } from './time.js';
import { isColdStart } from './cache.js';

export const NOTE =
  'Local token ledger from session logs. USD is an API-equivalent estimate at list prices, not a subscription bill and not the /usage percentage.';

export function redactor(on) {
  if (!on) return (s) => s;
  return (s) => (s ? `dir#${crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 6)}` : s);
}

const round = (x, d = 4) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

function cleanBucket(b) {
  return {
    turns: round(b.turns, 2),
    input: Math.round(b.input),
    output: Math.round(b.output),
    cacheWrite5m: Math.round(b.cacheWrite5m),
    cacheWrite1h: Math.round(b.cacheWrite1h),
    cacheRead: Math.round(b.cacheRead),
    rawTokens: Math.round(b.raw),
    weightedTokens: Math.round(b.weighted),
    apiEquivalentUsd: round(b.usd),
    unpricedRawTokens: Math.round(b.unpricedRaw),
  };
}

export function buildSummary(a, version, { top = 10 } = {}) {
  const o = a.opts;
  const red = redactor(o.redact);
  const turns = a.turns;
  const zone = o.zone;

  const bySource = {};
  const subTypes = {};
  const models = {};
  const cats = {};
  const days = {};
  for (const c of a.rules.categories) cats[c] = emptyBucket();
  for (const t of turns) {
    bySource[t.source] ??= { main: emptyBucket(), subagent: emptyBucket() };
    add(bySource[t.source][t.kind], t);
    const mk = `${t.source}:${t.model}`;
    models[mk] ??= emptyBucket();
    add(models[mk], t);
    days[t.day] ??= { main: emptyBucket(), subagent: emptyBucket(), categories: {} };
    add(days[t.day][t.kind], t);
    if (t.kind === 'subagent') {
      const k = `${t.source}:${t.agentType || 'subagent'}`;
      subTypes[k] ??= emptyBucket();
      add(subTypes[k], t);
    } else {
      cats[t.category] ??= emptyBucket();
      add(cats[t.category], t);
      days[t.day].categories[t.category] = (days[t.day].categories[t.category] || 0) + (t.cost || 0);
    }
  }

  const mainTotal = emptyBucket();
  for (const t of turns) if (t.kind === 'main') add(mainTotal, t);
  const allTotal = emptyBucket();
  for (const t of turns) add(allTotal, t);

  const categories = {};
  for (const [c, b] of Object.entries(cats)) {
    categories[c] = {
      label: a.rules.labels[c] || null,
      ...cleanBucket(b),
      shareOfMainUsd: mainTotal.usd ? round(b.usd / mainTotal.usd) : null,
      shareOfMainRaw: mainTotal.raw ? round(b.raw / mainTotal.raw) : null,
    };
  }

  // cache rewrites (cold starts listed apart)
  const causes = {};
  let excess = 0;
  let rewriteTokens = 0;
  const rewrites = a.rewrites.filter((ev) => !isColdStart(ev));
  const cold = { events: 0, tokens: 0, excessUsd: 0 };
  for (const ev of a.rewrites) {
    if (!isColdStart(ev)) continue;
    cold.events++;
    cold.tokens += ev.rewriteTokens;
    cold.excessUsd += ev.excess || 0;
  }
  cold.excessUsd = round(cold.excessUsd);
  for (const ev of rewrites) {
    causes[ev.cause] ??= { events: 0, rewriteTokens: 0, excessUsd: 0 };
    causes[ev.cause].events++;
    causes[ev.cause].rewriteTokens += ev.rewriteTokens;
    causes[ev.cause].excessUsd += ev.excess || 0;
    excess += ev.excess || 0;
    rewriteTokens += ev.rewriteTokens;
  }
  for (const c of Object.values(causes)) c.excessUsd = round(c.excessUsd);
  const cache = {
    definition: `turn writes >= ${o.cacheOpts.minTokens} tokens to cache while reading < ${o.cacheOpts.readRatio} of the previous turn's cached context; the first turn of a session or subagent is a cold start and is counted apart`,
    events: rewrites.length,
    rewriteTokens,
    excessUsdVsCacheRead: round(excess),
    excessShareOfAllUsd: allTotal.usd ? round(excess / allTotal.usd) : null,
    byCause: causes,
    coldStarts: cold,
    top: [...rewrites]
      .sort((x, y) => y.rewriteTokens - x.rewriteTokens)
      .slice(0, top)
      .map((ev) => ({
        time: fmt(zone, ev.turn.ts),
        source: ev.turn.source,
        kind: ev.turn.kind,
        model: ev.turn.model,
        session: shortId(ev.turn.sessionId),
        cause: ev.cause,
        gapMinutes: ev.gapSeconds == null ? null : round(ev.gapSeconds / 60, 1),
        rewriteTokens: ev.rewriteTokens,
        excessUsd: round(ev.excess),
      })),
  };

  const tasks = summarizeTasks(a, red, top, mainTotal);

  // sessions
  const sess = new Map();
  for (const t of turns) {
    if (t.kind !== 'main') continue;
    if (!sess.has(t.sessionId)) sess.set(t.sessionId, { b: emptyBucket(), cats: {}, first: t.ts, last: t.ts, cwd: t.cwd, source: t.source });
    const s = sess.get(t.sessionId);
    add(s.b, t);
    s.cats[t.category] = (s.cats[t.category] || 0) + (t.cost || 0);
    s.first = Math.min(s.first, t.ts);
    s.last = Math.max(s.last, t.ts);
    s.cwd = s.cwd || t.cwd;
  }
  const sessions = [...sess.entries()]
    .sort((x, y) => y[1].b.usd - x[1].b.usd)
    .slice(0, top)
    .map(([id, s]) => ({
      session: shortId(id),
      source: s.source,
      cwd: red(s.cwd),
      first: fmt(zone, s.first),
      last: fmt(zone, s.last),
      apiEquivalentUsd: round(s.b.usd),
      categoryShare: Object.fromEntries(Object.entries(s.cats).map(([c, v]) => [c, s.b.usd ? round(v / s.b.usd, 3) : null])),
    }));

  // by working directory (main)
  const dirs = {};
  for (const t of turns) {
    if (t.kind !== 'main') continue;
    const k = red(t.cwd || '?');
    dirs[k] ??= { b: emptyBucket(), cats: {} };
    add(dirs[k].b, t);
    dirs[k].cats[t.category] = (dirs[k].cats[t.category] || 0) + (t.cost || 0);
  }
  const byDirectory = Object.entries(dirs)
    .sort((x, y) => y[1].b.usd - x[1].b.usd)
    .slice(0, top)
    .map(([d, v]) => ({
      cwd: d,
      apiEquivalentUsd: round(v.b.usd),
      shareOfMainUsd: mainTotal.usd ? round(v.b.usd / mainTotal.usd) : null,
      categoryShare: Object.fromEntries(Object.entries(v.cats).map(([c, x]) => [c, v.b.usd ? round(x / v.b.usd, 3) : null])),
    }));

  const parsing = {};
  for (const [s, st] of Object.entries(a.sourceStats)) {
    parsing[s] = { ...st };
    if (st.assistantLines) parsing[s].linesPerUniqueTurn = round(st.assistantLines / Math.max(1, st.uniqueTurns), 2);
  }

  return {
    tool: 'claude-code-usage-audit',
    version,
    note: NOTE,
    window: {
      since: o.sinceMs == null ? null : fmt(zone, o.sinceMs),
      until: o.untilMs == null ? null : fmt(zone, o.untilMs),
      timeZone: zone.name,
    },
    options: {
      dedupe: o.dedupe,
      mergeSubagents: !!o.mergeSubagents,
      rules: o.config ? (o.redact ? 'custom' : o.config) : 'default',
      prices: a.prices.source,
    },
    warnings: a.warnings,
    parsing,
    totals: {
      all: cleanBucket(allTotal),
      mainAgent: cleanBucket(mainTotal),
      bySource: Object.fromEntries(
        Object.entries(bySource).map(([s, v]) => [s, { main: cleanBucket(v.main), subagent: cleanBucket(v.subagent) }]),
      ),
    },
    subagentsByType: Object.fromEntries(Object.entries(subTypes).map(([k, b]) => [k, cleanBucket(b)])),
    models: Object.fromEntries(Object.entries(models).map(([k, b]) => [k, cleanBucket(b)])),
    categories,
    days: Object.fromEntries(
      Object.entries(days)
        .sort()
        .map(([d, v]) => [
          d,
          {
            mainUsd: round(v.main.usd),
            subagentUsd: round(v.subagent.usd),
            mainRaw: Math.round(v.main.raw),
            subagentRaw: Math.round(v.subagent.raw),
            categoryUsd: Object.fromEntries(Object.entries(v.categories).map(([c, x]) => [c, round(x)])),
          },
        ]),
    ),
    cache,
    tasks,
    topSessions: sessions,
    byDirectory,
  };
}

function summarizeTasks(a, red, top, mainTotal) {
  const zone = a.opts.zone;
  const byLabel = {};
  let attributedUsd = 0;
  const rows = [];
  for (const task of a.tasks) {
    const main = emptyBucket();
    const phases = {};
    for (const { turn, phase, share } of task.turns) {
      add(main, turn, share);
      phases[phase] ??= emptyBucket();
      add(phases[phase], turn, share);
    }
    const worker = emptyBucket();
    for (const t of task.workerTurns) add(worker, t);
    attributedUsd += main.usd;
    const L = (byLabel[task.label] ??= { tasks: 0, retries: 0, mainUsd: 0, mainRaw: 0, workerUsd: 0, workerRaw: 0, ledgerOk: 0, ledgerFailed: 0 });
    L.tasks++;
    if (task.retryOf) L.retries++;
    L.mainUsd += main.usd;
    L.mainRaw += main.raw;
    L.workerUsd += worker.usd;
    L.workerRaw += worker.raw;
    if (task.ledger && task.ledger.ok === true) L.ledgerOk++;
    if (task.ledger && task.ledger.ok === false) L.ledgerFailed++;
    rows.push({
      id: task.id,
      label: task.label,
      time: fmt(zone, task.ts),
      session: shortId(task.sessionId),
      ledgerName: task.ledger && !a.opts.redact ? task.ledger.name : task.ledger ? '(matched)' : null,
      ledgerOk: task.ledger ? task.ledger.ok : null,
      retryOf: task.retryOf,
      mainTurns: round(main.turns, 2),
      mainRaw: Math.round(main.raw),
      mainUsd: round(main.usd),
      phaseUsd: Object.fromEntries(Object.entries(phases).map(([p, b]) => [p, round(b.usd)])),
      workerRaw: Math.round(worker.raw),
      workerUsd: round(worker.usd),
    });
  }
  for (const L of Object.values(byLabel)) {
    for (const k of ['mainUsd', 'workerUsd']) L[k] = round(L[k]);
    for (const k of ['mainRaw', 'workerRaw']) L[k] = Math.round(L[k]);
  }
  const usdList = rows.map((r) => r.mainUsd || 0).sort((x, y) => x - y);
  return {
    count: rows.length,
    ledger: a.ledgerInfo.entries ? a.ledgerInfo : null,
    attributedMainUsd: round(attributedUsd),
    attributedShareOfMainUsd: mainTotal.usd ? round(attributedUsd / mainTotal.usd) : null,
    medianMainUsdPerTask: usdList.length ? round(usdList[Math.floor((usdList.length - 1) / 2)]) : null,
    byLabel,
    top: [...rows].sort((x, y) => (y.mainUsd || 0) - (x.mainUsd || 0)).slice(0, top),
    all: rows,
  };
}

export function shortId(id) {
  if (!id) return id;
  const s = String(id);
  const [head, tail] = s.split('/');
  return tail ? `${head.slice(0, 8)}/${tail.slice(0, 10)}` : head.slice(0, 8);
}

// ---------- text rendering ----------

export function tok(n) {
  if (n == null) return '-';
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return String(Math.round(n));
}
export const usd = (n) => (n == null ? '-' : `$${n >= 100 ? n.toFixed(0) : n >= 0.1 || n === 0 ? n.toFixed(2) : n.toFixed(3)}`);
export const pct = (x) => (x == null ? '-' : `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`);

export function table(rows, align) {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows
    .map((r) => r.map((c, i) => ((align && align[i] === 'l') || i === 0 ? String(c).padEnd(w[i]) : String(c).padStart(w[i]))).join('  '))
    .join('\n');
}

export function renderSummary(s, { days = true } = {}) {
  const L = [];
  L.push(`claude-code-usage-audit ${s.version}`);
  L.push(s.note);
  L.push(`Window: ${s.window.since || 'start'} .. ${s.window.until || 'now'} (${s.window.timeZone})`);
  for (const w of s.warnings) L.push(`! ${w}`);
  for (const [src, p] of Object.entries(s.parsing)) {
    if (src === 'claude') {
      L.push(`Claude logs: ${p.files} files, ${p.assistantLines} assistant lines -> ${p.uniqueTurns} unique responses (${p.linesPerUniqueTurn} lines each; ${p.crossFileDuplicates} copies in other files dropped)`);
    } else {
      L.push(`Codex logs: ${p.files} files, ${p.tokenEvents} token_count events, ${p.duplicateEvents} repeated events dropped -> ${p.uniqueTurns} turns`);
    }
  }
  L.push('');
  L.push('== Main agent vs subagents (subagents are not added to the main agent) ==');
  const rows = [['', 'turns', 'input', 'output', 'cache write', 'cache read', 'raw total', 'API-equiv']];
  for (const [src, v] of Object.entries(s.totals.bySource)) {
    for (const k of ['main', 'subagent']) {
      const b = v[k];
      if (!b.turns) continue;
      rows.push([`${src} ${k}`, Math.round(b.turns), tok(b.input), tok(b.output), tok(b.cacheWrite5m + b.cacheWrite1h), tok(b.cacheRead), tok(b.rawTokens), usd(b.apiEquivalentUsd)]);
    }
  }
  L.push(table(rows));
  const subs = Object.entries(s.subagentsByType).sort((a, b) => b[1].apiEquivalentUsd - a[1].apiEquivalentUsd);
  if (subs.length) {
    L.push(`Subagents by type: ${subs.slice(0, 6).map(([k, b]) => `${k} ${usd(b.apiEquivalentUsd)}`).join(', ')}`);
  }
  L.push('');
  L.push('== By model (weighted = input-token equivalents at that model\'s prices) ==');
  const mrows = [['model', 'raw tokens', 'weighted', 'API-equiv']];
  for (const [m, b] of Object.entries(s.models).sort((a, b) => b[1].rawTokens - a[1].rawTokens)) {
    mrows.push([m, tok(b.rawTokens), b.unpricedRawTokens ? 'no price' : tok(b.weightedTokens), b.unpricedRawTokens ? '-' : usd(b.apiEquivalentUsd)]);
  }
  L.push(table(mrows));
  L.push('');
  L.push('== Where the main agent\'s usage went ==');
  const crows = [['category', 'turns', 'raw tokens', 'raw share', 'API-equiv', 'share']];
  for (const [c, b] of Object.entries(s.categories)) {
    crows.push([c, Math.round(b.turns), tok(b.rawTokens), pct(b.shareOfMainRaw), usd(b.apiEquivalentUsd), pct(b.shareOfMainUsd)]);
  }
  L.push(table(crows));
  for (const [c, b] of Object.entries(s.categories)) if (b.label) L.push(`  ${c}: ${b.label}`);
  if (days) {
    L.push('');
    L.push('== By day (main agent API-equiv; subagents separate) ==');
    const cats = Object.keys(s.categories);
    const drows = [['day', 'main', ...cats.map((c) => c.slice(0, 13)), `${cats[0]} %`, 'subagents']];
    for (const [d, v] of Object.entries(s.days)) {
      drows.push([d, usd(v.mainUsd), ...cats.map((c) => usd(v.categoryUsd[c] || 0)), pct(v.mainUsd ? (v.categoryUsd[cats[0]] || 0) / v.mainUsd : null), usd(v.subagentUsd)]);
    }
    L.push(table(drows));
  }
  L.push('');
  L.push('== Cache rewrites ==');
  L.push(`${s.cache.events} rewrites, ${tok(s.cache.rewriteTokens)} tokens written; ${usd(s.cache.excessUsdVsCacheRead)} more than reading them from cache (${pct(s.cache.excessShareOfAllUsd)} of all API-equiv)`);
  const rrows = [['cause', 'events', 'tokens', 'excess']];
  for (const [c, v] of Object.entries(s.cache.byCause).sort((a, b) => b[1].excessUsd - a[1].excessUsd)) {
    rrows.push([c, v.events, tok(v.rewriteTokens), usd(v.excessUsd)]);
  }
  if (rrows.length > 1) L.push(table(rrows));
  const cs = s.cache.coldStarts;
  if (cs && cs.events) L.push(`Not counted above: ${cs.events} cold starts (first turn of a session or subagent), ${tok(cs.tokens)} tokens written`);
  L.push('');
  L.push('== Hand-offs (tasks) ==');
  const t = s.tasks;
  L.push(`${t.count} tasks; main agent spent ${usd(t.attributedMainUsd)} on them (${pct(t.attributedShareOfMainUsd)} of main), median ${usd(t.medianMainUsdPerTask)} per task`);
  if (t.ledger) L.push(`Ledger: ${t.ledger.matched} of ${t.ledger.entries} entries matched to a launch`);
  const trows = [['marker', 'tasks', 'retries', 'main API-equiv', 'worker API-equiv']];
  for (const [k, v] of Object.entries(t.byLabel)) trows.push([k, v.tasks, v.retries, usd(v.mainUsd), v.workerRaw ? usd(v.workerUsd) : 'not linked']);
  if (trows.length > 1) L.push(table(trows));
  return L.join('\n');
}
