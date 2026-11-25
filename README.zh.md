# dsh-enhance-prompt

WorkBuddy「增强提示词」的 DSH 复刻版：输入框右侧一颗四角星，一键把草稿改写成更清晰、更具体的提示词。

**v0.5.0 起改写先进预览面板**：流式出字、token 级 diff、八版撤销栈，点「采用」才写进输入框——原文在你看清改写之前一个字都不会动。四档模式（轻 / 标准 / 深 / 结构化）随时切换，模型与推理档位可就近选。

提示词（system + user 模板）逐字取自 WorkBuddy `resources/app.asar` 里的 `app/main/server.js`（`llm:enhancePrompt` 处理链的 `Jr` / `Yr` 两个常量），不是照着行为重写的近似版本；但它现在只是 A/B 基线，不是默认值（见 §二）。

---

## 一、和 WorkBuddy 的对应关系

| WorkBuddy（Electron） | 本插件（DSH） |
| --- | --- |
| i18n `input.enhance.title` / `chatInput.enhance.tooltip`（Enhance prompt / 增强提示词） | 按钮 `aria-label` + tooltip，中英随 `navigator.language` |
| i18n `input.enhance.enhancing`（增强中…） | `data-phase="loading"` 的 spinner + tooltip 文案 |
| i18n `input.enhance.revert`（恢复原文） | v0.4.0 同款「恢复原文」；**v0.5.0 改成预览面板 + 「采用」**，草稿在采用前不动，另带 8 版撤销栈 |
| i18n `chatInput.enhance.failed`（Enhance failed / 增强失败） | `data-phase="error"` 的警告图标 + tooltip 带原始错误 |
| `EnhanceIcon`（16×16 四角星）+ `cr-enhance-spinner` | `SparkleIcon` / `SpinnerIcon`（同款四角星几何，24 视框缩放） |
| 状态机 `{isEnhancing, hasEnhancePrompt, errorMessage, backupBlocks, pendingApply}` | `{phase, preview, history, error, meta}`（`phase: idle/loading/streaming/done/error`）+ `localStorage` 里的 prefs/history |
| `makeHandleTriggerEnhance`：AbortController 抢占旧请求 | `abortRef` + 新请求先 abort 旧请求（SSE 流式消费） |
| `makeHandleRevert`：写回 `backupBlocks.before` | 「采用」→ `setDraft(preview)` 并压栈；撤销栈回退写上一版 |
| `makeHandleContentDiverged`：块内容不等于 after 就清掉备份 | `DIVERGE_GRACE_MS=1200` 宽限后比较 `draft !== preview`，不等即作废预览 |
| `minTextLength: 1` | 空草稿点按钮 → `phase=error`，文案「先写点内容再增强」 |
| 主进程 RPC `llm:enhancePrompt` | HTTP `/enhance` + `/stream`（SSE）+ 模型工具 `enhance_prompt` |
| `runAgent({systemPrompt: Jr, userPrompt: Yr.replace('{input}', text)})` | 同一个 system + 同一个 `{input}` 模板，走宿主 `llm` 服务；但默认档换成 `standard`（见 §二） |
| `stripWrappingQuotes`（去 `" ' “ ” ‘ ’`） | `sanitizeOutput()`，同一条正则 |
| 空结果 → `llm_error` / `Enhanced result is empty` | `empty_output`，同一条文案 `the model returned an empty rewrite` |
| 日志前缀 `[enhancePrompt]` | 同前缀 |

WorkBuddy 里没有、这里补上的：`enhance_prompt` 模型工具、`GET /info` 自检、`/stream` SSE 流式、`/models` 模型与 effort 清单、四档模式、保真闸/长度闸/语言闸、上下文触发器、可自定义 system/模板。

