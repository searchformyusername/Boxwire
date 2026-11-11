// Concrete syntax tree for Boxwire source files: JSON with comments (JSONC).
//
// A hand-written tokenizer and recursive-descent parser for JSON plus `//` and
// `/* */` comments and trailing commas. Every token keeps its exact text,
// offsets and line/column, with the whitespace and comments around it
// attached as trivia, so printing the tree reproduces the file byte for byte
// and source/edit.js can change only the bytes it means to. Trivia on the
// same line after a token is that token's trailing trivia; everything from
// the next line break on leads the following token.
//
// Parsing never throws. A problem comes back as one error with its offset and
// line/column, and `value` is null so the caller keeps its last good model.

export const SOURCE_LIMITS = { bytes: 5 * 1024 * 1024, depth: 64, tokens: 200000 }

const PUNCT = new Set(['{', '}', '[', ']', ':', ','])
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y
const WORD = /[A-Za-z_$][\w$]*/y
const LITERALS = { true: true, false: false, null: null }

class ParseError extends Error {
  constructor(message, start, end = start) {
    super(message)
    this.start = start
    this.end = end
  }
}

/** 1-based line and column (UTF-16 code units) of an offset. */
function locator(text) {
  const starts = [0]
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
  return (offset) => {
    let lo = 0, hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return { line: lo + 1, col: offset - starts[lo] + 1 }
  }
}

function utf8Length(text) {
  if (text.length * 3 <= SOURCE_LIMITS.bytes) return text.length
  return new TextEncoder().encode(text).length
}

/** Tokens with trivia attached; the last token is `eof` (empty text) and leads with whatever trails the document. */
function tokenize(text, locate) {
  const tokens = []
  let i = 0
  let pending = [] // trivia since the previous token
  const n = text.length

  const attach = (tok) => {
    const prev = tokens[tokens.length - 1]
    let k = 0
    if (prev) {
      while (k < pending.length && pending[k].type !== 'newline') k++
      prev.trailing = pending.slice(0, k)
    }
    tok.leading = pending.slice(k)
    tok.trailing = []
    pending = []
    Object.assign(tok, locate(tok.start))
    tokens.push(tok)
    if (tokens.length > SOURCE_LIMITS.tokens) throw new ParseError(`The file has more than ${SOURCE_LIMITS.tokens} tokens.`, tok.start)
  }
  const trivia = (type, start, end) => pending.push({ type, text: text.slice(start, end), start, end })

  while (i < n) {
    const ch = text[i]
    if (ch === '\n') { trivia('newline', i, i + 1); i++; continue }
    if (ch === '\r' && text[i + 1] === '\n') { trivia('newline', i, i + 2); i += 2; continue }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '﻿') {
      let j = i + 1
      while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '﻿' || (text[j] === '\r' && text[j + 1] !== '\n'))) j++
      trivia('ws', i, j)
      i = j
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      let j = text.indexOf('\n', i)
      if (j < 0) j = n
      if (text[j - 1] === '\r') j--
      trivia('line', i, j)
      i = j
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const j = text.indexOf('*/', i + 2)
      if (j < 0) throw new ParseError('Unterminated block comment: add "*/".', i, i + 2)
      trivia('block', i, j + 2)
      i = j + 2
      continue
    }
    if (PUNCT.has(ch)) {
      attach({ type: ch, text: ch, start: i, end: i + 1 })
      i++
      continue
    }
    if (ch === '"') {
      const end = scanString(text, i)
      attach({ type: 'string', text: text.slice(i, end), start: i, end })
      i = end
      continue
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      NUMBER.lastIndex = i
      const m = NUMBER.exec(text)
      const end = m ? i + m[0].length : i
      if (!m || /[\w.$]/.test(text[end] ?? '')) throw new ParseError('Invalid number.', i, Math.max(end, i + 1))
      attach({ type: 'number', text: m[0], start: i, end })
      i = end
      continue
    }
    WORD.lastIndex = i
    const w = WORD.exec(text)
    if (w) {
      const end = i + w[0].length
      if (Object.hasOwn(LITERALS, w[0])) {
        attach({ type: 'literal', text: w[0], start: i, end })
        i = end
        continue
      }
      const key = /^\s*:/.test(text.slice(end, end + 64))
      throw new ParseError(key ? `Keys must be double-quoted strings: write "${w[0].slice(0, 40)}".` : `Unexpected "${w[0].slice(0, 40)}"; values are strings, numbers, true, false, null, objects or arrays.`, i, end)
    }
    if (ch === "'") throw new ParseError('Strings use double quotes (").', i, i + 1)
    throw new ParseError(`Unexpected character ${JSON.stringify(String.fromCodePoint(text.codePointAt(i)))}.`, i, i + 1)
  }
  attach({ type: 'eof', text: '', start: n, end: n })
  return tokens
}

