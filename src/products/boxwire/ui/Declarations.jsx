import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Presentation } from 'lucide-react'
import { CAPACITY_FIELDS } from '../core/declared.js'
import { framesOf, isEdge, isFrame } from '../core/elements.js'
import { NODE_KINDS } from '../author/vocabulary.js'
import { kindOfNode, roleOf } from '../review/graph.js'
import { reviewDoc } from '../review/index.js'
import { useEditor } from './useEditor.js'

// Which declarations make sense for each role. Every field is optional:
// leaving one empty means "undeclared", which the review reports as unknown.
const FIELDS = {
  client: ['dau', 'writesPerUser', 'readsPerUser', 'readWrite', 'writesPerDay', 'writesPerMonth', 'writeQps', 'readQps', 'peak', 'writeKB', 'readKB', 'public'],
  edge: ['qpsPerNode', 'replicas', 'hitRatio', 'auth', 'public', 'managed'],
  auth: ['qpsPerNode', 'replicas', 'managed'],
  compute: ['qpsPerNode', 'replicas', 'fanout', 'writeKB', 'auth', 'public', 'managed'],
  store: ['qpsPerNode', 'replicas', 'shards', 'retentionYears', 'replicationFactor', 'storageTB', 'writeKB', 'managed'],
  cache: ['qpsPerNode', 'replicas', 'shards', 'hitRatio', 'ttlSec', 'managed'],
  queue: ['qpsPerNode', 'shards', 'replicas', 'managed'],
  external: ['qpsPerNode', 'managed'],
  ops: ['qpsPerNode', 'managed'],
}

function NumberField({ field, value, onCommit }) {
  const f = CAPACITY_FIELDS[field]
  const [text, setText] = useState(value === undefined ? '' : String(value))
  const [bad, setBad] = useState(false)
  useEffect(() => setText(value === undefined ? '' : String(value)), [value])
  const commit = () => {
    const t = text.trim().replace(/[_,\s]/g, '')
    if (!t) return setBad(false), value !== undefined && onCommit(undefined)
    // accept shorthand like 100M, 2.5k, 1e6
    const m = /^(-?\d*\.?\d+(?:e[+-]?\d+)?)([kmbt]?)$/i.exec(t)
    const v = m ? Number(m[1]) * ({ '': 1, k: 1e3, m: 1e6, b: 1e9, t: 1e12 })[m[2].toLowerCase()] : NaN
    const ok = Number.isFinite(v) && v >= f.min && v <= f.max && (!f.integer || Number.isInteger(v))
    setBad(!ok)
    if (ok && v !== value) onCommit(v)
  }
  const id = `bw-cap-${field}`
  return (
    <label className="bw-cap-field" htmlFor={id} title={`${f.label} (${f.unit})`}>
      <span className="bw-cap-name">{f.label}</span>
      <span className="bw-cap-input">
        <input
          id={id}
          inputMode="decimal"
          value={text}
          placeholder="undeclared"
          aria-invalid={bad || undefined}
          aria-describedby={`${id}-unit`}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              setText(value === undefined ? '' : String(value))
              e.currentTarget.blur()
            }
          }}
        />
        <span id={`${id}-unit`} className="bw-cap-unit">{f.unit}</span>
      </span>
      {bad && <span className="bw-cap-error" role="alert">{f.min}–{f.max}{f.integer ? ', whole number' : ''}</span>}
    </label>
  )
}

function Flag({ field, value, onCommit }) {
  const f = CAPACITY_FIELDS[field]
  // three states: undeclared, yes, no — "no" is a declaration too (e.g. auth: false)
  return (
    <label className="bw-cap-flag">
      <span className="bw-cap-name">{f.label}</span>
      <select className="bw-select" value={value === undefined ? '' : String(value)} onChange={(e) => onCommit(e.target.value === '' ? undefined : e.target.value === 'true')}>
        <option value="">undeclared</option>
        <option value="true">yes</option>
        <option value="false">no</option>
      </select>
    </label>
  )
}

