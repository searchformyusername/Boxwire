// One entry point for everything a user can bring in: a saved Boxwire board
// file or an authored `boxwire-diagram`. Both come back as the same report
// shape, so the UI shows one kind of diagnostics. Nothing here touches the
// live board.

import { FORMAT, LIMITS } from './vocabulary.js'
import { compileDiagram } from './compile.js'
import { LIMITS as BOARD, parseBoardFile } from '../core/validate.js'
import { parseSource } from '../source/cst.js'

export const MAX_FILE_BYTES = BOARD.fileBytes
const utf8Bytes = (text) => new TextEncoder().encode(text).length
const problem = (message, path = '') => ({ path, message })
const mb = (bytes) => `${Math.round(bytes / 1024 / 1024)} MB`

/** Size check for a File before reading it (File.size is bytes). */
export const fileTooLarge = (file) => file.size > MAX_FILE_BYTES && problem(`The file is ${mb(file.size)}; the limit is ${mb(MAX_FILE_BYTES)}.`)

/**
 * Parse an imported file's text.
 * Returns { kind: 'board' | 'diagram', errors, warnings, name?, board?, source? }. A diagram may be
 * written as JSONC (comments, trailing commas); its text comes back as `source`, so the board can
 * keep editing that file instead of replacing it.
 */
export function parseImport(text, { measure } = {}) {
  if (utf8Bytes(text) > MAX_FILE_BYTES) return { kind: 'board', errors: [problem(`The file is larger than ${mb(MAX_FILE_BYTES)}.`)], warnings: [] }
  let json
  try {
    json = JSON.parse(text)
  } catch (err) {
    // not plain JSON: an authored diagram with comments is still a diagram
    if (/"format"\s*:\s*"boxwire-diagram"/.test(text)) {
      const src = parseSource(text)
      if (src.value) return diagram(text, src.value, measure)
      const e = src.errors[0]
      return { kind: 'diagram', errors: [problem(`${e.message} (line ${e.line}, column ${e.col}).`)], warnings: [] }
    }
    return { kind: 'board', errors: [problem(`The file isn't valid JSON (${err.message}).`)], warnings: [] }
  }
  if (json?.format === FORMAT) return diagram(text, json, measure)
  const res = parseBoardFile(text)
  if (res.error) return { kind: 'board', errors: [problem(res.error)], warnings: [] }
  return { kind: 'board', errors: [], warnings: res.warning ? [problem(res.warning)] : [], name: res.name, board: res.board }
}

function diagram(text, json, measure) {
  if (utf8Bytes(text) > LIMITS.bytes) return { kind: 'diagram', errors: [problem(`Diagram files are limited to ${mb(LIMITS.bytes)}.`)], warnings: [] }
  const r = compileDiagram(json, { measure })
  return r.errors.length
    ? { kind: 'diagram', errors: r.errors, warnings: r.warnings }
    : { kind: 'diagram', errors: [], warnings: r.warnings, name: r.name, board: r.board, doc: r.doc, source: text }
}

/**
 * Clipboard text that is an authored diagram becomes a Boxwire clipboard
 * payload (so the normal paste path remaps ids and records one undo step).
 * Returns null for anything that isn't a `boxwire-diagram`.
 */
export function diagramPaste(text, { measure } = {}) {
  // Intent is recognised from the format marker, so a broken authored diagram gets diagnostics
  // instead of falling through to "paste as a text label".
  if (!text.trimStart().startsWith('{') || !/"format"\s*:\s*"boxwire-diagram"/.test(text)) return null
  const fail = (message) => ({ kind: 'diagram', errors: [problem(message)], warnings: [] })
  // UTF-16 length is a lower bound on UTF-8 bytes, so this rejects oversize input before any encoding or parsing
  if (text.length > LIMITS.bytes || utf8Bytes(text) > LIMITS.bytes) return fail(`Diagrams are limited to ${mb(LIMITS.bytes)}.`)
  let json
  try {
    json = JSON.parse(text)
  } catch (err) {
    return fail(`This looks like a Boxwire diagram but isn't valid JSON (${err.message}).`)
  }
  if (json?.format !== FORMAT) return null
  const r = diagram(text, json, measure)
  return r.errors.length ? r : { ...r, clipboard: JSON.stringify({ boxwire: 1, elements: Object.values(r.doc) }) }
}

/** Plain-text version of a report, for pasting back to whoever wrote the file. */
export function reportText({ errors, warnings }) {
  const line = (k) => (p) => `${k}${p.path ? ` ${p.path}:` : ':'} ${p.message}`
  return [...errors.map(line('error')), ...warnings.map(line('warning'))].join('\n')
}
