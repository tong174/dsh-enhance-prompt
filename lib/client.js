/**
 * dsh-enhance-prompt — 浏览器半边（v0.4.0）。
 *
 * 在输入框右侧挂一个四角星按钮：
 *   点一下 → 把草稿发给宿主改写 → 结果写回输入框
 *   再点一下（成功后变成回环箭头）→ 恢复原文
 *
 * 三条硬约束（踩过的坑，别改）：
 *   1. client bundle 必须自己包一层 IIFE：宿主把多个插件源码拼进同一个 <script>，
 *      顶层 const 会互相冲突。
 *   2. id 必须等于包名，否则宿主不认。
 *   3. 组件类型必须是模块级常量：写成内联箭头函数的话每次 render 都换类型，
 *      宿主会把输入框整块重挂。
 *
 * v0.4.0 的改动集中在「失败要说人话」：
 *   - 每个请求带 x-dsh-enhance 头（宿主侧默认要求，挡跨站请求）
 *   - 错误按 code 翻成人话，红色图标 hover 就能看懂原因
 *   - 红点不会永远挂着：10 秒自动回落，点一下重试
 *   - 空草稿不再报错（不红、不亮）
 */
;(function () {
  const loader = window.__ModuleLoader__
  if (!loader || typeof loader.load !== 'function') {
    // 宿主没注入 loader：说明这不是 DSH 的页面，静默退出比抛错更安全。
    return
  }

  loader.load({
    id: 'dsh-enhance-prompt',
    factory(require) {
      var module = { exports: {} }
      var exports = module.exports
      ;(function (exports, module, require) {
        const React = require('react')

        const API_PREFIX = '/dsh-enhance-prompt'

        /** 宿主侧默认要求这个头（CSRF 守卫）。跨站 fetch 带自定义头会触发 preflight。 */
        const REQUEST_HEADER = 'x-dsh-enhance'

        /** 成功后多久开始检测「用户是不是又自己改了」 —— 太短会把写回本身当成用户编辑。 */
        const DIVERGE_GRACE_MS = 1200
        /** 错误态静置多久自动回落成 idle（避免永远红着）。 */
        const ERROR_RESET_MS = 10000
        /** 每次页面加载最多上报多少条诊断（日志端点不该被刷爆）。 */
        const REPORT_LIMIT = 20

        /**
         * 子路径部署时反推前缀：script 是 <base>/plugins/<pkg>/client.js，
         * 所以取到 /plugins/ 之前的部分。根部署返回空串。
         */
        function detectAppBase(doc) {
          try {
            const current = doc.currentScript && doc.currentScript.src
            const scripts = current ? [current] : Array.from(doc.querySelectorAll('script[src]')).map((s) => s.src)
            for (const src of scripts) {
              if (!src) continue
              const match = /^(.*?)\/plugins\//.exec(String(src))
              if (match) return match[1]
            }
          } catch {
            /* 忽略 */
          }
          return ''
        }

        const APP_BASE = detectAppBase(document)
        const apiPath = (suffix) => `${APP_BASE}${API_PREFIX}${suffix}`

        let reportCount = 0

        /** 尽力而为的客户端上报：失败完全静默，绝不影响主流程。 */
        function report(stage, detail) {
          if (reportCount >= REPORT_LIMIT) return
          reportCount += 1
          try {
            fetch(apiPath('/report'), {
              method: 'POST',
              headers: { 'content-type': 'application/json', [REQUEST_HEADER]: '1' },
              body: JSON.stringify({
                stage,
                href: String(location && location.href),
                appBase: APP_BASE,
                ua: String(navigator && navigator.userAgent),
                ...detail,
              }),
              keepalive: true,
            }).catch(() => {})
          } catch {
            /* 忽略 */
          }
        }

        const TEXT = {
          zh: {
            title: '增强提示词',
            busyTitle: '正在增强…',
            revertTitle: '恢复原文',
            failedTitle: '增强失败',
            retryTitle: '点击重试',
            empty: '先输入一点内容再点这里',
            noDraft: '这里没有可增强的草稿',
            // code → 人话
            busy: '请求太频繁，稍等一下',
            timeout: '模型响应超时，请重试',
            disabled: '插件已被禁用',
            forbidden: '请求被宿主拒绝',
            empty_input: '草稿是空的',
            too_large: '草稿太长了',
            not_loaded: '插件服务未就绪',
            no_route: '没有可用的模型',
            network: '连不上宿主服务',
            unknown: '未知错误',
          },
          en: {
            title: 'Enhance prompt',
            busyTitle: 'Enhancing…',
            revertTitle: 'Restore original',
            failedTitle: 'Enhance failed',
            retryTitle: 'Click to retry',
            empty: 'Type something first',
            noDraft: 'Nothing to enhance',
            busy: 'Too many requests, try again shortly',
            timeout: 'Model timed out, please retry',
            disabled: 'Plugin is disabled',
            forbidden: 'Request rejected by the host',
            empty_input: 'The draft is empty',
            too_large: 'The draft is too long',
            not_loaded: 'Plugin service is not ready',
            no_route: 'No model available',
            network: 'Cannot reach the host service',
            unknown: 'Unknown error',
          },
        }

        const locale = String((navigator && navigator.language) || 'en')
        const t = /^zh/i.test(locale) ? TEXT.zh : TEXT.en

        /** 把宿主/网络错误翻成一句人话（红点 hover 就能看懂）。 */
        function describe(code, fallback) {
          if (code && Object.prototype.hasOwnProperty.call(t, code)) return t[code]
          if (typeof code === 'string' && code.startsWith('http_')) {
            if (code.includes('404') || code.includes('405')) return t.not_loaded
            return t.forbidden
          }
          if (typeof fallback === 'string' && fallback !== '') {
            return fallback.length > 90 ? `${fallback.slice(0, 90)}…` : fallback
          }
          return t.unknown
        }

        // ------------------------------------------------------------------ 样式

        const STYLE_ID = 'dsh-enhance-prompt-style'
        const CSS = `
.dsh-enhance-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; padding: 0; border: none; border-radius: 8px;
  background: transparent; color: currentColor; cursor: pointer;
  opacity: .62; transition: opacity .12s ease, background-color .12s ease, color .12s ease;
}
.dsh-enhance-btn:hover:not(:disabled) { opacity: 1; background: rgba(127,157,255,.14); }
.dsh-enhance-btn:focus-visible { outline: 2px solid rgba(127,157,255,.7); outline-offset: 1px; opacity: 1; }
.dsh-enhance-btn:disabled { cursor: default; }
.dsh-enhance-btn[data-phase="loading"] { opacity: 1; color: #7f9dff; }
.dsh-enhance-btn[data-phase="done"] { opacity: 1; color: #7f9dff; }
.dsh-enhance-btn[data-phase="error"] { opacity: 1; color: #e5674f; }
.dsh-enhance-btn[data-phase="error"]:hover { background: rgba(229,103,79,.14); }
.dsh-enhance-btn[data-flash="1"] { animation: dshEnhanceShake .32s ease; }
.dsh-enhance-spin { animation: dshEnhanceSpin .9s linear infinite; transform-origin: 12px 12px; }
@keyframes dshEnhanceSpin { to { transform: rotate(360deg); } }
@keyframes dshEnhanceShake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-2px); }
  75% { transform: translateX(2px); }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-enhance-spin, .dsh-enhance-btn[data-flash="1"] { animation: none; }
}
`

        /** 幂等插入样式，返回移除函数。 */
        function ensureStyle(doc) {
          const head = doc.head || doc.documentElement
          if (!head) return () => {}
          let el = doc.getElementById(STYLE_ID)
          let created = false
          if (!el) {
            el = doc.createElement('style')
            el.id = STYLE_ID
            el.textContent = CSS
            head.appendChild(el)
            created = true
          }
          return () => {
            if (!created) return
            try {
              el.remove()
            } catch {
              /* 忽略 */
            }
          }
        }

        // ------------------------------------------------------------------ 图标

        function SparkleIcon() {
          return React.createElement(
            'svg',
            { width: 16, height: 16, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
            React.createElement('path', {
              fill: 'currentColor',
              d: 'M12 2.6l2.34 6.9 6.9 2.34-6.9 2.34L12 21.08l-2.34-6.9-6.9-2.34 6.9-2.34z',
            }),
          )
        }

        function SpinnerIcon() {
          return React.createElement(
            'svg',
            { width: 16, height: 16, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false', className: 'dsh-enhance-spin' },
            React.createElement('circle', {
              cx: 12,
              cy: 12,
              r: 8.2,
              fill: 'none',
              stroke: 'currentColor',
              strokeOpacity: 0.25,
              strokeWidth: 2,
            }),
            React.createElement('path', {
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 2,
              strokeLinecap: 'round',
              d: 'M12 3.8a8.2 8.2 0 0 1 8.2 8.2',
            }),
          )
        }

        function RevertIcon() {
          return React.createElement(
            'svg',
            { width: 16, height: 16, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
            React.createElement('path', {
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 2,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              d: 'M4 9h9.5a5 5 0 1 1 0 10H7M4 9l4-4M4 9l4 4',
            }),
          )
        }

        function WarnIcon() {
          return React.createElement(
            'svg',
            { width: 16, height: 16, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
            React.createElement('path', {
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 2,
              strokeLinejoin: 'round',
              d: 'M12 4.5l8 14H4z',
            }),
            React.createElement('path', {
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 2,
              strokeLinecap: 'round',
              d: 'M12 9.5v4',
            }),
            React.createElement('circle', { cx: 12, cy: 16.4, r: 0.9, fill: 'currentColor' }),
          )
        }

        // -------------------------------------------------------------- 主组件

        function EnhanceButton(props) {
          const useLiveInput = props.useInput
          const actions = props.inputActions

          const live = typeof useLiveInput === 'function' ? useLiveInput((s) => s) : null
          const draft = live && typeof live.draft === 'string' ? live.draft : ''

          const [phase, setPhase] = React.useState('idle') // idle | loading | done | error
          const [error, setError] = React.useState('')
          const [flash, setFlash] = React.useState(false)

          const abortRef = React.useRef(null)
          const graceRef = React.useRef(0)
          const backupRef = React.useRef('')
          const enhancedRef = React.useRef('')
          const aliveRef = React.useRef(true)
          const mountedRef = React.useRef(false)
          const phaseRef = React.useRef(phase)

          phaseRef.current = phase

          // 挂载：装样式已经由 apply() 做过，这里只上报一次运行时形状，
          // 排查「宿主到底给了什么 props」时全靠这一条。
          React.useEffect(() => {
            aliveRef.current = true
            if (!mountedRef.current) {
              mountedRef.current = true
              report('mount', {
                hasActions: Boolean(actions),
                actionKeys: actions ? Object.keys(actions) : [],
                hasUseInput: typeof useLiveInput === 'function',
                draftLen: draft.length,
              })
            }
            return () => {
              aliveRef.current = false
              const controller = abortRef.current
              if (controller) {
                try {
                  controller.abort()
                } catch {
                  /* 忽略 */
                }
              }
            }
            // eslint-disable-next-line react-hooks/exhaustive-deps
          }, [])

          // 写完草稿之后，用户只要自己动手改，就把「恢复原文」的机会收回去
          // （等价于 WorkBuddy 的 onContentDiverged）。留 1.2s 宽限期，
          // 否则写回那一刻的 draft 变化会被误判成用户编辑。
          React.useEffect(() => {
            if (phase !== 'done') return undefined
            if (draft === enhancedRef.current) return undefined
            const wait = Math.max(0, graceRef.current - Date.now()) + 400
            const timer = setTimeout(() => {
              if (!aliveRef.current) return
              setPhase('idle')
              backupRef.current = ''
              enhancedRef.current = ''
            }, wait)
            return () => clearTimeout(timer)
          }, [phase, draft])

          // 红点不常驻：静置一段时间自动回落，用户点一下也能重试。
          React.useEffect(() => {
            if (phase !== 'error') return undefined
            const timer = setTimeout(() => {
              if (aliveRef.current) setPhase('idle')
            }, ERROR_RESET_MS)
            return () => clearTimeout(timer)
          }, [phase, error])

          React.useEffect(() => {
            if (!flash) return undefined
            const timer = setTimeout(() => setFlash(false), 340)
            return () => clearTimeout(timer)
          }, [flash])

          function writeDraft(value) {
            if (!actions || typeof actions.setDraft !== 'function') {
              report('writeDraft', { error: 'setDraft missing', actionKeys: actions ? Object.keys(actions) : [] })
              return false
            }
            try {
              actions.setDraft(value)
              if (typeof actions.persistDraft === 'function') actions.persistDraft()
              return true
            } catch (err) {
              report('writeDraft', {
                error: err instanceof Error ? err.message : String(err),
                actionKeys: Object.keys(actions),
              })
              return false
            }
          }

          function fail(code, message, stage, extra) {
            if (!aliveRef.current) return
            const human = describe(code, message)
            setError(human)
            setPhase('error')
            report(stage || 'request', { code, error: message, human, ...extra })
          }

          async function runEnhance() {
            const before = draft
            if (before.trim() === '') {
              // 空草稿不是错误：抖一下让用户知道按钮活着，别把图标点红。
              setFlash(true)
              setPhase('idle')
              return
            }

            const previous = abortRef.current
            if (previous) {
              try {
                previous.abort()
              } catch {
                /* 忽略 */
              }
            }
            const controller = new AbortController()
            abortRef.current = controller

            setPhase('loading')
            setError('')
            const started = Date.now()

            try {
              const response = await fetch(apiPath('/enhance'), {
                method: 'POST',
                headers: { 'content-type': 'application/json', [REQUEST_HEADER]: '1' },
                body: JSON.stringify({ text: before }),
                signal: controller.signal,
              })
              let data = null
              try {
                data = await response.json()
              } catch {
                data = null
              }
              if (!aliveRef.current) return

              if (!response.ok || !data || data.success !== true || typeof data.text !== 'string') {
                fail(
                  (data && data.code) || `http_${response.status}`,
                  (data && data.error) || '',
                  'request',
                  { status: response.status, ms: Date.now() - started, draftLen: before.length },
                )
                return
              }

              const text = data.text
              graceRef.current = Date.now() + DIVERGE_GRACE_MS
              backupRef.current = before
              enhancedRef.current = text
              setPhase('done')

              if (!writeDraft(text)) {
                fail('forbidden', 'cannot write to the input box', 'writeback', {
                  provider: data.provider,
                  ms: Date.now() - started,
                })
                return
              }
              report('ok', {
                ms: Date.now() - started,
                draftLen: before.length,
                textLen: text.length,
                provider: data.provider || null,
                cached: data.cached === true,
              })
            } catch (err) {
              if (controller.signal.aborted) return
              const message = err instanceof Error ? err.message : String(err)
              fail('network', message, 'throw', { ms: Date.now() - started, draftLen: before.length })
            }
          }

          function runRevert() {
            const backup = backupRef.current
            if (backup !== '') writeDraft(backup)
            setPhase('idle')
            setError('')
            backupRef.current = ''
            enhancedRef.current = ''
          }

          function onClick() {
            if (phase === 'done') {
              runRevert()
              return
            }
            // error 态点击 = 重试；idle 态点击 = 增强。
            void runEnhance()
          }

          const isBusy = phase === 'loading'
          let label = t.title
          if (phase === 'loading') label = t.busyTitle
          else if (phase === 'done') label = t.revertTitle
          else if (phase === 'error') label = `${t.failedTitle}：${error || t.unknown}（${t.retryTitle}）`

          let icon
          if (phase === 'loading') icon = React.createElement(SpinnerIcon, null)
          else if (phase === 'done') icon = React.createElement(RevertIcon, null)
          else if (phase === 'error') icon = React.createElement(WarnIcon, null)
          else icon = React.createElement(SparkleIcon, null)

          return React.createElement(
            'button',
            {
              type: 'button',
              className: 'dsh-enhance-btn',
              'data-phase': phase,
              'data-flash': flash ? '1' : '0',
              title: label,
              'aria-label': label,
              'aria-busy': isBusy ? 'true' : 'false',
              'aria-disabled': isBusy ? 'true' : 'false',
              disabled: isBusy,
              onClick,
            },
            icon,
          )
        }

        // ------------------------------------------------------------------ 装配

        function apply(ctx) {
          if (!ctx || typeof ctx.get !== 'function') return
          const slots = ctx.get('slots')
          if (!slots || typeof slots.inject !== 'function') return

          if (typeof ctx.effect === 'function') {
            ctx.effect(() => ensureStyle(document))
          } else {
            ensureStyle(document)
          }

          ctx.effect(() =>
            slots.inject('conversation.input.right', () =>
              slots.register(
                {
                  name: 'conversation.input.right',
                  id: 'enhance-prompt',
                  order: 20,
                  label: t.title,
                },
                // 必须传入稳定引用：这里用模块级常量 EnhanceButton，
                // 写成内联组件会让宿主每帧重挂输入框。
                (slotProps) =>
                  React.createElement(EnhanceButton, {
                    inputActions: slotProps && slotProps.inputActions,
                    useInput: slotProps && slotProps.useInput,
                  }),
              ),
            ),
          )
        }

        exports.apply = apply
        exports.inject = ['slots']
        exports.EnhanceButton = EnhanceButton
      })(module.exports, module, require)
      return module.exports
    },
  })
})()
