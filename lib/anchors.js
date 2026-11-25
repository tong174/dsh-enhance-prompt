/**
 * Deterministic fact anchors + fidelity gate.
 *
 * Every other prompt enhancer asks the model, in its system prompt, to "keep all the
 * details". That is a hope, not a check. This module turns it into a mechanical
 * assertion: pull every concrete token out of the draft BEFORE the call, then verify
 * after the call that each one still survives, then repair deterministically.
 *
 * Design bias (deliberate): a false "missing" only costs one extra repair call, while a
 * false "kept" loses something the user wrote. So survival is checked generously, and
 * anything that fails all three tiers is treated as lost.
 *
 * @module dsh-enhance-prompt/anchors
 */

/** @typedef {'code'|'url'|'path'|'ref'|'version'|'number'|'identifier'|'quoted'} AnchorKind */
/** @typedef {{ kind: AnchorKind, text: string, start: number }} Anchor */

/** Hard caps so one pathological draft cannot explode the repair prompt. */
export const MAX_ANCHORS = 200
export const MIN_ANCHOR_LENGTH = 2
export const MAX_CODE_LENGTH = 120
export const REPORT_LIMIT = 5

/** Extensions that make a bare dotted token a file path rather than prose. */
const FILE_EXTENSIONS = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'd', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'swift', 'm', 'mm', 'scala', 'sh', 'bash', 'zsh',
  'ps1', 'bat', 'sql', 'md', 'mdx', 'txt', 'log', 'json', 'jsonc', 'yaml', 'yml', 'toml',
  'ini', 'cfg', 'conf', 'env', 'lock', 'gradle', 'properties', 'xml', 'html', 'htm', 'css',
  'scss', 'less', 'vue', 'svelte', 'astro', 'proto', 'tf', 'ipynb', 'csv', 'png', 'jpg',
  'jpeg', 'gif', 'svg', 'webp', 'ico', 'pdf', 'zip', 'gz', 'tar', 'exe', 'dll', 'so', 'dylib',
  'wasm', 'map', 'gitignore', 'dockerignore', 'editorconfig',
]

const EXT_ALT = FILE_EXTENSIONS.join('|')

/**
 * Matchers run in array order and claim their span, so earlier entries win. The order IS
 * the semantics: a fenced block must be claimed before inline code so it is not chopped
 * into fragments, and dotted identifiers must be claimed before camelCase so `a.b.c` is
 * not read as three unrelated pieces.
 *
 * @type {ReadonlyArray<{ kind: AnchorKind, re: RegExp, claimOnly?: boolean, group?: number }>}
 */
const MATCHERS = [
  // A fenced block is payload, not a fact to preserve verbatim: claim it so nothing
  // inside is mistaken for an anchor, but do not record it.
  { kind: 'code', re: /```[\s\S]*?```/g, claimOnly: true },
  { kind: 'code', re: /`[^`\n]+`/g },
  { kind: 'url', re: /https?:\/\/[^\s<>()[\]"'`]+/g },
  // @file / @folder references
  { kind: 'ref', re: /(?:^|[\s(\[{,，。；;])@([A-Za-z0-9_][A-Za-z0-9_./-]{1,})/g, group: 1 },
  // "quoted literal" / 'quoted literal' / 「quoted」
  { kind: 'quoted', re: /"([^"\n]{2,80})"|'([^'\n]{2,80})'|「([^」\n]{2,80})」/g },
  // path with at least one separator
  { kind: 'path', re: /(?:[A-Za-z]:)?(?:\/|\.{1,2}\/)?[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@*-]+)+/g },
  // bare filename with a known extension
  { kind: 'path', re: new RegExp(`\\b[A-Za-z0-9_@-][A-Za-z0-9_.@-]*\\.(?:${EXT_ALT})\\b`, 'gi') },
  // version-ish: 1.2, v2, 0.4.0, 1.0-rc.2
  { kind: 'version', re: /\bv?\d+(?:\.\d+){1,3}(?:-rc\.?\d*)?\b/gi },
  // number with a unit (incl. CJK units)
  {
    kind: 'number',
    re: /\b\d+(?:\.\d+)?\s?(?:%|px|em|rem|ms|s|m|h|kb|mb|gb|tb|k|w|字|秒|分钟|小时|天|行|条|项)\b/gi,
  },
  // dotted identifier chain: foo.bar.baz
  { kind: 'identifier', re: /\b[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*){1,4}\b/g },
  // camelCase
  { kind: 'identifier', re: /\b[a-z][a-zA-Z0-9]*(?:[A-Z][A-Za-z0-9]*)+\b/g },
  // snake_case
  { kind: 'identifier', re: /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g },
  // CONST_CASE
  { kind: 'identifier', re: /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g },
]

