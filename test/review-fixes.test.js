// Regression tests for the issues fixed in 0.1.1. Each test reproduces one reported problem.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readClaude } from '../src/readers/claude.js';
import { groupSessions } from '../src/analyze.js';
import { extractKeys, attributeTasks } from '../src/tasks.js';
import { loadRules, classifyAll } from '../src/rules.js';
import { makeZone, parseTime, parseUntil } from '../src/time.js';
import { normalizeText } from '../src/readers/fsutil.js';
import { cli, cliJson, EX_ARGS, tmpDir, writeLines, writeJson, usage, asst, toolUse, turn, call, at } from './helpers.js';

const close = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const R = loadRules();
function run(list) {
  const sessions = groupSessions(list);
  classifyAll(R, sessions);
  return { ...attributeTasks(sessions, R), sessions };
}

test('task cost counts only turns inside the report window', () => {
  // The subagent task is launched at 09:25; its report is read at 10:40, after --until.
  const s = cliJson([...EX_ARGS, '--until', '2026-01-05T09:30']);
  assert.ok(s.tasks.attributedShareOfMainUsd <= 1);
  close(s.tasks.attributedMainUsd, s.categories.dispatch.apiEquivalentUsd);
  // A task launched before --since whose report is read inside the window is listed, with the
  // in-window turns only.
  const late = cliJson([...EX_ARGS, '--since', '2026-01-05T10:00']);
  close(late.tasks.attributedMainUsd, late.categories.dispatch.apiEquivalentUsd);
  const sub = late.tasks.all.find((r) => r.label === 'claude-subagent');
  assert.ok(sub, 'task launched at 09:25 and reviewed at 10:40 is listed');
  assert.deepEqual(Object.keys(sub.phaseUsd), ['review']);
  assert.equal(sub.workerRaw, 0, 'its subagent ran before the window');
});

