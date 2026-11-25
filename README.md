# dsh-enhance-prompt

A one-click **prompt enhancer** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — a reverse-engineered, benchmarked reimplementation of WorkBuddy's "Enhance prompt".

Type a rough draft in the composer, click the sparkle button on the right, and the draft is rewritten into a clearer, more specific prompt **without changing what you asked for**.

Since **v0.5.0 the rewrite lands in a preview panel first**: streaming output, token-level diff against your draft, and an eight-deep undo stack. Your draft is not touched until you press *Use it* — and pressing it is the only path back to the composer.

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
- **Preview panel** — streaming rewrite, token-level diff, eight-deep undo stack persisted in `localStorage`. The draft is written only when you accept.
- **Four modes on the chip row** — `light` (1.2× length budget), `standard` (2.5×), `deep` (4×), `system` (emits a structured system prompt). `enhanced` is a legacy alias of `standard`; `workbuddy` is the A/B fixture. Neither shows a chip.
- **Model and reasoning-effort pickers** — `/models` lists provider groups including sleeping ones; an effort is sent only if the model's `reasoning.efforts` actually declares it, and a gateway that rejects it triggers a downgrade-and-retry.
- **Deterministic quality gates** — a fidelity gate extracts the concrete facts from your draft (inline commands, URLs, paths, filenames, versions, numbers with units, `camelCase`/`snake_case`/`CONST_CASE` identifiers, `@references`, quoted literals) and verifies each one survived; a single repair pass reinjects the missing ones; a length gate rejects bloated rewrites; a language gate refuses to flip a monolingual draft.
- **Disabled while `@references` are attached** — whether `setDraft` clears the reference list cannot be verified from the host side, so the button refuses rather than silently dropping the files you attached.
- **`enhance_prompt` agent tool** — the model can rewrite a prompt itself.
- **HTTP API** — `/enhance`, `/stream` (SSE), `/models`, `/info`, `/report`, `/selftest`.
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
| `promptStyle` | `standard` | `light` (1.2×) / `standard` (2.5×) / `deep` (4×) / `system` (structured system prompt) / `workbuddy` (verbatim original, A/B baseline). Unknown values fall back to `standard`, never `workbuddy` |
| `lengthGuard` | `true` | one converge pass when a rewrite overshoots the mode's ratio; `system`/`workbuddy` are unbounded, and every mode is floored at 600 chars so the guard cannot squeeze out the execution detail `standard` is required to add |
| `fidelityGuard` | `true` | extract fact anchors before the call, verify each one survived after it |
| `fidelityRepair` | `true` | one repair pass when facts went missing — never pipelined, never retried twice |
| `refineMode` | `true` | let the model turn a vague draft into an executable task instead of interrogating you |
| `contextAware` / `contextTurns` / `contextChars` | `true` / `6` / `4000` | carry recent turns only when the draft is anaphoric ("make that plan better") |
| `stream` | `true` | serve `/stream` as SSE; off means wait for the whole answer |
| `provider`, `model` | `''` | empty = automatic candidate chain |
| `providerPriority` | `[]` | provider ids to try first |
| `reasoningEffort` | `''` | empty = send no effort. The model default cost 11.5× the output tokens on this mechanical task |
| `maxAttempts` | `6` | how many candidate routes one enhancement may try |
| `totalBudgetMs` | `90000` | wall-clock ceiling for the whole chain, so a dead provider cannot burn `maxAttempts × timeoutMs` |
| `maxConcurrency` | `2` | concurrent enhancements; extra requests get `429 busy` |
| `idempotent` | `true` | sha256 cache + single-flight, so double-clicking the star costs one model call |
| `temperature` | `0.3` | |
| `maxTokens` | `4000` | reasoning tokens count against this |
| `timeoutMs` | `60000` | per route |
| `minTextLength` | `1` | matches WorkBuddy; `0` really does disable the check |
| `maxInputChars` | `8000` | reject longer drafts (`too_long`) |
| `customSystemPrompt` / `customUserTemplate` | `''` | override; the template must contain `{input}` |
| `stripWrappingQuotes` / `stripCodeFence` | `true` | same cleanup as the original |
| `announceToAgent` / `toolsEnabled` | `true` | expose `enhance_prompt` |
| `allowRemote` | `false` | only loopback clients may call the HTTP API |
| `requireHeader` | `true` | browser requests must carry `x-dsh-enhance: 1` (blocks cross-site `fetch`/forms) |
| `rateLimitPerMinute` | `30` | per client token bucket; self-test is capped at 2/min |
| `selfTestOnStart` | `false` | one real model call per load when enabled. The structural check (prompts/modes/routes/guard/log/version) always runs for free; its result is `/info.startupCheck` |

