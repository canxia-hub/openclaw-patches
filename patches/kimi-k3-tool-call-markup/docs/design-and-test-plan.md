# Kimi K3 工具调用「文本标签协议」漂移 — 插件修复计划

日期：2026-09-03 ｜ 状态：计划定稿，签名开关两项变更已随本计划应用（待网关重启生效）
影响面：`~/.openclaw/extensions/kimi`（@openclaw/kimi-provider v0.8.5），`kimi/k3` 模型通道

---

## 0. 证据与根因定位（已完成）

1. **协议真相（官方文档，platform.kimi.ai，2026-09-03 拉取原文）**
   - `/docs/api/messages.md`：Kimi coding 端点的 Anthropic Messages 兼容接口输出**原生 `tool_use` content block**，内容顺序固定 `thinking → text → tool_use`；流式为 `content_block_start/delta/stop`，thinking 带 `signature_delta`。
   - `/docs/guide/tool-call-repeat.md`（官方《How to Fix Repeated Tool Calls》）：重复调用根因排查顺序 = ①消息布局（`finish_reason=tool_calls` 的消息原样回填、每个 tool_call 有配对 `role=tool` 结果、`tool_call_id` 严格匹配、流式 `function.arguments` 分片必须正确聚合）→ ②客户端 3/5/8 次重复注入 `<system-reminder>` 升级提示。
   - `/docs/guide/kimi-k3-tool-calling-best-practice.md`：**工具清单过大时 K3 更容易选错工具**，官方方案是 `search_tools` 动态注入，首轮回 auto。
2. **插件现状（extensions/kimi/dist 源码审计）**
   - `stream.js`：K3 走两条路径——原生 tool_use 直通 + `parseKimiTaggedToolCalls()` 文本标签垫片（`<|tool_calls_section_begin|>…<|tool_call_begin|>{id}<|tool_call_argument_begin|>{json}<|tool_call_end|>…<|tool_calls_section_end|>`，Hermes/GLM 模板）。垫片缺陷：
     - **全有或全无**：任一调用段不合规 → 整段返回 null，本轮全部工具调用静默丢失；
     - **固定偏移 + indexOf 链式扫描**：多调用/截断/嵌套花括号时边界易错位；
     - 未剥离 `functions.` 命名空间前缀的容错；
     - 只改写 text block，**分片态标签文本可能泄漏为可见文本**（事故中可见的 "I need to investigate further…" 泄漏即此类）。
   - `replay-policy.js`：`preserveSignatures: false`（回放剥离思考签名）。
   - `stream.js` K3 分支：强制 `compat.allowEmptySignature: true`。
3. **事故闭环形态（09-03 05:53–06:31）**：长会话 + 60+ 工具清单 + thinking=max 下，模型发出**名字漂移**的原生 tool_use（`feishu_ask_user_question`，args 被掏空/错误）→ 网关 schema 校验失败 → 错误以 toolResult 回填 → 模型不改名重试 → 循环，直至 core loop detector 阻断。换模型即愈 → 定位为 k3 通道，排除会话状态损坏。

**根因判定**：原生 tool_use 的选择漂移（官方已知的 K3 大清单行为）为主因；文本标签垫片的脆弱解析与签名剥离策略为放大器；校验失败的错误回填给模型"同名再试"的负反馈为循环燃料。

---

## 1. 对齐目标与不变量

| # | 不变量 | 依据 |
|---|--------|------|
| I-1 | 每个 toolCall 块必须获得配对 toolResult（id 严格一致），禁止孤儿 | 官方消息布局四检查 |
| I-2 | 标签协议原文任何情况下不得作为可见文本外泄 | OpenClaw text 通道 |
| I-3 | 名字解析必须做命名空间归一：`functions.<name>:<n>` → `<name>`；归一后名字不在本轮 tools 清单内 → 按"未知工具"错误回填（含合法工具名提示），**不得**原样执行 | 官方 tool_choice/清单文档 |
| I-4 | 解析失败粒度从"整段丢弃"改为"单调用容错"：坏段跳过 + 上报，好段照常执行 | 修复漂移静默丢失 |
| I-5 | 同一 (name, arguments) 连续重复 3 次注入官方弱提醒，5 次强提醒（携带工具名/次数/参数），8 次熔断上报 | 官方 tool-call-repeat.md |

## 2. 协议语义映射（Kimi 文本标签 ↔ OpenClaw 块）