test('assistant lines with spaces after the colons are read', async () => {
  const root = tmpDir();
  const line = JSON.stringify(asst({ id: 'sp1', ts: '2026-01-05T09:00:00Z', u: usage(1, 2) })).replace(/":/g, '": ');
  writeLines(path.join(root, 'p', 'S1.jsonl'), [line]);
  const { turns } = await readClaude(root);
  assert.deepEqual(turns.map((t) => [t.id, t.output]), [['sp1', 2]]);
});

test('sidechain records in a main log are a session of their own', async () => {
  const root = tmpDir();
  writeLines(path.join(root, 'p', 'S1.jsonl'), [
    asst({ sid: 'S1', id: 'a1', ts: '2026-01-05T09:00:00Z', u: usage(1, 1, { w1: 30000 }) }),
    asst({ sid: 'S1', id: 'sc1', ts: '2026-01-05T09:01:00Z', u: usage(1, 1, { w5: 25000 }), extra: { isSidechain: true }, content: [toolUse('Bash', { command: 'codex exec -C /w/jobs/side1 "go"' })] }),
    asst({ sid: 'S1', id: 'a2', ts: '2026-01-05T09:02:00Z', u: usage(1, 1, { cr: 30000 }) }),
  ]);
  const { turns } = await readClaude(root);
  const sc = turns.find((t) => t.id === 'sc1');
  assert.equal(sc.kind, 'subagent');
  assert.notEqual(sc.sessionId, 'S1');
  assert.equal(sc.parentSessionId, 'S1');
  const { tasks, sessions } = run(turns);
  assert.equal(tasks.length, 0, 'a launch by a sidechain is not a main-agent hand-off');
  assert.deepEqual(sessions.get('S1').map((t) => t.id), ['a1', 'a2']);
});

test('quoted paths with spaces stay whole', () => {
  const keys = (text, cwd) => [...extractKeys(normalizeText(text), cwd)].sort();
  assert.deepEqual(keys('codex exec --out "C:\\Shared Work\\jobs\\alpha"', 'C:\\repo'), ['c:/shared work/jobs/alpha']);
  assert.deepEqual(keys('codex exec "fix /w/src/a.ts, report to /w/jobs/j1/report.md"', null), ['/w/jobs/j1/report.md', '/w/src/a.ts']);
  assert.deepEqual(keys('codex exec --out "/home/u/my jobs/beta"', null), ['/home/u/my jobs/beta']);
  // Quoted commands and prompts that start with a path are scanned word by word, as before.
  assert.deepEqual(keys('codex exec "/w/jobs/j1/brief.md do this"', null), ['/w/jobs/j1/brief.md']);
  assert.deepEqual(keys('bash -c "/w/tools/run.sh /w/jobs/j1"', null), ['/w/jobs/j1']);
  assert.deepEqual(keys('claude -p "/review src/auth.ts"', null), ['src/auth.ts']);
  assert.deepEqual(keys('pwsh -c "C:\\w\\run.ps1 -taskfile C:\\w\\jobs\\j2\\brief.md"', null), ['c:/w/jobs/j2/brief.md']);
  const { tasks } = run([
    turn({ ts: at(0), cwd: 'C:\\repo', tools: [call('Bash', 'codex exec --out "C:\\Shared Work\\jobs\\alpha"')] }),
    turn({ ts: at(5), cwd: 'C:\\repo', tools: [call('Bash', 'codex exec --out "C:\\Shared Work\\jobs\\beta"')] }),
  ]);
  assert.equal(tasks[1].retryOf, null);
});

test('four launches on one job dir are three retries; a file shared by four different jobs is not a key', () => {
  const same = run([0, 10, 20, 30].map((m) => turn({ ts: at(m), tools: [call('Bash', 'codex exec -C /w/jobs/job001 "go"')] })));
  assert.deepEqual(same.tasks.map((t) => t.retryOf), [null, 'T1', 'T1', 'T1']);
  const generic = run(['a1', 'a2', 'a3', 'a4'].map((j, i) => turn({ ts: at(i * 10), tools: [call('Bash', `codex exec -C /w/jobs/${j} "read /w/tmp/brief.md"`)] })));
  assert.deepEqual(generic.tasks.map((t) => t.retryOf), [null, null, null, null]);
  for (const t of generic.tasks) assert.ok(!t.keys.has('/w/tmp/brief.md'));
});

test('a --cwd-rule category is not overridden by task attribution', () => {
  const s = cliJson([...EX_ARGS, '--cwd-rule', '.*=work']);
  assert.equal(s.categories.dispatch.turns, 0);
  assert.equal(s.categories.work.shareOfMainRaw, 1);
});

test('compare: a session arm keeps its subagents while the main agent waits', () => {
  const r = cliJson(['compare', ...EX_ARGS, '--arm', 'a=session:aaaa1111@2026-01-05T09:26..2026-01-05T09:30', '--arm', 'b=session:bbbb2222']);
  assert.equal(r.arms[0].mainTurns, 0);
  assert.equal(r.arms[0].subagentRaw, 21503 + 23403);
});

test('cross-file copies: the earliest-started file wins regardless of file names, tool calls are merged', async () => {
  for (const [origName, forkName] of [['z-orig', 'a-fork'], ['a-orig', 'z-fork']]) {
    const root = tmpDir();
    writeLines(path.join(root, 'p', `${origName}.jsonl`), [
      asst({ sid: 'orig', id: 'o0', ts: '2026-01-05T09:00:00Z', u: usage(1, 1) }),
      asst({ sid: 'orig', id: 'mx', ts: '2026-01-05T09:05:00Z', u: usage(1, 5), content: [{ type: 'text', text: 'a' }] }),
    ]);
    writeLines(path.join(root, 'p', `${forkName}.jsonl`), [
      asst({ sid: 'fork', id: 'mx', ts: '2026-01-05T09:05:00Z', u: usage(1, 5), content: [toolUse('Read', { file_path: '/w/a.md' }, 'toolu_x')] }),
      asst({ sid: 'fork', id: 'f1', ts: '2026-01-05T10:00:00Z', u: usage(1, 1) }),
    ]);
    const { turns } = await readClaude(root);
    const mx = turns.filter((t) => t.id === 'mx');
    assert.equal(mx.length, 1);
    assert.equal(mx[0].sessionId, 'orig', `${origName} / ${forkName}`);
    assert.deepEqual(mx[0].tools.map((c) => c.id), ['toolu_x']);
  }
});

test('cross-file copies: a resumed session starts at the same moment; the file that ended first wins', async () => {
  for (const [origName, resName] of [['z-orig', 'a-resumed'], ['a-orig', 'z-resumed']]) {
    const root = tmpDir();
    const history = (sid) => [
      asst({ sid, id: 'h1', ts: '2026-01-05T09:00:00Z', u: usage(1, 1) }),
      asst({ sid, id: 'h2', ts: '2026-01-05T09:05:00Z', u: usage(1, 2) }),
    ];
    writeLines(path.join(root, 'p', `${origName}.jsonl`), history('orig'));
    writeLines(path.join(root, 'p', `${resName}.jsonl`), [...history('resumed'), asst({ sid: 'resumed', id: 'r1', ts: '2026-01-06T10:00:00Z', u: usage(1, 1) })]);
    const { turns } = await readClaude(root);
    assert.deepEqual(turns.map((t) => [t.id, t.sessionId]).sort(), [['h1', 'orig'], ['h2', 'orig'], ['r1', 'resumed']], `${origName} / ${resName}`);
  }
});

test('--until a date ends at the next local midnight across DST changes', () => {
  const ny = makeZone('America/New_York');
  assert.equal(parseUntil(ny, '2026-03-08'), parseTime(ny, '2026-03-09') - 1);
  assert.equal(parseUntil(ny, '2026-11-01'), parseTime(ny, '2026-11-02') - 1);
  assert.equal(parseUntil(ny, '2026-11-01') - parseTime(ny, '2026-11-01'), 25 * 3600000 - 1);
});

test('the median of an even number of tasks is the mean of the middle two', () => {
  const s = cliJson(EX_ARGS);
  const v = s.tasks.all.map((r) => r.mainUsd).sort((x, y) => x - y);
  assert.equal(v.length, 4);
  close(s.tasks.medianMainUsdPerTask, (v[1] + v[2]) / 2);
});

test('impossible dates and times are rejected', () => {
  const z = makeZone('UTC');
  for (const s of ['2026-02-30', '2026-13-01', '2026-01-05T25:00', '2026-01-05T10:60', '2026-02-30T00:00Z', '2026-04-31T00:00+08:00']) {
    assert.throws(() => parseTime(z, s), /Bad time/, s);
  }
  assert.equal(parseTime(z, '2028-02-29'), Date.UTC(2028, 1, 29));
});

test('--cwd-rule does not write a temp file', () => {
  const missing = path.join(tmpDir(), 'no-such-dir');
  const env = { ...process.env, TMPDIR: missing, TEMP: missing, TMP: missing };
  const r = cli([...EX_ARGS, '--cwd-rule', 'demo/webapp$=orchestration', '--json', '-'], { env });
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).options.rules, '--cwd-rule');
  assert.equal(fs.existsSync(missing), false);
});

test('--redact hides the path of a --prices file', () => {
  const dir = path.join(tmpDir(), 'secret-folder');
  const f = writeJson(path.join(dir, 'prices.json'), { models: { 'claude-opus-5-5': { input: 5, output: 25 } } });
  const needle = normalizeText(dir).split('/').pop();
  const j = cli([...EX_ARGS, '--prices', f, '--redact', '--json', '-']);
  assert.equal(j.code, 0, j.err);
  assert.ok(!j.out.includes(needle), 'JSON output');
  assert.match(JSON.parse(j.out).options.prices, /overrides from a local file/);
  for (const cmd of ['report', 'tasks', 'cache']) {
    const t = cli([cmd, ...EX_ARGS, '--prices', f, '--redact']);
    assert.equal(t.code, 0, t.err);
    assert.ok(!t.out.includes(needle), `${cmd} text output`);
  }
  assert.ok(cliJson([...EX_ARGS, '--prices', f]).options.prices.includes(needle), 'shown without --redact');
});
