import { useState } from 'react'
import { Check, ClipboardCopy, X } from 'lucide-react'
import Modal from './Modal.jsx'
import { reportText } from '../author/import.js'

export const GUIDE_URL = '/products/boxwire/llm.md'

/**
 * Import diagnostics. Errors mean nothing was imported; warnings mean it was,
 * minus the ignored parts. "Copy" exists so the list can go straight back to
 * the AI (or person) that wrote the file.
 */
export default function ImportReport({ report, onClose }) {
  const [copied, setCopied] = useState(false)
  const failed = report.errors.length > 0
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(reportText(report))
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  const row = (kind) => (p, i) => (
    <li key={kind + i} className={`bw-report-row is-${kind}`}>
      {p.path && <code>{p.path}</code>}
      <span>{p.message}</span>
    </li>
  )
  return (
    <Modal className="bw-modal bw-report" label={failed ? 'Import failed' : 'Imported with notes'} onClose={onClose}>
      <div className="bw-modal-head">
        <div>
          <h2>{failed ? `Couldn’t import ${report.source ?? 'this file'}` : `Imported ${report.name ?? 'the diagram'}, with notes`}</h2>
          <p>
            {failed
              ? `${report.errors.length} ${report.errors.length === 1 ? 'problem' : 'problems'} to fix. Your current board wasn’t changed.`
              : 'These parts were ignored; everything else came in as written.'}
            {report.kind === 'diagram' && <> See the <a href={GUIDE_URL} target="_blank" rel="noreferrer">diagram format guide</a>.</>}
          </p>
        </div>
        <button type="button" className="bw-icon-btn" aria-label="Close" onClick={onClose} autoFocus>
          <X size={17} />
        </button>
      </div>
      <ul className="bw-report-list">
        {report.errors.map(row('error'))}
        {report.warnings.map(row('warning'))}
      </ul>
      <div className="bw-report-actions">
        <button type="button" className="bw-btn" onClick={copy}>
          {copied ? <Check size={15} /> : <ClipboardCopy size={15} />} {copied ? 'Copied' : 'Copy problems'}
        </button>
      </div>
    </Modal>
  )
}
