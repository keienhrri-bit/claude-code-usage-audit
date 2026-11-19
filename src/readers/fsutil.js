import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

// Recursively list files under dir whose name passes `accept`. A missing dir is empty; a dir
// that exists but cannot be read (not a directory, no permission) throws. A subdirectory that
// cannot be read is passed to `onError(path, error)` and skipped, so the caller can say which
// part of the logs is missing. `readdir` is replaceable for tests.
export function walk(dir, accept, { onError = null, readdir = fs.readdirSync } = {}) {
  let entries;
  try {
    entries = readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw new Error(`Cannot read ${dir}: ${err && err.code ? err.code : err}`);
  }
  return walkEntries(dir, entries, accept, onError, readdir).sort();
}

function walkEntries(dir, entries, accept, onError, readdir) {
  const out = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      let sub;
      try {
        sub = readdir(p, { withFileTypes: true });
      } catch (err) {
        // Removed while we were listing: nothing is missing.
        if (onError && err?.code !== 'ENOENT') onError(p, err);
        continue;
      }
      out.push(...walkEntries(p, sub, accept, onError, readdir));
    } else if (e.isFile() && accept(e.name, p)) out.push(p);
  }
  return out;
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

// eachLine for a file that may not be readable: a file system error (EACCES, ENOENT, EISDIR ...)
// is returned instead of thrown. Errors from `onLine` itself still throw.
export async function tryEachLine(file, onLine) {
  try {
    await eachLine(file, onLine);
    return null;
  } catch (err) {
    if (err && typeof err.code === 'string' && /^E[A-Z]+$/.test(err.code)) return err;
    throw err;
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

// Codex's `-C <dir>` is spelled `--cd <dir>` (its long form) before lower-casing, so that it
// stays apart from `-c key=value` (a config override).
const CODEX_CD_RE = /(\bcodex(?:\.exe)?\s+exec\b[^\n;&|]*?\s)-C(?=[\s=])/g;

// Lower-case, forward slashes. Rules and keys are matched against this form.
export function normalizeText(s) {
  return String(s || '').replace(CODEX_CD_RE, '$1--cd').toLowerCase().replace(/\\\\/g, '/').replace(/\\/g, '/');
}
