import { useEffect, useMemo, useRef, useState } from 'react'
import { CircleAlert, CircleCheck, Download, FileDown, FileInput, FolderOpen, Package, X } from 'lucide-react'
import { acceptedPatchFile, bundledSelection, recomputeFromBundle, rejectedFromSelection, reviewSources } from '../change/handoff.js'
import { compactLines } from '../interop/report.js'
import { emptyBaseline, hasImportHeader, importForeign } from '../interop/index.js'
import { allChanges } from '../change/diff.js'
import { compileDiagram } from '../author/compile.js'
import { routeAsync } from '../core/routeClient.js'
import { docBounds } from '../render/bounds.js'
import { downloadBlob, safeName } from '../export/frame.js'
import Modal from './Modal.jsx'
import MergeCards from './MergeCards.jsx'
import { Tabs } from './Review.jsx'

const SAMPLE = () => Promise.all([
  import('../change/fixtures/baseline.boxwire.jsonc?raw'),
  import('../change/fixtures/proposal.boxwire.jsonc?raw'),
  import('../policy/fixtures/rules.json?raw'),
]).then(([b, p, r]) => ({ baseline: b.default, proposal: p.default, rules: r.default, names: { baseline: 'storefront.boxwire.jsonc (sample)', proposal: 'agent proposal (sample)', rules: 'rules.json (sample)' } }))

/** Rendered view of a source's diagram, with element rects for highlighting. */
function useView(value) {
  const [view, setView] = useState(null)
  useEffect(() => {
    let live = true
    if (!value) return setView(null)
    const r = compileDiagram(value)
    if (!r.doc) return setView(null)
    // routed in a worker (exact, every connector), so a large diagram never blocks the dialog; closing the
    // dialog cancels it, and a failed worker still gives a picture (with a caption saying how)
    const abort = new AbortController()
    Promise.all([import('../export/svg.js'), routeAsync(r.doc, { signal: abort.signal })]).then(([{ renderSvgString }, routes]) => {
      if (!live) return
      const els = Object.values(r.doc)
      const b = docBounds(els, routes)
      const camera = { x: b.x - 24, y: b.y - 24, w: b.w + 48, h: b.h + 48 }
      const svg = renderSvgString(r.doc, { camera, width: Math.ceil(camera.w), height: Math.ceil(camera.h), theme: 'light', routes })
      setView({ url: URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })), camera, doc: r.doc, fallback: routes.fallback ?? null })
    })
    return () => {
      live = false
      abort.abort()
    }
  }, [value])
  useEffect(() => () => view?.url && URL.revokeObjectURL(view.url), [view])
  return view
}

function Diagram({ view, ids, label }) {
  if (!view) return <div className="bw-cr-diagram is-empty">{label}: no diagram</div>
  const { camera, doc } = view
  const boxes = [...new Set(ids)].map((id) => doc[id]).filter((el) => el && el.type === 'node' && el.shape !== 'frame')
  return (
    <figure className="bw-cr-diagram">
      <figcaption>{label}{view.fallback && ` · background routing stopped (${view.fallback.reason}); ${view.fallback.provisional} connector${view.fallback.provisional === 1 ? ' is' : 's are'} drawn as simple elbows`}</figcaption>
      <div className="bw-cr-canvas">
        <img src={view.url} alt={`${label} diagram`} />
        {boxes.map((el) => (
          <span key={el.id} className="bw-cr-hit" style={{ left: `${((el.x - camera.x) / camera.w) * 100}%`, top: `${((el.y - camera.y) / camera.h) * 100}%`, width: `${(el.w / camera.w) * 100}%`, height: `${(el.h / camera.h) * 100}%` }} />
        ))}
      </div>
    </figure>
  )
}

