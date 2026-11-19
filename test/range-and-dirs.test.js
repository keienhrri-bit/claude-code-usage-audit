// 0.1.4: compare stays inside --since/--until, and log directories that cannot be read are
// reported instead of counted as empty. Expected numbers come from the example logs; see the
// turn list in scripts/make-example-logs.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cli, cliJson, EX_ARGS, EX, tmpDir, writeLines, asst, usage } from './helpers.js';
import { walk, tryEachLine } from '../src/readers/fsutil.js';
import { readClaude } from '../src/readers/claude.js';
import { readCodex } from '../src/readers/codex.js';

const SUBAGENT_RAW = 21503 + 23403; // the two subagent turns at 09:26 and 09:29

const arms = (r) => r.arms.map((a) => [a.label, a.mainTurns, a.subagentRaw, a.tasksLaunched, a.cacheRewrites]);

test('compare: --until cuts a session arm', () => {
  const r = cliJson(['compare', ...EX_ARGS, '--until', '2026-01-05T09:30', '--arm', 'a=session:aaaa1111', '--arm', 'b=session:bbbb2222']);
  // aaaa1111 up to 09:30: eight main turns (09:00..09:25), both subagent turns, the launches at
  // 09:12 and 09:25; the 09:00 cold start is not a rewrite. bbbb2222 only has a turn on 01-06.
  assert.deepEqual(arms(r), [['a', 8, SUBAGENT_RAW, 2, 0], ['b', 0, 0, 0, 0]]);
  assert.match(r.arms[1].stretches[0], /outside --since\/--until/);
});

test('compare: --since cuts a session arm and a time-window arm', () => {
  const r = cliJson(['compare', ...EX_ARGS, '--since', '2026-01-05T12:00', '--arm', 'a=session:aaaa1111', '--arm', 'w=2026-01-05..2026-01-06']);
  // aaaa1111 from 12:00: 12:00, 12:06, 12:30; launch T3 at 12:06; idle-1h, compaction, model-switch.
  // The window arm adds the two Codex turns (launch T4 at 13:02) and bbbb2222 on 01-06 with its
  // idle-1h rewrite.
  assert.deepEqual(arms(r), [['a', 3, 0, 1, 3], ['w', 6, 0, 2, 4]]);
});

test('compare: a session@window arm is intersected with the report window', () => {
  const r = cliJson(['compare', ...EX_ARGS, '--until', '2026-01-05T12:10', '--arm', 'x=session:aaaa1111@2026-01-05T10:00..2026-01-05T13:00', '--arm', 'y=session:bbbb2222']);
  // 10:40, 12:00, 12:06; 12:30 is after --until.
  assert.deepEqual(arms(r)[0], ['x', 3, 0, 1, 3]);
  assert.match(r.arms[0].stretches[0], /^2026-01-05 10:40\.\.2026-01-05 12:06/);
});

test('compare without --since/--until is unchanged', () => {
  const r = cliJson(['compare', ...EX_ARGS, '--arm', 'a=session:aaaa1111', '--arm', 'b=session:bbbb2222']);
  assert.deepEqual(arms(r), [['a', 12, SUBAGENT_RAW, 3, 4], ['b', 1, 0, 0, 1]]);
  assert.match(r.arms[0].stretches[0], /^2026-01-05 09:00\.\.2026-01-05 12:30/);
});

test('an explicit log directory that is a file is an error', () => {
  for (const [flag, other] of [['--claude-dir', '--no-codex'], ['--codex-dir', '--no-claude']]) {
    const r = cli([flag, path.join(EX, 'ledger.jsonl'), other]);
    assert.equal(r.code, 1, `${flag}: ${r.out}`);
    assert.match(r.err, /is not a directory/);
    assert.equal(r.out, '');
  }
});

test('an explicit directory without any session log warns instead of reporting zero silently', () => {
  const empty = tmpDir();
  fs.writeFileSync(path.join(empty, 'notes.txt'), 'x');
  const r = cli(['--claude-dir', empty, '--no-codex', '--tz', 'UTC']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /! No Claude Code session logs \(\*\.jsonl\) found under/);
  const j = cliJson(['--claude-dir', empty, '--no-codex', '--tz', 'UTC']);
  assert.ok(j.warnings.some((w) => /No Claude Code session logs/.test(w)));
  // The other commands do not print warnings in their output, so it goes to stderr.
  const c = cli(['compare', '--claude-dir', empty, '--no-codex', '--arm', 'a=2026-01-05..2026-01-06', '--arm', 'b=2026-01-07..2026-01-08']);
  assert.equal(c.code, 0, c.err);
  assert.match(c.err, /No Claude Code session logs/);
  // Filtering everything out with --since is not a warning.
  const old = cliJson([...EX_ARGS, '--since', '2099-01-01']);
  assert.ok(!old.warnings.some((w) => /No .* session logs/.test(w)));
});

test('the 0-turn header has no "undefined"', () => {
  const r = cli(['--claude-dir', tmpDir(), '--no-codex', '--tz', 'UTC']);
  assert.equal(r.code, 0, r.err);
  assert.ok(!r.out.includes('undefined'), r.out.split('\n').find((l) => l.includes('undefined')));
});

