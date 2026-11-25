# Changelog

## 0.5.0 — 2026-11-25

把 51 个同类 DSH 提示词增强插件的长处逐条对完，能吸收的吸收，吸收不了的说清为什么。核心变化：**改写不再直接覆盖输入框**。

### 交互

- **预览面板**：点四角星后改写以 SSE 流式进入面板，草稿在用户点「采用」前一个字都不动。v0.4.0 只有「直接覆盖」一条路，等于必须先把原文交出去才能判断改写值不值。
- **token 级 diff**：面板里「原文 / 改写」并排，改动处按 token 高亮。公共前后缀先裁掉再做 LCS，短改写走的是几十个格子的表；超过 `DIFF_CELL_LIMIT`（4M 格）降级成整段替换而不是把界面卡死。
- **8 版撤销栈**：每次采用压栈，可逐版回退，`localStorage` 持久化（隐私模式下静默降级为不持久）。
- **模式 chip**：`light / standard / deep / system` 四档直接可见；`enhanced` 只是 `standard` 的旧别名、`workbuddy` 是 A/B 夹具，两者都不出 chip。
- **模型与 effort 下拉**：`/models` 拉宿主的 provider 分组，`reasoning.efforts` 校验后才发，网关拒 effort 时自动降级重试。
- **有 @ 引用时禁用按钮**：`setDraft` 是否会清空引用列表无法在宿主侧确认，宁可禁用也不静默丢用户引用的文件。
- 快捷键与 `Esc` 关闭；`DIVERGE_GRACE_MS=1200` 宽限期防止「自己写回草稿」被误判成用户手动编辑。

### 质量闸（确定性，不靠模型自觉）

- **保真闸**：改写前抽出草稿里的具体事实（内联命令、URL、路径、文件名、版本号、带单位数字、`camelCase` / `snake_case` / `CONST_CASE` / 点链标识符、`@引用`、引号字面量），改写后逐个验证是否还在。三级匹配 raw → 折叠空白 → 去全部空白，**大小写敏感**（`Foo` 与 `foo` 在多数语言里是两个东西）。
- **一次修复**：只补一次，把丢失项作为「必须原样保留」的清单重新注入，最多再跑一次就收工。永不流水线——第 2 次生成后仍缺项就如实报告，而不是无限重试烧额度。
- **长度闸**：每档有 ratio 上限（light 1.2× / standard 2.5× / deep 4×），超出即重写；`system` / `workbuddy` 不限长但有 `MIN_BUDGET_CHARS=600` 字符下限（地板必须容得下下面 completeness floor 的三条细节，否则长度闸会反过来把内容压回去）。`null` ratio 回落 2.5 而不是「无限」。
- **语言闸**：纯中文草稿不能改写成英文，反之亦然；真正混排的草稿两侧都放行。
- **上下文触发器**：草稿是「刚才那个方案再改一下」这类指代句时才带上最近几轮对话，普通草稿不塞上下文。

### 改写质量：从「重排」到「补齐执行细节」

v0.5.0 首版实测暴露了真问题：45 字的 `帮我写个爬虫 抓 douban top250 存 csv 每天跑一次 别用selenium` 只被改成 83 字的三段加粗重排，`ratio 1.8×`、锚点 0/0——格式变好看了，信息量没变。根因不是模型不行，是提示词自相矛盾：`DISCIPLINE` 第 6 条禁加用户未说的东西、第 8 条缺信息只许保持笼统或 `(TBD: ...)`，`STANDARD_SYSTEM` 又写着「pick from this menu, do not use all of it」「A one-line request must never be inflated into a specification」，三处叠加等于命令模型「只许重排，不许补料」。

把两件事切开：

- **产品决策**（功能、范围、技术栈、库、格式、受众）——仍然禁。这决定用户拿到的是不是他要的东西。
- **执行细节**（存哪些字段、重跑覆盖还是追加、失败怎么重试、多久跑一次、重复怎么处理）——任何工程师要做到用户已经要求的事都得先定下来。草稿点了具体活儿就**必须补**，但**绝不静默**：每条行内标注 `（假定：…）` / `(assumed: …)`，用户一键可删。

