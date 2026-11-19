import path from 'node:path';
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
  // Problems with the log directories themselves: the CLI also prints these to stderr.
  const readWarnings = [];
  if (o.claudeDir) {
    const r = await readClaude(o.claudeDir, { sinceMs: readerSince, dedupe: o.dedupe });
    for (const t of r.turns) turns.push(t);
    contextTurns = r.contextTurns;
    sourceStats.claude = r.stats;
    readWarnings.push(...dirWarnings(o, 'claude', o.claudeDir, r));
  }
  if (o.codexDir) {
    const r = await readCodex(o.codexDir, { sinceMs: readerSince });
    for (const t of r.turns) turns.push(t);
    sourceStats.codex = r.stats;
    readWarnings.push(...dirWarnings(o, 'codex', o.codexDir, r));
  }
  warnings.push(...readWarnings);
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
    readWarnings,
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

const SOURCE_LOGS = {
  claude: { name: 'Claude Code', files: '*.jsonl', flag: '--claude-dir' },
  codex: { name: 'Codex', files: 'rollout-*.jsonl', flag: '--codex-dir' },
};
const SHOW_PATHS = 5;

// A directory given on the command line with no logs in it, and parts of a log directory that
// could not be read, would otherwise look like zero usage. --redact names neither the
// directory nor the paths below it (Claude project folder names are working directories).
function dirWarnings(o, source, root, r) {
  const s = SOURCE_LOGS[source];
  const where = o.redact ? `the ${s.name} log directory` : root;
  const out = [];
  const found = r.stats.files + r.stats.skippedOld + r.unreadable.length;
  if (!found && o.explicitDirs && o.explicitDirs[source]) {
    out.push(`No ${s.name} session logs (${s.files}) found under ${o.redact ? s.flag : root}. Check the path given to ${s.flag}.`);
  }
  if (r.unreadable.length) {
    const codes = [...new Set(r.unreadable.map((u) => u.code))].join(', ');
    let msg = `Could not read ${r.unreadable.length} path${r.unreadable.length > 1 ? 's' : ''} under ${where} (${codes}); their usage is missing from this report`;
    if (!o.redact) {
      const shown = r.unreadable.slice(0, SHOW_PATHS).map((u) => path.relative(root, u.path) || u.path);
      msg += `: ${shown.join(', ')}${r.unreadable.length > SHOW_PATHS ? `, and ${r.unreadable.length - SHOW_PATHS} more` : ''}`;
    }
    out.push(msg + '.');
  }
  return out;
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