```
<|tool_call_begin|>{rawId}<|tool_call_argument_begin|>{jsonArgs}<|tool_call_end|>
  rawId      → name = strip("functions."前缀, ":N"计数后缀)；id = rawId 原样
  jsonArgs   → arguments（JSON.parse 失败 → I-4 容错路径，不吞整段）
外层 section 缺失时 → 退化为逐段扫描（正则按 BEGIN…到下一个 BEGIN/END/section-END 切段），不再整段判死
stopReason: "stop" + 解析出 ≥1 个 toolCall → 改 "toolUse"（保留现有行为）
```

## 3. 变更清单

### 3.1 垫片解析器重写（stream.js）— 核心修复
- 用**分段正则 + 每段独立 try/catch** 替换 indexOf 固定偏移（cursor=28/±17/±26 硬编码一并消灭）；
- I-3 命名空间归一与工具清单校验（清单从 `context/tools` 传入）；
- I-2：partial 帧中的**不完整标签前缀**（如 `<|tool_call…`）从 text 输出中缓冲/剥离；
- 未知工具名 → 返回结构化错误 toolResult，文案明确"该名字不存在，可用工具：…"，切断同名重试的负反馈。

### 3.2 签名策略翻转（本计划已应用，需重启生效）
- `replay-policy.js`：`preserveSignatures: false → true`；
- `stream.js`：K3 分支 `compat.allowEmptySignature: true → false`。
- **回归风险**：K3 `display:"summarized"` 思考可能无签名，严格签名策略下多轮回放或被端点 400。验证序（先隔离后主配置）：
  ```powershell
  # 隔离冒烟：3 轮工具循环 + thinking high
  OPENCLAW_CONFIG_PATH=... OPENCLAW_STATE_DIR=... openclaw agent --local --json
  ```
  若 400 invalid signature：回退方案 A = `preserveSignatures:true` 保留 + 插件侧把无签名 thinking 块降级为普通 text 回放；回退方案 B = 恢复原值。

### 3.3 循环熔断对齐（OpenClaw 侧，不改插件）
- 现有 loop detector（"Repeated tool call detected/blocked"）保持；
- 增强：kimi/k3 车道在 detector 第 3 次重复时按官方文案注入 `<system-reminder>`（弱），第 5 次注强提醒，替代直接阻断，给模型自纠机会；8 次再阻断。实现走 agent-turn 前置中间件/extraParams，不动 core。

### 3.4 工具清单降漂（需阿訫决策的选项）
- 方案 α：k3 车道 per-model 工具 allowlist，defer `video_*`（~40 个）与 `feishu_*`（~30 个）大件，用时再开；
- 方案 β：按官方 best practice 上 `search_tools` 动态注入（工程量最大，二期）。
- 默认建议：先 α 保守版（仅 defer video_*），观察一周漂移率再定 β。

## 4. 测试与验收
| 层 | 用例 |
|----|------|
| 解析单测 | 正常单/多调用、缺 END 截断、args 嵌套花括号、空 args、`functions.` 前缀、`:N` 计数、未知工具名、混合好段+坏段（坏跳好留） |
| 泄漏测试 | 分片流中半截标签不得出现在最终 text（对 webchat 输出断言） |
| e2e 冒烟 | k3 单消息并发 2 工具（spawn+exec）×3 轮；日志零 "Repeated tool call was blocked" |
| 签名回归 | 多轮 thinking 工具循环零 HTTP 4xx（3.2 验证序） |
| 验收标准 | 上述全绿 + 连续 3 天生产会话无同名重复阻断事件 |

## 5. 持久化与升级防护
- dist 直改会在 `openclaw upgrade` 时被覆盖：本次改动已备份原件 `*.bak.20260903`；
- 落 `~/.openclaw/workspace/ops/scripts/reapply-kimi-patch.ps1`（升级后幂等重放全部补丁）；
- 同步整理 issue 材料（本文件 §0 证据 + §3.1 设计）向 openclaw / kimi-provider 提上游 PR，上游合入后废弃本地补丁。

## 6. 回滚
`Copy-Item *.bak.20260903 → 原名` + 网关重启，10 秒回到现状。

---
*调查证据链：session jsonl 取证（257776c4…）、kimi 插件源码审计（stream/replay-policy/provider-policy-api/index）、官方文档三份原文缓存（%TEMP%\kimi_{toolcall,messages,k3best}.md）。*
