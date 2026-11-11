import { useRef, useSyncExternalStore } from 'react'

const shallowEqual = (a, b) => {
  if (Object.is(a, b)) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  const ka = Object.keys(a), kb = Object.keys(b)
  return ka.length === kb.length && ka.every((k) => Object.is(a[k], b[k]))
}

/** Subscribe to a slice of editor state; re-renders only when the slice changes (shallowly). */
export function useEditor(editor, selector) {
  const memo = useRef({ ui: null, doc: null, value: undefined })
  const get = () => {
    const m = memo.current
    if (m.ui !== editor.ui || m.doc !== editor.doc) {
      const next = selector(editor)
      m.ui = editor.ui
      m.doc = editor.doc
      if (!shallowEqual(m.value, next)) m.value = next
    }
    return m.value
  }
  return useSyncExternalStore(editor.subscribe, get)
}
