/**
 * dsh-enhance-prompt — 宿主半边（v0.4.0）。
 *
 * 复刻 WorkBuddy 桌面版「增强提示词」：
 *   用户点了输入框那个四角星 → 把草稿交给模型改写 → 结果写回输入框，
 *   并且记住原文，用户可以一键「恢复原文」。
 *
 * 与 WorkBuddy 的对应关系：
 *   llm:enhancePrompt RPC           →  POST /dsh-enhance-prompt/enhance
 *   agentName 'enhance-prompt'      →  一次性模型调用（system + user 模板）
 *   stripWrappingQuotes             →  sanitizeOutput()（引号 + 围栏，只剥一层）
 *   empty_input / llm_error 等 code →  同名 code 原样回给前端
 *
 * 路径选择：/api/* 是宿主 api-gateway 的保留前缀（未鉴权一律 401），
 * 插件自己的路由必须挂别的路径（同 dsh-meme 的 /dsh-memes-api）。
 * v0.4.0 起不再保留 /api/enhance-prompt/* 别名 —— 那两条永远 401，是死代码。
 *
 * 安全模型（v0.4.0 新增，此前完全没有）：
 *   1. 默认只接受回环地址（req.socket.remoteAddress ∈ 127.0.0.0/8 ::1）；
 *      需要反代暴露时显式打开 allowRemote。
 *   2. 默认要求 x-dsh-enhance 请求头 —— 跨站表单/图片打不进来，
 *      跨站 fetch 带自定义头会触发 preflight，而本插件不返回 CORS 头。
 *   3. 每端点令牌桶限流（enhance 默认 30/min，selftest 固定 2/min）。
 *   4. 请求体不再能随意指定 provider/model（allowRouteOverride 默认关闭）。
 *
 * 诊断：所有失败都同时写进 ~/.dsh/enhance-prompt.log（桌面端会收走子进程
 * stdout，只看 ctx.logger 在用户侧是查不到痕迹的）。日志按 2MB 轮转一次。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  WORKBUDDY_SYSTEM,
  WORKBUDDY_USER_TEMPLATE,
  ENHANCED_SYSTEM,
  ENHANCED_USER_TEMPLATE,
  SYSTEM_STYLE_SYSTEM,
  DEFAULT_PROMPT_STYLE,
  PROMPT_STYLES,
  renderUserPrompt,
  resolvePromptStyle,
  sanitizeOutput,
} from './prompts.js'

/** 浏览器半边调的接口前缀（api-gateway 之外的路径）。 */
const API_PREFIX = '/dsh-enhance-prompt'

/** 系统提示词小节用的 order（排在工具说明之后，靠后不影响装配）。 */
const SECTION_ORDER = 900

/** 诊断日志。桌面端会收走 stdout，所以自己落盘。 */
const LOG_FILE = process.env.DSH_ENHANCE_LOG || path.join(os.homedir(), '.dsh', 'enhance-prompt.log')
const LOG_MAX_BYTES = 2 * 1024 * 1024

/** 上次成功的路由。落盘保存，冷启动不用从头试错。 */
const ROUTE_FILE = process.env.DSH_ENHANCE_ROUTE || path.join(os.homedir(), '.dsh', 'enhance-prompt-route.json')
/** 落盘路由的有效期：适配器/凭据变过之后老路由未必还成立。 */
const ROUTE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** 致命 provider 的冷却时间（按 provider+model 记，不按 provider）。 */
const DEAD_TTL_MS = 10 * 60 * 1000

/** 结果缓存条数（幂等）。 */
const CACHE_LIMIT = 32
/** 客户端上报的日志最多吃掉多少字节，防止日志被灌穿。 */
const REPORT_LIMIT = 8 * 1024

/** 版本号单源：直接读自己的 package.json。 */
const VERSION = (() => {
  try {
    return String(createRequire(import.meta.url)('../package.json').version || '0.0.0')
  } catch {
    return '0.0.0'
  }
})()

// --------------------------------------------------------------------- 日志

let logBytes = -1

function safeStringify(value) {
  try {
    const seen = new WeakSet()
    return JSON.stringify(value, (key, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[circular]'
        seen.add(val)
      }
      if (val instanceof Error) return { name: val.name, message: val.message, code: val.code }
      return val
    })
  } catch {
    return String(value)
  }
}