v0.5.0 与 WorkBuddy 的**行为分歧**（都是有意的）：改写先进预览面板而不直接覆盖输入框；默认档不是 WorkBuddy 原文而是 A/B 胜出的 `standard`；有 `@引用` 时禁用按钮；事实丢失只补一次、不流水线重试。

## 二、质量对比：我们 vs WorkBuddy（2026-11-18）

WorkBuddy 的「增强提示词」在实现上只有一步：草稿塞进 `Yr`，连同 `Jr` 交给一次 `runAgent`。所以拿同一台模型分别跑两套提示词，比的就是提示词本身。12 条用例 × 5 轮裁判取均值（中/英/混排 × 极含糊/已具体 × 提问/列表/代码/写作/运维）：

| 维度（1–5） | WorkBuddy | 我们 |
| --- | --- | --- |
| fidelity 保真 | 4.58 | **4.98** |
| gain 具体化增益 | **4.77** | 4.40 |
| language 语言跟随 | 4.78 | **4.98** |
| restraint 不越界 | 3.10 | **4.35** |
| usable 可直接粘贴 | 4.90 | **4.97** |
| **总分（25）** | 22.13 | **23.69** |
| 用例胜负 | 1 | **11** |
| 事实丢失（12 条） | 3 | **1** |
| 平均长度比 | 12.3× | **5.64×** |

`gain` 是唯一落后的轴，而且是有意的：裁判给 gain 打分时奖励「多加几条要求」，WorkBuddy 正是靠把 5 字需求灌成 12 倍长度拿到这一分；我们用 restraint 换掉了它（+1.25），总分净胜 1.56。

完整报告（含每轮迭代、逐用例输出与裁判评语）：[`docs/compare-report.md`](docs/compare-report.md)，原始数据 `docs/compare-round1..6.json`。

## 三、安装

本插件是标准 DSH bundle（`dsh.bundle.patch` + `dsh.client`），两种装法：

```powershell
# A. 已装进 desktop profile 的机器上，直接启用
#    （把目录复制到 profile 的 node_modules，再把包名加进 dsh.profile.bundles）
node tools/install.mjs          # 本仓库自带，复制 + 注册，幂等

# B. 手工装
Copy-Item . "C:\Users\<user>\.dsh\profiles\desktop\node_modules\dsh-enhance-prompt" -Recurse
#    然后在 profile 的 package.json 里：
#    dependencies["dsh-enhance-prompt"] = "file:<本目录绝对路径>"
#    dsh.profile.bundles.push("dsh-enhance-prompt")
```

装完刷新窗口（Ctrl+R）即可看到按钮；**纯 insert 的 bundle 不需要重启 DSH**（`plugin_manager set_bundle` 会热挂载）。卸载：`plugin_manager action=set_bundle enabled=false target=dsh-enhance-prompt`。

## 四、配置

