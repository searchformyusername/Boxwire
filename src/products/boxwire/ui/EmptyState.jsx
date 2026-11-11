import { PROBLEMS } from '../problems/index.js'
import { useEditor } from './useEditor.js'
import { GUIDE_URL } from './ImportReport.jsx'

/** Shown on an empty board: the three moves that get a diagram going, plus templates. */
export default function EmptyState({ editor, onPractice, onReference }) {
  const empty = useEditor(editor, (ed) => Object.keys(ed.doc).length === 0 && !ed.ui.draft && ed.ui.tool === 'select')
  if (!empty) return null
  return (
    <div className="bw-empty" aria-live="polite">
      <h2>Draw the system, not the boxes.</h2>
      <ul>
        <li><kbd>⌘K</kbd> insert any component by name — try “kafka”</li>
        <li><kbd>R</kbd> then click to drop a box and type its name</li>
        <li><kbd>⌘ →</kbd> grow a connected box to the right</li>
        <li className="bw-empty-ai">
          or have an AI write it: give it the <a href={GUIDE_URL} target="_blank" rel="noreferrer">format guide</a>, then paste its JSON here
        </li>
      </ul>
      <div className="bw-empty-tpls">
        <button type="button" className="is-primary" onClick={onPractice}>Practice a timed interview</button>
        <span>or study a reference</span>
        {PROBLEMS.slice(0, 5).map((p) => (
          <button key={p.id} type="button" onClick={() => onReference(p)}>
            {p.name}
          </button>
        ))}
      </div>
    </div>
  )
}
