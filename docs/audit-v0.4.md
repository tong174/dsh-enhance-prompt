# 审判与重建：dsh-enhance-prompt v0.3.0 → v0.4.0 审计报告

审计日期 2026-11-18。对象为 v0.3.0（`lib/index.js` 656 行 / `lib/client.js` 443 行 / `lib/prompts.js` 227 行）。
立场：假设这个插件会交给陌生人装在他的机器上，而他不知道我们的任何背景 —— 凡是「作者心里有数、代码里没写」的地方，一律算缺陷。

每条给三件事：**是什么** / **为什么是问题** / **影响多大**（🔴 会坏 / 🟠 会浪费 / 🟡 会误导）。

---

## 一、功能性问题（会真的做错事）

### F1 🔴 `listModels()` 被当成同步函数读 —— 路由系统从 0.3.0 起就是坏的

- **是什么**：`modelIds(llm, provider)` 写的是 `Array.isArray(llm.listModels(provider))`。宿主的签名是 `async listModels(provider): Promise<LlmModelInfo[]>`（见 `@deepseek-ai/dsh-llm/lib/typert.host.js`）。拿到 Promise，`Array.isArray` 恒为 `false`，于是**每个 provider 都被判定为「没有任何模型」**。
- **为什么是问题**：候选链退化成 `{ provider: 'deepseek-official', model: '' }` 这种裸路由，并且因为它是第 4 步按注册顺序生成的，会被排到第一顺位。于是**每一次**增强都先拿空 model 去打最不可用的那个 provider，失败后才靠兜底走到真能用的路由。
- **影响**：实测 `GET /info` 直接暴露了证据 —— `"route": {"provider": "deepseek-official", "model": ""}`。每次调用多一次必然失败的往返（本机实测 wasted attempt ≈ 1 次模型调用 + 数百 ms 到数十秒）；更糟的是「指定 provider 只展开模型」这条路径完全失效，配置了 `provider` 而不配 `model` 的用户拿不到任何模型候选。
- **根因性质**：v0.3.0 的日志里那些 `deepseek-flash` 模型名是更早版本的硬编码残留，不是这个函数算出来的 —— 也就是说这段代码从来没真正工作过，只是被缓存和兜底掩盖了。

### F2 🔴 `candidateRoutes` 主动制造 `model: ''` 废路由

- **是什么**：`push({ provider: id, model: first || '' })` —— 模型列表拿不到就填空串，照样入链。
- **为什么是问题**：空 model 交给 provider 是未定义行为（有的适配器抛错，有的悄悄用它自己的默认模型）。它把「解析失败」伪装成「有一条可用路由」，让 F1 的症状变成静默的而不是响亮的。
- **影响**：见 F1。修法是把它降级为**最后兜底**：先只收有模型名的路由；全部落空时才启用裸路由；再空才抛 `no_route`。

### F3 🔴 `stripWrappingQuotes` 单边吞字符

- **是什么**：`/^["'\u201C\u201D\u2018\u2019]|["'\u201C\u201D\u2018\u2019]$/g` —— 两端各自独立匹配。
- **为什么是问题**：输入 `"only left`（只有左引号）会被削成 `only left`，`it's fine'` 会被削成 `it's fine`。原始 WorkBuddy 只做「两端都是引号才剥」，我们的正则把它变成了「任意一端是引号就剥」。
- **影响**：改写结果可能少一个字符、破坏一个合法的英文缩写或代码片段。静默数据损坏，用户看不出来源。已由单测锁死（`stripWrappingQuotes('"only left')` 必须保留左引号）。

### F4 🔴 默认风格自相矛盾：schema 说 `enhanced`，代码回退 `workbuddy`

- **是什么**：`Config` 里 `promptStyle` 默认 `'enhanced'`；`cfg()` 里 `readConfigField(config?.promptStyle, 'workbuddy')`。
- **为什么是问题**：`readConfigField` 在字段未配置时返回 fallback，于是两份默认值打架 —— **schema 里那个从未生效过**。
- **影响**：装了插件、什么都不配的人，拿到的是 WorkBuddy 的逐字复刻版（灌水、混排被翻平、丢事实），而不是我们 A/B 赢了 11:1 的那版。整个「优化提示词」的成果对默认用户是 0。

