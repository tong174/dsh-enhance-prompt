// A/B 质量对比：WorkBuddy 原生 prompt（Jr/Yr） vs 我们优化后的 prompt（ENHANCED_*）。
//
// WorkBuddy 桌面端的「增强提示词」本质就是一次 runAgent(system=Jr, user=Yr.replace('{input}') )，
// 没有别的加工，所以用同一台模型分别跑两套 prompt，就是在比它俩的提示词质量。
//
// 用法：node test/compare.mjs [--round 3] [--passes 3] [--out docs/compare-round3.json]
//
// 裁判跑多轮（默认 3 轮）并对齐 A/B 位置：每轮按 (用例序号 + 轮次) 奇偶交换两侧，
// 单轮裁判的位置偏好与噪声会被平均掉。
import fs from 'node:fs'
import path from 'node:path'
import {
  WORKBUDDY_SYSTEM,
  WORKBUDDY_USER_TEMPLATE,
  ENHANCED_SYSTEM,
  ENHANCED_USER_TEMPLATE,
  renderUserPrompt,
  sanitizeOutput,
} from '../lib/prompts.js'

const BASE = process.env.ENHANCE_BASE_URL ?? 'http://127.0.0.1:3425/v1'
const MODEL = process.env.ENHANCE_MODEL ?? 'group/deepseek'
const KEY = process.env.ENHANCE_API_KEY ?? 'local'
const CONCURRENCY = Number(process.env.ENHANCE_CONCURRENCY ?? 4)

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? Number(process.argv[i + 1]) : fallback
}
const round = argOf('--round', 1)
const PASSES = Math.max(1, argOf('--passes', 3))

/** 12 个用例：语言 × 清晰度 × 形态 都覆盖到。 */
const CASES = [
  {
    id: 'zh-vague',
    lang: 'zh',
    text: '帮我写个爬虫',
    mustKeep: ['爬虫'],
    note: '极短、极含糊',
  },
  {
    id: 'zh-detail',
    lang: 'zh',
    text: '请把 src/utils/date.ts 里的 formatDate 改成支持时区参数，并为它补三个单元测试。',
    mustKeep: ['src/utils/date.ts', 'formatDate', '三个单元测试'],
    note: '已经很具体，测是否过度膨胀',
  },
  {
    id: 'zh-list',
    lang: 'zh',
    text: '帮我整理一下这个需求：\n1. 登录页支持手机号\n2. 验证码 60 秒重发\n3. 记住登录状态 7 天',
    mustKeep: ['手机号', '60', '7 天'],
    note: '列表结构，测结构保持',
  },
  {
    id: 'zh-code',
    lang: 'zh',
    text: '这段代码为什么会内存泄漏？\n```js\nconst cache = new Map()\nsetInterval(() => cache.set(Date.now(), {}), 1000)\n```',
    mustKeep: ['cache', 'Map', 'setInterval'],
    note: '带代码块，测代码原样保留',
  },
  {
    id: 'zh-question',
    lang: 'zh',
    text: 'React 的 useEffect 和 useLayoutEffect 有什么区别？',
    mustKeep: ['useEffect', 'useLayoutEffect'],
    note: '纯提问，测是否被改成需求/被回答',
  },
  {
    id: 'zh-ops',
    lang: 'zh',
    text: '服务器老是被打，帮我加固',
    mustKeep: ['服务器'],
    note: '运维含糊需求',
  },
  {
    id: 'en-vague',
    lang: 'en',
    text: 'make my site faster',
    mustKeep: ['site'],
    note: '英文极短',
  },
  {
    id: 'en-tech',
    lang: 'en',
    text: 'add caching to the api',
    mustKeep: ['caching', 'api'],
    note: '英文技术短句',
  },
  {
    id: 'en-detail',
    lang: 'en',
    text: 'Rewrite the retry logic in src/queue.ts so that it uses exponential backoff with jitter, max 5 attempts, and logs each failure.',
    mustKeep: ['src/queue.ts', 'exponential backoff', '5 attempts'],
    note: '英文已很具体',
  },
  {
    id: 'mixed',
    lang: 'mixed',
    text: '这段代码有 bug，can you help me fix it?',
    mustKeep: [],
    note: '中英混排，测语言跟随',
  },
  {
    id: 'mixed-tech',
    lang: 'mixed',
    text: '用 rust 重写这个 CLI，but keep the flags the same',
    mustKeep: ['rust', 'CLI', 'flags'],
    note: '混排 + 明确技术约束',
  },
  {
    id: 'zh-writing',
    lang: 'zh',
    text: '帮我写个周报',
    mustKeep: ['周报'],
    note: '写作类，非技术',
  },
]

