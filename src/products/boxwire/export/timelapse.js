// Timelapse export. GIF renders frames on a virtual clock (faster than real
// time) and encodes them in a worker; video uses the browser's MediaRecorder,
// which records in real time, so the preview plays while it records.

import { createFrameRenderer, replayCamera } from './frame.js'

const MAX_IN_FLIGHT = 3

const VIDEO_TYPES = [
  ['video/mp4;codecs=avc1.42E01F', 'mp4'],
  ['video/mp4', 'mp4'],
  ['video/webm;codecs=vp9', 'webm'],
  ['video/webm;codecs=vp8', 'webm'],
  ['video/webm', 'webm'],
]

/** The best video container this browser can record, or null. */
export function videoFormat() {
  if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) return null
  const hit = VIDEO_TYPES.find(([mime]) => MediaRecorder.isTypeSupported(mime))
  return hit ? { mime: hit[0], ext: hit[1] } : null
}

/**
 * Video uses standard frames that every player and H.264 level accepts:
 * 1920×1080 for wide boards, 1080×1350 (4:5) for tall ones; content is letterboxed.
 */
export const videoSize = (camera) => (camera.w / camera.h >= 1 ? { width: 1920, height: 1080 } : { width: 1080, height: 1350 })

/** GIF size that fits the replay camera, with even dimensions. */
export function frameSize(camera, width) {
  const aspect = Math.max(0.7, Math.min(2.4, camera.w / camera.h))
  const even = (v) => Math.max(2, Math.round(v / 2) * 2)
  return { width: even(width), height: even(width / aspect) }
}

const aborted = () => new DOMException('Export cancelled', 'AbortError')

function equalPixels(a, b) {
  const x = new Uint32Array(a.buffer, a.byteOffset, a.byteLength >> 2), y = new Uint32Array(b.buffer, b.byteOffset, b.byteLength >> 2)
  if (x.length !== y.length) return false
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false
  return true
}

/**
 * Streams RGBA frames to a GIF worker. Identical consecutive frames merge into
 * one longer frame; at most MAX_IN_FLIGHT frames wait in the worker, so memory
 * stays bounded. Every wait races a single failure signal, so cancelling or a
 * worker error settles the export immediately. The worker is always terminated.
 *
 * frames: iterable of { data: Uint8ClampedArray, delay: ms, progress: 0..1 }
 */
export async function encodeFrames({ worker, frames, width, height, signal, onProgress }) {
  let error = null
  let rejectFailed
  const failed = new Promise((_, reject) => (rejectFailed = reject))
  failed.catch(() => {})
  const fail = (e) => {
    error ??= e
    rejectFailed(error)
  }
  const until = (p) => Promise.race([p, failed])
  let resolveDone
  const finished = new Promise((resolve) => (resolveDone = resolve))
  let inFlight = 0
  let wake = null

  worker.onmessage = ({ data }) => {
    if (data.type === 'ack') {
      inFlight--
      wake?.()
    } else if (data.type === 'done') resolveDone(data.bytes)
  }
  worker.onerror = (e) => fail(new Error(e?.message || 'The GIF encoder crashed.'))
  const onAbort = () => fail(aborted())
  if (signal?.aborted) onAbort()
  signal?.addEventListener('abort', onAbort)

  try {
    worker.postMessage({ type: 'start' })
    let pending = null
    const send = (f) => {
      inFlight++
      worker.postMessage({ type: 'frame', buffer: f.data.buffer, width, height, delay: Math.round(f.delay) }, [f.data.buffer])
    }
    let n = 0
    for (const f of frames) {
      if (error) throw error
      if (pending && equalPixels(pending.data, f.data)) pending.delay += f.delay
      else {
        if (pending) send(pending)
        pending = { data: f.data, delay: f.delay }
      }
      while (inFlight >= MAX_IN_FLIGHT) await until(new Promise((r) => (wake = r)))
      onProgress?.(Math.min(0.97, f.progress))
      if (++n % 8 === 0) await until(new Promise((r) => setTimeout(r, 0))) // let the UI breathe
    }
    if (error) throw error
    if (pending) send(pending)
    worker.postMessage({ type: 'finish' })
    const bytes = await until(finished)
    onProgress?.(1)
    return bytes
  } finally {
    signal?.removeEventListener('abort', onAbort)
    worker.terminate()
  }
}

const gifWorker = () => new Worker(new URL('./gif.worker.js', import.meta.url), { type: 'module' })

export async function recordGif({ replay, theme, width, speed = 1, fps = 12.5, watermark, onProgress, signal, createWorker = gifWorker }) {
  await document.fonts?.ready
  const camera = replayCamera(replay)
  const size = frameSize(camera, width)
  const canvas = new OffscreenCanvas(size.width, size.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const render = createFrameRenderer()
  const stepMs = 1000 / fps
  const total = replay.total / speed
  function* frames() {
    for (let t = 0; t <= total + stepMs / 2; t += stepMs) {
      const f = replay.frame(Math.min(t, total) * speed)
      render(ctx, f.doc, { camera, width: size.width, height: size.height, theme, fx: f.fx, watermark })
      yield { data: ctx.getImageData(0, 0, size.width, size.height).data, delay: stepMs, progress: t / total }
    }
  }
  const bytes = await encodeFrames({ worker: createWorker(), frames: frames(), width: size.width, height: size.height, signal, onProgress })
  return new Blob([bytes], { type: 'image/gif' })
}

/** Records the replay in real time into a canvas the caller can show as a live preview. */
export function recordVideo({ replay, theme, canvas, speed = 1, watermark, onProgress, signal }) {
  const format = videoFormat()
  if (!format) return Promise.reject(new Error('This browser cannot record video. Export a GIF instead.'))
  const camera = replayCamera(replay)
  const ctx = canvas.getContext('2d')
  const render = createFrameRenderer()
  const stream = canvas.captureStream(30)
  const rec = new MediaRecorder(stream, { mimeType: format.mime, videoBitsPerSecond: 8_000_000 })
  const chunks = []
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)

  return new Promise((resolve, reject) => {
    let raf = 0
    let start = 0
    const total = replay.total / speed
    const stop = (err) => {
      cancelAnimationFrame(raf)
      stream.getTracks().forEach((t) => t.stop())
      if (err) {
        rec.onstop = null
        if (rec.state !== 'inactive') rec.stop()
        reject(err)
      } else if (rec.state !== 'inactive') rec.stop()
    }
    rec.onstop = () => resolve({ blob: new Blob(chunks, { type: format.mime.split(';')[0] }), ext: format.ext })
    rec.onerror = (e) => stop(e.error ?? new Error('Recording failed.'))
    signal?.addEventListener('abort', () => stop(aborted()), { once: true })
    const tick = (now) => {
      start ||= now
      const t = Math.min(total, now - start)
      const f = replay.frame(t * speed)
      render(ctx, f.doc, { camera, width: canvas.width, height: canvas.height, theme, fx: f.fx, watermark })
      onProgress?.(t / total)
      if (t >= total) setTimeout(() => stop(), 120)
      else raf = requestAnimationFrame(tick)
    }
    render(ctx, replay.frame(0).doc, { camera, width: canvas.width, height: canvas.height, theme, watermark })
    rec.start(250)
    raf = requestAnimationFrame(tick)
  })
}
