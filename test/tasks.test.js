import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { extractKeys, attributeTasks, readLedger } from '../src/tasks.js';
import { loadRules, classifyAll } from '../src/rules.js';
import { analyze, groupSessions } from '../src/analyze.js';
import { makeZone } from '../src/time.js';
import { turn, call, at, tmpDir, writeLines, EX, T0, MIN } from './helpers.js';
import { normalizeText } from '../src/readers/fsutil.js';

const R = loadRules();
const keys = (text, cwd) => [...extractKeys(normalizeText(text), cwd)].sort();

test('keys are job paths and --name/--out values, not launchers, tool dirs or the working dir', () => {
  assert.deepEqual(
    keys('pwsh -file C:\\u\\.claude\\skills\\d\\scripts\\run-worker.ps1 -taskfile C:\\u\\work\\jobs\\j7\\brief.md -outdir C:\\u\\work\\jobs\\j7', 'C:\\u\\work'),
    ['c:/u/work/jobs/j7', 'c:/u/work/jobs/j7/brief.md'],
  );
  assert.deepEqual(keys('codex exec --name ch3-defs "read https://example.com/a/b/c"', null), ['ch3-defs']);
  assert.deepEqual(keys('node scripts/run.mjs --job 42', null), [], 'short values without punctuation are not keys');
  assert.deepEqual(keys('cat /a/b', null), [], 'too short');
});

function run(list, opts = {}) {
  const sessions = groupSessions(list);
  classifyAll(R, sessions);
  return { ...attributeTasks(sessions, R, opts), sessions };
}

test('brief, launch and review turns are attributed to the task', () => {
  const brief = turn({ ts: at(0), tools: [call('Write', '/w/jobs/j1/brief.md')] });
  const launch = turn({ ts: at(2), tools: [call('Bash', 'codex exec -C /w/jobs/j1 "do /w/jobs/j1/brief.md"')] });
  const review = turn({ ts: at(10), tools: [call('Read', '/w/jobs/j1/report.md')] });
  const follow = turn({ ts: at(11) });
  const later = turn({ ts: at(60) });
  const other = turn({ ts: at(61), tools: [call('Read', '/w/app/src/main.ts')] });
  const { tasks } = run([brief, launch, review, follow, later, other]);
  assert.equal(tasks.length, 1);
  const t = tasks[0];
  assert.equal(t.label, 'codex-exec');
  assert.deepEqual(t.turns.map((x) => [x.turn, x.phase]), [[brief, 'brief'], [launch, 'launch'], [review, 'review'], [follow, 'review']]);
  assert.deepEqual(later.taskLinks, [], 'inheritance stops after the lookback window');
  assert.deepEqual(other.taskLinks, []);
  assert.equal(brief.category, 'dispatch');
  assert.equal(brief.categoryReason, 'attributed');
  assert.equal(other.category, 'work');
});

test('a turn that touches two tasks is split between them', () => {
  const l1 = turn({ ts: at(0), tools: [call('Bash', 'codex exec -C /w/jobs/aa1 "go"')] });
  const l2 = turn({ ts: at(1), tools: [call('Bash', 'codex exec -C /w/jobs/bb2 "go"')] });
  const both = turn({ ts: at(5), tools: [call('Read', '/w/jobs/aa1/out.md'), call('Read', '/w/jobs/bb2/out.md')] });
  const { tasks } = run([l1, l2, both]);
  assert.equal(tasks.length, 2);
  for (const t of tasks) assert.deepEqual(t.turns.find((x) => x.turn === both).share, 0.5);
});

test('relaunching on the same job dir is a retry', () => {
  const { tasks } = run([
    turn({ ts: at(0), tools: [call('Bash', 'codex exec -C /w/jobs/j9 "go"')] }),
    turn({ ts: at(20), tools: [call('Bash', 'codex exec -C /w/jobs/j9 "fix it"')] }),
  ]);
  assert.equal(tasks[1].retryOf, tasks[0].id);
});

