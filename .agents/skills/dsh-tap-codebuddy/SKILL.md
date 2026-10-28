---
name: dsh-tap-codebuddy
description: |
  处理 DeepSeek Harness 的 dsh-tap 插件与 CodeBuddy 渠道（copilot.tencent.com 网关）的一切问题。
  适用场景：codebuddy 渠道报错（400/11128 "Illegal API invocation from an unapproved channel"、11101、11102、
  11150、12403、14401、14407、401/429/503）、本地 3901 桥不通、模型清单缺失或被禁用、额度与用量异常、
  OAuth 登录与刷新、思考档位 reasoning_effort 不生效、改了 dsh-tap 代码要确认怎么生效、
  需要从会话文件里还原真实请求体抓现场、要查网关事实与踩坑记录。
  触发关键词：dsh-tap、dsh tap、tap 插件、codebuddy、CodeBuddy 渠道、3901 桥、codebuddy 报错、11128、
  unapproved channel、codebuddy 模型、codebuddy 额度、codebuddy 登录、plugin.json、transformChatPayload。
license: MIT
---

# dsh-tap / CodeBuddy 渠道排障

> 本 skill 有两份同内容副本：仓库内 `.agents/skills/dsh-tap-codebuddy/`，本机全局 `~/.dsh/skills/dsh-tap/`。
> 下文用 `$SKILL` 指代当前这份的根目录：
>
> ```powershell
> # 全局安装副本
> $SKILL = "$env:USERPROFILE\.dsh\skills\dsh-tap"
> # 或直接用仓库内的副本
> # $SKILL = "<repo>\.agents\skills\dsh-tap-codebuddy"
> ```
>
> 自带脚本：`scripts/dsh-session-dump.js`（从会话文件还原真实请求）、`scripts/probe-codebuddy.js`（打桥判链路）。

## 一句话

dsh-tap 是把腾讯 CodeBuddy 网关（`copilot.tencent.com`）接进 DSH 的插件。codebuddy 渠道的链路是：

```
DSH agent → pi-ai(openai-completions) → 本地桥 127.0.0.1:3901/v2 → adapters 出站归一 → 腾讯网关
```

**本地桥是出站方言的唯一收口**（`transformChatPayload`）。想改 DSH 发出的请求长什么样，改这里，别改上游别处。

## 固定事实（别每次重新摸索）

| 项 | 值 |
|---|---|
| 插件包 | `~/.dsh/profiles/desktop/node_modules/dsh-tap`（纯 ESM，Node ≥ 22） |
| 渠道配置 | `~/.dsh/profiles/desktop/cordis.patch.yml` 的 `llm-pi-ai.providers.codebuddy`，`baseURL: http://127.0.0.1:3901/v2` |
| 桥端口 | codebuddy `3901`；trae `3912`、qoder `3913`（desktop profile 在默认 3902/3903 上 +10） |
| 哨兵头 | `Authorization: Bearer dsh-codebuddy-bridge` + `X-IDE-Type/Name/Version`、`X-Product-Version`、`X-Requested-With`、`X-Private-Data` |
| 插件设置层 | `~/.dsh/codebuddy-plugin.json`（含 `apiKeys`、`modelState.disabled`、`modelState.overrides`） |
| 用量台账 | `~/.dsh/codebuddy-plugin-usage.json` |
| 会话记录 | `~/.dsh/sessions/<项目>/session-<uuid>/session.v4.jsonl.zstd`（**多帧 zstd**） |
| 宿主 | `C:\app\dsh\DeepSeek Harness.exe`（Electron；桥由它的 host 子进程监听 3901） |

会话文件里就是抓现场的金矿，一条记录一种用途：

| record `type` | 用途 |
|---|---|
| `system/message` | system prompt 全文（含 `source.kind`） |
| `user/message` | 每条 user 消息（含 AGENTS.md、runtime context、skill 目录） |
| `request/header` | 出站 tools 数组（可达 64 个）+ `config.model/maxTokens` |
| `request/context` | 实际 `provider` / `model` / `contextWindow` |
| `assistant/attempt` | 失败原文（`finish.reason.failure.message` 里带网关 code/msg/requestId） |

## 硬规则