### F5 🟠 `resolvePromptStyle` 把「配错」当「没配」

- **是什么**：`typeof value === 'string' ? value.trim().toLowerCase() : ''`。
- **为什么是问题**：`promptStyle: 42`（或任何非字符串）被当成空，回退默认且 `fallback` 标记为 false —— 上层连一条警告都不会记。
- **影响**：用户改错了配置，行为静默变化，没有任何反馈。

### F6 🟠 `minTextLength: 0` 无效

- **是什么**：`Math.max(1, c.minTextLength)`。
- **为什么是问题**：字段语义是「最短可接受长度」，配 0 理应允许一切。
- **影响**：极小，但属于「配置项骗人」，必须修。

### F7 🟠 ENHANCED_SYSTEM 的规则 5 与它自己的示例互相否定

- **是什么**：规则 5 写 `NEVER TURN A DOABLE TASK INTO A QUESTIONNAIRE`，例外清单里却写着「可以问 which server」；而示例段里 zh-ops 那条的正确输出就是「请先补充操作系统、对外暴露的服务与端口…」。
- **为什么是问题**：模型在规则与示例冲突时跟示例走。示例就是一个把可做任务变成问卷的样本。
- **影响**：A/B 六轮里 zh-ops 是**唯一稳定输给 WorkBuddy 的用例**（21.4 vs 23.4）。这不是玄学，是 prompt 里的自相矛盾。

---

## 二、成本与安全（会把钱花在错的地方）

### S1 🔴 `/selftest` 是 GET，且「仅限回环」只写在注释里

- **是什么**：`selfTestHandler` 没有任何来源判断，GET 一次就真跑一次 `enhance('帮我写个爬虫')`。
- **为什么是问题**：注释宣称 loopback-only，代码里没有；GET 是最容易被顺手触发的方法（浏览器预取、代理探测、任何能访问该端口的进程）。
- **影响**：一次真实模型调用 = 一次额度 + 1.5–60 s。别人机器上装了这个插件，一条 curl 就能持续烧。

### S2 🟠 `selfTestOnStart` 默认 `true`

- **是什么**：每次插件加载（安装、重启、热重载）1.5 s 后真跑一次增强。
- **为什么是问题**：把一个「诊断开关」设成默认行为。装了就花钱，而用户并不知道。
- **影响**：每次重载一次调用；对推理模型还可能因为 `maxTokens 4000` 拿到空文本而把自检记成 error —— 误报。

### S3 🔴 `/enhance` 允许请求体指定 `provider` / `model`，且路由无鉴权

- **是什么**：`if (body.provider) route.provider = body.provider`；`/dsh-enhance-prompt/*` 由宿主 webserver 承接，而 webserver 自身不鉴权。
- **为什么是问题**：任何能访问 12578 的进程（本机任意用户、同网段、恶意页面通过 `fetch` 到 localhost）都可以用你的 key 打**任意** provider 与模型。这是额度滥用面，不是理论问题。
- **影响**：钱包。且 `fetch('http://127.0.0.1:12578/dsh-enhance-prompt/enhance')` 从任意网页都能发（简单请求不触发预检）。

### S4 🟠 无并发与幂等保护

- **是什么**：连点四角星 = 并发请求 = 各自独立走完候选链。
- **为什么是问题**：同一段草稿被增强 N 次毫无意义，纯浪费。
- **影响**：两次点击 ≈ 两倍额度；六次点击可能撞上 provider 限流。

### S5 🟠 死 provider 只按 provider 记，且落盘路由不随适配器变化失效

- **是什么**：`deadUntil` 键是 provider（不含 model）；`llm/adapters-updated` 只把内存 `routeCache = null`，`~/.dsh/enhance-prompt-route.json` 原样留着。
- **为什么是问题**：同一 provider 下换个模型也一起冷藏 10 分钟；而落盘的路由可能指向已经卸载的适配器，重启后第一条候选就是死的。
- **影响**：换 provider/换模型后仍然先撞一次墙。

