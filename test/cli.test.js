// End to end on the synthetic example logs. The expected numbers are worked out by hand in
// scripts/make-example-logs.mjs (see the comments there).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cli, cliJson, EX_ARGS, ROOT, EX, tmpDir } from './helpers.js';

const close = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('report: parsing and dedupe counts', () => {
  const s = cliJson(EX_ARGS);
  assert.equal(s.tool, 'claude-code-usage-audit');
  assert.equal(s.window.timeZone, 'UTC');
  assert.deepEqual(
    [s.parsing.claude.files, s.parsing.claude.assistantLines, s.parsing.claude.uniqueTurns, s.parsing.claude.crossFileDuplicates],
    [3, 18, 15, 1],
  );
  assert.deepEqual([s.parsing.codex.tokenEvents, s.parsing.codex.duplicateEvents, s.parsing.codex.uniqueTurns], [3, 1, 2]);
});

test('report: subagents are listed apart from the main agent', () => {
  const s = cliJson(EX_ARGS);
  assert.equal(s.totals.bySource.claude.main.turns, 13);
  assert.equal(s.totals.bySource.claude.subagent.turns, 2);
  assert.equal(s.totals.bySource.codex.main.turns, 2);
  assert.equal(s.totals.mainAgent.turns, 15);
  assert.equal(s.totals.all.turns, 17);
  assert.equal(s.subagentsByType['claude:general-purpose'].turns, 2);
  // haiku subagent: (3*0.1 + 500*0.5 + 21000*0.125 + 3*0.1 + 900*0.5 + 1500*0.125 + 21000*0.01) / 1e6
  close(s.subagentsByType['claude:general-purpose'].apiEquivalentUsd, 0.0037);
});

test('report: model prices and weighted tokens', () => {
  const s = cliJson(EX_ARGS);
  // msg_a12: 5 in, 600 out, 25000 1h writes at Sonnet 5.5 list prices (2 / 10 / 4 per MTok)
  const sonnet = s.models['claude:claude-sonnet-5-5'];
  close(sonnet.apiEquivalentUsd, 0.106);
  assert.equal(sonnet.weightedTokens, 53005);
  assert.equal(sonnet.rawTokens, 25605);
  const codex = s.models['codex:gpt-demo'];
  assert.equal(codex.unpricedRawTokens, codex.rawTokens);
  assert.equal(codex.apiEquivalentUsd, 0);
  assert.ok(s.warnings.some((w) => w.includes('gpt-demo')));
});

test('report: categories of the main agent', () => {
  const s = cliJson(EX_ARGS);
  assert.deepEqual(Object.keys(s.categories), ['orchestration', 'dispatch', 'work']);
  assert.deepEqual(
    Object.values(s.categories).map((c) => c.turns),
    [2, 9, 4],
  );
  const shares = Object.values(s.categories).map((c) => c.shareOfMainUsd);
  close(shares.reduce((x, y) => x + y, 0), 1, 1e-3);
});

test('report: cache rewrites by cause, cold starts apart', () => {
  const s = cliJson(EX_ARGS);
  assert.equal(s.cache.events, 4);
  assert.deepEqual(Object.keys(s.cache.byCause).sort(), ['compaction', 'idle-1h', 'model-switch', 'waiting-on-subagent']);
  assert.equal(s.cache.rewriteTokens, 33000 + 34000 + 22000 + 25000);
  assert.deepEqual([s.cache.coldStarts.events, s.cache.coldStarts.tokens], [3, 30000 + 21000 + 20500]);
  assert.ok(s.cache.top.every((e) => !['session-start', 'subagent-start'].includes(e.cause)));
});

test('report: hand-offs', () => {
  const s = cliJson(EX_ARGS);
  assert.equal(s.tasks.count, 4);
  assert.deepEqual(s.tasks.ledger, { entries: 2, matched: 2 });
  assert.deepEqual(Object.keys(s.tasks.byLabel).sort(), ['agy', 'claude-subagent', 'codex-exec']);
  assert.equal(s.tasks.byLabel['codex-exec'].retries, 1);
  assert.equal(s.tasks.byLabel['codex-exec'].ledgerFailed, 1);
  assert.equal(s.tasks.byLabel['codex-exec'].ledgerOk, 1);
});

test('report: days in the chosen zone', () => {
  const utc = cliJson(EX_ARGS);
  assert.deepEqual(Object.keys(utc.days), ['2026-01-05', '2026-01-06']);
  assert.equal(utc.days['2026-01-06'].mainRaw, 10 + 60 + 20500); // msg_b1 only
  // At UTC+14 the 2026-01-05 day ends at 10:00Z: msg_a1..msg_a8 and the subagent.
  const east = cliJson([...EX_ARGS.slice(0, -2), '--tz', '+14:00']);
  assert.deepEqual(Object.keys(east.days), ['2026-01-05', '2026-01-06']);
  assert.equal(east.days['2026-01-05'].mainRaw, 264245);
  assert.equal(east.days['2026-01-05'].subagentRaw, 21503 + 23403);
});

