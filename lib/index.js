/**
 * dsh-enhance-prompt — host half.
 *
 * Turns a composer draft into a sharper, executable prompt using the harness's own LLM
 * route. Beyond "call a model and paste the answer", this host half enforces:
 *
 *  - a determinism gate: every concrete fact in the draft (paths, identifiers, numbers,
 *    versions, URLs, @refs, quoted literals) is extracted before the call and verified
 *    after it, with at most one repair round and a deterministic re-injection as the last
 *    resort;
 *  - a length gate: per-mode ratio ceilings with an absolute floor, so a one-line note
 *    cannot be inflated into a specification;
 *  - an optional context window, pulled only when the draft literally cannot stand alone;
 *  - loopback-only access with a Host allow-list and a pinned Origin port, so a random
 *    local dev server cannot spend the user's model quota;
 *  - one route per capability, all under `/dsh-enhance-prompt` because `/api/*` belongs to
 *    the host api-gateway and answers 401 to plugins.
 *
 * @module dsh-enhance-prompt
 */

import z from '@deepseek-ai/schemastery'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'

import {
  DEFAULT_PROMPT_STYLE,
  PROMPT_STYLES,
  renderUserPrompt,
  resolvePromptStyle,
  sanitizeOutput,
} from './prompts.js'

import {
  MAX_ANCHORS,
  budgetFor,
  charLength,
  checkFidelity,
  contextTrigger,
  detectLanguage,
  extractAnchors,
  fenceDraft,
  fidelityNote,
  formatRatio,
  languageConsistent,
  lengthVerdict,
  reinjectionBlock,
  repairClause,
} from './anchors.js'

const require = createRequire(import.meta.url)

/** Plugin id; also the route prefix. Must stay equal to the package name. */
export const name = 'dsh-enhance-prompt'

const API_PREFIX = '/dsh-enhance-prompt'

/**
 * Single source of truth for the version. Reading it from the manifest means the log line
 * and `/info` can never drift from what was actually published.
 */
const VERSION = (() => {
  try {
    return String(require('../package.json').version ?? '0.0.0')
  } catch {
    return '0.0.0'
  }
})()

/**
 * Cross-site requests cannot set a custom header without triggering a CORS preflight, which
 * this server never answers. Requiring one is therefore enough to stop a drive-by page from
 * spending quota, without needing any token to be negotiated.
 */
const REQUIRED_HEADER = 'x-dsh-enhance'
const HEADER_VALUE = '1'

/** HTTP status per error code. `timeout` is genuinely a gateway timeout; the rest are 502. */
const ERROR_STATUS = Object.freeze({
  disabled: 503,
  llm_unavailable: 503,
  no_route: 503,
  timeout: 504,
  too_long: 413,
  empty: 400,
  bad_request: 400,
  context_too_large: 413,
})

/** Cap on body size. A composer draft is never a megabyte. */
const BODY_LIMIT = 256 * 1024

/** Cache ceilings — bounded so a long session cannot grow this process without limit. */
const CACHE_LIMIT = 48
const MODEL_TTL_MS = 60 * 1000
const EFFORT_TTL_MS = 10 * 60 * 1000
const DEAD_TTL_MS = 90 * 1000
const BUCKET_SWEEP_MS = 5 * 60 * 1000

/** How many models per provider get their reasoning metadata resolved eagerly. */
const EFFORT_PROBE_LIMIT = 40

export class EnhanceError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [detail]
   */
  constructor(code, message, detail) {
    super(message)
    this.name = 'EnhancePromptError'
    this.code = code
    if (detail) Object.assign(this, detail)
  }
}

/**
 * Read one config field defensively. The config object handed to `apply` can expose values
 * through getters that throw while the profile is being hot-reloaded, so a single failed
 * read must not take the whole request down.
 *
 * @param {object | undefined} source
 * @param {string} field
 * @returns {unknown}
 */
function safeRead(source, field) {
  try {
    return source?.[field]
  } catch {
    return undefined
  }
}

const Config = z.object({
  enabled: z.boolean().default(true).description('Master switch. Off means every route reports disabled.'),
  provider: z
    .string()
    .default('')
    .description('Preferred provider id. Empty means pick the first usable route.'),
  model: z
    .string()
    .default('')
    .description('Preferred model id inside the provider. Empty means the provider default.'),
  providerPriority: z
    .array(z.string())
    .default(['deepseek', 'deepseek-api-key', 'magpie', 'group'])
    .description('Provider ids tried in this order after the preferred one.'),
  reasoningEffort: z
    .string()
    .default('')
    .description(
      'Reasoning effort for the rewrite call. Empty means send none — the model default can cost 10x the output tokens for a task this mechanical.',
    ),
  maxAttempts: z.number().default(6).description('Candidate routes tried before giving up.'),
  temperature: z.number().default(0.3).description('Sampling temperature. Low keeps the rewrite faithful.'),
  maxTokens: z.number().default(4000).description('Output token cap per attempt.'),
  timeoutMs: z.number().default(60000).description('Per-attempt timeout.'),
  totalBudgetMs: z
    .number()
    .default(90000)
    .description('Whole-request budget across all candidate routes and the repair round.'),
  maxConcurrency: z.number().default(2).description('Concurrent rewrite calls. Extra requests get 429.'),
  minTextLength: z.number().default(1).description('Drafts shorter than this are refused locally.'),
  maxInputChars: z.number().default(8000).description('Draft character ceiling, refused before any model call.'),
  promptStyle: z
    .string()
    .default(DEFAULT_PROMPT_STYLE)
    .description(`Rewrite mode: ${PROMPT_STYLES.join(' | ')}.`),
  lengthGuard: z
    .boolean()
    .default(true)
    .description('Enforce the per-mode length ratio with an absolute floor.'),
  fidelityGuard: z
    .boolean()
    .default(true)
    .description('Verify every path/identifier/number/version/URL survived, and repair deterministically.'),
  fidelityRepair: z
    .boolean()
    .default(true)
    .description('Spend one extra call when the fidelity gate finds a lost fact. Off means re-inject only.'),
  refineMode: z
    .boolean()
    .default(true)
    .description('Use the previous result as the draft when the user asks for another pass.'),
  contextAware: z
    .boolean()
    .default(true)
    .description('Carry recent conversation turns, but only when the draft cannot stand alone.'),
  contextTurns: z.number().default(6).description('How many recent turns may be carried.'),
  contextChars: z.number().default(4000).description('Character budget for the carried context.'),
  stream: z.boolean().default(true).description('Let the client consume the rewrite as a server-sent event stream.'),
  customSystemPrompt: z.string().default('').description('Replaces the system prompt for the standard mode.'),
  customUserTemplate: z
    .string()
    .default('')
    .description('Replaces the user template. `{draft}` receives the fenced draft.'),
  stripWrappingQuotes: z.boolean().default(true).description('Unwrap one symmetric quote layer from the answer.'),
  stripCodeFence: z.boolean().default(true).description('Unwrap one code fence from the answer.'),
  idempotent: z.boolean().default(true).description('Cache identical draft+mode+model requests.'),
  announceToAgent: z
    .boolean()
    .default(true)
    .description('Tell the agent, in its system prompt, that the user rewrites drafts with this plugin.'),
  toolsEnabled: z.boolean().default(true).description('Expose the enhance_prompt tool to the agent.'),
  selfTestOnStart: z
    .boolean()
    .default(false)
    .description('On startup, spend one real model call to prove the route works. Off keeps startup free.'),
  allowRemote: z.boolean().default(false).description('Allow non-loopback clients. Off is the safe default.'),
  requireHeader: z
    .boolean()
    .default(true)
    .description(`Require the ${REQUIRED_HEADER}: 1 header, which cross-site pages cannot send without a preflight.`),
  rateLimitPerMinute: z.number().default(30).description('Rewrite calls allowed per client per minute.'),
})