/** Source text with the highlighted ranges' lines marked; scrolls the first one into view. */
function SourceView({ text, ranges, label }) {
  const ref = useRef(null)
  const lines = useMemo(() => text.split('\n'), [text])
  const marked = new Set()
  for (const r of ranges) for (let l = r.line; l <= (r.endLine ?? r.line); l++) marked.add(l)
  const first = Math.min(...marked)
  useEffect(() => {
    ref.current?.querySelector(`[data-line="${first}"]`)?.scrollIntoView({ block: 'center' })
  }, [first])
  return (
    <figure className="bw-cr-source">
      <figcaption>{label}</figcaption>
      <pre ref={ref} tabIndex={0} aria-label={`${label} source`}>
        {lines.map((l, i) => (
          <span key={i} data-line={i + 1} className={marked.has(i + 1) ? 'is-marked' : ''}><b aria-hidden="true">{i + 1}</b>{l || ' '}{'\n'}</span>
        ))}
      </pre>
    </figure>
  )
}

const kindLabel = { semantic: 'Model changes', layout: 'Layout only', presentation: 'Presentation', identity: 'Connector ids written down' }

/**
 * Change review: a baseline and a proposed revision of a source file, the semantic diff kept
 * apart from layout, the declared rules on both sides with witnesses, safe partial acceptance,
 * and a minimal source patch plus an offline review bundle.
 */
/** What an import couldn't carry over, grouped by construct with the lines it occurred on. */
function ImportLosses({ imported, onOpen }) {
  const { losses, mapped, from } = imported
  return (
    <section className="bw-cr-import" aria-label="Import report">
      <h3 className="bw-review-h">Imported from {from} <span>{losses.length ? `${losses.length} not carried over exactly` : 'nothing lost'}</span></h3>
      {losses.length > 0 && (
        <ul className="bw-cr-losses">
          {losses.map((l, i) => (
            <li key={i} className={`is-${l.kind}`}><strong>{l.kind}</strong> {l.construct}: {l.detail} <span className="bw-cr-ranges">line{l.lines.length > 1 ? 's' : ''} {compactLines(l.lines)}</span></li>
          ))}
        </ul>
      )}
      {mapped.length > 0 && (
        <details>
          <summary>How constructs were mapped ({mapped.length})</summary>
          <ul className="bw-cr-losses">{mapped.map((m) => <li key={m.construct}>{m.construct} → {m.as}</li>)}</ul>
        </details>
      )}
      <p className="bw-decl-note">The report is also written at the top of the imported source. Accept changes below, or <button type="button" className="bw-link" onClick={onOpen}>open the whole import as a new board</button>.</p>
    </section>
  )
}

