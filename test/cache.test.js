import test from 'node:test';
import assert from 'node:assert/strict';
import { detectRewrites, excessCost, isColdStart } from '../src/cache.js';
import { groupSessions } from '../src/analyze.js';
import { turn, at } from './helpers.js';

const causes = (turns, opts) => detectRewrites(groupSessions(turns), opts).map((e) => e.cause);

test('first turn of a session is a cold start, not a rewrite', () => {
  const ev = detectRewrites(groupSessions([turn({ sessionId: 'A', ts: at(0), cacheWrite1h: 30000 })]));
  assert.deepEqual(ev.map((e) => e.cause), ['session-start']);
  assert.equal(isColdStart(ev[0]), true);
  assert.equal(ev[0].gapSeconds, null);
});

test('reading the cached prefix is not a rewrite', () => {
  assert.deepEqual(causes([
    turn({ sessionId: 'A', ts: at(0), cacheWrite1h: 10000 }),
    turn({ sessionId: 'A', ts: at(2), cacheRead: 10000, cacheWrite1h: 25000 }),
  ]), []);
});

test('idle past the 1-hour TTL', () => {
  const ev = detectRewrites(groupSessions([
    turn({ sessionId: 'A', ts: at(0), cacheWrite1h: 1000 }),
    turn({ sessionId: 'A', ts: at(2), cacheRead: 1000, cacheWrite1h: 30000 }),
    turn({ sessionId: 'A', ts: at(92), cacheRead: 0, cacheWrite1h: 31000 }),
  ]));
  assert.deepEqual(ev.map((e) => e.cause), ['idle-1h']);
  assert.equal(ev[0].gapSeconds, 90 * 60);
  assert.equal(ev[0].ttlSeconds, 3600);
  assert.equal(ev[0].rewriteTokens, 31000);
  assert.equal(ev[0].prevContext, 31000);
});

test('idle past the 5-minute TTL', () => {
  assert.deepEqual(causes([
    turn({ sessionId: 'A', ts: at(0), cacheWrite5m: 1000 }),
    turn({ sessionId: 'A', ts: at(1), cacheRead: 1000, cacheWrite5m: 25000 }),
    turn({ sessionId: 'A', ts: at(11), cacheWrite5m: 26000 }),
  ]), ['idle-5m']);
});

test('waiting on a subagent: the gap is covered by a subagent of the same session', () => {
  assert.deepEqual(causes([
    turn({ sessionId: 'A', ts: at(0), cacheWrite1h: 1000 }),
    turn({ sessionId: 'A', ts: at(1), cacheRead: 1000, cacheWrite1h: 30000 }),
    turn({ sessionId: 'A/x', parentSessionId: 'A', kind: 'subagent', ts: at(30) }),
    turn({ sessionId: 'A', ts: at(75), cacheWrite1h: 31000 }),
  ]), ['waiting-on-subagent']);
});

test('compaction comes before model switch, model switch before idle', () => {
  assert.deepEqual(causes([
    turn({ sessionId: 'A', ts: at(0), cacheWrite1h: 1000 }),
    turn({ sessionId: 'A', ts: at(1), cacheRead: 1000, cacheWrite1h: 30000 }),
    turn({ sessionId: 'A', ts: at(200), model: 'claude-sonnet-5-5', compactBefore: true, cacheWrite1h: 22000 }),
  ]), ['compaction']);
  assert.deepEqual(causes([
    turn({ sessionId: 'A', ts: at(0), cacheWrite1h: 1000 }),
    turn({ sessionId: 'A', ts: at(1), cacheRead: 1000, cacheWrite1h: 30000 }),
    turn({ sessionId: 'A', ts: at(200), model: 'claude-sonnet-5-5', cacheWrite1h: 25000 }),
  ]), ['model-switch']);
});

test('a rewrite inside the TTL with the same model is unexplained', () => {
  assert.deepEqual(causes([
    turn({ sessionId: 'A', ts: at(0), cacheWrite1h: 1000 }),
    turn({ sessionId: 'A', ts: at(1), cacheRead: 1000, cacheWrite1h: 30000 }),
    turn({ sessionId: 'A', ts: at(3), cacheRead: 2000, cacheWrite1h: 29000 }),
  ]), ['unexplained']);
});

test('rewrites inside a subagent are prefixed', () => {
  const sub = (o) => turn({ sessionId: 'A/x', parentSessionId: 'A', kind: 'subagent', ...o });
  assert.deepEqual(causes([
    sub({ ts: at(0), cacheWrite5m: 21000 }),
    sub({ ts: at(10), cacheWrite5m: 22000 }),
  ]), ['subagent-start', 'subagent:idle-5m']);
});

test('thresholds: small writes and mostly-read prefixes are ignored', () => {
  const base = [
    turn({ sessionId: 'A', ts: at(0), cacheWrite1h: 1000 }),
    turn({ sessionId: 'A', ts: at(1), cacheRead: 1000, cacheWrite1h: 30000 }),
  ];
  assert.deepEqual(causes([...base, turn({ sessionId: 'A', ts: at(90), cacheWrite1h: 19999 })]), []);
  assert.deepEqual(causes([...base, turn({ sessionId: 'A', ts: at(90), cacheRead: 15500, cacheWrite1h: 25000 })]), []);
  assert.deepEqual(causes([...base, turn({ sessionId: 'A', ts: at(90), cacheRead: 15400, cacheWrite1h: 25000 })]), ['idle-1h']);
  assert.deepEqual(causes([...base, turn({ sessionId: 'A', ts: at(90), cacheWrite1h: 5000 })], { minTokens: 1000 }), ['session-start', 'idle-1h']);
});

test('excess cost is the write price minus the read price', () => {
  const ev = { turn: turn({ cacheWrite5m: 1e6, cacheWrite1h: 1e6 }) };
  const p = { input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 };
  assert.ok(Math.abs(excessCost(ev, p) - (1.15 + 1.9)) < 1e-9);
  assert.equal(excessCost(ev, null), null);
});
