/**
 * dsh-enhance-prompt — web client.
 *
 * One sparkle button in the composer's right slot. Clicking it streams a rewrite into a
 * preview panel; nothing touches the draft until the user accepts it. That is the whole
 * point of this version: the v0.4.0 button wrote straight into the input box, so the only
 * way to judge a rewrite was to let it overwrite what you had typed.
 *
 * Wrapped in its own IIFE because the host concatenates every plugin's source into one
 * <script>; a top-level const here would collide with another plugin's.
 */
;(function () {
  const loader = window.__ModuleLoader__
  if (!loader || typeof loader.load !== 'function') return

  loader.load({
    id: 'dsh-enhance-prompt',
    factory(require) {
      var module = { exports: {} }
      ;(function (module, exports, require) {
        'use strict'

        const React = require('react')
        const { useState, useEffect, useRef, useMemo, useCallback } = React

        const API_PREFIX = '/dsh-enhance-prompt'
        const REQUEST_HEADER = 'x-dsh-enhance'
        const STYLE_ID = 'dsh-enhance-prompt-style'
        const PREFS_KEY = 'dsh-enhance-prompt:prefs'
        const HISTORY_KEY = 'dsh-enhance-prompt:history'
        const HISTORY_LIMIT = 8
        const REPORT_LIMIT = 20
        const ERROR_RESET_MS = 10000
        // How long after a write-back we stop treating a draft change as the user's own edit.
        const DIVERGE_GRACE_MS = 1200

        /* ------------------------------------------------------------------ i18n */

        const TEXT = {
          zh: {
            title: '增强提示词',
            openTitle: '增强提示词 (Ctrl+Shift+E)',
            needsReferences: '先清掉 @ 引用再增强：改写会整体替换草稿',
            tooShort: '草稿太短',
            panelTitle: '增强提示词',
            mode: '模式',
            model: '模型',
            effort: '思考',
            effortDefault: '默认',
            auto: '自动',
            apply: '应用',
            applyHint: 'Ctrl+Enter',
            regenerate: '重新生成',
            discard: '放弃',
            history: '历史',
            noHistory: '还没有历史版本',
            restore: '恢复',
            close: '关闭',
            streaming: '正在改写…',
            empty: '草稿是空的',
            failed: '改写失败',
            retry: '重试',
            copy: '复制',
            copied: '已复制',
            applied: '已写入输入框',
            anchorsKept: '关键事实保留',
            anchorsLost: '丢失事实',
            ratio: '长度',
            chars: '字符',
            route: '路由',
            cached: '缓存命中',
            repaired: '已自动补回缺失事实',
            contextUsed: '已带入对话上下文',
            diffLegend: '绿=新增 红=删除',
            preview: '预览',
            errorCodes: {
              empty: '草稿是空的',
              too_long: '草稿超出长度上限',
              disabled: '插件已在设置中关闭',
              busy: '并发改写已满，稍后再试',
              rate_limited: '请求过于频繁',
              no_route: '没有可用模型路由',
              empty_output: '模型返回了空内容',
              length_exceeded: '改写结果超出长度闸门',
              language_mismatch: '改写结果语言与草稿不一致',
              not_loaded: '插件未加载，请重启 DSH',
              forbidden: '请求被拒绝（来源校验失败）',
              network: '网络错误',
            },
          },
          en: {
            title: 'Enhance prompt',
            openTitle: 'Enhance prompt (Ctrl+Shift+E)',
            needsReferences: 'Clear the @ references first — the rewrite replaces the whole draft',
            tooShort: 'Draft is too short',
            panelTitle: 'Enhance prompt',
            mode: 'Mode',
            model: 'Model',
            effort: 'Effort',
            effortDefault: 'default',
            auto: 'auto',
            apply: 'Apply',
            applyHint: 'Ctrl+Enter',
            regenerate: 'Regenerate',
            discard: 'Discard',
            history: 'History',
            noHistory: 'No earlier versions yet',
            restore: 'Restore',
            close: 'Close',
            streaming: 'Rewriting…',
            empty: 'The draft is empty',
            failed: 'Rewrite failed',
            retry: 'Retry',
            copy: 'Copy',
            copied: 'Copied',
            applied: 'Written to the input box',
            anchorsKept: 'facts kept',
            anchorsLost: 'facts lost',
            ratio: 'length',
            chars: 'chars',
            route: 'route',
            cached: 'cached',
            repaired: 'missing facts were re-injected',
            contextUsed: 'conversation context used',
            diffLegend: 'green=added red=removed',
            preview: 'Preview',
            errorCodes: {
              empty: 'The draft is empty',
              too_long: 'The draft exceeds the length limit',
              disabled: 'The enhancer is switched off in settings',
              busy: 'Too many rewrites in flight, try again shortly',
              rate_limited: 'Too many requests',
              no_route: 'No usable model route',
              empty_output: 'The model returned nothing',
              length_exceeded: 'The rewrite exceeded the length gate',
              language_mismatch: 'The rewrite changed language',
              not_loaded: 'Plugin not loaded — restart DSH',
              forbidden: 'Request rejected (origin check failed)',
              network: 'Network error',
            },
          },
        }

        const t = /^zh/i.test(navigator.language || '') ? TEXT.zh : TEXT.en

        function describe(code, fallback) {
          if (!code) return fallback || t.failed
          const known = t.errorCodes[code]
          if (known) return known
          if (/^http_/.test(code)) {
            const status = Number(code.slice(5))
            if (status === 404 || status === 405) return t.errorCodes.not_loaded
            if (status === 403) return t.errorCodes.forbidden
            if (status === 429) return t.errorCodes.rate_limited
          }
          const text = typeof fallback === 'string' ? fallback.trim() : ''
          return text ? text.slice(0, 120) : t.failed
        }

        /* ------------------------------------------------------------- app base */

        function detectAppBase(doc) {
          const sources = []
          if (doc.currentScript && doc.currentScript.src) sources.push(doc.currentScript.src)
          const tags = doc.querySelectorAll ? doc.querySelectorAll('script[src]') : []
          for (let i = 0; i < tags.length; i += 1) sources.push(tags[i].src)
          for (const src of sources) {
            const match = /^(.*?)\/plugins\//.exec(src || '')
            if (match) return match[1]
          }
          return ''
        }

        const APP_BASE = detectAppBase(document)
        const apiPath = (suffix) => APP_BASE + API_PREFIX + suffix

        /* ------------------------------------------------------------- telemetry */

        let reported = 0

        function report(stage, detail) {
          if (reported >= REPORT_LIMIT) return
          reported += 1
          try {
            fetch(apiPath('/report'), {
              method: 'POST',
              headers: { 'content-type': 'application/json', [REQUEST_HEADER]: '1' },
              body: JSON.stringify({
                stage,
                href: location.href,
                appBase: APP_BASE,
                ua: navigator.userAgent,
                ...(detail || {}),
              }),
              keepalive: true,
            }).catch(() => {})
          } catch {
            /* telemetry is never allowed to break the button */
          }
        }

        /* ------------------------------------------------------------------ css */

        const CSS = `
.dsh-ep-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:8px;background:transparent;color:inherit;opacity:.62;cursor:pointer;transition:opacity .15s,background .15s,color .15s}
.dsh-ep-btn:hover:not(:disabled){opacity:1;background:rgba(127,157,255,.14)}
.dsh-ep-btn:focus-visible{outline:2px solid #7f9dff;outline-offset:1px}
.dsh-ep-btn:disabled{opacity:.3;cursor:not-allowed}
.dsh-ep-btn[data-phase="loading"],.dsh-ep-btn[data-phase="done"]{color:#7f9dff;opacity:1}
.dsh-ep-btn[data-phase="error"]{color:#e5674f;opacity:1}
.dsh-ep-btn[data-flash="1"]{animation:dshEpShake .32s ease-in-out}
.dsh-ep-spin{animation:dshEpSpin .9s linear infinite;transform-origin:12px 12px}
@keyframes dshEpSpin{to{transform:rotate(360deg)}}
@keyframes dshEpShake{0%,100%{transform:translateX(0)}25%{transform:translateX(-2px)}75%{transform:translateX(2px)}}
@media (prefers-reduced-motion:reduce){.dsh-ep-spin,.dsh-ep-btn[data-flash="1"]{animation:none}}

.dsh-ep-panel{--ep-bg:#16181d;--ep-fg:#e7e9ee;--ep-dim:#9aa1ad;--ep-line:rgba(255,255,255,.11);--ep-soft:rgba(255,255,255,.05);--ep-accent:#7f9dff;--ep-add:#5fd08a;--ep-del:#e5674f;
position:fixed;z-index:2147483000;display:flex;flex-direction:column;box-sizing:border-box;max-height:min(70vh,620px);
font:13px/1.55 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif;color:var(--ep-fg);background:var(--ep-bg);
border:1px solid var(--ep-line);border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,.42);overflow:hidden}
@media (prefers-color-scheme:light){.dsh-ep-panel{--ep-bg:#fbfbfd;--ep-fg:#1d2026;--ep-dim:#69707c;--ep-line:rgba(15,20,30,.13);--ep-soft:rgba(15,20,30,.045);--ep-accent:#3f63d6;--ep-add:#1f8b4c;--ep-del:#c0392b;box-shadow:0 18px 48px rgba(20,30,60,.18)}}

.dsh-ep-head{display:flex;align-items:center;gap:8px;padding:9px 10px;border-bottom:1px solid var(--ep-line);flex:0 0 auto;flex-wrap:wrap}
.dsh-ep-title{font-weight:600;font-size:12.5px;letter-spacing:.01em;margin-right:2px}
.dsh-ep-modes{display:inline-flex;background:var(--ep-soft);border-radius:7px;padding:2px;gap:2px}
.dsh-ep-mode{border:0;background:transparent;color:var(--ep-dim);font:inherit;font-size:12px;padding:2px 8px;border-radius:5px;cursor:pointer;line-height:1.6}
.dsh-ep-mode[data-active="1"]{background:var(--ep-accent);color:#fff}
.dsh-ep-mode:hover:not([data-active="1"]){color:var(--ep-fg)}
.dsh-ep-spacer{flex:1 1 auto}
.dsh-ep-x{border:0;background:transparent;color:var(--ep-dim);cursor:pointer;font-size:16px;line-height:1;padding:2px 4px;border-radius:5px}
.dsh-ep-x:hover{color:var(--ep-fg);background:var(--ep-soft)}

.dsh-ep-selects{display:flex;gap:6px;padding:7px 10px;border-bottom:1px solid var(--ep-line);flex:0 0 auto;flex-wrap:wrap}
.dsh-ep-field{display:flex;align-items:center;gap:5px;font-size:11.5px;color:var(--ep-dim)}
.dsh-ep-field select{max-width:190px;font:inherit;font-size:12px;color:var(--ep-fg);background:var(--ep-soft);border:1px solid var(--ep-line);border-radius:6px;padding:2px 5px;cursor:pointer}

.dsh-ep-body{flex:1 1 auto;overflow:auto;padding:10px 12px;overscroll-behavior:contain}
.dsh-ep-text{margin:0;white-space:pre-wrap;word-break:break-word;font:12.5px/1.62 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dsh-ep-text ins{background:rgba(95,208,138,.18);color:var(--ep-add);text-decoration:none;border-radius:3px}
.dsh-ep-text del{background:rgba(229,103,79,.16);color:var(--ep-del);text-decoration:line-through;border-radius:3px}
.dsh-ep-empty{color:var(--ep-dim);font-size:12.5px}
.dsh-ep-err{color:var(--ep-del);font-size:12.5px;white-space:pre-wrap}
.dsh-ep-legend{color:var(--ep-dim);font-size:11px;margin-bottom:6px}
.dsh-ep-note{color:var(--ep-dim);font-size:11.5px;margin-top:8px}

.dsh-ep-hist{list-style:none;margin:0 0 8px;padding:0;display:flex;flex-direction:column;gap:4px}
.dsh-ep-hist li{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:6px;background:var(--ep-soft);font-size:11.5px;color:var(--ep-dim)}
.dsh-ep-hist li span{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ep-fg)}
.dsh-ep-hist button{border:0;background:transparent;color:var(--ep-accent);font:inherit;font-size:11.5px;cursor:pointer;padding:0}

.dsh-ep-foot{display:flex;align-items:center;gap:8px;padding:8px 10px;border-top:1px solid var(--ep-line);flex:0 0 auto;flex-wrap:wrap}
.dsh-ep-stats{flex:1 1 auto;font-size:11px;color:var(--ep-dim);display:flex;gap:9px;flex-wrap:wrap;align-items:center}
.dsh-ep-stat b{font-weight:600;color:var(--ep-fg)}
.dsh-ep-stat[data-bad="1"] b{color:var(--ep-del)}
.dsh-ep-act{border:1px solid var(--ep-line);background:transparent;color:var(--ep-fg);font:inherit;font-size:12px;padding:3px 10px;border-radius:7px;cursor:pointer;white-space:nowrap}
.dsh-ep-act:hover:not(:disabled){background:var(--ep-soft)}
.dsh-ep-act:disabled{opacity:.4;cursor:not-allowed}
.dsh-ep-act[data-primary="1"]{background:var(--ep-accent);border-color:transparent;color:#fff}
.dsh-ep-act[data-primary="1"]:hover:not(:disabled){filter:brightness(1.08);background:var(--ep-accent)}
`

        function ensureStyle(doc) {
          const existing = doc.getElementById(STYLE_ID)
          if (existing) return () => {}
          const el = doc.createElement('style')
          el.id = STYLE_ID
          el.textContent = CSS
          ;(doc.head || doc.documentElement).appendChild(el)
          return () => {
            try {
              el.remove()
            } catch {
              /* the host may have already torn the head down */
            }
          }
        }

        /* --------------------------------------------------------------- icons */

        // Module level on purpose: an inline arrow component would be a new type on every
        // render, which makes the host remount the whole composer subtree.
        function SparkleIcon() {
          return React.createElement(
            'svg',
            { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
            React.createElement('path', {
              d: 'M12 2.6l2.34 6.9 6.9 2.34-6.9 2.34L12 21.08l-2.34-6.9-6.9-2.34 6.9-2.34z',
              stroke: 'currentColor',
              strokeWidth: 1.5,
              strokeLinejoin: 'round',
            }),
          )
        }

        function SpinnerIcon() {
          return React.createElement(
            'svg',
            { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
            React.createElement('circle', {
              cx: 12,
              cy: 12,
              r: 8.2,
              stroke: 'currentColor',
              strokeWidth: 1.6,
              strokeOpacity: 0.25,
            }),
            React.createElement('path', {
              d: 'M12 3.8a8.2 8.2 0 0 1 8.2 8.2',
              stroke: 'currentColor',
              strokeWidth: 1.6,
              strokeLinecap: 'round',
              className: 'dsh-ep-spin',
            }),
          )
        }

        function CheckIcon() {
          return React.createElement(
            'svg',
            { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
            React.createElement('path', {
              d: 'M5 12.6l4.4 4.4L19 7.4',
              stroke: 'currentColor',
              strokeWidth: 1.9,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
            }),
          )
        }

        function WarnIcon() {
          return React.createElement(
            'svg',
            { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
            React.createElement('path', {
              d: 'M12 4.2l8.2 14.6H3.8L12 4.2z',
              stroke: 'currentColor',
              strokeWidth: 1.5,
              strokeLinejoin: 'round',
            }),
            React.createElement('path', { d: 'M12 9.6v4.1', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
            React.createElement('circle', { cx: 12, cy: 16.4, r: 0.95, fill: 'currentColor' }),
          )
        }

        /* ---------------------------------------------------------------- diff */

        const TOKEN_RE = /\s+|[\u3400-\u4dbf\u4e00-\u9fff]|[A-Za-z0-9_]+|[^\s]/g
        // Above this many token pairs the DP table gets slow enough to be felt as a stall;
        // a long draft then simply renders without inline highlighting.
        const DIFF_CELL_LIMIT = 4000000

        function tokenize(text) {
          const out = String(text ?? '').match(TOKEN_RE)
          return out || []
        }

        function sameToken(a, b) {
          return a === b
        }

        /**
         * Token diff for the preview. Common prefix and suffix are trimmed first: a rewrite
         * usually edits a handful of phrases, so the quadratic core stays tiny.
         */
        function diffTokens(before, after) {
          const A = tokenize(before)
          const B = tokenize(after)
          let head = 0
          while (head < A.length && head < B.length && sameToken(A[head], B[head])) head += 1
          let tailA = A.length
          let tailB = B.length
          while (tailA > head && tailB > head && sameToken(A[tailA - 1], B[tailB - 1])) {
            tailA -= 1
            tailB -= 1
          }

          const ops = []
          if (head > 0) ops.push({ op: 'keep', text: A.slice(0, head).join('') })

          const midA = A.slice(head, tailA)
          const midB = B.slice(head, tailB)
          const n = midA.length
          const m = midB.length

          if (n === 0) {
            if (m > 0) ops.push({ op: 'add', text: midB.join('') })
          } else if (m === 0) {
            ops.push({ op: 'del', text: midA.join('') })
          } else if (n * m > DIFF_CELL_LIMIT) {
            ops.push({ op: 'del', text: midA.join('') })
            ops.push({ op: 'add', text: midB.join('') })
          } else {
            const w = m + 1
            const dp = new Uint16Array((n + 1) * w)
            const dir = new Uint8Array((n + 1) * w)
            for (let i = 1; i <= n; i += 1) {
              const row = i * w
              const prev = (i - 1) * w
              for (let j = 1; j <= m; j += 1) {
                const k = row + j
                if (sameToken(midA[i - 1], midB[j - 1])) {
                  dp[k] = dp[prev + j - 1] + 1
                  dir[k] = 3
                } else if (dp[prev + j] >= dp[row + j - 1]) {
                  dp[k] = dp[prev + j]
                  dir[k] = 1
                } else {
                  dp[k] = dp[row + j - 1]
                  dir[k] = 2
                }
              }
            }
            const rev = []
            let i = n
            let j = m
            while (i > 0 || j > 0) {
              const d = i > 0 && j > 0 ? dir[i * w + j] : i > 0 ? 1 : 2
              if (d === 3) {
                rev.push({ op: 'keep', text: midA[i - 1] })
                i -= 1
                j -= 1
              } else if (d === 1) {
                rev.push({ op: 'del', text: midA[i - 1] })
                i -= 1
              } else {
                rev.push({ op: 'add', text: midB[j - 1] })
                j -= 1
              }
            }
            rev.reverse()
            for (const item of rev) {
              const last = ops[ops.length - 1]
              if (last && last.op === item.op) last.text += item.text
              else ops.push({ op: item.op, text: item.text })
            }
          }

          if (tailA < A.length) ops.push({ op: 'keep', text: A.slice(tailA).join('') })
          return ops
        }

        /* ----------------------------------------------------------------- sse */

        function makeError(code, message) {
          const err = new Error(message || code || 'enhance failed')
          err.code = code || 'unknown'
          return err
        }

        function parseFrame(frame) {
          let event = 'message'
          const data = []
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim()
            else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
          }
          if (data.length === 0) return null
          let payload = null
          try {
            payload = JSON.parse(data.join('\n'))
          } catch {
            return null
          }
          return { event, payload }
        }

        /**
         * POST + read the SSE body by hand. EventSource cannot send a body, and the endpoint
         * needs the draft in it.
         */
        async function streamEnhance(body, handlers) {
          const res = await fetch(apiPath('/stream'), {
            method: 'POST',
            headers: { 'content-type': 'application/json', [REQUEST_HEADER]: '1' },
            body: JSON.stringify(body),
            signal: handlers.signal,
          })

          if (!res.ok) {
            let payload = null
            try {
              payload = await res.json()
            } catch {
              /* a proxy error page is not JSON */
            }
            throw makeError(payload && payload.code ? payload.code : `http_${res.status}`, payload && payload.error)
          }

          if (!res.body || typeof res.body.getReader !== 'function') {
            // No streaming body (very old browser or a proxy that buffered everything).
            const payload = await res.json()
            if (!payload || payload.ok !== true || typeof payload.text !== 'string') {
              throw makeError(payload && payload.code, payload && payload.error)
            }
            return payload
          }

          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          let result = null
          let failure = null

          const drain = (final) => {
            for (;;) {
              const cut = buffer.indexOf('\n\n')
              if (cut === -1) break
              const frame = buffer.slice(0, cut)
              buffer = buffer.slice(cut + 2)
              const parsed = parseFrame(frame)
              if (!parsed) continue
              if (parsed.event === 'route') handlers.onRoute?.(parsed.payload)
              else if (parsed.event === 'delta') handlers.onDelta?.(parsed.payload.text || '')
              else if (parsed.event === 'done') result = parsed.payload
              else if (parsed.event === 'error') {
                failure = makeError(parsed.payload && parsed.payload.code, parsed.payload && parsed.payload.error)
              }
            }
            if (final && buffer.trim()) {
              const parsed = parseFrame(buffer)
              buffer = ''
              if (parsed) {
                if (parsed.event === 'done') result = parsed.payload
                else if (parsed.event === 'error') {
                  failure = makeError(parsed.payload && parsed.payload.code, parsed.payload && parsed.payload.error)
                }
              }
            }
          }

          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
            drain(false)
          }
          buffer += decoder.decode().replace(/\r\n/g, '\n')
          drain(true)

          if (failure) throw failure
          if (!result || result.ok !== true || typeof result.text !== 'string') {
            throw makeError('empty_output', 'the stream ended without a result')
          }
          return result
        }

        /* --------------------------------------------------------------- prefs */

        const MODE_LABELS = {
          light: 'Light',
          standard: 'Standard',
          deep: 'Deep',
          system: 'System',
          enhanced: 'Standard',
          workbuddy: 'WorkBuddy',
        }

        const DEFAULT_PREFS = { mode: 'standard', provider: '', model: '', effort: '' }

        function loadPrefs() {
          try {
            const raw = localStorage.getItem(PREFS_KEY)
            if (!raw) return { ...DEFAULT_PREFS }
            const parsed = JSON.parse(raw)
            return {
              mode: typeof parsed.mode === 'string' && parsed.mode ? parsed.mode : DEFAULT_PREFS.mode,
              provider: typeof parsed.provider === 'string' ? parsed.provider : '',
              model: typeof parsed.model === 'string' ? parsed.model : '',
              effort: typeof parsed.effort === 'string' ? parsed.effort : '',
            }
          } catch {
            return { ...DEFAULT_PREFS }
          }
        }

        function savePrefs(prefs) {
          try {
            localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
          } catch {
            /* private mode: preferences simply do not persist */
          }
        }

        function loadHistory() {
          try {
            const raw = localStorage.getItem(HISTORY_KEY)
            if (!raw) return []
            const parsed = JSON.parse(raw)
            if (!Array.isArray(parsed)) return []
            return parsed
              .filter((item) => item && typeof item.text === 'string' && item.text)
              .slice(0, HISTORY_LIMIT)
              .map((item) => ({
                text: item.text,
                mode: typeof item.mode === 'string' ? item.mode : '',
                at: Number(item.at) || Date.now(),
              }))
          } catch {
            return []
          }
        }

        function saveHistory(list) {
          try {
            localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_LIMIT)))
          } catch {
            /* not fatal */
          }
        }

        /* -------------------------------------------------------------- catalog */

        let catalogCache = null
        let catalogPending = null

        async function loadCatalog() {
          if (catalogCache) return catalogCache
          if (catalogPending) return catalogPending
          catalogPending = fetch(apiPath('/models'), {
            method: 'GET',
            headers: { [REQUEST_HEADER]: '1' },
          })
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
              if (data && data.ok === true) catalogCache = data
              return catalogCache
            })
            .catch(() => null)
            .finally(() => {
              catalogPending = null
            })
          return catalogPending
        }

        function findModel(catalog, provider, model) {
          if (!catalog || !Array.isArray(catalog.groups)) return null
          for (const group of catalog.groups) {
            if (group.provider !== provider) continue
            for (const entry of group.models || []) {
              if (entry.id === model) return entry
            }
          }
          return null
        }

        /* -------------------------------------------------------------- format */

        function formatTime(at) {
          try {
            return new Date(at).toLocaleTimeString(navigator.language || 'en', {
              hour: '2-digit',
              minute: '2-digit',
            })
          } catch {
            return ''
          }
        }

        function ratioText(meta) {
          if (!meta) return ''
          if (typeof meta.ratioLabel === 'string' && meta.ratioLabel) return meta.ratioLabel
          if (typeof meta.ratio === 'number' && Number.isFinite(meta.ratio)) return `${meta.ratio.toFixed(2)}x`
          return ''
        }

        /* --------------------------------------------------------------- panel */

        function DiffText(props) {
          const ops = props.ops
          if (!ops || ops.length === 0) {
            return React.createElement('pre', { className: 'dsh-ep-text' }, props.fallback || '')
          }
          const children = ops.map((item, index) => {
            if (item.op === 'keep') return React.createElement('span', { key: index }, item.text)
            const tag = item.op === 'add' ? 'ins' : 'del'
            return React.createElement(tag, { key: index }, item.text)
          })
          return React.createElement('pre', { className: 'dsh-ep-text' }, children)
        }

        function EnhancePanel(props) {
          const { phase, streamed, result, error, prefs, catalog, history, onClose, onApply, onRegenerate, onDiscard, onRestore, onPrefs } = props
          const bodyRef = useRef(null)
          const [showHistory, setShowHistory] = useState(false)

          // Follow the stream while it is still arriving.
          useEffect(() => {
            if (phase !== 'loading') return
            const node = bodyRef.current
            if (node) node.scrollTop = node.scrollHeight
          }, [phase, streamed])

          const meta = result && result.meta ? result.meta : null
          const shown = phase === 'preview' || phase === 'done' ? (result && result.text) || '' : streamed

          const ops = useMemo(() => {
            if (phase !== 'preview' || !result) return null
            if (!props.before) return null
            try {
              return diffTokens(props.before, result.text)
            } catch {
              return null
            }
          }, [phase, result, props.before])

          // Only the four user-facing modes get chips; `enhanced` is an alias and
          // `workbuddy` exists for the A/B harness, not for the composer.
          const CHIP_MODES = ['light', 'standard', 'deep', 'system']
          const offered = catalog && Array.isArray(catalog.styles) ? catalog.styles : []
          const styles = CHIP_MODES.filter((id) => offered.length === 0 || offered.includes(id))

          const groups = catalog && Array.isArray(catalog.groups) ? catalog.groups : []
          const selectedModel = findModel(catalog, prefs.provider, prefs.model)
          const efforts = selectedModel && selectedModel.reasoning && Array.isArray(selectedModel.reasoning.efforts)
            ? selectedModel.reasoning.efforts
            : []

          const header = React.createElement(
            'div',
            { className: 'dsh-ep-head' },
            React.createElement('span', { className: 'dsh-ep-title' }, t.panelTitle),
            React.createElement(
              'div',
              { className: 'dsh-ep-modes', role: 'group', 'aria-label': t.mode },
              styles.map((id) =>
                React.createElement(
                  'button',
                  {
                    key: id,
                    type: 'button',
                    className: 'dsh-ep-mode',
                    'data-active': prefs.mode === id ? '1' : '0',
                    onClick: () => onPrefs({ mode: id }),
                  },
                  MODE_LABELS[id] || id,
                ),
              ),
            ),
            React.createElement('span', { className: 'dsh-ep-spacer' }),
            React.createElement('button', { type: 'button', className: 'dsh-ep-x', title: t.close, onClick: onClose }, '\u00d7'),
          )

          const selects = React.createElement(
            'div',
            { className: 'dsh-ep-selects' },
            React.createElement(
              'label',
              { className: 'dsh-ep-field' },
              React.createElement('span', null, t.model),
              React.createElement(
                'select',
                {
                  value: prefs.provider && prefs.model ? `${prefs.provider}\u0000${prefs.model}` : '',
                  onChange: (event) => {
                    const value = event.target.value
                    if (!value) {
                      onPrefs({ provider: '', model: '', effort: '' })
                      return
                    }
                    const cut = value.indexOf('\u0000')
                    const provider = value.slice(0, cut)
                    const model = value.slice(cut + 1)
                    const entry = findModel(catalog, provider, model)
                    const fallbackEffort =
                      entry && entry.reasoning && typeof entry.reasoning.defaultEffort === 'string'
                        ? entry.reasoning.defaultEffort
                        : ''
                    onPrefs({ provider, model, effort: fallbackEffort })
                  },
                },
                React.createElement('option', { value: '' }, t.auto),
                groups.map((group) =>
                  React.createElement(
                    'optgroup',
                    { key: group.provider, label: group.provider },
                    (group.models || []).map((entry) =>
                      React.createElement(
                        'option',
                        { key: `${group.provider}/${entry.id}`, value: `${group.provider}\u0000${entry.id}` },
                        entry.name || entry.id,
                      ),
                    ),
                  ),
                ),
              ),
            ),
            efforts.length > 0
              ? React.createElement(
                  'label',
                  { className: 'dsh-ep-field' },
                  React.createElement('span', null, t.effort),
                  React.createElement(
                    'select',
                    { value: prefs.effort || '', onChange: (event) => onPrefs({ effort: event.target.value }) },
                    React.createElement('option', { value: '' }, t.effortDefault),
                    efforts.map((effort) =>
                      React.createElement('option', { key: effort.id, value: effort.id }, effort.name || effort.id),
                    ),
                  ),
                )
              : null,
          )

          let body = null
          if (phase === 'error') {
            body = React.createElement('div', { className: 'dsh-ep-err' }, error || t.failed)
          } else if (phase === 'loading' && !shown) {
            body = React.createElement('div', { className: 'dsh-ep-empty' }, t.streaming)
          } else if (!shown) {
            body = React.createElement('div', { className: 'dsh-ep-empty' }, t.empty)
          } else {
            const parts = []
            if (showHistory) {
              parts.push(
                React.createElement(
                  'ul',
                  { key: 'hist', className: 'dsh-ep-hist' },
                  history.length === 0
                    ? React.createElement('li', null, t.noHistory)
                    : history.map((item, index) =>
                        React.createElement(
                          'li',
                          { key: `${item.at}-${index}` },
                          React.createElement('span', { title: item.text.slice(0, 200) }, item.text.slice(0, 90)),
                          React.createElement(
                            'em',
                            { style: { fontStyle: 'normal', opacity: 0.7 } },
                            `${MODE_LABELS[item.mode] || item.mode || ''} \u00b7 ${item.text.length} \u00b7 ${formatTime(item.at)}`,
                          ),
                          React.createElement('button', { type: 'button', onClick: () => onRestore(item) }, t.restore),
                        ),
                      ),
                ),
              )
            }
            if (ops && phase === 'preview') {
              parts.push(React.createElement('div', { key: 'legend', className: 'dsh-ep-legend' }, t.diffLegend))
              parts.push(React.createElement(DiffText, { key: 'diff', ops, fallback: shown }))
            } else {
              parts.push(React.createElement(DiffText, { key: 'plain', ops: null, fallback: shown }))
            }
            if (meta && meta.repaired) {
              parts.push(React.createElement('div', { key: 'repair', className: 'dsh-ep-note' }, t.repaired))
            }
            if (meta && meta.contextUsed) {
              parts.push(
                React.createElement(
                  'div',
                  { key: 'ctx', className: 'dsh-ep-note' },
                  `${t.contextUsed}${meta.contextReason ? ` (${meta.contextReason})` : ''}`,
                ),
              )
            }
            body = parts
          }

          const anchors = meta && meta.anchors ? meta.anchors : null
          const stats = []
          if (meta) {
            if (anchors && anchors.total > 0) {
              const lost = Math.max(0, anchors.total - anchors.kept)
              stats.push(
                React.createElement(
                  'span',
                  { key: 'anchors', className: 'dsh-ep-stat', 'data-bad': lost > 0 ? '1' : '0' },
                  React.createElement('b', null, `${anchors.kept}/${anchors.total}`),
                  ` ${lost > 0 ? t.anchorsLost : t.anchorsKept}`,
                ),
              )
            }
            if (meta.chars) {
              stats.push(
                React.createElement(
                  'span',
                  { key: 'chars', className: 'dsh-ep-stat' },
                  React.createElement('b', null, String(meta.chars)),
                  ` ${t.chars} \u00b7 ${ratioText(meta)}`,
                ),
              )
            }
            if (meta.route) {
              stats.push(React.createElement('span', { key: 'route', className: 'dsh-ep-stat' }, meta.route))
            }
            if (meta.ms) {
              stats.push(React.createElement('span', { key: 'ms', className: 'dsh-ep-stat' }, `${meta.ms}ms`))
            }
            if (meta.cached) {
              stats.push(React.createElement('span', { key: 'cached', className: 'dsh-ep-stat' }, t.cached))
            }
          }

          const canApply = phase === 'preview' && result && typeof result.text === 'string' && result.text.length > 0

          const foot = React.createElement(
            'div',
            { className: 'dsh-ep-foot' },
            React.createElement('div', { className: 'dsh-ep-stats' }, stats),
            React.createElement(
              'button',
              { type: 'button', className: 'dsh-ep-act', onClick: () => setShowHistory((v) => !v) },
              t.history,
            ),
            phase === 'error'
              ? React.createElement('button', { type: 'button', className: 'dsh-ep-act', onClick: onRegenerate }, t.retry)
              : React.createElement(
                  'button',
                  { type: 'button', className: 'dsh-ep-act', onClick: onRegenerate, disabled: phase === 'loading' },
                  t.regenerate,
                ),
            React.createElement('button', { type: 'button', className: 'dsh-ep-act', onClick: onDiscard }, t.discard),
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'dsh-ep-act',
                'data-primary': '1',
                onClick: onApply,
                disabled: !canApply,
                title: t.applyHint,
              },
              t.apply,
            ),
          )

          return React.createElement(
            'div',
            {
              className: 'dsh-ep-panel',
              style: props.style,
              role: 'dialog',
              'aria-label': t.panelTitle,
              onKeyDown: (event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  onClose()
                } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  if (canApply) onApply()
                }
              },
            },
            header,
            selects,
            React.createElement('div', { className: 'dsh-ep-body', ref: bodyRef }, body),
            foot,
          )
        }

        /* -------------------------------------------------------------- button */

        const noopHook = () => null

        function EnhanceButton(props) {
          const actions = props.inputActions || null
          const useInputHook = typeof props.useInput === 'function' ? props.useInput : noopHook
          const live = useInputHook((state) => state)

          const draft = live && typeof live.draft === 'string' ? live.draft : ''
          const references = live && Array.isArray(live.references) ? live.references : []
          const hasReferences = references.length > 0

          const [open, setOpen] = useState(false)
          const [phase, setPhase] = useState('idle')
          const [streamed, setStreamed] = useState('')
          const [result, setResult] = useState(null)
          const [error, setError] = useState('')
          const [flash, setFlash] = useState(false)
          const [prefs, setPrefs] = useState(loadPrefs)
          const [catalog, setCatalog] = useState(() => catalogCache)
          const [history, setHistory] = useState(loadHistory)
          const [anchor, setAnchor] = useState(null)

          const btnRef = useRef(null)
          const abortRef = useRef(null)
          const beforeRef = useRef('')
          const appliedRef = useRef('')
          const graceRef = useRef(0)
          const aliveRef = useRef(true)

          useEffect(() => {
            aliveRef.current = true
            return () => {
              aliveRef.current = false
              abortRef.current?.abort()
            }
          }, [])

          // A draft that no longer matches what we wrote means the user kept editing; drop
          // the "done" state so the button reads as idle again.
          useEffect(() => {
            if (phase !== 'done') return
            if (Date.now() < graceRef.current) return
            if (draft !== appliedRef.current) {
              setPhase('idle')
              appliedRef.current = ''
            }
          }, [draft, phase])

          useEffect(() => {
            if (!flash) return undefined
            const timer = setTimeout(() => setFlash(false), 400)
            return () => clearTimeout(timer)
          }, [flash])

          useEffect(() => {
            if (phase !== 'error') return undefined
            const timer = setTimeout(() => {
              setPhase((current) => (current === 'error' ? 'idle' : current))
              setError('')
            }, ERROR_RESET_MS)
            return () => clearTimeout(timer)
          }, [phase])

          const updatePrefs = useCallback((patch) => {
            setPrefs((current) => {
              const next = { ...current, ...patch }
              savePrefs(next)
              return next
            })
          }, [])

          const writeDraft = useCallback(
            (value) => {
              if (!actions || typeof actions.setDraft !== 'function') {
                report('writeDraft', { reason: 'no setDraft' })
                return false
              }
              try {
                actions.setDraft(value)
                if (typeof actions.persistDraft === 'function') actions.persistDraft()
                return true
              } catch (err) {
                report('writeDraft', { reason: String((err && err.message) || err).slice(0, 160) })
                return false
              }
            },
            [actions],
          )

          const placePanel = useCallback(() => {
            const node = btnRef.current
            if (!node || typeof node.getBoundingClientRect !== 'function') return
            const rect = node.getBoundingClientRect()
            const width = Math.min(560, Math.max(320, window.innerWidth - 24))
            const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12))
            const bottom = Math.max(12, window.innerHeight - rect.top + 8)
            setAnchor({ left, bottom, width })
          }, [])

          const run = useCallback(
            async (options) => {
              const force = options && options.force === true
              const before = draft
              if (!before.trim()) {
                setFlash(true)
                return
              }
              abortRef.current?.abort()
              const controller = new AbortController()
              abortRef.current = controller

              beforeRef.current = before
              setOpen(true)
              setPhase('loading')
              setStreamed('')
              setResult(null)
              setError('')
              placePanel()

              let acc = ''
              try {
                const payload = await streamEnhance(
                  {
                    text: before,
                    mode: prefs.mode,
                    provider: prefs.provider || undefined,
                    model: prefs.model || undefined,
                    effort: prefs.effort || undefined,
                    force,
                  },
                  {
                    signal: controller.signal,
                    onRoute: () => {},
                    onDelta: (chunk) => {
                      acc += chunk
                      if (aliveRef.current) setStreamed(acc)
                    },
                  },
                )
                if (!aliveRef.current) return
                setResult({ text: payload.text, meta: payload.meta || null })
                setPhase('preview')
              } catch (err) {
                if (!aliveRef.current) return
                if (err && (err.name === 'AbortError' || controller.signal.aborted)) {
                  setPhase('idle')
                  return
                }
                setError(describe(err && err.code, err && err.message))
                setPhase('error')
              }
            },
            [draft, prefs.mode, prefs.provider, prefs.model, prefs.effort, placePanel],
          )

          const close = useCallback(() => {
            abortRef.current?.abort()
            abortRef.current = null
            setOpen(false)
            setPhase('idle')
            setStreamed('')
            setResult(null)
            setError('')
          }, [])

          const accept = useCallback(() => {
            if (!result || typeof result.text !== 'string' || !result.text) return
            const before = beforeRef.current
            if (before && before !== result.text) {
              setHistory((current) => {
                const next = [{ text: before, mode: prefs.mode, at: Date.now() }, ...current].slice(0, HISTORY_LIMIT)
                saveHistory(next)
                return next
              })
            }
            const ok = writeDraft(result.text)
            if (!ok) {
              setError(describe('forbidden'))
              setPhase('error')
              return
            }
            graceRef.current = Date.now() + DIVERGE_GRACE_MS
            appliedRef.current = result.text
            setPhase('done')
            setOpen(false)
            report('apply', { chars: result.text.length, mode: prefs.mode })
          }, [result, prefs.mode, writeDraft])

          const restore = useCallback(
            (item) => {
              if (!item || typeof item.text !== 'string') return
              if (!writeDraft(item.text)) return
              graceRef.current = Date.now() + DIVERGE_GRACE_MS
              appliedRef.current = item.text
              setPhase('done')
              setOpen(false)
            },
            [writeDraft],
          )

          // Panel geometry depends on where the button sits, which moves with the composer.
          useEffect(() => {
            if (!open) return undefined
            placePanel()
            const onScroll = () => placePanel()
            window.addEventListener('resize', onScroll)
            window.addEventListener('scroll', onScroll, true)
            return () => {
              window.removeEventListener('resize', onScroll)
              window.removeEventListener('scroll', onScroll, true)
            }
          }, [open, placePanel])

          useEffect(() => {
            if (!open || catalog) return undefined
            let cancelled = false
            loadCatalog().then((data) => {
              if (!cancelled && data) setCatalog(data)
            })
            return () => {
              cancelled = true
            }
          }, [open, catalog])

          // Ctrl/Cmd+Shift+E from anywhere in the composer.
          useEffect(() => {
            const onKey = (event) => {
              if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return
              if (String(event.key).toLowerCase() !== 'e') return
              if (event.defaultPrevented) return
              if (hasReferences) return
              event.preventDefault()
              if (open) close()
              else run({})
            }
            document.addEventListener('keydown', onKey)
            return () => document.removeEventListener('keydown', onKey)
          }, [hasReferences, open, close, run])

          const disabled = hasReferences
          const phaseIcon =
            phase === 'loading'
              ? React.createElement(SpinnerIcon)
              : phase === 'done'
                ? React.createElement(CheckIcon)
                : phase === 'error'
                  ? React.createElement(WarnIcon)
                  : React.createElement(SparkleIcon)

          const button = React.createElement(
            'button',
            {
              ref: btnRef,
              type: 'button',
              className: 'dsh-ep-btn',
              'data-phase': phase,
              'data-flash': flash ? '1' : '0',
              disabled,
              title: disabled ? t.needsReferences : t.openTitle,
              'aria-label': disabled ? t.needsReferences : t.title,
              onClick: (event) => {
                event.preventDefault()
                event.stopPropagation()
                if (disabled) return
                if (open) close()
                else run({})
              },
            },
            phaseIcon,
          )

          if (!open) return button

          return React.createElement(
            React.Fragment,
            null,
            button,
            React.createElement(EnhancePanel, {
              phase,
              streamed,
              result,
              error,
              prefs,
              catalog,
              history,
              before: beforeRef.current,
              style: anchor
                ? { left: `${anchor.left}px`, bottom: `${anchor.bottom}px`, width: `${anchor.width}px` }
                : { left: '12px', bottom: '80px', width: '420px' },
              onClose: close,
              onApply: accept,
              onDiscard: close,
              onRegenerate: () => run({ force: true }),
              onRestore: restore,
              onPrefs: updatePrefs,
            }),
          )
        }

        /* ---------------------------------------------------------------- apply */

        function apply(ctx) {
          if (!ctx || typeof ctx.get !== 'function') return
          const slots = ctx.get('slots')
          if (!slots || typeof slots.inject !== 'function') return

          ctx.effect(() => ensureStyle(document))

          ctx.effect(() =>
            slots.inject('conversation.input.right', () =>
              slots.register(
                { name: 'conversation.input.right', id: 'enhance-prompt', order: 20, label: t.title },
                (slotProps) =>
                  React.createElement(EnhanceButton, {
                    inputActions: slotProps && slotProps.inputActions,
                    useInput: slotProps && slotProps.useInput,
                  }),
              ),
            ),
          )

          report('mount', { appBase: APP_BASE })
        }

        exports.apply = apply
        exports.inject = ['slots']
        exports.EnhanceButton = EnhanceButton
        // Pure helpers, exposed so the node test suite can exercise them without a DOM.
        exports.__internals = { diffTokens, tokenize, parseFrame, describe, loadPrefs, loadHistory }
      })(module, module.exports, require)
      return module.exports
    },
  })
})()