/** Inspector section: the semantic kind, declared capacity facts and the formulas the review derived from them. */
export default function Declarations({ editor, onPresent }) {
  const s = useEditor(editor, (ed) => {
    const sel = ed.selected()
    if (sel.length !== 1) return null
    const el = sel[0]
    return { el, frames: isFrame(el) ? framesOf(ed.scene().nodes) : null, doc: ed.store.committedDoc }
  })
  if (!s) return null
  const { el } = s

  if (s.frames) {
    const i = s.frames.findIndex((f) => f.id === el.id)
    return (
      <section className="bw-decl" aria-label="Slide">
        <span className="bw-field-label">Slide {i + 1} of {s.frames.length}</span>
        <div className="bw-icon-row">
          <button type="button" aria-label="Move slide earlier" title="Earlier" disabled={i === 0} onClick={() => editor.moveFrame(el.id, -1)}><ArrowUp size={16} /></button>
          <button type="button" aria-label="Move slide later" title="Later" disabled={i === s.frames.length - 1} onClick={() => editor.moveFrame(el.id, 1)}><ArrowDown size={16} /></button>
          <button type="button" aria-label="Present from this slide" title="Present from here" onClick={() => onPresent(i)}><Presentation size={16} /></button>
        </div>
      </section>
    )
  }

  if (isEdge(el)) {
    return (
      <section className="bw-decl" aria-label="Load on this connector">
        <span className="bw-field-label">Load on this connector</span>
        <label className="bw-cap-flag">
          <span className="bw-cap-name">Carries</span>
          <select className="bw-select" value={el.carries ?? ''} onChange={(e) => editor.setCarries([el.id], e.target.value || undefined)}>
            <option value="">everything the source sends</option>
            <option value="reads">reads only</option>
            <option value="writes">writes only</option>
            <option value="lookups">one read per request handled</option>
            <option value="misses">cache misses (behind the source's caches)</option>
          </select>
        </label>
        <ShareField el={el} editor={editor} />
        <p className="bw-decl-note">{el.dash === 'dashed' ? 'Dashed: asynchronous message.' : 'Solid: synchronous request.'} The arrowhead sets the direction.</p>
      </section>
    )
  }

  if (el.type !== 'node') return null
  const { kind, inferred } = kindOfNode(el)
  const role = roleOf(kind)
  const sameShape = Object.values(NODE_KINDS).filter((it) => it.shape === el.shape && roleOf(it.kind))
  const review = reviewDoc(s.doc)
  const info = review.capacity?.nodes.get(el.id)
  const cap = el.cap ?? {}
  const set = (k) => (v) => editor.setCapacity([el.id], { [k]: v })
  const fields = (FIELDS[role] ?? []).filter((k) => k !== 'hitRatio' || role === 'cache' || kind === 'cdn')

  return (
    <section className="bw-decl" aria-label="Architecture declarations">
      {sameShape.length > 0 && (
        <label className="bw-field">
          <span className="bw-field-label">Kind {inferred && <em className="bw-decl-inferred">inferred</em>}</span>
          <select className="bw-select" value={el.kind ?? ''} onChange={(e) => editor.setKind([el.id], e.target.value || undefined)}>
            <option value="">{inferred ? `${kind} (inferred)` : 'none: an annotation'}</option>
            {sameShape.map((it) => <option key={it.kind} value={it.kind}>{it.kind}</option>)}
          </select>
        </label>
      )}
      {role && !el.crossed && (
        <>
          <span className="bw-field-label">Declared ({role})</span>
          <div className="bw-cap-grid">
            {fields.map((k) => CAPACITY_FIELDS[k].type === 'boolean'
              ? <Flag key={k} field={k} value={cap[k]} onCommit={set(k)} />
              : <NumberField key={k} field={k} value={cap[k]} onCommit={set(k)} />)}
          </div>
          {info?.steps.length > 0 && (
            <div className="bw-decl-derived" aria-label="Derived load">
              <span className="bw-field-label">Derived</span>
              <dl>
                {info.steps.map((st, i) => (
                  <div key={i}>
                    <dt>{st.label}</dt>
                    <dd><code>{st.formula}</code> = <strong>{st.value}</strong></dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </>
      )}
      {el.crossed && role && <p className="bw-decl-note">Crossed out: a rejected option, left out of the review.</p>}
    </section>
  )
}

function ShareField({ el, editor }) {
  const [text, setText] = useState(el.share === undefined ? '' : String(el.share))
  useEffect(() => setText(el.share === undefined ? '' : String(el.share)), [el.share])
  const commit = () => {
    const v = text.trim() === '' ? undefined : Number(text)
    if (v === undefined || (Number.isFinite(v) && v >= 0 && v <= 1)) editor.updateShare?.(el.id, v)
    else setText(el.share === undefined ? '' : String(el.share))
  }
  return (
    <label className="bw-cap-field" htmlFor="bw-share">
      <span className="bw-cap-name">Share of source output</span>
      <span className="bw-cap-input">
        <input id="bw-share" inputMode="decimal" placeholder="1 (all)" value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
        <span className="bw-cap-unit">0–1</span>
      </span>
    </label>
  )
}