/** 同一套模型调用，两套 prompt 的唯一差别就是 system/user。 */
async function complete(system, user) {
  const started = Date.now()
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.3,
      max_tokens: 2000,
      stream: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  })
  const raw = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 200)}`)
  const json = JSON.parse(raw)
  const reply = json.choices?.[0]?.message?.content ?? ''
  return {
    text: sanitizeOutput(reply, { stripFence: true, stripQuotes: true }),
    raw: reply,
    ms: Date.now() - started,
    usage: json.usage,
  }
}

const JUDGE_SYSTEM = `You are an impartial evaluator of prompt rewrites.

You get an ORIGINAL user message and two rewrites, A and B. Score each rewrite from 1 to 5 on five axes:

- fidelity: keeps the original intent AND every concrete detail (paths, identifiers, numbers, versions, flags, code, constraints). Dropping or renaming a detail is a serious fault.
- gain: makes the message more specific and actionable than the original (deliverable, scope, constraints, acceptance) without padding.
- language: same language and register as the original. Mixed-language input stays mixed. Any language label or meta commentary about language is a fault.
- restraint: adds no unrelated scope, no invented requirements, no forced technology choices the user did not imply. Answering the request instead of rewriting it is a serious fault. Turning a doable task into a questionnaire of questions back to the user is also a fault.
- usable: the rewrite can be pasted straight into an AI assistant: no preamble, no quotes around it, no code fence, no explanation, no truncation mid-sentence.

Return ONLY JSON, no prose, no fence:
{"A":{"fidelity":n,"gain":n,"language":n,"restraint":n,"usable":n,"faults":["..."]},"B":{...},"winner":"A|B|tie","why":"one short sentence"}`

const JUDGE_USER = (original, a, b) => `ORIGINAL:\n${original}\n\nREWRITE A:\n${a}\n\nREWRITE B:\n${b}`

const AXES = ['fidelity', 'gain', 'language', 'restraint', 'usable']

/** 确定性指标：不依赖裁判模型，能机器复核。 */
const CJK = /[\u4e00-\u9fff]/g
const LATIN = /[A-Za-z]/g
function dominantLang(text) {
  const cjk = (text.match(CJK) ?? []).length
  const latin = (text.match(LATIN) ?? []).length
  if (cjk > 0 && latin > 0 && Math.min(cjk, latin) / Math.max(cjk, latin) > 0.15) return 'mixed'
  return cjk > latin ? 'zh' : 'en'
}

const META_LEAK = /(user input is|input language|response must be|语言一致|输出语言|语言标签|the user wrote in)/i
const FENCE = /```/

function metrics(input, out, mustKeep) {
  const inLang = dominantLang(input)
  const outLang = dominantLang(out)
  return {
    langOk: inLang === outLang,
    inLang,
    outLang,
    metaLeak: META_LEAK.test(out),
    fence: FENCE.test(out),
    wrapped: /^["'“”‘’]|["'“”‘’]$/.test(out.trim()),
    lenRatio: Number((out.length / Math.max(1, input.length)).toFixed(2)),
    kept: mustKeep.filter((k) => out.includes(k)),
    missing: mustKeep.filter((k) => !out.includes(k)),
    empty: out.trim() === '',
  }
}

async function pool(items, limit, worker) {
  const out = new Array(items.length)
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++
        out[index] = await worker(items[index], index)
      }
    }),
  )
  return out
}

const results = []
for (const c of CASES) {
  const [wb, en] = await Promise.all([
    complete(WORKBUDDY_SYSTEM, renderUserPrompt(WORKBUDDY_USER_TEMPLATE, c.text)),
    complete(ENHANCED_SYSTEM, renderUserPrompt(ENHANCED_USER_TEMPLATE, c.text)),
  ])
  results.push({ case: c, wb, en })
}

