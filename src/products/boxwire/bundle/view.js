// The review as plain display strings: what review.html shows and what the
// host app may print. Results are opaque JSON from the change/policy modules,
// so this reads them tolerantly (several key spellings, strings or objects)
// and never trusts them: every string is stripped of control and bidi
// characters and clipped.

export const INTEGRITY_NOTE = 'SHA-256 hashes establish file integrity and which baseline and proposal were compared. They do not identify a reviewer and are not an approval or signature.'

const MAX_ITEMS = 1000
const MAX_TEXT = 400

// C0/C1 controls (newline and tab kept by callers that want them), bidi overrides/isolates, zero-width joiners.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g

/** A display-safe single-line string. */
export function clean(v, max = MAX_TEXT) {
  const s = (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v) ?? String(v)).replace(UNSAFE, '').replace(/[\n\t\r]+/g, ' ')
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const get = (o, path) => path.split('.').reduce((v, k) => (isObj(v) ? v[k] : undefined), o)
const firstArray = (o, paths) => {
  for (const p of paths) {
    const v = get(o, p)
    if (Array.isArray(v)) return v
  }
  return []
}

const KEYS = {
  semantic: ['semantic', 'semanticChanges', 'diff.semantic', 'changes.semantic', 'diff.changes'],
  layout: ['layout', 'layoutChanges', 'diff.layout', 'changes.layout'],
  identity: ['identity', 'diff.identity'],
  rules: ['rules', 'ruleResults', 'diagnostics', 'policy.results', 'review.results', 'checks'],
  conflicts: ['conflicts', 'merge.conflicts', 'diff.conflicts'],
}

/** 1-based line:col of UTF-16 offset `at` in `text`. */
export function lineCol(text, at) {
  let line = 1, last = -1
  for (let i = 0; i < at && i < text.length; i++) if (text.charCodeAt(i) === 10) { line++; last = i }
  return { line, col: Math.min(at, text.length) - last }
}

const point = (p, text) => {
  if (typeof p === 'number' && Number.isFinite(p)) return text === undefined ? `@${p}` : fmt(lineCol(text, p))
  if (isObj(p) && Number.isFinite(p.line)) return fmt({ line: p.line, col: p.col ?? p.column ?? p.character ?? 1 })
  if (isObj(p) && Number.isFinite(p.offset)) return point(p.offset, text)
  return null
}
const fmt = ({ line, col }) => `${line}:${col}`

/** "proposal 12:3–12:20" for a span object; offsets become line:col against the named source. */
function range(r, sources) {
  if (!isObj(r)) return null
  const file = clean(r.file ?? r.side ?? r.source ?? r.in ?? r.doc ?? '', 80)
  const text = sources[file.replace(/\.boxwire\.jsonc$/, '')]
  const start = point(r.start ?? r.from ?? (Number.isFinite(r.line) ? r : undefined), text)
  if (!start) return null
  const end = point(r.end ?? r.to, text)
  return `${file ? file + ' ' : ''}${start}${end && end !== start ? '–' + end : ''}`
}

function ranges(item, sources) {
  const out = []
  for (const k of ['range', 'ranges', 'span', 'spans', 'location', 'locations', 'sourceRange', 'sourceRanges']) {
    const v = item[k]
    for (const r of Array.isArray(v) ? v : v ? [v] : []) {
      const s = range(r, sources)
      if (s) out.push(s)
    }
  }
  return out.slice(0, 20)
}

const step = (s) => clean(isObj(s) ? s.id ?? s.label ?? s.name ?? s : s, 80)
function witness(item) {
  const w = item.witness ?? item.path ?? item.witnessPath
  const list = Array.isArray(w) ? w : isObj(w) ? w.path ?? w.nodes ?? w.ids ?? (w.from && w.to ? [w.from, w.to] : null) : null
  return Array.isArray(list) && list.length ? list.slice(0, 50).map(step).join(' → ') : ''
}