/** End offset of the string token starting at `i` (validated: escapes, no raw control characters). */
function scanString(text, i) {
  let j = i + 1
  for (;;) {
    if (j >= text.length) throw new ParseError('Unterminated string: add the closing ".', i, j)
    const c = text.charCodeAt(j)
    if (c === 34) return j + 1
    if (c === 10 || c === 13) throw new ParseError('Unterminated string: add the closing " (line breaks inside strings are written \\n).', i, j)
    if (c < 32) throw new ParseError('Control characters in strings must be escaped.', j, j + 1)
    if (c === 92) {
      const e = text[j + 1]
      if (e === 'u') {
        if (!/^[0-9a-fA-F]{4}$/.test(text.slice(j + 2, j + 6))) throw new ParseError('Bad \\u escape: it needs four hex digits.', j, j + 2)
        j += 6
        continue
      }
      if (e === undefined || !'"\\/bfnrt'.includes(e)) throw new ParseError(`Bad escape "\\${e ?? ''}" in string.`, j, j + 2)
      j += 2
      continue
    }
    j++
  }
}

function parser(tokens) {
  let p = 0
  const peek = () => tokens[p]
  const next = () => tokens[p++]
  const describe = (t) => (t.type === 'eof' ? 'the end of the file' : `"${t.text.slice(0, 40)}"`)
  const expect = (type, message) => {
    const t = peek()
    if (t.type !== type) throw new ParseError(`${message}; found ${describe(t)}.`, t.start, t.end)
    return next()
  }

  function value(depth) {
    const t = peek()
    if (t.type === '{' || t.type === '[') {
      if (depth >= SOURCE_LIMITS.depth) throw new ParseError(`Nested deeper than ${SOURCE_LIMITS.depth} levels.`, t.start, t.end)
      return t.type === '{' ? object(depth + 1) : array(depth + 1)
    }
    if (t.type === 'string') return scalar('string', JSON.parse(next().text))
    if (t.type === 'number') return scalar('number', Number(next().text))
    if (t.type === 'literal') return scalar('literal', LITERALS[next().text])
    throw new ParseError(t.type === ',' ? 'Unexpected ",".' : `Expected a value; found ${describe(t)}.`, t.start, t.end)
  }

  function scalar(type, v) {
    const tok = tokens[p - 1]
    return { type, token: tok, value: v, first: tok, last: tok, start: tok.start, end: tok.end }
  }

  function object(depth) {
    const open = next()
    const members = []
    const out = {}
    const seen = new Set()
    while (peek().type !== '}') {
      const last = members[members.length - 1]
      const t = peek()
      if (last && !last.comma) throw new ParseError(`Expected "," or "}" after a member; found ${describe(t)}.`, t.start, t.end)
      if (t.type === ',') throw new ParseError('Unexpected ","; a comma goes between members.', t.start, t.end)
      if (t.type !== 'string') throw new ParseError(`Expected a double-quoted key or "}"; found ${describe(t)}.`, t.start, t.end)
      const key = next()
      const name = JSON.parse(key.text)
      if (seen.has(name)) throw new ParseError(`Duplicate key ${JSON.stringify(name.slice(0, 40))}.`, key.start, key.end)
      seen.add(name)
      const colon = expect(':', `Expected ":" after key ${key.text.slice(0, 40)}`)
      const v = value(depth)
      const comma = peek().type === ',' ? next() : null
      members.push({ type: 'member', key, name, colon, value: v, comma, first: key, last: comma ?? v.last, start: key.start, end: v.end })
      // own property even for "__proto__", as JSON.parse does
      Object.defineProperty(out, name, { value: v.value, writable: true, enumerable: true, configurable: true })
    }
    const close = next()
    return { type: 'object', open, close, members, value: out, first: open, last: close, start: open.start, end: close.end }
  }

  function array(depth) {
    const open = next()
    const elements = []
    while (peek().type !== ']') {
      const last = elements[elements.length - 1]
      const t = peek()
      if (last && !last.comma) throw new ParseError(`Expected "," or "]" after an element; found ${describe(t)}.`, t.start, t.end)
      if (t.type === ',') throw new ParseError('Unexpected ","; a comma goes between elements.', t.start, t.end)
      if (t.type === 'eof') break
      const v = value(depth)
      const comma = peek().type === ',' ? next() : null
      elements.push({ type: 'element', value: v, comma, first: v.first, last: comma ?? v.last, start: v.start, end: v.end })
    }
    const close = expect(']', 'Expected "]"')
    return { type: 'array', open, close, elements, value: elements.map((e) => e.value.value), first: open, last: close, start: open.start, end: close.end }
  }

  return {
    document() {
      if (peek().type === 'eof') throw new ParseError('The file is empty.', peek().start)
      const root = value(0)
      const t = peek()
      if (t.type !== 'eof') throw new ParseError(`Unexpected ${describe(t)} after the end of the document.`, t.start, t.end)
      return root
    },
  }
}

