/**
 * dsh-enhance-prompt — 宿主半边。
 *
 * 复刻 WorkBuddy 桌面版「增强提示词」：
 *   用户点了输入框那个四角星 → 把草稿交给模型改写 → 结果写回输入框，
 *   并且记住原文，用户可以一键「恢复原文」。
 *
 * 与 WorkBuddy 的对应关系：
 *   llm:enhancePrompt RPC           →  POST /dsh-enhance-prompt/enhance
 *   agentName 'enhance-prompt'      →  一次性模型调用（system=Jr, user=Yr(input)）
 *   stripWrappingQuotes             →  sanitizeOutput()（引号 + 围栏）
 *   empty_input / llm_error 等 code →  同名 code 原样回给前端
 *
 * 路径选择：/api/* 是宿主 api-gateway 的保留前缀（未鉴权一律 401），
 * 插件自己的路由必须挂在别的路径上，这里跟 dsh-meme 的 /dsh-memes-api 同款，
 * 用 /dsh-enhance-prompt/*；旧的 /api/enhance-prompt/* 保留成别名。
 *
 * 诊断：所有失败都同时写进 ~/.dsh/enhance-prompt.log（桌面端会收走子进程
 * stdout，只看 ctx.logger 在用户侧是查不到痕迹的）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  WORKBUDDY_SYSTEM,
  WORKBUDDY_USER_TEMPLATE,
  ENHANCED_SYSTEM,
  ENHANCED_USER_TEMPLATE,
  SYSTEM_STYLE_SYSTEM,
  renderUserPrompt,
  sanitizeOutput,
} from './prompts.js'

/** 浏览器半边调的接口前缀（api-gateway 之外的路径）。 */
const API_PREFIX = '/dsh-enhance-prompt'
/** 早期版本用的前缀，保留成别名，方便老页面不刷新也能用。 */
const LEGACY_PREFIX = '/api/enhance-prompt'

/** 系统提示词小节用的 order（排在工具说明之后，靠后不影响装配）。 */
const SECTION_ORDER = 900

/** 诊断日志。桌面端会收走 stdout，所以自己落盘。 */
const LOG_FILE = process.env.DSH_ENHANCE_LOG || path.join(os.homedir(), '.dsh', 'enhance-prompt.log')

function fileLog(level, message, detail) {
  try {
    const stamp = new Date().toISOString()
    let line = `${stamp} [${level}] ${message}`
    if (detail !== undefined && detail !== null && detail !== '') {
      line += ` :: ${typeof detail === 'string' ? detail : safeStringify(detail)}`
    }
    fs.appendFileSync(LOG_FILE, line + '\n')
  } catch {
    /* 日志失败不影响主流程 */
  }
}

function safeStringify(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** 上次跑通的路由记在这里，重启后第一枪就打准的，不必从头撞一遍死 key。 */
const ROUTE_FILE = process.env.DSH_ENHANCE_ROUTE || path.join(os.homedir(), '.dsh', 'enhance-prompt-route.json')

function loadSavedRoute() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ROUTE_FILE, 'utf8'))
    if (parsed && typeof parsed.provider === 'string' && typeof parsed.model === 'string') {
      return { provider: parsed.provider, model: parsed.model }
    }
  } catch {
    /* 没有历史记录就是第一次跑 */
  }
  return null
}

function saveSavedRoute(route) {
  try {
    fs.mkdirSync(path.dirname(ROUTE_FILE), { recursive: true })
    fs.writeFileSync(ROUTE_FILE, JSON.stringify({ ...route, at: new Date().toISOString() }, null, 2) + '\n')
  } catch {
    /* 落盘失败不影响本次结果 */
  }
}

/** 模型侧公告：短、只说能力与边界，避免每轮吃额度。 */
const GUIDANCE = [
  '本机装了 dsh-enhance-prompt 插件：把一句粗糙的提示词改写成更清晰、更具体的版本（保留原意与原语言，只改表达）。',
  '用法：工具 enhance_prompt({ text }) 返回增强后的文本；Web GUI 输入框右侧的四角星按钮是同一能力。',
  '它只改写、不执行：不要用它回答用户的问题，也不要把它当作任务执行器。',
].join('\n')

