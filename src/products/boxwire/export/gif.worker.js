// GIF encoding off the main thread. Pixels unchanged since the previous frame
// become transparent (dispose = keep), so static parts of the board cost
// almost nothing after LZW.

import { GIFEncoder, applyPalette, quantize } from 'gifenc'

let gif = null
let prev = null

self.onmessage = ({ data: m }) => {
  if (m.type === 'start') {
    gif = GIFEncoder()
    prev = null
  } else if (m.type === 'frame') {
    const rgba = new Uint8ClampedArray(m.buffer)
    const palette = quantize(rgba, prev ? 255 : 256, { format: 'rgb444' })
    const index = applyPalette(rgba, palette, 'rgb444')
    const opts = { palette, delay: m.delay, repeat: 0, dispose: 1 }
    if (prev) {
      const a = new Uint32Array(rgba.buffer), b = new Uint32Array(prev.buffer)
      const clear = palette.length
      for (let i = 0; i < a.length; i++) if (a[i] === b[i]) index[i] = clear
      palette.push([0, 0, 0])
      Object.assign(opts, { transparent: true, transparentIndex: clear })
    }
    gif.writeFrame(index, m.width, m.height, opts)
    prev = rgba
    self.postMessage({ type: 'ack' })
  } else if (m.type === 'finish') {
    gif.finish()
    const bytes = gif.bytes()
    self.postMessage({ type: 'done', bytes }, [bytes.buffer])
    gif = prev = null
  }
}