`Config` 走宿主设置面板（cordis.patch.yml 里那一行的 `config`），全部有默认值：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后按钮仍渲染但请求直接报 `disabled` |
| `provider` / `model` | `''` | 留空 = 候选链自动试（见 `providerPriority` / `maxAttempts`） |
| `temperature` | `0.3` | WorkBuddy 侧不可配，这里放开 |
| `maxTokens` | `4000` | 增强结果通常 100~400 token；推理模型的 reasoning 也吃这个预算，留足 |
| `timeoutMs` | `60000` | 超时 → code `timeout`，前端显示「增强失败」 |
| `minTextLength` | `1` | 与 WorkBuddy `minTextLength:1` 对齐 |
| `maxInputChars` | `8000` | 超长草稿直接拒（code `too_long`），避免烧额度 |
| `promptStyle` | `standard` | `light` 1.2× / `standard` 2.5× / `deep` 4× / `system`（输出结构化 system prompt）/ `workbuddy`（逐字复刻的 Jr/Yr，A/B 基线）。未知值一律回落 `standard` |
| `lengthGuard` | `true` | 长度闸：超出该档 ratio 就收敛重写一次；`system`/`workbuddy` 不限长，但任何档都至少有 600 字符地板（容得下 standard 档要补的执行细节，否则闸会反过来把内容压回去） |
| `fidelityGuard` | `true` | 保真闸：改写前抽事实锚点，改写后逐个验证还在不在 |
| `fidelityRepair` | `true` | 丢事实时补一次（最多一次，永不流水线） |
| `refineMode` | `true` | 允许模型把模糊草稿补成可执行任务，而不是反问用户 |
| `contextAware` / `contextTurns` / `contextChars` | `true` / `6` / `4000` | 仅当草稿是指代句（「刚才那个方案再改一下」）时带最近几轮对话 |
| `stream` | `true` | 前端走 SSE 流式；关掉则等整段返回 |
| `idempotent` | `true` | 相同草稿+模式+模型复用结果（`force` 可跳过） |
| `reasoningEffort` | `''` | 空 = 不发 effort。机械改写用默认 effort 实测输出 token 是关掉的 11.5 倍 |
| `totalBudgetMs` | `90000` | 整次请求（含候选重试与一次修复）的总预算 |
| `maxConcurrency` | `2` | 并发改写数，超出的请求回 429 |
| `allowRemote` | `false` | 允许非回环客户端（默认只服务本机） |
| `requireHeader` | `true` | 要求 `x-dsh-enhance: 1`，挡掉跨站表单式调用 |
| `rateLimitPerMinute` | `30` | 每客户端每分钟改写次数（令牌桶） |
| `customSystemPrompt` | `''` | 非空则覆盖 system |
| `customUserTemplate` | `''` | 非空则覆盖 user 模板，必须含 `{input}` |
| `stripWrappingQuotes` / `stripCodeFence` | `true` | 模型爱加引号/``` 围栏，和 WorkBuddy 一样剥掉 |
| `announceToAgent` | `true` | 是否把「可以用 enhance_prompt」写进系统提示词 |
| `toolsEnabled` | `true` | 是否注册 `enhance_prompt` 工具 |
| `providerPriority` | `[]` | 候选 provider 的优先顺序，命中的排前面 |
| `maxAttempts` | `6` | 一次增强最多试几个候选路由（前几个 provider 常常 key 失效/余额不足） |
| `selfTestOnStart` | `false` | 打开后每次加载真跑一次增强（花一次模型调用）。结构自检（prompts/modes/routes/guard/log/version）永远零成本执行，结果在 `/info.startupCheck` |

## 五、接口

全部在 `/dsh-enhance-prompt/*` 下（`/api/enhance-prompt/*` 保留为别名，但宿主 api-gateway 会先接管该前缀并回 401）。所有路由（含 `/info`）都要求 `x-dsh-enhance: 1` 头，且默认只服务回环地址；`/info` 只跳过限流，不跳过头检查。

```http
POST /dsh-enhance-prompt/enhance      # 整段返回
{ "text": "帮我写个爬虫", "style": "standard", "provider": "magpie", "model": "group/deepseek-v4.1", "effort": "low", "force": false }
→ { "ok": true, "text": "...", "meta": { "mode", "modeLabel", "provider", "model", "route", "ms", "chars", "draftChars",
                                         "ratio", "ratioLabel", "budget", "anchors": { "total", "kept", "reinjected" },
                                         "note", "repaired", "contextUsed", "contextReason", "language", "cached" } }
→ { "ok": false, "code": "empty|too_long|forbidden|rate_limited|busy|timeout|upstream|empty_output|no_route|llm_unavailable|disabled|bad_request", "error": "..." }

POST /dsh-enhance-prompt/stream       # SSE，同一份 body
event: route   data: { "provider": "magpie", "model": "group/deepseek-v4.1" }
event: delta   data: { "text": "改写到一半的片段" }
event: done    data: { "ok": true, "text": "完整结果", "meta": { …同 /enhance… } }
event: error   data: { "ok": false, "code": "upstream", "error": "..." }   # 错误码集合同 /enhance

GET  /dsh-enhance-prompt/models       # 可选模型清单（含休眠 provider）
→ { "ok": true, "groups": [ { "provider": "magpie", "active": true,
      "models": [ { "id": "...", "name": "...", "description": "...",
                    "reasoning": { "efforts": [ { "id": "low", "name": "Low" } ], "defaultEffort": "low" } } ] } ],
    "defaultStyle": "standard", "styles": ["standard","light","deep","system","workbuddy"] }

GET  /dsh-enhance-prompt/info         # 同样要求请求头，前端探活用
→ { "ok": true, "version": "0.5.0", "enabled": true, "style": "standard", "styles": [...], "maxRatio": 2.5,
    "guards": { "fidelity": true, "repair": true, "length": true },
    "context": { "aware": true, "turns": 6, "chars": 4000 },
    "reasoningEffort": "(model default)", "stream": true, "route": { "provider": "...", "model": "..." },
    "routes": [...], "stats": { ... }, "startupCheck": { ... } }

POST /dsh-enhance-prompt/report       # 浏览器侧失败上报，写宿主日志
POST /dsh-enhance-prompt/selftest     # 真跑一次增强（可带 {"text": "..."}）
```

`meta.anchors.reinjected > 0` 表示丢过事实并补跑过一次——此时长度上限让位，宁可长也不许丢内容。错误码与 WorkBuddy 语义对齐但用短名：`empty`（原文 `Empty input`）、`empty_output`（原文 `Enhanced result is empty`），外加 `too_long` / `timeout` / `busy` / `upstream` / `no_route` / `llm_unavailable` / `disabled` / `forbidden` / `rate_limited` / `bad_request`。

## 六、验证

```powershell
# 单元测试：40 项，不打模型（anchors 18 + prompts 9 + client 9 + 宿主契约 6）
npm test
npm run check                      # 四个入口文件语法检查

# 现场：拿 WorkBuddy 的 prompt 直接打本机网关，看中/英/混排三种输入的语言是否跟随
node test/live.mjs                 # 默认 http://127.0.0.1:3425/v1 + group/deepseek-v4.1
node test/live.mjs group/deepseek  # 换模型

# A/B 质量对比：WorkBuddy 原版 prompt vs 我们的优化版（12 用例 × N 轮裁判）
node test/compare.mjs --round 6 --passes 5
node tools/report.mjs              # 由各轮 json 生成 docs/compare-report.md

# 线上验证：直接打插件接口，看默认风格的真实输出
node test/live-compare.mjs
```

`npm test` 显式列出四个文件而不是无参 `node --test`：`test/compare.mjs`、`test/live*.mjs` 会真打模型，绝不能被卷进单元测试。

`test/client.test.mjs` 用 `new Function` 注入 stub 跑**出厂的 `lib/client.js` 源码**，截获 `__ModuleLoader__.load({ id, factory })` 后对 `exports.__internals` 断言——测的是发布物本身，不是它的副本。

`test/live.mjs` 的判据（2026-11-17 实测通过）：中文进中文出、英文进英文出、混排保持混排、结果不带语言标签元注释、原样包的引号被洗掉、耗时 1.5~3.5s。

## 七、已知边界

- 采用改写后写回的是**整段草稿**，不会保留引用块的结构；改写前你能看到 diff，但没有逐块采用。
- 撤销栈 8 版，绑在当前浏览器 profile 上；`localStorage` 不可用（隐私模式）时静默降级为本次会话内有效。
- 挂了 `@引用` 时按钮直接禁用——`setDraft` 是否会清空引用列表在宿主侧无法确认，静默丢用户附的文件比让用户先清掉更糟。
- 只挂 `conversation.input.right` 槽；宿主若改槽名，`slots.inject` 不会触发，按钮不出现（不会报错）。
