// What stands in for a lazily loaded panel while its chunk loads or after it failed (see lazyPanel.jsx).

import { Component } from 'react'
import Modal from './Modal.jsx'

/** What shows in place of a panel that is loading or failed to load. */
export function Stand({ kind, name, state, onClose, onRetry }) {
  const loading = state === 'loading'
  const body = (
    <>
      {loading
        ? <p role="status">Loading {name.toLowerCase()}…</p>
        : <p role="alert">{name} couldn't load. Check your connection, then try again.</p>}
      <div className="bw-panel-status-actions">
        {!loading && <button type="button" className="bw-btn" onClick={onRetry}>Try again</button>}
        {onClose && kind !== 'quiet' && <button type="button" className="bw-btn" onClick={onClose}>{loading ? 'Cancel' : 'Close'}</button>}
      </div>
    </>
  )
  if (kind === 'modal') {
    return (
      <Modal label={loading ? `Loading ${name.toLowerCase()}` : `${name} couldn't load`} className={`bw-modal bw-panel-status-dialog${loading ? '' : ' is-error'}`} onClose={onClose ?? undefined}>
        {body}
      </Modal>
    )
  }
  return <div className={`bw-panel-status${loading ? '' : ' is-error'}`}>{body}</div>
}

export class PanelErrorBoundary extends Component {
  state = { error: null }
  static getDerivedStateFromError(error) {
    return { error }
  }
  render() {
    return this.state.error ? this.props.fallback : this.props.children
  }
}
