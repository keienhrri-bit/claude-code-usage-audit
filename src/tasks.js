// Per-task attribution: how much did the main agent spend on each hand-off?
//
// 1. Every tool call in a main session that matches a marker (Agent/Task, `codex exec`, `agy`,
//    `claude -p`, your own launcher scripts via extraMarkers, ...) starts a task. Its "keys" are the paths and --name/--out style
//    values that appear in the call.
// 2. Optional ledger: a JSONL file of finished jobs with a time window. An entry is paired with
//    the task whose launch falls inside its window and whose call mentions the entry's name or
//    directory; the entry's name and dir are added to the task's keys.
// 3. Main-agent turns are attributed to a task when they are the launch turn, or when their tool
//    input mentions one of the task's keys: before the launch (within `lookbackMinutes`) that is
//    writing the brief, after it that is reading the report / verifying / redoing. A turn with no
//    tool calls inherits the attribution of the turn before it, unless more than the lookback
//    window has passed since that turn. A turn that mentions several tasks
//    is split evenly between them.
// 4. A later task in the same session that shares a key with an earlier one is counted as a retry.

import { markerFor } from './rules.js';
import { parseTime } from './time.js';
import { normalizeText } from './readers/fsutil.js';
import fs from 'node:fs';

export const DEFAULT_TASK_OPTS = { lookbackMinutes: 30, maxKeyShare: 3, ledgerSlackSeconds: 120 };