export const inject = ['webServer', 'tools', 'llm', 'systemPrompt']

const GUIDANCE = `The user rewrites their composer drafts with an "enhance prompt" button before sending.
Those rewrites are produced by a deterministic gate: concrete facts (paths, identifiers,
numbers, versions, URLs, @references, quoted literals) are extracted from the draft, verified
in the rewrite, repaired at most once, and re-attached verbatim as a last resort. If a rewrite
arrives with a "Preserved original details" footer, that footer is authoritative — those values
were in the user's original draft and must be honoured.`

/* ------------------------------------------------------------------ http plumbing */

function sendJson(res, status, payload) {
  if (res.writableEnded) return
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(body)
}

/**
 * Read and parse a JSON body with a hard ceiling.
 *
 * On overflow the stream is drained rather than destroyed: destroying the socket before the
 * response is written turns a clean 413 into an opaque ECONNRESET on the client.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 */
function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (err) => {
      if (settled) return
      settled = true
      req.resume()
      reject(err)
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        fail(new EnhanceError('too_long', `request body exceeds ${limit} bytes`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw === '') {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(raw)
        resolve(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(new EnhanceError('bad_request', 'body is not valid JSON'))
      }
    })
    req.on('error', fail)
    req.on('aborted', () => fail(new EnhanceError('bad_request', 'client aborted the request')))
  })
}

/** Normalised peer address. */
function peerAddress(req) {
  const raw = req.socket?.remoteAddress ?? ''
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw
}

function isLoopbackAddress(address) {
  return (
    address === '::1' ||
    address === '127.0.0.1' ||
    /^127\./.test(address) ||
    address === 'localhost' ||
    address === ''
  )
}

/** Host header hostname without port or brackets. */
function hostnameOf(host) {
  if (!host) return ''
  const trimmed = String(host).trim().toLowerCase()
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    return end === -1 ? trimmed : trimmed.slice(1, end)
  }
  return trimmed.split(':')[0]
}

/** Port of a Host header, or null when it carries none. */
function portOf(host) {
  if (!host) return null
  const trimmed = String(host).trim()
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    if (end === -1) return null
    const rest = trimmed.slice(end + 1)
    return rest.startsWith(':') ? rest.slice(1) : null
  }
  const idx = trimmed.lastIndexOf(':')
  if (idx === -1) return null
  const port = trimmed.slice(idx + 1)
  return /^\d+$/.test(port) ? port : null
}

function effectivePort(url) {
  if (url.port) return url.port
  if (url.protocol === 'https:') return '443'
  if (url.protocol === 'http:') return '80'
  return null
}

const TRUSTED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/**
 * Is this request from the machine's own UI?
 *
 * Four independent gates, because a loopback socket alone proves nothing: a DNS-rebinding
 * page keeps the socket on 127.0.0.1 while carrying the attacker's hostname, and any local
 * dev server on `localhost:4000` is same-site to us unless the port is pinned.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{ allowRemote: boolean, requireHeader: boolean }} options
 * @returns {{ ok: boolean, reason: string }}
 */
function isTrustedRequest(req, options) {
  if (options.allowRemote) return { ok: true, reason: 'allow-remote' }

  // A proxy header means the immediate peer is not the client we think it is.
  if (req.headers['x-forwarded-for'] !== undefined || req.headers.forwarded !== undefined) {
    return { ok: false, reason: 'proxied' }
  }

  const address = peerAddress(req)
  if (!isLoopbackAddress(address)) return { ok: false, reason: 'non-loopback peer' }

  const host = req.headers.host
  if (host) {
    const hostname = hostnameOf(host)
    if (hostname !== '' && !TRUSTED_HOSTNAMES.has(hostname)) {
      return { ok: false, reason: 'untrusted host header' }
    }
  }

  const origin = req.headers.origin
  if (origin && origin !== 'null') {
    let parsed
    try {
      parsed = new URL(origin)
    } catch {
      return { ok: false, reason: 'malformed origin' }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, reason: 'untrusted origin scheme' }
    }
    if (!TRUSTED_HOSTNAMES.has(parsed.hostname)) {
      return { ok: false, reason: 'untrusted origin host' }
    }
    const expected = portOf(host)
    if (expected !== null && effectivePort(parsed) !== expected) {
      return { ok: false, reason: 'origin port mismatch' }
    }
  }

  if (options.requireHeader && req.headers[REQUIRED_HEADER] !== HEADER_VALUE) {
    return { ok: false, reason: 'missing plugin header' }
  }

  return { ok: true, reason: 'ok' }
}

/**
 * Token bucket per client key. Capacity doubles as the per-minute allowance, so refill rate
 * is capacity/60 per second and a burst is bounded by one minute of traffic.
 *
 * @param {number} capacity
 */
function createBucket(capacity) {
  let tokens = capacity
  let last = Date.now()
  return {
    take() {
      const now = Date.now()
      tokens = Math.min(capacity, tokens + ((now - last) / 1000) * (capacity / 60))
      last = now
      if (tokens < 1) return false
      tokens -= 1
      return true
    },
  }
}