/**
 * Parse JSONC source. Returns { value, cst, errors }: on success `errors` is empty;
 * on failure `value` and `cst` are null and `errors` holds one { message, start, end, line, col }.
 * cst = { type: 'document', root, tokens, eof, locate(offset) → { line, col } }.
 */
export function parseSource(text) {
  if (typeof text !== 'string') return { value: null, cst: null, errors: [{ message: 'Source must be text.', start: 0, end: 0, line: 1, col: 1 }] }
  const locate = locator(text)
  try {
    if (text.length > SOURCE_LIMITS.bytes || utf8Length(text) > SOURCE_LIMITS.bytes) throw new ParseError(`The file is larger than ${SOURCE_LIMITS.bytes / 1024 / 1024} MB.`, 0)
    const tokens = tokenize(text, locate)
    const root = parser(tokens).document()
    return { value: root.value, cst: { type: 'document', root, tokens, eof: tokens[tokens.length - 1], locate }, errors: [] }
  } catch (err) {
    if (!(err instanceof ParseError)) throw err
    return { value: null, cst: null, errors: [{ message: err.message, start: err.start, end: err.end, ...locate(err.start) }] }
  }
}

const triviaText = (list) => list.map((t) => t.text).join('')

/** The source text, rebuilt from tokens and trivia: always equal to the parsed text. */
export function printCst(cst) {
  return cst.tokens.map((t) => triviaText(t.leading) + t.text + triviaText(t.trailing)).join('')
}

/** End of a token including its same-line trailing trivia. */
export const trailEnd = (tok) => (tok.trailing.length ? tok.trailing[tok.trailing.length - 1].end : tok.end)

/** { start, end, line, col, endLine, endCol } for a CST node (or anything with start/end). */
export function spanOfNode(cst, node) {
  const a = cst.locate(node.start), b = cst.locate(node.end)
  return { start: node.start, end: node.end, line: a.line, col: a.col, endLine: b.line, endCol: b.col }
}