test('text report has every section', () => {
  const r = cli(EX_ARGS);
  assert.equal(r.code, 0, r.err);
  for (const h of ['Main agent vs subagents', 'By model', "Where the main agent's usage went", 'By day', 'Cache rewrites', 'cold starts', 'Hand-offs']) {
    assert.ok(r.out.includes(h), h);
  }
  assert.ok(!cli([...EX_ARGS, '--no-days']).out.includes('== By day'));
});

test('--since/--until window', () => {
  const s = cliJson([...EX_ARGS, '--since', '2026-01-06']);
  assert.equal(s.totals.all.turns, 1);
  const u = cliJson([...EX_ARGS, '--until', '2026-01-05T09:30']);
  assert.equal(u.totals.bySource.claude.main.turns, 8);
  assert.equal(u.totals.bySource.codex, undefined);
});

test('--dedupe file keeps copies; --merge-subagents folds subagents into the parent', () => {
  assert.equal(cliJson([...EX_ARGS, '--dedupe', 'file']).totals.bySource.claude.main.turns, 14);
  const m = cliJson([...EX_ARGS, '--merge-subagents']);
  assert.equal(m.totals.bySource.claude.main.turns, 15);
  assert.equal(m.totals.bySource.claude.subagent.turns, 0);
});

test('--no-codex and --cwd-rule', () => {
  const s = cliJson([...EX_ARGS, '--no-codex']);
  assert.deepEqual(Object.keys(s.totals.bySource), ['claude']);
  const c = cliJson([...EX_ARGS, '--cwd-rule', 'demo/webapp$=orchestration']);
  assert.equal(c.categories.orchestration.turns, 15);
  assert.equal(c.categories.orchestration.shareOfMainRaw, 1);
});

test('--redact hides working directories and ledger names', () => {
  const s = cliJson([...EX_ARGS, '--redact']);
  const text = JSON.stringify(s);
  assert.ok(!text.includes('/home/demo'));
  assert.ok(!text.includes('j1-retry'));
  assert.match(s.byDirectory[0].cwd, /^dir#[0-9a-f]{6}$/);
});

test('--json <file> writes the file and still prints the text report', () => {
  const f = path.join(tmpDir(), 'out.json');
  const r = cli([...EX_ARGS, '--json', f]);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes('Hand-offs'));
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).tasks.count, 4);
});

test('cache and tasks commands', () => {
  const c = cliJson(['cache', ...EX_ARGS]);
  assert.equal(c.events, 4);
  const ct = cli(['cache', ...EX_ARGS]);
  assert.ok(ct.out.includes('waiting-on-subagent'));
  const t = cliJson(['tasks', ...EX_ARGS]);
  assert.equal(t.all.length, 4);
  assert.ok(cli(['tasks', ...EX_ARGS]).out.includes('codex-exec'));
});

test('compare: two arms by time window', () => {
  const r = cliJson(['compare', ...EX_ARGS, '--arm', 'self=2026-01-05T09:00..2026-01-05T09:30', '--arm', 'delegated=2026-01-05T12:00..2026-01-05T13:00']);
  assert.deepEqual(r.arms.map((a) => [a.label, a.mainTurns]), [['self', 8], ['delegated', 3]]);
  assert.equal(r.arms[0].mainUsdVsFirst, 1);
  assert.equal(r.arms[0].subagentRaw, 21503 + 23403);
  assert.equal(r.arms[0].cacheRewrites, 0); // only the cold start at 09:00, which is not a rewrite
  assert.equal(r.arms[1].cacheRewrites, 3); // idle-1h 12:00, compaction 12:06, model-switch 12:30
  assert.match(r.note, /anecdote/);
});

test('compare: session arms and errors', () => {
  const r = cliJson(['compare', ...EX_ARGS, '--arm', 'a=session:aaaa1111', '--arm', 'b=session:bbbb2222']);
  assert.deepEqual(r.arms.map((a) => a.mainTurns), [12, 1]);
  assert.equal(cli(['compare', ...EX_ARGS, '--arm', 'a=session:aaaa']).code, 1);
  assert.match(cli(['compare', ...EX_ARGS, '--arm', 'a=2026-01-05', '--arm', 'b=x']).err, /Bad window|Bad --arm|needs/);
});

test('rules, help, version, errors', () => {
  const rules = cli(['rules']);
  assert.equal(rules.code, 0);
  assert.deepEqual(JSON.parse(rules.out), JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'default-rules.json'), 'utf8')));
  assert.match(cli(['--help']).out, /Usage:/);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(cli(['--version']).out.trim(), pkg.version);
  const bad = cli(['frobnicate', ...EX_ARGS]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /Unknown command/);
  const missing = cli(['--claude-dir', path.join(EX, 'nope'), '--no-codex']);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /does not exist/);
  assert.match(cli(['--tz']).err, /needs a value/);
});

test('no log directories at all is an error, not an empty report', () => {
  const empty = tmpDir();
  const r = cli(['--no-claude', '--no-codex'], { env: { ...process.env, HOME: empty, USERPROFILE: empty } });
  assert.equal(r.code, 1);
  assert.match(r.err, /No log directory/);
});
