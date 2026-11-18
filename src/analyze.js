import { readClaude } from './readers/claude.js';
import { readCodex } from './readers/codex.js';
import { loadPrices, turnCost, turnWeighted, rawTotal } from './prices.js';
import { loadRules, classifyAll } from './rules.js';
import { detectRewrites, excessCost } from './cache.js';
import { attributeTasks, readLedger } from './tasks.js';
import { dayKey } from './time.js';

// Load, price, classify and attribute. Returns everything the reports need.
export async function analyze(o) {
  const warnings = [];
  const prices = loadPrices(o.prices);
  const rules = loadRules(o.config, o.extraSessionRules || []);
  const readerSince = o.sinceMs != null ? o.sinceMs - 2 * 86400000 : null; // keep context before the window

  const turns = [];
  let contextTurns = [];
  const sourceStats = {};
  if (o.claudeDir) {
    const r = await readClaude(o.claudeDir, { sinceMs: readerSince, dedupe: o.dedupe });
    turns.push(...r.turns);
    contextTurns = r.contextTurns;
    sourceStats.claude = r.stats;
  }
  if (o.codexDir) {
    const r = await readCodex(o.codexDir, { sinceMs: readerSince });
    turns.push(...r.turns);
    sourceStats.codex = r.stats;
  }
  const sessionTurns = [...turns, ...contextTurns];
  if (o.mergeSubagents) {
    for (const t of sessionTurns) {
      if (t.kind === 'subagent' && t.parentSessionId) {
        t.kind = 'main';
        t.sessionId = t.parentSessionId;
      }
    }
  }

  for (const t of turns) {
    const p = prices.lookup(t.model);
    t.price = p;
    t.cost = turnCost(t, p);
    t.weighted = turnWeighted(t, p);
    t.raw = rawTotal(t);
  }

  // Sessions over all loaded turns (context before --since matters for sticky rules and cache gaps).
  const sessions = groupSessions(sessionTurns);
  classifyAll(rules, sessions);
  const ledger = o.ledger ? readLedger(o.ledger, o.zone, o.ledgerFields) : null;
  const taskResult = attributeTasks(sessions, rules, { ...o.taskOpts, ledger });
  const rewrites = detectRewrites(sessions, o.cacheOpts).filter(({ turn }) => !turn.contextOnly);
  for (const ev of rewrites) ev.excess = excessCost(ev, ev.turn.price);

  const inWin = (ts) => (o.sinceMs == null || ts >= o.sinceMs) && (o.untilMs == null || ts <= o.untilMs);
  const windowTurns = turns.filter((t) => inWin(t.ts));
  const unpriced = new Map();
  for (const t of windowTurns) {
    t.day = dayKey(o.zone, t.ts);
    if (!t.price) unpriced.set(t.model, (unpriced.get(t.model) || 0) + t.raw);
  }
  for (const [m, n] of unpriced) {
    warnings.push(`No price for model "${m}" (${n.toLocaleString('en-US')} raw tokens in the window): counted in raw tokens, left out of USD and weighted totals. Add it with --prices.`);
  }
  return {
    opts: o,
    prices,
    rules,
    warnings,
    sourceStats,
    allTurns: turns,
    sessions,
    turns: windowTurns,
    // A launch, attributed main turn or linked worker turn brings a task into the report.
    tasks: taskResult.tasks.filter((k) => inWin(k.ts) || k.turns.some(({ turn }) => inWin(turn.ts)) || k.workerTurns.some((t) => inWin(t.ts))),
    inWin,
    tasksAll: taskResult.tasks,
    rewritesAll: rewrites,
    ledgerInfo: { entries: taskResult.ledgerEntries, matched: taskResult.ledgerMatched },
    rewrites: rewrites.filter((e) => inWin(e.turn.ts)),
  };
}

export function groupSessions(turns) {
  const m = new Map();
  for (const t of turns) {
    if (!m.has(t.sessionId)) m.set(t.sessionId, []);
    m.get(t.sessionId).push(t);
  }
  for (const list of m.values()) list.sort((a, b) => a.ts - b.ts);
  return m;
}

export function emptyBucket() {
  return { turns: 0, input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, raw: 0, weighted: 0, usd: 0, unpricedRaw: 0 };
}

export function add(b, t, share = 1) {
  b.turns += share;
  b.input += t.input * share;
  b.output += t.output * share;
  b.cacheWrite5m += t.cacheWrite5m * share;
  b.cacheWrite1h += t.cacheWrite1h * share;
  b.cacheRead += t.cacheRead * share;
  b.raw += t.raw * share;
  if (t.cost == null) b.unpricedRaw += t.raw * share;
  else {
    b.usd += t.cost * share;
    b.weighted += t.weighted * share;
  }
  return b;
}
