# claude-code-usage-audit

Reads the session logs Claude Code and Codex keep on your machine and shows where the main agent's usage went: maintaining your agent setup, handing work to other agents, or the actual work.

```bash
npx github:keienhrri-bit/claude-code-usage-audit --since 2026-01-01
```

English | [简体中文](README.zh-CN.md)

```text
== Where the main agent's usage went ==
category       turns  raw tokens  raw share  API-equiv  share
orchestration      2         63k        14%     $0.029   2.2%
dispatch           9        259k        60%      $0.53    40%
work               4        113k        26%      $0.79    58%

== Cache rewrites ==
4 rewrites, 114k tokens written; $0.79 more than reading them from cache (58% of all API-equiv)
cause                events  tokens  excess
idle-1h                   1     34k   $0.27
waiting-on-subagent       1     33k   $0.26
compaction                1     22k   $0.17
model-switch              1     25k  $0.098

== Hand-offs (tasks) ==
4 tasks; main agent spent $0.53 on them (40% of main), median $0.13 per task
marker           tasks  retries  main API-equiv  worker API-equiv
codex-exec           2        1           $0.25        not linked
claude-subagent      1        0           $0.28            $0.004
agy                  1        0           $0.00        not linked
```

Part of the output for the synthetic logs in `examples/` (full output under [Example](#example)). Subagents, the cost of each hand-off and prompt-cache rewrites are listed separately from the main agent.

Version 0.1.2. Not published on npm. All numbers are token counts from local logs, plus API-equivalent dollar estimates at list prices. They are not your bill and not the percentage `/usage` shows.

## Why

If you build tooling around Claude Code (skills, subagents, hooks, scripts that hand work to other CLIs), part of your usage goes into the tooling and the hand-offs rather than the work. Daily totals don't show that split. This tool answers three questions from the logs:

1. What share of the main agent's usage went to building or maintaining the setup, to dispatching work, and to the work itself?
2. What did each hand-off cost the main agent (writing the brief, launching it, reading and checking the report), and how often was a job redone?
3. When was the prompt cache rewritten, and why: compaction, a model switch, waiting on a subagent, or idling past the cache lifetime?

## Install and run

Needs Node.js 20 or later. No dependencies.

```bash
npx github:keienhrri-bit/claude-code-usage-audit --since 2026-01-01
```

Or clone it:

```bash
git clone https://github.com/keienhrri-bit/claude-code-usage-audit
cd claude-code-usage-audit
node bin/claude-code-usage-audit.js --since 2026-01-01
```

To try it on the synthetic logs bundled in `examples/`:

```bash
npm run demo
```

## What it reads

- **Claude Code**: `~/.claude/projects/**/*.jsonl` (or `$CLAUDE_CONFIG_DIR/projects`), including subagent transcripts in `<session>/subagents/`. Claude Code writes one API response as several lines that repeat the same usage, and resumed or forked sessions copy earlier messages into new files. Responses are therefore counted once per `message.id` across all files. `--dedupe file` counts copies in different files separately, as tools that dedupe per file do.
- **Codex**: `~/.codex/sessions/**/rollout-*.jsonl` (or `$CODEX_HOME/sessions`). Per-turn usage is the growth of `total_token_usage` between `token_count` events.
- Nothing else. The tool makes no network connections. It writes only the `--json` file you ask for.

Claude Code deletes session data older than [`cleanupPeriodDays`](https://code.claude.com/docs/en/claude-directory#cleaned-up-automatically) (30 days by default). To audit a longer period, raise that setting before the logs you want are gone.

## Example

`npm run demo` prints:

```text
claude-code-usage-audit 0.1.2
Local token ledger from session logs. USD is an API-equivalent estimate at list prices, not a subscription bill and not the /usage percentage.
Window: start .. now (UTC)
! No price for model "gpt-demo" (26,500 raw tokens in the window): counted in raw tokens, left out of USD and weighted totals. Add it with --prices.
Claude logs: 3 files, 18 assistant lines -> 15 unique responses (1.2 lines each; 1 copies in other files dropped)
Codex logs: 1 files, 3 token_count events, 1 repeated events dropped -> 2 turns

== Main agent vs subagents (subagents are not added to the main agent) ==
                 turns  input  output  cache write  cache read  raw total  API-equiv
claude main         13     75      2k         170k        236k       409k      $1.35
claude subagent      2      6      1k          23k         21k        45k     $0.004
codex main           2     6k     500            0         20k        27k      $0.00
Subagents by type: claude:general-purpose $0.004

== By model (weighted = input-token equivalents at that model's prices) ==
model                     raw tokens  weighted  API-equiv
claude:claude-opus-5-5          383k      311k      $1.24
claude:claude-haiku-5-5          45k       37k     $0.004
codex:gpt-demo                   27k  no price          -
claude:claude-sonnet-5-5         26k       53k      $0.11

== Where the main agent's usage went ==
category       turns  raw tokens  raw share  API-equiv  share
orchestration      2         63k        14%     $0.029   2.2%
dispatch           9        259k        60%      $0.53    40%
work               4        113k        26%      $0.79    58%
  orchestration: building / maintaining the agent setup (skills, agents, hooks, settings, CLAUDE.md, dispatch scripts, usage tooling)
  dispatch: dispatch operations (launching subagents / other CLIs, writing briefs, reading reports, verifying)
  work: everything else: the actual work

== By day (main agent API-equiv; subagents separate) ==
day          main  orchestration  dispatch   work  orchestration %  subagents
2026-01-05  $1.19         $0.029     $0.53  $0.62             2.5%     $0.004
2026-01-06  $0.17          $0.00     $0.00  $0.17             0.0%      $0.00

== Cache rewrites ==
4 rewrites, 114k tokens written; $0.79 more than reading them from cache (58% of all API-equiv)
cause                events  tokens  excess
idle-1h                   1     34k   $0.27
waiting-on-subagent       1     33k   $0.26
compaction                1     22k   $0.17
model-switch              1     25k  $0.098
Not counted above: 3 cold starts (first turn of a session or subagent), 72k tokens written

== Hand-offs (tasks) ==
4 tasks; main agent spent $0.53 on them (40% of main), median $0.13 per task
Ledger: 2 of 2 entries matched to a launch
marker           tasks  retries  main API-equiv  worker API-equiv
codex-exec           2        1           $0.25        not linked
claude-subagent      1        0           $0.28            $0.004
agy                  1        0           $0.00        not linked
```

The example logs are generated by `scripts/make-example-logs.mjs`, which documents every message. The tests check the numbers above against hand calculations.

## Commands

```text
claude-code-usage-audit [report] [options]   summary (default)
claude-code-usage-audit cache [options]      list cache rewrites
claude-code-usage-audit tasks [options]      per hand-off cost of the main agent
claude-code-usage-audit compare --arm self=A..B --arm delegated=C..D [options]
claude-code-usage-audit rules                print the default rules (start of a config file)
```

Common options: `--since` / `--until` (a bare date means the whole day), `--tz` (`local` by default, or `UTC`, `+05:30`, an IANA name), `--claude-dir`, `--codex-dir`, `--no-claude`, `--no-codex`, `--json <file|->`, `--top <n>`, `--no-days`. Run `--help` for the full list.

### report: main agent, subagents, categories

The main agent is your own conversation. Subagent turns (Claude Code `subagents/` files, Codex sessions started as subagents) are reported next to it and never added to it. `--merge-subagents` folds them into the parent session, for comparison with tools that count them together.

Each main-agent turn gets one category:

| Category | Default rules |
|---|---|
| `orchestration` (setup) | reading or editing `.claude/` or `.codex/` skills, agents, commands, hooks, plugins, settings; `CLAUDE.md`, `AGENTS.md`, `.mcp.json`; running `ccusage`, this tool, `claude mcp/config/plugin`, `codex mcp/config/login` |
| `dispatch` | Agent, Task and SendMessage tool calls; shell commands running `codex exec`, `agy`, `claude -p`, `gemini -p`; turns that write a hand-off's brief or read its report (see `tasks`) |
| `work` | everything else |

Rules are regular expressions over tool names and tool inputs. A turn with several tool calls takes the first category in the order above. A turn without tool calls inherits the previous turn's category in the same session. These are heuristics: check them against a few sessions you remember before trusting the split.

**Register your own launcher.** If you hand work out through your own script, the defaults don't know it. A script under `~/.claude/skills/` then counts as setup work and its hand-offs are not found. Add it in a config file; [`examples/my-rules.json`](examples/my-rules.json) shows the three things you can add:

```json
{
  "prependRules": [
    { "category": "dispatch", "tool": "^(bash|powershell|shell|exec_command|exec|local_shell)$", "match": "run-worker\\.ps1" }
  ],
  "extraMarkers": [
    { "label": "my-worker", "tool": "^(bash|powershell|shell|exec_command|exec|local_shell)$", "match": "run-worker\\.ps1" }
  ],
  "sessionRules": [
    { "cwd": "/my-agent-setup$", "category": "orchestration" }
  ]
}
```

```bash
node bin/claude-code-usage-audit.js --config my-rules.json
```

Keys in a config replace the defaults; `prependRules`, `appendRules` and `extraMarkers` add to them. `--cwd-rule '<regex>=<category>'` puts whole sessions in a category by working directory. `claude-code-usage-audit rules` prints the defaults with comments.

### tasks: what each hand-off cost

A tool call that matches a marker (Agent/Task, `codex exec`, `agy`, `claude -p`, `gemini -p`, or your own `extraMarkers`) starts a task. The paths and `--name` / `--out` style values in that call become the task's keys. Main-agent turns are then attributed to the task in three phases:

- **brief**: turns in the 30 minutes before the launch (`--lookback`) whose tool input mentions a key;
- **launch**: the turn that launches it;
- **review**: later turns whose tool input mentions a key (reading the report, checking, redoing).

A task whose keys match an earlier task is shown as a retry. Worker cost is linked only for Claude Code subagents. Work launched through other CLIs (Codex, agy, ...) shows as "not linked", even when their logs are loaded; their usage still appears in the totals by source.

With `--since` / `--until`, a task's cost counts only its turns inside the window. A task launched before the window shows up when one of its turns falls inside it, for example when its report is read.

**Optional job ledger.** If your launcher writes a line per finished job, pass it with `--ledger`. Each line is JSON with `name` and/or `dir`, and either `start` and `end`, or `time` and `seconds`. `ok: false` marks a failed job. An entry is paired with the launch inside its time window whose call mentions its name or directory:

```json
{"time":"2026-01-05T09:20:00","seconds":480,"name":"j1","dir":"/home/demo/webapp/jobs/j1","ok":false}
```

### cache: rewrites and their causes

A rewrite is a turn that writes at least 20,000 tokens to the prompt cache (`--cache-min`) while reading less than half of the previous turn's cached context (`--cache-read-ratio`). The cause is the first of:

| Cause | Test |
|---|---|
| `compaction` | a compaction record precedes the turn |
| `model-switch` | the model differs from the previous turn (caches are per model) |
| `waiting-on-subagent` | the gap is longer than the cache lifetime and a subagent of this session ran during it |
| `idle-5m`, `idle-1h` | the gap is longer than the lifetime of the previous turn's cache writes |
| `unexplained` | none of the above (tool list or system prompt changed, server-side eviction, ...) |

Rewrites inside a subagent's own transcript get a `subagent:` prefix. The first turn of a session or subagent is a cold start; cold starts are counted apart, not as rewrites. "Excess" is what the written tokens cost at the cache-write price minus what reading them from cache would have cost. These causes are inferred from usage numbers. For the live session, Claude Code's own statusline fields are authoritative (see below).

### compare: two ways of doing similar work

```bash
node bin/claude-code-usage-audit.js compare --arm self=2026-01-05T09:00..2026-01-05T09:30 --arm delegated=2026-01-05T12:00..2026-01-05T13:00
node bin/claude-code-usage-audit.js compare --arm a=session:aaaa1111 --arm b=session:bbbb2222
```

Each arm is a time window or a session id prefix. The table shows main-agent usage, subagents, tasks and cache rewrites per arm. A single pair is an anecdote; repeat each arm on several similar tasks before drawing a conclusion.

### Prices and sharing

- `data/prices.json` holds list prices in USD per million tokens, taken from [Anthropic's pricing page](https://platform.claude.com/docs/en/about-claude/pricing) as of 2026-11-16, with 5-minute and 1-hour cache writes at 1.25× and 2× input. `--prices <file>` adds or overrides models, for example Codex models, which have no price by default and are counted in raw tokens only.
- "Weighted tokens" are input-token equivalents at the model's own prices, so turns on different models can be compared.
- `--redact` replaces working directories with short hashes and hides ledger names and the paths of `--config` and `--prices` files, for output you want to post. Check the result before posting it anyway.

## How it relates to other tools

Use this tool next to the ones below, not instead of them. What each one does is taken from its own documentation; star counts are from the GitHub API on 2026-11-16.

| Tool | What it gives you | Use it when you want |
|---|---|---|
| Claude Code statusline [`prompt_cache`](https://code.claude.com/docs/en/statusline#prompt-cache-fields) (v2.1.251+; `last_miss_cause` and `miss_causes` from v2.1.260) | Live cache state of the current main conversation: warm or cold, TTL and expiry, requests, misses, hit ratio, re-cache tokens, likely miss cause | to watch the cache while you work. It covers the main conversation only, not subagents or past sessions. |
| Claude Code [`/usage`](https://code.claude.com/docs/en/costs) | Plan usage; on subscription plans a breakdown of the last 24 hours or 7 days by skill, subagent, plugin and MCP server, computed from local history; a `Prompt cache (main)` line (v2.1.251+) | your plan percentage and a quick recent breakdown |
| Claude Code [`/insights`](https://code.claude.com/docs/en/costs) | A report on how you work rather than how many tokens you used | patterns in how you work, not token accounting |
| [ccusage](https://github.com/ccusage/ccusage) (19,449★) | Daily, weekly, monthly and per-session token and cost reports for Claude Code and other CLIs, Codex included | totals by day, model or session |
| [Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor) (8,801★) | Real-time terminal monitor with predictions; an optional local store that keeps history past the 30-day cleanup | to watch the current window live |
| [tare](https://github.com/kelviq/tare) (307★) | A Claude Code skill you ask where usage went: attribution, limit diagnosis, background automation, week-over-week comparison, redacted summaries (Claude Code logs, macOS and Linux) | a conversational diagnosis inside Claude Code |
| [tokenjam](https://github.com/Metabuilder-Labs/tokenjam) (125★) | Claude Code and Codex; per-subagent cost inside the parent session, over-powered dispatches, overspend categories, a dashboard | per-subagent cost and a dashboard |
| [CCUsageX](https://github.com/MHJoy99/CCUsageX) (7★) | Per-prompt dashboard including subagents, 5-hour and 7-day limits, its own copy of history | a per-prompt view |

None of the single features here is unique: tokenjam also covers Codex and subagents, and `/usage` and tare also attribute usage. What this tool puts together is a batch ledger over any window still on disk, a setup / dispatch / work split with rules you can edit, the main agent's cost per hand-off, and cache-rewrite causes across past sessions, subagents included. Other local log auditors include [ccaudit](https://github.com/kmcheung12/ccaudit) and [tokenscope](https://github.com/wartzar-bee/tokenscope).

## A case: one user's logs

One user ran the tool over about 11 days of their Claude Code logs. Only ratios are given. Those logs are not in this repository, so this case cannot be reproduced from it; the logs in `examples/` are synthetic.

Before the tool existed, a one-off script with that user's own rules had put the setup share of the main agent's usage at about 24%. The tool's results for the same window (main agent only, API-equivalent at list prices):

| Rules used | Setup | Dispatch | Work |
|---|---|---|---|
| The one-off script's rules, ported to a config | 23.7% | 4.4% | 71.9% |
| Default rules + the user's launcher script registered (one rule, one marker) | 21.7% | 19.2% | 59.1% |
| … + the user's setup folders and scripts | 30.7% | 14.5% | 54.8% |
| Default rules only | 25.7% | 2.1% | 72.2% |

Share of the main agent's usage in sessions started in the folder where the setup was maintained: 34%.

What the differences show:

- **The hand count was reproduced.** With the ported rules the setup share is 23.4–24.0%, depending on whether copies of the same message in resumed sessions are dropped and how subagent files are counted. Counting each file separately inflated the total by about 6% in these logs.
- **Dispatch is bigger than it looks.** The default rules count writing briefs, launching and reading reports as dispatch; the one-off script counted them as work. With the launcher registered, dispatch is about 15 points higher than with the ported rules (work about 13 lower, setup 2 lower).
- **Register your launcher.** With default rules only, launching jobs through a script stored under `~/.claude/skills/` looked like setup work, and its hand-offs were not found: dispatch fell to 2%.
- **By folder is higher.** Sessions in the setup folder also contain ordinary work, and everything in them counts.

## Limits

- Categories, hand-offs and cache causes are heuristics over tool inputs and usage numbers. Spot-check them.
- Dollar figures are API-equivalent at list prices. They are not a bill, and subscription plans are not billed per token. Claude Haiku 5.5 is priced at its rates for prompts up to 100,000 tokens; its higher rates for longer prompts, regional pricing and fast mode are not modelled.
- Codex and other non-Claude models have no price unless you pass `--prices`.
- Hand-offs are linked through paths and names in tool input. A brief that mentions neither is not attributed.
- The log formats are undocumented and can change between versions.
- CI runs the tests on Windows and Linux with Node 20, 22 and 24. Not tested on macOS.

## Related

- [agent-cite-check](https://github.com/keienhrri-bit/agent-cite-check): checks an AI agent's report against your local files without calling a model: quoted lines, declared numbers and changed files.
- [claude-subagent-cost](https://github.com/keienhrri-bit/claude-subagent-cost): a Claude Code mod that shows each subagent's model and tokens under its Agent row, keeps the 5-hour and 7-day quota in view, and asks Claude for a handoff brief before the quota runs out.

## License

MIT
