// Importing a Mermaid flowchart or a Structurizr DSL workspace: detect which,
// parse with our own subset parser, and write a commented `boxwire-diagram`
// source whose header carries the loss report. The result is a proposal for
// the change review (ui/ChangeReview.jsx), never applied to a board directly.

import { compileDiagram } from '../author/compile.js'
import { STUB_MEASURE } from '../change/model.js'
import { parseMermaid } from './mermaid.js'
import { parseStructurizr } from './structurizr.js'
import { emitSource, groupLosses } from './report.js'
import { parseSource } from '../source/cst.js'

export const IMPORT_LIMIT_BYTES = 2 * 1024 * 1024
const MERMAID_OTHER = /^(sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|quadrantChart|requirementDiagram|gitGraph|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment|mindmap|timeline|zenuml|sankey(?:-beta)?|xychart(?:-beta)?|block(?:-beta)?|packet(?:-beta)?|kanban|architecture(?:-beta)?|radar(?:-beta)?|treemap(?:-beta)?)\b/

/** 'mermaid' | 'structurizr' | null, from the first meaningful line. */
export function detectFormat(text) {
  // block comments (Structurizr) count as blank lines
  const lines = String(text).replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).split('\n')
  let i = 0
  if (lines[0]?.trim() === '---') {
    i = lines.findIndex((l, k) => k > 0 && l.trim() === '---') + 1
    if (i === 0) return null
  }
  for (; i < lines.length; i++) {
    const t = lines[i].trim()
    if (!t || t.startsWith('%%') || t.startsWith('#') || t.startsWith('//')) continue
    if (/^(flowchart|graph)\b/.test(t) || MERMAID_OTHER.test(t)) return 'mermaid'
    if (/^workspace\b/.test(t)) return 'structurizr'
    return null
  }
  return null
}

/**
 * Import foreign diagram text. Returns
 * { format, from, value, source, losses, mapped, errors }: `source` is the proposal text for the
 * change review; `losses` groups every construct not carried over exactly (with its lines);
 * `errors` (with line numbers) mean nothing was produced.
 */
export function importForeign(text) {
  const fail = (format, errors) => ({ format, from: null, value: null, source: null, losses: [], mapped: [], errors })
  if (typeof text !== 'string' || !text.trim()) return fail(null, [{ line: 1, message: 'Paste a Mermaid flowchart or a Structurizr DSL workspace.' }])
  if (new TextEncoder().encode(text).length > IMPORT_LIMIT_BYTES) return fail(null, [{ line: 1, message: `The text is larger than ${IMPORT_LIMIT_BYTES / 1024 / 1024} MB.` }])
  const format = detectFormat(text)
  if (!format) return fail(null, [{ line: 1, message: 'Not recognised: a Mermaid flowchart starts with "flowchart" or "graph"; a Structurizr DSL file starts with "workspace".' }])
  if (format === 'mermaid') {
    const first = text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('%%') && l !== '---' && !/^\w+\s*:/.test(l))
    const other = MERMAID_OTHER.exec(first ?? '')
    if (other) return fail(format, [{ line: 1, message: `Mermaid ${other[1]} is not supported; only flowcharts ("flowchart" or "graph") are.` }])
  }
  let parsed
  try {
    parsed = format === 'mermaid' ? parseMermaid(text) : parseStructurizr(text)
  } catch (err) {
    // a parser bug must surface as a refusal the user can read, never as an exception or a partial import
    return fail(format, [{ line: 1, message: `internal: the ${format === 'mermaid' ? 'Mermaid' : 'Structurizr'} importer failed (${String(err?.message ?? err).slice(0, 200)}). Nothing was imported; please report this text.` }])
  }
  if (parsed.errors.length) return fail(format, parsed.errors)
  const from = format === 'mermaid' ? 'a Mermaid flowchart' : 'a Structurizr DSL workspace'
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').length
  if (!parsed.value.nodes.length) return fail(format, [{ line: 1, message: 'Nothing to import: no nodes or elements were found.' }])
  const source = emitSource(parsed.value, { from, report: parsed.report, lines })
  // the generated source must compile; if it doesn't, that's our bug, reported as such rather than hidden
  const compiled = compileDiagram(parsed.value, { measure: STUB_MEASURE })
  if (compiled.errors.length) return fail(format, compiled.errors.map((e) => ({ line: 1, message: `internal: the imported diagram doesn't compile (${e.path}: ${e.message}). Please report this file.` })))
  return { format, from, value: parsed.value, source, losses: groupLosses(parsed.report.items), mapped: parsed.report.mapped, errors: [] }
}

/** A baseline for a board that has no source yet: an empty diagram, so every imported element is an addition. */
export const emptyBaseline = (name) => `{\n  "format": "boxwire-diagram",\n  "version": 1,\n  "name": ${JSON.stringify(name || 'Imported diagram')},\n  "nodes": [\n  ]\n}\n`

/**
 * Whether a source carries a generated import header (an "Imported from a Mermaid flowchart …" or
 * "… Structurizr DSL workspace …" comment) anywhere among the comments before its first field, wherever
 * hand-written comments put it.
 */
export function hasImportHeader(text) {
  const root = typeof text === 'string' ? parseSource(text).cst?.root : null
  const first = root?.type === 'object' ? root.members[0] : null
  if (!first) return false
  return first.first.leading.some((t) => t.type === 'line' && /^\/\/ Imported from (a Mermaid flowchart|a Structurizr DSL workspace) \(/.test(t.text))
}
