import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyze } from './analyze.js';
import { buildSummary, renderSummary, table, tok, usd, pct } from './report.js';
import { makeZone, parseTime, parseUntil } from './time.js';
import { parseArm, compareArms } from './compare.js';
import { defaultRulesText } from './rules.js';
import { DEFAULT_CACHE_OPTS } from './cache.js';
import { DEFAULT_TASK_OPTS } from './tasks.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const HELP = `claude-code-usage-audit ${VERSION}
Where did my Claude Code (and Codex) usage go? Reads local session logs and splits the main
agent's usage into building the agent setup, dispatching work, and the actual work.

Usage:
  claude-code-usage-audit [report] [options]   summary (default)
  claude-code-usage-audit cache [options]      list cache rewrites
  claude-code-usage-audit tasks [options]      per hand-off cost of the main agent
  claude-code-usage-audit compare --arm self=A..B --arm delegated=C..D [options]
  claude-code-usage-audit rules                print the default rules (start of a config file)

Data:
  --claude-dir <dir>     Claude Code projects dir (default: $CLAUDE_CONFIG_DIR/projects or ~/.claude/projects)
  --codex-dir <dir>      Codex sessions dir (default: $CODEX_HOME/sessions or ~/.codex/sessions)
  --no-claude, --no-codex
  --since <time>         e.g. 2026-01-05 or 2026-01-05T09:00 (wall clock in --tz)
  --until <time>         a bare date means through the end of that day
  --tz <zone>            local (default), UTC, +05:30, Europe/Berlin ...
Rules:
  --config <file>        classification / marker rules (see "rules")
  --cwd-rule <re=cat>    put whole sessions whose working directory matches <re> into <cat> (repeatable)
  --prices <file>        extra or overriding model prices (USD per million tokens)
  --ledger <file>        JSONL job ledger with name/dir and start+end or time+seconds
  --ledger-time-is start|end   meaning of "time" in the ledger (default end)