### S6 🟠 最坏时延 = `maxAttempts × timeoutMs` = 6 分钟

- **是什么**：6 条路由 × 每条 60 s，HTTP 侧没有总预算。
- **为什么是问题**：用户点一次星，最坏等 6 分钟，UI 一直转圈，浏览器可能先断开（断开后我们仍在花钱）。
- **影响**：糟糕体验 + 不可控成本。

---

## 三、可靠性细节（不会立刻坏，但会咬人）

| 编号 | 是什么 | 为什么是问题 | 影响 |
| --- | --- | --- | --- |
| R1 | `version` 在 `infoHandler` 与 `ready` 日志里**硬编码 `'0.3.0'`** | 与 `package.json` 双源，必然漂移 | 🟡 用户报的版本号可能是错的，排查被误导 |
| R2 | `/api/enhance-prompt/*` 两条别名路由 | 该前缀被宿主 api-gateway 占据，一律 401 —— 代码里自己注释写明了还会 401 却仍然注册 | 🟡 死代码；`test` 与客户端都要为它维护回退分支 |
| R3 | `readJsonBody` 超限时 `req.destroy()` | 直接掐掉连接，客户端拿到的是网络错误，看不到 `too_large` | 🟠 用户只看到「失败」，看不到原因 |
| R4 | 日志 `appendFileSync` + 无轮转 | 同步写阻塞事件循环；日志文件无限增长 | 🟠 热路径抖动；半年后是个几百 MB 的文件 |
| R5 | 响应头无 `nosniff`、无 `no-store` | `/info` 可能被缓存；响应类型可被嗅探 | 🟡 |
| R6 | 错误态 title 塞整段错误文本，点击 = 重试，无法清除 | 用户想「消掉红点」只能重试或刷新 | 🟠 交互死角 |
| R7 | 空草稿点星 → 红色错误图标 | 空输入不是错误，是「没东西可增强」 | 🟠 第一次用的人会以为坏了 |
| R8 | 客户端 report 上报无上限 | 每条失败都 POST 一次，日志可被刷爆 | 🟡 |
| R9 | `no_route` / `llm_unavailable` 与普通模型失败同为 502 | 客户端无法区分「配置问题」与「网络问题」 | 🟡 |

---

## 四、改了什么（v0.4.0）

### 后端 `lib/index.js`

