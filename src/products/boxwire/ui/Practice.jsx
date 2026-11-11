import { useEffect, useState } from 'react'
import { BookOpen, Check, ChevronRight, Flag, Timer, X } from 'lucide-react'
import { PHASES, activity, clock, timing } from '../review/practice.js'
import { scoreBoard } from '../review/rubric.js'
import { problemById } from '../problems/index.js'
import Modal from './Modal.jsx'
import { ScoreView } from './Review.jsx'
import { useEditor } from './useEditor.js'

function useNow(active) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [active])
  return now
}

function Brief({ problem, phase }) {
  return (
    <div className="bw-brief">
      <p className="bw-brief-prompt">{problem.prompt}</p>
      {phase && <p className="bw-brief-goal"><strong>{phase.title}:</strong> {phase.goal}</p>}
      <div className="bw-brief-cols">
        <div><h4>Functional</h4><ul>{problem.functional.map((x) => <li key={x}>{x}</li>)}</ul></div>
        <div><h4>Non-functional</h4><ul>{problem.nonFunctional.map((x) => <li key={x}>{x}</li>)}</ul></div>
      </div>
      <h4>Numbers to start from</h4>
      <ul>{problem.estimates.map((x) => <li key={x}>{x}</li>)}</ul>
      <h4>Deep-dive prompts</h4>
      <ul>{problem.deepDives.map((x) => <li key={x}>{x}</li>)}</ul>
    </div>
  )
}

/** The running session: phase stepper, countdown for the current phase, the brief, and phase changes. */
export function PracticeBar({ practice, onAdvance, onShowScore }) {
  const problem = problemById(practice.problem)
  const ended = practice.endedAt !== null
  const now = useNow(!ended)
  const [brief, setBrief] = useState(practice.marks.length === 1 && !practice.endedAt) // open at the start: the problem is the first thing to read
  if (!problem) return null
  const rows = timing(practice, now)
  const cur = rows.find((r) => r.status === 'current')
  const left = cur ? cur.budget - cur.elapsed : 0
  const total = (practice.endedAt ?? now) - practice.startedAt
  const last = practice.marks.length === PHASES.length

  return (
    <div className="bw-panel bw-practice" role="region" aria-label={`Practice: ${problem.name}`}>
      <div className="bw-practice-row">
        <span className="bw-practice-name"><Timer size={15} aria-hidden="true" /> {problem.name}</span>
        <ol className="bw-phases" aria-label="Phases">
          {rows.map((r) => (
            <li key={r.id} className={`is-${r.status}${r.status === 'done' && r.elapsed > r.budget ? ' is-over' : ''}`} aria-current={r.status === 'current' ? 'step' : undefined} title={`${r.title}: ${r.minutes} min${r.status === 'done' ? `, took ${clock(r.elapsed)}` : ''}`}>
              {r.status === 'done' ? <Check size={12} aria-hidden="true" /> : null}
              <span>{r.title}</span>
            </li>
          ))}
        </ol>
        {cur ? (
          <span className={`bw-practice-clock${left < 0 ? ' is-over' : ''}`} role="timer" aria-live="off" aria-label={`${cur.title}: ${left < 0 ? `${clock(-left)} over` : `${clock(left)} left`}`}>
            {left < 0 ? '+' : ''}{clock(Math.abs(left))}
          </span>
        ) : (
          <span className="bw-practice-clock">{clock(total)}</span>
        )}
        <button type="button" className="bw-btn" aria-expanded={brief} onClick={() => setBrief((b) => !b)}><BookOpen size={15} /> Brief</button>
        {!ended ? (
          <button type="button" className="bw-btn bw-btn-accent" onClick={onAdvance}>
            {last ? <><Flag size={15} /> Finish &amp; score</> : <>Next: {PHASES[practice.marks.length].title} <ChevronRight size={15} /></>}
          </button>
        ) : (
          <button type="button" className="bw-btn bw-btn-accent" onClick={onShowScore}><Flag size={15} /> Score</button>
        )}
      </div>
      {/* the clock isn't announced every second; a phase change is */}
      <span className="bw-sr-only" aria-live="polite">{cur ? `Phase: ${cur.title}, ${cur.minutes} minutes.` : ended ? 'Session finished.' : ''}</span>
      {brief && <Brief problem={problem} phase={cur && PHASES.find((p) => p.id === cur.id)} />}
    </div>
  )
}

/** End-of-session report: the rubric score with evidence, plus how the time was spent. */
export function ScoreDialog({ editor, practice, onClose, onReplay, onReference }) {
  const { doc, history } = useEditor(editor, (ed) => ({ doc: ed.store.committedDoc, history: ed.store.history }))
  const problem = problemById(practice?.problem ?? '')
  const score = scoreBoard({ doc, base: history.base, done: history.done, practice, problem, now: practice?.endedAt ?? Date.now() })
  const rows = practice ? timing(practice, practice.endedAt ?? Date.now()) : []
  const steps = practice ? activity(practice, history.done) : []
  return (
    <Modal className="bw-modal bw-score-dialog" label="Practice score" onClose={onClose}>
      <div className="bw-modal-head">
        <div>
          <h2>{problem ? `${problem.name}: score` : 'Score'}</h2>
          <p>Scored locally against the published rubric. Each item links to the elements behind it and the moment they appear in the timelapse.</p>
        </div>
        <button type="button" className="bw-icon-btn" aria-label="Close" onClick={onClose}><X size={17} /></button>
      </div>
      {practice && (
        <table className="bw-timing">
          <caption>Time per phase</caption>
          <thead><tr><th scope="col">Phase</th><th scope="col">Budget</th><th scope="col">Took</th><th scope="col">Steps</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id} className={r.elapsed > r.budget * 1.2 ? 'is-over' : ''}>
                <th scope="row">{r.title}</th><td>{r.minutes}:00</td><td>{r.status === 'upcoming' ? '—' : r.status === 'done' && !steps[i] ? 'skipped' : clock(r.elapsed)}</td><td>{steps[i]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ScoreView editor={editor} score={score} onReplay={(ms) => { onClose(); onReplay(ms) }} />
      <div className="bw-modal-foot">
        {problem && <button type="button" className="bw-btn" onClick={() => onReference(problem)}>Open the reference solution</button>}
        <button type="button" className="bw-btn bw-btn-accent" onClick={onClose} autoFocus>Back to the board</button>
      </div>
    </Modal>
  )
}
