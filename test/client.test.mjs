import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * The client is a browser IIFE, not an ES module: it reads `window.__ModuleLoader__` at load
 * time and hands the host a factory. To test its pure helpers we load the real source with
 * stubbed globals and pull `__internals` out of the exports the factory produces. That keeps
 * the assertions on shipped code instead of a copy of it.
 */
const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

function loadClient({ language = 'zh-CN', storage = null } = {}) {
  const captured = []
  const window = {
    __ModuleLoader__: {
      load(spec) {
        captured.push(spec)
      },
    },
  }
  const document = {
    currentScript: null,
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: () => ({ setAttribute() {}, appendChild() {}, style: {} }),
    head: { appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
  }
  const localStorage = storage || {
    _map: new Map(),
    getItem(k) {
      return this._map.has(k) ? this._map.get(k) : null
    },
    setItem(k, v) {
      this._map.set(k, String(v))
    },
    removeItem(k) {
      this._map.delete(k)
    },
  }
  const React = {
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    createElement: () => null,
  }

  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'document', 'navigator', 'localStorage', 'fetch', 'location', SOURCE)
  run(window, document, { language }, localStorage, async () => ({ ok: false }), { href: 'http://localhost/' })

  assert.equal(captured.length, 1, 'the client must register exactly one module with the loader')
  const spec = captured[0]
  const exports = spec.factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected require: ${id}`)
  })
  return { spec, exports, storage: localStorage }
}

test('the client registers itself under its package name', () => {
  const { spec } = loadClient()
  assert.equal(spec.id, 'dsh-enhance-prompt')
  assert.equal(typeof spec.factory, 'function')
})

test('tokenize splits whitespace, CJK characters, words and punctuation', () => {
  const { exports } = loadClient()
  const { tokenize } = exports.__internals
  assert.deepEqual(tokenize('ab cd'), ['ab', ' ', 'cd'])
  // Each CJK character is its own token so a one-character edit stays a one-character diff.
  assert.deepEqual(tokenize('你好'), ['你', '好'])
  assert.deepEqual(tokenize('a, b'), ['a', ',', ' ', 'b'])
  assert.deepEqual(tokenize(''), [])
  assert.deepEqual(tokenize(null), [])
  assert.deepEqual(tokenize(undefined), [])
})

test('diffTokens keeps the two reconstruction invariants', () => {
  const { exports } = loadClient()
  const { diffTokens } = exports.__internals

  const cases = [
    ['', ''],
    ['', 'hello world'],
    ['hello world', ''],
    ['abc', 'abc'],
    ['把缓存失效策略改简洁', '把缓存失效策略改得更简洁一些'],
    ['run npm test now', 'run npm run test now'],
    ['aaa bbb ccc', 'xxx bbb yyy'],
  ]
  for (const [before, after] of cases) {
    const ops = diffTokens(before, after)
    const rebuiltAfter = ops.filter((o) => o.op !== 'del').map((o) => o.text).join('')
    const rebuiltBefore = ops.filter((o) => o.op !== 'add').map((o) => o.text).join('')
    assert.equal(rebuiltAfter, after, `keep+add must rebuild the rewrite for ${JSON.stringify(before)}`)
    assert.equal(rebuiltBefore, before, `keep+del must rebuild the draft for ${JSON.stringify(before)}`)
  }
})

test('diffTokens marks only the changed span, not the whole draft', () => {
  const { exports } = loadClient()
  const { diffTokens } = exports.__internals
  const ops = diffTokens('hello world', 'hello there')
  const kept = ops.filter((o) => o.op === 'keep').map((o) => o.text).join('')
  assert.ok(kept.includes('hello'), `shared prefix should stay untouched: ${JSON.stringify(ops)}`)
  assert.ok(ops.some((o) => o.op === 'add'))
  assert.ok(ops.some((o) => o.op === 'del'))
})

test('diffTokens merges adjacent operations of the same kind', () => {
  const { exports } = loadClient()
  const { diffTokens } = exports.__internals
  const ops = diffTokens('aaa bbb', 'ccc ddd')
  for (let i = 1; i < ops.length; i += 1) {
    assert.notEqual(ops[i].op, ops[i - 1].op, `adjacent ${ops[i].op} runs were not merged`)
  }
})

test('parseFrame reads event and data, and refuses frames it cannot use', () => {
  const { exports } = loadClient()
  const { parseFrame } = exports.__internals

  assert.deepEqual(parseFrame('event: delta\ndata: {"text":"hi"}'), {
    event: 'delta',
    payload: { text: 'hi' },
  })
  // A frame with no event line is a default "message".
  assert.deepEqual(parseFrame('data: {"ok":true}'), { event: 'message', payload: { ok: true } })
  // Multi-line data is joined before parsing.
  assert.deepEqual(parseFrame('data: {"a":\ndata: 1}'), { event: 'message', payload: { a: 1 } })
  assert.equal(parseFrame('event: ping'), null, 'a frame without data carries nothing')
  assert.equal(parseFrame('data: not json'), null, 'malformed JSON must not throw')
  assert.equal(parseFrame(''), null)
})

test('describe maps transport failures onto the same user-facing copy', () => {
  const { exports } = loadClient({ language: 'zh-CN' })
  const { describe } = exports.__internals

  // Same failure, three spellings: the status code, the code name, and the bare message.
  assert.equal(describe('http_404'), describe('not_loaded'))
  assert.equal(describe('http_405'), describe('not_loaded'))
  assert.equal(describe('http_403'), describe('forbidden'))
  assert.equal(describe('http_429'), describe('rate_limited'))
  assert.ok(describe('empty').length > 0)

  // Unknown transport failures fall back to the server's own message.
  assert.equal(describe('http_500', 'server exploded'), 'server exploded')
  assert.equal(describe(null, 'fallback copy'), 'fallback copy')
  // A very long server message is clipped so the panel cannot be blown out.
  assert.equal(describe('http_500', 'x'.repeat(400)).length, 120)
})

test('loadPrefs falls back to the standard mode when storage is missing or corrupt', () => {
  const { exports } = loadClient()
  const { loadPrefs } = exports.__internals

  assert.deepEqual(loadPrefs(), { mode: 'standard', provider: '', model: '', effort: '' })

  const corrupt = {
    getItem: () => '{not json',
    setItem() {},
  }
  const { exports: second } = loadClient({ storage: corrupt })
  assert.equal(second.__internals.loadPrefs().mode, 'standard')

  const partial = {
    getItem: () => JSON.stringify({ mode: 'deep', model: 42 }),
    setItem() {},
  }
  const { exports: third } = loadClient({ storage: partial })
  const prefs = third.__internals.loadPrefs()
  assert.equal(prefs.mode, 'deep')
  assert.equal(prefs.model, '', 'a non-string model must not leak into the request')
})

test('loadHistory drops unusable entries and caps the stack', () => {
  const { exports, storage } = loadClient()
  const { loadHistory } = exports.__internals

  assert.deepEqual(loadHistory(), [])

  const entries = []
  for (let i = 0; i < 20; i += 1) entries.push({ text: `draft ${i}`, mode: 'standard', at: i })
  entries.push({ text: '', mode: 'standard', at: 1 })
  entries.push({ mode: 'standard', at: 1 })
  entries.push(null)
  storage.setItem('dsh-enhance-prompt:history', JSON.stringify(entries))

  const loaded = loadHistory()
  assert.ok(loaded.length > 0 && loaded.length < 20, `history must be capped, got ${loaded.length}`)
  assert.ok(loaded.every((item) => typeof item.text === 'string' && item.text), 'empty drafts leaked in')
  assert.equal(loaded[0].text, 'draft 0', 'newest-first ordering is preserved as stored')
})