- **F1/F2**：`modelIds` 改 async 并 `await llm.listModels()`；结果按 provider 缓存 60 s（`MODEL_TTL_MS`），`llm/adapters-updated` 清缓存。`candidateRoutes` 改 async；`push` 只收有模型名的路由，裸路由降级为**全部落空时的最后兜底**，再空抛 `no_route`。四个调用点全部 `await`。
- **F4/F5**：`prompts.js` 新增 `PROMPT_STYLES` / `DEFAULT_PROMPT_STYLE` / `resolvePromptStyle()` 作为**唯一真源**；`cfg()` 的 `promptStyle` 回退改用它，配错值会 `fallback: true` 并记日志。
- **F6**：`Math.max(0, …)`。
- **F3**：`stripWrappingQuotes` 改为配对剥离（`QUOTE_PAIRS`，两端必须同族引号）。
- **S1**：`selftest` 改 **POST**（GET 回 405 并提示「一次自检要花一次真实调用」），并纳入 `guard()` 的 2/min 限流。
- **S2**：`selfTestOnStart` 默认改 **`false`**；新增**零成本** `staticSelfTest()`（prompts / route / log / routes 四项），每次加载都跑，结果进 `startupCheck`、`/info` 与日志。
- **S3**：新增 `guard(req, res, kind)`：①非回环 403（`allowRemote: false`）；②必须带 `x-dsh-enhance: 1` 头（`requireHeader: true`，跨站 `fetch` 带自定义头会触发预检，直接被挡）；③按客户端令牌桶限流（enhance 30/min、report 120/min、selftest 2/min）。模型工具的参数**收紧为只有 `text`**；请求体里的 `provider`/`model` 只在它确实是已注册 provider 时生效，否则**忽略并记日志**（不 400，保持向后兼容）。
- **S4**：sha256 幂等缓存（`CACHE_LIMIT 32`，LRU）+ 单飞（同 key 并发请求共享一次调用）+ `maxConcurrency 2`（超出回 `429 busy`）。成功后**把结果本身也缓存**，所以「连点两次」第二次 0 ms。
- **S5**：`deadUntil` 键改 `${provider}\u0000${model}`；`adapters-updated` 现在同时清内存路由、**删落盘文件**、清冷却、清模型缓存。落盘路由带 `savedAt`，7 天过期。
- **S6**：`totalBudgetMs`（默认 90 s）覆盖整条链，每条路由的 timeout 取 `min(timeoutMs, 剩余预算)`，剩余不足 500 ms 直接抛 `timeout`。
- **R1**：`VERSION` 从 `package.json` 单源读取（`createRequire(import.meta.url)('../package.json')`）。
- **R2**：删除两条 `/api/enhance-prompt/*` 死路由与客户端的回退分支。
- **R3**：超限后 `reject` + `req.resume()` 排空，响应仍能送达（`413 too_large`）。
- **R4**：日志改异步 `fs.appendFile`，超过 2 MB 轮转成 `.1`。
- **R5**：`sendJson` 加 `cache-control: no-store` + `x-content-type-options: nosniff`；**不发任何 CORS 头**。
- **R9**：`ERROR_STATUS` 集中映射（400/401/403/405/413/429/502/503/504）。

### 前端 `lib/client.js`

- **R6/R7/R8**：状态机 `idle | loading | done | error` 重写。空草稿只抖一下（`data-flash`），不报错；错误态 10 s 自动回落、点击即重试；错误文案走 `describe(code)` 的 12 条人话（`busy` / `timeout` / `forbidden` / `not_loaded` …），title 截断 90 字符；成功后的 1.2 s 宽限期内按钮变「恢复原文」。`prefers-reduced-motion` 降级、`focus-visible` 焦点环、上报计数封顶 20 条。
- 请求统一带 `x-dsh-enhance: 1`；删除 legacy 前缀回退。

---

## 五、优化前后对比

| 维度 | v0.3.0 | v0.4.0 | 依据 |
| --- | --- | --- | --- |
| 实际生效的默认风格 | `workbuddy`（schema 说 `enhanced`） | `enhanced` | F4 |
| 首条候选路由 | `deepseek-official` + **空 model**（必然失败） | `deepseek-official` + `deepseek-flash` | `/info` 前后实测 |
| 每次点击的模型调用 | 1 + 1 次必然失败的重试 | 1（重复点击 0） | `test/api.mjs` 幂等项 |
| 最坏等待 | 6 × 60 s = **6 分钟** | `totalBudgetMs` 90 s 硬顶 | S6 |
| `/selftest` 触发方式 | GET，无来源校验，无限制 | POST，回环 + 头部 + 2/min | S1 |
| 加载即花一次额度 | 是（默认开） | 否（静态四项零成本） | S2 |
| 从网页跨站调用 API | 可行（无鉴权、无头部要求） | 被 `x-dsh-enhance` 头 + 回环检查挡住 | S3 |
| 引用剥离 | 单边吞字符 | 两端配对才剥 | F3 |
| 死路由 | 只按 provider，10 min | 按 provider+model，10 min，适配器变化即清 | S5 |
| 明确错误码 | 5 个（且 2 个死） | 9 个 + 一一对应 HTTP 状态 | R9 |
| 版本来源 | 硬编码 ×2 | `package.json` 单源 | R1 |
| 单元测试 | 7 项 | **14 项（全过）** | `node test/unit.mjs` |
| HTTP 契约测试 | 无 | **7 项（全过）** | `node test/api.mjs` |
| 代码量 | index 656 / client 443 / prompts 227 | index 1119 / client 527 / prompts 230 | 体积涨在安全、幂等、观测上；prompt 资产本身只多了 3 行（导出与校验函数） |

