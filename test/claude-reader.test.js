import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readClaude } from '../src/readers/claude.js';
import { tmpDir, writeLines, writeJson, usage, asst, toolUse } from './helpers.js';

// projects/p1/S1.jsonl          m1 (three lines), synthetic, broken line, compact, m2, m3, sidechain m6
// projects/p1/S2.jsonl          copy of m1 (resumed session), m4 (no cache breakdown)
// projects/p1/S1/subagents/     agent-x.jsonl (m5) + agent-x.meta.json
function fixture() {
  const root = tmpDir();
  const p = path.join(root, 'p1');
  const m1a = usage(10, 10, { w1: 30000 });
  const m1b = usage(10, 50, { w1: 30000 });
  writeLines(path.join(p, 'S1.jsonl'), [
    { type: 'user', sessionId: 'S1', timestamp: '2026-01-05T08:59:00Z', message: { role: 'user', content: 'hi' } },
    asst({ id: 'm1', ts: '2026-01-05T09:00:00Z', u: m1a, content: [{ type: 'thinking', thinking: '' }] }),
    asst({ id: 'm1', ts: '2026-01-05T09:00:00Z', u: m1a, content: [{ type: 'text', text: 'a' }] }),
    asst({ id: 'm1', ts: '2026-01-05T09:00:00Z', u: m1b, content: [{ type: 'text', text: 'b' }] }),
    asst({ id: 'syn', ts: '2026-01-05T09:00:30Z', model: '<synthetic>', u: usage(0, 0) }),
    '{"type":"assistant", this line is cut off',
    { type: 'system', subtype: 'compact_boundary', sessionId: 'S1', timestamp: '2026-01-05T09:01:00Z' },
    asst({ id: 'm2', ts: '2026-01-05T09:02:00Z', u: usage(5, 20, { w1: 25000 }) }),
    asst({ id: 'm3', ts: '2026-01-05T09:03:00Z', u: usage(5, 20, { cr: 25000 }), content: [toolUse('Bash', { command: 'pwsh -File C:\\Users\\Demo\\Run.ps1' }, 'toolu_b')] }),
    asst({ id: 'm3', ts: '2026-01-05T09:03:00Z', u: usage(5, 20, { cr: 25000 }), content: [toolUse('Bash', { command: 'pwsh -File C:\\Users\\Demo\\Run.ps1' }, 'toolu_b')] }),
    asst({ id: 'm6', ts: '2026-01-05T09:04:00Z', u: usage(1, 1), extra: { isSidechain: true } }),
  ]);
  writeLines(path.join(p, 'S2.jsonl'), [
    asst({ sid: 'S1', id: 'm1', ts: '2026-01-05T09:00:00Z', u: m1b }),
    asst({ sid: 'S2', id: 'm4', ts: '2026-01-06T10:00:00Z', u: usage(2, 3, { w5: 1000, breakdown: false }) }),
  ]);
  const sub = path.join(p, 'S1', 'subagents');
  writeLines(path.join(sub, 'agent-x.jsonl'), [
    asst({ id: 'm5', ts: '2026-01-05T09:05:00Z', model: 'claude-haiku-5-5', u: usage(3, 4, { w5: 21000 }), extra: { isSidechain: true, agentId: 'x' } }),
  ]);
  writeJson(path.join(sub, 'agent-x.meta.json'), { agentType: 'reviewer', toolUseId: 'toolu_1' });
  fs.writeFileSync(path.join(p, 'notes.txt'), 'not a log');
  return root;
}

test('one response written as several lines is one turn, with the last usage', async () => {
  const { turns, stats } = await readClaude(fixture());
  const m1 = turns.filter((t) => t.id === 'm1');
  assert.equal(m1.length, 1);
  assert.equal(m1[0].output, 50);
  assert.equal(m1[0].cacheWrite1h, 30000);
  assert.equal(m1[0].cacheWrite5m, 0);
  const m3 = turns.find((t) => t.id === 'm3');
  assert.equal(m3.tools.length, 1, 'the same tool_use id is kept once');
  assert.equal(stats.assistantLines, 10);
});

test('copies of a message in other files are dropped by default and kept with dedupe=file', async () => {
  const root = fixture();
  const g = await readClaude(root);
  assert.deepEqual(g.turns.map((t) => t.id).sort(), ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
  assert.equal(g.stats.crossFileDuplicates, 1);
  assert.equal(g.stats.files, 3);
  const f = await readClaude(root, { dedupe: 'file' });
  assert.equal(f.turns.filter((t) => t.id === 'm1').length, 2);
});

test('synthetic and unparseable lines are skipped', async () => {
  const { turns } = await readClaude(fixture());
  assert.equal(turns.some((t) => t.id === 'syn' || t.model === '<synthetic>'), false);
});

test('compaction marks the next turn', async () => {
  const { turns } = await readClaude(fixture());
  assert.equal(turns.find((t) => t.id === 'm1').compactBefore, false);
  assert.equal(turns.find((t) => t.id === 'm2').compactBefore, true);
  assert.equal(turns.find((t) => t.id === 'm3').compactBefore, false);
});

test('tool input is lower-cased with forward slashes', async () => {
  const { turns } = await readClaude(fixture());
  const c = turns.find((t) => t.id === 'm3').tools[0];
  assert.equal(c.name, 'Bash');
  assert.equal(c.text, 'pwsh -file c:/users/demo/run.ps1');
});

test('subagent transcripts are their own sessions, linked to the parent', async () => {
  const { turns } = await readClaude(fixture());
  const m5 = turns.find((t) => t.id === 'm5');
  assert.equal(m5.kind, 'subagent');
  assert.equal(m5.agentType, 'reviewer');
  assert.equal(m5.parentToolUseId, 'toolu_1');
  assert.equal(m5.parentSessionId, 'S1');
  assert.equal(m5.sessionId, 'S1/x');
  const m6 = turns.find((t) => t.id === 'm6');
  assert.equal(m6.kind, 'subagent');
  assert.equal(m6.agentType, 'sidechain');
  assert.equal(turns.find((t) => t.id === 'm2').kind, 'main');
});

test('cache writes without the 5m/1h breakdown count as 5-minute writes', async () => {
  const { turns } = await readClaude(fixture());
  const m4 = turns.find((t) => t.id === 'm4');
  assert.equal(m4.cacheWrite5m, 1000);
  assert.equal(m4.cacheWrite1h, 0);
  assert.equal(m4.sessionId, 'S2');
});

test('files last written before sinceMs are skipped', async () => {
  const root = fixture();
  const old = new Date('2025-01-01T00:00:00Z');
  fs.utimesSync(path.join(root, 'p1', 'S2.jsonl'), old, old);
  const { turns, stats } = await readClaude(root, { sinceMs: Date.UTC(2026, 0, 1) });
  assert.equal(stats.skippedOld, 1);
  assert.equal(turns.some((t) => t.id === 'm4'), false);
});

test('a missing directory reads as empty', async () => {
  const { turns, stats } = await readClaude(path.join(tmpDir(), 'nope'));
  assert.equal(turns.length, 0);
  assert.equal(stats.files, 0);
});
