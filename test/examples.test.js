// The committed example logs must be exactly what the generator writes, so the numbers checked
// in cli.test.js always come from the documented script.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, EX, tmpDir } from './helpers.js';

function files(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p, base) : [path.relative(base, p).split(path.sep).join('/')];
  }).sort();
}

test('examples/ matches scripts/make-example-logs.mjs', () => {
  const out = tmpDir();
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'make-example-logs.mjs'), out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  // my-rules.json is a hand-written config example, not generated.
  assert.deepEqual(files(out), files(EX).filter((f) => f !== 'my-rules.json'));
  for (const f of files(out)) {
    const a = fs.readFileSync(path.join(out, f), 'utf8').replace(/\r\n/g, '\n');
    const b = fs.readFileSync(path.join(EX, f), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(a, b, f);
  }
});

test('example data contains no local paths or personal markers', () => {
  for (const f of files(EX)) {
    const text = fs.readFileSync(path.join(EX, f), 'utf8');
    assert.doesNotMatch(text, /[A-Za-z]:\\\\|Users[\\/]|@[a-z0-9-]+\.[a-z]{2,}/i, f);
  }
});
