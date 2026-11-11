import { useEffect, useRef } from 'react'

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea, [href], [tabindex]:not([tabindex="-1"])'

/** Dialog shell: takes focus on open, traps Tab inside, closes on Escape or backdrop click (unless locked). */
export default function Modal({ label, className = '', onClose, locked = false, children }) {
  const ref = useRef(null)
  const close = useRef(onClose)
  close.current = locked ? null : onClose

  useEffect(() => {
    const el = ref.current
    const before = document.activeElement
    if (!el.contains(document.activeElement)) (el.querySelector('[autofocus]') ?? el.querySelector(FOCUSABLE) ?? el).focus()
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close.current?.()
      } else if (e.key === 'Tab') {
        const items = [...el.querySelectorAll(FOCUSABLE)]
        if (!items.length) return
        const first = items[0], last = items[items.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      if (before?.isConnected) before.focus?.({ preventScroll: true })
    }
  }, [])

  return (
    <div className="bw-modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close.current?.()}>
      <div ref={ref} className={className} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
        {children}
      </div>
    </div>
  )
}
