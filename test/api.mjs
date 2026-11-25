// HTTP 契约测试：直接打宿主里跑着的插件端点，验证 v0.5.0 的安全与错误码约定。
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

// 1. GET /info —— 版本单源，必须等于 package.json；风格/守卫/上下文/自检都要在
{
  const { status, json } = await call('/info', { headers: { ...HEADER } })
  assert.equal(status, 200, 'info 应返回 200')
  assert.equal(json.version, pkg.version, `info.version 应等于 package.json 的 ${pkg.version}，实际 ${json.version}`)
  assert.ok(Array.isArray(json.styles) && json.styles.includes('standard'), 'styles 必须含 standard')
  assert.equal(json.style, 'standard', '默认风格必须是 standard（不是 workbuddy）')
  assert.equal(typeof json.maxRatio, 'number', 'maxRatio 应随当前档位返回')
  assert.ok(json.guards && typeof json.guards === 'object', 'guards 应返回保真/修复/长度三闸状态')
  for (const key of ['fidelity', 'repair', 'length']) {
    assert.equal(typeof json.guards[key], 'boolean', `guards.${key} 应为布尔`)
  }
  assert.ok(json.context && typeof json.context.turns === 'number', 'context 应返回上下文触发器配置')
  assert.ok(json.startupCheck && typeof json.startupCheck === 'object', '静态自检结果应随 info 返回')
  assert.ok(Array.isArray(json.routes) && json.routes.length >= 6, '六条路由都该登记')
  ok(
    'GET /info',
    `v${json.version}, style=${json.style}, guards=${Object.entries(json.guards).filter(([, v]) => v === true).length}/3, ${json.routes.length} 路由`,
  )
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
  const { status, json } = await call('/selftest', { headers: { ...HEADER } })
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
  assert.equal(json.code, 'empty')
  ok('POST /enhance 空输入 → 400 empty')
}

// 5. 超长输入 —— 413 too_large
{
  const { status, json } = await call('/enhance', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...HEADER },
    body: JSON.stringify({ text: 'x'.repeat(300 * 1024) }),
  })
  assert.equal(status, 413, `超大 body 应 413，实际 ${status}`)
  assert.equal(json.code, 'too_long')
  ok('POST /enhance 超大 body → 413 too_long')
}

// 6. 真跑一次 —— 200 + {ok, text, meta}，且第二次应命中缓存（幂等 & 不重复烧额度）
if (WITH_MODEL) {
  const body = {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...HEADER },
    body: JSON.stringify({ text: '帮我写个爬虫' }),
  }
  const first = await call('/enhance', body)
  assert.equal(first.status, 200, `真实增强应 200，实际 ${first.status}: ${first.text.slice(0, 200)}`)
  assert.equal(first.json.ok, true, `ok 应为 true，实际 ${first.text.slice(0, 200)}`)
  assert.ok(typeof first.json.text === 'string' && first.json.text.length > 0)
  assert.ok(!first.json.text.includes('```'), '输出不该带围栏')

  const meta = first.json.meta
  assert.ok(meta && typeof meta === 'object', 'meta 必须随结果返回（前端面板全靠它）')
  assert.equal(meta.mode, 'standard', `默认档应为 standard，实际 ${meta.mode}`)
  assert.equal(typeof meta.chars, 'number')
  assert.ok(meta.anchors && typeof meta.anchors.total === 'number', 'meta.anchors 应回报保真闸统计')
  assert.ok(meta.anchors.kept <= meta.anchors.total, '保留数不该超过总数')
  ok(
    'POST /enhance 真实增强',
    `${meta.ms}ms via ${meta.provider}/${meta.model}, ${meta.chars} 字, ${meta.ratioLabel}, 锚点 ${meta.anchors.kept}/${meta.anchors.total}`,
  )

  const second = await call('/enhance', body)
  assert.equal(second.status, 200)
  assert.equal(second.json.meta?.cached, true, '相同输入第二次必须命中缓存（防止连点重复烧额度）')
  assert.equal(second.json.text, first.json.text)
  ok('POST /enhance 幂等缓存', `${second.json.meta.ms}ms, cached=true`)
} else {
  console.log('skip 真实增强（--no-model）')
}

console.log(`\n${passed} 项通过`)
