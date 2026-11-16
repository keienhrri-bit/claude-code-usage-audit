// Writes the synthetic example logs in examples/logs. Everything here is made up: paths live
// under /home/demo, ids are fake, token numbers are chosen so tests can check them by hand.
// Run: node scripts/make-example-logs.mjs [out-dir]   (default: examples/)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples');
const proj = path.join(root, 'logs', 'claude', 'projects', '-home-demo-webapp');
const SID_A = 'aaaa1111-0000-4000-8000-000000000001';
const SID_B = 'bbbb2222-0000-4000-8000-000000000002';
const CWD = '/home/demo/webapp';
let seq = 0;
const nextId = () => String(++seq).padStart(4, '0');

function usage(input, output, { w5 = 0, w1 = 0, cr = 0 } = {}) {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: w5 + w1,
    cache_read_input_tokens: cr,
    cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 },
  };
}

function assistant({ sid, id, ts, model = 'claude-opus-5-5', u, content, extra = {} }) {
  return JSON.stringify({
    type: 'assistant',
    sessionId: sid,
    cwd: CWD,
    timestamp: ts,
    uuid: `${id}-${nextId()}`,
    ...extra,
    message: { id, model, role: 'assistant', content, usage: u },
  });
}
const user = (sid, ts, text) => JSON.stringify({ type: 'user', sessionId: sid, cwd: CWD, timestamp: ts, message: { role: 'user', content: text } });
const text = (s) => [{ type: 'text', text: s }];
const tool = (name, input, id) => [{ type: 'tool_use', id: id || `toolu_${name}_${nextId()}`, name, input }];

const A = [];
A.push(user(SID_A, '2026-01-05T08:59:50Z', 'Plan the signup form changes.'));
// T1: one response written as three lines with the same message.id (thinking, text, text)
const u1 = usage(10, 100, { w1: 30000 });
A.push(assistant({ sid: SID_A, id: 'msg_a1', ts: '2026-01-05T09:00:00Z', u: u1, content: [{ type: 'thinking', thinking: '' }] }));
A.push(assistant({ sid: SID_A, id: 'msg_a1', ts: '2026-01-05T09:00:00Z', u: u1, content: text('Here is a plan.') }));
A.push(assistant({ sid: SID_A, id: 'msg_a1', ts: '2026-01-05T09:00:00Z', u: u1, content: text('Step two.') }));
// T2: edit a skill -> orchestration
A.push(assistant({ sid: SID_A, id: 'msg_a2', ts: '2026-01-05T09:02:00Z', u: usage(5, 200, { w1: 1000, cr: 30000 }), content: tool('Edit', { file_path: '/home/demo/.claude/skills/router/SKILL.md', old_string: 'a', new_string: 'b' }) }));
// T3: no tool -> inherits orchestration
A.push(assistant({ sid: SID_A, id: 'msg_a3', ts: '2026-01-05T09:03:00Z', u: usage(5, 50, { w1: 500, cr: 31000 }), content: text('Skill updated.') }));
// T4: write the brief -> attributed to task 1 as "brief"
A.push(assistant({ sid: SID_A, id: 'msg_a4', ts: '2026-01-05T09:10:00Z', u: usage(5, 400, { w1: 600, cr: 31500 }), content: tool('Write', { file_path: '/home/demo/webapp/jobs/j1/brief.md', content: 'Add input validation to the signup form.' }) }));
// T5: hand off to codex -> launch of task 1
A.push(assistant({ sid: SID_A, id: 'msg_a5', ts: '2026-01-05T09:12:00Z', u: usage(5, 80, { w1: 700, cr: 32100 }), content: tool('Bash', { command: 'codex exec -C /home/demo/webapp/jobs/j1 "do the task in /home/demo/webapp/jobs/j1/brief.md and write report.md"' }) }));
// T6: read the report -> review
A.push(assistant({ sid: SID_A, id: 'msg_a6', ts: '2026-01-05T09:20:00Z', u: usage(5, 300, { w1: 2000, cr: 32800 }), content: tool('Read', { file_path: '/home/demo/webapp/jobs/j1/report.md' }) }));
// T7: no tool -> inherits the review
A.push(assistant({ sid: SID_A, id: 'msg_a7', ts: '2026-01-05T09:21:00Z', u: usage(5, 150, { w1: 300, cr: 34800 }), content: text('Two checks are missing.') }));
// T8: Claude Code subagent -> task 2, linked to the subagent transcript by tool_use id
A.push(assistant({ sid: SID_A, id: 'msg_a8', ts: '2026-01-05T09:25:00Z', u: usage(5, 120, { w1: 400, cr: 35100 }), content: tool('Agent', { description: 'summarize module', subagent_type: 'general-purpose', prompt: 'Summarize /home/demo/webapp/src/auth.ts into /home/demo/webapp/jobs/sub1/summary.md' }, 'toolu_sub1') }));
// T9: 75 minutes later, the cache has expired while the subagent ran -> waiting-on-subagent
A.push(assistant({ sid: SID_A, id: 'msg_a9', ts: '2026-01-05T10:40:00Z', u: usage(5, 250, { w1: 33000, cr: 3000 }), content: tool('Read', { file_path: '/home/demo/webapp/jobs/sub1/summary.md' }) }));
// T10: 80 minutes idle -> idle-1h
A.push(assistant({ sid: SID_A, id: 'msg_a10', ts: '2026-01-05T12:00:00Z', u: usage(5, 90, { w1: 34000, cr: 3000 }), content: text('Back. Continuing.') }));
A.push(JSON.stringify({ type: 'system', subtype: 'compact_boundary', sessionId: SID_A, timestamp: '2026-01-05T12:05:00Z', content: 'Conversation compacted' }));
// T11: after compaction; re-dispatch the same job dir -> task 3, retry of task 1
A.push(assistant({ sid: SID_A, id: 'msg_a11', ts: '2026-01-05T12:06:00Z', u: usage(5, 70, { w1: 22000, cr: 3000 }), content: tool('Bash', { command: 'codex exec -C /home/demo/webapp/jobs/j1 "fix the issues listed in /home/demo/webapp/jobs/j1/review.md"' }) }));
// T12: switch model -> model-switch rewrite; plain work
A.push(assistant({ sid: SID_A, id: 'msg_a12', model: 'claude-sonnet-5-5', ts: '2026-01-05T12:30:00Z', u: usage(5, 600, { w1: 25000 }), content: tool('Bash', { command: 'python /home/demo/webapp/tools/coverage.py --module auth' }) }));

