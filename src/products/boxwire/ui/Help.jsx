import { X } from 'lucide-react'
import { SHORTCUTS } from '../editor/keys.js'
import Modal from './Modal.jsx'
import { GUIDE_URL } from './ImportReport.jsx'

export default function Help({ onClose }) {
  return (
    <Modal className="bw-modal bw-help" label="Keyboard shortcuts" onClose={onClose}>
      <div className="bw-modal-head">
        <h2 id="bw-help-title">Keyboard shortcuts</h2>
        <button type="button" className="bw-icon-btn" aria-label="Close" onClick={onClose} autoFocus>
          <X size={17} />
        </button>
      </div>
      <div className="bw-help-grid">
        {SHORTCUTS.map(([group, rows]) => (
          <section key={group}>
            <h3>{group}</h3>
            <dl>
              {rows.map(([k, v]) => (
                <div key={k}>
                  <dt><kbd>{k}</kbd></dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <p className="bw-help-foot">
        On Windows and Linux, use Ctrl wherever you see ⌘. Want an AI to draft a diagram? Give it the{' '}
        <a href={GUIDE_URL} target="_blank" rel="noreferrer">diagram format guide</a>, then open or paste the file it writes.
      </p>
    </Modal>
  )
}