1. **生效方式按层次区分**：静态配置（`cordis.patch.yml`）、组合根（`index.js`/`host-config.js`）、`core/`、`providers/codebuddy/` 改动 = **必须重启桌面应用**；trae/qoder 网关端口域名热生效；多服务商 preset 热加载；浏览器设置卡刷新页面即可。改完不重启就别声称已修好。
2. **按 code 判定，不按文案**。同一个 `11128` 既可能是通道校验拒绝，也可能是内容审核变迁后的出口；`finish_reason: content_filter` 是历史形态。断言只认 `http + code + 层级`。
3. **出站归一只能做「语义等价」**：`developer → system`、system 文本等义改写。不改写用户输入、不新增能力面、不伪造凭据。
4. **`core/` 禁止出现 CodeBuddy 特化**（`scripts/verify-core-generic.mjs` 会锁）。渠道事实一律落在 `providers/codebuddy/`。
5. **改插件代码必须同步文档**：新网关事实 → `docs/rules/gateway-facts.md` 或对应专题；新坑 → `docs/pitfalls.md` 取新编号；原始请求/响应证据 → `docs/probes/*.jsonl`。改完跑 `node scripts/verify-bridge.mjs`，应为 `all bridge checks passed` + exit 0。
6. **`cordis.patch.yml` 会被宿主重写**（每次启动规范化，注释与模型清单一并重排，文件长度变化是正常现象）。判断配置是否丢失，要对账「patch 里的 id 是否都在生成的 `cordis.yml` 里」，不要比字节数。

## 排障流程：先分流，再抓现场

### 第 0 步：确认链路停在哪一段

```powershell
# 桥在不在（应看到 LISTENING，PID = 宿主 host 子进程）
netstat -ano | Select-String ":3901"
# 宿主是谁、什么时候起的
Get-Process -Name "DeepSeek Harness" | Select-Object Id,StartTime
```

桥不在 → 宿主没起来或插件没装载，先把 DSH 起来再看。
桥在 → 用探针打一发裸请求，区分「渠道级」还是「内容级」：

```powershell
node "$SKILL\scripts\probe-codebuddy.js" --text "hi"
# 200 + SSE  → 渠道本身通，问题在请求内容 → 走 400/11128 流程
# 400/11128  → 连裸请求都拦 → 凭据/UA/头/账号级，去 docs/rules/ua-validation.md
```

### 400 / 11128 的标准二分（实战验证有效）

**不要猜，一定从会话文件里取真实字节回放。** 手写重建会抹掉差异（踩坑 #19/#22）。