---

## 六、怎么验证优化真的生效

### 1. 静态：不碰模型，随时可跑

```powershell
node test/unit.mjs
# 期望：14 项通过（含"两端配对才剥引号"、"默认风格是 enhanced"、"规则 5 不再自相矛盾"）
```

### 2. 契约：对着运行中的宿主

```powershell
node test/api.mjs              # 7 项，含 1 次真实调用
node test/api.mjs --no-model   # 6 项，不花钱
```

期望逐项：`GET /info` 的 `version` 等于 `package.json`；缺头的 `POST /enhance` → 403；`GET /selftest` → 405；空输入 → 400；300 KB → 413；真实增强 200 且输出无围栏；同输入第二次 `cached: true` 且文本一致。

### 3. 路由真的解析到了模型（F1 的现场证据）

```powershell
curl.exe -s http://127.0.0.1:12578/dsh-enhance-prompt/info
```

必须同时满足：

- `"route": { "provider": "...", "model": "..." }` —— **model 非空**（v0.3.0 是 `""`）；
- `"startup": { "ok": true }`，`startup.checks` 里 `route` 的 `detail` 是候选数（本机 6）；
- `"promptStyle": "enhanced"`（不配置时）。

### 4. 成本闸门（S1/S3 的现场证据）

```powershell
# 应 405
curl.exe -s -o NUL -w "%{http_code}`n" http://127.0.0.1:12578/dsh-enhance-prompt/selftest
# 应 403（缺头）
curl.exe -s -o NUL -w "%{http_code}`n" -X POST -H "content-type: application/json" -d '{\"text\":\"hi\"}' http://127.0.0.1:12578/dsh-enhance-prompt/enhance
# 应 200（带头）
curl.exe -s -X POST -H "x-dsh-enhance: 1" -H "content-type: application/json" -d '{\"text\":\"帮我写个爬虫\"}' http://127.0.0.1:12578/dsh-enhance-prompt/enhance
```

### 5. 前端（需要人点一次）

按 `Ctrl+R` 刷新页面，在输入框打一句中文，点四角星：

- 正常：按钮转圈 → 草稿被替换 → 按钮变成「恢复原文」；
- 空输入：按钮抖一下，**不出红点**（v0.3.0 会变红）；
- 连点两次：第二次几乎立刻返回（缓存）；
- 每次都会在 `~/.dsh/enhance-prompt.log` 留下 `[client] report` 或 `enhance ok` 一行。

```powershell
Get-Content "$env:USERPROFILE\.dsh\enhance-prompt.log" -Tail 20
```

### 6. 启动日志

插件加载时应有：

```
[info] startup check :: {"ok":true,...,"checks":[{"name":"prompts","ok":true},{"name":"route","ok":true,"detail":6},{"name":"log","ok":true},{"name":"routes","ok":true}]}
[info] ready :: {"version":"0.4.0",...,"route":null}
```

`ok:true` 且**没有** `self-test ok` 行（因为 `selfTestOnStart` 默认 false）。

---

## 七、评估后**故意不改**的地方

诚实记账，避免下一轮重复争论：

1. **`cfg()` 每次调用重建 20 个字段**：`readConfigField` 可能读到 cordis 的 volatile `Ref`，缓存会让热更新失效。代价是每次 HTTP 请求几十次属性读取 —— 与一次模型调用相比可忽略。**保留**。
2. **请求体里的 `provider`/`model` 覆盖**：没有删，而是「只在合法 provider 时生效、否则记日志」。删掉会破坏已有脚本与 `test/live*.mjs`；鉴权与头部闸门已经把滥用面挡住了。**保留 + 收紧**。
3. **`promptStyle` 保留 `workbuddy` 原版**：那是逆向复刻的参照物，删了就再也无法做对照实验。只是它不再是默认。**保留**。
4. **改写仍然替换整个草稿**：block/quote 结构不保留，与 WorkBuddy 一致。要改就得做增量 diff 注入，属于新功能，不在本次审计范围。
