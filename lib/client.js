/**
 * dsh-enhance-prompt — 浏览器半边。
 *
 * 复刻 WorkBuddy 输入框的「增强提示词」按钮：
 *   草稿 → 点四角星 → 增强中… → 写回输入框；写完按钮变成「恢复原文」，点一下退回原稿。
 *   用户自己动手改了字就等同于放弃这次增强（恢复按钮消失），与 WorkBuddy 的
 *   onContentDiverged 行为一致。
 *
 * 载入方式是 dsh.client bundle 格式（window.__ModuleLoader__.load）：
 * id 必须等于 profile 里那一行的 loader entry 名，否则 ModuleLoader 会报
 * "loaded without registering <id>"。
 */
window.__ModuleLoader__.load({
  id: 'dsh-enhance-prompt',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /**
     * 宿主接口前缀。
     *
     * /api/* 是宿主 api-gateway 的保留面（没带鉴权一律 401），插件路由挂在
     * /dsh-enhance-prompt/*（同 dsh-meme 的 /dsh-memes-api 做法）。旧的
     * /api/enhance-prompt/* 留作回退，老页面不刷新也能用。
     */
    const API_PREFIX = '/dsh-enhance-prompt'
    const LEGACY_PREFIX = '/api/enhance-prompt'

    /**
     * 子路径部署（反代挂在 /app/<id>/ 下）时站内接口也要带同一前缀，
     * 否则请求会落到 SPA 兜底上拿回 index.html。前缀从加载本 bundle 的
     * <script src> 反推，根路径部署时是空串。
     */
    const detectAppBase = (doc) => {
      const strip = (p) => String(p || '').replace(/\/+$/, '')
      const fromPath = (p) => {
        const m = /^(.*?)\/plugins\//.exec(String(p || ''))
        return m ? strip(m[1]) : null
      }
      if (!doc) return ''
      try {
        const src = doc.currentScript && doc.currentScript.src
        if (src) {
          const base = fromPath(new URL(src, doc.baseURI || location.href).pathname)
          if (base !== null) return base
        }
      } catch (error) {
        /* 非浏览器 / 非脚本方式加载 */
      }
      try {
        for (const el of doc.querySelectorAll('script[src]')) {
          const base = fromPath(new URL(el.src, doc.baseURI || location.href).pathname)
          if (base !== null) return base
        }
      } catch (error) {
        /* 极简 DOM */
      }
      return ''
    }

    const APP_BASE = detectAppBase(typeof document === 'undefined' ? null : document)
    const apiPath = (suffix) => APP_BASE + API_PREFIX + suffix
    const legacyPath = (suffix) => APP_BASE + LEGACY_PREFIX + suffix

    /** 排障上报：把浏览器侧的失败原因写进宿主日志（~/.dsh/enhance-prompt.log）。 */
    const report = (payload) => {
      try {
        fetch(apiPath('/report'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...payload, href: String(location.href), appBase: APP_BASE }),
          keepalive: true,
        }).catch(() => {})
      } catch {
        /* 上报失败不影响主流程 */
      }
    }

    /**
     * 打增强接口。先走 /dsh-enhance-prompt，404/401/405 时回退到老路径，
     * 两个都失败就把状态码交给调用方报错。
     */
    const postEnhance = async (text, signal) => {
      const attempt = async (url) => {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
          signal,
        })
        const data = await response.json().catch(() => ({}))
        return { status: response.status, data }
      }
      let result = await attempt(apiPath('/enhance'))
      if (result.status === 404 || result.status === 401 || result.status === 405) {
        const legacy = await attempt(legacyPath('/enhance'))
        if (legacy.status !== 404 && legacy.status !== 401 && legacy.status !== 405) result = legacy
        else
          result = {
            status: legacy.status,
            data: {
              success: false,
              code: `http_${result.status}/${legacy.status}`,
              error: `enhance endpoint not reachable (${result.status} on ${API_PREFIX}, ${legacy.status} on ${LEGACY_PREFIX})`,
            },
          }
      }
      return result
    }

    const TEXT = {
      zh: {
        title: '增强提示词',
        enhancing: '增强中…',
        revert: '恢复原文',
        failed: '增强失败',
        empty: '先写点内容再增强',
        retry: '再试一次',
      },
      en: {
        title: 'Enhance prompt',
        enhancing: 'Enhancing…',
        revert: 'Restore original',
        failed: 'Enhance failed',
        empty: 'Write something first',
        retry: 'Try again',
      },
    }
    const locale = String((typeof navigator !== 'undefined' && navigator.language) || 'zh')
    const t = /^zh/i.test(locale) ? TEXT.zh : TEXT.en

    /** 每次页面加载只上报一次挂载，避免重挂时刷日志。 */
    let mountReported = false

    const STYLE_ID = 'dsh-enhance-prompt-style'
    const CSS = [
      '@keyframes dshEnhanceSpin{to{transform:rotate(360deg)}}',
      '.dsh-enhance-btn{display:inline-flex;align-items:center;justify-content:center;',
      'width:26px;height:26px;padding:0;border:none;border-radius:8px;background:transparent;',
      'color:inherit;cursor:pointer;opacity:.62;transition:background .15s,opacity .15s,color .15s;',
      'flex:0 0 auto;line-height:0}',
      '.dsh-enhance-btn:hover:not(:disabled){background:rgba(127,127,127,.18);opacity:1}',
      '.dsh-enhance-btn:disabled{cursor:default}',
      '.dsh-enhance-btn[data-phase="loading"]{opacity:.9}',
      '.dsh-enhance-btn[data-phase="done"]{opacity:1;color:#7f9dff}',
      '.dsh-enhance-btn[data-phase="error"]{color:#e5674f;opacity:1}',
      '.dsh-enhance-spin{animation:dshEnhanceSpin .9s linear infinite;transform-origin:50% 50%}',
    ].join('')

    function ensureStyle(doc) {
      if (!doc) return () => {}
      if (doc.getElementById(STYLE_ID)) return () => {}
      const el = doc.createElement('style')
      el.id = STYLE_ID
      el.textContent = CSS
      ;(doc.head || doc.documentElement).appendChild(el)
      return () => {
        if (el.parentNode) el.parentNode.removeChild(el)
      }
    }

    /** WorkBuddy 的 EnhanceIcon 是四角星火花，这里同款几何。 */
    function SparkleIcon({ size = 15, color = 'currentColor' }) {
      return React.createElement(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
        React.createElement('path', {
          d: 'M12 2.6l2.34 6.9 6.9 2.34-6.9 2.34L12 21.08l-2.34-6.9-6.9-2.34 6.9-2.34z',
          fill: color,
        }),
      )
    }

    function SpinnerIcon({ size = 15, color = 'currentColor' }) {
      return React.createElement(
        'svg',
        {
          className: 'dsh-enhance-spin',
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        React.createElement('circle', {
          cx: 12,
          cy: 12,
          r: 8.2,
          fill: 'none',
          stroke: color,
          strokeWidth: 2.4,
          strokeOpacity: 0.25,
        }),
        React.createElement('path', {
          d: 'M12 3.8a8.2 8.2 0 0 1 8.2 8.2',
          fill: 'none',
          stroke: color,
          strokeWidth: 2.4,
          strokeLinecap: 'round',
        }),
      )
    }

    function RevertIcon({ size = 15, color = 'currentColor' }) {
      return React.createElement(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
        React.createElement('path', {
          d: 'M4.4 9.2A8.2 8.2 0 1 1 4.9 15.4',
          fill: 'none',
          stroke: color,
          strokeWidth: 2.1,
          strokeLinecap: 'round',
        }),
        React.createElement('path', {
          d: 'M4.1 4.2v5.2h5.2',
          fill: 'none',
          stroke: color,
          strokeWidth: 2.1,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    function WarnIcon({ size = 15, color = 'currentColor' }) {
      return React.createElement(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
        React.createElement('path', {
          d: 'M12 3.6l9 15.8H3z',
          fill: 'none',
          stroke: color,
          strokeWidth: 2,
          strokeLinejoin: 'round',
        }),
        React.createElement('path', { d: 'M12 9.4v4.4', stroke: color, strokeWidth: 2, strokeLinecap: 'round' }),
        React.createElement('circle', { cx: 12, cy: 16.6, r: 1.15, fill: color }),
      )
    }

    /**
     * 输入框右侧那颗按钮。
     *
     * props 里能拿到的是宿主 uiSession.provide 投影出来的东西：
     *   useInput（读草稿状态的 hook）、inputActions（写草稿的 action 集合）。
     * 草稿只能从 useInput 读——宿主输入栏自己就是 useInput((s) => s)，
     * 没有 props.input。
     */
    function EnhanceButton(props) {
      const useLiveInput = typeof props.useInput === 'function' ? props.useInput : () => null
      const input = useLiveInput((state) => state)
      const draft = typeof input?.draft === 'string' ? input.draft : ''
      const actions = props.inputActions

      const [phase, setPhase] = React.useState('idle')
      const [backup, setBackup] = React.useState(null)
      const [enhanced, setEnhanced] = React.useState(null)
      const [error, setError] = React.useState('')

      const abortRef = React.useRef(null)
      /** 写回输入框之后给 store 一点落地时间，免得把刚写进去的文字当成「用户改过」。 */
      const graceRef = React.useRef(0)
      const aliveRef = React.useRef(true)

      React.useEffect(() => {
        aliveRef.current = true
        // 挂载即上报一次：能证明客户端插件真的加载、props 真的给到了。
        if (!mountReported) {
          mountReported = true
          report({
            stage: 'mount',
            hasActions: Boolean(actions),
            actionKeys: actions ? Object.keys(actions) : null,
            hasUseInput: typeof props.useInput === 'function',
            draftLen: draft.length,
          })
        }
        return () => {
          aliveRef.current = false
          if (abortRef.current) abortRef.current.abort()
        }
      }, [])

      // 与 WorkBuddy onContentDiverged 等价：增强后用户改了字，就放弃「恢复原文」。
      React.useEffect(() => {
        if (phase !== 'done' || draft === enhanced) return
        const wait = Math.max(0, graceRef.current - Date.now()) + 400
        const timer = setTimeout(() => {
          if (!aliveRef.current) return
          setPhase('idle')
          setBackup(null)
          setEnhanced(null)
        }, wait)
        return () => clearTimeout(timer)
      }, [phase, draft, enhanced])

      const writeDraft = (value) => {
        try {
          if (actions && typeof actions.setDraft === 'function') {
            actions.setDraft(value)
            if (typeof actions.persistDraft === 'function') actions.persistDraft()
            return true
          }
        } catch (writeError) {
          report({
            stage: 'writeDraft',
            error: String((writeError && writeError.message) || writeError),
            actionKeys: actions ? Object.keys(actions) : null,
          })
        }
        return false
      }

      const runEnhance = async () => {
        const before = draft
        if (!before || before.trim() === '') {
          setPhase('error')
          setError(t.empty)
          return
        }
        if (abortRef.current) abortRef.current.abort()
        const controller = new AbortController()
        abortRef.current = controller
        setPhase('loading')
        setError('')
        const started = Date.now()
        try {
          const { status, data } = await postEnhance(before, controller.signal)
          if (!data || data.success !== true || typeof data.text !== 'string') {
            if (!aliveRef.current) return
            setPhase('error')
            setError((data && (data.error || data.code)) || t.failed)
            report({
              stage: 'request',
              status,
              code: data && data.code,
              error: data && data.error,
              ms: Date.now() - started,
              draftLen: before.length,
            })
            return
          }
          if (!aliveRef.current) return
          graceRef.current = Date.now() + 1200
          setBackup(before)
          setEnhanced(data.text)
          setPhase('done')
          if (!writeDraft(data.text)) {
            setPhase('error')
            setError(t.failed)
            report({
              stage: 'writeback',
              hasActions: Boolean(actions),
              actionKeys: actions ? Object.keys(actions) : null,
              textLen: data.text.length,
            })
          } else {
            report({ stage: 'ok', ms: Date.now() - started, draftLen: before.length, textLen: data.text.length })
          }
        } catch (requestError) {
          if (controller.signal.aborted || !aliveRef.current) return
          setPhase('error')
          setError((requestError && requestError.message) || t.failed)
          report({
            stage: 'throw',
            error: String((requestError && requestError.message) || requestError),
            ms: Date.now() - started,
          })
        }
      }

      const runRevert = () => {
        if (backup === null) return
        graceRef.current = Date.now() + 1200
        writeDraft(backup)
        setPhase('idle')
        setBackup(null)
        setEnhanced(null)
        setError('')
      }

      const isDone = phase === 'done'
      const isBusy = phase === 'loading'
      const label = isBusy
        ? t.enhancing
        : isDone
          ? t.revert
          : phase === 'error'
            ? `${t.failed}: ${error || t.retry}`
            : t.title

      let icon = React.createElement(SparkleIcon, null)
      if (isBusy) icon = React.createElement(SpinnerIcon, null)
      else if (isDone) icon = React.createElement(RevertIcon, null)
      else if (phase === 'error') icon = React.createElement(WarnIcon, null)

      return React.createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-enhance-btn',
          'data-phase': phase,
          title: label,
          'aria-label': label,
          'aria-busy': isBusy ? 'true' : 'false',
          disabled: isBusy,
          onClick: isDone ? runRevert : runEnhance,
        },
        icon,
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (!slots || typeof slots.inject !== 'function') return
      if (typeof document !== 'undefined') ctx.effect(() => ensureStyle(document))

      // 组件类型必须在这里一次定死（EnhanceButton 是模块级常量）。
      // 若像 makeMemeButton(...) 那样在 render 回调里现造组件，每次重渲染都会
      // 换一个类型，宿主会不停卸载重挂按钮。meme 的注释里有实测 20+ 次/秒的先例。
      //
      // 宿主没有声明这个槽时 inject 不会触发，不需要额外判断。
      slots.inject('conversation.input.right', () =>
        slots.register(
          { name: 'conversation.input.right', id: 'enhance-prompt', order: 20, label: t.title },
          (slotProps) =>
            React.createElement(EnhanceButton, {
              inputActions: slotProps && slotProps.inputActions,
              useInput: slotProps && slotProps.useInput,
            }),
        ),
      )
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