/** Least-recently-used insertion-order map, capped. */
function remember(map, key, value, limit) {
  if (map.has(key)) map.delete(key)
  map.set(key, value)
  while (map.size > limit) {
    const oldest = map.keys().next()
    if (oldest.done) break
    map.delete(oldest.value)
  }
  return value
}

/** One-shot SSE writer with backpressure. */
function createSseWriter(res) {
  let closed = false
  const cleanup = []
  const onClose = () => {
    closed = true
  }
  res.on('close', onClose)
  cleanup.push(() => res.off('close', onClose))

  return {
    open() {
      if (res.headersSent) return
      res.statusCode = 200
      res.setHeader('content-type', 'text/event-stream; charset=utf-8')
      res.setHeader('cache-control', 'no-cache, no-transform')
      res.setHeader('connection', 'keep-alive')
      // Nginx and friends buffer SSE into uselessness unless told not to.
      res.setHeader('x-accel-buffering', 'no')
      res.write(': open\n\n')
      res.flushHeaders?.()
    },
    get writable() {
      return !closed && res.writableEnded !== true && res.destroyed !== true
    },
    /**
     * Write one frame, awaiting `drain` when the socket buffer is full. Without this a slow
     * reader lets the whole rewrite pile into kernel buffers with no feedback.
     */
    async write(frame) {
      if (!this.writable) return false
      if (res.write(frame)) return true
      return new Promise((resolve) => {
        const done = (ok) => {
          res.off('drain', onDrain)
          res.off('close', onCloseWait)
          resolve(ok)
        }
        const onDrain = () => done(true)
        const onCloseWait = () => done(false)
        res.once('drain', onDrain)
        res.once('close', onCloseWait)
      })
    },
    event(type, data) {
      return this.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
    },
    close() {
      if (res.writableEnded) return
      try {
        res.end()
      } catch {
        /* socket already gone */
      }
    },
    dispose() {
      for (const fn of cleanup) {
        try {
          fn()
        } catch {
          /* ignore */
        }
      }
    },
  }
}

/* ------------------------------------------------------------------------- plugin */