## API

```http
POST /dsh-enhance-prompt/enhance
x-dsh-enhance: 1
{ "text": "帮我写个爬虫", "style": "standard", "effort": "low", "force": false }
→ { "ok": true, "text": "...", "meta": { "mode", "modeLabel", "provider", "model", "route", "ms", "chars",
    "draftChars", "ratio", "ratioLabel", "budget", "anchors": { "total", "kept", "reinjected" },
    "note", "repaired", "contextUsed", "contextReason", "language", "cached" } }
→ { "ok": false, "code": "empty|too_long|forbidden|rate_limited|busy|timeout|upstream|empty_output|no_route|llm_unavailable|disabled|bad_request", "error": "..." }

POST /dsh-enhance-prompt/stream      # SSE, same body
event: route   data: { "provider": "magpie", "model": "group/deepseek" }
event: delta   data: { "text": "partial" }
event: done    data: { "ok": true, "text": "...", "meta": { …same as /enhance… } }
event: error   data: { "ok": false, "code": "upstream", "error": "..." }   # same code set as /enhance

GET  /dsh-enhance-prompt/models      # provider groups (sleeping ones included) with per-model reasoning efforts
GET  /dsh-enhance-prompt/info        # version, style, guards, context, effort, resolved route, stats, startup checks
POST /dsh-enhance-prompt/selftest    # one real model call; 405 on GET so a browser tab cannot trigger it
POST /dsh-enhance-prompt/report      # browser-side failure reporting, written to the log
```

`meta.anchors.reinjected > 0` means facts were dropped and one repair pass ran — in that case the length ceiling yields: too long is acceptable, missing content is not.

Status codes: `400` bad input, `401/403` header or loopback refused, `405` wrong method, `413` body over 256 KB or draft over
`maxInputChars`, `422` language flip or length rejection, `429` concurrency or rate limit, `502` model failure,
`503` disabled / no route, `504` timeout.

`/api/enhance-prompt/*` used to be an alias but the host's API gateway claims that prefix and answers 401, so it was removed in 0.4.0 — use `/dsh-enhance-prompt/*`.

## Verification

```powershell
npm test                              # 40 checks, no model call: anchors (18) + prompts (9) + client (9) + host contract (6)
npm run check                         # node --check on all four entry files
node test/api.mjs                     # HTTP contract against the running host (7 checks, 1 real model call)
node test/api.mjs --no-model          # same, minus the paid call
node test/live.mjs                    # hit a gateway directly, check language following
node test/compare.mjs --round 6 --passes 5   # A/B against WorkBuddy's prompt
node tools/report.mjs                 # regenerate docs/compare-report.md
```

`npm test` deliberately names its four files instead of using bare `node --test`: `test/compare.mjs` and `test/live*.mjs` make real model calls and must never be swept into a unit run.

`test/client.test.mjs` runs the shipped `lib/client.js` source through `new Function` with stubbed `window`/`document`/`fetch`, captures the `__ModuleLoader__.load({ id, factory })` call, and asserts against `exports.__internals` — so it tests the published artifact, not a copy of it.

A passing `GET /dsh-enhance-prompt/info` must show `"startup": { "ok": true }` and a `route` with a **non-empty**
`model`; `version` must equal `package.json`. See `docs/audit-v0.4.md` for the full before/after audit.

## Known limits

- Accepting a rewrite replaces the **whole draft**; block/quote structure is not preserved. You see the diff first, but there is no per-hunk accept.
- The undo stack is 8 entries deep and keyed to this browser profile. `localStorage` being unavailable (private mode) silently degrades to in-memory-only for the session.
- Only binds the `conversation.input.right` slot. If a host version renames that slot, the button silently disappears instead of erroring.
- The button disables itself while `@references` are attached, because whether `setDraft` clears the reference list cannot be verified from the host side. Dropping your attached files silently would be worse than making you clear them first.
- The HTTP API is localhost-only and header-gated by default. If you flip `allowRemote`, you are exposing a route that spends your model quota — put it behind a proxy that authenticates.
- Route selection is per provider+model and persisted for 7 days; a provider that answers with an auth/balance error is cooled down for 10 minutes, not removed.

## License

MIT. The two WorkBuddy prompt constants shipped in `lib/prompts.js` are included as reverse-engineering reference for interoperability; the plugin's default style is an independent rewrite.
