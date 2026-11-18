// 纯逻辑回归：prompt 资产 + 模板替换 + 输出清洗 + 风格解析。node test/unit.mjs
// 只依赖 lib/prompts.js（不碰 DSH 运行时），所以可以在任何地方跑。
import assert from 'node:assert/strict'
import {
  WORKBUDDY_SYSTEM,
  WORKBUDDY_USER_TEMPLATE,
  ENHANCED_SYSTEM,
  ENHANCED_USER_TEMPLATE,
  SYSTEM_STYLE_SYSTEM,
  PROMPT_STYLES,
  DEFAULT_PROMPT_STYLE,
  resolvePromptStyle,
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

check('我们的 enhanced 资产完整且默认风格指向它', () => {
  assert.ok(ENHANCED_SYSTEM.length > 2000, 'enhanced system 太短')
  assert.ok(ENHANCED_USER_TEMPLATE.includes('{input}'))
  assert.equal(DEFAULT_PROMPT_STYLE, 'enhanced')
  assert.deepEqual(PROMPT_STYLES, ['enhanced', 'workbuddy', 'system'])
})

check('enhanced system 里没有「让运维请求变成问卷」的自相矛盾示例', () => {
  // v0.3.0 的 zh-ops 示例写的是「请先补充操作系统、对外暴露的服务与端口…」，
  // 与规则 5 直接冲突，是 A/B 里 zh-ops 唯一败例的根因。必须消失。
  assert.ok(!/请先补充操作系统/.test(ENHANCED_SYSTEM), '旧的反例又回来了')
  assert.ok(/NEVER TURN A DOABLE TASK INTO A QUESTIONNAIRE/.test(ENHANCED_SYSTEM))
  assert.ok(/never ask which operating system/i.test(ENHANCED_SYSTEM))
})

check('renderUserPrompt 只替换占位符、不丢原文', () => {
  const out = renderUserPrompt(WORKBUDDY_USER_TEMPLATE, '帮我写个爬虫')
  assert.ok(out.includes('帮我写个爬虫'))
  assert.ok(!out.includes('{input}'))
  const expected = WORKBUDDY_USER_TEMPLATE.split('{input}').join('帮我写个爬虫')
  assert.equal(out, expected)
})

check('renderUserPrompt 保留 $ 之类特殊字符', () => {
  const text = 'cost is $1 and \\n should stay literal'
  assert.ok(renderUserPrompt(WORKBUDDY_USER_TEMPLATE, text).includes(text))
})

check('renderUserPrompt 对空模板/空输入不炸', () => {
  assert.equal(renderUserPrompt(undefined, ''), WORKBUDDY_USER_TEMPLATE.split('{input}').join(''))
  assert.equal(renderUserPrompt('x{input}y', null), 'xy')
})

check('stripWrappingQuotes 去皮中英文引号', () => {
  assert.equal(stripWrappingQuotes('"hello"'), 'hello')
  assert.equal(stripWrappingQuotes('“你好”'), '你好')
  assert.equal(stripWrappingQuotes("'quoted'"), 'quoted')
  assert.equal(stripWrappingQuotes('no quotes'), 'no quotes')
  assert.equal(stripWrappingQuotes('"a "b" c"'), 'a "b" c')
  // 不配对时不能把单边引号当包裹剥掉
  assert.equal(stripWrappingQuotes('"only left'), '"only left')
})

check('stripCodeFence 去 ``` 围栏', () => {
  assert.equal(stripCodeFence('```\nhello\n```'), 'hello')
  assert.equal(stripCodeFence('```text\nhello\n```'), 'hello')
  assert.equal(stripCodeFence('plain'), 'plain')
  // 正文里夹着围栏时不许动（只剥「整段就是围栏」）
  assert.equal(stripCodeFence('see:\n```\nx\n```\ndone'), 'see:\n```\nx\n```\ndone')
})

check('sanitizeOutput 组合清洗并 trim', () => {
  const raw = '"```\n请修改 formatDate\n```"'
  assert.equal(sanitizeOutput(raw, {}), '请修改 formatDate')
})

check('sanitizeOutput 可单独关闭清洗', () => {
  const raw = '```\nx\n```'
  assert.equal(sanitizeOutput(raw, { stripFence: false }), '```\nx\n```')
})

check('sanitizeOutput 是幂等的（跑两趟结果一样）', () => {
  const raw = '"````text\n请修改 formatDate\n````"'
  const once = sanitizeOutput(raw, {})
  assert.equal(sanitizeOutput(once, {}), once)
})

check('sanitizeOutput 对空值返回空串而不是 "undefined"', () => {
  assert.equal(sanitizeOutput(undefined, {}), '')
  assert.equal(sanitizeOutput(null, {}), '')
  assert.equal(sanitizeOutput('   ', {}), '')
})

check('resolvePromptStyle 认识三种风格、未知值回退默认', () => {
  assert.deepEqual(resolvePromptStyle('enhanced'), { style: 'enhanced', fallback: false })
  assert.deepEqual(resolvePromptStyle('workbuddy'), { style: 'workbuddy', fallback: false })
  assert.deepEqual(resolvePromptStyle('system'), { style: 'system', fallback: false })
  // 空值 = 没配，不算 fallback
  assert.deepEqual(resolvePromptStyle(''), { style: DEFAULT_PROMPT_STYLE, fallback: false })
  assert.deepEqual(resolvePromptStyle(undefined), { style: DEFAULT_PROMPT_STYLE, fallback: false })
  // 写错了 = fallback，要能被上层记日志抓到
  assert.deepEqual(resolvePromptStyle('workbudd'), { style: DEFAULT_PROMPT_STYLE, fallback: true })
  assert.deepEqual(resolvePromptStyle(42), { style: DEFAULT_PROMPT_STYLE, fallback: true })
})

check('resolvePromptStyle 大小写与空白容错', () => {
  assert.equal(resolvePromptStyle(' Enhanced ').style, 'enhanced')
  assert.equal(resolvePromptStyle('WORKBUDDY').style, 'workbuddy')
})

console.log(`\n${passed} 项通过`)