`STANDARD_SYSTEM` 新增 `Completeness floor`：job 型草稿不到「工程师能直接开工」不算完，至少 3 条执行细节，且每条必须落定一个决策（禁止不落决策的句子）；纯问题、纯观点、已可执行的草稿没有下限。`Hard limits` 首条从「一行请求绝不可膨胀成规格」改为 `Structure is earned`——一行问题不加标题，已是清单的不重编号。

实测（同一批探针）：爬虫草稿 → 546 字、5 条假定标记、字段/翻页/重试/cron/编码/验收齐备；`Redis 的持久化有几种方式？` → 原样 16 字不膨胀；`把 lib/index.js:42 的 timeout 从 30000 改成 60000` → 195 字、锚点 1/1；`light` 档 20 字 → 12 字（去填充、不膨胀）。

### 提示词

- `prompts.js` 重写为 `DISCIPLINE`（共享约束）+ 五档模式，`DEFAULT_PROMPT_STYLE` 改为 `standard`。WorkBuddy 原文逐字保留，作为 A/B 基线而不是默认值——它的 system 里写死「maximum length should be around 800 characters」，实测平均 12.3× 长度膨胀、12 条事实丢 3 条。
- 未知风格一律回落 `standard`，**永不回落 `workbuddy`**。

### 修掉的缺陷

- `readConfigField` 查的是 schemastery 的 schema 属性而不是解析后的配置值，逻辑上恒不命中 → 换成 `safeRead()`，profile 热重载期间抛异常的 getter 不再拖垮整次请求。
- `llm.listModels()` 是 async，旧码同步读导致路由实际从未生效。
- `loadSavedRoute()` 是占位废码 → 真实持久化到 `~/.dsh/enhance-prompt-route.json`，写失败只当优化失效。
- `stripWrappingQuotes` 两端独立匹配会吞掉单边引号 → 改成配对剥一层。
- `streamRoute` 的 `effort` 与参数解构撞名（`Identifier 'effort' has already been declared`）。
- `anchors.js`：被否决的候选匹配会把 `lastIndex` 推到其后，导致 `` ``` `` 收尾与后续 `` `npm i` `` 开头配成假对、真锚点被跳过 → 每次否决回退到 `start + 1`。
- `detectLanguage` 的 2× 阈值用 `>=`，2 个汉字对 1 个英文词被误判成纯中文 → 改严格大于，小样本正确落到 `mixed`。

### 工程

- `test/anchors.test.mjs`（18）、`test/prompts.test.mjs`（9）、`test/client.test.mjs`（9）、`test/contract.test.mjs`（6），`npm test` 40 项全绿；`npm run check` 四入口语法检查。
- `test/client.test.mjs` 用 `new Function` 注入 stub 跑**出厂源码**取 `__internals`，断言的是发布物本身而不是副本。
- `test/contract.test.mjs` 把宿主契约钉死：`systemPrompt.section({name, order:<有限数>, text})`、`tools.register` 必须带 `output{schema, render}`、`parameters` 用扁平方言、所有路由必须在 `/dsh-enhance-prompt` 前缀下、默认模式不得回落 `workbuddy`、写回草稿必须经「采用」。

## 0.4.0 — 2026-11-19

- 从 `app.asar` 逆向重写：prompt 资产逐字对齐、错误码对齐、状态机对齐。
- 路由迁到 `/dsh-enhance-prompt/*`（`/api/*` 会被 gateway 401）。
- 模型工具 `enhance_prompt` + 系统提示词公告。
- 发布到 DSH 插件市场（PR #16368 已合并）。

## 0.3.0 — 2026-11-18

- A/B 定稿：12 用例五轴 23.69 vs 22.13，事实丢失 1 vs 3，长度比 5.64× vs 12.3×。
- 定下「不灌水换分、不丢事实、不把可做任务变成问卷」三条硬约束。