/** 一次增强失败。code 与 WorkBuddy 保持一致，便于前端按码分支。 */
export class EnhanceError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'EnhancePromptError'
    this.code = code
  }
}

/** 读一个可能是 volatile Ref 的配置字段。 */
export function readConfigField(field, fallback) {
  if (field === undefined || field === null) return fallback
  if (typeof field.get === 'function') return field.get()
  return field
}

const Config = z.object({
  enabled: z.boolean().default(true),
  /** 空 = 自动挑一个可用 provider。 */
  provider: z.string().default(''),
  /** 空 = 取该 provider 的首个模型。 */
  model: z.string().default(''),
  /** 没配 provider 时的优先顺序（点名的排前面），例如 ['magpie']。 */
  providerPriority: z.array(z.string()).default([]),
  /** 候选链最多试几条路由（第一个 provider 的 key 失效时会自动往后试）。 */
  maxAttempts: z.number().default(6),
  temperature: z.number().default(0.3),
  /** 推理模型的 reasoning 也计入这个预算，太小会拿到空文本。 */
  maxTokens: z.number().default(4000),
  timeoutMs: z.number().default(60000),
  /** 少于这么多字符就当空输入（WorkBuddy 是 1）。 */
  minTextLength: z.number().default(1),
  /** 超长草稿直接截断，避免一次点击吃掉整窗上下文。 */
  maxInputChars: z.number().default(8000),
  /**
   * 'enhanced' = 我们优化后的提示词（默认，A/B 实测优于 WorkBuddy）；
   * 'workbuddy' = 逐字复刻的 Jr + Yr(input)；
   * 'system' = 规则进 system，user 纯文本。
   */
  promptStyle: z.string().default('enhanced'),
  /** 覆盖 system（promptStyle='system' 时生效）。 */
  customSystemPrompt: z.string().default(''),
  /** 覆盖 user 模板，用 {input} 占位（promptStyle='workbuddy' 时生效）。 */
  customUserTemplate: z.string().default(''),
  stripWrappingQuotes: z.boolean().default(true),
  stripCodeFence: z.boolean().default(true),
  /** 是否把能力公告写进系统提示词。 */
  announceToAgent: z.boolean().default(true),
  /** 是否注册 enhance_prompt 工具。 */
  toolsEnabled: z.boolean().default(true),
  /** 加载时跑一次自检（结果写日志），用于装机排障。 */
  selfTestOnStart: z.boolean().default(true),
})

export { Config }

export const inject = ['webServer', 'tools', 'llm', 'systemPrompt']

