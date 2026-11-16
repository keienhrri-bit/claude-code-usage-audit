import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

// Recursively list files under dir whose name passes `accept`. Missing dir -> [].
export function walk(dir, accept) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, accept));
    else if (e.isFile() && accept(e.name, p)) out.push(p);
  }
  return out.sort();
}

export function mtimeMs(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

// Stream a file line by line; `onLine` returns nothing. Lines that fail to parse are the
// caller's problem — we only hand out raw strings.
export async function eachLine(file, onLine) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (line) onLine(line);
  }
}

export function readJsonMaybe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

export function toolText(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (typeof input === 'object' && !Array.isArray(input)) {
    return Object.values(input)
      .map((v) => (typeof v === 'string' ? v : safeJson(v)))
      .join(' ');
  }
  return safeJson(input);
}

function safeJson(v) {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return String(v);
  }
}

// Lower-case, forward slashes. Rules and keys are matched against this form.
export function normalizeText(s) {
  return String(s || '').toLowerCase().replace(/\\\\/g, '/').replace(/\\/g, '/');
}
