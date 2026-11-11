import { useMemo, useState } from 'react'
import { CircleAlert, CircleCheck, Download } from 'lucide-react'
import { mergeSources, resolveSources } from '../change/collab.js'
import { downloadBlob } from '../export/frame.js'

const show = (v) => (v === undefined || v === null ? '(absent)' : typeof v === 'string' ? v : JSON.stringify(v, null, 2))

/** One conflict: both sides' values, and a choice of ours, theirs, or a value written by hand. */
function Card({ card, index, choice, setChoice }) {
  const name = `bw-merge-${index}`
  const [draft, setDraft] = useState(() => show(card.ours))
  const editing = choice && typeof choice === 'object'
  const parse = (text) => {
    if (card.field && typeof card.ours === 'string') return { ok: true, value: text }
    try {
      return { ok: true, value: JSON.parse(text) }
    } catch {
      return { ok: false }
    }
  }
  const draftState = parse(draft)
  return (
    <li className="bw-merge-card">
      <fieldset>
        <legend>{card.message}</legend>
        <div className="bw-merge-sides">
          <div><span className="bw-merge-who">Yours</span><pre>{show(card.ours)}</pre></div>
          <div><span className="bw-merge-who">Theirs</span><pre>{show(card.theirs)}</pre></div>
        </div>
        <div className="bw-merge-choice" role="radiogroup" aria-label={`Resolve: ${card.message}`}>
          <label><input type="radio" name={name} checked={choice === 'ours'} onChange={() => setChoice('ours')} /> Keep yours</label>
          <label><input type="radio" name={name} checked={choice === 'theirs'} onChange={() => setChoice('theirs')} /> Take theirs</label>
          <label><input type="radio" name={name} checked={!!editing} onChange={() => draftState.ok && setChoice({ edit: draftState.value })} /> Write it yourself</label>
        </div>
        {editing && (
          <label className="bw-merge-edit">
            <span className="bw-decl-note">{card.field ? `Value of ${card.field}` : 'The whole element as JSON (null removes it)'}</span>
            <textarea
              className="bw-source-text"
              spellCheck={false}
              value={draft}
              aria-invalid={!draftState.ok}
              onChange={(e) => {
                setDraft(e.target.value)
                const p = parse(e.target.value)
                if (p.ok) setChoice({ edit: p.value })
              }}
            />
            {!draftState.ok && <span className="bw-cr-error" role="alert">Not valid JSON yet.</span>}
          </label>
        )}
      </fieldset>
    </li>
  )
}

/**
 * Merge someone else's edit of the same source with yours (three-way, against the common original), with
 * every conflict as a card to resolve; nothing changes until the merged source is opened as a board.
 */
export default function MergeCards({ inputs, onOpenSource, onBack }) {
  const merged = useMemo(() => mergeSources(inputs), [inputs])
  const [choices, setChoices] = useState({})
  const cards = merged.conflicts ?? []
  const chosen = cards.filter((c) => choices[c.id] !== undefined).length
  const result = useMemo(() => (merged.error ? null : cards.length ? resolveSources(inputs, merged, choices) : merged), [inputs, merged, choices, cards.length])
  if (merged.error) return <p className="bw-cr-error" role="alert">{merged.error.message}</p>
  const ready = !!result && chosen === cards.length && result.valid !== false && !(result.errors?.length)
  const clean = (merged.applied?.ours?.length ?? 0) + (merged.applied?.theirs?.length ?? 0)
  return (
    <section className="bw-merge" aria-labelledby="bw-merge-h">
      <h3 id="bw-merge-h" className="bw-review-h">Merge: {inputs.names.ours} + {inputs.names.theirs} <span>against {inputs.names.base}</span></h3>
      <p className="bw-decl-note" role="status">
        {cards.length
          ? <><CircleAlert size={13} /> {clean} change{clean === 1 ? '' : 's'} merged without conflict; {cards.length} conflict{cards.length === 1 ? '' : 's'} to resolve ({chosen} resolved).</>
          : <><CircleCheck size={13} /> {clean} change{clean === 1 ? '' : 's'} merged without conflict.</>}
        {' '}The merge is the same whichever side you pick as yours.
      </p>
      {cards.length > 0 && <ul className="bw-merge-cards">{cards.map((c, i) => <Card key={c.id} card={c} index={i} choice={choices[c.id]} setChoice={(v) => setChoices((s) => ({ ...s, [c.id]: v }))} />)}</ul>}
      {result?.errors?.length > 0 && chosen === cards.length && <p className="bw-cr-error" role="alert">These choices don't make a valid diagram: {result.errors[0].message}</p>}
      <div className="bw-modal-foot">
        <button type="button" className="bw-btn" onClick={onBack}>Back</button>
        <button type="button" className="bw-btn" disabled={!ready} onClick={() => downloadBlob(new Blob([result.text], { type: 'application/json' }), 'merged.boxwire.jsonc')}><Download size={15} /> Merged source</button>
        <button type="button" className="bw-btn bw-btn-accent" disabled={!ready} onClick={() => onOpenSource(result.text, null)}>Open merged as a board</button>
      </div>
    </section>
  )
}
