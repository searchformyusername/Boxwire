import { useEffect, useState } from 'react'
import { CircleAlert, Download, FileCode, X } from 'lucide-react'
import { downloadBlob, safeName } from '../export/frame.js'

/**
 * The board's source file. Canvas edits arrive here as minimal edits; the text can also be
 * edited by hand and applied (⌘/Ctrl+Enter) as one undoable step. A parse or compile error
 * keeps the last good board and marks the source stale.
 */
export default function SourcePanel({ source, name, onClose }) {
  const [text, setText] = useState(source.text)
  const [dirty, setDirty] = useState(false)
  const [tick, setTick] = useState(0)
  useEffect(() => source.watch(() => setTick((t) => t + 1)), [source])
  useEffect(() => {
    if (!dirty) setText(source.text)
  }, [source, tick, dirty])

  const apply = () => {
    const r = source.applyText(text)
    if (r.ok) setDirty(false)
  }
  const stale = source.stale
  const lines = text.split('\n').length

  return (
    <aside className="bw-panel bw-review bw-source" aria-label="Source file">
      <div className="bw-review-head">
        <h2><FileCode size={16} /> Source</h2>
        <button type="button" className="bw-icon-btn" aria-label="Close source" onClick={onClose}><X size={16} /></button>
      </div>
      <p className="bw-decl-note bw-source-status" role="status" aria-live="polite">
        {stale
          ? <><CircleAlert size={13} /> Stale: {stale.message}{stale.line ? ` (line ${stale.line}, column ${stale.col})` : ''}. The board shows the last version that compiled.</>
          : dirty ? 'Edited here, not applied yet.' : `In sync with the board · ${lines} lines. Canvas edits become minimal edits to this text.`}
        {source.unsupported.length > 0 && !stale && <> {source.unsupported.length} canvas change(s) can't be written to the format and stay on the board only.</>}
        {source.reflowed.length > 0 && !stale && !dirty && <> Auto layout would have moved {source.reflowed.length} other node{source.reflowed.length > 1 ? 's' : ''}, so {source.reflowed.length > 1 ? 'they are' : 'it is'} pinned where {source.reflowed.length > 1 ? 'they are' : 'it is'} in "positions".</>}
        {source.pinned.length > 0 && !stale && !dirty && <> Wrote down the generated connector id{source.pinned.length > 1 ? 's' : ''} {source.pinned.join(', ')} so {source.pinned.length > 1 ? 'they keep their' : 'it keeps its'} identity (not a layout change).</>}
      </p>
      <textarea
        className="bw-source-text"
        aria-label="Source text"
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setDirty(true)
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            apply()
          }
          // Escape leaves the text box for the panel's own controls, never for the page (or the canvas behind it)
          if (e.key === 'Escape') e.currentTarget.closest('.bw-source')?.querySelector('.bw-review-foot button:not(:disabled)')?.focus()
        }}
      />
      <div className="bw-review-foot">
        <button type="button" className="bw-btn bw-btn-accent" disabled={!dirty} onClick={(e) => {
          const area = e.currentTarget.closest('.bw-source')?.querySelector('.bw-source-text')
          apply()
          area?.focus() // Apply disables itself once applied; keep the keyboard in the panel
        }}>Apply (⌘↵)</button>
        <button type="button" className="bw-btn" disabled={!dirty && !stale} onClick={(e) => {
          // back to the text the board was built from: that text compiles, so the source is no longer stale
          const area = e.currentTarget.closest('.bw-source')?.querySelector('.bw-source-text')
          setText(source.text)
          setDirty(false)
          if (stale) source.applyText(source.text)
          area?.focus() // this button disables itself; keep the keyboard in the panel
        }}>Revert</button>
        <button type="button" className="bw-btn" onClick={() => downloadBlob(new Blob([source.text], { type: 'application/json' }), `${safeName(name)}.boxwire.jsonc`)}><Download size={15} /> Download</button>
      </div>
    </aside>
  )
}