Detail:
  --cache-min <n>        minimum tokens for a cache rewrite (default ${DEFAULT_CACHE_OPTS.minTokens})
  --cache-read-ratio <x> rewrite if cache read < x * previous cached context (default ${DEFAULT_CACHE_OPTS.readRatio})
  --lookback <minutes>   how far before a launch brief-writing turns are looked for (default ${DEFAULT_TASK_OPTS.lookbackMinutes})
  --dedupe global|file   dedupe message ids across files (default) or only within a file
  --merge-subagents      count subagents into their parent session (older tools' behaviour; for comparison only)
Output:
  --json <file|->        write the full result as JSON
  --top <n>              rows in top lists (default 10)
  --no-days              skip the per-day table
  --redact               hash working directories, hide ledger names and file paths (for sharing)
  -h, --help, -v, --version
`;

function parseArgs(argv) {
  const o = { _: [], arm: [], cwdRule: [] };
  const flags = new Set(['no-claude', 'no-codex', 'merge-subagents', 'redact', 'no-days', 'help', 'version']);
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === '-h') a = '--help';
    if (a === '-v') a = '--version';
    if (!a.startsWith('--')) {
      o._.push(a);
      continue;
    }
    let key = a.slice(2);
    let val;
    const eq = key.indexOf('=');
    if (eq >= 0) {
      val = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    if (flags.has(key)) {
      o[camel(key)] = true;
      continue;
    }
    if (val === undefined) {
      val = argv[++i];
      if (val === undefined) throw new Error(`--${key} needs a value`);
    }
    const k = camel(key);
    if (k === 'arm' || k === 'cwdRule') o[k].push(val);
    else o[k] = val;
  }
  return o;
}

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function defaultClaudeDir() {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}
function defaultCodexDir() {
  const base = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(base, 'sessions');
}

export async function main(argv) {
  const a = parseArgs(argv);
  if (a.help) return void process.stdout.write(HELP);
  if (a.version) return void process.stdout.write(`${VERSION}\n`);
  const cmd = a._[0] || 'report';
  if (cmd === 'rules') return void process.stdout.write(defaultRulesText());
  if (!['report', 'cache', 'tasks', 'compare'].includes(cmd)) throw new Error(`Unknown command "${cmd}". Try --help.`);

  const zone = makeZone(a.tz || 'local');
  const config = a.config || null;
  // --cwd-rule entries are added after the config file's sessionRules, in memory.
  const extraSessionRules = a.cwdRule.map(parseCwdRule);
  const claudeDir = a.noClaude ? null : a.claudeDir || defaultClaudeDir();
  const codexDir = a.noCodex ? null : a.codexDir || defaultCodexDir();
  for (const [name, d, explicit] of [['--claude-dir', claudeDir, a.claudeDir], ['--codex-dir', codexDir, a.codexDir]]) {
    if (!d || !explicit) continue;
    if (!fs.existsSync(d)) throw new Error(`${name} ${d} does not exist`);
    if (!fs.statSync(d).isDirectory()) throw new Error(`${name} ${d} is not a directory`);
  }

  const opts = {
    zone,
    claudeDir: claudeDir && fs.existsSync(claudeDir) ? claudeDir : null,
    codexDir: codexDir && fs.existsSync(codexDir) ? codexDir : null,
    explicitDirs: { claude: !!(claudeDir && a.claudeDir), codex: !!(codexDir && a.codexDir) },
    sinceMs: a.since ? parseTime(zone, a.since) : null,
    untilMs: a.until ? parseUntil(zone, a.until) : null,
    config,
    extraSessionRules,
    prices: a.prices || null,
    ledger: a.ledger || null,
    ledgerFields: a.ledgerTimeIs ? { timeIs: a.ledgerTimeIs } : {},
    dedupe: a.dedupe === 'file' ? 'file' : 'global',
    mergeSubagents: !!a.mergeSubagents,
    redact: !!a.redact,
    cacheOpts: {
      minTokens: a.cacheMin != null ? Number(a.cacheMin) : DEFAULT_CACHE_OPTS.minTokens,
      readRatio: a.cacheReadRatio != null ? Number(a.cacheReadRatio) : DEFAULT_CACHE_OPTS.readRatio,
    },
    taskOpts: { lookbackMinutes: a.lookback != null ? Number(a.lookback) : DEFAULT_TASK_OPTS.lookbackMinutes },
  };
  if (!opts.claudeDir && !opts.codexDir) throw new Error('No log directory found. Pass --claude-dir or --codex-dir.');

  const result = await analyze(opts);
  // The report shows its warnings; the other commands don't, so problems reading the logs go to stderr.
  if (cmd !== 'report') for (const w of result.readWarnings) process.stderr.write(`! ${w}\n`);
  const top = a.top ? Number(a.top) : 10;
  if (a.cwdRule.length) result.opts.config = a.config ? `${a.config} + --cwd-rule` : '--cwd-rule';
  const summary = buildSummary(result, VERSION, { top });

  let text;
  let json = summary;
  if (cmd === 'report') {
    text = renderSummary(summary, { days: !a.noDays });
  } else if (cmd === 'cache') {
    json = summary.cache;
    const rows = [['time', 'source', 'kind', 'model', 'session', 'cause', 'gap min', 'tokens', 'excess']];
    for (const e of summary.cache.top) rows.push([e.time, e.source, e.kind, e.model, e.session, e.cause, e.gapMinutes ?? '-', tok(e.rewriteTokens), usd(e.excessUsd)]);
    text = [`Cache rewrites: ${summary.cache.definition}`, summary.cache.events ? table(rows) : 'none found'].join('\n');
  } else if (cmd === 'tasks') {
    json = summary.tasks;
    const rows = [['id', 'marker', 'time', 'session', 'ledger', 'retry of', 'main turns', 'main raw', 'main API-equiv', 'brief/launch/review', 'worker']];
    for (const r of summary.tasks.all.slice().sort((x, y) => y.mainUsd - x.mainUsd).slice(0, top)) {
      const ph = r.phaseUsd;
      rows.push([r.id, r.label, r.time, r.session, r.ledgerName ? `${r.ledgerName}${r.ledgerOk === false ? ' (failed)' : ''}` : '-', r.retryOf || '-', r.mainTurns, tok(r.mainRaw), usd(r.mainUsd), `${usd(ph.brief || 0)}/${usd(ph.launch || 0)}/${usd(ph.review || 0)}`, r.workerRaw ? usd(r.workerUsd) : '-']);
    }
    text = [renderSummary(summary, { days: false }).split('== Hand-offs (tasks) ==')[1].trim(), '', rows.length > 1 ? table(rows) : ''].join('\n');
  } else if (cmd === 'compare') {
    if (a.arm.length < 2) throw new Error('compare needs at least two --arm options');
    const arms = a.arm.map((s) => parseArm(zone, s));
    json = compareArms(result, arms);
    const rows = [['arm', 'main turns', 'main raw', 'main API-equiv', 'vs first', 'subagents', 'tasks launched', 'cache rewrites', 'active min']];
    for (const r of json.arms) rows.push([r.label, r.mainTurns, tok(r.mainRaw), usd(r.mainUsd), pct(r.mainUsdVsFirst), r.subagentRaw ? usd(r.subagentUsd) : '-', r.tasksLaunched, r.cacheRewrites, r.activeMinutes]);
    text = [table(rows), '', ...json.arms.map((r) => `${r.label}: ${r.stretches.join('; ')}`), '', json.note].join('\n');
  }

  if (a.json) {
    const out = JSON.stringify(json, null, 2);
    if (a.json === '-') {
      process.stdout.write(out + '\n');
      return;
    }
    fs.writeFileSync(a.json, out + '\n');
  }
  process.stdout.write(text + '\n');
}

function parseCwdRule(s) {
  const i = s.lastIndexOf('=');
  if (i < 1) throw new Error(`Bad --cwd-rule "${s}": expected <regex>=<category>`);
  return { cwd: s.slice(0, i), category: s.slice(i + 1) };
}
