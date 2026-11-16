// Claude Code session logs: <projects>/<project>/<session>.jsonl, and subagent transcripts in
// <projects>/<project>/<session>/subagents/agent-*.jsonl (+ agent-*.meta.json).
//
// One API response is written as several JSONL lines (one per content block) that share
// message.id and repeat the same usage. Resumed or forked sessions copy earlier messages into a
// new file. So we dedupe by message.id: within a file always, across files by default.

import path from 'node:path';
import { walk, eachLine, mtimeMs, readJsonMaybe, toolText, normalizeText } from './fsutil.js';

export async function readClaude(root, opts = {}) {
  const { sinceMs = null, dedupe = 'global' } = opts;
  const files = walk(root, (name) => name.endsWith('.jsonl'));
  const stats = { files: 0, skippedOld: 0, assistantLines: 0, perFileUnique: 0, crossFileDuplicates: 0 };
  const byId = new Map();
  const turns = [];

  for (const file of files) {
    if (sinceMs != null && mtimeMs(file) < sinceMs) {
      stats.skippedOld++;
      continue;
    }
    stats.files++;
    const parts = file.split(/[\\/]/);
    const subIdx = parts.lastIndexOf('subagents');
    const isSubFile = subIdx > 0;
    let meta = null;
    if (isSubFile) meta = readJsonMaybe(file.replace(/\.jsonl$/, '.meta.json'));
    const fileTurns = new Map();
    let compactPending = false;
    let sessionId = isSubFile ? parts[subIdx - 1] : path.basename(file, '.jsonl');

    await eachLine(file, (line) => {
      const isAssistant = line.includes('"type":"assistant"');
      const isCompact = !isAssistant && line.includes('"compact_boundary"');
      if (!isAssistant && !isCompact) return;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        return;
      }
      if (o.type === 'system' && o.subtype === 'compact_boundary') {
        compactPending = true;
        return;
      }
      if (o.type !== 'assistant') return;
      const m = o.message || {};
      const u = m.usage;
      if (!u || m.model === '<synthetic>') return;
      stats.assistantLines++;
      const id = m.id || o.uuid;
      if (!id) return;
      let t = fileTurns.get(id);
      if (!t) {
        const ts = Date.parse(o.timestamp);
        if (Number.isNaN(ts)) return;
        if (!isSubFile && o.sessionId) sessionId = o.sessionId;
        const sidechain = !isSubFile && o.isSidechain === true;
        t = {
          source: 'claude',
          id,
          file,
          sessionId: isSubFile ? `${sessionId}/${o.agentId || path.basename(file, '.jsonl')}` : sessionId,
          parentSessionId: isSubFile ? sessionId : null,
          kind: isSubFile || sidechain ? 'subagent' : 'main',
          agentType: isSubFile ? meta?.agentType || 'subagent' : sidechain ? 'sidechain' : null,
          parentToolUseId: isSubFile ? meta?.toolUseId || null : null,
          ts,
          model: m.model || 'unknown',
          cwd: o.cwd || null,
          compactBefore: compactPending,
          tools: [],
          _toolIds: new Set(),
        };
        compactPending = false;
        fileTurns.set(id, t);
      }
      // Later lines of the same response carry the final usage; keep the last one.
      setUsage(t, u);
      for (const c of m.content || []) {
        if (c && c.type === 'tool_use' && !t._toolIds.has(c.id)) {
          t._toolIds.add(c.id);
          const text = toolText(c.input);
          t.tools.push({ name: c.name, id: c.id, text: normalizeText(text) });
        }
      }
    });

    stats.perFileUnique += fileTurns.size;
    for (const t of fileTurns.values()) {
      delete t._toolIds;
      if (dedupe === 'global') {
        const prev = byId.get(t.id);
        if (prev) {
          stats.crossFileDuplicates++;
          if (t.ts < prev.ts) {
            Object.assign(prev, t); // keep the earliest copy
          }
          continue;
        }
        byId.set(t.id, t);
      }
      turns.push(t);
    }
  }
  stats.uniqueTurns = turns.length;
  return { turns, stats };
}

function setUsage(t, u) {
  const cc = u.cache_creation || null;
  let w5 = cc ? cc.ephemeral_5m_input_tokens : undefined;
  let w1 = cc ? cc.ephemeral_1h_input_tokens : undefined;
  if (w5 == null && w1 == null) {
    w5 = u.cache_creation_input_tokens || 0;
    w1 = 0;
  }
  t.input = u.input_tokens || 0;
  t.output = u.output_tokens || 0;
  t.cacheRead = u.cache_read_input_tokens || 0;
  t.cacheWrite5m = w5 || 0;
  t.cacheWrite1h = w1 || 0;
}
