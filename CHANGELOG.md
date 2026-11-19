# Changelog

## 0.1.3 - 2026-11-19

- Task keys preserve quoted path arguments and pick up relative paths inside shell commands. Retry detection distinguishes sibling job directories and accepts changed external output files for repeat launches.
- Reports include tasks with linked worker usage inside the window and compute median task costs before rounding. The comparison table labels its count of launches.
- Claude Code deduplication preserves worker links from matching records, combines usage and tools into one billable response, and keeps copied history for category and cache analysis.
- Date-only boundaries handle skipped midnights and year rollovers. Explicit-offset times validate extended years and accept ISO end-of-day `24:00`.
- Clarified which log formats contribute to source totals and corrected the 0.1.1 regression coverage statement.

## 0.1.2 - 2026-11-17

Two follow-ups to 0.1.1, with regression tests in `test/review-fixes.test.js`.

- `tasks`: 0.1.1 took any quoted string with spaces that started with a path as one path, so a quoted command or prompt such as `bash -c "/w/tools/run.sh /w/jobs/j1"` became a single key and the job directory was lost. A quoted string now counts as one path only when no second path or flag follows a space, the file name has no space, and a `/`-rooted string has no space in its first folder.
- Claude Code reader: a resumed session copies the whole history and starts at the same moment as the original, so 0.1.1's "file that started earliest" rule fell back to path order. When the starts tie, the copy from the file that ended first (the original) is kept; path order decides only when both tie.

## 0.1.1 - 2026-11-17

Behavior fixes have regression tests in `test/review-fixes.test.js`.

- `--redact` now also hides the path of a `--prices` file (it was printed in `options.prices`).
- `--cwd-rule` no longer writes a temporary rules file; the rules are merged in memory.
- `tasks`: with `--since` / `--until`, a task's cost counts only its turns inside the window, so the share of main-agent cost can no longer exceed 100%. Tasks launched before the window are listed when one of their turns falls inside it.
- `tasks`: relaunching the same job more than three times keeps the retries. A key is dropped as generic only when it appears next to more than three different sets of other keys.
- `tasks`: a quoted path with spaces (`"C:\Shared Work\jobs\a"`) is one key, not two fragments that make unrelated jobs look like retries.
- `tasks`: a `--cwd-rule` / `sessionRules` category is no longer changed to `dispatch` by task attribution.
- Claude Code reader: subagent turns written into the main log (`isSidechain: true`) form their own session linked to the parent, so they no longer start tasks or count as the main agent's previous turn in cache and category detection.
- Claude Code reader: copies of a message in several files share a timestamp; the copy from the file that started earliest is kept (it was path order), and tool calls from all copies are merged.
- Claude Code reader: assistant lines with whitespace after the colons (`"type": "assistant"`) are read.
- `compare`: a `session:<id>@A..B` arm counts that session's subagents even when the main agent has no turn in the window.
- `--until <date>` ends at the next local midnight, which is 23 or 25 hours away on a daylight-saving change.
- Impossible dates and times (`2026-02-30`, `25:00`) are rejected instead of rolling over.
- The median cost per task is the mean of the two middle values for an even number of tasks.
Documentation updates:

- Clarified that Claude Code subagents are the supported workers for task cost links.
- Added a Related section linking agent-cite-check and claude-subagent-cost.

## 0.1.0 - 2026-11-16

First release.

- `report`: main agent and subagents side by side (subagents are never added to the main agent), usage by model, the main agent's usage split into `orchestration` (setup), `dispatch` and `work`, and a per-day table.
- `tasks`: what each hand-off cost the main agent, in three phases (brief, launch, review), with retries detected from shared paths and names. Worker cost is linked for Claude Code subagents. An optional JSONL job ledger (`--ledger`) is paired with launches by time window and name or directory.
- `cache`: prompt-cache rewrites with an inferred cause (`compaction`, `model-switch`, `waiting-on-subagent`, `idle-5m`, `idle-1h`, `unexplained`; `subagent:` prefix inside subagent transcripts). Cold starts are counted apart. Excess cost is the cache-write cost minus the cost of reading the same tokens from cache.
- `compare`: two or more arms, each a time window or a session id prefix.
- `rules`: prints the default rules. A `--config` file replaces keys or adds rules (`prependRules`, `appendRules`, `extraMarkers`, `sessionRules`); `--cwd-rule` sets a category for whole sessions by working directory. `examples/my-rules.json` shows how to register your own launcher script.
- Claude Code reader: responses counted once per `message.id` across all files (resumed and forked sessions copy messages); subagent transcripts read from `<session>/subagents/`. `--dedupe file` counts copies in different files separately.
- Codex reader: per-turn usage from the growth of `total_token_usage` between `token_count` events.
- List prices in `data/prices.json`; `--prices` adds or overrides models. Models without a price are reported in raw tokens and left out of dollar totals.
- `--since`, `--until`, `--tz`, `--json`, `--top`, `--no-days`, `--redact`.
- Synthetic example logs generated by `scripts/make-example-logs.mjs`; `npm run demo`.
- Tests with `node --test`; CI on Windows and Linux with Node 20, 22 and 24.
