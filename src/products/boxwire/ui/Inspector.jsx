import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalDistributeCenter,
  AlignStartHorizontal, AlignStartVertical, AlignVerticalDistributeCenter, BadgeX, BringToFront, Copy, Highlighter,
  Frame, SendToBack, Trash2,
} from 'lucide-react'
import Declarations from './Declarations.jsx'
import { COLOR_NAMES, THEMES, colorOf } from '../render/theme.js'
import { isEdge, isNode } from '../core/elements.js'
import { ICON_NAMES } from '../render/icons.js'
import { useEditor } from './useEditor.js'

const STYLE_TOOLS = new Set(['rect', 'ellipse', 'diamond', 'cylinder', 'queue', 'class', 'zone', 'note', 'text', 'arrow', 'pen'])

const RELATIONS = [
  ['Association', { head: 'arrow', tail: 'none', dash: 'solid' }],
  ['Async / event', { head: 'arrow', tail: 'none', dash: 'dashed' }],
  ['Two-way', { head: 'arrow', tail: 'arrow', dash: 'solid' }],
  ['Dependency', { head: 'open', tail: 'none', dash: 'dashed' }],
  ['Inheritance', { head: 'triangle', tail: 'none', dash: 'solid' }],
  ['Realization', { head: 'triangle', tail: 'none', dash: 'dashed' }],
  ['Aggregation', { head: 'none', tail: 'diamond', dash: 'solid' }],
  ['Composition', { head: 'none', tail: 'diamondFilled', dash: 'solid' }],
  ['ER one → many', { head: 'many', tail: 'one', dash: 'solid' }],
  ['ER one → zero-or-many', { head: 'zeroMany', tail: 'one', dash: 'solid' }],
  ['ER many ↔ many', { head: 'many', tail: 'many', dash: 'solid' }],
  ['Plain line', { head: 'none', tail: 'none', dash: 'solid' }],
]
const HEADS = ['none', 'arrow', 'open', 'triangle', 'diamond', 'diamondFilled', 'circle', 'one', 'many', 'oneMany', 'zeroMany']

function Segmented({ label, value, options, onChange }) {
  return (
    <div className="bw-field">
      <span className="bw-field-label">{label}</span>
      <div className="bw-seg" role="radiogroup" aria-label={label}>
        {options.map(([v, text, title]) => (
          <button key={String(v)} type="button" role="radio" aria-checked={value === v} title={title ?? text} className={value === v ? 'is-on' : ''} onClick={() => onChange(v)}>
            {text}
          </button>
        ))}
      </div>
    </div>
  )
}

