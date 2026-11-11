import { memo, useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { LIBRARY, itemProps, searchItems } from '../catalog.js'
import { SHAPES, makeNode } from '../core/elements.js'
import { drawNode } from '../render/draw.js'
import { THEMES } from '../render/theme.js'

export const DRAG_TYPE = 'application/x-boxwire-item'

/** Tiny render of a library item using the real renderer, so the preview is what you get. */
const Preview = memo(function Preview({ item, theme }) {
  const ref = useRef(null)
  useEffect(() => {
    const c = ref.current
    const dpr = window.devicePixelRatio || 1
    const W = 64, H = 44
    c.width = W * dpr
    c.height = H * dpr
    const ctx = c.getContext('2d')
    const [w, h] = SHAPES[item.shape].size
    const el = makeNode(item.shape, 0, 0, itemProps({ ...item, text: '' }))
    const pad = 4
    const s = Math.min((W - pad * 2) / w, (H - pad * 2) / h)
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (W - w * s) / 2, dpr * (H - h * s) / 2)
    ctx.clearRect(-1e4, -1e4, 2e4, 2e4)
    if (item.shape === 'text') {
      ctx.font = `600 ${h * 0.9}px Inter, sans-serif`
      ctx.fillStyle = THEMES[theme].muted
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('Aa', w / 2, h / 2)
      return
    }
    drawNode(ctx, { ...el, stroke: 2 / Math.max(s, 0.3) }, THEMES[theme], { hideText: true })
  }, [item, theme])
  return <canvas ref={ref} className="bw-lib-preview" style={{ width: 64, height: 44 }} aria-hidden="true" />
})

export default function Library({ theme, onInsert, onClose }) {
  const [q, setQ] = useState('')
  const groups = q.trim() ? [{ group: 'Results', items: searchItems(q) }] : LIBRARY
  return (
    <aside className="bw-panel bw-library" aria-label="Component library">
      <div className="bw-lib-head">
        <div className="bw-search">
          <Search size={15} />
          <input autoFocus placeholder="Search components" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search components" />
        </div>
        <button type="button" className="bw-icon-btn" aria-label="Close library" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div className="bw-lib-scroll">
        {groups.map((g) => (
          <section key={g.group}>
            <h3>{g.group}</h3>
            <div className="bw-lib-grid">
              {g.items.map((it) => (
                <button
                  key={it.name}
                  type="button"
                  className="bw-lib-item"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_TYPE, it.name)
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                  onClick={() => onInsert(it)}
                  title={`Add ${it.name} (click, or drag onto the canvas)`}
                >
                  <Preview item={it} theme={theme} />
                  <span>{it.name}</span>
                </button>
              ))}
              {!g.items.length && <p className="bw-empty-note">No components match “{q}”.</p>}
            </div>
          </section>
        ))}
      </div>
    </aside>
  )
}
