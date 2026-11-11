import { Maximize, Minus, Plus } from 'lucide-react'
import { useEditor } from './useEditor.js'

export default function ZoomBar({ editor }) {
  const z = useEditor(editor, (ed) => ed.ui.view.z)
  return (
    <div className="bw-panel bw-zoombar" role="group" aria-label="Zoom">
      <button type="button" className="bw-icon-btn" aria-label="Zoom out (⌘−)" title="Zoom out · ⌘−" onClick={() => editor.zoomAt(1 / 1.2)}>
        <Minus size={15} />
      </button>
      <button type="button" className="bw-zoom-pct" title="Reset to 100% · ⌘0" onClick={() => editor.zoomAt(1 / z)}>
        {Math.round(z * 100)}%
      </button>
      <button type="button" className="bw-icon-btn" aria-label="Zoom in (⌘+)" title="Zoom in · ⌘+" onClick={() => editor.zoomAt(1.2)}>
        <Plus size={15} />
      </button>
      <button type="button" className="bw-icon-btn" aria-label="Zoom to fit (⇧1)" title="Zoom to fit · ⇧1" onClick={() => editor.zoomToFit()}>
        <Maximize size={15} />
      </button>
    </div>
  )
}
