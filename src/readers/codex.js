// Codex session logs: <codex>/sessions/YYYY/MM/DD/rollout-*.jsonl.
// Usage comes from event_msg/token_count events. The same event can be written twice, so we
// take the increase of info.total_token_usage, not the sum of last_token_usage.
// OpenAI-style input_tokens include cached_input_tokens; we split them apart.
// session_meta carries account identifiers; we never read them into the output.

import path from 'node:path';
import { walk, eachLine, mtimeMs, toolText, normalizeText } from './fsutil.js';

const FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'total_tokens'];

export async function readCodex(root, opts = {}) {
  const { sinceMs = null } = opts;
  const files = walk(root, (name) => /^rollout-.*\.jsonl$/.test(name));
  const stats = { files: 0, skippedOld: 0, tokenEvents: 0, duplicateEvents: 0 };
  const turns = [];

  for (const file of files) {
    if (sinceMs != null && mtimeMs(file) < sinceMs) {
      stats.skippedOld++;
      continue;
    }
    stats.files++;
    let sessionId = path.basename(file, '.jsonl').replace(/^rollout-/, '');
    let parentSessionId = null;
    let kind = 'main';
    let agentType = null;
    let cwd = null;
    let model = 'unknown';
    let prevTotal = null;
    let pendingTools = [];
    let seq = 0;

    await eachLine(file, (line) => {
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        return;
      }
      const p = o.payload || {};
      if (o.type === 'session_meta') {
        if (p.id) sessionId = p.id;
        cwd = p.cwd || cwd;
        const sub = p.source && typeof p.source === 'object' ? p.source.subagent : null;
        if (sub) {
          kind = 'subagent';
          agentType = typeof sub === 'string' ? sub : sub.other || Object.keys(sub)[0] || 'subagent';
          parentSessionId = p.parent_thread_id || null;
        }
        return;
      }
      if (o.type === 'turn_context') {
        if (p.model) model = p.model;
        if (p.cwd) cwd = p.cwd;
        return;
      }
      if (o.type === 'response_item') {
        if (p.type === 'function_call') {
          pendingTools.push({ name: p.name, id: p.call_id || p.id, text: normalizeText(argText(p.arguments)) });
        } else if (p.type === 'custom_tool_call') {
          pendingTools.push({ name: p.name, id: p.call_id || p.id, text: normalizeText(toolText(p.input)) });
        } else if (p.type === 'local_shell_call') {
          const cmd = p.action && p.action.command;
          pendingTools.push({ name: 'local_shell', id: p.call_id || p.id, text: normalizeText(toolText(cmd)) });
        }
        return;
      }
      if (o.type === 'event_msg' && p.type === 'token_count' && p.info) {
        stats.tokenEvents++;
        const total = p.info.total_token_usage;
        const last = p.info.last_token_usage;
        let d;
        if (total && prevTotal) {
          d = diff(total, prevTotal);
          if (d.total_tokens === 0 && d.input_tokens === 0 && d.output_tokens === 0) {
            stats.duplicateEvents++;
            return;
          }
          if (d.input_tokens < 0 || d.output_tokens < 0) d = pick(last || total); // counter reset
        } else {
          d = pick(total || last);
        }
        if (total) prevTotal = total;
        const ts = Date.parse(o.timestamp);
        if (Number.isNaN(ts)) return;
        const cached = d.cached_input_tokens || 0;
        turns.push({
          source: 'codex',
          id: `${sessionId}#${seq++}`,
          file,
          sessionId,
          parentSessionId,
          kind,
          agentType,
          parentToolUseId: null,
          ts,
          model,
          cwd,
          compactBefore: false,
          tools: pendingTools,
          input: Math.max(0, (d.input_tokens || 0) - cached),
          output: d.output_tokens || 0,
          cacheRead: cached,
          cacheWrite5m: d.cache_write_input_tokens || 0,
          cacheWrite1h: 0,
        });
        pendingTools = [];
      }
    });
  }
  stats.uniqueTurns = turns.length;
  return { turns, stats };
}

function argText(a) {
  if (typeof a !== 'string') return toolText(a);
  try {
    return toolText(JSON.parse(a));
  } catch {
    return a;
  }
}

function pick(u) {
  const o = {};
  for (const k of FIELDS) o[k] = (u && u[k]) || 0;
  return o;
}

function diff(a, b) {
  const o = {};
  for (const k of FIELDS) o[k] = ((a && a[k]) || 0) - ((b && b[k]) || 0);
  return o;
}
