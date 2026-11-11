import { createFrameRenderer } from './frame.js'
import { THEMES } from '../render/theme.js'

const MAX_SIDE = 12000
const MAX_PIXELS = 80e6

/**
 * Render the board (or just the selection) to a PNG blob at `scale`× resolution,
 * shrinking the scale if the image would exceed browser canvas limits.
 */
export async function exportPng(editor, { scale = 2, background = true, theme = editor.ui.theme, selectionOnly = false, padding = 32 } = {}) {
  await document.fonts?.ready
  const els = selectionOnly && editor.ui.selection.length ? editor.selected() : editor.scene().elements
  const b = editor.contentBounds(els)
  if (!b) throw new Error('Nothing to export yet.')
  const camera = { x: b.x - padding, y: b.y - padding, w: b.w + padding * 2, h: b.h + padding * 2 }
  let s = scale
  s = Math.min(s, MAX_SIDE / camera.w, MAX_SIDE / camera.h, Math.sqrt(MAX_PIXELS / (camera.w * camera.h)))
  const width = Math.max(1, Math.round(camera.w * s)), height = Math.max(1, Math.round(camera.h * s))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  const only = selectionOnly && editor.ui.selection.length ? new Set(els.map((e) => e.id)) : null
  createFrameRenderer()(ctx, editor.doc, { camera, width, height, theme: THEMES[theme], background, only })
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('The browser could not encode the image.')
  return { blob, width, height, scale: s }
}