test('a path the session used long before the launch is ambient, not a key', () => {
  const { tasks } = run([
    turn({ ts: at(0), tools: [call('Read', '/w/scratch/common/notes.md')] }),
    turn({ ts: at(120), tools: [call('Bash', 'codex exec "read /w/scratch/common/notes.md"')] }),
  ]);
  assert.equal(tasks[0].keys.has('/w/scratch/common/notes.md'), false);
});

test('Claude Code subagent transcripts are the worker turns of their launch', () => {
  const launch = turn({ sessionId: 'S', ts: at(0), tools: [call('Agent', 'summarize', 'toolu_9')] });
  const w = turn({ sessionId: 'S/x', parentSessionId: 'S', kind: 'subagent', parentToolUseId: 'toolu_9', ts: at(1) });
  const { tasks } = run([launch, w]);
  assert.equal(tasks[0].label, 'claude-subagent');
  assert.deepEqual(tasks[0].workerTurns, [w]);
});

test('ledger: naive times in the zone, time+seconds or start+end', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'ledger.jsonl');
  writeLines(f, [
    { time: '2026-01-05T09:20:00', seconds: 480, name: 'j1', dir: 'C:\\W\\Jobs\\J1', ok: false },
    { start: '2026-01-05T10:00:00Z', end: '2026-01-05T10:05:00Z', name: 'j2', ok: true },
    { name: 'no-times' },
    'garbage',
  ]);
  const e = readLedger(f, makeZone('+01:00'));
  assert.equal(e.length, 2);
  assert.deepEqual([e[0].start, e[0].end], [Date.UTC(2026, 0, 5, 8, 12), Date.UTC(2026, 0, 5, 8, 20)]);
  assert.equal(e[0].dir, 'c:/w/jobs/j1');
  assert.equal(e[0].ok, false);
  assert.equal(e[1].end - e[1].start, 5 * MIN);
  const s = readLedger(f, makeZone('UTC'), { timeIs: 'start' });
  assert.deepEqual([s[0].start, s[0].end], [Date.UTC(2026, 0, 5, 9, 20), Date.UTC(2026, 0, 5, 9, 28)]);
});

test('ledger entries pair with the launch inside their window that names their dir', () => {
  const launch = turn({ ts: T0 + 12 * MIN, tools: [call('Bash', 'codex exec -C /w/jobs/j1 "go"')] });
  const elsewhere = turn({ ts: T0 + 13 * MIN, tools: [call('Bash', 'codex exec -C /w/jobs/k5 "go"')] });
  const ledger = [{ name: 'j1', dir: '/w/jobs/j1', ok: true, start: T0 + 12 * MIN, end: T0 + 20 * MIN }];
  const { tasks, ledgerMatched } = run([launch, elsewhere], { ledger });
  assert.equal(ledgerMatched, 1);
  assert.equal(tasks[0].ledger.name, 'j1');
  assert.equal(tasks[1].ledger, null);
});

test('the example logs: four hand-offs, one retry, both ledger entries matched', async () => {
  const a = await analyze({
    zone: makeZone('UTC'),
    claudeDir: path.join(EX, 'logs', 'claude', 'projects'),
    codexDir: path.join(EX, 'logs', 'codex', 'sessions'),
    ledger: path.join(EX, 'ledger.jsonl'),
    cacheOpts: {}, taskOpts: {},
  });
  assert.deepEqual(a.tasks.map((t) => t.label), ['codex-exec', 'claude-subagent', 'codex-exec', 'agy']);
  const [t1, t2, t3, t4] = a.tasks;
  assert.equal(t3.retryOf, t1.id);
  assert.equal(t1.ledger.name, 'j1');
  assert.equal(t3.ledger.name, 'j1-retry');
  assert.deepEqual(a.ledgerInfo, { entries: 2, matched: 2 });
  assert.deepEqual(t1.turns.map((x) => [x.turn.id, x.phase]), [['msg_a4', 'brief'], ['msg_a5', 'launch'], ['msg_a6', 'review'], ['msg_a7', 'review']]);
  assert.equal(t2.workerTurns.length, 2);
  assert.deepEqual(t2.turns.map((x) => [x.turn.id, x.phase]), [['msg_a8', 'launch'], ['msg_a9', 'review']]);
  assert.equal(t4.source, 'codex');
  assert.equal(t4.turns.length, 2);
});
