// Keyboard shortcuts. One table drives both the handler and the help sheet.

const TOOL_KEYS = {
  v: 'select', h: 'hand', r: 'rect', o: 'ellipse', d: 'diamond', b: 'cylinder', q: 'queue', c: 'class',
  f: 'zone', n: 'note', t: 'text', a: 'arrow', p: 'pen', e: 'eraser', l: 'laser',
}

export const SHORTCUTS = [
  ['Tools', [
    ['V', 'Select'], ['H / hold Space', 'Pan'], ['R', 'Box'], ['O', 'Ellipse'], ['D', 'Decision'], ['B', 'Database'],
    ['Q', 'Queue'], ['C', 'Class'], ['F', 'Zone / frame'], ['N', 'Sticky note'], ['T', 'Text'], ['A', 'Arrow'],
    ['P', 'Pen'], ['E', 'Eraser'], ['L', 'Laser pointer'],
  ]],
  ['Build fast', [
    ['⌘K', 'Insert any component by name'], ['⌘ + arrow', 'Add a connected shape in that direction'],
    ['Drag a blue port', 'Draw a connector'], ['Enter / double-click', 'Edit label'], ['Esc', 'Finish editing'],
    ['Tab / ⇧Tab (on canvas)', 'Select next / previous shape'], ['⌥Tab', 'Leave the canvas to the toolbar'], ['X', 'Cross out (rejected option)'], ['⌥ + drag', 'Duplicate while dragging'],
  ]],
  ['Edit', [
    ['⌘Z / ⇧⌘Z', 'Undo / redo'], ['⌘D', 'Duplicate'], ['⌘C / ⌘V', 'Copy / paste'], ['⌫', 'Delete'],
    ['Arrows (⇧ ×10)', 'Nudge'], ['⌘A', 'Select all'], ['⌘] / ⌘[', 'Bring to front / send to back'], ['Hold ⌘ while dragging', 'Disable snapping'],
  ]],
  ['Present', [
    ['→ / Space / Page Down', 'Next frame'], ['← / Page Up', 'Previous frame'], ['Home / End', 'First / last frame'], ['Esc', 'Leave the presentation'],
  ]],
  ['View', [
    ['⇧1', 'Zoom to fit'], ['⇧2', 'Zoom to selection'], ['⌘0', 'Zoom to 100%'], ['⌘+ / ⌘−', 'Zoom in / out'], ['?', 'This sheet'],
  ]],
]

const ARROWS = { ArrowUp: [0, -1, 'n'], ArrowDown: [0, 1, 's'], ArrowLeft: [-1, 0, 'w'], ArrowRight: [1, 0, 'e'] }

const typing = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
// Keys that navigate or activate (Tab, Enter, Space, arrows, Delete) belong to whatever has focus;
// they act on the diagram only when the canvas (or nothing) is focused.
const onCanvas = (t) => !t || t === document.body || t.classList?.contains('bw-canvas')
const inPopup = (t) => !!t?.closest?.('[role="menu"], [role="dialog"], [role="listbox"]')

/**
 * Handles a keydown for the editor. Returns true when consumed.
 * `ui` exposes app-level actions (palette, help, export) owned by React.
 */
export function handleKey(e, editor, pointer, ui) {
  const t = e.target
  if (typing(t) || inPopup(t) || editor.ui.editing) return false
  const mod = e.metaKey || e.ctrlKey
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  const sel = editor.ui.selection
  const canvas = onCanvas(t)

  if (mod) {
    switch (key) {
      case 'z': return e.shiftKey ? editor.redo() : editor.undo(), true
      case 'y': return editor.redo(), true
      case 'd': return editor.duplicate(), true
      case 'a': return canvas ? (editor.selectAll(), true) : false
      case 'k': return ui.openPalette(), true
      case '0': return editor.zoomAt(1 / editor.ui.view.z), true
      case '=':
      case '+': return editor.zoomAt(1.2), true
      case '-': return editor.zoomAt(1 / 1.2), true
      case ']': return editor.reorder(true), true
      case '[': return editor.reorder(false), true
      case 'e': return e.shiftKey ? (ui.exportPng(), true) : false
      default:
        if (canvas && ARROWS[e.key] && sel.length === 1) return editor.quickConnect(sel[0], ARROWS[e.key][2]), true
        return false
    }
  }

  if (canvas) {
    if (e.key === ' ') {
      pointer?.setSpace(true)
      return true
    }
    if (ARROWS[e.key]) {
      const [dx, dy] = ARROWS[e.key]
      const k = e.shiftKey ? 10 : 1
      return editor.nudge(dx * k, dy * k), true
    }
    if (e.key === 'Escape') {
      if (pointer?.active) pointer.cancel()
      else if (editor.ui.tool !== 'select') editor.set({ tool: 'select' })
      else editor.select([])
      return true
    }
    if (e.key === 'Backspace' || e.key === 'Delete') return editor.remove(sel), true
    if (e.key === 'Enter' && sel.length === 1) return editor.startEdit(sel[0]), true
    // only on the canvas itself: with nothing focused, Tab must move focus into the page, never trap it
    if (e.key === 'Tab' && !e.altKey && t?.classList?.contains('bw-canvas')) return editor.cycleSelection(e.shiftKey ? -1 : 1), true
  }
  if (e.key === '!' || (e.shiftKey && e.code === 'Digit1')) return editor.zoomToFit(), true
  if (e.key === '@' || (e.shiftKey && e.code === 'Digit2')) return editor.zoomToFit(editor.selected(), { maxZoom: 2 }), true
  if (e.key === '?') return ui.openHelp(), true
  if (key === 'x' && !e.shiftKey && !e.altKey) return editor.toggleCross(), true
  if (!e.shiftKey && !e.altKey && TOOL_KEYS[key]) return editor.set({ tool: TOOL_KEYS[key] }), true
  return false
}

export function handleKeyUp(e, pointer) {
  if (e.key === ' ') pointer?.setSpace(false)
}
