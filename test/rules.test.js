import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadRules, classifyCall, classifyAll, markerFor } from '../src/rules.js';
import { groupSessions } from '../src/analyze.js';
import { tmpDir, writeJson, turn, call, at, EX } from './helpers.js';

const R = loadRules();
const cat = (name, text) => classifyCall(R, call(name, text), turn());

test('default categories', () => {
  assert.deepEqual(R.categories, ['orchestration', 'dispatch', 'work']);
  assert.equal(R.defaultCategory, 'work');
  assert.equal(R.sticky, true);
  assert.equal(R.attributionAsDispatch, true);
});

test('editing agent configuration is orchestration', () => {
  assert.equal(cat('Edit', '{"file_path":"/home/u/.claude/skills/router/SKILL.md"}'), 'orchestration');
  assert.equal(cat('Write', 'C:\\Users\\u\\.claude\\agents\\reviewer.md'), 'orchestration');
  assert.equal(cat('Edit', '/home/u/proj/CLAUDE.md'), 'orchestration');
  assert.equal(cat('Read', '/home/u/proj/AGENTS.md'), 'orchestration');
  assert.equal(cat('Write', '/home/u/proj/.mcp.json'), 'orchestration');
  assert.equal(cat('Edit', '/home/u/.codex/config.toml'), 'orchestration');
  assert.equal(cat('Bash', 'npx ccusage daily --json'), 'orchestration');
  assert.equal(cat('Bash', 'codex mcp list'), 'orchestration');
});

test('launching a worker is dispatch, even from inside .claude/skills', () => {
  assert.equal(cat('Agent', '{"prompt":"summarize"}'), 'dispatch');
  assert.equal(cat('Task', 'x'), 'dispatch');
  assert.equal(cat('Bash', 'codex exec -C /w "do it"'), 'dispatch');
  assert.equal(cat('PowerShell', 'cd C:\\Users\\u\\.claude\\skills\\d; codex exec "x"'), 'dispatch');
  assert.equal(cat('Bash', 'agy -p "translate"'), 'dispatch');
  assert.equal(cat('exec_command', 'claude -p "review"'), 'dispatch');
  assert.equal(cat('Bash', 'gemini -p "summarize"'), 'dispatch');
});

test('own launcher scripts need a config; examples/my-rules.json shows how', () => {
  const launch = 'pwsh -File C:\\Users\\u\\.claude\\skills\\d\\scripts\\run-worker.ps1 -Task t';
  assert.equal(cat('PowerShell', launch), 'orchestration', 'by default only the skills path is seen');
  const r = loadRules(path.join(EX, 'my-rules.json'));
  assert.equal(classifyCall(r, call('PowerShell', launch), turn()), 'dispatch');
  assert.equal(markerFor(r, call('PowerShell', launch), turn()), 'my-worker');
  assert.equal(r.sessionRules.length, 1);
  assert.equal(r.markers.length, R.markers.length + 1);
});

test('everything else is work', () => {
  assert.equal(cat('Bash', 'npm test'), 'work');
  assert.equal(cat('Read', '/home/u/app/src/main.ts'), 'work');
  assert.equal(cat('Bash', 'magy -p x'), 'work', 'agy only as a whole command word');
  assert.equal(cat('Edit', '/home/u/proj/docs/claude-notes.md'), 'work');
  assert.equal(cat('WebFetch', 'https://example.com/skills/x'), 'work');
});

test('markers name the launcher', () => {
  const m = (name, text) => markerFor(R, call(name, text), turn());
  assert.equal(m('Agent', 'x'), 'claude-subagent');
  assert.equal(m('Bash', 'codex exec "x"'), 'codex-exec');
  assert.equal(m('Bash', 'cd /w && agy -p x'), 'agy');
  assert.equal(m('PowerShell', 'claude -p "check the diff"'), 'claude-print');
  assert.equal(m('Bash', 'ls'), null);
});