export function apply(ctx, config) {
  const cfg = () => ({
    enabled: readConfigField(config?.enabled, true),
    provider: readConfigField(config?.provider, '') ?? '',
    model: readConfigField(config?.model, '') ?? '',
    providerPriority: readConfigField(config?.providerPriority, []) ?? [],
    maxAttempts: readConfigField(config?.maxAttempts, 6),
    temperature: readConfigField(config?.temperature, 0.3),
    maxTokens: readConfigField(config?.maxTokens, 4000),
    timeoutMs: readConfigField(config?.timeoutMs, 60000),
    minTextLength: readConfigField(config?.minTextLength, 1),
    maxInputChars: readConfigField(config?.maxInputChars, 8000),
    promptStyle: readConfigField(config?.promptStyle, 'workbuddy'),
    customSystemPrompt: readConfigField(config?.customSystemPrompt, '') ?? '',
    customUserTemplate: readConfigField(config?.customUserTemplate, '') ?? '',
    stripWrappingQuotes: readConfigField(config?.stripWrappingQuotes, true),
    stripCodeFence: readConfigField(config?.stripCodeFence, true),
    announceToAgent: readConfigField(config?.announceToAgent, true),
    toolsEnabled: readConfigField(config?.toolsEnabled, true),
    selfTestOnStart: readConfigField(config?.selfTestOnStart, true),
  })

  /** provider/model 解析结果缓存：listModels 每次点击都问一遍太浪费。 */
  let routeCache = loadSavedRoute()

  /** 明确不可用的 provider（key 失效 / 余额不足 / 未授权）先冷一会儿，别每次都撞。 */
  const deadUntil = new Map()
  const DEAD_TTL_MS = 10 * 60 * 1000

  const isDead = (provider) => {
    const until = deadUntil.get(provider)
    if (!until) return false
    if (until <= Date.now()) {
      deadUntil.delete(provider)
      return false
    }
    return true
  }

  /** 这类错误说明 provider 本身不可用，短时间重试没有意义。 */
  const isProviderFatal = (message) =>
    /authentication fails|insufficient balance|invalid.*(api key|token)|unauthorized|401|permission denied/i.test(
      String(message ?? ''),
    )

  const log = (level, message, detail) => {
    fileLog(level, message, detail)
    const sink = ctx.logger?.[level] ?? ctx.logger?.info
    if (typeof sink !== 'function') return
    if (detail === undefined) sink.call(ctx.logger, `[enhancePrompt] ${message}`)
    else sink.call(ctx.logger, `[enhancePrompt] ${message}`, detail)
  }

  /**
   * 候选路由链。
   *
   * 宿主里往往挂着好几个 provider，排第一的那个未必能用（本机实测
   * deepseek-official 的 key 是失效的，回 Authentication Fails）。所以这里
   * 不"挑一个"，而是按优先级排出一串候选，enhance() 逐个试到成功为止：
   *   配置里点名的 → providerPriority 里点名的 → 其余按注册顺序。
   * 每个 provider 只取它的第一个模型，避免一次点击打十几次模型。
   */
  async function candidateRoutes(c) {
    const llm = ctx.get('llm')
    if (!llm || typeof llm.stream !== 'function') {
      throw new EnhanceError('llm_unavailable', 'the llm service is unavailable in this runtime')
    }
    const out = []
    const push = (route) => {
      if (!route || !route.provider || !route.model) return
      if (out.some((r) => r.provider === route.provider && r.model === route.model)) return
      out.push(route)
    }
    const modelsOf = async (id) => {
      try {
        const models = await llm.listModels(id)
        return (models ?? []).filter((m) => m && typeof m.id === 'string' && m.id.length > 0)
      } catch (error) {
        log('warn', `listModels failed for provider ${id}`, error instanceof Error ? error.message : error)
        return []
      }
    }

    // 1) 配置点名的路由
    const cfgProvider = String(c.provider ?? '').trim()
    const cfgModel = String(c.model ?? '').trim()
    if (cfgProvider && cfgModel) push({ provider: cfgProvider, model: cfgModel })
    else if (cfgProvider) for (const m of await modelsOf(cfgProvider)) push({ provider: cfgProvider, model: m.id })

    // 2) 上次成功过的路由（仍然排在配置之后、其它 provider 之前）
    if (routeCache) push(routeCache)

    // 3) 其余 provider：providerPriority 里点名的先来
    const ids = (typeof llm.listProviders === 'function' ? llm.listProviders() : [])
      .map((p) => p?.id ?? p?.provider)
      .filter((id) => typeof id === 'string' && id.length > 0)
    const priority = Array.isArray(c.providerPriority) ? c.providerPriority.filter((x) => typeof x === 'string') : []
    const ranked = [
      ...priority.filter((id) => ids.includes(id)),
      ...ids.filter((id) => !priority.includes(id)),
    ]
    for (const id of ranked) {
      if (cfgModel && !cfgProvider) push({ provider: id, model: cfgModel })
      else {
        const models = await modelsOf(id)
        const first = models[0]
        if (first) push({ provider: id, model: first.id })
      }
    }

    if (out.length === 0) throw new EnhanceError('llm_unavailable', 'no provider/model route could be resolved')
    // 刚撞过的死 provider 排到后面去（不是删掉：全都死了还得靠它们兜底）
    const alive = out.filter((route) => !isDead(route.provider))
    const finalRoutes = alive.length > 0 ? [...alive, ...out.filter((route) => isDead(route.provider))] : out
    log('info', 'candidate routes', finalRoutes)
    return finalRoutes
  }

  /** 走 prepareCall 的一次性流（llm/stream 监听器仍然会跑到）。 */
  async function openStream(llm, call, request) {
    if (typeof llm.prepareCall !== 'function') return llm.stream({ ...call, ...request })
    const prepared = await llm.prepareCall(call, request.signal)
    return prepared.stream({ ...prepared.config, ...request })
  }

  /** 对一条路由做一次完整调用（流式累加）。失败抛 EnhanceError。 */
  async function callRoute(llm, route, { system, userMessage, c, signal }) {
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(new Error('enhance-prompt timed out')), c.timeoutMs)
    const forward = () => timeout.abort(signal?.reason)
    signal?.addEventListener?.('abort', forward, { once: true })

    const started = Date.now()
    let reply = ''
    let usage = null
    let finishKind = null
    try {
      const stream = await openStream(
        llm,
        {
          provider: route.provider,
          model: route.model,
          ...(Number.isFinite(c.temperature) ? { temperature: c.temperature } : {}),
          ...(Number.isFinite(c.maxTokens) ? { maxTokens: c.maxTokens } : {}),
        },
        {
          system,
          messages: [
            createUserMessage({
              content: [{ type: 'text', text: userMessage }],
              source: { kind: 'user' },
            }),
          ],
          signal: timeout.signal,
        },
      )
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') reply += chunk.text
        else if (chunk.type === 'usage') usage = chunk.usage
        else if (chunk.type === 'finish') {
          finishKind = chunk.reason?.kind ?? null
          if (finishKind === 'error') {
            const failure = chunk.reason?.failure
            throw new EnhanceError('llm_error', failure?.message ?? String(failure ?? 'model call failed'))
          }
        }
      }
    } catch (error) {
      if (error instanceof EnhanceError) throw error
      if (timeout.signal.aborted) {
        throw new EnhanceError('timeout', `the model did not answer within ${Math.round(c.timeoutMs / 1000)}s`)
      }
      throw new EnhanceError('llm_error', error instanceof Error ? error.message : String(error))
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', forward)
    }

    const enhanced = sanitizeOutput(reply, {
      stripFence: c.stripCodeFence,
      stripQuotes: c.stripWrappingQuotes,
    })
    log('info', 'route ok', {
      route,
      ms: Date.now() - started,
      finishKind,
      rawLen: reply.length,
      outLen: enhanced.length,
      usage,
    })
    if (enhanced === '') throw new EnhanceError('llm_error', 'Enhanced result is empty')
    return { text: enhanced, provider: route.provider, model: route.model }
  }

  /** 一次增强：沿候选链逐个试，返回 { text, provider, model }。 */
  async function enhance(rawText, options = {}) {
    const c = cfg()
    if (!c.enabled) throw new EnhanceError('disabled', 'the enhance-prompt plugin is disabled')

    const source = String(rawText ?? '')
    const text = source.length > c.maxInputChars ? source.slice(0, c.maxInputChars) : source
    if (text.trim().length < Math.max(1, c.minTextLength)) {
      throw new EnhanceError('empty_input', 'Empty input')
    }

    const llm = ctx.get('llm')
    const cOverride =
      options.provider && options.model ? { ...c, provider: options.provider, model: options.model } : c
    const candidates = await candidateRoutes(cOverride)

    const style = c.promptStyle === 'workbuddy' || c.promptStyle === 'system' ? c.promptStyle : 'enhanced'
    const system =
      style === 'system'
        ? c.customSystemPrompt.trim() !== ''
          ? c.customSystemPrompt
          : SYSTEM_STYLE_SYSTEM
        : style === 'workbuddy'
          ? WORKBUDDY_SYSTEM
          : ENHANCED_SYSTEM
    const userTemplate =
      style === 'workbuddy'
        ? c.customUserTemplate.trim() !== ''
          ? c.customUserTemplate
          : WORKBUDDY_USER_TEMPLATE
        : ENHANCED_USER_TEMPLATE
    const userMessage = style === 'system' ? text : renderUserPrompt(userTemplate, text)

    const limit = Math.max(1, Number(c.maxAttempts) || 1)
    let lastError = null
    let tried = 0
    for (const route of candidates) {
      if (tried >= limit) break
      if (options.signal?.aborted) throw new EnhanceError('timeout', 'the request was aborted')
      tried++
      try {
        const result = await callRoute(llm, route, { system, userMessage, c, signal: options.signal })
        routeCache = route
        saveSavedRoute(route)
        return result
      } catch (error) {
        lastError = error
        const code = error instanceof EnhanceError ? error.code : 'llm_error'
        const message = error instanceof Error ? error.message : String(error)
        log('warn', `route failed (${tried}/${limit}): ${route.provider}/${route.model}`, `${code}: ${message}`)
        if (isProviderFatal(message)) {
          deadUntil.set(route.provider, Date.now() + DEAD_TTL_MS)
          log('info', `provider cooling down ${Math.round(DEAD_TTL_MS / 60000)}min: ${route.provider}`)
        }
        if (code === 'timeout' || options.signal?.aborted) break
      }
    }
    throw lastError ?? new EnhanceError('llm_error', 'every candidate route failed')
  }

  // ---------------------------------------------------------------- HTTP 路由

  const readJsonBody = (req, limit = 1024 * 1024) =>
    new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          reject(new EnhanceError('too_large', 'request body is too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        if (raw.trim() === '') return resolve({})
        try {
          const parsed = JSON.parse(raw)
          resolve(parsed && typeof parsed === 'object' ? parsed : {})
        } catch {
          reject(new EnhanceError('bad_request', 'the request body is not valid JSON'))
        }
      })
      req.on('error', reject)
    })

  const sendJson = (res, status, payload) => {
    if (res.writableEnded) return
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(payload))
  }

  const webServer = ctx.get('webServer')

  /** 注册一条路由，失败不拖垮插件（写日志，方便用日志定位冲突）。 */
  const registerRoute = (route, label) => {
    try {
      ctx.effect(() => webServer.register(route), label)
      log('info', `route registered: ${route.path}`)
      return true
    } catch (error) {
      log('error', `route registration failed: ${route.path}`, error instanceof Error ? error.message : error)
      return false
    }
  }

  if (webServer && typeof webServer.register === 'function') {
    const enhanceHandler = async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      // 前端关掉请求（取消/关标签页）时把模型调用一起掐掉。
      // 注意必须挂 res 的 close：Node 16 起 req 的 'close' 在请求体读完时就会
      // 触发（不是"连接断了"），挂 req 会在读完 body 的瞬间把自己 abort 掉，
      // 表现为每个请求都立刻 timeout。
      const abort = new AbortController()
      res.on('close', () => {
        if (!res.writableEnded) abort.abort(new Error('client disconnected'))
      })
      try {
        const body = await readJsonBody(req)
        log('info', 'POST enhance', { len: typeof body.text === 'string' ? body.text.length : -1 })
        const result = await enhance(body.text, {
          provider: typeof body.provider === 'string' ? body.provider : undefined,
          model: typeof body.model === 'string' ? body.model : undefined,
          signal: abort.signal,
        })
        sendJson(res, 200, { success: true, ...result })
      } catch (error) {
        const code = error instanceof EnhanceError ? error.code : 'llm_error'
        const message = error instanceof Error ? error.message : String(error)
        const status = code === 'empty_input' || code === 'bad_request' || code === 'too_large' ? 400 : 502
        if (code !== 'empty_input') log('warn', `enhance failed: ${code}`, message)
        sendJson(res, status, { success: false, text: '', code, error: message })
      }
    }

    const infoHandler = (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' })
        res.end()
        return
      }
      const c = cfg()
      sendJson(res, 200, {
        success: true,
        version: '0.3.0',
        enabled: c.enabled,
        minTextLength: Math.max(1, c.minTextLength),
        maxInputChars: c.maxInputChars,
        promptStyle: c.promptStyle,
        configuredProvider: c.provider || null,
        configuredModel: c.model || null,
        route: routeCache,
      })
    }

    /** 客户端排障上报：把浏览器侧的失败原因写进同一份日志。 */
    const reportHandler = async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      try {
        const body = await readJsonBody(req, 64 * 1024)
        log('client', 'report', body)
      } catch {
        /* 上报失败无所谓 */
      }
      sendJson(res, 200, { ok: true })
    }

    /** 自检：GET 时真跑一次增强，把结果写日志并回显（只在回环地址上可用）。 */
    const selfTestHandler = async (req, res) => {
      const started = Date.now()
      try {
        const result = await enhance('帮我写个爬虫')
        sendJson(res, 200, { ok: true, ms: Date.now() - started, ...result })
      } catch (error) {
        const code = error instanceof EnhanceError ? error.code : 'llm_error'
        const message = error instanceof Error ? error.message : String(error)
        sendJson(res, 502, { ok: false, code, error: message, ms: Date.now() - started })
      }
    }

    registerRoute({ kind: 'exact', path: `${API_PREFIX}/enhance`, handler: enhanceHandler }, 'enhance-prompt: POST enhance')
    registerRoute({ kind: 'exact', path: `${API_PREFIX}/info`, handler: infoHandler }, 'enhance-prompt: GET info')
    registerRoute({ kind: 'exact', path: `${API_PREFIX}/report`, handler: reportHandler }, 'enhance-prompt: POST report')
    registerRoute({ kind: 'exact', path: `${API_PREFIX}/selftest`, handler: selfTestHandler }, 'enhance-prompt: GET selftest')
    // 老路径别名：早期版本的客户端还在用 /api/enhance-prompt/*。
    registerRoute({ kind: 'exact', path: `${LEGACY_PREFIX}/enhance`, handler: enhanceHandler }, 'enhance-prompt: legacy enhance')
    registerRoute({ kind: 'exact', path: `${LEGACY_PREFIX}/info`, handler: infoHandler }, 'enhance-prompt: legacy info')
  } else {
    log('warn', 'webServer is unavailable; only the enhance_prompt tool will work')
  }

  // ------------------------------------------------------------------ 模型工具

  ctx.effect(() => {
    if (!cfg().toolsEnabled) return () => {}
    const tools = ctx.get('tools')
    if (!tools || typeof tools.register !== 'function') {
      log('warn', 'tools service is unavailable; enhance_prompt is not registered')
      return () => {}
    }
    return tools.register(
      defineTool({
        name: 'enhance_prompt',
        description:
          'Rewrite a rough prompt into a clearer, more specific one, preserving the original intent and language. Returns only the enhanced text. Use it when the user explicitly asks to enhance/polish a prompt, never to answer the prompt itself.',
        parameters: {
          text: { type: 'string', required: true, description: 'The prompt to enhance.' },
          provider: { type: 'string', description: 'Optional llm provider override.' },
          model: { type: 'string', description: 'Optional model override.' },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute(args, exec) {
          const result = await enhance(args.text, {
            provider: typeof args.provider === 'string' ? args.provider : undefined,
            model: typeof args.model === 'string' ? args.model : undefined,
            signal: exec?.signal,
          })
          return result.text
        },
      }),
    )
  })

  // -------------------------------------------------------------- 系统提示词

  let disposeSection
  const syncSection = () => {
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
    routeCache = null
    syncSection()
  })
  ctx.on('llm/adapters-updated', () => {
    routeCache = null
  })

  // 插件卸载时把系统提示词小节一起摘掉（路由与工具由 ctx.effect 自己收）。
  ctx.effect(() => () => {
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
  })

  // ------------------------------------------------------------------ 启动自检

  if (cfg().selfTestOnStart) {
    const timer = setTimeout(() => {
      const started = Date.now()
      enhance('帮我写个爬虫')
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

  log('info', 'ready', { version: '0.3.0', logFile: LOG_FILE })
}

export const name = 'dsh-enhance-prompt'

export default { apply, inject, Config, name }
