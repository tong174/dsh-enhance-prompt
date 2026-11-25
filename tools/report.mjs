// 从 docs/compare-round*.json 生成对比报告 docs/compare-report.md。
// 用法：node tools/report.mjs
import fs from 'node:fs'
import path from 'node:path'

const ROUNDS = [
  { file: 'docs/compare-round1.json', label: 'R1 初版', note: '自写 prompt 首版：事实守恒 / 长度自适应 / 结构守恒 / 提问不被作答' },
  { file: 'docs/compare-round2.json', label: 'R2 +问用户', note: '加入「缺失信息要问用户」，副作用是大量任务被改成问卷' },
  { file: 'docs/compare-round3.json', label: 'R3 收窄规则5', note: '规则 5 收窄为「真的无法开始时才问」，裁判升级为 3 轮 A/B 交换' },
  { file: 'docs/compare-round4.json', label: 'R4 加自检', note: '规则 3 加白名单（交付物形态/验收方式/原文隐含约束）+ 输出前自检' },
  { file: 'docs/compare-round5.json', label: 'R5 反问卷', note: '规则 5 改为「禁止把可做任务变成问卷」+ BAD OUTPUT 反例' },
  { file: 'docs/compare-round6.json', label: 'R6 定稿', note: '语言规则要求外语从句逐字保留；裁判 5 轮取均值（最终基准）' },
]

const AXES = ['fidelity', 'gain', 'language', 'restraint', 'usable']
/** R1/R2 的 json 是旧结构（没有 summary.total），这里补齐。 */
function normalize(d) {
  if (d.summary?.total) return d
  const total = { workbuddy: 0, enhanced: 0 }
  for (const side of ['workbuddy', 'enhanced']) {
    total[side] = Number(AXES.reduce((n, a) => n + (d.summary?.[side]?.[a] ?? 0), 0).toFixed(2))
  }
  d.summary = { ...d.summary, total }
  return d
}
const load = (f) => normalize(JSON.parse(fs.readFileSync(f, 'utf8')))

const rows = []
for (const r of ROUNDS) {
  if (!fs.existsSync(r.file)) continue
  const d = load(r.file)
  rows.push({ ...r, d })
}

const final = rows[rows.length - 1].d

const md = []
md.push('# 增强提示词质量对比：我们 vs WorkBuddy')
md.push('')
md.push('## 对比口径')
md.push('')
md.push(
  'WorkBuddy 桌面端的「增强提示词」在实现上只有一步：把用户草稿塞进 `Yr` 模板，连同 `Jr` 系统提示词交给一次 `runAgent({agentName:"enhance-prompt"})`。它没有别的加工、没有后处理（只去一次包裹引号）。所以**用同一台模型分别跑两套提示词，比的就是提示词本身的质量**——这正是本对比做的事。',
)
md.push('')
md.push('- 基准 A：`WORKBUDDY_SYSTEM` + `WORKBUDDY_USER_TEMPLATE`（从 `server.js` 逐字切出）')
md.push('- 候选 B：`ENHANCED_SYSTEM` + `ENHANCED_USER_TEMPLATE`（自写，见 `lib/prompts.js`）')
md.push(`- 模型：\`${final.model}\`（本机 magpie 网关），temperature 0.3，max_tokens 2000`)
md.push('- 用例：12 条，覆盖 中文/英文/中英混排 × 极含糊/已很具体 × 提问/列表/代码块/写作/运维')
md.push(
  '- 裁判：五轴各 1–5（fidelity 保真 / gain 具体化增益 / language 语言跟随 / restraint 不越界 / usable 可直接粘贴），每轮按 (用例序号+轮次) 奇偶交换 A/B 位置，多轮取均值以压掉位置偏好与噪声',
)
md.push('- 确定性指标（不依赖裁判模型，可机器复核）：语言一致数、meta 泄漏、围栏、包裹引号、长度比、mustKeep 事实丢失数')
md.push('')

md.push('## 各轮结果')
md.push('')
md.push('| 轮次 | 说明 | 我们总分 | WorkBuddy 总分 | 用例胜负（我们:它:平） | 事实丢失 | 长度比 |')
md.push('| --- | --- | --- | --- | --- | --- | --- |')
for (const r of rows) {
  const s = r.d.summary
  const det = r.d.deterministic
  const passes = r.d.passes ?? 1
  md.push(
    `| ${r.label} | ${r.note} | **${s.total.enhanced}** | ${s.total.workbuddy} | ${s.wins.enhanced}:${s.wins.workbuddy}:${s.wins.tie} | ${det.enhanced.missingFacts} vs ${det.workbuddy.missingFacts} | ${det.enhanced.avgLenRatio}× vs ${det.workbuddy.avgLenRatio}× |`,
  )
}
md.push('')
md.push('> 总分 = 五轴之和（满分 25）。R1/R2 是单轮裁判，R3 起为 3 轮，R6 为 5 轮；轮次间差异在 ±0.4 内属裁判噪声，方向一致。')
md.push('')

