// Claude Code session logs: <projects>/<project>/<session>.jsonl, and subagent transcripts in
// <projects>/<project>/<session>/subagents/agent-*.jsonl (+ agent-*.meta.json).
//
// One API response is written as several JSONL lines (one per content block) that share
// message.id and repeat the same usage. Resumed or forked sessions copy earlier messages into a
// new file. So we dedupe by message.id: within a file always, across files by default. Copies
// usually share the timestamp. The copy in its recorded session's transcript has priority;
// otherwise transcript times and then session IDs decide. We merge usage and tools into one
// billable turn and retain copies from other sessions as context.
//
// Subagent turns can also appear in the main log, marked isSidechain: true. Those
// become a session of their own, `<session>/<agentId or "sidechain">`, linked to the parent.

import path from 'node:path';
import { walk, tryEachLine, mtimeMs, readJsonMaybe, toolText, normalizeText } from './fsutil.js';

// Cheap pre-filter before JSON.parse; allows whitespace around the colon.
const ASSISTANT_RE = /"type"\s*:\s*"assistant"/;

export async function readClaude(root, opts = {}) {
  const { sinceMs = null, dedupe = 'global' } = opts;
  const unreadable = [];
  const onError = (p, err) => unreadable.push({ path: p, code: err?.code || String(err) });
  const files = walk(root, (name) => name.endsWith('.jsonl'), { onError });
  const stats = { files: 0, skippedOld: 0, unreadable: 0, assistantLines: 0, perFileUnique: 0, crossFileDuplicates: 0 };
  const byId = new Map();
  const duplicates = new Map();
  const turns = [];
  const contextTurns = [];

  for (const file of files) {
    if (sinceMs != null && mtimeMs(file) < sinceMs) {
      stats.skippedOld++;
      continue;
    }
    const parts = file.split(/[\\/]/);
    const subIdx = parts.lastIndexOf('subagents');
    const isSubFile = subIdx > 0;
    let meta = null;
    if (isSubFile) meta = readJsonMaybe(file.replace(/\.jsonl$/, '.meta.json'));
    const fileTurns = new Map();
    let compactPending = false;
    const fileSessionId = isSubFile ? parts[subIdx - 1] : path.basename(file, '.jsonl');
    let sessionId = fileSessionId;
    let mainSessionId = fileSessionId;
    const linesBefore = stats.assistantLines;

    const readError = await tryEachLine(file, (line) => {
      const isAssistant = ASSISTANT_RE.test(line);
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
        const sidechain = !isSubFile && o.isSidechain === true;
        if (!isSubFile && o.sessionId) {
          sessionId = o.sessionId;
          if (!sidechain) mainSessionId = o.sessionId;
        }
        const sub = isSubFile ? o.agentId || path.basename(file, '.jsonl') : sidechain ? o.agentId || 'sidechain' : null;
        t = {
          source: 'claude',
          id,
          file,
          sessionId: sub ? `${sessionId}/${sub}` : sessionId,
          parentSessionId: sub ? sessionId : null,
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
    if (readError) {
      // Not readable (permissions, removed meanwhile): leave the whole file out and say so.
      stats.assistantLines = linesBefore;
      unreadable.push({ path: file, code: readError.code || String(readError) });
      continue;
    }
    stats.files++;

    stats.perFileUnique += fileTurns.size;
    let fileStart = Infinity;
    let fileEnd = -Infinity;
    for (const t of fileTurns.values()) {
      fileStart = Math.min(fileStart, t.ts);
      fileEnd = Math.max(fileEnd, t.ts);
    }
    for (const t of fileTurns.values()) {
      delete t._toolIds;
      if (dedupe !== 'global') {
        turns.push(t);
        continue;
      }
      t._fileSpan = [fileStart, fileEnd];
      t._ownTranscript = t.kind === 'main' && t.sessionId === fileSessionId;
      t._contextSessionId = t.kind === 'main' ? mainSessionId : t.sessionId;
      const prev = byId.get(t.id);
      if (!prev) {
        byId.set(t.id, t);
        continue;
      }
      stats.crossFileDuplicates++;
      if (!duplicates.has(t.id)) duplicates.set(t.id, [prev]);
      duplicates.get(t.id).push(t);
      if (preferredCopy(t, prev)) byId.set(t.id, t);
    }
  }
  const workerLinks = new Map(); // fallback session -> Map(worker session -> linked copy)
  for (const [id, turn] of byId) {
    const copies = duplicates.get(id);
    if (copies) mergeCopies(turn, copies, contextTurns, workerLinks);
    turns.push(turn);
  }
  joinFallbackSessions([...turns, ...contextTurns], workerLinks);
  for (const t of [...turns, ...contextTurns]) {
    delete t._fileSpan;
    delete t._ownTranscript;
    delete t._contextSessionId;
    delete t._cacheBreakdown;
  }
  stats.uniqueTurns = turns.length;
  stats.unreadable = unreadable.length;
  return { turns, stats, contextTurns, unreadable };
}

function preferredCopy(a, b) {
  if (a.ts !== b.ts) return a.ts < b.ts;
  // Some forked transcripts retain the source session ID on copied messages.
  if (a._ownTranscript !== b._ownTranscript) return a._ownTranscript;
  const [aStart, aEnd] = a._fileSpan;
  const [bStart, bEnd] = b._fileSpan;
  if (aStart !== bStart) return aStart < bStart;
  if (aEnd !== bEnd) return aEnd < bEnd;
  return a.sessionId < b.sessionId;
}

function mergeCopies(turn, copies, contextTurns, workerLinks) {
  keepWorkerLink(turn, copies, workerLinks);
  const writes = cacheWriteSource(turn, copies);
  for (const copy of copies) {
    if (copy === turn) continue;
    turn.tools = mergeTools(turn.tools, copy.tools);
    mergeUsage(turn, copy);
  }
  turn.cacheWrite5m = writes.cacheWrite5m;
  turn.cacheWrite1h = writes.cacheWrite1h;

  // One history entry per session. The original session's billable turn already supplies its history.
  const seen = new Set([turn.sessionId]);
  const { input, output, cacheRead, cacheWrite5m, cacheWrite1h, tools } = turn;
  for (const copy of copies) {
    const sessionId = copy.kind === 'main' ? copy._contextSessionId : copy.sessionId;
    if (seen.has(sessionId) || sameWorker(turn, copy)) continue;
    seen.add(sessionId);
    contextTurns.push({ ...copy, sessionId, input, output, cacheRead, cacheWrite5m, cacheWrite1h, tools, contextOnly: true });
  }
}

function sameWorker(a, b) {
  if (a.kind !== 'subagent' || b.kind !== 'subagent' || a.parentSessionId !== b.parentSessionId) return false;
  const fallbackId = a.parentSessionId + '/sidechain';
  return a.sessionId === b.sessionId ||
    (a.agentType === 'sidechain' && a.sessionId === fallbackId) ||
    (b.agentType === 'sidechain' && b.sessionId === fallbackId);
}

function keepWorkerLink(turn, copies, workerLinks) {
  if (turn.kind !== 'subagent' || turn.parentToolUseId) return;
  let linked = null;
  for (const copy of copies) {
    if (!copy.parentToolUseId || !sameWorker(turn, copy)) continue;
    if (linked && linked.parentToolUseId !== copy.parentToolUseId) return;
    linked = copy;
  }
  if (!linked) return;
  if (turn.sessionId === turn.parentSessionId + '/sidechain' && turn.sessionId !== linked.sessionId) {
    if (!workerLinks.has(turn.sessionId)) workerLinks.set(turn.sessionId, new Map());
    workerLinks.get(turn.sessionId).set(linked.sessionId, linked);
  }
  turn.parentToolUseId = linked.parentToolUseId;
  turn.agentType = linked.agentType;
  turn.sessionId = linked.sessionId;
}

// Main-log sidechain records without agentId share the fallback session `<session>/sidechain`.
// If its linked turns all point to one subagent transcript, the whole fallback session is that
// worker: its other turns move there too, so the worker's history stays in one session (cache
// continuity) and all of its usage is linked to the launch. Linked to several transcripts, only
// the linked turns move.
function joinFallbackSessions(all, workerLinks) {
  for (const [fallback, targets] of workerLinks) {
    if (targets.size !== 1) continue;
    const [worker] = targets.values();
    for (const t of all) {
      if (t.sessionId !== fallback) continue;
      t.sessionId = worker.sessionId;
      t.parentToolUseId = t.parentToolUseId || worker.parentToolUseId;
      t.agentType = worker.agentType;
    }
  }
}

function mergeUsage(turn, copy) {
  // Copies are snapshots of the same response; cache writes are picked in cacheWriteSource.
  turn.input = Math.max(turn.input, copy.input);
  turn.output = Math.max(turn.output, copy.output);
  turn.cacheRead = Math.max(turn.cacheRead, copy.cacheRead);
}

// The cache TTL split describes one shared total: take the copy with the largest total; among
// those, the billable copy if it has its own split, else the detailed split with the most
// 1-hour writes (the higher cost). The result does not depend on the order files are read.
function cacheWriteSource(turn, copies) {
  const total = (c) => c.cacheWrite5m + c.cacheWrite1h;
  const max = Math.max(...copies.map(total));
  const top = copies.filter((c) => total(c) === max);
  if (top.includes(turn) && turn._cacheBreakdown) return turn;
  const detailed = top.filter((c) => c._cacheBreakdown);
  if (!detailed.length) return top[0];
  return detailed.reduce((best, c) => (c.cacheWrite1h > best.cacheWrite1h ? c : best));
}

function mergeTools(a, b) {
  const ids = new Set(a.map((c) => c.id));
  return [...a, ...b.filter((c) => !ids.has(c.id))];
}

function setUsage(t, u) {
  const cc = u.cache_creation || null;
  let w5 = cc ? cc.ephemeral_5m_input_tokens : undefined;
  let w1 = cc ? cc.ephemeral_1h_input_tokens : undefined;
  t._cacheBreakdown = w5 != null || w1 != null;
  if (!t._cacheBreakdown) {
    w5 = u.cache_creation_input_tokens || 0;
    w1 = 0;
  }
  t.input = u.input_tokens || 0;
  t.output = u.output_tokens || 0;
  t.cacheRead = u.cache_read_input_tokens || 0;
  t.cacheWrite5m = w5 || 0;
  t.cacheWrite1h = w1 || 0;
}