const S = [];
S.push(JSON.stringify({ type: 'user', isSidechain: true, agentId: 's1', sessionId: SID_A, cwd: CWD, timestamp: '2026-01-05T09:25:30Z', message: { role: 'user', content: 'Summarize...' } }));
S.push(assistant({ sid: SID_A, id: 'msg_s1', model: 'claude-haiku-5-5', ts: '2026-01-05T09:26:00Z', u: usage(3, 500, { w5: 21000 }), content: tool('Read', { file_path: '/home/demo/webapp/src/auth.ts' }), extra: { isSidechain: true, agentId: 's1' } }));
S.push(assistant({ sid: SID_A, id: 'msg_s2', model: 'claude-haiku-5-5', ts: '2026-01-05T09:29:00Z', u: usage(3, 900, { w5: 1500, cr: 21000 }), content: tool('Write', { file_path: '/home/demo/webapp/jobs/sub1/summary.md', content: '...' }), extra: { isSidechain: true, agentId: 's1' } }));

const B = [];
// B starts by repeating msg_a1 (a resumed session copies history) -> dropped as a cross-file copy
B.push(assistant({ sid: SID_B, id: 'msg_a1', ts: '2026-01-05T09:00:00Z', u: u1, content: text('Here is a plan.') }));
B.push(assistant({ sid: SID_B, id: 'msg_b1', ts: '2026-01-06T08:00:00Z', u: usage(10, 60, { w1: 20500 }), content: text('Good morning.') }));

function write(p, lines) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, lines.join('\n') + '\n');
}
write(path.join(proj, `${SID_A}.jsonl`), A);
write(path.join(proj, `${SID_B}.jsonl`), B);
const subDir = path.join(proj, SID_A, 'subagents');
write(path.join(subDir, 'agent-s1.jsonl'), S);
fs.writeFileSync(path.join(subDir, 'agent-s1.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'summarize module', toolUseId: 'toolu_sub1' }) + '\n');

// Codex: one session that hands work to agy.
const C = [];
const cts = (m) => `2026-01-05T13:${String(m).padStart(2, '0')}:00Z`;
C.push(JSON.stringify({ timestamp: cts(0), type: 'session_meta', payload: { id: 'cccc3333-0000-4000-8000-000000000003', cwd: CWD, originator: 'demo' } }));
C.push(JSON.stringify({ timestamp: cts(0), type: 'turn_context', payload: { model: 'gpt-demo', cwd: CWD } }));
C.push(JSON.stringify({ timestamp: cts(1), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call_1', arguments: JSON.stringify({ cmd: 'agy -p "review /home/demo/webapp/jobs/t1/brief.md" --out /home/demo/webapp/jobs/t1' }) } }));
const tc = (m, tot, last) => JSON.stringify({ timestamp: cts(m), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: tot, last_token_usage: last } } });
const t1 = { input_tokens: 12000, cached_input_tokens: 8000, output_tokens: 300, total_tokens: 12300 };
C.push(tc(2, t1, t1));
C.push(tc(2, t1, t1)); // the same event written twice
C.push(JSON.stringify({ timestamp: cts(9), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call_2', arguments: JSON.stringify({ cmd: 'cat /home/demo/webapp/jobs/t1/out.md' }) } }));
const t2 = { input_tokens: 26000, cached_input_tokens: 20000, output_tokens: 500, total_tokens: 26500 };
C.push(tc(10, t2, { input_tokens: 14000, cached_input_tokens: 12000, output_tokens: 200, total_tokens: 14200 }));
write(path.join(root, 'logs', 'codex', 'sessions', '2026', '01', '05', 'rollout-2026-01-05T13-00-00-cccc3333-0000-4000-8000-000000000003.jsonl'), C);

// Ledger: naive local times (read with --tz UTC in the demo), "time" written when the job ended.
write(path.join(root, 'ledger.jsonl'), [
  JSON.stringify({ time: '2026-01-05T09:20:00', seconds: 480, name: 'j1', agent: 'codex', dir: '/home/demo/webapp/jobs/j1', ok: false }),
  JSON.stringify({ time: '2026-01-05T12:20:00', seconds: 840, name: 'j1-retry', agent: 'codex', dir: '/home/demo/webapp/jobs/j1', ok: true }),
]);
console.log('wrote examples/logs and examples/ledger.jsonl');