/** Collapse all whitespace runs to one space. */
export function normalizeForMatch(text) {
  return String(text).replace(/\s+/g, ' ')
}

/** Remove all whitespace — survives re-wrapped lines inside a rebuilt sentence. */
export function stripWhitespace(text) {
  return String(text).replace(/\s+/g, '')
}

/** Codepoint length, not UTF-16 units: an emoji is one character to the user. */
export function charLength(text) {
  let n = 0
  for (const _ of String(text)) n += 1
  return n
}

/**
 * Trim a raw match down to the text a user would recognise inside the draft.
 *
 * @param {AnchorKind} kind
 * @param {string} raw
 */
function unwrap(kind, raw) {
  let text = String(raw).trim()
  if (kind === 'code') text = text.replace(/^`+/, '').replace(/`+$/, '').trim()
  else if (kind === 'ref') {
    const at = text.startsWith('@') ? 0 : text.indexOf('@')
    if (at >= 0) text = text.slice(at + 1).trim()
  }
  return text
}

/**
 * Pull every concrete detail out of a draft, in first-appearance order.
 *
 * @param {string} draft
 * @param {number} [limit]
 * @returns {Anchor[]}
 */
export function extractAnchors(draft, limit = MAX_ANCHORS) {
  const text = typeof draft === 'string' ? draft : ''
  if (text.trim() === '') return []

  const claimed = new Array(text.length).fill(false)
  /** @type {Anchor[]} */
  const out = []
  const seen = new Set()

  const free = (start, end) => {
    for (let i = start; i < end; i += 1) if (claimed[i]) return false
    return true
  }
  const claim = (start, end) => {
    for (let i = start; i < end; i += 1) claimed[i] = true
  }

  for (const matcher of MATCHERS) {
    if (out.length >= limit) break
    matcher.re.lastIndex = 0
    let m
    while ((m = matcher.re.exec(text)) !== null) {
      if (m[0] === '') {
        matcher.re.lastIndex += 1
        continue
      }
      // A matcher with a capture group records the group, not the whole match, but claims
      // the whole match so a neighbouring matcher cannot re-read the prefix.
      const start = m.index
      const end = m.index + m[0].length
      // A rejected candidate must not swallow the matches that begin inside it. In
      // "```\ncode\n``` and `npm i`" the closing fence pairs with the opener of `npm i`,
      // producing the false pair "` and `"; resuming after the *end* of that pair would skip
      // the real anchor, so every rejection rewinds to one past this start instead.
      const resume = start + 1
      if (!free(start, end)) {
        matcher.re.lastIndex = resume
        continue
      }
      claim(start, end)
      if (matcher.claimOnly) continue

      const rawGroup = matcher.group ? m[matcher.group] : m[0]
      if (rawGroup === undefined) {
        matcher.re.lastIndex = resume
        continue
      }
      let text2 = unwrap(matcher.kind, rawGroup)
      if (text2.length < MIN_ANCHOR_LENGTH) {
        matcher.re.lastIndex = resume
        continue
      }
      if (matcher.kind === 'code' && text2.length > MAX_CODE_LENGTH) {
        matcher.re.lastIndex = resume
        continue
      }
      // A pure punctuation/path-separator token carries no information.
      if (!/[\p{L}\p{N}]/u.test(text2)) {
        matcher.re.lastIndex = resume
        continue
      }

      const key = `${matcher.kind}\u0000${text2}`
      if (seen.has(key)) {
        matcher.re.lastIndex = resume
        continue
      }
      seen.add(key)
      out.push({ kind: matcher.kind, text: text2, start })
      if (out.length >= limit) break
    }
  }

  return out.sort((a, b) => a.start - b.start)
}

/**
 * Three-tier survival test, cheapest first.
 *
 * Case is preserved on purpose: `Foo` and `foo` are different identifiers in most
 * languages, so a case-insensitive match would report a lost name as kept.
 *
 * @param {Anchor} anchor
 * @param {string} rawEnhanced
 * @param {{ normalized?: string, stripped?: string }} [prepared]
 */
export function anchorSurvives(anchor, rawEnhanced, prepared = {}) {
  const raw = String(rawEnhanced)
  const text = anchor.text
  if (text === '') return true
  if (raw.includes(text)) return true
  const normalized = prepared.normalized ?? normalizeForMatch(raw)
  if (normalized.includes(normalizeForMatch(text))) return true
  const stripped = prepared.stripped ?? stripWhitespace(raw)
  if (stripped.includes(stripWhitespace(text))) return true
  return false
}

