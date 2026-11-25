import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DISCIPLINE,
  MODES,
  PROMPT_STYLES,
  DEFAULT_PROMPT_STYLE,
  resolvePromptStyle,
  renderUserPrompt,
  stripWrappingQuotes,
  stripCodeFence,
  sanitizeOutput,
} from '../lib/prompts.js'

test('every user-facing mode is registered exactly once', () => {
  assert.equal(DEFAULT_PROMPT_STYLE, 'standard')
  assert.deepEqual([...PROMPT_STYLES], ['standard', 'light', 'deep', 'system', 'workbuddy'])
  for (const id of PROMPT_STYLES) {
    assert.ok(MODES[id], `MODES is missing ${id}`)
    assert.equal(MODES[id].id, id)
  }
})

test('the length ladder is ordered light < standard < deep, and the reference sets are unbounded', () => {
  assert.ok(MODES.light.maxRatio < MODES.standard.maxRatio)
  assert.ok(MODES.standard.maxRatio < MODES.deep.maxRatio)
  assert.equal(MODES.system.maxRatio, null)
  assert.equal(MODES.workbuddy.maxRatio, null)
})

test('every mode carries a substantial system prompt and a usable user template', () => {
  for (const id of PROMPT_STYLES) {
    const mode = MODES[id]
    assert.ok(mode.system.length > 400, `${id} system prompt is too thin to do anything`)
    assert.ok(
      mode.userTemplate.includes('{draft}') || mode.userTemplate.includes('{input}'),
      `${id} user template has no placeholder`,
    )
    assert.ok(mode.label && mode.labelEn && mode.description, `${id} is missing display metadata`)
  }
})

test('the discipline block is shared, not duplicated per mode', () => {
  assert.ok(DISCIPLINE.length > 200)
  for (const id of ['light', 'standard', 'deep', 'system']) {
    assert.ok(MODES[id].system.includes(DISCIPLINE), `${id} does not carry the shared discipline block`)
  }
})

test('resolvePromptStyle maps legacy ids and never falls back to the padded baseline', () => {
  assert.equal(resolvePromptStyle('enhanced').id, 'standard')
  assert.equal(resolvePromptStyle('  ENHANCED  ').id, 'standard')
  assert.equal(resolvePromptStyle('polish').id, 'light')
  assert.equal(resolvePromptStyle('brief').id, 'deep')
  assert.equal(resolvePromptStyle('workbuddy').id, 'workbuddy')
  assert.equal(resolvePromptStyle('does-not-exist').id, 'standard')
  assert.equal(resolvePromptStyle(undefined).id, 'standard')
  assert.equal(resolvePromptStyle(null).id, 'standard')
  assert.equal(resolvePromptStyle(42).id, 'standard')
})

test('renderUserPrompt substitutes the fenced draft into both placeholder spellings', () => {
  assert.equal(renderUserPrompt('A{draft}B', 'X'), 'AXB')
  assert.equal(renderUserPrompt('A{input}B', 'X'), 'AXB')
  assert.equal(renderUserPrompt('no placeholder', 'X'), 'no placeholder')
})

test('stripWrappingQuotes only unwraps a symmetric pair', () => {
  assert.equal(stripWrappingQuotes('"hello"'), 'hello')
  assert.equal(stripWrappingQuotes('「你好」'), '你好')
  assert.equal(stripWrappingQuotes('《标题》'), '标题')
  // One-sided quotes are content, not wrapping: the pre-0.4.0 regex ate them.
  assert.equal(stripWrappingQuotes('"only left'), '"only left')
  assert.equal(stripWrappingQuotes('only right"'), 'only right"')
  // A pair that wraps two quoted fragments is not a wrapper.
  assert.equal(stripWrappingQuotes('"a" and "b"'), '"a" and "b"')
  assert.equal(stripWrappingQuotes(''), '')
  assert.equal(stripWrappingQuotes('"'), '"')
})

test('stripCodeFence removes one fence layer and keeps inner backticks', () => {
  assert.equal(stripCodeFence('```\nplain\n```'), 'plain')
  assert.equal(stripCodeFence('```js\nconst a = 1\n```'), 'const a = 1')
  assert.equal(stripCodeFence('```\nhas `inline` tick\n```'), 'has `inline` tick')
  assert.equal(stripCodeFence('not fenced'), 'not fenced')
  assert.equal(stripCodeFence('```\nunclosed'), '```\nunclosed')
})

test('sanitizeOutput composes fence and quote stripping and can be told not to', () => {
  assert.equal(sanitizeOutput('  ```\n"hello"\n```  '), 'hello')
  assert.equal(sanitizeOutput('"hello"', { stripQuotes: false }), '"hello"')
  assert.equal(sanitizeOutput('```\nhello\n```', { stripFence: false }), '```\nhello\n```')
  assert.equal(sanitizeOutput(''), '')
  assert.equal(sanitizeOutput(null), '')
  assert.equal(sanitizeOutput(undefined), '')
})
