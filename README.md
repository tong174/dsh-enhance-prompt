# dsh-enhance-prompt

A one-click **prompt enhancer** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — a reverse-engineered, benchmarked reimplementation of WorkBuddy's "Enhance prompt".

Type a rough draft in the composer, click the sparkle button on the right, and the draft is rewritten into a clearer, more specific prompt **without changing what you asked for**. Click again to revert. If you edit the text yourself, the revert entry disappears — exactly like the original.

```
draft:  帮我写个爬虫
   ✦
result: 请帮我编写一个网络爬虫程序，并说明目标网站的页面结构与需要采集的字段；
        明确采集范围（页面数量、分页规则）、数据输出格式（如 CSV 或 JSON）、
        请求频率与并发限制，以及需要处理的异常情况（反爬机制、超时重试、编码问题）。
```

## Why this exists

WorkBuddy ships this feature as a single hidden RPC (`llm:enhancePrompt`) in `app.asar`. Its whole implementation is one call:

```js
runAgent({ systemPrompt: Jr, userPrompt: Yr.replace('{input}', text), agentName: 'enhance-prompt' })
```

So its quality **is** its prompt. This plugin:

1. extracts `Jr` / `Yr` byte-for-byte from `app.asar` (no paraphrasing), and
2. ships a rewritten prompt (`enhanced`, the default) that beat the original in a measured A/B — 12 cases × 5 judge passes, same model:

| axis (1–5) | WorkBuddy | this plugin |
| --- | --- | --- |
| fidelity (keeps the ask) | 4.58 | **4.98** |
| specificity gained | **4.77** | 4.40 |
| language preservation | 4.78 | **4.98** |
| restraint (adds nothing extra) | 3.10 | **4.35** |
| paste-ready | 4.90 | **4.97** |
| **total (25)** | 22.13 | **23.69** |
| case wins | 1 | **11** |
| dropped facts (of 12) | 3 | **1** |
| average length ratio | 12.3× | **5.64×** |

WorkBuddy's stable failure modes: inflating a five-word request into twelve times its length, inventing requirements the user never asked for (`robots.txt`, exit codes, incident-response plans), dropping concrete constraints, and flattening mixed Chinese/English into one language. The `enhanced` prompt fixes all four. Full report: [`docs/compare-report.md`](docs/compare-report.md).

## What you get

- **Sparkle button in the composer** (`conversation.input.right` slot) with four states: idle / enhancing / done / failed.
- **Revert** back to your original draft, which vanishes the moment you type over the result.
- **`enhance_prompt` agent tool** — the model can rewrite a prompt itself.
- **HTTP API** — `POST /dsh-enhance-prompt/enhance`, plus `/info`, `/report`, `/selftest`.
- **Three prompt styles** — `enhanced` (default, benchmarked), `workbuddy` (verbatim original), `system` (generic copy-editing).
- **Provider fallback chain** — tries routes in order, cools down providers that fail with auth/balance errors, and remembers the one that worked.

## Install

Marketplace: search **Enhance Prompt** in **Plugins → Discover** (once listed).

Manual (any profile):

```powershell
# 1. copy into the profile
Copy-Item . -Recurse "$HOME\.dsh\profiles\desktop\node_modules\dsh-enhance-prompt"

# 2. register it — add to dsh.profile.bundles in that profile's package.json
"dsh-enhance-prompt"

# 3. enable without restarting
#    plugin_manager set_bundle { action: "set_bundle", target: "dsh-enhance-prompt", enabled: true }
```

Reload the web page (`Ctrl+R`) so the browser picks up the new plugin bundle.

Requirements: `dsh >= 0.2.1-rc.2 < 0.4.0`, Node `^22.19 || >=24`.

## Configuration

Everything lives in the plugin's row in your profile `cordis.patch.yml`; all fields have defaults.

| field | default | meaning |
| --- | --- | --- |
| `promptStyle` | `enhanced` | `enhanced` / `workbuddy` / `system` |
| `provider`, `model` | `''` | empty = automatic candidate chain |
| `providerPriority` | `[]` | provider ids to try first |
| `maxAttempts` | `6` | how many candidate routes one enhancement may try |
| `temperature` | `0.3` | |
| `maxTokens` | `4000` | reasoning tokens count against this |
| `timeoutMs` | `60000` | |
| `minTextLength` | `1` | matches WorkBuddy |
| `maxInputChars` | `8000` | reject longer drafts (`too_large`) |
| `customSystemPrompt` / `customUserTemplate` | `''` | override; the template must contain `{input}` |
| `stripWrappingQuotes` / `stripCodeFence` | `true` | same cleanup as the original |
| `announceToAgent` / `toolsEnabled` | `true` | expose `enhance_prompt` |
| `selfTestOnStart` | `true` | run one self-test at load, logged |
| `logFile` | `~/.dsh/enhance-prompt.log` | host-side log; browser failures POST here too |

## API

```http
POST /dsh-enhance-prompt/enhance
{ "text": "帮我写个爬虫" }
→ { "success": true, "text": "...", "provider": "magpie", "model": "group/deepseek" }
→ { "success": false, "text": "", "code": "empty_input|too_large|timeout|llm_error|disabled", "error": "..." }

GET  /dsh-enhance-prompt/info
GET  /dsh-enhance-prompt/selftest
POST /dsh-enhance-prompt/report      # browser-side failure reporting, written to the log
```

`/api/enhance-prompt/*` exists as an alias but the host's API gateway claims that prefix and answers 401 — use `/dsh-enhance-prompt/*`.

## Verification

```powershell
node test/unit.mjs                    # sanitizer + template logic (7 checks)
node test/live.mjs                    # hit a gateway directly, check language following
node test/compare.mjs --round 6 --passes 5   # A/B against WorkBuddy's prompt, writes docs/compare-round6.json
node tools/report.mjs                 # regenerate docs/compare-report.md
node test/live-compare.mjs            # hit the installed plugin endpoint end to end
```

## Known limits

- The rewrite replaces the **whole draft** (same as the original); block/quote structure is not preserved.
- The revert backup lives in component state — switching sessions or reloading drops it (WorkBuddy behaves the same).
- Only binds the `conversation.input.right` slot. If a host version renames that slot, the button silently disappears instead of erroring.

## License

MIT. The two WorkBuddy prompt constants shipped in `lib/prompts.js` are included as reverse-engineering reference for interoperability; the plugin's default style is an independent rewrite.
