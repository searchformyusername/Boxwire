// Line diff for showing and exporting a source patch: an LCS over lines
// (bounded, so a pathological pair degrades to one hunk instead of hanging),
// grouped into unified-diff hunks with context.

const MAX_CELLS = 4e6

/** Edit script between two line arrays: [{ type: 'same'|'del'|'add', line }]. */
function script(a, b) {
  let lo = 0
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++
  let ea = a.length, eb = b.length
  while (ea > lo && eb > lo && a[ea - 1] === b[eb - 1]) ea--, eb--
  const A = a.slice(lo, ea), B = b.slice(lo, eb)
  const head = a.slice(0, lo).map((line) => ({ type: 'same', line }))
  const tail = a.slice(ea).map((line) => ({ type: 'same', line }))
  if (A.length * B.length > MAX_CELLS) return [...head, ...A.map((line) => ({ type: 'del', line })), ...B.map((line) => ({ type: 'add', line })), ...tail]
  const n = A.length, m = B.length
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const mid = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (A[i] === B[j]) mid.push({ type: 'same', line: A[i++] }), j++
    else if (L[i + 1][j] >= L[i][j + 1]) mid.push({ type: 'del', line: A[i++] })
    else mid.push({ type: 'add', line: B[j++] })
  }
  while (i < n) mid.push({ type: 'del', line: A[i++] })
  while (j < m) mid.push({ type: 'add', line: B[j++] })
  return [...head, ...mid, ...tail]
}

/**
 * Hunks between two texts: [{ oldStart, oldLines, newStart, newLines, lines: [' x', '-y', '+z'] }]
 * (1-based starts, `context` unchanged lines around each change).
 */
export function lineDiff(before, after, { context = 2 } = {}) {
  const ops = script(before.split('\n'), after.split('\n'))
  const hunks = []
  let oldNo = 1, newNo = 1, cur = null, since = 0, pending = []
  ops.forEach((op, k) => {
    if (op.type !== 'same') {
      if (!cur) {
        const back = []
        for (let b = k - 1; b >= 0 && back.length < context && ops[b].type === 'same'; b--) back.unshift(ops[b].line)
        cur = { oldStart: oldNo - back.length, newStart: newNo - back.length, oldLines: back.length, newLines: back.length, lines: back.map((l) => ' ' + l) }
        hunks.push(cur)
      }
      // unchanged lines between two nearby changes belong to the same hunk
      for (const l of pending) cur.lines.push(' ' + l), cur.oldLines++, cur.newLines++
      pending = []
      since = 0
      cur.lines.push((op.type === 'del' ? '-' : '+') + op.line)
      if (op.type === 'del') cur.oldLines++
      else cur.newLines++
    } else if (cur) {
      since++
      if (since <= context) {
        cur.lines.push(' ' + op.line)
        cur.oldLines++
        cur.newLines++
      } else if (since > context * 2) {
        cur = null
        pending = []
      } else pending.push(op.line)
    }
    if (op.type !== 'add') oldNo++
    if (op.type !== 'del') newNo++
  })
  return hunks
}

/** A unified diff text (git-style headers) for a list of hunks. */
export function unified(hunks, { from = 'a/baseline.boxwire.jsonc', to = 'b/accepted.boxwire.jsonc' } = {}) {
  if (!hunks.length) return ''
  return [`--- ${from}`, `+++ ${to}`, ...hunks.flatMap((h) => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines])].join('\n') + '\n'
}

/** Changed-line counts: { removed, added }. */
export const churn = (hunks) => hunks.reduce((s, h) => ({ removed: s.removed + h.lines.filter((l) => l[0] === '-').length, added: s.added + h.lines.filter((l) => l[0] === '+').length }), { removed: 0, added: 0 })