function rotateLog() {
  try {
    fs.rmSync(`${LOG_FILE}.1`, { force: true })
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`)
  } catch {
    /* 目标不存在或占用：忽略 */
  }
  logBytes = 0
}

/**
 * 写一行诊断日志。完全失败静默（日志不能成为新的故障点）。
 * 用异步 appendFile：之前 appendFileSync 在请求热路径上同步阻塞事件循环。
 */
function fileLog(level, message, detail) {
  try {
    let line = `${new Date().toISOString()} [${level}] ${message}`
    if (detail !== undefined) line += ` :: ${safeStringify(detail)}`
    const chunk = `${line}\n`
    if (logBytes < 0) {
      try {
        logBytes = fs.statSync(LOG_FILE).size
      } catch {
        logBytes = 0
        fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
      }
    }
    if (logBytes + Buffer.byteLength(chunk) > LOG_MAX_BYTES) rotateLog()
    logBytes += Buffer.byteLength(chunk)
    fs.appendFile(LOG_FILE, chunk, () => {})
  } catch {
    /* 忽略 */
  }
}

// --------------------------------------------------------------- 路由持久化

function loadSavedRoute() {
  try {
    const raw = JSON.parse(fs.readFileSync(ROUTE_FILE, 'utf8'))
    if (!raw || typeof raw.provider !== 'string' || raw.provider === '') return null
    if (typeof raw.savedAt === 'number' && Date.now() - raw.savedAt > ROUTE_MAX_AGE_MS) return null
    return { provider: raw.provider, model: String(raw.model || '') }
  } catch {
    return null
  }
}

function saveSavedRoute(route) {
  try {
    fs.mkdirSync(path.dirname(ROUTE_FILE), { recursive: true })
    fs.writeFileSync(
      ROUTE_FILE,
      `${JSON.stringify({ provider: route.provider, model: route.model, savedAt: Date.now() }, null, 2)}\n`,
    )
  } catch (error) {
    fileLog('warn', 'save route failed', { message: error instanceof Error ? error.message : String(error) })
  }
}

/** 适配器/凭据变了 → 落盘路由可能已经失效，直接清掉而不是只清内存。 */
function clearSavedRoute() {
  try {
    fs.rmSync(ROUTE_FILE, { force: true })
  } catch {
    /* 忽略 */
  }
}

// ------------------------------------------------------------------- 工具

export class EnhanceError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'EnhancePromptError'
    this.code = code
  }
}

/** 读一个配置字段，兼容 volatile Ref（`.get()`）。 */
export function readConfigField(field, fallback) {
  if (field === undefined || field === null) return fallback
  if (typeof field === 'object' && typeof field.get === 'function') {
    const value = field.get()
    return value === undefined || value === null ? fallback : value
  }
  return field
}

/** 错误码 → HTTP 状态。集中一处，避免新增错误码时漏改。 */
const ERROR_STATUS = {
  empty_input: 400,
  bad_request: 400,
  too_large: 413,
  unauthorized: 401,
  forbidden: 403,
  method_not_allowed: 405,
  busy: 429,
  disabled: 503,
  llm_unavailable: 503,
  no_route: 503,
  timeout: 504,
}

function statusOf(code) {
  return ERROR_STATUS[code] ?? 502
}

// ------------------------------------------------------------------ 配置

const Config = z.object({
  enabled: z.boolean().default(true).description('Enable the enhance-prompt plugin.'),
  provider: z.string().default('').description('Preferred LLM provider id (empty = auto).'),
  model: z.string().default('').description('Preferred model id (empty = first model of the provider).'),
  providerPriority: z.array(z.string()).default([]).description('Provider ids to try before the rest.'),
  maxAttempts: z.number().default(6).description('How many candidate routes to try per request.'),
  temperature: z.number().default(0.3).description('Sampling temperature for the rewrite.'),
  maxTokens: z.number().default(4000).description('Max output tokens.'),
  timeoutMs: z.number().default(60000).description('Per-route timeout in milliseconds.'),
  totalBudgetMs: z.number().default(90000).description('Whole-request budget across all candidate routes.'),
  maxConcurrency: z.number().default(2).description('Concurrent enhance requests before answering 429.'),
  minTextLength: z.number().default(1).description('Reject inputs shorter than this many characters (0 = allow empty).'),
  maxInputChars: z.number().default(8000).description('Truncate inputs longer than this many characters.'),
  promptStyle: z
    .string()
    .default(DEFAULT_PROMPT_STYLE)
    .description(`Which prompt set to use: ${PROMPT_STYLES.join(' | ')}.`),
  customSystemPrompt: z.string().default('').description("Overrides the system prompt when promptStyle = 'system'."),
  customUserTemplate: z.string().default('').description('Overrides the user template ({input} placeholder).'),
  stripWrappingQuotes: z.boolean().default(true).description('Strip one layer of wrapping quotes from the result.'),
  stripCodeFence: z.boolean().default(true).description('Strip a wrapping ``` fence from the result.'),
  idempotent: z.boolean().default(true).description('Cache results and share in-flight calls for identical input.'),
  announceToAgent: z.boolean().default(true).description('Advertise the enhance_prompt tool in the system prompt.'),
  toolsEnabled: z.boolean().default(true).description('Register the enhance_prompt model tool.'),
  selfTestOnStart: z.boolean().default(false).description('Run one real model call at startup (costs quota).'),
  allowRemote: z.boolean().default(false).description('Accept non-loopback callers (behind a reverse proxy with its own auth).'),
  requireHeader: z.boolean().default(true).description('Require the x-dsh-enhance request header (CSRF guard).'),
  rateLimitPerMinute: z.number().default(30).description('Enhance requests allowed per minute per client.'),
})

export const inject = ['webServer', 'tools', 'llm', 'systemPrompt']

