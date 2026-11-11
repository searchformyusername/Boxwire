import { describe, expect, it } from 'vitest'
import { encodeFrames, frameSize, videoSize } from './timelapse.js'

/** Fake worker: `ack` controls whether frames are acknowledged, `finish` whether encoding completes. */
function fakeWorker({ ack = true, finish = true, crashAt = -1 } = {}) {
  const w = {
    frames: [],
    terminated: false,
    onmessage: null,
    onerror: null,
    postMessage(m) {
      if (m.type === 'frame') {
        w.frames.push(m.delay)
        if (w.frames.length - 1 === crashAt) return setTimeout(() => w.onerror?.({ message: 'boom' }), 0)
        if (ack) setTimeout(() => w.onmessage?.({ data: { type: 'ack' } }), 0)
      }
      if (m.type === 'finish' && finish) setTimeout(() => w.onmessage?.({ data: { type: 'done', bytes: new Uint8Array([71, 73, 70]) } }), 0)
    },
    terminate() {
      w.terminated = true
    },
  }
  return w
}

const frame = (v, delay = 80) => ({ data: new Uint8ClampedArray(16).fill(v), delay, progress: 0 })
function* frames(values) {
  for (const v of values) yield frame(v)
}
const settle = (p, ms = 500) => Promise.race([p.then(() => 'resolved', (e) => (e.name === 'AbortError' ? 'AbortError' : e.message)), new Promise((r) => setTimeout(() => r('still pending'), ms))])

describe('encodeFrames', () => {
  it('encodes, merging identical consecutive frames into longer delays', async () => {
    const w = fakeWorker()
    const bytes = await encodeFrames({ worker: w, frames: frames([1, 1, 1, 2, 3, 3]), width: 2, height: 2 })
    expect([...bytes]).toEqual([71, 73, 70])
    expect(w.frames).toEqual([240, 80, 160])
    expect(w.terminated).toBe(true)
  })

  it('cancelling while blocked on backpressure settles at once (regression)', async () => {
    const w = fakeWorker({ ack: false })
    const ctl = new AbortController()
    const p = encodeFrames({ worker: w, frames: frames([1, 2, 3, 4, 5, 6, 7, 8]), width: 2, height: 2, signal: ctl.signal })
    setTimeout(() => ctl.abort(), 10)
    expect(await settle(p)).toBe('AbortError')
    expect(w.terminated).toBe(true)
  })

  it('cancelling during final encoding settles', async () => {
    const w = fakeWorker({ finish: false })
    const ctl = new AbortController()
    const p = encodeFrames({ worker: w, frames: frames([1, 2]), width: 2, height: 2, signal: ctl.signal })
    setTimeout(() => ctl.abort(), 20)
    expect(await settle(p)).toBe('AbortError')
  })

  it('a worker crash rejects instead of hanging', async () => {
    const w = fakeWorker({ ack: false, crashAt: 1 })
    const p = encodeFrames({ worker: w, frames: frames([1, 2, 3, 4, 5, 6]), width: 2, height: 2 })
    expect(await settle(p)).toBe('boom')
    expect(w.terminated).toBe(true)
  })

  it('an already-aborted signal never starts, and a retry afterwards succeeds', async () => {
    const ctl = new AbortController()
    ctl.abort()
    expect(await settle(encodeFrames({ worker: fakeWorker(), frames: frames([1]), width: 2, height: 2, signal: ctl.signal }))).toBe('AbortError')
    expect(await settle(encodeFrames({ worker: fakeWorker(), frames: frames([1, 2]), width: 2, height: 2 }))).toBe('resolved')
  })
})

describe('output sizes', () => {
  it('video frames are standard sizes within H.264 level limits', () => {
    expect(videoSize({ w: 1600, h: 900 })).toEqual({ width: 1920, height: 1080 })
    expect(videoSize({ w: 600, h: 1400 })).toEqual({ width: 1080, height: 1350 })
  })
  it('GIF frames follow the content but stay even and within sane aspect ratios', () => {
    const s = frameSize({ w: 100, h: 1000 }, 960)
    expect(s.width % 2 + s.height % 2).toBe(0)
    expect(s.height).toBeLessThanOrEqual(Math.ceil(960 / 0.7) + 2)
  })
})