const preview = (v) => (v === undefined ? '' : clean(v, 120))
function describe(item) {
  if (!isObj(item)) return { text: clean(item), detail: '' }
  const target = item.id ?? item.target ?? item.ref ?? item.path ?? item.key
  const text = item.summary ?? item.message ?? item.description ?? item.title ??
    [item.op ?? item.type ?? item.change ?? 'change', item.kind ?? item.object, target].filter((x) => x !== undefined).map((x) => clean(x, 80)).join(' ')
  const pairs = [['before', 'after'], ['base', 'proposal'], ['ours', 'theirs'], ['from', 'to']]
  const pair = pairs.find(([a, b]) => item[a] !== undefined || item[b] !== undefined)
  let detail = pair ? `${preview(item[pair[0]]) || '∅'} → ${preview(item[pair[1]]) || '∅'}` : ''
  if (pair?.[0] === 'base' && item.ours !== undefined) detail = `base ${preview(item.base) || '∅'}; ours ${preview(item.ours) || '∅'}; proposal ${preview(item.proposal ?? item.theirs) || '∅'}`
  return { text: clean(text), detail }
}

function list(results, key, sources, extra) {
  const all = firstArray(results, KEYS[key])
  const items = all.slice(0, MAX_ITEMS).map((it) => ({ ...describe(it), ranges: isObj(it) ? ranges(it, sources) : [], ...(extra && isObj(it) ? extra(it) : {}) }))
  return { items, more: Math.max(0, all.length - MAX_ITEMS) }
}

const ruleExtra = (it) => ({
  status: clean(it.status ?? it.outcome ?? it.level ?? '', 40),
  severity: clean(it.severity ?? '', 40),
  rule: clean(it.rule ?? it.ruleId ?? it.code ?? '', 80) + (it.ruleVersion !== undefined ? ` v${clean(it.ruleVersion, 20)}` : ''),
  witness: witness(it),
})

/**
 * View model for a review. `sources` maps 'baseline' | 'proposal' | 'accepted'
 * to source text, used to turn offset spans into line:col.
 */
export function reviewView({ manifest, results, sources = {} }) {
  const r = isObj(results) ? results : {}
  return {
    name: clean(manifest.name, 200),
    createdAt: clean(manifest.createdAt, 40),
    tool: clean(`${manifest.tool?.name ?? ''} ${manifest.tool?.version ?? ''}`.trim(), 80),
    baselineHash: clean(manifest.baselineHash, 64),
    proposalHash: clean(manifest.proposalHash, 64),
    acceptedHash: manifest.acceptedHash ? clean(manifest.acceptedHash, 64) : '',
    note: INTEGRITY_NOTE,
    files: (manifest.files ?? []).map((f) => ({ path: clean(f.path, 120), sha256: clean(f.sha256, 64), bytes: Number(f.bytes) || 0 })),
    semantic: list(r, 'semantic', sources),
    layout: list(r, 'layout', sources),
    identity: list(r, 'identity', sources),
    rules: list(r, 'rules', sources, ruleExtra),
    conflicts: list(r, 'conflicts', sources),
    // whether rule results on the two sides could be compared; an aborted evaluation resolves nothing
    comparison: isObj(r.comparison) && r.comparison.status === 'not-evaluated'
      ? `Rule comparison: NOT EVALUATED. ${(Array.isArray(r.comparison.reasons) ? r.comparison.reasons : []).map((x) => clean(x, 300)).join(' ')} No violation is reported as introduced or resolved.`
      : isObj(r.comparison) ? 'Rule comparison: complete on both sides.' : '',
  }
}

const SECTIONS = [['semantic', 'Semantic changes'], ['layout', 'Layout changes'], ['identity', 'Identity changes (connector ids written down)'], ['rules', 'Rule results'], ['conflicts', 'Conflicts']]

/** The view as plain text lines (the noscript fallback and the host app's summary). */
export function summaryLines(view) {
  const lines = [
    `Review: ${view.name}`,
    `Created: ${view.createdAt} with ${view.tool}`,
    `Baseline SHA-256: ${view.baselineHash}`,
    `Proposal SHA-256: ${view.proposalHash}`,
    ...(view.acceptedHash ? [`Accepted SHA-256: ${view.acceptedHash}`] : []),
    view.note,
    ...(view.comparison ? [view.comparison] : []),
  ]
  for (const [key, title] of SECTIONS) {
    const { items, more } = view[key]
    lines.push('', `${title} (${items.length + more})`)
    if (!items.length) lines.push('  none')
    for (const it of items) {
      const head = key === 'rules' ? [it.status && `[${it.status}]`, it.rule, it.text].filter(Boolean).join(' ') : it.text
      lines.push(`  - ${head}${it.detail ? ` (${it.detail})` : ''}`)
      if (it.witness) lines.push(`    witness: ${it.witness}`)
      if (it.ranges.length) lines.push(`    source: ${it.ranges.join(', ')}`)
    }
    if (more) lines.push(`  … and ${more} more`)
  }
  return lines
}
