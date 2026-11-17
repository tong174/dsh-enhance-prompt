# dsh-enhance-prompt

WorkBuddy「增强提示词」的 DSH 复刻版：输入框右侧一颗四角星，一键把草稿改写成更清晰、更具体的提示词；改完按钮变「恢复原文」，点一下退回原稿；自己动手改了字，恢复入口自动消失。

提示词（system + user 模板）逐字取自 WorkBuddy `resources/app.asar` 里的 `app/main/server.js`（`llm:enhancePrompt` 处理链的 `Jr` / `Yr` 两个常量），不是照着行为重写的近似版本。

---

## 一、和 WorkBuddy 的对应关系

| WorkBuddy（Electron） | 本插件（DSH） |
| --- | --- |
| i18n `input.enhance.title` / `chatInput.enhance.tooltip`（Enhance prompt / 增强提示词） | 按钮 `aria-label` + tooltip，中英随 `navigator.language` |
| i18n `input.enhance.enhancing`（增强中…） | `data-phase="loading"` 的 spinner + tooltip 文案 |
| i18n `input.enhance.revert`（恢复原文） | `data-phase="done"` 的回箭头图标，点击写回 `backup` |
| i18n `chatInput.enhance.failed`（Enhance failed / 增强失败） | `data-phase="error"` 的警告图标 + tooltip 带原始错误 |
| `EnhanceIcon`（16×16 四角星）+ `cr-enhance-spinner` | `SparkleIcon` / `SpinnerIcon`（同款四角星几何，24 视框缩放） |
| 状态机 `{isEnhancing, hasEnhancePrompt, errorMessage, backupBlocks, pendingApply}` | `{phase, backup, enhanced, error}`（`phase: idle/loading/done/error`） |
| `makeHandleTriggerEnhance`：AbortController 抢占旧请求 | `abortRef` + 新请求先 abort 旧请求 |
| `makeHandleRevert`：写回 `backupBlocks.before` | `writeDraft(backup)` |
| `makeHandleContentDiverged`：块内容不等于 after 就清掉备份 | `graceRef` 宽限 1.2s 后比较 `draft !== enhanced`，不等即清备份 |
| `minTextLength: 1` | 空草稿点按钮 → `phase=error`，文案「先写点内容再增强」 |
| 主进程 RPC `llm:enhancePrompt` | HTTP `POST /dsh-enhance-prompt/enhance` + 模型工具 `enhance_prompt` |
| `runAgent({systemPrompt: Jr, userPrompt: Yr.replace('{input}', text)})` | 同一个 system + 同一个 `{input}` 模板，走宿主 `llm` 服务 |
| `stripWrappingQuotes`（去 `" ' “ ” ‘ ’`） | `sanitizeOutput()`，同一条正则 |
| 空结果 → `llm_error` / `Enhanced result is empty` | 同 code、同文案 |
| 日志前缀 `[enhancePrompt]` | 同前缀 |

WorkBuddy 里没有、这里补上的：`enhance_prompt` 模型工具（让 agent 自己也能改提示词）、`GET /api/enhance-prompt/info` 自检、`promptStyle: 'system'` 的通用润色提示词、可自定义 system/模板。

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
| `maxInputChars` | `8000` | 超长草稿直接拒（code `too_large`），避免烧额度 |
| `promptStyle` | `enhanced` | `enhanced` = 优化版（A/B 实测优于原版）；`workbuddy` = 逐字复刻的 Jr/Yr；`system` = 通用润色提示词 |
| `customSystemPrompt` | `''` | 非空则覆盖 system |
| `customUserTemplate` | `''` | 非空则覆盖 user 模板，必须含 `{input}` |
| `stripWrappingQuotes` / `stripCodeFence` | `true` | 模型爱加引号/``` 围栏，和 WorkBuddy 一样剥掉 |
| `announceToAgent` | `true` | 是否把「可以用 enhance_prompt」写进系统提示词 |
| `toolsEnabled` | `true` | 是否注册 `enhance_prompt` 工具 |
| `providerPriority` | `[]` | 候选 provider 的优先顺序，命中的排前面 |
| `maxAttempts` | `6` | 一次增强最多试几个候选路由（前几个 provider 常常 key 失效/余额不足） |
| `selfTestOnStart` | `true` | 加载后跑一次自检并把结果写进日志（排障用） |
| `logFile` | `~/.dsh/enhance-prompt.log` | 宿主侧文件日志；浏览器侧的失败也会 POST 到这里 |

## 五、接口

```http
POST /dsh-enhance-prompt/enhance
{ "text": "帮我写个爬虫", "provider": "magpie", "model": "group/deepseek-v4.1" }
→ { "success": true, "text": "...", "provider": "magpie", "model": "..." }
→ { "success": false, "text": "", "code": "empty_input|too_large|timeout|llm_error|disabled", "error": "..." }

GET  /dsh-enhance-prompt/info
→ { "success": true, "enabled": true, "minTextLength": 1, "maxInputChars": 8000,
    "promptStyle": "enhanced", "configuredProvider": null, "configuredModel": null }
```

`/api/enhance-prompt/*` 保留为别名，但宿主 api-gateway 会先接管该前缀并回 401，**实际请用 `/dsh-enhance-prompt/*`**。另有 `POST /dsh-enhance-prompt/report`（浏览器侧失败上报，写日志）与 `GET /dsh-enhance-prompt/selftest`（真跑一次增强）。

错误码与 WorkBuddy 对齐：`empty_input`（原文 `Empty input`）、`llm_error`（原文 `Enhanced result is empty`）、外加 `timeout` / `too_large` / `disabled`。

## 六、验证

```powershell
# 纯逻辑：引号/围栏清洗 + 模板替换
node test/unit.mjs

# 现场：拿 WorkBuddy 的 prompt 直接打本机网关，看中/英/混排三种输入的语言是否跟随
node test/live.mjs                 # 默认 http://127.0.0.1:3425/v1 + group/deepseek-v4.1
node test/live.mjs group/deepseek  # 换模型

# A/B 质量对比：WorkBuddy 原版 prompt vs 我们的优化版（12 用例 × N 轮裁判）
node test/compare.mjs --round 6 --passes 5
node tools/report.mjs              # 由各轮 json 生成 docs/compare-report.md

# 线上验证：直接打插件接口，看默认风格的真实输出
node test/live-compare.mjs
```

`test/live.mjs` 的判据（2026-11-17 实测通过）：中文进中文出、英文进英文出、混排保持混排、结果不带语言标签元注释、原样包的引号被洗掉、耗时 1.5~3.5s。

## 七、已知边界

- 增强后写回的是**整段草稿**（与 WorkBuddy 一致），不会保留引用块/附件的结构化状态。
- 「恢复原文」的备份在组件 state 里，切换会话或刷新页面即失效（WorkBuddy 存在 `backupBlocks` 里跨渲染保留，但同样不跨会话）。
- 只挂 `conversation.input.right` 槽；宿主若改槽名，`slots.inject` 不会触发，按钮不出现（不会报错）。
