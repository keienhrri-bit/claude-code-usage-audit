import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const BUILTIN = new URL('../data/prices.json', import.meta.url);

export function loadPrices(extraFile) {
  const base = JSON.parse(fs.readFileSync(fileURLToPath(BUILTIN), 'utf8'));
  const models = { ...base.models };
  const baseSource = base._source;
  let source = baseSource;
  if (extraFile) {
    const extra = JSON.parse(fs.readFileSync(extraFile, 'utf8').replace(/^﻿/, ''));
    Object.assign(models, extra.models || extra);
    source += ` + overrides from ${extraFile}`;
  }
  return { models, source, baseSource, overridesFile: extraFile || null, lookup: makeLookup(models) };
}

// Exact id, then id without a trailing date (-20260101), then longest known prefix.
function makeLookup(models) {
  const keys = Object.keys(models).sort((a, b) => b.length - a.length);
  const cache = new Map();
  return (model) => {
    if (cache.has(model)) return cache.get(model);
    let hit = models[model] || null;
    if (!hit) {
      const bare = String(model).replace(/-\d{8}$/, '').replace(/\[.*\]$/, '');
      hit = models[bare] || null;
      if (!hit) {
        const k = keys.find((key) => bare.startsWith(key));
        hit = k ? models[k] : null;
      }
    }
    cache.set(model, hit);
    return hit;
  };
}

// API-equivalent USD for one turn, or null if the model has no price.
export function turnCost(t, price) {
  if (!price) return null;
  return (
    (t.input * price.input +
      t.output * price.output +
      t.cacheWrite5m * (price.cacheWrite5m ?? price.input * 1.25) +
      t.cacheWrite1h * (price.cacheWrite1h ?? price.input * 2) +
      t.cacheRead * (price.cacheRead ?? price.input * 0.1)) /
    1e6
  );
}

// Input-price-equivalent ("weighted") tokens: cost expressed in units of that model's input token.
export function turnWeighted(t, price) {
  if (!price || !price.input) return null;
  return (turnCost(t, price) * 1e6) / price.input;
}

export function rawTotal(t) {
  return t.input + t.output + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead;
}
