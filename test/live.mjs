// 现场验证：用插件里的 WorkBuddy prompt 直接打本机 magpie 网关，看增强效果与清洗逻辑。
// 用法：node test/live.mjs [provider/model]
import { WORKBUDDY_SYSTEM, WORKBUDDY_USER_TEMPLATE, renderUserPrompt, sanitizeOutput } from '../lib/prompts.js'

const BASE = process.env.ENHANCE_BASE_URL ?? 'http://127.0.0.1:3425/v1'
const MODEL = process.argv[2] ?? process.env.ENHANCE_MODEL ?? 'group/deepseek-v4.1'
const KEY = process.env.ENHANCE_API_KEY ?? 'local'

const samples = [
  ['zh', '帮我写个爬虫'],
  ['en', 'make my site faster'],
  ['mixed', '这段代码有 bug，can you help me fix it?'],
  ['already-clear', '请把 src/utils/date.ts 里的 formatDate 改成支持时区参数，并为它补三个单元测试。'],
]

async function complete(text) {
  const body = {
    model: MODEL,
    temperature: 0.3,
    max_tokens: 1200,
    stream: false,
    messages: [
      { role: 'system', content: WORKBUDDY_SYSTEM },
      { role: 'user', content: renderUserPrompt(WORKBUDDY_USER_TEMPLATE, text) },
    ],
  }
  const started = Date.now()
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  })
  const raw = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 300)}`)
  const json = JSON.parse(raw)
  const reply = json.choices?.[0]?.message?.content ?? ''
  return { reply, ms: Date.now() - started, usage: json.usage }
}

for (const [tag, text] of samples) {
  try {
    const { reply, ms, usage } = await complete(text)
    const cleaned = sanitizeOutput(reply, { stripFence: true, stripQuotes: true })
    console.log(`\n===== ${tag} (${ms}ms, in ${usage?.prompt_tokens} / out ${usage?.completion_tokens}) =====`)
    console.log('IN :', text)
    console.log('RAW:', JSON.stringify(reply.slice(0, 400)))
    console.log('OUT:', cleaned)
    if (cleaned === '') console.log('!! 空结果')
    if (/^["'“”‘’]|["'“”‘’]$/.test(reply.trim())) console.log('!! 原样带引号（说明清洗生效前有包裹）')
  } catch (error) {
    console.log(`\n===== ${tag} FAILED =====`)
    console.log(String(error.message ?? error))
  }
}