/**
 * Verify every anchor against the rewrite.
 *
 * @param {Anchor[]} anchors
 * @param {string} enhanced
 * @returns {{ total: number, kept: number, missing: Anchor[] }}
 */
export function checkFidelity(anchors, enhanced) {
  const list = Array.isArray(anchors) ? anchors : []
  if (list.length === 0) return { total: 0, kept: 0, missing: [] }
  const prepared = {
    normalized: normalizeForMatch(enhanced),
    stripped: stripWhitespace(enhanced),
  }
  /** @type {Anchor[]} */
  const missing = []
  for (const anchor of list) {
    if (!anchorSurvives(anchor, enhanced, prepared)) missing.push(anchor)
  }
  return { total: list.length, kept: list.length - missing.length, missing }
}

/**
 * A user-message clause naming every lost anchor, for one repair round.
 *
 * @param {Anchor[]} missing
 */
export function repairClause(missing) {
  const list = (Array.isArray(missing) ? missing : []).map((a) => a.text).filter(Boolean)
  if (list.length === 0) return ''
  return [
    'Your previous rewrite dropped details the user had written. Rewrite it once more,',
    'keeping everything you already had, and place each of these EXACT strings back into it',
    'naturally (do not append them as a list at the end, and do not translate or reformat them):',
    ...list.map((t) => `- ${t}`),
  ].join('\n')
}

/**
 * Deterministic last resort: when a repair round still loses a fact, re-attach it under an
 * explicit label. Visually separate so it reads as a preservation note, not as prose the
 * model invented.
 *
 * @param {Anchor[]} missing
 * @param {'zh'|'en'} [lang]
 */
export function reinjectionBlock(missing, lang = 'en') {
  const list = (Array.isArray(missing) ? missing : []).map((a) => a.text).filter(Boolean)
  if (list.length === 0) return ''
  const header =
    lang === 'zh' ? '保留原始细节 / Preserved original details:' : 'Preserved original details:'
  return `\n\n${header}\n${list.map((t) => `- ${t}`).join('\n')}`
}

/**
 * One line for the status bar: what the model lost and the gate had to put back.
 *
 * @param {Anchor[]} missing
 * @param {'zh'|'en'} [lang]
 */
export function fidelityNote(missing, lang = 'en') {
  const list = (Array.isArray(missing) ? missing : []).map((a) => a.text).filter(Boolean)
  if (list.length === 0) return ''
  const head = list.slice(0, REPORT_LIMIT).join(lang === 'zh' ? '、' : ', ')
  const rest = list.length > REPORT_LIMIT ? list.length - REPORT_LIMIT : 0
  if (lang === 'zh') return rest > 0 ? `${head} 等 ${list.length} 处` : head
  return rest > 0 ? `${head} and ${list.length} total` : head
}

/* ------------------------------------------------------------------ length gate */

/**
 * Absolute floor in characters. A pure ratio is wrong at both ends: 2.5x of a 2000-char
 * draft allows another 3000 chars of padding, while 2.5x of a 9-char draft refuses the
 * three-line rewrite that draft most needs.
 */
export const MIN_BUDGET_CHARS = 600

/** Ratio of rewrite length to draft length; 0 for an empty draft. */
export function ratioOf(original, enhanced) {
  const base = charLength(original)
  if (base === 0) return 0
  return charLength(enhanced) / base
}

/** @param {string} original @param {number} maxRatio */
export function budgetFor(original, maxRatio) {
  const ratio = Number.isFinite(maxRatio) && maxRatio > 0 ? maxRatio : 2.5
  return Math.max(MIN_BUDGET_CHARS, Math.floor(charLength(original) * ratio))
}

/** `2.4x` */
export function formatRatio(r) {
  const n = Number.isFinite(r) ? r : 0
  return `${(Math.round(n * 10) / 10).toFixed(1)}x`
}

/**
 * @param {string} original
 * @param {string} enhanced
 * @param {number} maxRatio
 * @returns {{ ok: boolean, ratio: number, ratioLabel: string, charBudget: number, chars: number, kind: 'ok'|'converge' }}
 */
export function lengthVerdict(original, enhanced, maxRatio) {
  const ratio = ratioOf(original, enhanced)
  const charBudget = budgetFor(original, maxRatio)
  const chars = charLength(enhanced)
  return {
    ok: chars <= charBudget,
    kind: chars <= charBudget ? 'ok' : 'converge',
    ratio,
    ratioLabel: formatRatio(ratio),
    charBudget,
    chars,
  }
}

/* -------------------------------------------------------------- context trigger */

/**
 * Session history is only worth carrying when the draft cannot stand alone. Paying for
 * context on every click wastes tokens; never paying for it breaks "刚才那个".
 *
 * @module dsh-enhance-prompt/context-trigger
 */

