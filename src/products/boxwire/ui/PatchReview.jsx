import { useEffect, useRef, useState } from 'react'
import { Copy, X } from 'lucide-react'
import { checkPatch, docHash, planPatch } from '../author/patch.js'
import { reviewDoc } from '../review/index.js'
import Modal from './Modal.jsx'

/**
 * Preview of an agent's `boxwire-patch`: every operation in words, the review
 * results it would fix or introduce, and Apply as one undoable step. Invalid
 * or stale patches show their problems with JSON paths and change nothing.
 */
export default function PatchReview({ editor, patch, source, onClose }) {
  const [state, setState] = useState(null)

  const doc0 = useRef(editor.store.committedDoc) // the document the preview was computed against

  useEffect(() => {
    let live = true
    const doc = doc0.current
    docHash(doc).then((baseline) => {
      if (!live) return
      const { errors, ops } = checkPatch(patch, doc, baseline)
      if (errors.length) return setState({ errors })
      const plan = planPatch(doc, ops, {
        measure: editor.measure,
        zTop: editor.zTop(),
        place: (w, h, near) => editor.freeSpot(near ? { x: near.x + near.w + 120 + w / 2, y: near.y + near.h / 2 } : editor.toWorld({ x: editor.ui.size.w / 2, y: editor.ui.size.h / 2 }), w, h),
      })
      if (plan.problem) return setState({ errors: [{ path: '', message: `The result would not be a valid board (${plan.problem}).` }] })
      const before = reviewDoc(doc), after = reviewDoc(plan.doc)
      const ids = (r) => new Set(r.results.filter((x) => x.status !== 'pass').map((x) => x.id))
      const b = ids(before), a = ids(after)
      setState({
        plan,
        resolved: before.results.filter((x) => x.status !== 'pass' && !a.has(x.id)),
        introduced: after.results.filter((x) => x.status !== 'pass' && !b.has(x.id)),
      })
    }).catch((err) => {
      // any failure while checking is a diagnostic; the board is untouched
      if (live) setState({ errors: [{ path: '', message: `The patch couldn't be checked (${err?.message ?? err}). Nothing was changed.` }] })
    })
    return () => {
      live = false
    }
  }, [editor, patch])

  const apply = () => {
    if (editor.store.committedDoc !== doc0.current) {
      setState({ errors: [{ path: 'baseline', message: 'The board changed while this patch was open. Close it and paste the patch again.' }] })
      return
    }
    editor.store.apply(state.plan.entries, 'apply agent patch')
    editor.select(state.plan.entries.filter(([, el]) => el && el.type === 'node').map(([id]) => id))
    editor.toast(`Applied ${state.plan.summary.length} change(s) as one step. ⌘Z undoes it.`)
    onClose()
  }

  return (
    <Modal className="bw-modal bw-patch" label="Review agent patch" onClose={onClose}>
      <div className="bw-modal-head">
        <div>
          <h2>Agent patch</h2>
          <p>From {source}. Nothing changes until you apply it, and it applies as one undoable step.</p>
        </div>
        <button type="button" className="bw-icon-btn" aria-label="Close" onClick={onClose}><X size={17} /></button>
      </div>
      {!state && <p>Checking…</p>}
      {state?.errors && (
        <>
          <ul className="bw-report-list" aria-label="Problems">
            {state.errors.map((e, i) => <li key={i} className="is-error"><code>{e.path || '(patch)'}</code> {e.message}</li>)}
          </ul>
          <div className="bw-modal-foot">
            <button type="button" className="bw-btn" onClick={() => navigator.clipboard?.writeText(state.errors.map((e) => `error ${e.path}: ${e.message}`).join('\n'))}><Copy size={14} /> Copy problems</button>
            <button type="button" className="bw-btn bw-btn-accent" onClick={onClose} autoFocus>Close</button>
          </div>
        </>
      )}
      {state?.plan && (
        <>
          <ol className="bw-patch-ops">{state.plan.summary.map((s, i) => <li key={i}>{s}</li>)}</ol>
          <div className="bw-patch-delta">
            <p><strong>Resolves {state.resolved.length}</strong> review result(s){state.resolved.length ? ':' : '.'}</p>
            {state.resolved.length > 0 && <ul>{state.resolved.map((r) => <li key={r.id}><code>{r.id}</code></li>)}</ul>}
            <p><strong>Introduces {state.introduced.length}</strong>{state.introduced.length ? ':' : '.'}</p>
            {state.introduced.length > 0 && <ul>{state.introduced.map((r) => <li key={r.id} className={`is-${r.status}`}><code>{r.id}</code> {r.message}</li>)}</ul>}
          </div>
          <div className="bw-modal-foot">
            <button type="button" className="bw-btn" onClick={onClose}>Discard</button>
            <button type="button" className="bw-btn bw-btn-accent" onClick={apply} autoFocus>Apply as one step</button>
          </div>
        </>
      )}
    </Modal>
  )
}
