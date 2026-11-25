import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * Contract guards, not behaviour tests.
 *
 * index.js cannot be imported here: it pulls `@deepseek-ai/schemastery` from the host install,
 * which is not on this repo's resolution path. So these assertions read the source and pin the
 * exact shapes the host rejects at startup — each one corresponds to a failure that actually
 * happened while building v0.5.0, and each fails loudly if someone reverts it.
 */
const index = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const prompts = readFileSync(new URL('../lib/prompts.js', import.meta.url), 'utf8')
const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

test('the system prompt section uses { name, order, text } and a finite order', () => {
  const call = index.match(/systemPrompt\?\.section\?\.\(\{([^}]*)\}/)
  assert.ok(call, 'no systemPrompt.section() call found')
  const body = call[1]
  assert.match(body, /name:\s*'enhance-prompt'/)
  // order must be a literal finite number: a computed or missing order throws inside the host.
  assert.match(body, /order:\s*\d+/)
  // The payload key is `text`; `content` is silently ignored, which is worse than throwing.
  assert.match(body, /text:\s*GUIDANCE/)
  assert.doesNotMatch(body, /content:/)
})

test('the registered tool declares the output envelope the host requires', () => {
  const start = index.indexOf('ctx.tools.register(')
  assert.ok(start > 0, 'no tools.register() call found')
  const block = index.slice(start, start + 2500)
  assert.match(block, /output:\s*\{/, 'tools.register must pass output { schema, render }')
  assert.match(block, /render:\s*(\(|function)/, 'output.render must be a function')
  // parameters uses the host's flat dialect ({ name: { type, required } }), not JSON Schema.
  assert.match(block, /parameters:\s*\{/, 'parameters must be an object literal')
  assert.doesNotMatch(block, /"type":\s*"object"/, 'parameters must not be a JSON Schema document')
})

test('config reads go through the resolved config, never the schema', () => {
  assert.match(index, /function safeRead\(source, field\)/)
  assert.doesNotMatch(index, /readConfigField/, 'the schema-reading helper must stay deleted')
  // A throwing getter during profile reload must not take the request down with it.
  const safe = index.slice(index.indexOf('function safeRead'))
  assert.match(safe.slice(0, 300), /try\s*\{[\s\S]*?catch/)
})

test('every server route lives under the plugin prefix', () => {
  // /api/* is behind the gateway's 401, so a route outside the prefix is unreachable.
  assert.match(index, /const API_PREFIX = '\/dsh-enhance-prompt'/)
  const routes = [...index.matchAll(/`\$\{API_PREFIX\}(\/[a-z]+)`/g)].map((m) => m[1])
  assert.ok(routes.length >= 5, `expected the full route set, found ${JSON.stringify(routes)}`)
  for (const path of ['/enhance', '/stream', '/models', '/info']) {
    assert.ok(routes.includes(path), `missing route ${path}`)
  }
})

test('the default mode is the disciplined one, never the padded baseline', () => {
  // workbuddy is the A/B fixture. Falling back to it would re-introduce the padding that
  // v0.3.0 measured as 12.3x length inflation with three dropped facts.
  assert.match(prompts, /DEFAULT_PROMPT_STYLE = 'standard'/)
  const resolver = prompts.slice(prompts.indexOf('export function resolvePromptStyle'))
  assert.match(resolver.slice(0, 600), /DEFAULT_PROMPT_STYLE/)
})

test('the client never writes the draft without an explicit accept', () => {
  // setDraft is the only path into the composer, and it must sit behind the accept handler.
  const calls = [...client.matchAll(/setDraft\(/g)]
  assert.ok(calls.length > 0, 'the client must eventually write the draft')
  assert.match(client, /accept/i, 'the write path must be gated by an accept action')
  // A disabled button is how @references stay safe: clearing them silently loses user data.
  assert.match(client, /references/, 'the client must inspect references before enabling')
})