const judged = await pool(results, CONCURRENCY, async (r, index) => {
  const passes = []
  for (let p = 0; p < PASSES; p++) {
    const flip = (index + p) % 2 === 1
    const a = flip ? r.en.text : r.wb.text
    const b = flip ? r.wb.text : r.en.text
    try {
      const { raw } = await complete(JUDGE_SYSTEM, JUDGE_USER(r.case.text, a, b))
      const json = JSON.parse(
        raw
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/```\s*$/, '')
          .trim(),
      )
      passes.push({ flip, verdict: json })
    } catch (error) {
      passes.push({ flip, error: String(error.message ?? error) })
    }
  }

  const score = (side) => {
    const per = { fidelity: 0, gain: 0, language: 0, restraint: 0, usable: 0, n: 0 }
    for (const p of passes) {
      const v = p.verdict
      if (!v) continue
      const label = side === 'wb' ? (p.flip ? 'B' : 'A') : p.flip ? 'A' : 'B'
      const s = v[label]
      if (!s) continue
      for (const axis of AXES) per[axis] += Number(s[axis] ?? 0)
      per.n++
    }
    if (per.n > 0) for (const axis of AXES) per[axis] = Number((per[axis] / per.n).toFixed(2))
    return per
  }

  const wbScore = score('wb')
  const enScore = score('en')
  return { ...r, passes, wbScore, enScore }
})

const summary = { workbuddy: {}, enhanced: {}, total: { workbuddy: 0, enhanced: 0 }, wins: { workbuddy: 0, enhanced: 0, tie: 0 } }
for (const axis of AXES) {
  summary.workbuddy[axis] = 0
  summary.enhanced[axis] = 0
}
let scored = 0
for (const r of judged) {
  r.wbMetrics = metrics(r.case.text, r.wb.text, r.case.mustKeep ?? [])
  r.enMetrics = metrics(r.case.text, r.en.text, r.case.mustKeep ?? [])
  if (r.wbScore.n === 0) continue
  scored++
  for (const axis of AXES) {
    summary.workbuddy[axis] += r.wbScore[axis]
    summary.enhanced[axis] += r.enScore[axis]
  }
  const wbTotal = AXES.reduce((n, a) => n + r.wbScore[a], 0)
  const enTotal = AXES.reduce((n, a) => n + r.enScore[a], 0)
  r.wbTotal = Number(wbTotal.toFixed(2))
  r.enTotal = Number(enTotal.toFixed(2))
  summary.total.workbuddy += wbTotal
  summary.total.enhanced += enTotal
  if (Math.abs(wbTotal - enTotal) < 0.3) summary.wins.tie++
  else if (enTotal > wbTotal) summary.wins.enhanced++
  else summary.wins.workbuddy++
}
for (const axis of AXES) {
  summary.workbuddy[axis] = scored ? Number((summary.workbuddy[axis] / scored).toFixed(2)) : 0
  summary.enhanced[axis] = scored ? Number((summary.enhanced[axis] / scored).toFixed(2)) : 0
}
summary.total.workbuddy = scored ? Number((summary.total.workbuddy / scored).toFixed(2)) : 0
summary.total.enhanced = scored ? Number((summary.total.enhanced / scored).toFixed(2)) : 0

const det = {}
for (const [name, key] of [
  ['workbuddy', 'wbMetrics'],
  ['enhanced', 'enMetrics'],
]) {
  const rows = judged.map((r) => r[key])
  det[name] = {
    langOk: rows.filter((m) => m.langOk).length,
    metaLeak: rows.filter((m) => m.metaLeak).length,
    fence: rows.filter((m) => m.fence).length,
    wrapped: rows.filter((m) => m.wrapped).length,
    empty: rows.filter((m) => m.empty).length,
    missingFacts: rows.reduce((n, m) => n + m.missing.length, 0),
    avgLenRatio: Number((rows.reduce((n, m) => n + m.lenRatio, 0) / Math.max(1, rows.length)).toFixed(2)),
  }
}

const outPath = process.env.ENHANCE_COMPARE_OUT ?? `docs/compare-round${round}.json`
const payload = {
  generatedAt: new Date().toISOString(),
  model: MODEL,
  round,
  passes: PASSES,
  cases: judged.length,
  scored,
  summary,
  deterministic: det,
  detail: judged.map((r) => ({
    id: r.case.id,
    note: r.case.note,
    input: r.case.text,
    workbuddy: { text: r.wb.text, ms: r.wb.ms, metrics: r.wbMetrics, score: r.wbScore, total: r.wbTotal },
    enhanced: { text: r.en.text, ms: r.en.ms, metrics: r.enMetrics, score: r.enScore, total: r.enTotal },
    passes: r.passes,
  })),
}
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n')

console.log(`model=${MODEL} cases=${judged.length} scored=${scored} passes=${PASSES}`)
console.log('judge averages (1-5, averaged over passes):')
for (const axis of AXES) {
  console.log(`  ${axis.padEnd(10)} workbuddy ${summary.workbuddy[axis]}  enhanced ${summary.enhanced[axis]}`)
}
console.log(`  ${'TOTAL'.padEnd(10)} workbuddy ${summary.total.workbuddy}  enhanced ${summary.total.enhanced}`)
console.log('case wins:', summary.wins)
console.log('deterministic:', JSON.stringify(det))
console.log('written:', outPath)