test('walk: an unreadable subdirectory is reported and skipped; an unreadable root throws', () => {
  const root = tmpDir();
  writeLines(path.join(root, 'ok', 'a.jsonl'), ['{}']);
  writeLines(path.join(root, 'locked', 'b.jsonl'), ['{}']);
  const locked = path.join(root, 'locked');
  const readdir = (dir, o) => {
    if (dir === locked) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    return fs.readdirSync(dir, o);
  };
  const errors = [];
  const files = walk(root, (n) => n.endsWith('.jsonl'), { readdir, onError: (p, e) => errors.push([p, e.code]) });
  assert.deepEqual(files, [path.join(root, 'ok', 'a.jsonl')]);
  assert.deepEqual(errors, [[locked, 'EACCES']]);
  // The root itself: missing reads as empty, anything else throws.
  assert.deepEqual(walk(path.join(root, 'nope'), () => true), []);
  assert.throws(() => walk(locked, () => true, { readdir }), /Cannot read .*locked.*EACCES/);
  assert.throws(() => walk(path.join(root, 'ok', 'a.jsonl'), () => true), /ENOTDIR/);
});

test('tryEachLine returns the file system error instead of hanging or throwing', async () => {
  const dir = tmpDir();
  // A directory opens on POSIX and fails on the first read, and fails to open on Windows.
  assert.equal((await tryEachLine(dir, () => {}))?.code, 'EISDIR');
  assert.equal((await tryEachLine(path.join(dir, 'missing.jsonl'), () => {}))?.code, 'ENOENT');
  const f = path.join(dir, 'ok.jsonl');
  fs.writeFileSync(f, 'a\n\nb\n');
  const lines = [];
  assert.equal(await tryEachLine(f, (l) => lines.push(l)), null);
  assert.deepEqual(lines, ['a', 'b']);
  await assert.rejects(tryEachLine(f, () => { throw new TypeError('bug in the caller'); }), TypeError);
});

test('readers return the list of unreadable paths (empty when all is readable)', async () => {
  const root = tmpDir();
  writeLines(path.join(root, 'p', 'S1.jsonl'), [asst({ id: 'm1', ts: '2026-01-05T09:00:00Z', u: usage(1, 1) })]);
  const claude = await readClaude(root);
  assert.deepEqual(claude.turns.map((t) => t.id), ['m1']);
  assert.deepEqual(claude.unreadable, []);
  const codexRoot = tmpDir();
  writeLines(path.join(codexRoot, '2026', '01', '05', 'rollout-x.jsonl'), [
    { type: 'event_msg', timestamp: '2026-01-05T09:00:00Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } } } },
  ]);
  const codex = await readCodex(codexRoot);
  assert.equal(codex.turns.length, 1);
  assert.deepEqual(codex.unreadable, []);
});

// Take read access away from the current user: chmod on POSIX, a deny entry on Windows.
const WIN = process.platform === 'win32';
const user = process.env.USERNAME;
function lock(p) {
  if (!WIN) return fs.chmodSync(p, 0o000);
  const isDir = fs.statSync(p).isDirectory();
  const r = spawnSync('icacls', [p, '/deny', `${user}:${isDir ? '(OI)(CI)(RD)' : '(R)'}`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`icacls: ${r.stdout}${r.stderr}`);
}
function unlock(p, mode) {
  if (!WIN) return fs.chmodSync(p, mode);
  spawnSync('icacls', [p, '/remove:d', user], { encoding: 'utf8' });
}
const canLock = WIN ? !!user : !(process.getuid && process.getuid() === 0);

const readable = (dir) => {
  try {
    fs.readdirSync(dir);
    return true;
  } catch {
    return false;
  }
};

test('end to end: an unreadable subdirectory and file are named, and hidden with --redact', { skip: !canLock && 'root can read anything' }, (t) => {
  const root = tmpDir();
  writeLines(path.join(root, '-w-ok', 'S1.jsonl'), [asst({ id: 'm1', ts: '2026-01-05T09:00:00Z', u: usage(10, 1) })]);
  writeLines(path.join(root, '-w-secretproj', 'S2.jsonl'), [asst({ sid: 'S2', id: 'm2', ts: '2026-01-05T09:00:00Z', u: usage(10, 1) })]);
  writeLines(path.join(root, '-w-ok', 'S3.jsonl'), [asst({ sid: 'S3', id: 'm3', ts: '2026-01-05T09:00:00Z', u: usage(10, 1) })]);
  const lockedDir = path.join(root, '-w-secretproj');
  const lockedFile = path.join(root, '-w-ok', 'S3.jsonl');
  lock(lockedDir);
  lock(lockedFile);
  try {
    // A process with backup privileges (an elevated Windows shell) reads past a deny entry.
    if (readable(lockedDir)) return void t.skip('this process can still read the locked directory');
    const args = ['--claude-dir', root, '--no-codex', '--tz', 'UTC'];
    const j = cliJson(args);
    assert.equal(j.totals.all.turns, 1);
    const w = j.warnings.find((x) => /Could not read/.test(x));
    assert.ok(w, JSON.stringify(j.warnings));
    assert.match(w, /Could not read 2 paths/);
    assert.match(w, /-w-secretproj/);
    assert.match(w, /S3\.jsonl/);
    assert.equal(j.parsing.claude.unreadable, 2);
    const tasks = cli(['tasks', ...args]);
    assert.equal(tasks.code, 0, tasks.err);
    assert.match(tasks.err, /Could not read 2 paths/);
    const red = cli([...args, '--redact', '--json', '-']);
    assert.equal(red.code, 0, red.err);
    assert.ok(!red.out.includes('secretproj') && !red.err.includes('secretproj'));
    assert.match(red.out, /Could not read 2 paths under the Claude Code log directory/);
    // An unreadable root is an error, not an empty report.
    lock(root);
    const r = cli(args);
    assert.equal(r.code, 1);
    assert.match(r.err, /Cannot read/);
  } finally {
    unlock(root, 0o755);
    unlock(lockedDir, 0o755);
    unlock(lockedFile, 0o644);
  }
});