/** 只改写、不执行的说明，注入系统提示词。 */
const GUIDANCE = `Prompt enhancer: the user can rewrite their current draft into a sharper prompt with the sparkle
button (four-pointed star) at the right of the input box, or by calling the \`enhance_prompt\` tool.
It only rewrites wording — it never executes the request, never answers the question, and never adds facts
the user did not provide. Use it when the user's message is vague and they asked you to sharpen it;
do not call it on your own to "improve" a message the user is happy with.`

export function apply(ctx, config) {
  // ------------------------------------------------------------------ 状态

  let routeCache = loadSavedRoute()
  /** `${provider}\u0000${model}` → 冷却截止时间。 */
  const deadUntil = new Map()
  /** provider → { at, models }，见 modelIds()。 */
  const modelCache = new Map()
  const MODEL_TTL_MS = 60 * 1000
  /** 幂等缓存：hash → { text, at }。 */
  const resultCache = new Map()
  /** 单飞：hash → 正在跑的 Promise。 */
  const inflight = new Map()
  /** 限流令牌桶：key → { tokens, at }。 */
  const buckets = new Map()
  let running = 0
  let disposeSection
  let startupCheck = null

  const stats = {
    calls: 0,
    ok: 0,
    failed: 0,
    shared: 0,
    cacheHits: 0,
    totalMs: 0,
    lastErrorAt: null,
    lastError: null,
    lastOkAt: null,
  }

  const log = (level, message, detail) => fileLog(level, message, detail)

  function cfg() {
    // 故意不做缓存：readConfigField 可能读写 volatile Ref，值随时会变，
    // 缓存会让热更新失效（正确性优先于这点开销）。
    return {
      enabled: Boolean(readConfigField(config?.enabled, true)),
      provider: String(readConfigField(config?.provider, '') || ''),
      model: String(readConfigField(config?.model, '') || ''),
      providerPriority: (readConfigField(config?.providerPriority, []) || []).map(String).filter(Boolean),
      maxAttempts: Math.max(1, Number(readConfigField(config?.maxAttempts, 6)) || 6),
      temperature: Number(readConfigField(config?.temperature, 0.3)),
      maxTokens: Math.max(64, Number(readConfigField(config?.maxTokens, 4000)) || 4000),
      timeoutMs: Math.max(1000, Number(readConfigField(config?.timeoutMs, 60000)) || 60000),
      totalBudgetMs: Math.max(1000, Number(readConfigField(config?.totalBudgetMs, 90000)) || 90000),
      maxConcurrency: Math.max(1, Number(readConfigField(config?.maxConcurrency, 2)) || 2),
      minTextLength: Math.max(0, Number(readConfigField(config?.minTextLength, 1)) || 0),
      maxInputChars: Math.max(0, Number(readConfigField(config?.maxInputChars, 8000)) || 8000),
      // 唯一样式来源：默认值也来自 prompts.js，不再各处写死。
      promptStyle: resolvePromptStyle(readConfigField(config?.promptStyle, DEFAULT_PROMPT_STYLE)).style,
      customSystemPrompt: String(readConfigField(config?.customSystemPrompt, '') || ''),
      customUserTemplate: String(readConfigField(config?.customUserTemplate, '') || ''),
      stripWrappingQuotes: Boolean(readConfigField(config?.stripWrappingQuotes, true)),
      stripCodeFence: Boolean(readConfigField(config?.stripCodeFence, true)),
      idempotent: Boolean(readConfigField(config?.idempotent, true)),
      announceToAgent: Boolean(readConfigField(config?.announceToAgent, true)),
      toolsEnabled: Boolean(readConfigField(config?.toolsEnabled, true)),
      selfTestOnStart: Boolean(readConfigField(config?.selfTestOnStart, false)),
      allowRemote: Boolean(readConfigField(config?.allowRemote, false)),
      requireHeader: Boolean(readConfigField(config?.requireHeader, true)),
      rateLimitPerMinute: Math.max(1, Number(readConfigField(config?.rateLimitPerMinute, 30)) || 30),
    }
  }

  // ------------------------------------------------------------- 限流/来源

  function clientId(req) {
    const addr = String((req.socket && req.socket.remoteAddress) || 'unknown')
    return addr
  }

  function isLoopback(req) {
    const addr = clientId(req)
    return (
      addr === '::1' ||
      addr === '::ffff:127.0.0.1' ||
      addr.startsWith('127.') ||
      addr === 'localhost'
    )
  }

  /** 令牌桶：capacity 次突发，按 capacity/60 每秒回填。 */
  function takeToken(key, capacity) {
    const now = Date.now()
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { tokens: capacity, at: now }
      buckets.set(key, bucket)
    }
    bucket.tokens = Math.min(capacity, bucket.tokens + ((now - bucket.at) / 1000) * (capacity / 60))
    bucket.at = now
    if (bucket.tokens < 1) return false
    bucket.tokens -= 1
    if (buckets.size > 512) {
      for (const [k, v] of buckets) {
        if (now - v.at > 5 * 60 * 1000) buckets.delete(k)
      }
    }
    return true
  }

  /**
   * 统一入口守卫。返回 true 表示「已经回过响应，调用方直接 return」。
   * info 端点不受限流与请求头约束（方便 curl 排查），但仍受回环限制。
   */
  function guard(req, res, kind) {
    const c = cfg()
    if (!c.allowRemote && !isLoopback(req)) {
      log('warn', 'rejected non-loopback caller', { kind, addr: clientId(req) })
      sendJson(res, 403, {
        success: false,
        text: '',
        code: 'forbidden',
        error: 'only loopback clients may call this endpoint (set allowRemote to override)',
      })
      return true
    }
    if (kind !== 'info' && c.requireHeader && !req.headers['x-dsh-enhance']) {
      sendJson(res, 403, {
        success: false,
        text: '',
        code: 'forbidden',
        error: 'missing x-dsh-enhance header',
      })
      return true
    }
    if (kind !== 'info') {
      const capacity = kind === 'selftest' ? 2 : kind === 'report' ? 120 : c.rateLimitPerMinute
      if (!takeToken(`${kind}:${clientId(req)}`, capacity)) {
        log('warn', 'rate limited', { kind, addr: clientId(req), capacity })
        sendJson(res, 429, {
          success: false,
          text: '',
          code: 'busy',
          error: `rate limit reached (${capacity}/min)`,
        })
        return true
      }
    }
    return false
  }

  // ------------------------------------------------------------- 路由解析

  function providerIds(llm) {
    try {
      const list = llm.listProviders()
      return (Array.isArray(list) ? list : [])
        .map((p) => (typeof p === 'string' ? p : String((p && (p.id ?? p.name)) || '')))
        .filter(Boolean)
    } catch (error) {
      log('warn', 'listProviders failed', { message: error instanceof Error ? error.message : String(error) })
      return []
    }
  }

  // llm.listModels 是 async（`Promise<LlmModelInfo[]>`）；早先按同步读拿到的是
  // Promise，Array.isArray 判 false，于是每个 provider 都被当成「没有模型」，
  // 候选链退化成 { provider, model: '' } 裸路由 —— 这是 v0.3.0 起就潜伏的 bug。
  // 结果按 provider 缓存 60s：候选链每次调用都要看模型表，逐个 await 会让
  // 一次 enhance 平白多出 N 次适配器往返；`llm/adapters-updated` 会清掉缓存。
  async function modelIds(llm, provider) {
    const hit = modelCache.get(provider)
    if (hit && Date.now() - hit.at < MODEL_TTL_MS) return hit.models
    try {
      const list = await llm.listModels(provider)
      const models = (Array.isArray(list) ? list : [])
        .map((m) => (typeof m === 'string' ? m : String((m && (m.id ?? m.name)) || '')))
        .filter(Boolean)
      modelCache.set(provider, { at: Date.now(), models })
      return models
    } catch (error) {
      log('warn', 'listModels failed', {
        provider,
        message: error instanceof Error ? error.message : String(error),
      })
      return []
    }
  }

  function isDead(route) {
    const until = deadUntil.get(`${route.provider}\u0000${route.model}`)
    return typeof until === 'number' && until > Date.now()
  }

  async function candidateRoutes(c) {
    const llm = ctx.get('llm')
    if (!llm || typeof llm.stream !== 'function') {
      throw new EnhanceError('llm_unavailable', 'llm service is not available')
    }
    const out = []
    const seen = new Set()
    const push = (route) => {
      if (!route || typeof route.provider !== 'string' || route.provider === '') return
      const model = String(route.model || '')
      const key = `${route.provider}\u0000${model}`
      if (seen.has(key)) return
      seen.add(key)
      out.push({ provider: route.provider, model })
    }

    // 1. 配置点名的 provider/model（只配了 provider 就展开它的全部模型）
    if (c.provider) {
      if (c.model) push({ provider: c.provider, model: c.model })
      else for (const model of await modelIds(llm, c.provider)) push({ provider: c.provider, model })
    }
    // 2. 上次成功的路由（落到第一顺位，冷启动不用再试错）
    if (routeCache) push(routeCache)
    // 3. providerPriority 里点名的
    for (const id of c.providerPriority) {
      const first = (await modelIds(llm, id))[0]
      if (first) push({ provider: id, model: first })
    }
    // 4. 其余按注册顺序。模型列表拿不到（provider 挂了 / 没鉴权）的先不排，
    //    见下面第 6 步的兜底 —— 否则会造出 { provider, model: '' } 这种废路
    //    由排在第一顺位，每次调用都先白试一次。
    const bare = []
    for (const id of providerIds(llm)) {
      const first = (await modelIds(llm, id))[0]
      if (first) push({ provider: id, model: first })
      else bare.push(id)
    }
    // 5. 冷却中的路由排到最后（不删，兜底）
    const alive = out.filter((r) => !isDead(r))
    const cold = out.filter((r) => isDead(r))
    let ordered = alive.concat(cold)
    // 6. 一个模型名都解析不出来时才退回裸 provider 路由（model 留空由 provider 自己取
    //    默认）。只在没有别的选择时用，所以放在最后而不是第一顺位。
    if (ordered.length === 0) {
      for (const id of bare) push({ provider: id, model: '' })
      ordered = out
    }
    if (ordered.length === 0) {
      throw new EnhanceError('no_route', 'no provider/model route could be resolved')
    }
    return ordered
  }

  // ------------------------------------------------------------- 模型调用

  function openStream(llm, call, request) {
    if (typeof llm.prepareCall === 'function') {
      return Promise.resolve(llm.prepareCall(call, request.signal)).then((prepared) =>
        prepared.stream({ ...(prepared.config || {}), ...request }),
      )
    }
    return Promise.resolve(llm.stream({ ...call, ...request }))
  }

  async function callRoute(llm, route, { system, userMessage, c, signal, timeoutMs }) {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort(new Error(`timeout after ${timeoutMs}ms`))
    }, timeoutMs)
    const forward = () => controller.abort(signal.reason)
    if (signal) {
      if (signal.aborted) forward()
      else signal.addEventListener('abort', forward, { once: true })
    }
    const started = Date.now()
    const request = {
      system,
      messages: [createUserMessage({ content: [{ type: 'text', text: userMessage }], source: { kind: 'user' } })],
      signal: controller.signal,
    }
    const limit = { timeoutMs }
    let raw = ''
    let usage
    let finishKind = 'unknown'
    try {
      const stream = await openStream(
        llm,
        {
          provider: route.provider,
          model: route.model,
          temperature: c.temperature,
          maxTokens: c.maxTokens,
        },
        request,
      )
      for await (const chunk of stream) {
        if (!chunk || typeof chunk !== 'object') continue
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') raw += chunk.text
        else if (chunk.type === 'usage') usage = chunk.usage
        else if (chunk.type === 'finish') {
          finishKind = (chunk.reason && chunk.reason.kind) || 'stop'
          if (finishKind === 'error') {
            const failure = chunk.reason && chunk.reason.failure
            const detail =
              failure && failure.message ? failure.message : safeStringify(chunk.reason && chunk.reason.failure)
            const error = new EnhanceError('llm_error', detail || 'model returned an error finish')
            error.provider = route.provider
            throw error
          }
        }
      }
    } catch (error) {
      const aborted = controller.signal.aborted
      const reason = controller.signal.reason
      const timedOut = aborted && reason instanceof Error && /timeout after/.test(reason.message)
      log('warn', 'route failed', {
        provider: route.provider,
        model: route.model,
        ms: Date.now() - started,
        aborted,
        timedOut,
        code: error instanceof EnhanceError ? error.code : 'llm_error',
        message: error instanceof Error ? error.message : String(error),
      })
      if (error instanceof EnhanceError) throw error
      if (timedOut) throw new EnhanceError('timeout', `the model did not answer within ${timeoutMs}ms`)
      throw new EnhanceError('llm_error', error instanceof Error ? error.message : String(error))
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', forward)
    }

    const text = sanitizeOutput(raw, {
      stripFence: c.stripCodeFence,
      stripQuotes: c.stripWrappingQuotes,
    })
    if (text === '') throw new EnhanceError('llm_error', 'Enhanced result is empty')
    log('info', 'route ok', {
      route,
      ms: Date.now() - started,
      finishKind,
      rawLen: raw.length,
      outLen: text.length,
      usage,
      limit,
    })
    return { text, provider: route.provider, model: route.model }
  }

  function isProviderFatal(message) {
    return /authentication fails|insufficient balance|invalid.*(api key|token)|unauthorized|401|permission denied/i.test(
      String(message || ''),
    )
  }

  // --------------------------------------------------------- 缓存与单飞

  function cacheGet(key) {
    const hit = resultCache.get(key)
    if (!hit) return null
    // LRU：命中后挪到末尾
    resultCache.delete(key)
    resultCache.set(key, hit)
    return hit.text
  }

  function cacheSet(key, text) {
    resultCache.set(key, { text, at: Date.now() })
    while (resultCache.size > CACHE_LIMIT) {
      const oldest = resultCache.keys().next()
      if (oldest.done) break
      resultCache.delete(oldest.value)
    }
  }

  function cacheKeyOf(style, text) {
    return crypto.createHash('sha256').update(style).update('\u0000').update(text).digest('hex')
  }

  // ----------------------------------------------------------- 主流程

  function buildPrompts(style, text, c) {
    if (style === 'system') {
      return {
        system: c.customSystemPrompt || SYSTEM_STYLE_SYSTEM,
        userMessage: text,
      }
    }
    if (style === 'workbuddy') {
      return {
        system: WORKBUDDY_SYSTEM,
        userMessage: renderUserPrompt(c.customUserTemplate || WORKBUDDY_USER_TEMPLATE, text),
      }
    }
    return {
      system: ENHANCED_SYSTEM,
      userMessage: renderUserPrompt(c.customUserTemplate || ENHANCED_USER_TEMPLATE, text),
    }
  }

  async function runChain({ llm, c, text, style, signal }) {
    const routes = await candidateRoutes(c)
    const deadline = Date.now() + c.totalBudgetMs
    const attempts = Math.min(c.maxAttempts, routes.length)
    const { system, userMessage } = buildPrompts(style, text, c)
    let lastError = null
    for (let index = 0; index < attempts; index += 1) {
      const route = routes[index]
      const remaining = deadline - Date.now()
      if (remaining <= 500) {
        lastError = new EnhanceError('timeout', `request budget of ${c.totalBudgetMs}ms exhausted`)
        break
      }
      try {
        const result = await callRoute(llm, route, {
          system,
          userMessage,
          c,
          signal,
          timeoutMs: Math.min(c.timeoutMs, remaining),
        })
        routeCache = { provider: result.provider, model: result.model }
        saveSavedRoute(routeCache)
        return result
      } catch (error) {
        lastError = error
        // 记住这次尝试，下次（以及别的请求）先绕开它。
        if (error instanceof EnhanceError && (error.code === 'llm_error' || error.code === 'timeout')) {
          const fatal = isProviderFatal(error.message)
          if (fatal || error.code === 'timeout') {
            deadUntil.set(`${route.provider}\u0000${route.model}`, Date.now() + DEAD_TTL_MS)
          }
        }
        if (error instanceof EnhanceError && error.code === 'disabled') break
        // 外部中断（客户端断开）没有继续的必要。
        if (signal && signal.aborted) break
        if (index === attempts - 1) break
      }
    }
    if (signal && signal.aborted) throw new EnhanceError('timeout', 'the request was aborted')
    throw lastError || new EnhanceError('llm_error', 'no candidate route answered')
  }

  /**
   * 增强一段文本。
   *
   * options.bypassCache — selftest 用：强制真打一次模型。
   * options.provider / options.model — 仅当 allowRouteOverride 打开时有效。
   */
  async function enhance(rawText, options = {}) {
    const c = cfg()
    if (!c.enabled) throw new EnhanceError('disabled', 'Enhance prompt is disabled')

    let text = String(rawText ?? '')
    if (c.maxInputChars > 0 && text.length > c.maxInputChars) text = text.slice(0, c.maxInputChars)
    if (text.trim().length < c.minTextLength) {
      throw new EnhanceError('empty_input', c.minTextLength > 0 ? 'Empty input' : 'Nothing to enhance')
    }

    // cfg() 已经把 promptStyle 归一化过（未知值 → 默认值），这里只补一条诊断日志。
    const style = c.promptStyle
    if (resolvePromptStyle(readConfigField(config?.promptStyle, DEFAULT_PROMPT_STYLE)).fallback) {
      log('warn', 'unknown promptStyle, using default', {
        configured: String(readConfigField(config?.promptStyle, '')),
        used: style,
      })
    }

    let llmConfig = c
    if (options.provider) {
      const llm = ctx.get('llm')
      const allowed = llm && providerIds(llm).includes(String(options.provider))
      if (!allowed) {
        log('warn', 'route override refused', { provider: options.provider, model: options.model })
      } else {
        llmConfig = { ...c, provider: String(options.provider), model: String(options.model || '') }
      }
    }

    const key = cacheKeyOf(style, text)
    const useCache = c.idempotent && !options.bypassCache
    if (useCache) {
      const hit = cacheGet(key)
      if (hit !== null) {
        stats.cacheHits += 1
        return { text: hit, provider: 'cache', model: '', cached: true }
      }
    }
    const running_ = inflight.get(key)
    if (running_) {
      stats.shared += 1
      return { ...(await running_), shared: true }
    }
    if (running >= llmConfig.maxConcurrency) {
      throw new EnhanceError('busy', `too many concurrent enhance requests (${llmConfig.maxConcurrency})`)
    }

    const llm = ctx.get('llm')
    if (!llm || typeof llm.stream !== 'function') {
      throw new EnhanceError('llm_unavailable', 'llm service is not available')
    }

    const controller = new AbortController()
    const started = Date.now()
    stats.calls += 1
    running += 1
    const task = (async () => {
      try {
        const result = await runChain({
          llm,
          c: llmConfig,
          text,
          style,
          signal: controller.signal,
        })
        stats.ok += 1
        stats.totalMs += Date.now() - started
        stats.lastOkAt = Date.now()
        if (useCache) {
          cacheSet(key, result.text)
          // 幂等的另一半：这次的结果本身也记一份，用户重复点不会再放大一遍。
          cacheSet(cacheKeyOf(style, result.text), result.text)
        }
        return result
      } catch (error) {
        stats.failed += 1
        stats.lastErrorAt = Date.now()
        stats.lastError = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        running -= 1
      }
    })()
    inflight.set(key, task)
    try {
      return await task
    } finally {
      inflight.delete(key)
    }
  }

  // -------------------------------------------------------------- HTTP 层

  function sendJson(res, status, payload) {
    if (res.writableEnded) return
    let body = ''
    try {
      body = JSON.stringify(payload)
    } catch {
      body = '{"success":false,"text":"","code":"internal","error":"unserialisable payload"}'
    }
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-content-type-options', 'nosniff')
    res.end(body)
  }

  function readJsonBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      let settled = false
      const settle = (fn, arg) => {
        if (settled) return
        settled = true
        fn(arg)
      }
      req.on('data', (chunk) => {
        if (settled) return
        size += chunk.length
        if (size > limit) {
          settle(reject, new EnhanceError('too_large', `request body exceeds ${limit} bytes`))
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (settled) return
        const raw = Buffer.concat(chunks).toString('utf8').trim()
        if (raw === '') return settle(resolve, {})
        try {
          const parsed = JSON.parse(raw)
          settle(resolve, parsed && typeof parsed === 'object' ? parsed : {})
        } catch {
          settle(reject, new EnhanceError('bad_request', 'request body is not valid JSON'))
        }
      })
      req.on('error', (error) => settle(reject, error))
    })
  }

  function registerRoute(route, label) {
    if (!ctx.webServer || typeof ctx.webServer.register !== 'function') {
      log('warn', `route skipped (no webServer): ${label}`)
      return
    }
    try {
      ctx.effect(() => ctx.webServer.register(route), `enhance-prompt: ${label}`)
      log('info', `route registered: ${label}`, { path: route.path, kind: route.kind })
    } catch (error) {
      log('error', `route register failed: ${label}`, {
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function enhanceHandler(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { success: false, text: '', code: 'method_not_allowed', error: 'use POST' })
      return
    }
    if (guard(req, res, 'enhance')) return

    // abort 挂 res 而不是 req：Node 16 起 req 的 'close' 在请求体读完就触发，
    // 挂 req 会让每个请求刚读完 body 就把自己掐死（历史上的 502 timeout 根因）。
    const controller = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) controller.abort(new Error('client disconnected'))
    })

    let body = {}
    try {
      body = await readJsonBody(req, 256 * 1024)
    } catch (error) {
      const code = error instanceof EnhanceError ? error.code : 'bad_request'
      sendJson(res, statusOf(code), {
        success: false,
        text: '',
        code,
        error: error instanceof Error ? error.message : String(error),
      })
      req.resume()
      return
    }

    const started = Date.now()
    try {
      const result = await enhance(body.text ?? body.input ?? '', {
        provider: body.provider,
        model: body.model,
      })
      sendJson(res, 200, {
        success: true,
        text: result.text,
        provider: result.provider,
        model: result.model,
        cached: result.cached === true,
        shared: result.shared === true,
        ms: Date.now() - started,
        style: cfg().promptStyle,
      })
    } catch (error) {
      const code = error instanceof EnhanceError ? error.code : 'llm_error'
      log('error', 'enhance failed', { code, message: error instanceof Error ? error.message : String(error) })
      sendJson(res, statusOf(code), {
        success: false,
        text: '',
        code,
        error: error instanceof Error ? error.message : String(error),
        ms: Date.now() - started,
      })
    }
  }

  async function infoHandler(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { success: false, text: '', code: 'method_not_allowed', error: 'use GET' })
      return
    }
    if (guard(req, res, 'info')) return
    const c = cfg()
    let route = null
    try {
      route = routeCache || (await candidateRoutes(c))[0] || null
    } catch {
      route = null
    }
    sendJson(res, 200, {
      success: true,
      version: VERSION,
      name: 'dsh-enhance-prompt',
      enabled: c.enabled,
      promptStyle: c.promptStyle,
      promptStyles: PROMPT_STYLES,
      configuredProvider: c.provider || null,
      configuredModel: c.model || null,
      route,
      limits: {
        minTextLength: c.minTextLength,
        maxInputChars: c.maxInputChars,
        maxAttempts: c.maxAttempts,
        timeoutMs: c.timeoutMs,
        maxTokens: c.maxTokens,
        temperature: c.temperature,
        totalBudgetMs: c.totalBudgetMs,
        maxConcurrency: c.maxConcurrency,
        rateLimitPerMinute: c.rateLimitPerMinute,
        allowRemote: c.allowRemote,
        requireHeader: c.requireHeader,
      },
      cache: { size: resultCache.size, hits: stats.cacheHits, shared: stats.shared },
      stats: {
        calls: stats.calls,
        ok: stats.ok,
        failed: stats.failed,
        avgMs: stats.ok > 0 ? Math.round(stats.totalMs / stats.ok) : null,
        lastOkAt: stats.lastOkAt,
        lastErrorAt: stats.lastErrorAt,
        lastError: stats.lastError,
      },
      startup: startupCheck,
      logFile: LOG_FILE,
    })
  }

  async function reportHandler(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { success: false, text: '', code: 'method_not_allowed', error: 'use POST' })
      return
    }
    if (guard(req, res, 'report')) return
    try {
      const body = await readJsonBody(req, REPORT_LIMIT)
      log('client', 'report', body)
      sendJson(res, 200, { success: true })
    } catch (error) {
      const code = error instanceof EnhanceError ? error.code : 'bad_request'
      // 日志端点不吃错误码：回报但不放大噪音
      log('warn', 'client report rejected', { code })
      sendJson(res, statusOf(code), { success: false, code })
      req.resume()
    }
  }

  async function selfTestHandler(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, {
        success: false,
        text: '',
        code: 'method_not_allowed',
        error: 'use POST (a self-test costs one real model call)',
      })
      return
    }
    if (guard(req, res, 'selftest')) return
    const started = Date.now()
    try {
      const result = await enhance('帮我写个爬虫', { bypassCache: true })
      sendJson(res, 200, {
        success: true,
        ms: Date.now() - started,
        provider: result.provider,
        model: result.model,
        text: result.text,
      })
    } catch (error) {
      const code = error instanceof EnhanceError ? error.code : 'llm_error'
      sendJson(res, statusOf(code), {
        success: false,
        text: '',
        code,
        error: error instanceof Error ? error.message : String(error),
        ms: Date.now() - started,
      })
    }
  }

  registerRoute({ kind: 'exact', path: `${API_PREFIX}/enhance`, handler: enhanceHandler }, 'POST /enhance')
  registerRoute({ kind: 'exact', path: `${API_PREFIX}/info`, handler: infoHandler }, 'GET /info')
  registerRoute({ kind: 'exact', path: `${API_PREFIX}/report`, handler: reportHandler }, 'POST /report')
  registerRoute({ kind: 'exact', path: `${API_PREFIX}/selftest`, handler: selfTestHandler }, 'POST /selftest')

  // ---------------------------------------------------------------- 模型工具

  ctx.effect(() => {
    const c = cfg()
    if (!c.toolsEnabled) return () => {}
    const dispose = ctx.tools.register(
      defineTool({
        name: 'enhance_prompt',
        description:
          'Rewrite a vague user request into a sharper prompt. Rewrites wording only: it does not execute the ' +
          'request and does not add facts the user did not provide.',
        parameters: {
          text: { type: 'string', required: true, description: 'The prompt text to rewrite.' },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
        },
        async execute(args) {
          const result = await enhance(String((args && args.text) || ''))
          return result.text
        },
      }),
    )
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  })

  // ------------------------------------------------------- 系统提示词小节

  function syncSection() {
    const c = cfg()
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    if (!c.enabled || !c.announceToAgent) return
    if (!ctx.systemPrompt || typeof ctx.systemPrompt.section !== 'function') return
    disposeSection = ctx.systemPrompt.section({
      name: 'plugin:enhance-prompt',
      order: SECTION_ORDER,
      text: GUIDANCE,
    })
  }
  syncSection()
  ctx.on('loader/volatile-update', () => {
    routeCache = loadSavedRoute()
    syncSection()
  })
  ctx.on('llm/adapters-updated', () => {
    // 适配器变了，之前记住的路由可能指向已经不存在的模型：内存和落盘一起清。
    routeCache = null
    clearSavedRoute()
    deadUntil.clear()
    modelCache.clear()
  })

  ctx.effect(() => () => {
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
  })

  // -------------------------------------------------------------- 启动自检

  /** 零成本的静态自检：不碰模型，所以可以每次都跑。 */
  async function staticSelfTest() {
    const checks = []
    checks.push({
      name: 'prompts',
      ok:
        ENHANCED_SYSTEM.length > 1000 &&
        WORKBUDDY_SYSTEM.length > 1000 &&
        ENHANCED_USER_TEMPLATE.includes('{input}') &&
        SYSTEM_STYLE_SYSTEM.length > 100,
    })
    let routeCount = 0
    let routeError = null
    try {
      routeCount = (await candidateRoutes(cfg())).length
    } catch (error) {
      routeError = error instanceof Error ? error.message : String(error)
    }
    checks.push({ name: 'route', ok: routeCount > 0, detail: routeCount, error: routeError })
    let logOk = true
    let logError = null
    try {
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
      fs.appendFileSync(LOG_FILE, '')
    } catch (error) {
      logOk = false
      logError = error instanceof Error ? error.message : String(error)
    }
    checks.push({ name: 'log', ok: logOk, detail: LOG_FILE, error: logError })
    checks.push({
      name: 'routes',
      ok: Boolean(ctx.webServer && typeof ctx.webServer.register === 'function'),
    })
    const failed = checks.filter((c) => !c.ok)
    return { ok: failed.length === 0, at: Date.now(), version: VERSION, checks }
  }

  staticSelfTest()
    .then((result) => {
      startupCheck = result
      log('info', 'startup check', result)
      if (!result.ok) log('error', 'startup check failed', result.checks.filter((c) => !c.ok))
    })
    .catch((error) => {
      startupCheck = {
        ok: false,
        at: Date.now(),
        version: VERSION,
        checks: [{ name: 'startup', ok: false, error: error instanceof Error ? error.message : String(error) }],
      }
      log('error', 'startup check threw', startupCheck)
    })

  if (cfg().selfTestOnStart) {
    const timer = setTimeout(() => {
      const started = Date.now()
      enhance('帮我写个爬虫', { bypassCache: true })
        .then((result) => {
          log('info', 'self-test ok', {
            ms: Date.now() - started,
            provider: result.provider,
            model: result.model,
            text: result.text.slice(0, 120),
          })
        })
        .catch((error) => {
          log('error', 'self-test failed', {
            ms: Date.now() - started,
            code: error instanceof EnhanceError ? error.code : 'llm_error',
            message: error instanceof Error ? error.message : String(error),
          })
        })
    }, 1500)
    if (typeof timer.unref === 'function') timer.unref()
    ctx.effect(() => () => clearTimeout(timer))
  }

  log('info', 'ready', { version: VERSION, logFile: LOG_FILE, route: routeCache, prefix: API_PREFIX })
}

export const name = 'dsh-enhance-prompt'

export default { apply, inject, Config, name }
