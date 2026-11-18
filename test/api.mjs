// HTTP 契约测试：直接打宿主里跑着的插件端点，验证 v0.4.0 的安全与错误码约定。
// 用法：node test/api.mjs [base]
//   默认 base = http://127.0.0.1:12578
// 只做「不花钱」的检查 + 一次真实增强（可用 --no-model 跳过）。
import assert from 'node:assert/strict'
import fs from 'node:fs'

const BASE = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'http://127.0.0.1:12578'
const PREFIX = `${BASE}/dsh-enhance-prompt`
const WITH_MODEL = !process.argv.includes('--no-model')
const HEADER = { 'x-dsh-enhance': '1' }

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

let passed = 0
const ok = (name, detail) => {
  passed += 1
  console.log(`ok  ${name}${detail ? ` (${detail})` : ''}`)
}

async function call(path, init = {}) {
  const res = await fetch(`${PREFIX}${path}`, init)
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, json, text }
}

console.log(`base: ${BASE}\n`)

// 1. GET /info —— 版本单源，必须等于 package.json
{
  const { status, json } = await call('/info')
  assert.equal(status, 200, 'info 应返回 200')
  assert.equal(json.version, pkg.version, `info.version 应等于 package.json 的 ${pkg.version}，实际 ${json.version}`)
  assert.ok(Array.isArray(json.promptStyles) && json.promptStyles.includes('enhanced'))
  assert.equal(json.promptStyle, 'enhanced', '默认风格必须是 enhanced')
  assert.ok(json.limits && typeof json.limits.maxTokens === 'number')
  assert.ok(json.startup && typeof json.startup === 'object', '静态自检结果应随 info 返回')
  ok('GET /info', `v${json.version}, startup=${Object.entries(json.startup).filter(([, v]) => v === true).length} 项通过`)
}

// 2. 缺 x-dsh-enhance 头 —— 必须 403（挡跨站请求）
{
  const { status, json } = await call('/enhance', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '帮我写个爬虫' }),
  })
  assert.equal(status, 403, `缺头的请求应 403，实际 ${status}`)
  assert.equal(json.code, 'forbidden')
  ok('POST /enhance 缺头 → 403')
}

// 3. 错方法 —— 必须 405（selftest 曾经是 GET，会白烧一次模型调用）
{
  const { status, json } = await call('/selftest')
  assert.equal(status, 405, `GET /selftest 应 405，实际 ${status}`)
  assert.equal(json.code, 'method_not_allowed')
  ok('GET /selftest → 405')
}

// 4. 空输入 —— 400 empty_input，且不该触到模型
{
  const { status, json } = await call('/enhance', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...HEADER },
    body: JSON.stringify({ text: '   ' }),
  })
  assert.equal(status, 400, `空输入应 400，实际 ${status}`)
  assert.equal(json.code, 'empty_input')
  ok('POST /enhance 空输入 → 400 empty_input')
}

// 5. 超长输入 —— 413 too_large
{
  const { status, json } = await call('/enhance', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...HEADER },
    body: JSON.stringify({ text: 'x'.repeat(300 * 1024) }),
  })
  assert.equal(status, 413, `超大 body 应 413，实际 ${status}`)
  assert.equal(json.code, 'too_large')
  ok('POST /enhance 超大 body → 413 too_large')
}

// 6. 真跑一次 —— 200 + text，且第二次应命中缓存（幂等 & 不重复烧额度）
if (WITH_MODEL) {
  const body = {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...HEADER },
    body: JSON.stringify({ text: '帮我写个爬虫' }),
  }
  const first = await call('/enhance', body)
  assert.equal(first.status, 200, `真实增强应 200，实际 ${first.status}: ${first.text.slice(0, 200)}`)
  assert.equal(first.json.success, true)
  assert.ok(typeof first.json.text === 'string' && first.json.text.length > 0)
  assert.ok(!first.json.text.includes('```'), '输出不该带围栏')
  ok('POST /enhance 真实增强', `${first.json.ms}ms via ${first.json.provider}/${first.json.model}, ${first.json.text.length} 字`)

  const second = await call('/enhance', body)
  assert.equal(second.status, 200)
  assert.equal(second.json.cached, true, '相同输入第二次必须命中缓存（防止连点重复烧额度）')
  assert.equal(second.json.text, first.json.text)
  ok('POST /enhance 幂等缓存', `${second.json.ms}ms, cached=true`)
} else {
  console.log('skip 真实增强（--no-model）')
}

console.log(`\n${passed} 项通过`)
