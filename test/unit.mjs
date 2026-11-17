// 纯逻辑回归：模板替换 + 输出清洗。node test/unit.mjs
import assert from 'node:assert/strict'
import {
  WORKBUDDY_SYSTEM,
  WORKBUDDY_USER_TEMPLATE,
  SYSTEM_STYLE_SYSTEM,
  renderUserPrompt,
  stripWrappingQuotes,
  stripCodeFence,
  sanitizeOutput,
} from '../lib/prompts.js'

let passed = 0
const check = (name, fn) => {
  fn()
  passed += 1
  console.log(`ok  ${name}`)
}

check('WorkBuddy system/user 两份资产都完整', () => {
  assert.ok(WORKBUDDY_SYSTEM.length > 2000, 'system 太短，可能没对上原文')
  assert.ok(WORKBUDDY_USER_TEMPLATE.includes('{input}'), 'user 模板必须含 {input}')
  assert.ok(SYSTEM_STYLE_SYSTEM.length > 100)
})

check('renderUserPrompt 只替换占位符、不丢原文', () => {
  const out = renderUserPrompt(WORKBUDDY_USER_TEMPLATE, '帮我写个爬虫')
  assert.ok(out.includes('帮我写个爬虫'))
  assert.ok(!out.includes('{input}'))
  // 模板里除 {input} 外的正文必须原样保留
  const expected = WORKBUDDY_USER_TEMPLATE.replace('{input}', '帮我写个爬虫')
  assert.equal(out, expected)
})

check('renderUserPrompt 保留 $ 之类特殊字符', () => {
  const text = 'cost is $1 and \\n should stay literal'
  assert.ok(renderUserPrompt(WORKBUDDY_USER_TEMPLATE, text).includes(text))
})

check('stripWrappingQuotes 去皮中英文引号', () => {
  assert.equal(stripWrappingQuotes('"hello"'), 'hello')
  assert.equal(stripWrappingQuotes('“你好”'), '你好')
  assert.equal(stripWrappingQuotes("'quoted'"), 'quoted')
  assert.equal(stripWrappingQuotes('no quotes'), 'no quotes')
  // 只剥一层，不碰内部引号
  assert.equal(stripWrappingQuotes('"a "b" c"'), 'a "b" c')
})

check('stripCodeFence 去 ``` 围栏', () => {
  assert.equal(stripCodeFence('```\nhello\n```'), 'hello')
  assert.equal(stripCodeFence('```text\nhello\n```'), 'hello')
  assert.equal(stripCodeFence('plain'), 'plain')
})

check('sanitizeOutput 组合清洗并 trim', () => {
  const raw = '"```\n请修改 formatDate\n```"'
  assert.equal(sanitizeOutput(raw, {}), '请修改 formatDate')
})

check('sanitizeOutput 可单独关闭清洗', () => {
  const raw = '```\nx\n```'
  assert.equal(sanitizeOutput(raw, { stripFence: false }), '```\nx\n```')
})

console.log(`\n${passed} 项通过`)