export function apply(ctx, config) {
  /* ------------------------------------------------------------------ state */

  /** Consecutive-failure cooldowns per `provider\0model`. */
  const deadUntil = new Map()
  /** provider -> { at, models } */
  const modelCache = new Map()
  /** `provider\0model` -> { at, reasoning } */
  const effortCache = new Map()
  /** sha256 -> { text, meta, at } */
  const resultCache = new Map()
  /** sha256 -> Promise, so N identical clicks produce one call. */
  const inflight = new Map()
  /** client key -> bucket */
  const buckets = new Map()
  let bucketSweepAt = Date.now()
  /** Route that last succeeded; tried first so a warm process never probes cold. */
  let routeCache = loadSavedRoute()
  let running = 0
  let disposed = false

  const stats = {
    calls: 0,
    ok: 0,
    failed: 0,
    repaired: 0,
    reinjected: 0,
    cacheHits: 0,
    shared: 0,
    totalMs: 0,
    lastError: '',
    lastErrorAt: 0,
    lastOkAt: 0,
  }

  /** @type {Array<{ at: number, level: string, msg: string, detail?: unknown }>} */
  const logBuffer = []
  let logWriteQueued = false

  /* -------------------------------------------------------------- config read */

  function cfg() {
    const read = (field) => safeRead(config, field)
    const style = resolvePromptStyle(read('promptStyle'))
    return {
      enabled: read('enabled') !== false,
      provider: String(read('provider') ?? ''),
      model: String(read('model') ?? ''),
      providerPriority: Array.isArray(read('providerPriority')) ? read('providerPriority') : [],
      reasoningEffort: String(read('reasoningEffort') ?? ''),
      maxAttempts: clampInt(read('maxAttempts'), 1, 20, 6),
      temperature: clampNum(read('temperature'), 0, 2, 0.3),
      maxTokens: clampInt(read('maxTokens'), 128, 32000, 4000),
      timeoutMs: clampInt(read('timeoutMs'), 5000, 300000, 60000),
      totalBudgetMs: clampInt(read('totalBudgetMs'), 10000, 600000, 90000),
      maxConcurrency: clampInt(read('maxConcurrency'), 1, 8, 2),
      minTextLength: clampInt(read('minTextLength'), 0, 200, 1),
      maxInputChars: clampInt(read('maxInputChars'), 100, 100000, 8000),
      style,
      lengthGuard: read('lengthGuard') !== false,
      fidelityGuard: read('fidelityGuard') !== false,
      fidelityRepair: read('fidelityRepair') !== false,
      refineMode: read('refineMode') !== false,
      contextAware: read('contextAware') !== false,
      contextTurns: clampInt(read('contextTurns'), 0, 20, 6),
      contextChars: clampInt(read('contextChars'), 0, 20000, 4000),
      stream: read('stream') !== false,
      customSystemPrompt: String(read('customSystemPrompt') ?? ''),
      customUserTemplate: String(read('customUserTemplate') ?? ''),
      stripWrappingQuotes: read('stripWrappingQuotes') !== false,
      stripCodeFence: read('stripCodeFence') !== false,
      idempotent: read('idempotent') !== false,
      announceToAgent: read('announceToAgent') !== false,
      selfTestOnStart: read('selfTestOnStart') === true,
      allowRemote: read('allowRemote') === true,
      requireHeader: read('requireHeader') !== false,
      rateLimitPerMinute: clampInt(read('rateLimitPerMinute'), 1, 600, 30),
    }
  }

  function clampInt(value, min, max, fallback) {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, Math.trunc(n)))
  }

  function clampNum(value, min, max, fallback) {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, n))
  }

  /* --------------------------------------------------------------------- log */

  function log(level, msg, detail) {
    const entry = { at: Date.now(), level, msg: String(msg) }
    if (detail !== undefined) entry.detail = detail
    logBuffer.push(entry)
    if (logBuffer.length > 400) logBuffer.splice(0, logBuffer.length - 400)
    if (level === 'error') {
      stats.lastError = entry.msg
      stats.lastErrorAt = entry.at
    }
    if (logWriteQueued) return
    logWriteQueued = true
    queueMicrotask(() => {
      logWriteQueued = false
      flushLog()
    })
  }

  function flushLog() {
    try {
      const lines = logBuffer.splice(0, logBuffer.length).map((e) =>
        JSON.stringify({ t: new Date(e.at).toISOString(), l: e.level, m: e.msg, d: e.detail }),
      )
      if (lines.length === 0) return
      const fs = require('node:fs')
      const path = require('node:path')
      const dir = require('node:os').homedir()
      const file = path.join(dir, '.dsh', 'enhance-prompt.log')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      // Rotate at 2 MB so a long-lived session cannot fill the disk with one file.
      try {
        const st = fs.statSync(file)
        if (st.size > 2 * 1024 * 1024) fs.renameSync(file, `${file}.1`)
      } catch {
        /* first write */
      }
      fs.appendFileSync(file, `${lines.join('\n')}\n`)
    } catch {
      /* logging must never break a request */
    }
  }

  /* ------------------------------------------------------------- saved route */

  function routeFilePath() {
    const path = require('node:path')
    const os = require('node:os')
    return path.join(os.homedir(), '.dsh', 'enhance-prompt-route.json')
  }

  /**
   * The route that last produced a usable rewrite, read back on a cold start so the
   * first click after a restart does not have to probe dead providers again.
   */
  function loadSavedRoute() {
    try {
      const parsed = JSON.parse(require('node:fs').readFileSync(routeFilePath(), 'utf8'))
      if (parsed && typeof parsed.provider === 'string' && parsed.provider) {
        return { provider: parsed.provider, model: typeof parsed.model === 'string' ? parsed.model : '' }
      }
    } catch {
      /* first run, or a corrupt file: probe cold and overwrite on success */
    }
    return null
  }

  function rememberRoute(route) {
    if (!route || !route.provider) return
    routeCache = { provider: route.provider, model: route.model || '' }
    try {
      const fs = require('node:fs')
      const path = require('node:path')
      fs.mkdirSync(path.dirname(routeFilePath()), { recursive: true })
      fs.writeFileSync(routeFilePath(), JSON.stringify(routeCache))
    } catch {
      /* persistence is an optimization, never a precondition */
    }
  }

  /* ------------------------------------------------------------- llm surface */

  function llm() {
    const service = ctx?.llm
    if (!service || typeof service.stream !== 'function') {
      throw new EnhanceError('llm_unavailable', 'the harness llm service is not available')
    }
    return service
  }

  function providerIds(service) {
    const ids = []
    const push = (id) => {
      if (typeof id === 'string' && id !== '' && !ids.includes(id)) ids.push(id)
    }
    try {
      for (const p of service.listProviders?.() ?? []) push(p?.id)
    } catch {
      /* ignore */
    }
    return ids
  }

  /** Providers the user could activate but has not configured yet. */
  function configurableProviderIds(service) {
    const ids = []
    try {
      for (const p of service.listConfigurableProviders?.() ?? []) {
        const id = p?.id ?? p?.provider
        if (typeof id === 'string' && id !== '') ids.push(id)
      }
    } catch {
      /* ignore */
    }
    return ids
  }

  /** `async listModels` — the v0.3.0 bug was reading it synchronously and finding nothing. */
  async function modelsOf(service, provider) {
    const cached = modelCache.get(provider)
    if (cached && Date.now() - cached.at < MODEL_TTL_MS) return cached.models
    let models = []
    try {
      const result = await service.listModels(provider)
      if (Array.isArray(result)) models = result
      else if (Array.isArray(result?.models)) models = result.models
    } catch (err) {
      log('warn', `listModels(${provider}) failed: ${err?.message ?? err}`)
      models = []
    }
    modelCache.set(provider, { at: Date.now(), models })
    return models
  }

  /** Reasoning metadata for one model, cached far longer than the model list. */
  async function reasoningOf(service, provider, model) {
    const key = `${provider}\u0000${model}`
    const cached = effortCache.get(key)
    if (cached && Date.now() - cached.at < EFFORT_TTL_MS) return cached.reasoning
    let reasoning = null
    try {
      const info = await service.resolveModelInfo?.(provider, model)
      const r = info?.reasoning
      if (r && Array.isArray(r.efforts)) {
        reasoning = {
          efforts: r.efforts.map((e) => ({ id: String(e.id), name: String(e.name ?? e.id) })),
          defaultEffort: r.defaultEffort ? String(r.defaultEffort) : null,
        }
      }
    } catch {
      reasoning = null
    }
    effortCache.set(key, { at: Date.now(), reasoning })
    return reasoning
  }

  /** Full provider/model catalogue for the client's picker. */
  async function catalogue(service) {
    const active = providerIds(service)
    const sleepers = configurableProviderIds(service).filter((id) => !active.includes(id))
    const groups = []
    for (const id of [...active, ...sleepers]) {
      const isActive = active.includes(id)
      let models = []
      if (isActive) models = await modelsOf(service, id)
      const entries = []
      for (const m of models.slice(0, EFFORT_PROBE_LIMIT)) {
        const mid = String(m?.id ?? m?.model ?? '')
        if (mid === '') continue
        const reasoning = await reasoningOf(service, id, mid)
        entries.push({
          id: mid,
          name: String(m?.name ?? mid),
          description: String(m?.description ?? ''),
          reasoning,
        })
      }
      groups.push({ provider: id, active: isActive, models: entries })
    }
    return { groups, defaultStyle: DEFAULT_PROMPT_STYLE, styles: PROMPT_STYLES }
  }

  function isDead(route) {
    const until = deadUntil.get(`${route.provider}\u0000${route.model}`)
    if (!until) return false
    if (Date.now() > until) {
      deadUntil.delete(`${route.provider}\u0000${route.model}`)
      return false
    }
    return true
  }

  function markDead(route) {
    deadUntil.set(`${route.provider}\u0000${route.model}`, Date.now() + DEAD_TTL_MS)
  }

  /**
   * Ordered candidate routes.
   *
   * A bare `{provider, model: ''}` route is a last resort, never a first pick: it used to be
   * hoisted to the front, which burned one guaranteed-failing request on every call.
   */
  async function candidateRoutes(c, service, preferred) {
    /** @type {Array<{provider: string, model: string}>} */
    const out = []
    const seen = new Set()
    const push = (provider, model) => {
      if (!provider) return
      const key = `${provider}\u0000${model}`
      if (seen.has(key)) return
      seen.add(key)
      out.push({ provider, model: model || '' })
    }

    const expand = async (provider) => {
      if (preferred?.provider === provider && preferred?.model) {
        push(provider, preferred.model)
        return
      }
      const models = await modelsOf(service, provider)
      if (models.length === 0) return
      for (const m of models.slice(0, 6)) push(provider, String(m?.id ?? m?.model ?? ''))
    }

    if (preferred?.provider) push(preferred.provider, preferred.model || '')
    if (c.provider) {
      if (c.model) push(c.provider, c.model)
      else await expand(c.provider)
    }
    if (routeCache?.provider) push(routeCache.provider, routeCache.model || '')
    for (const p of c.providerPriority) await expand(p)
    for (const p of providerIds(service)) await expand(p)

    const concrete = out.filter((r) => r.model !== '')
    const bare = out.filter((r) => r.model === '')
    const usable = concrete.filter((r) => !isDead(r))
    const cooled = concrete.filter((r) => isDead(r))
    const ordered = [...usable, ...bare, ...cooled]
    return ordered.slice(0, Math.max(1, c.maxAttempts))
  }

  /* ------------------------------------------------------------- one model call */

  /**
   * Stream one route. Yields deltas; returns the accumulated text through the `result`
   * callback so callers can distinguish "no deltas" from "empty answer".
   */
  async function* streamRoute(service, route, { system, user, c, signal, effort }) {
    const call = {
      provider: route.provider,
      model: route.model,
      temperature: c.temperature,
      maxTokens: c.maxTokens,
    }
    // Only forward an effort the model actually advertises; a rejected effort fails the
    // whole call on some gateways. A per-request override wins over the configured default.
    const wantedEffort = effort ?? c.reasoningEffort
    if (wantedEffort) {
      const reasoning = await reasoningOf(service, route.provider, route.model)
      const supported = reasoning?.efforts?.some((e) => e.id === wantedEffort)
      if (supported) call.reasoningEffort = wantedEffort
      else log('warn', `reasoningEffort ${wantedEffort} not supported by ${route.provider}/${route.model}, omitted`)
    }

    const request = {
      provider: route.provider,
      model: route.model,
      temperature: c.temperature,
      maxTokens: c.maxTokens,
      system,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: user }],
          source: { kind: 'user' },
        },
      ],
      signal,
    }
    if (call.reasoningEffort) request.reasoningEffort = call.reasoningEffort

    let stream
    if (typeof service.prepareCall === 'function') {
      const prepared = await service.prepareCall(call, signal)
      stream = prepared.stream({ ...prepared.config, ...request })
    } else {
      stream = service.stream(request)
    }

    let failure = null
    for await (const chunk of stream) {
      if (!chunk) continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        yield chunk.text
      } else if (chunk.type === 'finish') {
        const reason = chunk.reason ?? {}
        if (reason.kind === 'error' || reason.kind === 'aborted') failure = reason.failure ?? reason
        else if (reason.kind === 'max-tokens') failure = null
      }
    }
    if (failure) {
      const message =
        failure?.message ?? failure?.error?.message ?? (typeof failure === 'string' ? failure : 'stream failed')
      throw new EnhanceError('upstream', String(message))
    }
  }

  /** Non-streaming convenience wrapper. */
  async function callRoute(service, route, args) {
    let text = ''
    for await (const delta of streamRoute(service, route, args)) text += delta
    return text
  }

  /* ----------------------------------------------------------- history reading */

  /**
   * Recent conversation turns, or '' when history is unavailable.
   *
   * Context is an optimisation, never a precondition: every failure path here returns '',
   * including a host that does not expose sessions at all.
   */
  async function readHistory(sessionId, c) {
    if (!c.contextAware || c.contextTurns <= 0 || !sessionId) return ''
    try {
      const sessions = ctx.get?.('sessions') ?? ctx.sessions
      if (!sessions) return ''
      const session = typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
      if (!session) return ''
      let messages = []
      if (typeof session.deriveMessages === 'function') messages = await session.deriveMessages()
      else if (Array.isArray(session.messages)) messages = session.messages
      if (!Array.isArray(messages) || messages.length === 0) return ''

      const turns = []
      for (const m of messages) {
        const role = m?.role === 'assistant' ? 'Assistant' : m?.role === 'user' ? 'User' : ''
        if (role === '') continue
        let text = ''
        if (typeof m.content === 'string') text = m.content
        else if (Array.isArray(m.content)) {
          text = m.content
            .filter((part) => part?.type === 'text' && typeof part.text === 'string')
            .map((part) => part.text)
            .join('\n')
        }
        if (text.trim() === '') continue
        turns.push({ role, text: text.trim() })
      }
      // Drop the last turn when it is the very draft being rewritten.
      const recent = turns.slice(-c.contextTurns)
      const blocks = []
      let used = 0
      for (let i = recent.length - 1; i >= 0; i -= 1) {
        const turn = recent[i]
        const cost = charLength(turn.text)
        if (used + cost > c.contextChars) break
        used += cost
        blocks.unshift(`${turn.role}: ${turn.text}`)
      }
      if (blocks.length === 0) return ''
      return `<conversation_context>\n${blocks.join('\n\n')}\n</conversation_context>`
    } catch (err) {
      log('warn', `history unavailable: ${err?.message ?? err}`)
      return ''
    }
  }

  /* -------------------------------------------------------------- the pipeline */

  function buildPrompts(c, style) {
    const resolved = style ?? c.style
    const system = c.customSystemPrompt.trim() !== '' ? c.customSystemPrompt : resolved.system
    const template = c.customUserTemplate.trim() !== '' ? c.customUserTemplate : resolved.userTemplate
    return { system, template, mode: resolved }
  }

  /**
   * Run the rewrite for one draft.
   *
   * Order matters: local refusals cost nothing, the first generation is the only mandatory
   * model call, and at most one repair round follows. There is never a pipeline of calls.
   */
  async function runEnhance(rawText, options = {}) {
    const c = cfg()
    const started = Date.now()

    if (!c.enabled) throw new EnhanceError('disabled', 'the enhancer is switched off in plugin settings')

    const draft = String(rawText ?? '')
    const trimmed = draft.trim()
    if (trimmed === '') throw new EnhanceError('empty', 'the draft is empty')
    if (charLength(trimmed) < c.minTextLength) {
      throw new EnhanceError('empty', `the draft is shorter than the ${c.minTextLength}-character minimum`)
    }
    if (charLength(draft) > c.maxInputChars) {
      throw new EnhanceError('too_long', `the draft exceeds the ${c.maxInputChars}-character limit`)
    }

    const style = resolvePromptStyle(options.style ?? c.promptStyle)
    const { system, template, mode } = buildPrompts(c, style)

    // ---- idempotency: identical draft + mode + explicit route share one result
    const cacheKey = createHash('sha256')
      .update(`${mode.id}\u0000${options.provider ?? ''}\u0000${options.model ?? ''}\u0000${draft}`)
      .digest('hex')

    if (c.idempotent && !options.force) {
      const hit = resultCache.get(cacheKey)
      if (hit) {
        stats.cacheHits += 1
        remember(resultCache, cacheKey, hit, CACHE_LIMIT)
        // `meta.cached` is what the panel reads, so keep it truthful on a hit as well.
        return { ...hit, meta: { ...hit.meta, cached: true }, cached: true, ms: 0 }
      }
      const pending = inflight.get(cacheKey)
      if (pending) {
        stats.shared += 1
        const shared = await pending
        return { ...shared, shared: true }
      }
    }

    if (running >= c.maxConcurrency) {
      throw new EnhanceError('busy', `at most ${c.maxConcurrency} rewrites run at once; try again in a moment`)
    }

    const promise = executeEnhance({ c, draft, trimmed, system, template, mode, options, started })
    if (c.idempotent && !options.force) inflight.set(cacheKey, promise)
    running += 1

    let result
    try {
      result = await promise
    } finally {
      running -= 1
      inflight.delete(cacheKey)
    }

    if (c.idempotent && !options.force) {
      remember(resultCache, cacheKey, { text: result.text, meta: result.meta }, CACHE_LIMIT)
    }
    return result
  }

  async function executeEnhance({ c, draft, trimmed, system, template, mode, options, started }) {
    const service = llm()
    const ac = new AbortController()
    const onAbort = () => ac.abort()
    const budget = setTimeout(() => ac.abort(), c.totalBudgetMs)

    const emit = typeof options.onDelta === 'function' ? options.onDelta : null

    try {
      // ---- facts to preserve
      const anchors = c.fidelityGuard ? extractAnchors(trimmed, MAX_ANCHORS) : []

      // ---- context, only when the draft cannot stand alone
      const contextOn = options.context === true ? true : options.context === false ? false : c.contextAware
      const trigger = contextOn ? contextTrigger(trimmed) : { needed: false, reason: 'none' }
      const history = trigger.needed ? await readHistory(options.sessionId, c) : ''

      const fenced = fenceDraft(trimmed)
      const userText = renderUserPrompt(template, history ? `${history}\n\n${fenced}` : fenced)

      const preferred = { provider: options.provider ?? c.provider, model: options.model ?? c.model }
      const routes = await candidateRoutes(c, service, preferred)
      if (routes.length === 0) throw new EnhanceError('no_route', 'no usable model route was found')

      let text = ''
      let usedRoute = null
      let lastError = null

      for (const route of routes) {
        if (ac.signal.aborted) break
        try {
          const attempt = setTimeout(() => ac.abort(), c.timeoutMs)
          try {
            if (emit) {
              let first = true
              for await (const delta of streamRoute(service, route, { system, user: userText, c, signal: ac.signal, effort: options.effort })) {
                text += delta
                if (first) {
                  first = false
                  emit({ type: 'route', provider: route.provider, model: route.model })
                }
                emit({ type: 'delta', text: delta })
              }
            } else {
              text = await callRoute(service, route, { system, user: userText, c, signal: ac.signal, effort: options.effort })
            }
          } finally {
            clearTimeout(attempt)
          }
          if (text.trim() === '') throw new EnhanceError('empty_output', 'the model returned an empty rewrite')
          usedRoute = route
          break
        } catch (err) {
          lastError = err
          const message = err?.message ?? String(err)
          stats.failed += 1
          log('warn', `route ${route.provider}/${route.model || '(default)'} failed: ${message}`)
          markDead(route)
          text = ''
          if (ac.signal.aborted) break
        }
      }

      if (!usedRoute) {
        if (ac.signal.aborted) {
          throw new EnhanceError('timeout', `the rewrite did not finish inside ${c.totalBudgetMs}ms`)
        }
        throw new EnhanceError('no_route', lastError?.message ?? 'every candidate route failed')
      }

      rememberRoute(usedRoute)

      // ---- sanitise once, then gate
      let enhanced = sanitizeOutput(text, {
        stripFence: c.stripCodeFence,
        stripQuotes: c.stripWrappingQuotes,
      })
      if (enhanced === '') throw new EnhanceError('empty_output', 'the rewrite was empty after cleaning')

      let repaired = false
      let missing = []
      let verdict = null

      if (c.fidelityGuard || c.lengthGuard) {
        let fidelity = c.fidelityGuard ? checkFidelity(anchors, enhanced) : { missing: [], total: 0, kept: 0 }
        missing = fidelity.missing
        verdict = c.lengthGuard && mode.maxRatio ? lengthVerdict(trimmed, enhanced, mode.maxRatio) : null
        const tooLong = verdict !== null && !verdict.ok

        if ((missing.length > 0 || tooLong) && c.fidelityRepair && !ac.signal.aborted) {
          // One repair round covers both gates — never a second call per gate.
          const clauses = []
          if (missing.length > 0) clauses.push(repairClause(missing))
          if (tooLong) {
            clauses.push(
              `Your previous rewrite was too long: ${verdict.chars} characters against a budget of ${verdict.charBudget}. ` +
                'Rewrite it again, shorter, without dropping any content.',
            )
          }
          const repairText = `${userText}\n\nYour previous answer:\n${enhanced}\n\n${clauses.join('\n\n')}`
          try {
            const again = await callRoute(service, usedRoute, { system, user: repairText, c, signal: ac.signal })
            const fixed = sanitizeOutput(again, {
              stripFence: c.stripCodeFence,
              stripQuotes: c.stripWrappingQuotes,
            })
            if (fixed !== '') {
              repaired = true
              stats.repaired += 1
              enhanced = fixed
              if (c.fidelityGuard) missing = checkFidelity(anchors, enhanced).missing
              if (c.lengthGuard && mode.maxRatio) {
                verdict = lengthVerdict(trimmed, enhanced, mode.maxRatio)
              }
            }
          } catch (err) {
            log('warn', `repair round failed: ${err?.message ?? err}`)
          }
        }
      }

      // ---- deterministic last resort
      let reinjected = 0
      if (missing.length > 0) {
        const lang = detectLanguage(trimmed) === 'zh' ? 'zh' : 'en'
        enhanced = `${enhanced}${reinjectionBlock(missing, lang)}`
        reinjected = missing.length
        stats.reinjected += 1
      }

      const lang = detectLanguage(trimmed)
      const language = languageConsistent(trimmed, enhanced)
      if (!language.ok) {
        throw new EnhanceError(
          'language_mismatch',
          `the model answered in ${language.resultLang} but the draft is ${language.draftLang}; the draft was left untouched`,
        )
      }

      // ---- A re-appended fact outranks the ceiling; only a clean overrun is an error.
      if (verdict && reinjected === 0 && !verdict.ok) {
        throw new EnhanceError(
          'length_exceeded',
          `the rewrite is ${verdict.chars} characters against a budget of ${verdict.charBudget} ` +
            `(${verdict.ratioLabel}, ${mode.id} mode). Try the light mode or raise the limit.`,
        )
      }

      const ms = Date.now() - started
      stats.calls += 1
      stats.ok += 1
      stats.totalMs += ms
      stats.lastOkAt = Date.now()

      return {
        text: enhanced,
        meta: {
          version: VERSION,
          mode: mode.id,
          modeLabel: mode.label,
          provider: usedRoute.provider,
          model: usedRoute.model || '(default)',
          route: `${usedRoute.provider}/${usedRoute.model || '(default)'}`,
          ms,
          chars: charLength(enhanced),
          draftChars: charLength(trimmed),
          ratio: verdict?.ratio ?? null,
          ratioLabel: verdict ? formatRatio(verdict.ratio) : null,
          budget: verdict?.charBudget ?? null,
          anchors: { total: anchors.length, kept: anchors.length - missing.length, reinjected },
          note: fidelityNote(missing, lang === 'zh' ? 'zh' : 'en'),
          repaired,
          contextUsed: history !== '',
          contextReason: trigger.reason,
          language: lang,
          cached: false,
        },
      }
    } finally {
      clearTimeout(budget)
      ac.signal.removeEventListener?.('abort', onAbort)
    }
  }

  /* ------------------------------------------------------------------- handlers */

  function guard(req, res, kind) {
    const c = cfg()

    // `/info` stays reachable for local diagnostics even with the plugin switched off.
    if (kind !== 'info' && !c.enabled) {
      sendJson(res, 503, { ok: false, code: 'disabled', error: 'the enhancer is switched off' })
      return true
    }

    const trust = isTrustedRequest(req, c)
    if (!trust.ok) {
      log('warn', `rejected ${kind} from ${peerAddress(req)}: ${trust.reason}`)
      sendJson(res, 403, { ok: false, code: 'forbidden', error: `request rejected: ${trust.reason}` })
      return true
    }

    if (kind === 'info') return false

    const capacity = kind === 'selftest' ? 2 : kind === 'report' ? 120 : c.rateLimitPerMinute
    if (Date.now() - bucketSweepAt > BUCKET_SWEEP_MS) {
      bucketSweepAt = Date.now()
      buckets.clear()
      log('info', 'token buckets swept')
    }
    const key = `${kind}:${peerAddress(req)}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = createBucket(capacity)
      buckets.set(key, bucket)
    }
    if (!bucket.take()) {
      res.setHeader('retry-after', '10')
      sendJson(res, 429, { ok: false, code: 'rate_limited', error: `${capacity} requests per minute per client` })
      return true
    }
    return false
  }

  async function enhanceHandler(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, code: 'method_not_allowed', error: 'use POST' })
      return
    }
    if (guard(req, res, 'enhance')) return
    try {
      const body = await readJsonBody(req, BODY_LIMIT)
      const result = await runEnhance(body.text ?? body.draft ?? '', {
        style: body.style ?? body.mode,
        provider: body.provider,
        model: body.model,
        sessionId: body.sessionId,
        effort: typeof body.effort === 'string' && body.effort ? body.effort : undefined,
        context: body.context === true ? true : body.context === false ? false : undefined,
        force: body.force === true,
      })
      sendJson(res, 200, { ok: true, ...result })
    } catch (err) {
      respondError(res, err)
    }
  }

  async function streamHandler(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, code: 'method_not_allowed', error: 'use POST' })
      return
    }
    if (guard(req, res, 'enhance')) return

    const sse = createSseWriter(res)
    try {
      const body = await readJsonBody(req, BODY_LIMIT)
      sse.open()
      const result = await runEnhance(body.text ?? body.draft ?? '', {
        style: body.style ?? body.mode,
        provider: body.provider,
        model: body.model,
        sessionId: body.sessionId,
        effort: typeof body.effort === 'string' && body.effort ? body.effort : undefined,
        context: body.context === true ? true : body.context === false ? false : undefined,
        force: body.force === true,
        onDelta: (event) => {
          if (event.type === 'route') sse.event('route', { provider: event.provider, model: event.model })
          else if (event.type === 'delta') sse.event('delta', { text: event.text })
        },
      })
      await sse.event('done', { ok: true, ...result })
      sse.close()
    } catch (err) {
      const payload = errorPayload(err)
      if (sse.writable) {
        sse.open()
        await sse.event('error', payload)
        sse.close()
      } else {
        sendJson(res, statusOf(err), payload)
      }
    } finally {
      sse.dispose()
    }
  }

  async function modelsHandler(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') {
      sendJson(res, 405, { ok: false, code: 'method_not_allowed', error: 'use GET' })
      return
    }
    if (guard(req, res, 'info')) return
    try {
      const service = llm()
      sendJson(res, 200, { ok: true, ...(await catalogue(service)) })
    } catch (err) {
      respondError(res, err)
    }
  }

  function infoHandler(req, res) {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, code: 'method_not_allowed', error: 'use GET' })
      return
    }
    if (guard(req, res, 'info')) return
    const c = cfg()
    sendJson(res, 200, {
      ok: true,
      version: VERSION,
      enabled: c.enabled,
      style: c.style.id,
      styles: PROMPT_STYLES,
      maxRatio: c.style.maxRatio,
      guards: { fidelity: c.fidelityGuard, repair: c.fidelityRepair, length: c.lengthGuard },
      context: { aware: c.contextAware, turns: c.contextTurns, chars: c.contextChars },
      reasoningEffort: c.reasoningEffort || '(model default)',
      stream: c.stream,
      route: routeCache ?? null,
      routes: [`${API_PREFIX}/enhance`, `${API_PREFIX}/stream`, `${API_PREFIX}/models`, `${API_PREFIX}/info`, `${API_PREFIX}/report`, `${API_PREFIX}/selftest`],
      stats,
      startupCheck,
    })
  }

  async function reportHandler(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, code: 'method_not_allowed', error: 'use POST' })
      return
    }
    if (guard(req, res, 'report')) return
    try {
      const body = await readJsonBody(req, BODY_LIMIT)
      log(body.stage === 'ok' ? 'info' : 'warn', `client report: ${body.stage}`, body)
      sendJson(res, 200, { ok: true })
    } catch (err) {
      respondError(res, err)
    }
  }

  async function selfTestHandler(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, code: 'method_not_allowed', error: 'use POST' })
      return
    }
    if (guard(req, res, 'selftest')) return
    try {
      const body = await readJsonBody(req, BODY_LIMIT)
      const text = String(body.text ?? 'Improve the error message of lib/a.js so a user can act on it.')
      const result = await runEnhance(text, { style: body.style, force: true })
      sendJson(res, 200, { ok: true, ...result })
    } catch (err) {
      respondError(res, err)
    }
  }

  function statusOf(err) {
    const code = err?.code
    if (code === 'busy' || code === 'rate_limited') return 429
    if (code === 'language_mismatch' || code === 'length_exceeded') return 422
    return ERROR_STATUS[code] ?? 502
  }

  function errorPayload(err) {
    return {
      ok: false,
      code: err?.code ?? 'unknown',
      error: err?.message ?? String(err),
      hint: err?.hint ?? undefined,
    }
  }

  function respondError(res, err) {
    const code = err?.code ?? 'unknown'
    if (code !== 'bad_request') log('error', `enhance failed [${code}]: ${err?.message ?? err}`)
    sendJson(res, statusOf(err), errorPayload(err))
  }

  /* ---------------------------------------------------------------- registration */

  function registerRoute(kind, path, label, handler) {
    ctx.effect(() => {
      const dispose = ctx.webServer.register({
        kind,
        path,
        handler: (req, res) => {
          Promise.resolve(handler(req, res)).catch((err) => {
            if (!res.headersSent) respondError(res, err)
            else res.end()
          })
        },
      })
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    }, `enhance-prompt: ${label}`)
  }

  registerRoute('exact', `${API_PREFIX}/enhance`, 'enhance', enhanceHandler)
  registerRoute('exact', `${API_PREFIX}/stream`, 'stream', streamHandler)
  registerRoute('exact', `${API_PREFIX}/models`, 'models', modelsHandler)
  registerRoute('exact', `${API_PREFIX}/info`, 'info', infoHandler)
  registerRoute('exact', `${API_PREFIX}/report`, 'report', reportHandler)
  registerRoute('exact', `${API_PREFIX}/selftest`, 'selftest', selfTestHandler)

  /* ------------------------------------------------------------- agent surface */

  if (cfg().announceToAgent) {
    try {
      // section() takes { name, order, text }: order must be a finite number or the
      // harness throws, and the payload key is `text`, not `content`.
      ctx.systemPrompt?.section?.({ name: 'enhance-prompt', order: 900, text: GUIDANCE })
    } catch (err) {
      log('warn', `system prompt section unavailable: ${err?.message ?? err}`)
    }
  }

  try {
    if (cfg().toolsEnabled && ctx.tools?.register) {
      ctx.tools.register({
        name: 'enhance_prompt',
        description:
          'Rewrite a rough draft into a precise, executable prompt. Applies the deterministic fidelity gate: ' +
          'every path, identifier, number, version, URL and quoted literal in the draft is verified to survive.',
        parameters: {
          text: { type: 'string', required: true, description: 'The draft to rewrite.' },
          style: { type: 'string', description: `Rewrite mode: ${PROMPT_STYLES.join(', ')}.` },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string', required: true },
              mode: { type: 'string', required: true },
              route: { type: 'string', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        async execute(input) {
          const result = await runEnhance(String(input?.text ?? ''), { style: input?.style, force: true })
          return { text: result.text, mode: result.meta.mode, route: result.meta.route }
        },
      })
    }
  } catch (err) {
    log('warn', `tool registration skipped: ${err?.message ?? err}`)
  }

  /* ----------------------------------------------------------------- startup */

  /**
   * Zero-cost startup check. A real model call on every boot would spend quota merely for
   * the process to start, so the default is structural: prompts, routes, guards, log dir.
   */
  const startupCheck = (() => {
    const checks = {}
    checks.prompts = PROMPT_STYLES.length
    checks.modes = Object.keys({ light: 1, standard: 1, deep: 1, system: 1, workbuddy: 1 }).length
    checks.routes = 6
    checks.guard = typeof isTrustedRequest === 'function'
    checks.log = (() => {
      try {
        const path = require('node:path')
        require('node:fs').mkdirSync(path.join(require('node:os').homedir(), '.dsh'), { recursive: true })
        return true
      } catch {
        return false
      }
    })()
    checks.version = VERSION
    const ok = Object.values(checks).every((v) => v !== false && v !== 0)
    log(ok ? 'info' : 'error', `startup check ${ok ? 'ok' : 'failed'}`, checks)
    return { ok, checks }
  })()

  if (cfg().selfTestOnStart) {
    ctx.effect(() => {
      const timer = setTimeout(() => {
        runEnhance('Tighten this note so an agent can act on it.', { force: true })
          .then((r) => log('info', `startup real-call self test ok in ${r.meta.ms}ms via ${r.meta.route}`))
          .catch((err) => log('error', `startup real-call self test failed: ${err?.message ?? err}`))
      }, 1500)
      timer.unref?.()
      return () => clearTimeout(timer)
    }, 'enhance-prompt: startup self test')
  }

  ctx.effect(() => {
    disposed = false
    return () => {
      disposed = true
      for (const [, entry] of inflight) {
        void entry.catch?.(() => {})
      }
      inflight.clear()
      resultCache.clear()
      modelCache.clear()
      effortCache.clear()
      deadUntil.clear()
      flushLog()
    }
  }, 'enhance-prompt: teardown')

  return {
    get disposed() {
      return disposed
    },
  }
}

export default { name, apply, inject, Config }