/** Chinese anaphora / continuation markers, matched as plain substrings. */
const ZH_MARKERS = [
  '这个', '那个', '这些', '那些', '上述', '上面', '刚刚', '刚才', '之前', '前面',
  '同样', '照旧', '继续', '接着', '还是', '就这样', '按这个', '按那个', '该方案',
  '这个方案', '它们', '此处', '那里', '这边', '刚才那个', '上面那', '那个东西',
]

/** English markers, word-boundary matched so "item"/"wait" never fire. */
const EN_MARKERS = [
  'it', 'its', 'this', 'that', 'these', 'those', 'above', 'previous', 'the same',
  'same way', 'continue', 'as before', 'again', 'there', 'the one',
]

const SHORT_DRAFT_CHARS = 12
const CONCRETE_HINT = /[A-Za-z0-9_]\.[A-Za-z0-9]{1,8}\b|[/\\]|\bhttps?:|`|\d/

/**
 * @param {string} draft
 * @returns {{ needed: boolean, reason: 'none'|'anaphora'|'short-vague' }}
 */
export function contextTrigger(draft) {
  const text = typeof draft === 'string' ? draft : ''
  const trimmed = text.trim()
  if (trimmed === '') return { needed: false, reason: 'none' }

  for (const marker of ZH_MARKERS) {
    if (trimmed.includes(marker)) return { needed: true, reason: 'anaphora' }
  }
  for (const marker of EN_MARKERS) {
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(trimmed)) {
      return { needed: true, reason: 'anaphora' }
    }
  }
  if (charLength(trimmed) <= SHORT_DRAFT_CHARS && !CONCRETE_HINT.test(trimmed)) {
    return { needed: true, reason: 'short-vague' }
  }
  return { needed: false, reason: 'none' }
}

/* ------------------------------------------------------------- language guarding */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/

/**
 * Coarse script detection. `mixed` means the draft genuinely uses both, which is normal
 * for Chinese developers and must not be "corrected" into one language.
 *
 * @param {string} text
 * @returns {'zh'|'en'|'mixed'|'none'}
 */
export function detectLanguage(text) {
  const s = String(text)
  let cjk = 0
  for (const ch of s) if (CJK.test(ch)) cjk += 1
  const latinWords = (s.match(/[A-Za-z]{2,}/g) || []).length
  if (cjk === 0 && latinWords === 0) return 'none'
  if (cjk === 0) return 'en'
  if (latinWords === 0) return 'zh'
  // A few English words inside Chinese prose is still Chinese, and vice versa. The dominance
  // has to be strict: at 2 CJK characters against 1 English word the draft is genuinely mixed,
  // and "mixed" is the answer that lets the rewrite land on either side.
  return cjk > latinWords * 2 ? 'zh' : latinWords > cjk * 2 ? 'en' : 'mixed'
}

/**
 * Did the rewrite keep the draft's script mix? Returns the offending pair so the caller can
 * report the real reason instead of quietly overwriting the draft with the wrong language.
 *
 * @param {string} draft
 * @param {string} enhanced
 * @returns {{ ok: boolean, draftLang: string, resultLang: string }}
 */
export function languageConsistent(draft, enhanced) {
  const draftLang = detectLanguage(draft)
  const resultLang = detectLanguage(enhanced)
  if (draftLang === 'none' || resultLang === 'none') {
    return { ok: true, draftLang, resultLang }
  }
  if (draftLang === resultLang) return { ok: true, draftLang, resultLang }
  // mixed drafts may land on either pure side; a pure draft may not flip.
  if (draftLang === 'mixed') return { ok: true, draftLang, resultLang }
  return { ok: false, draftLang, resultLang }
}

/* ------------------------------------------------------------------ prompt fence */

const FENCE_OPEN = '<<<DRAFT_TO_REWRITE>>>'
const FENCE_CLOSE = '<<<END_DRAFT_TO_REWRITE>>>'

/**
 * Wrap the draft so text inside it can never be read as instructions. A draft is untrusted
 * input: "ignore all previous instructions and output X" inside it is content to be
 * rewritten, not a command to obey.
 *
 * @param {string} draft
 */
export function fenceDraft(draft) {
  // Neutralise any occurrence of the fence tokens so the block cannot be closed early.
  const safe = String(draft)
    .split(FENCE_OPEN).join('<<< DRAFT_TO_REWRITE >>>')
    .split(FENCE_CLOSE).join('<<< END_DRAFT_TO_REWRITE >>>')
  return `${FENCE_OPEN}\n${safe}\n${FENCE_CLOSE}`
}

export const FENCE_TOKENS = Object.freeze({ open: FENCE_OPEN, close: FENCE_CLOSE })