test('a turn takes its most specific category; turns without tools inherit', () => {
  const list = [
    turn({ ts: at(0), tools: [call('Read', '/n/a.md'), call('Edit', '/u/.claude/skills/s/SKILL.md'), call('Agent', 'x')] }),
    turn({ ts: at(1) }),
    turn({ ts: at(2), tools: [call('Bash', 'npm test')] }),
    turn({ ts: at(3) }),
    turn({ ts: at(4), tools: [call('Agent', 'x'), call('Read', '/n/b.md')] }),
  ];
  classifyAll(R, groupSessions(list));
  assert.deepEqual(list.map((t) => t.category), ['orchestration', 'orchestration', 'work', 'work', 'dispatch']);
  assert.deepEqual(list.map((t) => t.categoryReason), ['tool', 'sticky', 'tool', 'sticky', 'tool']);
});

test('sticky can be turned off', () => {
  const dir = tmpDir();
  const r = loadRules(writeJson(path.join(dir, 'r.json'), { sticky: false }));
  const list = [turn({ ts: at(0), tools: [call('Agent', 'x')] }), turn({ ts: at(1) })];
  classifyAll(r, groupSessions(list));
  assert.deepEqual(list.map((t) => t.category), ['dispatch', 'work']);
});

test('session rules put whole sessions in a category by working directory', () => {
  const dir = tmpDir();
  const r = loadRules(writeJson(path.join(dir, 'r.json'), { sessionRules: [{ cwd: 'Desktop/agent-setup$', category: 'orchestration' }] }));
  const a = [turn({ sessionId: 'A', cwd: 'C:\\Users\\u\\Desktop\\agent-setup', ts: at(0), tools: [call('Bash', 'npm test')] }), turn({ sessionId: 'A', cwd: 'C:\\Users\\u\\Desktop\\agent-setup', ts: at(1) })];
  const b = [turn({ sessionId: 'B', cwd: '/home/u/app', ts: at(0), tools: [call('Bash', 'npm test')] })];
  classifyAll(r, groupSessions([...a, ...b]));
  assert.deepEqual(a.map((t) => [t.category, t.categoryReason]), [['orchestration', 'session'], ['orchestration', 'session']]);
  assert.equal(b[0].category, 'work');
});

test('a config replaces top-level keys; prepend/append/extraMarkers extend the defaults', () => {
  const dir = tmpDir();
  const r = loadRules(writeJson(path.join(dir, 'r.json'), {
    prependRules: [{ category: 'orchestration', tool: '^bash$', match: 'my-router\\.sh' }],
    appendRules: [{ category: 'dispatch', match: 'handoff/' }],
    extraMarkers: [{ label: 'my-router', tool: '^bash$', match: 'my-router\\.sh' }],
  }));
  assert.equal(r.rules.length, R.rules.length + 2);
  assert.equal(classifyCall(r, call('Bash', './my-router.sh codex exec x'), turn()), 'orchestration');
  assert.equal(classifyCall(r, call('Read', '/w/handoff/a.md'), turn()), 'dispatch');
  assert.equal(markerFor(r, call('Bash', './my-router.sh'), turn()), 'my-router');
});

test('rules may be limited to one log source', () => {
  const dir = tmpDir();
  const r = loadRules(writeJson(path.join(dir, 'r.json'), { prependRules: [{ category: 'orchestration', source: 'codex', match: 'special' }] }));
  assert.equal(classifyCall(r, call('Bash', 'special'), turn({ source: 'codex' })), 'orchestration');
  assert.equal(classifyCall(r, call('Bash', 'special'), turn({ source: 'claude' })), 'work');
});

test('a rule with an unknown category is rejected', () => {
  const dir = tmpDir();
  assert.throws(() => loadRules(writeJson(path.join(dir, 'r.json'), { appendRules: [{ category: 'misc', match: 'x' }] })), /not listed in "categories"/);
});
