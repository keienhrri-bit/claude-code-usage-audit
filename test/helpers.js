// Shared fixtures for the tests. Everything is synthetic and written to a fresh temp dir.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeText } from '../src/readers/fsutil.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BIN = path.join(ROOT, 'bin', 'claude-code-usage-audit.js');
export const EX = path.join(ROOT, 'examples');
export const EX_ARGS = [
  '--claude-dir', path.join(EX, 'logs', 'claude', 'projects'),
  '--codex-dir', path.join(EX, 'logs', 'codex', 'sessions'),
  '--ledger', path.join(EX, 'ledger.jsonl'),
  '--tz', 'UTC',
];

export function tmpDir(prefix = 'ccua-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeLines(file, items) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, items.map((o) => (typeof o === 'string' ? o : JSON.stringify(o))).join('\n') + '\n');
}

export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
}

// Claude Code usage block.
export function usage(input, output, { w5 = 0, w1 = 0, cr = 0, breakdown = true } = {}) {
  const u = { input_tokens: input, output_tokens: output, cache_creation_input_tokens: w5 + w1, cache_read_input_tokens: cr };
  if (breakdown) u.cache_creation = { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 };
  return u;
}

// One Claude Code assistant line.
export function asst({ sid = 'S1', id, ts, model = 'claude-opus-5-5', u, content = [], cwd = '/home/t/proj', extra = {} }) {
  return { type: 'assistant', sessionId: sid, cwd, timestamp: ts, uuid: `u-${id}-${Math.random().toString(36).slice(2, 8)}`, ...extra, message: { id, model, role: 'assistant', content, usage: u } };
}

export const toolUse = (name, input, id = `toolu_${name}_${Math.random().toString(36).slice(2, 8)}`) => ({ type: 'tool_use', id, name, input });

// In-memory turn, the shape the readers produce.
let seq = 0;
export function turn(o = {}) {
  return {
    source: 'claude', id: `t${++seq}`, file: 'x', sessionId: 'S', parentSessionId: null, kind: 'main', agentType: null,
    parentToolUseId: null, ts: 0, model: 'claude-opus-5-5', cwd: '/home/t/proj', compactBefore: false, tools: [],
    input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...o,
  };
}

export const call = (name, text, id = `c${++seq}`) => ({ name, id, text: normalizeText(text) });

export const MIN = 60000;
export const T0 = Date.UTC(2026, 0, 5, 9, 0, 0);
export const at = (minutes) => T0 + minutes * MIN;

export function cli(args, opts = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: ROOT, encoding: 'utf8', ...opts });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

export function cliJson(args) {
  const r = cli([...args, '--json', '-']);
  if (r.code !== 0) throw new Error(`exit ${r.code}: ${r.err}`);
  return JSON.parse(r.out);
}
