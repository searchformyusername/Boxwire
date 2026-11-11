import { useEffect, useRef, useState } from 'react'

/** Button + popover menu. Closes on outside click, Escape, or choosing an item. */
export default function Menu({ label, icon, children, align = 'left', className = '', title }) {
  const [open, setOpen] = useState(false)
  const root = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e) => !root.current?.contains(e.target) && setOpen(false)
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
        root.current?.querySelector('button')?.focus()
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = [...root.current.querySelectorAll('[role="menuitem"]:not(:disabled)')]
        const i = items.indexOf(document.activeElement)
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
        e.preventDefault()
      }
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey, true)
    requestAnimationFrame(() => root.current?.querySelector('[role="menuitem"]')?.focus())
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  return (
    <div className={`bw-menu ${className}`} ref={root}>
      <button type="button" className="bw-btn" aria-haspopup="menu" aria-expanded={open} title={title} aria-label={label ?? title} onClick={() => setOpen((o) => !o)}>
        {icon}
        {label && <span className="bw-btn-label">{label}</span>}
      </button>
      {open && (
        <div className={`bw-popover is-${align}`} role="menu" onClick={(e) => e.target.closest('[role="menuitem"]') && setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  )
}

export function MenuItem({ icon, children, hint, onClick, disabled, danger }) {
  return (
    <button type="button" role="menuitem" className={`bw-menu-item${danger ? ' is-danger' : ''}`} onClick={onClick} disabled={disabled}>
      {icon}
      <span className="bw-menu-text">{children}</span>
      {hint && <kbd>{hint}</kbd>}
    </button>
  )
}
