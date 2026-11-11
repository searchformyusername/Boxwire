import { useEffect, useLayoutEffect, useRef } from 'react'
import { isEdge, labelFont, shapeOf, textRect } from '../core/elements.js'
import { LINE_HEIGHT, wrapText } from '../core/text.js'
import { edgeLabelBox } from '../render/draw.js'
import { THEMES, paintOf } from '../render/theme.js'
import { useEditor } from './useEditor.js'

const MULTILINE = new Set(['class', 'table', 'note', 'text', 'zone'])

/** In-place label editor: a real textarea laid exactly over the element, so IME, paste and undo behave natively. */
export default function TextEditor({ editor }) {
  const ref = useRef(null)
  const state = useEditor(editor, (ed) => {
    const el = ed.get(ed.ui.editing)
    return el ? { el, view: ed.ui.view, theme: ed.ui.theme, routes: ed.scene().routes } : null
  })

  const id = state?.el.id
  useLayoutEffect(() => {
    const ta = ref.current
    if (!ta || !id) return
    ta.focus({ preventScroll: true })
    ta.setSelectionRange(ta.value.length, ta.value.length)
  }, [id])

  useEffect(() => {
    if (!id) return
    // A pointerdown on the canvas commits; this catches focus moving to other UI.
    const ta = ref.current
    const onBlur = () => setTimeout(() => editor.ui.editing === id && editor.commitEdit(), 0)
    ta?.addEventListener('blur', onBlur)
    return () => ta?.removeEventListener('blur', onBlur)
  }, [editor, id])

  if (!state) return null
  const { el, view, theme, routes } = state
  const t = THEMES[theme]
  const z = view.z
  const sections = !isEdge(el) && shapeOf(el).fit === 'sections'
  let box, align, color
  if (isEdge(el)) {
    const pts = routes.get(el.id) ?? [{ x: 0, y: 0 }, { x: 0, y: 0 }]
    const label = edgeLabelBox({ ...el, text: el.text || ' ' }, pts) // edit exactly where the label will sit
    box = { x: label.x + label.w / 2 - 115, y: label.y, w: 230, h: label.h + 2 }
    align = 'center'
    color = paintOf({ ...el, fill: 'none' }, t).text
  } else if (sections) {
    box = { x: el.x + 8, y: el.y + 6, w: el.w - 16, h: Math.max(el.h - 12, 40) }
    align = 'left'
    color = paintOf(el, t).text
  } else {
    const r = textRect(el)
    const m = shapeOf(el)
    const lines = wrapText(el.text || ' ', r.w, labelFont(el))
    const h = lines.length * el.size * LINE_HEIGHT
    const top = m.valign === 'top' || el.shape === 'actor' ? r.y : r.y + (r.h - h) / 2
    box = { x: r.x, y: top, w: r.w + (el.shape === 'text' ? 40 : 0), h: h + 2 }
    align = el.align ?? m.align ?? 'center'
    color = paintOf(el, t).text
  }

  const onKeyDown = (e) => {
    e.stopPropagation()
    if (e.nativeEvent.isComposing) return
    const multiline = isEdge(el) ? false : MULTILINE.has(el.shape)
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) || (e.key === 'Enter' && !e.shiftKey && !multiline)) {
      e.preventDefault()
      editor.commitEdit()
      editor.focusCanvas?.()
    }
  }

  return (
    <textarea
      ref={ref}
      className={`bw-text-editor${sections || isEdge(el) ? ' is-boxed' : ''}`}
      aria-label={isEdge(el) ? 'Connector label' : 'Shape label'}
      spellCheck={false}
      value={el.text}
      placeholder={sections ? 'Name\n---\n- field: Type\n---\n+ method(): void' : ''}
      onChange={(e) => editor.setEditText(e.target.value.slice(0, 20000))}
      onKeyDown={onKeyDown}
      onKeyUp={(e) => e.stopPropagation()}
      style={{
        left: box.x * z + view.x,
        top: box.y * z + view.y,
        width: box.w * z,
        height: Math.max(box.h, el.size * LINE_HEIGHT) * z,
        fontSize: (sections ? Math.round(el.size * 0.875) : el.size) * z,
        lineHeight: LINE_HEIGHT,
        fontFamily: labelFont(el).replace(/^.*?\d+px /, ''),
        fontWeight: el.shape === 'zone' ? 650 : 500,
        textAlign: align,
        color,
        background: sections || isEdge(el) ? t.paper : 'transparent',
        caretColor: t.accent,
      }}
    />
  )
}