export default function Inspector({ editor, onPresent }) {
  const s = useEditor(editor, (ed) => {
    const sel = ed.selected()
    const tool = ed.ui.tool
    if (!sel.length && !STYLE_TOOLS.has(tool)) return null
    const first = sel[0] ?? { ...ed.ui.style, ...(tool === 'arrow' ? { type: 'edge', ...ed.ui.edgeStyle } : {}) }
    return {
      count: sel.length,
      first,
      nodes: sel.filter(isNode).length,
      edges: sel.filter(isEdge).length,
      tool,
      marker: ed.ui.marker,
      theme: ed.ui.theme,
      component: sel.length === 1 && sel[0].shape === 'component',
      crossed: sel.some((e) => e.crossed),
    }
  })
  if (!s) return null
  const { first, count, nodes, edges, tool } = s
  const theme = THEMES[s.theme]
  const set = (patch) => editor.setStyle(patch)
  const showNodeStyle = nodes > 0 || (!count && tool !== 'arrow' && tool !== 'pen')
  const showEdgeStyle = edges > 0 || (!count && tool === 'arrow')
  const relation = RELATIONS.find(([, r]) => r.head === first.head && r.tail === first.tail && r.dash === first.dash)?.[0] ?? ''

  return (
    <aside className="bw-panel bw-inspector" aria-label="Style">
      <div className="bw-field">
        <span className="bw-field-label">Color</span>
        <div className="bw-swatches">
          {COLOR_NAMES.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={c}
              aria-pressed={first.color === c}
              className={`bw-swatch${first.color === c ? ' is-on' : ''}`}
              style={{ '--sw': colorOf(c, theme) }}
              onClick={() => set({ color: c })}
            />
          ))}
        </div>
      </div>

      {showNodeStyle && (
        <Segmented
          label="Fill"
          value={first.fill}
          onChange={(fill) => set({ fill })}
          options={[['paper', 'Plain'], ['tint', 'Tint'], ['solid', 'Solid'], ['none', 'None', 'Transparent']]}
        />
      )}

      <Segmented label="Line" value={first.dash} onChange={(dash) => set({ dash })} options={[['solid', '——', 'Solid'], ['dashed', '– –', 'Dashed'], ['dotted', '···', 'Dotted']]} />
      <Segmented label="Weight" value={first.stroke} onChange={(stroke) => set({ stroke })} options={[[1, 'Thin'], [2, 'Regular'], [3.5, 'Bold']]} />

      {(showNodeStyle || showEdgeStyle) && (
        <Segmented label="Text" value={first.size} onChange={(size) => set({ size })} options={[[13, 'S'], [16, 'M'], [20, 'L'], [28, 'XL']]} />
      )}
      {showNodeStyle && (
        <Segmented label="Font" value={first.font} onChange={(font) => set({ font })} options={[['sans', 'Sans'], ['mono', 'Mono']]} />
      )}

      {s.component && (
        <label className="bw-field">
          <span className="bw-field-label">Icon</span>
          <select className="bw-select" value={first.icon ?? ''} onChange={(e) => set({ icon: e.target.value })}>
            {ICON_NAMES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      )}

      {showEdgeStyle && (
        <>
          <Segmented label="Route" value={first.route} onChange={(route) => set({ route })} options={[['ortho', 'Elbow'], ['curve', 'Curve'], ['straight', 'Straight']]} />
          <label className="bw-field">
            <span className="bw-field-label">Relationship</span>
            <select className="bw-select" value={relation} onChange={(e) => set(RELATIONS.find(([n]) => n === e.target.value)[1])}>
              {!relation && <option value="">Custom</option>}
              {RELATIONS.map(([n]) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <div className="bw-field bw-field-row">
            <label>
              <span className="bw-field-label">Start</span>
              <select className="bw-select" value={first.tail} onChange={(e) => set({ tail: e.target.value })}>
                {HEADS.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </label>
            <label>
              <span className="bw-field-label">End</span>
              <select className="bw-select" value={first.head} onChange={(e) => set({ head: e.target.value })}>
                {HEADS.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </label>
          </div>
        </>
      )}

      {tool === 'pen' && !count && (
        <button type="button" className={`bw-btn bw-btn-wide${s.marker ? ' is-on' : ''}`} aria-pressed={s.marker} onClick={() => editor.setStyle({ marker: !s.marker })}>
          <Highlighter size={15} /> Highlighter
        </button>
      )}

      {count > 1 && (
        <div className="bw-field">
          <span className="bw-field-label">Arrange</span>
          <div className="bw-icon-row">
            <button type="button" aria-label="Align left" title="Align left" onClick={() => editor.align('left')}><AlignStartVertical size={16} /></button>
            <button type="button" aria-label="Align centers horizontally" title="Align centers" onClick={() => editor.align('hcenter')}><AlignCenterVertical size={16} /></button>
            <button type="button" aria-label="Align right" title="Align right" onClick={() => editor.align('right')}><AlignEndVertical size={16} /></button>
            <button type="button" aria-label="Align top" title="Align top" onClick={() => editor.align('top')}><AlignStartHorizontal size={16} /></button>
            <button type="button" aria-label="Align middles" title="Align middles" onClick={() => editor.align('vcenter')}><AlignCenterHorizontal size={16} /></button>
            <button type="button" aria-label="Align bottom" title="Align bottom" onClick={() => editor.align('bottom')}><AlignEndHorizontal size={16} /></button>
            <button type="button" aria-label="Distribute horizontally" title="Distribute horizontally" onClick={() => editor.distribute('x')}><AlignHorizontalDistributeCenter size={16} /></button>
            <button type="button" aria-label="Distribute vertically" title="Distribute vertically" onClick={() => editor.distribute('y')}><AlignVerticalDistributeCenter size={16} /></button>
          </div>
        </div>
      )}

      <Declarations editor={editor} onPresent={onPresent} />

      {count > 0 && (
        <div className="bw-icon-row bw-actions">
          <button type="button" aria-label="Frame selection as a slide" title="Frame as a slide (for presenting and PDF)" onClick={() => editor.frameSelection()}><Frame size={16} /></button>
          {nodes > 0 && (
            <button type="button" className={s.crossed ? 'is-on' : ''} aria-label="Cross out (X)" title="Cross out — mark as rejected (X)" onClick={() => editor.toggleCross()}>
              <BadgeX size={16} />
            </button>
          )}
          <button type="button" aria-label="Bring to front" title="Bring to front (⌘])" onClick={() => editor.reorder(true)}><BringToFront size={16} /></button>
          <button type="button" aria-label="Send to back" title="Send to back (⌘[)" onClick={() => editor.reorder(false)}><SendToBack size={16} /></button>
          <button type="button" aria-label="Duplicate" title="Duplicate (⌘D)" onClick={() => editor.duplicate()}><Copy size={16} /></button>
          <button type="button" aria-label="Delete" title="Delete (⌫)" className="is-danger" onClick={() => editor.remove(editor.ui.selection)}><Trash2 size={16} /></button>
        </div>
      )}
    </aside>
  )
}