const PATH_RE = /[^\s"'`<>|;,(){}[\]=]*\/[^\s"'`<>|;,(){}[\]=]+/g;
const ARG_RE = /(?:^|\s)--?(?:name|job|jobname|task|out|outdir|output|dir|workdir|brief|file|taskfile|promptfile|prompt-file)[=\s]+["']?([^\s"']+)/gi;

const LAUNCHER_RE = /\.(ps1|mjs|cjs|js|py|sh|exe|cmd|bat)$/;
const TASK_FILE_RE = /(brief|task|prompt|report|result|receipt|handoff)/;
const TOOL_DIR_RE = /^(bin|scripts|skills|programs|tools|node_modules|\.claude|\.codex|scratchpad)$/;

// Candidate keys of one launch: paths and --name/--out style values. Launcher scripts (and the
// directories that hold them), the working directory and its parents are not keys.
export function extractKeys(text, cwd) {
  const keys = new Set();
  const launchers = [];
  const cwdN = cwd ? normalizeText(cwd).replace(/\/+$/, '') : null;
  for (const m of text.matchAll(PATH_RE)) {
    const k = m[0].replace(/[.:,]+$/, '').replace(/^\.\//, '').replace(/\/+$/, '');
    if (/^[a-z]+:\/\//.test(k)) continue;
    const segs = k.split('/').filter(Boolean);
    const last = segs[segs.length - 1] || '';
    if (LAUNCHER_RE.test(k) && !TASK_FILE_RE.test(last)) {
      launchers.push(k);
      continue;
    }
    if (k.length < 8 || segs.length < 2) continue;
    if (cwdN && (cwdN === k || cwdN.startsWith(k + '/'))) continue;
    keys.add(k);
  }
  for (const m of text.matchAll(ARG_RE)) {
    const v = m[1].replace(/[.:,]+$/, '').replace(/\/+$/, '');
    const isLauncher = LAUNCHER_RE.test(v) && !TASK_FILE_RE.test(v.split('/').pop());
    if (v.length >= 6 && /[._/\-0-9]/.test(v) && !isLauncher) keys.add(v);
  }
  const all = [...keys];
  for (const k of all) {
    const last = k.split('/').pop();
    if (
      launchers.some((l) => l.startsWith(k + '/')) || // folder of the launcher script
      TOOL_DIR_RE.test(last) ||
      all.some((o) => o.startsWith(k + '/') && o.slice(k.length + 1).split('/').length >= 2) // two or more levels above another path in the same call
    ) {
      keys.delete(k);
    }
  }
  return keys;
}

const mentions = (turn, key) => turn.tools.some((c) => c.text.includes(key));

export function readLedger(file, zone, fields = {}) {
  const f = { name: 'name', start: 'start', end: 'end', time: 'time', seconds: 'seconds', dir: 'dir', ok: 'ok', timeIs: 'end', ...fields };
  const out = [];
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    let start = o[f.start] != null ? parseTime(zone, o[f.start]) : null;
    let end = o[f.end] != null ? parseTime(zone, o[f.end]) : null;
    if ((start == null || end == null) && o[f.time] != null) {
      const t = parseTime(zone, o[f.time]);
      const dur = (Number(o[f.seconds]) || 0) * 1000;
      if (f.timeIs === 'start') {
        start = start ?? t;
        end = end ?? t + dur;
      } else {
        end = end ?? t;
        start = start ?? t - dur;
      }
    }
    if (start == null || end == null) continue;
    out.push({
      name: o[f.name] != null ? String(o[f.name]) : null,
      dir: o[f.dir] != null ? normalizeText(String(o[f.dir])) : null,
      ok: o[f.ok] == null ? null : Boolean(o[f.ok]),
      start,
      end,
      agent: o.agent || null,
    });
  }
  return out;
}

export function attributeTasks(sessions, rules, opts = {}) {
  const { lookbackMinutes, maxKeyShare, ledgerSlackSeconds, ledger } = { ...DEFAULT_TASK_OPTS, ...opts };
  const tasks = [];
  const bySession = new Map();
  const subByToolUse = new Map();

  for (const list of sessions.values()) {
    for (const t of list) {
      if (t.kind === 'subagent' && t.parentToolUseId) {
        if (!subByToolUse.has(t.parentToolUseId)) subByToolUse.set(t.parentToolUseId, []);
        subByToolUse.get(t.parentToolUseId).push(t);
      }
    }
  }

  for (const [sid, list] of sessions) {
    if (!list.length || list[0].kind !== 'main') continue;
    for (const t of list) {
      for (const call of t.tools) {
        const label = markerFor(rules, call, t);
        if (!label) continue;
        const task = {
          id: `T${tasks.length + 1}`,
          label,
          sessionId: sid,
          source: t.source,
          ts: t.ts,
          launchTurn: t,
          callId: call.id,
          text: call.text,
          keys: extractKeys(call.text, t.cwd),
          ledger: null,
          turns: [],
          workerTurns: subByToolUse.get(call.id) || [],
          retryOf: null,
        };
        tasks.push(task);
        if (!bySession.has(sid)) bySession.set(sid, []);
        bySession.get(sid).push(task);
      }
    }
  }

  // Pair ledger entries with tasks.
  let ledgerMatched = 0;
  if (ledger && ledger.length) {
    const slack = ledgerSlackSeconds * 1000;
    const taken = new Set();
    for (const e of ledger) {
      let best = null;
      for (const task of tasks) {
        if (taken.has(task)) continue;
        if (task.ts < e.start - slack || task.ts > e.end) continue;
        const nameHit = e.name && e.name.length >= 3 && task.text.includes(e.name.toLowerCase());
        const dirHit = e.dir && task.text.includes(e.dir);
        if (!nameHit && !dirHit) continue;
        if (!best || Math.abs(task.ts - e.start) < Math.abs(best.ts - e.start)) best = task;
      }
      if (best) {
        taken.add(best);
        best.ledger = e;
        if (e.dir) best.keys.add(e.dir);
        if (e.name && e.name.length >= 4) best.keys.add(e.name.toLowerCase());
        ledgerMatched++;
      }
    }
  }

  // Keep only keys that are specific to a task. In session order: a key already owned by an
  // earlier task marks a retry of that task; otherwise the key is dropped if the session mentioned
  // it before the lookback window (an ambient path such as the session scratch dir), or if more
  // than `maxKeyShare` tasks across all sessions name it (a generic file name).
  const lookback = lookbackMinutes * 60000;
  const keyCount = new Map();
  for (const task of tasks) for (const k of task.keys) keyCount.set(k, (keyCount.get(k) || 0) + 1);
  for (const [sid, sessTasks] of bySession) {
    const list = sessions.get(sid);
    const owner = new Map();
    for (const task of sessTasks) {
      for (const k of [...task.keys]) {
        if (owner.has(k)) {
          task.retryOf = task.retryOf || owner.get(k).retryOf || owner.get(k).id;
          continue;
        }
        const early = list.some((t) => t.ts < task.ts - lookback && t !== task.launchTurn && mentions(t, k));
        if (early || keyCount.get(k) > maxKeyShare) {
          task.keys.delete(k);
          continue;
        }
        owner.set(k, task);
      }
    }
  }

  // Attribute main turns: per key, the latest task launched at or before the turn (review),
  // else the next task within the lookback window (brief).
  for (const [sid, sessTasks] of bySession) {
    const list = sessions.get(sid);
    let prevLinks = [];
    let prevTs = null;
    for (const t of list) {
      const linked = new Map();
      for (const task of sessTasks) if (task.launchTurn === t) linked.set(task, 'launch');
      if (t.tools.length) {
        const keysHere = new Set();
        for (const task of sessTasks) for (const k of task.keys) if (mentions(t, k)) keysHere.add(k);
        for (const k of keysHere) {
          let pick = null;
          for (const task of sessTasks) {
            if (!task.keys.has(k)) continue;
            if (task.ts <= t.ts) pick = task;
            else if (!pick && task.ts - lookback <= t.ts) {
              pick = task;
              break;
            }
          }
          if (pick && !linked.has(pick)) linked.set(pick, pick.ts > t.ts ? 'brief' : 'review');
        }
      }
      let final = [...linked].map(([task, phase]) => ({ task, phase }));
      if (!final.length && !t.tools.length && prevTs != null && t.ts - prevTs <= lookback) {
        final = prevLinks.map((l) => ({ task: l.task, phase: l.phase === 'brief' ? 'brief' : 'review' }));
      }
      t.taskLinks = final;
      for (const l of final) l.task.turns.push({ turn: t, phase: l.phase, share: 1 / final.length });
      prevLinks = final;
      prevTs = t.ts;
    }
  }

  if (rules.attributionAsDispatch) {
    for (const list of sessions.values()) {
      for (const t of list) {
        if (t.taskLinks && t.taskLinks.length && t.category === rules.defaultCategory) {
          t.category = 'dispatch';
          t.categoryReason = 'attributed';
        }
      }
    }
  }

  return { tasks, ledgerMatched, ledgerEntries: ledger ? ledger.length : 0 };
}
