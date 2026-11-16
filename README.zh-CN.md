# claude-code-usage-audit

读取 Claude Code 和 Codex 留在本机的会话日志，告诉你主代理（main agent）的用量花在了哪里：维护代理配置、把活派给别的代理，还是真正的工作。

```bash
npx github:keienhrri-bit/claude-code-usage-audit --since 2026-01-01
```

[English](README.md) | 简体中文

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
4 tasks; main agent spent $0.53 on them (40% of main), median $0.074 per task
marker           tasks  retries  main API-equiv  worker API-equiv
codex-exec           2        1           $0.25        not linked
claude-subagent      1        0           $0.28            $0.004
agy                  1        0           $0.00        not linked
```

上面是对 `examples/` 里合成日志的部分输出（完整输出见[示例](#示例)）。子代理（subagent）、每次派活的花费和提示缓存（prompt cache）重写都和主代理分开列。

版本 0.1.0，没有发布到 npm。所有数字都是本地日志里的 token 数，加上按标价折算的 API 等价美元估算。它们不是你的账单，也不是 `/usage` 显示的百分比。

## 为什么做这个

如果你在 Claude Code 周围搭了一套工具（skill、子代理、hook、把活交给其他 CLI 的脚本），一部分用量会花在这套工具和派活上，而不是工作本身。按天汇总的总量看不出这个划分。这个工具从日志里回答三个问题：

1. 主代理的用量里，搭建或维护配置、派活、真正干活各占多少？
2. 每次派活让主代理花了多少（写任务书、发起、读回报和核对），返工有多频繁？
3. 提示缓存什么时候被重写，原因是什么：压缩（compaction）、换模型、等子代理，还是闲置超过了缓存有效期？

## 安装和运行

需要 Node.js 20 或更高版本，没有依赖。

```bash
npx github:keienhrri-bit/claude-code-usage-audit --since 2026-01-01
```

或者克隆下来：

```bash
git clone https://github.com/keienhrri-bit/claude-code-usage-audit
cd claude-code-usage-audit
node bin/claude-code-usage-audit.js --since 2026-01-01
```

在 `examples/` 自带的合成日志上试一下：

```bash
npm run demo
```

## 读什么

- **Claude Code**：`~/.claude/projects/**/*.jsonl`（或 `$CLAUDE_CONFIG_DIR/projects`），包括 `<session>/subagents/` 里的子代理记录。Claude Code 会把一次 API 响应写成几行、每行重复同样的用量，恢复（resume）或分叉（fork）的会话还会把旧消息复制进新文件。所以每个 `message.id` 在所有文件里只算一次。`--dedupe file` 会把不同文件里的副本分别计数，和按文件去重的工具一致。
- **Codex**：`~/.codex/sessions/**/rollout-*.jsonl`（或 `$CODEX_HOME/sessions`）。每轮用量取 `token_count` 事件之间 `total_token_usage` 的增量。
- 别的都不读。工具不联网。它只写你用 `--json` 指定的文件；用 `--cwd-rule` 时会写一个临时规则文件，退出时删除。

Claude Code 会删除超过 [`cleanupPeriodDays`](https://code.claude.com/docs/en/claude-directory#cleaned-up-automatically)（默认 30 天）的会话数据。想统计更长的时间段，要在日志被删之前调大这个设置。

## 示例

`npm run demo` 的完整输出：

```text
claude-code-usage-audit 0.1.0
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
4 tasks; main agent spent $0.53 on them (40% of main), median $0.074 per task
Ledger: 2 of 2 entries matched to a launch
marker           tasks  retries  main API-equiv  worker API-equiv
codex-exec           2        1           $0.25        not linked
claude-subagent      1        0           $0.28            $0.004
agy                  1        0           $0.00        not linked
```

示例日志由 `scripts/make-example-logs.mjs` 生成，脚本里逐条说明了每条消息。测试会把上面的数字和手算结果对照。

## 命令

```text
claude-code-usage-audit [report] [options]   汇总（默认）
claude-code-usage-audit cache [options]      列出缓存重写
claude-code-usage-audit tasks [options]      主代理在每次派活上的花费
claude-code-usage-audit compare --arm self=A..B --arm delegated=C..D [options]
claude-code-usage-audit rules                打印默认规则（可作为配置文件的起点）
```

常用选项：`--since` / `--until`（只写日期表示整天）、`--tz`（默认 `local`，也可以是 `UTC`、`+05:30` 或 IANA 时区名）、`--claude-dir`、`--codex-dir`、`--no-claude`、`--no-codex`、`--json <file|->`、`--top <n>`、`--no-days`。完整列表见 `--help`。

### report：主代理、子代理、分类

主代理就是你自己的那段对话。子代理的轮次（Claude Code 的 `subagents/` 文件、以子代理身份启动的 Codex 会话）列在主代理旁边，从不加进主代理。`--merge-subagents` 把它们并进父会话，用来和把两者合计的工具对照。

主代理的每一轮归入一类：

| 分类 | 默认规则 |
|---|---|
| `orchestration`（配置） | 读或改 `.claude/`、`.codex/` 下的 skill、agent、command、hook、plugin、settings；`CLAUDE.md`、`AGENTS.md`、`.mcp.json`；运行 `ccusage`、本工具、`claude mcp/config/plugin`、`codex mcp/config/login` |
| `dispatch`（派活） | Agent、Task、SendMessage 工具调用；运行 `codex exec`、`agy`、`claude -p`、`gemini -p` 的 shell 命令；为某次派活写任务书或读回报的轮次（见 `tasks`） |
| `work`（工作） | 其余全部 |

规则是作用在工具名和工具输入上的正则表达式。一轮里有多个工具调用时，按上表顺序取第一个命中的分类。没有工具调用的轮次沿用同一会话上一轮的分类。这些都是启发式规则：先拿几段你记得的会话核对一下，再相信这个划分。

**登记你自己的派活脚本。** 如果你通过自己写的脚本派活，默认规则不认识它。放在 `~/.claude/skills/` 下的脚本会被算成配置工作，它发起的派活也找不到。在配置文件里加上它；[`examples/my-rules.json`](examples/my-rules.json) 示范了能加的三样东西：

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

配置里写的键会替换默认值；`prependRules`、`appendRules`、`extraMarkers` 则是在默认值上追加。`--cwd-rule '<regex>=<category>'` 按工作目录把整个会话归入某一类。`claude-code-usage-audit rules` 打印带注释的默认规则。

### tasks：每次派活花了多少

命中标记（marker）的工具调用（Agent/Task、`codex exec`、`agy`、`claude -p`、`gemini -p`，或你自己的 `extraMarkers`）开始一个任务。这次调用里的路径和 `--name` / `--out` 这类参数值成为任务的键。然后主代理的轮次分三个阶段归到任务上：

- **brief**（写任务书）：发起前 30 分钟内（`--lookback`）、工具输入提到某个键的轮次；
- **launch**（发起）：发起它的那一轮；
- **review**（复核）：之后工具输入提到某个键的轮次（读回报、核对、返工）。

键和更早任务重合的任务显示为返工（retry）。Claude Code 子代理的花费会关联到任务上；其他 CLI 做的活显示为“not linked”，除非也载入了它们自己的日志。

**可选的任务台账。** 如果你的派活脚本每完成一单写一行记录，用 `--ledger` 传进来。每行是 JSON，含 `name` 和/或 `dir`，以及 `start` 和 `end`，或者 `time` 和 `seconds`。`ok: false` 表示这一单失败。台账条目会和时间窗口内、调用里提到它的名字或目录的那次发起配对：

```json
{"time":"2026-01-05T09:20:00","seconds":480,"name":"j1","dir":"/home/demo/webapp/jobs/j1","ok":false}
```

### cache：缓存重写及原因

重写指一轮写入提示缓存至少 20,000 个 token（`--cache-min`），而读取的缓存不到上一轮缓存上下文的一半（`--cache-read-ratio`）。原因取下表第一个成立的：

| 原因 | 判断 |
|---|---|
| `compaction` | 这一轮之前有压缩记录 |
| `model-switch` | 模型和上一轮不同（缓存按模型分开） |
| `waiting-on-subagent` | 间隔超过缓存有效期，且期间这个会话的子代理在运行 |
| `idle-5m`、`idle-1h` | 间隔超过上一轮缓存写入的有效期 |
| `unexplained` | 以上都不是（工具列表或系统提示变了、服务端淘汰等） |

子代理自己记录里的重写带 `subagent:` 前缀。会话或子代理的第一轮是冷启动（cold start），单独计数，不算重写。“excess”是写入的 token 按缓存写入价算的费用，减去从缓存读取它们的费用。这些原因是从用量数字推断的；对当前会话，以 Claude Code 自己的状态栏字段为准（见下文）。

### compare：同类工作的两种做法

```bash
node bin/claude-code-usage-audit.js compare --arm self=2026-01-05T09:00..2026-01-05T09:30 --arm delegated=2026-01-05T12:00..2026-01-05T13:00
node bin/claude-code-usage-audit.js compare --arm a=session:aaaa1111 --arm b=session:bbbb2222
```

每个 arm 是一个时间窗口或会话 ID 前缀。表里按 arm 列出主代理用量、子代理、任务和缓存重写。只比一对只是个例；每种做法在几件相似的任务上各重复几次，再下结论。

### 价格和分享

- `data/prices.json` 存的是每百万 token 的美元标价，取自 2026-11-16 的 [Anthropic 价格页](https://platform.claude.com/docs/en/about-claude/pricing)，5 分钟和 1 小时缓存写入分别按输入价的 1.25 倍和 2 倍。`--prices <file>` 可以增加或覆盖模型价格，比如 Codex 的模型默认没有价格，只按原始 token 计。
- “加权 token”（weighted tokens）是按该模型自己的价格折成的输入 token 当量，便于比较不同模型上的轮次。
- `--redact` 把工作目录换成短哈希、隐藏台账名字，用于要公开贴出的输出。贴之前仍要自己检查一遍。

## 和其他工具的关系

和下面这些工具一起用，而不是替代它们。各工具的功能取自它们自己的文档；star 数取自 2026-11-16 的 GitHub API。

| 工具 | 提供什么 | 适合什么时候用 |
|---|---|---|
| Claude Code 状态栏的 [`prompt_cache`](https://code.claude.com/docs/en/statusline#prompt-cache-fields)（v2.1.251+；`last_miss_cause` 和 `miss_causes` 从 v2.1.260 起） | 当前主对话的实时缓存状态：冷热、TTL 和到期时间、请求数、未命中数、命中率、重新缓存的 token、未命中的可能原因 | 边工作边看缓存。只覆盖主对话，不含子代理和过去的会话 |
| Claude Code [`/usage`](https://code.claude.com/docs/en/costs) | 套餐用量；订阅套餐下按 skill、子代理、plugin、MCP server 拆分最近 24 小时或 7 天的用量，数据来自本机历史；一行 `Prompt cache (main)`（v2.1.251+） | 看套餐百分比和最近用量的快速拆分 |
| Claude Code [`/insights`](https://code.claude.com/docs/en/costs) | 关于你怎么工作的报告，而不是用了多少 token | 看工作习惯，不做 token 记账 |
| [ccusage](https://github.com/ccusage/ccusage)（19,449★） | Claude Code 和其他 CLI（含 Codex）的按日、周、月和按会话的 token 与费用报表 | 按天、模型或会话看总量 |
| [Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor)（8,801★） | 带预测的实时终端监控；可选的本地存储，能保留超过 30 天清理期的历史 | 实时盯当前窗口 |
| [tare](https://github.com/kelviq/tare)（307★） | 一个 Claude Code skill，问它用量去了哪：归因、额度诊断、后台自动化、周环比、脱敏摘要（读 Claude Code 日志，支持 macOS 和 Linux） | 在 Claude Code 里用对话方式诊断 |
| [tokenjam](https://github.com/Metabuilder-Labs/tokenjam)（125★） | Claude Code 和 Codex；父会话内按子代理的花费、模型过强的派活、超支分类、仪表盘 | 看每个子代理的花费和仪表盘 |
| [CCUsageX](https://github.com/MHJoy99/CCUsageX)（7★） | 含子代理的按提示（per-prompt）仪表盘、5 小时和 7 天额度、自己保存一份历史 | 按提示看 |

这里没有哪项单独的功能是独有的：tokenjam 也覆盖 Codex 和子代理，`/usage` 和 tare 也做用量归因。这个工具把几件事放在一起：对磁盘上仍在的任意时间段做批量记账；用可编辑的规则划分配置、派活、工作；主代理在每次派活上的花费；跨过去的会话（含子代理）的缓存重写原因。其他本地日志审计工具还有 [ccaudit](https://github.com/kmcheung12/ccaudit) 和 [tokenscope](https://github.com/wartzar-bee/tokenscope)。

## 一个案例：一位用户的日志

一位用户用这个工具跑了自己约 11 天的 Claude Code 日志。这里只给比例。那些日志不在本仓库里，所以这个案例无法用本仓库复现；`examples/` 里的日志是合成的。

在有这个工具之前，一个一次性脚本按这位用户自己的规则，算出配置工作约占主代理用量的 24%。同一时间段用本工具算的结果（只算主代理，按标价折算的 API 等价）：

| 用的规则 | 配置 | 派活 | 工作 |
|---|---|---|---|
| 一次性脚本的规则，移植成配置文件 | 23.7% | 4.4% | 71.9% |
| 默认规则 + 登记这位用户的派活脚本（一条规则、一个标记） | 21.7% | 19.2% | 59.1% |
| …… + 这位用户的配置目录和脚本 | 30.7% | 14.5% | 54.8% |
| 只用默认规则 | 25.7% | 2.1% | 72.2% |

按目录算：在维护配置的那个目录里启动的会话，占主代理用量的 34%。

差别说明了什么：

- **手算结果复现了。** 用移植的规则，配置占比是 23.4%–24.0%，取决于是否去掉恢复会话里同一条消息的副本，以及子代理文件怎么计。在这批日志里，按文件分别计数会让总量虚高约 6%。
- **派活比看上去多。** 默认规则把写任务书、发起、读回报都算作派活；一次性脚本把它们算作工作。登记派活脚本之后，派活比移植规则高约 15 个百分点（工作低约 13 个，配置低 2 个）。
- **要登记派活脚本。** 只用默认规则时，通过 `~/.claude/skills/` 下的脚本发起派活看起来像配置工作，派活也找不到：派活占比降到 2%。
- **按目录算偏高。** 配置目录里的会话也有普通工作，按目录算会把它们全算进去。

## 局限

- 分类、派活关联和缓存原因都是基于工具输入和用量数字的启发式判断，要抽查。
- 美元数字是按标价折算的 API 等价值，不是账单，订阅套餐也不按 token 计费。Claude Haiku 5.5 按 10 万 token 以内提示的价格计；更长提示的高价、按地区计价和 fast mode 都没有建模。
- Codex 和其他非 Claude 模型没有价格，除非你传 `--prices`。
- 派活是通过工具输入里的路径和名字关联的，任务书里两者都没提到就关联不上。
- 日志格式没有公开文档，版本之间可能变化。
- CI 在 Windows 和 Linux 上用 Node 20、22、24 跑测试。没有在 macOS 上测试过。

## 相关工具

- [agent-cite-check](https://github.com/keienhrri-bit/agent-cite-check)：不调用模型，把 AI 代理回报里的引文、数字和改动过的文件逐条对回本地文件。
- [claude-subagent-cost](https://github.com/keienhrri-bit/claude-subagent-cost)：一个 Claude Code mod，在每个子代理的 Agent 行下显示它用的模型和 token，常驻显示 5 小时和 7 天额度，额度快用完时让 Claude 写交接说明。

## 许可证

MIT
