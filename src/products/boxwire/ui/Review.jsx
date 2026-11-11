import { useMemo, useState } from 'react'
import { CircleAlert, CircleCheck, CircleHelp, FileDown, Gauge, Play, X } from 'lucide-react'
import { RULE_BY_ID, reviewDoc } from '../review/index.js'
import { scoreBoard } from '../review/rubric.js'
import { clock } from '../review/practice.js'
import { DEFAULT_SPEED } from '../core/replay.js'
import { problemById } from '../problems/index.js'
import { formatInterval } from '../review/capacity.js'
import { rate, size } from '../review/units.js'
import { useEditor } from './useEditor.js'
import { focusFinding } from './focus.js'

const STATUS = {
  violation: { icon: CircleAlert, label: 'Violations', tone: 'violation' },
  unknown: { icon: CircleHelp, label: 'Undeclared', tone: 'unknown' },
  pass: { icon: CircleCheck, label: 'Passing', tone: 'pass' },
}

function ElementChip({ editor, id, label }) {
  const el = editor.get(id)
  if (!el) return null
  const text = label ?? (String(el.text || '').split('\n').find((l) => l.trim()) || id)
  return (
    <button type="button" className="bw-chip" onClick={() => focusFinding(editor, { elementIds: [id], status: 'pass' }, { select: true })} title={`Select ${text}`}>
      {text.replace(/^[«*]+|[»*]+$/g, '').slice(0, 32)}
    </button>
  )
}

function Finding({ editor, r }) {
  const rule = RULE_BY_ID[r.rule]
  const s = STATUS[r.status]
  const Icon = s.icon
  return (
    <li className={`bw-finding is-${r.status}`}>
      <button type="button" className="bw-finding-main" onClick={() => focusFinding(editor, r)} aria-label={`${s.label}: ${rule?.title ?? r.rule}. ${r.message} Show on canvas.`}>
        <Icon size={15} aria-hidden="true" />
        <span>
          <code className="bw-rule-id">{r.rule}</code>
          <span className="bw-finding-msg">{r.message}</span>
        </span>
      </button>
      {r.status !== 'pass' && (
        <div className="bw-finding-more">
          {r.declare && <p><strong>Declare:</strong> {r.declare}.</p>}
          {r.status === 'violation' && rule && <p><strong>Fix:</strong> {rule.fix}</p>}
          {r.elementIds.length > 0 && (
            <div className="bw-chips" aria-label="Elements">
              {r.elementIds.map((id) => <ElementChip key={id} editor={editor} id={id} />)}
            </div>
          )}
        </div>
      )}
    </li>
  )
}

function Findings({ editor, review }) {
  const [showPass, setShowPass] = useState(false)
  if (!review.graph.nodes.size) return <p className="bw-review-empty">No architecture components yet. Insert components from the library (⌘K): kinds like service, cache or sql-database are what the review reads.</p>
  return (
    <div className="bw-findings">
      {['violation', 'unknown', 'pass'].map((status) => {
        const list = review.results.filter((r) => r.status === status)
        if (!list.length) return null
        if (status === 'pass' && !showPass) {
          return <button key={status} type="button" className="bw-btn bw-btn-wide" onClick={() => setShowPass(true)}><CircleCheck size={15} /> Show {list.length} passing checks</button>
        }
        return (
          <section key={status} aria-label={STATUS[status].label}>
            <h3 className={`bw-review-h is-${status}`}>{STATUS[status].label} <span>{list.length}</span></h3>
            <ul>{list.map((r) => <Finding key={r.id} editor={editor} r={r} />)}</ul>
          </section>
        )
      })}
      {!review.violations.length && !review.unknowns.length && <p className="bw-review-empty">Everything the rules examine is declared and consistent.</p>}
    </div>
  )
}

function Capacity({ editor, review }) {
  const cap = review.capacity
  const showLoad = useEditor(editor, (ed) => ed.ui.showLoad)
  if (!cap) return null
  const rows = [...cap.nodes].filter(([, n]) => n.steps.length)
  return (
    <div className="bw-capacity">
      <label className="bw-check">
        <input type="checkbox" checked={showLoad} onChange={(e) => editor.set({ showLoad: e.target.checked })} />
        Show load on the canvas
      </label>
      {!cap.declared && <p className="bw-review-empty">No client declares load yet. Select a client and fill in daily users and per-user rates (or writes per month and a read:write ratio).</p>}
      {cap.cut.size > 0 && <p className="bw-decl-note">{cap.cut.size} edge(s) close a cycle and carry no load.</p>}
      {rows.map(([id, n]) => {
        const node = review.graph.nodes.get(id)
        const tone = n.rating?.status ?? (n.storage?.status === 'violation' ? 'violation' : '')
        return (
          <details key={id} className={`bw-cap-node is-${tone}`}>
            <summary>
              <span className="bw-cap-node-name">{node.label}</span>
              <span className="bw-cap-node-load">{formatInterval(n.in.r, rate)} r · {formatInterval(n.in.w, rate)} w{n.storage?.need && Number.isFinite(n.storage.need[0]) && n.storage.need[0] > 0 ? ` · ${formatInterval(n.storage.need, size)}` : ''}</span>
            </summary>
            <dl>
              {n.steps.map((st, i) => (
                <div key={i}><dt>{st.label}</dt><dd><code>{st.formula}</code> = <strong>{st.value}</strong></dd></div>
              ))}
            </dl>
            <button type="button" className="bw-link" onClick={() => focusFinding(editor, { elementIds: [id], status: tone || 'pass' })}>Show on canvas</button>
          </details>
        )
      })}
      <p className="bw-decl-note">Rates are per second at the declared peak; storage accrues at the average rate. Undeclared values make a range, never a guess.</p>
    </div>
  )
}