1. 找到失败会话，导出真实请求：
   ```powershell
   node "$SKILL\scripts\dsh-session-dump.js" `
     "$env:USERPROFILE\.dsh\sessions\--E-gzq_deepseek--\session-<uuid>\session.v4.jsonl.zstd"
   ```
   产出 `meta.json` / `system.txt` / `system-plain.txt` / `user-N.txt` / `user-msgs.json` /
   `request-header.json` / `request-context.json` / `attempt.json`。
2. 先读 `request-context.json` 确认 `provider`（是 codebuddy 还是别的渠道），再读 `attempt.json` 拿网关原文。
3. 回放四变体：全量 → 去 user → 去 tools → 只剩 system。哪一档翻转，问题就在那一层。
4. 定位到 system 文本后，用**前缀扫描**找临界长度（步长 50 → 10 → 5 → 1），再对临界窗口做「删一句 / 换一个词」测试，找出最小触发串。
5. 结论必须落成一张「变体 × 结果」表，并把原始响应存进 `docs/probes/`。

**已知的两个 11128 触发源**（都记在 `docs/rules/content-moderation.md`，碰壁前先读）：

| 触发源 | 形态 | 处置 |
|---|---|---|
| R-M1 | messages 含字面量 `role:"developer"` | 适配器出站重写 `developer → system`（已落地） |
| R-M4 | system 里 `@` 路径说明段同时含 `@` + `Relative paths resolve from` + `workspace root`（临界精确到 `root` 的 `t`） | `SYSTEM_PROMPT_REWRITES` 把 `workspace root` → `project root`（已落地） |

R-M4 的来源是 DSH 内置 `@deepseek-ai/dsh-file-reference-local` 的硬编码 `FILE_REFERENCE_PROMPT`，**没有开关**（`read` 工具存在就注入），所以只能在桥的出站钩子上消解。遇到第三个触发源，按同样方法定位后追加进 `SYSTEM_PROMPT_REWRITES`。

### 其它错误码分流

| code | 含义方向 | 去哪看 |
|---|---|---|
| `11101` | 非流式请求被拒（本网关仅流式） | 确保 `stream: true` |
| `11102` | service info not found：目录里有但 `/v2` 不可路由 | `providers/codebuddy/catalog.js` 的 `UNROUTABLE_MODELS` |
| `11150` | 不支持的 `reasoning_effort` 档位 | 只发目录声明过的档位 |
| `12403` | UA 不是 CLI 形态 | `providers/codebuddy/headers.js` |
| `14401`/`14407` | 路由 / route config not found | `providers/codebuddy/errors.js` |
| `401`/`429`/`503 credential unavailable` | 凭据 / 额度 / 刷新失败 | `oauth.js` + `~/.dsh/codebuddy-plugin*.json` |

错误码真源在 `providers/codebuddy/errors.js`，不要凭记忆报含义。

### 模型清单问题

模型是否出现由 `modelState.disabled` 决定，不由网关目录决定：

```powershell
$j = Get-Content "$env:USERPROFILE\.dsh\codebuddy-plugin.json" -Raw | ConvertFrom-Json
$j.modelState.disabled.PSObject.Properties | Where-Object { $_.Value -eq $true } | Select-Object Name
```

判读：

- 模型不见了 → 先查是不是 `disabled: true`（自动禁用或手动禁用），再查是否在 `UNROUTABLE_MODELS`。
- 清单条目数变少但 `cordis.patch.yml` 的 id 全在生成物里 → 属于正常的目录/禁用态投影，不是配置丢失。
- 想恢复 → 在 tap 设置卡启用，或改 `modelState.disabled`，然后重启。

## 常用命令

```powershell
# 插件自带回归（改完必跑）
cd "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-tap"
node scripts/verify-bridge.mjs           # 期望 all bridge checks passed / exit 0
node scripts/verify-core-generic.mjs     # core 层未被 CodeBuddy 特化污染
node scripts/verify-models.mjs --list

# 桥取证日志（重启时带上环境变量，落每次出站的头与结果）
$env:CODEBUDDY_BRIDGE_LOG = "$env:TEMP\bridge.jsonl"
```

## 文档地图（改之前先读，别凭记忆）

| 要查什么 | 文件 |
|---|---|
| 网关事实总表（端点/头/UA/缓存/额度） | `docs/rules/gateway-facts.md` |
| 11128 / developer / system 文本触发源 | `docs/rules/content-moderation.md` |
| 错误码与路由 | `providers/codebuddy/errors.js` + `docs/rules/routing.md` |
| 踩坑全本（改之前 grep 编号） | `docs/pitfalls.md` |
| 课题交接状态 | `docs/rules/STATE.md` |
| 版本变更 | `CHANGELOG.md` |
| 开发纪律与命令 | 插件根 `AGENTS.md` |

## 交付纪律

改完一处，交付这四样，缺一不可：

1. **原文件备份**（`.bak-before-<主题>-<时间戳>`）
2. **回归结果**（`verify-bridge` 输出行 + exit code）
3. **证据落盘**（`docs/probes/*.jsonl`，含真实响应体）
4. **回滚路径**（备份文件路径 + 「重启生效」这句话）

验证要能区分「代码对」和「链路生效」：代码对用单元自检（直接调 `transformChatPayload` 看 payload），链路生效用探针打 3901 看 http/code。**没重启就只说「代码已就位、待重启」，不要报「已修复」。**

## 编辑本 skill 的注意事项

本机 `powershell.exe` 是 5.1，`Get-Content -Raw` 默认按 GBK/ANSI 解码 UTF-8 文件。**不要用 PowerShell 的 `Get-Content` + `Set-Content`/`WriteAllText` 改这个目录下的文件** —— 中文会被解码成乱码再写回，frontmatter 一旦损坏，skill 会直接从 catalog 掉线（已踩过一次）。请用 UTF-8 安全的编辑器或 `write`/`edit` 工具。