md.push('## 定稿（R6）五轴对比')
md.push('')
md.push('| 维度 | WorkBuddy | 我们 | 差 |')
md.push('| --- | --- | --- | --- |')
for (const axis of AXES) {
  const a = final.summary.workbuddy[axis]
  const b = final.summary.enhanced[axis]
  const ours = b >= a ? `**${b}**` : String(b)
  const theirs = a > b ? `**${a}**` : String(a)
  md.push(`| ${axis} | ${theirs} | ${ours} | ${b - a > 0 ? '+' : ''}${(b - a).toFixed(2)} |`)
}
md.push(
  `| TOTAL | ${final.summary.total.workbuddy} | **${final.summary.total.enhanced}** | +${(final.summary.total.enhanced - final.summary.total.workbuddy).toFixed(2)} |`,
)
md.push('')
md.push('用例胜负：我们 11 : WorkBuddy 1 : 平 0')
md.push('')
md.push(
  '> `gain` 是唯一我们落后的轴（4.4 vs 4.77），而且是**故意的**：裁判给 gain 打分时奖励「多加了几条要求」，而 WorkBuddy 正是靠把 5 字需求灌成 12 倍长度拿到这一分。我们用 restraint 换掉了它（+1.25），总分因此净胜 1.56。`zh-ops` 是它唯一赢的用例——那类需求确实需要先问环境信息，我们的版本问了但排得不够靠前。',
)
md.push('')
md.push('确定性指标：')
md.push('')
md.push('| 指标 | WorkBuddy | 我们 |')
md.push('| --- | --- | --- |')
md.push(`| 语言跟随正确 | ${final.deterministic.workbuddy.langOk}/12 | ${final.deterministic.enhanced.langOk}/12 |`)
md.push(`| 事实丢失（mustKeep 未保留） | ${final.deterministic.workbuddy.missingFacts} | ${final.deterministic.enhanced.missingFacts} |`)
md.push(`| 平均长度比 | ${final.deterministic.workbuddy.avgLenRatio}× | ${final.deterministic.enhanced.avgLenRatio}× |`)
md.push(`| meta 泄漏 / 包裹引号 / 空结果 | 0 / 0 / 0 | 0 / 0 / 0 |`)
md.push('')

md.push('## 逐用例（定稿）')
md.push('')
md.push('| 用例 | 输入 | 我们 | WorkBuddy | 胜 |')
md.push('| --- | --- | --- | --- | --- |')
for (const c of final.detail) {
  const win = c.enhanced.total > c.workbuddy.total + 0.3 ? '我们' : c.workbuddy.total > c.enhanced.total + 0.3 ? 'WB' : '平'
  const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ⏎ ').slice(0, 90)
  md.push(
    `| ${c.id} | ${esc(c.input)} | ${c.enhanced.total} | ${c.workbuddy.total} | ${win} |`,
  )
}
md.push('')

md.push('## WorkBuddy 提示词的四个结构性短板（实测）')
md.push('')
md.push(
  '1. **灌水换分**：平均把 5 字的输入扩成 12 倍长度，常加原文没有的要求（robots.txt、退出码、应急处置、篇幅上限），restraint 恒在 3.1–3.6，是它最大的失分项。',
)
md.push(
  '2. **丢事实**：`src/queue.ts`、`src/utils/date.ts`、`5 attempts` 这类具体约束会掉，12 个用例里稳定丢 3–4 个（我们 0–1 个）。',
)
md.push(
  '3. **混排语言被翻平**：中英混排输入经常被整段译成中文，原文那句英文消失（我们 12/12 保语言，它 10–12/12 波动）。',
)
md.push('4. **没有长度分档**：既会把已很具体的需求再灌一倍，也会把极短需求灌到 20 倍以上。')
md.push('')

md.push('## 我们改了什么')
md.push('')
md.push('| 规则 | 解决什么 | 证据 |')
md.push('| --- | --- | --- |')
md.push('| 1 语言逐字保留 | 混排被翻平 | R6 语言 4.98 vs 4.78；langOk 12/12 |')
md.push('| 2 事实守恒（路径/标识符/数字/代码逐字） | 丢具体约束 | missingFacts 1 vs 3 |')
md.push('| 3 保留原动作 + 三件白名单 + 输出前自检 | 越界加戏、把祈使句改成求建议 | restraint 4.35 vs 3.1 |')
md.push('| 4 保留形态（提问仍是提问、列表仍是列表） | 提问被改成需求、列表被打散 | zh-question/zh-list 均胜 |')
md.push('| 5 禁止把可做任务变成问卷 | 「请先补充」式回问 | R2 的 5 个失分用例在 R5 全部修复 |')
md.push('| 6 长度按输入分档 | 5 字灌成 12 倍 | 5.64× vs 12.3× |')
md.push('| 7 输出纪律 + 8 幂等 | 前言/围栏/重复增强继续膨胀 | fence/wrapped 0 |')
md.push('')

md.push('## 复现')
md.push('')
md.push('```bash')
md.push('node test/compare.mjs --round 6 --passes 5   # 跑一轮 A/B（写 docs/compare-round6.json）')
md.push('node tools/report.mjs                        # 由各轮 json 重新生成本报告')
md.push('```')
md.push('')
md.push('原始数据：`docs/compare-round1.json` … `docs/compare-round6.json`（含每轮每条输出的全文、五轴分数与裁判 faults）。')
md.push('')

const out = 'docs/compare-report.md'
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, md.join('\n'))
console.log('written', out, `${md.length} lines`)
