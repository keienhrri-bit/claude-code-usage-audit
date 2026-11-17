import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_FILE = fileURLToPath(new URL('../data/default-rules.json', import.meta.url));

export function defaultRulesText() {
  return fs.readFileSync(DEFAULT_FILE, 'utf8');
}

// A user config replaces any top-level key it sets. `prependRules` / `appendRules` /
// `extraMarkers` extend the defaults instead of replacing them. `extraSessionRules` (from
// --cwd-rule) come after the file's sessionRules.
export function loadRules(file, extraSessionRules = []) {
  const base = JSON.parse(defaultRulesText());
  let cfg = base;
  if (file) {
    const user = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    cfg = { ...base, ...user };
    if (user.prependRules) cfg.rules = [...user.prependRules, ...cfg.rules];
    if (user.appendRules) cfg.rules = [...cfg.rules, ...user.appendRules];
    if (user.extraMarkers) cfg.markers = [...cfg.markers, ...user.extraMarkers];
  }
  if (extraSessionRules.length) cfg = { ...cfg, sessionRules: [...(cfg.sessionRules || []), ...extraSessionRules] };
  return compile(cfg);
}

function rx(s) {
  if (s == null) return null;
  return new RegExp(s, 'i');
}

function compileMatcher(r) {
  const tool = rx(r.tool);
  const matches = (Array.isArray(r.match) ? r.match : r.match != null ? [r.match] : []).map(rx);
  const not = r.notMatch != null ? rx(r.notMatch) : null;
  const source = r.source ? new RegExp(`^(${r.source})$`, 'i') : null;
  return (call, turn) => {
    if (source && !source.test(turn.source)) return false;
    if (tool && !tool.test(call.name || '')) return false;
    for (const m of matches) if (!m.test(call.text)) return false;
    if (not && not.test(call.text)) return false;
    return true;
  };
}

function compile(cfg) {
  const categories = cfg.categories || ['orchestration', 'dispatch', 'work'];
  const rank = new Map(categories.map((c, i) => [c, i]));
  const rules = (cfg.rules || []).map((r) => ({ category: r.category, test: compileMatcher(r) }));
  const sessionRules = (cfg.sessionRules || []).map((r) => ({ category: r.category, cwd: rx(r.cwd) }));
  const markers = (cfg.markers || []).map((m) => ({ label: m.label, test: compileMatcher(m) }));
  for (const r of [...rules, ...sessionRules]) {
    if (!rank.has(r.category)) throw new Error(`Rule category "${r.category}" is not listed in "categories"`);
  }
  return {
    raw: cfg,
    categories,
    labels: cfg.labels || {},
    defaultCategory: cfg.default || categories[categories.length - 1],
    sticky: cfg.sticky !== false,
    attributionAsDispatch: cfg.attributionAsDispatch !== false && rank.has('dispatch'),
    rank,
    rules,
    sessionRules,
    markers,
  };
}

export function classifyCall(rules, call, turn) {
  for (const r of rules.rules) if (r.test(call, turn)) return r.category;
  return rules.defaultCategory;
}

export function markerFor(rules, call, turn) {
  for (const m of rules.markers) if (m.test(call, turn)) return m.label;
  return null;
}

// Sets turn.category for every turn. `sessions` is Map<sessionId, turns sorted by ts>.
export function classifyAll(rules, sessions) {
  for (const list of sessions.values()) {
    const cwd = list.find((t) => t.cwd)?.cwd || '';
    const forced = rules.sessionRules.find((r) => r.cwd && r.cwd.test(cwd.replace(/\\/g, '/')));
    let prev = rules.defaultCategory;
    for (const t of list) {
      if (forced) {
        t.category = forced.category;
        t.categoryReason = 'session';
        continue;
      }
      if (t.tools.length) {
        let best = null;
        for (const c of t.tools) {
          const cat = classifyCall(rules, c, t);
          if (best == null || rules.rank.get(cat) < rules.rank.get(best)) best = cat;
        }
        t.category = best;
        t.categoryReason = 'tool';
      } else {
        t.category = rules.sticky ? prev : rules.defaultCategory;
        t.categoryReason = rules.sticky ? 'sticky' : 'default';
      }
      prev = t.category;
    }
  }
}
