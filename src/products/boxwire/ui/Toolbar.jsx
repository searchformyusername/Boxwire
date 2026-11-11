import {
  Braces, Circle, Database, Diamond, Eraser, Hand, MousePointer2, MoveUpRight, Pencil, Pointer, Rows3, Shapes, Square,
  SquareDashed, StickyNote, Type,
} from 'lucide-react'
import { useEditor } from './useEditor.js'

const GROUPS = [
  [['select', MousePointer2, 'Select', 'V'], ['hand', Hand, 'Pan', 'H']],
  [['rect', Square, 'Box', 'R'], ['ellipse', Circle, 'Ellipse', 'O'], ['diamond', Diamond, 'Decision', 'D'], ['cylinder', Database, 'Database', 'B'], ['queue', Rows3, 'Queue', 'Q'], ['class', Braces, 'UML class', 'C'], ['zone', SquareDashed, 'Zone / frame', 'F']],
  [['arrow', MoveUpRight, 'Connector', 'A'], ['text', Type, 'Text', 'T'], ['note', StickyNote, 'Sticky note', 'N']],
  [['pen', Pencil, 'Pen — annotate or cross out', 'P'], ['eraser', Eraser, 'Eraser', 'E'], ['laser', Pointer, 'Laser pointer', 'L']],
]

function ToolButton({ icon, label, tip, active, onClick }) {
  const Icon = icon
  return (
    <button type="button" className={`bw-tool${active ? ' is-active' : ''}`} aria-pressed={active} aria-label={label} data-tip={tip} onClick={onClick}>
      <Icon size={18} strokeWidth={1.75} />
    </button>
  )
}

export default function Toolbar({ editor, libraryOpen, onToggleLibrary }) {
  const tool = useEditor(editor, (ed) => ed.ui.tool)
  return (
    <nav className="bw-panel bw-toolbar" aria-label="Tools">
      {GROUPS.map((group, i) => (
        <div className="bw-tool-group" key={i}>
          {group.map(([id, icon, label, key]) => (
            <ToolButton key={id} icon={icon} label={`${label} (${key})`} tip={`${label} · ${key}`} active={tool === id} onClick={() => editor.set({ tool: id })} />
          ))}
        </div>
      ))}
      <div className="bw-tool-group">
        <ToolButton icon={Shapes} label="Component library" tip="Components · ⌘K to search" active={libraryOpen} onClick={onToggleLibrary} />
      </div>
    </nav>
  )
}
