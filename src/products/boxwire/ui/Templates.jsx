import { FilePlus, Timer, X } from 'lucide-react'
import { TEMPLATES } from '../templates.js'
import { PROBLEMS } from '../problems/index.js'
import { PHASES } from '../review/practice.js'
import Modal from './Modal.jsx'

const MINUTES = PHASES.reduce((s, p) => s + p.minutes, 0)

/** New board gallery: the interview problems (timed practice or the reference design) and the LLD/ER starters. */
export default function Templates({ onPick, onBlank, onPractice, onReference, onClose, focus = 'all' }) {
  return (
    <Modal className="bw-modal bw-templates" label={focus === 'practice' ? 'Practice an interview problem' : 'Start a new board'} onClose={onClose}>
      <div className="bw-modal-head">
        <div>
          <h2>{focus === 'practice' ? 'Practice an interview problem' : 'Start a new board'}</h2>
          <p>
            Everything opens as a new board, so nothing you have is replaced. <strong>Practice</strong> starts a {MINUTES}-minute session in five timed phases on a blank board and scores it against the published rubric; <strong>Reference</strong> opens a worked design you can study, present and replay.
          </p>
        </div>
        <button type="button" className="bw-icon-btn" aria-label="Close" onClick={onClose}>
          <X size={17} />
        </button>
      </div>
      <h3 className="bw-tpl-section">Interview problems</h3>
      <ul className="bw-tpl-grid bw-problem-grid">
        {PROBLEMS.map((p, i) => (
          <li key={p.id} className="bw-tpl bw-problem">
            <span className="bw-tpl-tag">{p.tag}</span>
            <strong id={`bw-problem-${p.id}`}>{p.name}</strong>
            <span>{p.blurb}</span>
            <span className="bw-problem-actions">
              <button type="button" className="bw-btn bw-btn-accent" aria-describedby={`bw-problem-${p.id}`} onClick={() => onPractice(p)} autoFocus={focus === 'practice' && i === 0}>
                <Timer size={14} /> Practice
              </button>
              <button type="button" className="bw-btn" aria-describedby={`bw-problem-${p.id}`} onClick={() => onReference(p)}>Reference</button>
            </span>
          </li>
        ))}
      </ul>
      {focus !== 'practice' && (
        <>
          <h3 className="bw-tpl-section">Blank and low-level design</h3>
          <div className="bw-tpl-grid">
            <button type="button" className="bw-tpl is-blank" onClick={onBlank} autoFocus>
              <FilePlus size={22} strokeWidth={1.5} />
              <strong>Blank board</strong>
              <span>Start from nothing. Press ⌘K to insert anything by name.</span>
            </button>
            {TEMPLATES.filter((t) => t.tag !== 'HLD').map((t) => (
              <button key={t.id} type="button" className="bw-tpl" onClick={() => onPick(t)}>
                <span className="bw-tpl-tag">{t.tag}</span>
                <strong>{t.name}</strong>
                <span>{t.blurb}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </Modal>
  )
}
