/** Width the review drawer covers on the right (its CSS width plus gutters). */
const DRAWER = 404

/**
 * Frame the elements behind a review result in the part of the canvas the
 * review drawer leaves visible, and outline them and their witness path.
 * `select` also selects them (opening the inspector), for element chips.
 */
export function focusFinding(editor, { elementIds = [], witness = null, status = 'violation' }, { select = false } = {}) {
  const own = (elementIds ?? []).filter((id) => editor.get(id))
  const ids = [...new Set([...own, ...(witness ?? [])])].filter((id) => editor.get(id))
  editor.set({ highlight: { ids: own, witness: witness ?? [], tone: status } })
  if (select) editor.select(own)
  const els = ids.map((id) => editor.get(id)).filter((el) => el.type !== 'edge')
  if (!els.length) return
  const inset = document.querySelector('.bw-review') && editor.ui.size.w > DRAWER * 1.6 ? DRAWER : 0
  const { w, h } = editor.ui.size
  editor.set({ size: { w: w - inset, h } }) // fit into the uncovered width…
  editor.zoomToFit(els, { maxZoom: 1.2, pad: 100 })
  editor.set({ size: { w, h } }) // …then restore the real size; the view keeps that fit
}
