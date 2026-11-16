import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readCodex } from '../src/readers/codex.js';
import { tmpDir, writeLines } from './helpers.js';

const ts = (m) => `2026-01-05T13:${String(m).padStart(2, '0')}:00Z`;
const tc = (m, total, last) => ({ timestamp: ts(m), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } } });
const u = (input, cached, output) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output });

function fixture() {
  const root = tmpDir();
  const day = path.join(root, '2026', '01', '05');
  writeLines(path.join(day, 'rollout-2026-01-05T13-00-00-main.jsonl'), [
    { timestamp: ts(0), type: 'session_meta', payload: { id: 'C1', cwd: '/home/t/proj', originator: 'test' } },
    { timestamp: ts(0), type: 'turn_context', payload: { model: 'gpt-x', cwd: '/home/t/proj' } },
    { timestamp: ts(1), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'k1', arguments: JSON.stringify({ cmd: 'codex exec "Do It"' }) } },
    tc(2, u(1000, 600, 50), u(1000, 600, 50)),
    tc(2, u(1000, 600, 50), u(1000, 600, 50)), // written twice
    { timestamp: ts(3), type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'k2', input: '*** Begin Patch\n*** Update File: C:\\Proj\\A.md' } },
    { timestamp: ts(3), type: 'response_item', payload: { type: 'local_shell_call', call_id: 'k3', action: { command: ['bash', '-lc', 'ls'] } } },
    tc(4, u(2500, 2000, 80), u(1500, 1400, 30)),
    { timestamp: ts(5), type: 'event_msg', payload: { type: 'token_count', info: null } },
    tc(6, u(300, 0, 10), u(300, 0, 10)), // counter reset (new process)
    'not json',
  ]);
  writeLines(path.join(day, 'rollout-2026-01-05T13-30-00-sub.jsonl'), [
    { timestamp: ts(30), type: 'session_meta', payload: { id: 'C2', cwd: '/home/t/proj', parent_thread_id: 'C1', source: { subagent: { other: 'reviewer' } } } },
    tc(31, u(100, 0, 5), u(100, 0, 5)),
  ]);
  writeLines(path.join(day, 'rollout-2026-01-05T13-40-00-sub2.jsonl'), [
    { timestamp: ts(40), type: 'session_meta', payload: { id: 'C3', source: { subagent: 'review' } } },
    tc(41, u(10, 0, 1), u(10, 0, 1)),
  ]);
  writeLines(path.join(day, 'history.jsonl'), [tc(50, u(9999, 0, 9999), u(9999, 0, 9999))]);
  return root;
}

test('token_count events become turns from the growth of total_token_usage', async () => {
  const { turns, stats } = await readCodex(fixture());
  const main = turns.filter((t) => t.sessionId === 'C1');
  assert.equal(main.length, 3);
  assert.equal(stats.duplicateEvents, 1);
  assert.equal(stats.tokenEvents, 6);
  assert.deepEqual(
    main.map((t) => [t.input, t.cacheRead, t.output]),
    [[400, 600, 50], [100, 1400, 30], [300, 0, 10]],
  );
  assert.equal(main[0].model, 'gpt-x');
  assert.equal(main[0].cwd, '/home/t/proj');
  assert.equal(main[0].source, 'codex');
  assert.equal(main[0].kind, 'main');
});

test('tool calls attach to the next token_count turn', async () => {
  const { turns } = await readCodex(fixture());
  const main = turns.filter((t) => t.sessionId === 'C1');
  assert.deepEqual(main[0].tools.map((c) => c.name), ['exec_command']);
  assert.equal(main[0].tools[0].text, 'codex exec "do it"');
  assert.deepEqual(main[1].tools.map((c) => c.name), ['apply_patch', 'local_shell']);
  assert.match(main[1].tools[0].text, /c:\/proj\/a\.md/);
  assert.equal(main[2].tools.length, 0);
});

test('subagent sessions are recognised from session_meta.source', async () => {
  const { turns } = await readCodex(fixture());
  const c2 = turns.find((t) => t.sessionId === 'C2');
  assert.equal(c2.kind, 'subagent');
  assert.equal(c2.agentType, 'reviewer');
  assert.equal(c2.parentSessionId, 'C1');
  const c3 = turns.find((t) => t.sessionId === 'C3');
  assert.equal(c3.kind, 'subagent');
  assert.equal(c3.agentType, 'review');
});

test('only rollout-*.jsonl files are read', async () => {
  const { turns, stats } = await readCodex(fixture());
  assert.equal(stats.files, 3);
  assert.equal(turns.some((t) => t.input === 9999), false);
});
