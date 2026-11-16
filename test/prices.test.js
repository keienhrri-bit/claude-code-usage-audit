import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadPrices, turnCost, turnWeighted, rawTotal } from '../src/prices.js';
import { tmpDir, writeJson, turn, ROOT } from './helpers.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('model lookup: exact id, dated id, context suffix, longest prefix', () => {
  const p = loadPrices();
  const opus = p.models['claude-opus-5-5'];
  assert.ok(opus);
  assert.equal(p.lookup('claude-opus-5-5'), opus);
  assert.equal(p.lookup('claude-opus-5-5-20261101'), opus);
  assert.equal(p.lookup('claude-opus-5-5[1m]'), opus);
  assert.equal(p.lookup('claude-sonnet-5-5-preview'), p.models['claude-sonnet-5-5']);
  assert.equal(p.lookup('gpt-something'), null);
});

test('cost formula, with the documented cache multipliers as fallbacks', () => {
  const t = turn({ input: 1e6, output: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6, cacheRead: 1e6 });
  close(turnCost(t, { input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 }), 9.35);
  close(turnCost(t, { input: 2, output: 10 }), 2 + 10 + 2.5 + 4 + 0.2);
  close(turnWeighted(t, { input: 2, output: 10 }), 18.7e6 / 2);
  assert.equal(turnCost(t, null), null);
  assert.equal(turnWeighted(t, null), null);
  assert.equal(rawTotal(t), 5e6);
});

test('--prices adds and overrides models', () => {
  const dir = tmpDir();
  const p = loadPrices(writeJson(path.join(dir, 'p.json'), { models: { 'gpt-x': { input: 1, output: 4 }, 'claude-opus-5-5': { input: 99, output: 99 } } }));
  assert.equal(p.lookup('gpt-x').output, 4);
  assert.equal(p.lookup('claude-opus-5-5').input, 99);
  assert.match(p.source, /overrides/);
  const flat = loadPrices(writeJson(path.join(dir, 'flat.json'), { 'gpt-y': { input: 1, output: 2 } }));
  assert.equal(flat.lookup('gpt-y').output, 2);
});

test('price table: every model has input/output and the documented cache-write multipliers', () => {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'prices.json'), 'utf8'));
  for (const [id, m] of Object.entries(data.models)) {
    assert.ok(m.input > 0 && m.output > 0, id);
    close(m.cacheWrite5m, m.input * 1.25);
    close(m.cacheWrite1h, m.input * 2);
    assert.ok(m.cacheRead > 0 && m.cacheRead < m.input, id);
  }
});