export default function ChangeReview({ boardSource, boardName, bundle, importText, onClose, onOpenSource, notify }) {
  const [inputs, setInputs] = useState(null) // { baseline, proposal, rules, names }
  const [tab, setTab] = useState('changes')
  const [rejected, setRejected] = useState(() => new Set())
  const [focus, setFocus] = useState(null) // { ids, ranges: { baseline, proposal } }
  const [opened, setOpened] = useState(null) // bundle check result
  const [error, setError] = useState(null)
  const [restored, setRestored] = useState(null) // { accepted, total, unknown } when a bundle's selection was restored
  const [imported, setImported] = useState(null) // { from, losses, mapped, source, name } for a Mermaid / Structurizr import
  const [foreign, setForeign] = useState(importText?.text ?? '')
  const [merging, setMerging] = useState(null) // { base, ours, theirs, names } for a three-way merge of two edits
  const [chosen, setChosen] = useState({}) // file names picked, shown so the choice is visible and announced
  // re-importing into a board that came from an import compares with it; anything else starts from an empty baseline
  // (the provenance header can sit anywhere among the board source's leading comments)
  const [againstBoard, setAgainstBoard] = useState(() => !!boardSource && hasImportHeader(boardSource))
  const files = useRef({})
  // the controls that started a review disappear with it: move focus to its summary so keyboard and screen
  // reader users land on the result instead of the page body
  const summaryRef = useRef(null)
  useEffect(() => {
    if (!inputs) return
    const a = document.activeElement
    if (!a || a === document.body || !a.isConnected) summaryRef.current?.focus({ preventScroll: true })
  }, [inputs])
  /** New inputs from files or the sample start with every change accepted. */
  const begin = (next, imp = null) => {
    setRejected(new Set())
    setRestored(null)
    setImported(imp)
    setFocus(null)
    setInputs(next)
  }
  /** Mermaid flowchart or Structurizr DSL → a proposal against this board's source (or an empty baseline). */
  const runImport = (text, fileName) => {
    let r
    try {
      r = importForeign(text)
    } catch (err) {
      // never leave the dialog half-updated: the board and any review on screen stay as they were
      return setError(`Can't import${fileName ? ` ${fileName}` : ''}: ${String(err?.message ?? err).slice(0, 200)}. Nothing was changed.`)
    }
    if (r.errors.length) return setError(`Can't import${fileName ? ` ${fileName}` : ''}: ${r.errors.map((e) => `line ${e.line}: ${e.message}`).slice(0, 3).join(' ')}`)
    setError(null)
    const name = r.value.name
    const onBoard = againstBoard && !!boardSource
    begin({ baseline: onBoard ? boardSource : emptyBaseline(name), proposal: r.source, rules: null, names: { baseline: onBoard ? `${boardName} (this board)` : 'empty baseline', proposal: `${name} (import)`, rules: 'built-in checks only' } }, { ...r, name })
  }
  useEffect(() => {
    if (importText?.text) runImport(importText.text, importText.name)
    // run once for the text the dialog was opened with
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importText])

  // a review bundle opened from the Boards menu: verify, recompute, then show it
  useEffect(() => {
    if (!bundle) return
    let live = true
    Promise.all([import('../bundle/bundle.js')]).then(async ([{ openReviewBundle }]) => {
      const res = await openReviewBundle(bundle.bytes, { recompute: recomputeFromBundle })
      if (!live) return
      setOpened(res)
      if (!res.sources?.baseline || !res.sources?.proposal) return
      const next = { baseline: res.sources.baseline, proposal: res.sources.proposal, rules: res.sources.rules ?? null, names: { baseline: `${bundle.name} · baseline`, proposal: `${bundle.name} · proposal`, rules: 'bundled rules' } }
      // the reviewer's checkboxes as they were when the bundle was made (accepted.patch.json)
      const selection = bundledSelection(res.sources.acceptedPatch)
      const reviewed = selection ? reviewSources({ ...next, accept: selection }) : null
      if (reviewed?.review) {
        const ids = allChanges(reviewed.review.diff).map((c) => c.id)
        const { rejected: r, unknown } = rejectedFromSelection(selection, ids)
        setRejected(r)
        // the header box as the bundle's selection had it (or, for an older bundle, as its writer applied it)
        setWithHeader(reviewed.accepted?.header ?? true)
        setRestored({ accepted: ids.length - r.size, total: ids.length, unknown })
      } else {
        setRejected(new Set())
        setRestored(null)
      }
      setInputs(next)
    })
    return () => {
      live = false
    }
  }, [bundle])

  const run = useMemo(() => (inputs ? reviewSources(inputs) : null), [inputs])
  const changes = useMemo(() => (run?.review ? allChanges(run.review.diff) : []), [run])
  // the header box is its own choice, independent of the ticked model changes (change/handoff.js takesHeader):
  // ticked, the proposal's header (an import's provenance, warnings, comments) is taken even with no model
  // change; unticked, the source's own header stays whatever is ticked, and with nothing ticked the source
  // stays byte-for-byte as it is
  const [withHeader, setWithHeader] = useState(true)
  const accept = useMemo(() => ({ all: true, except: [...rejected], header: withHeader }), [rejected, withHeader])
  const accepted = useMemo(() => (inputs && run?.review ? reviewSources({ ...inputs, accept }).accepted : null), [inputs, run, accept])
  const values = run?.values
  const views = { proposal: useView(values?.proposal) }

  const pick = (key) => (e) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    f.text().then((t) => {
      files.current[key] = { text: t, name: f.name }
      setChosen((c) => ({ ...c, [key]: f.name }))
      setError(null)
      if (key === 'foreign') setForeign(t)
    }, () => setError(`Couldn't read ${f.name}.`))
  }
  const startMerge = () => {
    const { mergeBase, mergeOurs, mergeTheirs } = files.current
    const ours = mergeOurs?.text ?? boardSource
    if (!mergeBase || !ours || !mergeTheirs) return setError('To merge, choose the common original and their version (and yours, if this board has no source file).')
    setError(null)
    setMerging({ base: mergeBase.text, ours, theirs: mergeTheirs.text, names: { base: mergeBase.name, ours: mergeOurs?.name ?? `${boardName} (this board)`, theirs: mergeTheirs.name } })
  }
  const startFromFiles = () => {
    const { baseline, proposal, rules } = files.current
    const base = baseline?.text ?? boardSource
    if (!base || !proposal) return setError('Choose a baseline (or use this board\'s source) and a proposal.')
    begin({ baseline: base, proposal: proposal.text, rules: rules?.text ?? null, names: { baseline: baseline?.name ?? `${boardName} (this board)`, proposal: proposal.name, rules: rules?.name ?? 'built-in checks only' } })
  }

  const show = (ids, ranges) => setFocus({ ids, ranges })
  const toggle = (id) => setRejected((s) => {
    const n = new Set(s)
    n.has(id) ? n.delete(id) : n.add(id)
    return n
  })

  async function exportBundle() {
    const { buildReviewBundle } = await import('../bundle/bundle.js')
    const { renderSvgString } = await import('../export/svg.js')
    const res = reviewSources({ ...inputs, accept })
    const docs = { baseline: compileDiagram(res.values.baseline).doc, proposal: compileDiagram(res.values.proposal).doc }
    // both views routed in workers first; the synchronous render then draws those exact routes
    const routed = new Map(await Promise.all(Object.values(docs).filter(Boolean).map(async (d) => [d, await routeAsync(d)])))
    const degraded = [...routed.values()].find((r) => r.fallback)
    const renderSvg = (doc) => {
      const routes = routed.get(doc)
      const b = docBounds(Object.values(doc), routes)
      const camera = { x: b.x - 24, y: b.y - 24, w: b.w + 48, h: b.h + 48 }
      return renderSvgString(doc, { camera, width: Math.ceil(camera.w), height: Math.ceil(camera.h), theme: 'light', routes })
    }
    const built = await buildReviewBundle({ name: inputs.names.proposal, baseline: { source: inputs.baseline }, proposal: { source: inputs.proposal }, accepted: res.accepted?.source ? { source: res.accepted.source, patch: acceptedPatchFile(accept, res.accepted.patch) } : undefined, rules: inputs.rules ?? undefined, results: res.results, docs, renderSvg })
    if (!built.ok) return setError(built.errors.map((e) => e.message).join(' '))
    downloadBlob(new Blob([built.bytes], { type: 'application/zip' }), `${safeName(inputs.names.proposal)}.boxwire-review.zip`)
    notify(`Review bundle saved (${Math.round(built.bytes.length / 1024)} KB, ${built.manifest.files.length} files).${degraded ? ` Its views were drawn without background routing (${degraded.fallback.reason}); some connectors are simple elbows.` : ''}`)
  }

  const review = run?.review
  const notEvaluated = review?.comparison?.status === 'not-evaluated'

  return (
    <Modal className="bw-modal bw-change" label="Review an architecture change" onClose={onClose}>
      <div className="bw-modal-head">
        <div>
          <h2>Review an architecture change</h2>
          <p>Model changes are kept apart from layout. Rules check the declared model, not the deployed system. Nothing on your boards changes until you open a result.</p>
        </div>
        <button type="button" className="bw-icon-btn" aria-label="Close" onClick={onClose}><X size={17} /></button>
      </div>

      {opened && (
        <div className={`bw-cr-banner ${opened.ok ? 'is-ok' : 'is-bad'}`} role="status">
          {opened.ok ? <CircleCheck size={15} /> : <CircleAlert size={15} />}
          {opened.ok
            ? ` Bundle verified: every file matches its SHA-256 and the checks reproduce exactly (${opened.manifest.files.length} files). Hashes prove integrity, not who reviewed it.`
            : ` Bundle refused: ${[...opened.errors.map((e) => e.message), ...opened.mismatches.map((m) => `results differ at ${m.path}`)].slice(0, 4).join(' · ')}`}
        </div>
      )}

      {restored && (
        <p className="bw-decl-note bw-cr-restored" role="status">
          Restored the reviewer's selection from accepted.patch.json: {restored.accepted} of {restored.total} changes accepted.
          {restored.unknown.length > 0 && ` ${restored.unknown.length} selected change(s) are not in this diff: ${restored.unknown.join(', ')}.`}
        </p>
      )}

      {merging && <MergeCards inputs={merging} onOpenSource={onOpenSource} onBack={() => setMerging(null)} />}

      {!inputs && !bundle && !merging && (
        <>
          <div className="bw-cr-pick" role="group" aria-label="Review two source files">
            <label className="bw-btn"><FolderOpen size={15} /> Baseline…<input type="file" className="bw-file-input" accept=".jsonc,.json" onChange={pick('baseline')} /></label>
            {chosen.baseline ? <span className="bw-decl-note">{chosen.baseline}</span> : boardSource && <span className="bw-decl-note">or this board's source file</span>}
            <label className="bw-btn"><FolderOpen size={15} /> Proposal…<input type="file" className="bw-file-input" accept=".jsonc,.json" onChange={pick('proposal')} /></label>
            {chosen.proposal && <span className="bw-decl-note">{chosen.proposal}</span>}
            <label className="bw-btn"><FolderOpen size={15} /> Rules (optional)…<input type="file" className="bw-file-input" accept=".json,.jsonc" onChange={pick('rules')} /></label>
            {chosen.rules && <span className="bw-decl-note">{chosen.rules}</span>}
            <button type="button" className="bw-btn bw-btn-accent" onClick={startFromFiles}>Review</button>
            <button type="button" className="bw-btn" onClick={() => SAMPLE().then((x) => begin(x))}>Load the sample change</button>
          </div>
          <div className="bw-cr-foreign" role="group" aria-labelledby="bw-cr-foreign-h">
            <h3 id="bw-cr-foreign-h" className="bw-review-h">Or import a Mermaid flowchart or a Structurizr DSL workspace</h3>
            <p className="bw-decl-note">It becomes a proposal, reviewed like any other change. Everything that can't be carried over exactly is listed with its line. Supported: Mermaid <code>flowchart</code>/<code>graph</code>; Structurizr people, systems, containers, components, relationships and their context, container and component views.</p>
            <textarea className="bw-source-text bw-cr-foreign-text" aria-label="Mermaid or Structurizr DSL text" spellCheck={false} value={foreign} onChange={(e) => setForeign(e.target.value)} placeholder={'flowchart LR\n  web[Web] --> api[API]\n  api --> db[(Orders DB)]'} />
            {boardSource && (
              <label className="bw-cr-check">
                <input type="checkbox" checked={againstBoard} onChange={(e) => setAgainstBoard(e.target.checked)} />
                Compare with this board's source (for re-importing an updated file); otherwise everything is an addition
              </label>
            )}
            <div className="bw-cr-pick">
              <label className="bw-btn"><FileInput size={15} /> Open a .mmd or .dsl file…<input type="file" className="bw-file-input" accept=".mmd,.mermaid,.dsl,.txt,.md" onChange={pick('foreign')} /></label>
              {chosen.foreign && <span className="bw-decl-note">{chosen.foreign}</span>}
              <button type="button" className="bw-btn bw-btn-accent" disabled={!foreign.trim()} onClick={() => runImport(foreign, chosen.foreign)}>Review the import</button>
            </div>
          </div>
          <div className="bw-cr-foreign" role="group" aria-labelledby="bw-cr-merge-h">
            <h3 id="bw-cr-merge-h" className="bw-review-h">Or merge someone else's edit of the same file</h3>
            <p className="bw-decl-note">Two people changed copies of one source: give the original you both started from and their version. Changes that don't touch each other merge on their own; each conflict is a card you resolve. No server is involved.</p>
            <div className="bw-cr-pick">
              <label className="bw-btn"><FolderOpen size={15} /> Common original…<input type="file" className="bw-file-input" accept=".jsonc,.json" onChange={pick('mergeBase')} /></label>
              {chosen.mergeBase && <span className="bw-decl-note">{chosen.mergeBase}</span>}
              {!boardSource && <label className="bw-btn"><FolderOpen size={15} /> Your version…<input type="file" className="bw-file-input" accept=".jsonc,.json" onChange={pick('mergeOurs')} /></label>}
              {boardSource ? <span className="bw-decl-note">yours: this board's source</span> : chosen.mergeOurs && <span className="bw-decl-note">{chosen.mergeOurs}</span>}
              <label className="bw-btn"><FolderOpen size={15} /> Their version…<input type="file" className="bw-file-input" accept=".jsonc,.json" onChange={pick('mergeTheirs')} /></label>
              {chosen.mergeTheirs && <span className="bw-decl-note">{chosen.mergeTheirs}</span>}
              <button type="button" className="bw-btn bw-btn-accent" onClick={startMerge}>Merge</button>
            </div>
          </div>
        </>
      )}
      {(error || run?.error) && <p className="bw-cr-error" role="alert">{error ?? run.error.message}</p>}

      {review && (
        <div className="bw-cr">
          <div className="bw-cr-side">
            <p className="bw-cr-summary" ref={summaryRef} tabIndex={-1}>
              <strong>{review.diff.semantic.length}</strong> model, <strong>{review.diff.layout.length}</strong> layout, <strong>{review.diff.presentation.length}</strong> presentation changes{review.diff.identity.length > 0 && <>, <strong>{review.diff.identity.length}</strong> id{review.diff.identity.length > 1 ? 's' : ''} written down</>} ·{' '}
              {notEvaluated ? <span className="is-unknown">rules not evaluated: {review.comparison.reasons.join(' ')}</span> : <><strong>{review.introduced.length}</strong> rule violations introduced, <strong>{review.resolved.length}</strong> resolved</>}
            </p>
            {imported && <ImportLosses imported={imported} onOpen={() => onOpenSource(inputs.proposal, imported.name)} />}
            <Tabs tab={tab} setTab={setTab} label="Change review views" tabs={[['changes', 'Changes'], ['rules', `Rules${review.introduced.length ? ` · ${review.introduced.length}` : ''}`], ['patch', 'Accept & export']]} />
            <div role="tabpanel" id={`bw-tabpanel-${tab}`} aria-labelledby={`bw-tab-${tab}`} className="bw-cr-panel">
              {tab === 'changes' && ['semantic', 'layout', 'presentation', 'identity'].map((k) => review.diff[k].length > 0 && (
                <section key={k}>
                  <h3 className="bw-review-h">{kindLabel[k]} <span>{review.diff[k].length}</span></h3>
                  {k === 'identity' && <p className="bw-decl-note">Identity only: these neither move anything nor change the model. They are kept with the changes that need them, so they have no checkbox.</p>}
                  <ul className="bw-cr-list">
                    {review.diff[k].map((c, i) => (
                      <li key={c.id}>
                        {k !== 'identity' && <input type="checkbox" id={`bw-ch-${c.id}`} checked={!rejected.has(c.id)} onChange={() => toggle(c.id)} aria-label={`Accept: ${review.summary[k][i]}`} />}
                        <button type="button" className="bw-link" onClick={() => show([c.key], { baseline: rangeOf(run.indexes.baseline, c), proposal: rangeOf(run.indexes.proposal, c) })}>{review.summary[k][i]}</button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              {tab === 'rules' && (
                <>
                  {notEvaluated && <p className="bw-cr-error">Not evaluated: {review.comparison.reasons.join(' ')} No violation is reported as introduced or resolved.</p>}
                  {[['introduced', 'Introduced by the proposal', 'proposal'], ['resolved', 'Resolved by the proposal', 'baseline']].map(([key, title, side]) => (
                    <section key={key}>
                      <h3 className={`bw-review-h ${key === 'introduced' ? 'is-violation' : 'is-pass'}`}>{title} <span>{review[key].length}</span></h3>
                      <ul className="bw-findings">
                        {review[key].map((v) => (
                          <li key={v.id} className={`bw-finding ${key === 'introduced' ? 'is-violation' : 'is-pass'}`}>
                            <button type="button" className="bw-finding-main" onClick={() => show(v.witness ?? v.elementIds, { [side]: (v.ranges ?? []).map((x) => x.range) })}>
                              <span><code className="bw-rule-id">{v.rule}</code><span className="bw-finding-msg">{v.message}</span>
                                {v.ranges?.length > 0 && <span className="bw-cr-ranges">{side} {v.ranges.slice(0, 6).map((x) => `${x.range.line}:${x.range.col}`).join(', ')}</span>}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                  <p className="bw-decl-note">{review.rules.proposal.results.filter((x) => x.status === 'pass').length} rules pass on the proposal. {review.note}</p>
                </>
              )}
              {tab === 'patch' && accepted && (
                <>
                  <p>Accepting {accepted.applied.length} of {changes.length} changes{rejected.size ? ` (rejected ${rejected.size})` : ''}.</p>
                  <label className="bw-cr-check">
                    <input type="checkbox" checked={withHeader} onChange={(e) => setWithHeader(e.target.checked)} />
                    Also take the proposal's header comments (an import's provenance, warnings and original comments)
                  </label>
                  {accepted.applied.length === 0 && (
                    <p className="bw-decl-note" role="status">
                      {withHeader
                        ? 'No model change is selected. The header comments are still taken, so the source can change; untick the box above to keep it exactly as it is.'
                        : 'No model change is selected and the header is kept: the accepted source is the current source, byte for byte.'}
                    </p>
                  )}
                  {accepted.required.length > 0 && <p className="bw-decl-note">Pulled in to keep references whole: {accepted.required.join(', ')}</p>}
                  {accepted.rejected.length > 0 && <p className="bw-decl-note">Dropped with what you rejected: {accepted.rejected.join(', ')}</p>}
                  {accepted.brokenInvariants?.length > 0 && <p className="bw-cr-error">This selection breaks rules that hold on both sides: {accepted.brokenInvariants.map((b) => b.rule).join(', ')}</p>}
                  {!accepted.valid && <p className="bw-cr-error">This selection doesn't make a valid diagram: {accepted.errors?.[0]?.message}</p>}
                  {accepted.unsupported.length > 0 && <p className="bw-cr-error">Not written to the source: {accepted.unsupported.map((u) => `${u.id} (${u.reason})`).join('; ')}</p>}
                  <pre className="bw-cr-patch" tabIndex={0} aria-label="Source patch">{accepted.patch || 'No source changes.'}</pre>
                  <div className="bw-modal-foot">
                    <button type="button" className="bw-btn" disabled={!accepted.patch} onClick={() => downloadBlob(new Blob([accepted.patch], { type: 'text/x-diff' }), 'accepted.patch')}><Download size={15} /> Patch</button>
                    <button type="button" className="bw-btn" disabled={!accepted.source} onClick={() => downloadBlob(new Blob([accepted.source], { type: 'application/json' }), 'accepted.boxwire.jsonc')}><FileDown size={15} /> Accepted source</button>
                    <button type="button" className="bw-btn" onClick={exportBundle}><Package size={15} /> Review bundle</button>
                    <button type="button" className="bw-btn bw-btn-accent" disabled={!accepted.valid || !accepted.source} onClick={() => onOpenSource(accepted.source, null)}>Open accepted as a board</button>
                  </div>
                </>
              )}
            </div>
          </div>
          <div className="bw-cr-main">
            <Diagram view={views.proposal} ids={focus?.ids ?? []} label={`Proposal · ${inputs.names.proposal}`} />
            <SourceView text={inputs.proposal} ranges={focus?.ranges?.proposal ?? []} label="Proposal source" />
            {focus?.ranges?.baseline?.length > 0 && <SourceView text={inputs.baseline} ranges={focus.ranges.baseline} label="Baseline source" />}
          </div>
        </div>
      )}
    </Modal>
  )
}

/** Source range of a change's element on one side (null where it doesn't exist). */
function rangeOf(index, c) {
  if (c.entity === 'diagram') return []
  const r = index.spanOf({ entity: c.entity, id: c.key, field: c.field && !c.field.includes('.') ? c.field : undefined }) ?? index.spanOf({ entity: c.entity, id: c.key })
  return r ? [r] : []
}
