import { Suspense, lazy, useState } from 'react'
import { PanelErrorBoundary, Stand } from './PanelStand.jsx'

/**
 * A lazily loaded panel or dialog with its own Suspense boundary. While its chunk loads, only the panel is
 * absent: one boundary around the whole board would hide the top bar, toolbar and inspector (React hides a
 * suspended boundary's already-shown children) every time a dialog is opened for the first time.
 *
 * `kind` says what stands in for the panel while its chunk loads, or when it fails to load:
 * - 'modal' (dialogs): the existing Modal shell, so a slow or failed dialog behaves like the dialog it stands
 *   for: it takes focus, traps Tab, closes on Escape, Close or a backdrop click (the panel's own onClose /
 *   onExit), and focus goes back where it was. Once dismissed, a chunk that arrives later shows nothing,
 *   because the panel is no longer rendered.
 * - 'panel' (side panels): a small status with Close, not modal, nothing trapped.
 * - 'quiet' (the empty-state hint, the practice bar): nothing while loading; a failed load is a small
 *   non-modal notice with Try again. Never a dialog, never a focus trap.
 * Try again creates a new React.lazy wrapper and so calls the loader again (React.lazy remembers a rejected load,
 * so the old wrapper would only fail again). That is all it does: whether the new import() actually fetches the
 * chunk again, or succeeds, is up to the browser's module cache and the network, and nothing here guarantees it.
 */
export function lazyPanel(load, { kind = 'quiet', name = 'This panel' } = {}) {
  let Inner = lazy(load)
  function LazyPanel(props) {
    const [attempt, setAttempt] = useState(0)
    const retry = () => {
      Inner = lazy(load) // a new wrapper, so the loader is invoked again; no cache eviction or network recovery implied
      setAttempt((a) => a + 1)
    }
    const close = props.onClose ?? props.onExit ?? null
    const stand = (state) => <Stand kind={kind} name={name} state={state} onClose={close} onRetry={retry} />
    return (
      <PanelErrorBoundary key={attempt} fallback={stand('error')}>
        <Suspense fallback={kind === 'quiet' ? null : stand('loading')}>
          <Inner {...props} />
        </Suspense>
      </PanelErrorBoundary>
    )
  }
  LazyPanel.displayName = `LazyPanel(${name})`
  return LazyPanel
}