const BADGE = { met: 'Met', partial: 'Partial', missed: 'Missed', undeclared: 'Undeclared', 'n/a': 'Not scored' }

/** Rubric score with evidence: every item links to its elements and to the moment they appear in the timelapse. */
export function ScoreView({ editor, score, onReplay }) {
  const phases = [...new Set(score.items.map((i) => i.phase))]
  return (
    <div className="bw-score">
      <div className="bw-score-total" aria-live="polite">
        <strong>{score.percent}</strong><span>/ 100</span>
        <small>{score.earned} of {score.max} points · rubric v{score.version}</small>
      </div>
      {phases.map((ph) => (
        <section key={ph} aria-label={ph}>
          <h3 className="bw-review-h">{ph.replace('-', ' ')}</h3>
          <ul className="bw-score-items">
            {score.items.filter((i) => i.phase === ph).map((i) => (
              <li key={i.id} className={`bw-score-item is-${i.status.replace('/', '')}`}>
                <div className="bw-score-row">
                  <span className="bw-score-badge">{BADGE[i.status]}</span>
                  <span className="bw-score-title">{i.title}</span>
                  <span className="bw-score-pts">{i.points ? `${i.earned}/${i.points}` : '—'}</span>
                </div>
                <p className="bw-score-detail">{i.detail}</p>
                {i.evidence.length > 0 && (
                  <div className="bw-chips" aria-label={`Evidence for ${i.title}`}>
                    {i.evidence.slice(0, 8).map((e) => (
                      <span key={e.id} className="bw-evidence">
                        <ElementChip editor={editor} id={e.id} />
                        {e.at?.replay != null && onReplay && (
                          <button type="button" className="bw-chip is-time" onClick={() => onReplay(e.at.replay)} aria-label={`Replay from ${clock(e.at.replay / DEFAULT_SPEED)}`} title="Open the timelapse at this moment">
                            <Play size={11} /> {clock(e.at.replay / DEFAULT_SPEED)}
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                )}
                <details className="bw-score-rule"><summary>How this is scored</summary><p>{i.rule}</p></details>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <details className="bw-score-caveats" open>
        <summary>Assumptions</summary>
        <ul>{score.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
      </details>
      <details className="bw-score-caveats">
        <summary>What a diagram can't show</summary>
        <ul>{score.cannotInfer.map((a) => <li key={a}>{a}</li>)}</ul>
      </details>
    </div>
  )
}

/** WAI-ARIA tabs: one tab stop for the group; arrow keys, Home and End move between tabs and select them. */
export function Tabs({ tab, setTab, tabs, label = 'Review views' }) {
  const onKeyDown = (e) => {
    const ids = tabs.map(([id]) => id)
    const i = ids.indexOf(tab)
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: ids.length - 1 }[e.key]
    if (next === undefined) return
    e.preventDefault()
    const id = ids[(next + ids.length) % ids.length]
    setTab(id)
    e.currentTarget.querySelector(`#bw-tab-${id}`)?.focus()
  }
  return (
    <div className="bw-tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map(([id, text]) => (
        <button key={id} type="button" role="tab" id={`bw-tab-${id}`} aria-selected={tab === id} aria-controls={`bw-tabpanel-${id}`} tabIndex={tab === id ? 0 : -1} className={tab === id ? 'is-on' : ''} onClick={() => setTab(id)}>{text}</button>
      ))}
    </div>
  )
}

/** Review drawer: lint findings, capacity and the rubric score for the open board. */
export default function Review({ editor, meta, onClose, onReplay, onExportCritique }) {
  const [tab, setTab] = useState('findings')
  const { doc, history } = useEditor(editor, (ed) => ({ doc: ed.store.committedDoc, history: ed.store.history }))
  const review = reviewDoc(doc)
  const problem = problemById(meta.practice?.problem ?? meta.problem ?? '')
  const score = useMemo(() => (tab === 'score' ? scoreBoard({ doc, base: history.base, done: history.done, practice: meta.practice ?? null, problem }) : null), [tab, doc, history, meta.practice, problem])
  const counts = { violation: review.violations.length, unknown: review.unknowns.length }

  return (
    <aside className="bw-panel bw-review" aria-label="Review">
      <div className="bw-review-head">
        <h2><Gauge size={16} /> Review</h2>
        <button type="button" className="bw-icon-btn" aria-label="Close review" onClick={() => { editor.set({ highlight: null }); onClose() }}><X size={16} /></button>
      </div>
      <Tabs tab={tab} setTab={setTab} tabs={[['findings', `Findings${counts.violation ? ` · ${counts.violation}` : ''}`], ['capacity', 'Capacity'], ['score', 'Score']]} />
      <div className="bw-review-body" role="tabpanel" id={`bw-tabpanel-${tab}`} aria-labelledby={`bw-tab-${tab}`}>
        {tab === 'findings' && <Findings editor={editor} review={review} />}
        {tab === 'capacity' && <Capacity editor={editor} review={review} />}
        {tab === 'score' && score && <ScoreView editor={editor} score={score} onReplay={onReplay} />}
      </div>
      <div className="bw-review-foot">
        <p>Rules check the declared model, not the deployed system. <a href="/products/boxwire/llm.md#review" target="_blank" rel="noreferrer">Rules and rubric</a></p>
        <button type="button" className="bw-btn" onClick={onExportCritique} title="One JSON file with the typed graph, findings, capacity and score, for an AI agent to critique"><FileDown size={15} /> Critique bundle</button>
      </div>
    </aside>
  )
}
