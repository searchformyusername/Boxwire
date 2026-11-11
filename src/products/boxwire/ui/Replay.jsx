import { useEffect, useMemo, useRef, useState } from 'react'
import { Film, LoaderCircle, Pause, Play, RotateCcw, X } from 'lucide-react'
import { DEFAULT_SPEED, createReplay } from '../core/replay.js'
import { THEMES } from '../render/theme.js'
import { createFrameRenderer, downloadBlob, replayCamera, safeName } from '../export/frame.js'
import { frameSize, recordGif, recordVideo, videoFormat, videoSize } from '../export/timelapse.js'
import Modal from './Modal.jsx'

const SPEEDS = [1, 1.5, 2, 3]
const fmt = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`
const fileSize = (bytes) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(bytes > 10e6 ? 0 : 1)} MB`)

/** Timelapse player and exporter. The preview and the files come from the same frame function. */
export default function Replay({ editor, name, onClose, notify, startAt = null }) {
  const { base, done, checkpoint } = editor.store.history
  const [opts, setOpts] = useState({ theme: editor.ui.theme, speed: DEFAULT_SPEED, hideDeadEnds: true, watermark: true, gifWidth: 960 })
  const replay = useMemo(() => createReplay(base, done, { hideDeadEnds: opts.hideDeadEnds }), [base, done, opts.hideDeadEnds])
  // opened from a score's evidence link: start paused at that moment
  const [t, setT] = useState(startAt ?? 0)
  const [playing, setPlaying] = useState(startAt == null)
  const [job, setJob] = useState(null) // { kind, progress, controller }
  const canvas = useRef(null)
  const render = useMemo(() => createFrameRenderer(), [])
  const video = useMemo(() => videoFormat(), [])
  const camera = useMemo(() => replayCamera(replay), [replay])

  // playback clock (paused while a GIF encodes; driven by the recorder while a video records)
  useEffect(() => {
    if (!playing || job) return
    let raf = 0, last = 0
    const tick = (now) => {
      if (last) {
        setT((v) => {
          const next = v + (now - last) * opts.speed
          if (next >= replay.total) {
            setPlaying(false)
            return replay.total
          }
          return next
        })
      }
      last = now
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, job, opts.speed, replay])

  useEffect(() => {
    const c = canvas.current
    if (!c || !camera) return
    const dpr = window.devicePixelRatio || 1
    const box = c.getBoundingClientRect()
    if (c.width !== Math.round(box.width * dpr)) {
      c.width = Math.round(box.width * dpr)
      c.height = Math.round(box.height * dpr)
    }
    const f = replay.frame(t)
    render(c.getContext('2d'), f.doc, { camera, width: c.width, height: c.height, theme: THEMES[opts.theme], fx: f.fx, watermark: opts.watermark })
  }, [t, replay, camera, render, opts.theme, opts.watermark])

  const jobRef = useRef(null)
  jobRef.current = job
  useEffect(() => () => jobRef.current?.controller.abort(), []) // cancel an export if the dialog unmounts

  const set = (patch) => setOpts((o) => ({ ...o, ...patch }))
  const restart = () => {
    setT(0)
    setPlaying(true)
  }

  async function exportGif() {
    const controller = new AbortController()
    setJob({ kind: 'gif', progress: 0, controller })
    try {
      const blob = await recordGif({
        replay, theme: THEMES[opts.theme], width: opts.gifWidth, speed: opts.speed, watermark: opts.watermark, signal: controller.signal,
        onProgress: (p) => setJob((j) => j && { ...j, progress: p }),
      })
      downloadBlob(blob, `${safeName(name)}-timelapse.gif`)
      notify(`GIF saved (${fileSize(blob.size)}).`)
    } catch (err) {
      if (err.name !== 'AbortError') notify(err.message || 'GIF export failed.', 'error')
    } finally {
      setJob(null)
    }
  }

  async function exportVideo() {
    const controller = new AbortController()
    const size = videoSize(camera)
    const target = document.createElement('canvas')
    target.width = size.width
    target.height = size.height
    setJob({ kind: 'video', progress: 0, controller })
    setPlaying(false)
    try {
      const { blob, ext } = await recordVideo({
        replay, theme: THEMES[opts.theme], canvas: target, speed: opts.speed, watermark: opts.watermark, signal: controller.signal,
        onProgress: (p) => {
          setT(p * replay.total)
          setJob((j) => j && { ...j, progress: p })
        },
      })
      downloadBlob(blob, `${safeName(name)}-timelapse.${ext}`)
      notify(`Video saved (${ext.toUpperCase()}, ${fileSize(blob.size)}).`)
    } catch (err) {
      if (err.name !== 'AbortError') notify(err.message || 'Video export failed.', 'error')
    } finally {
      setJob(null)
    }
  }

  const duration = replay.total / opts.speed
  return (
    <Modal className="bw-modal bw-replay" label="Timelapse" onClose={onClose} locked={!!job}>
      <div onKeyDown={(e) => {
        if (e.key === ' ' && e.target.tagName !== 'BUTTON' && e.target.tagName !== 'INPUT' && !job) {
          e.preventDefault()
          setPlaying((p) => !p)
        }
      }}>
        <div className="bw-modal-head">
          <div>
            <h2 id="bw-replay-title">Timelapse</h2>
            <p>
              {replay.steps.length} {replay.steps.length === 1 ? 'step' : 'steps'}, replayed in the order you built them. Undone work is skipped.
              {checkpoint && ' It starts from a saved checkpoint rather than an empty board.'}
            </p>
          </div>
          <button type="button" className="bw-icon-btn" aria-label="Close" onClick={onClose} disabled={!!job}>
            <X size={17} />
          </button>
        </div>

        <div className="bw-replay-stage">
          <canvas ref={canvas} className="bw-replay-canvas" style={{ aspectRatio: camera ? `${frameSize(camera, 1000).width} / ${frameSize(camera, 1000).height}` : '16 / 9' }} />
        </div>

        <div className="bw-replay-controls">
          <button type="button" className="bw-icon-btn" aria-label={playing ? 'Pause' : 'Play'} disabled={!!job} onClick={() => (t >= replay.total ? restart() : setPlaying((p) => !p))}>
            {playing ? <Pause size={17} /> : <Play size={17} />}
          </button>
          <button type="button" className="bw-icon-btn" aria-label="Restart" disabled={!!job} onClick={restart}>
            <RotateCcw size={16} />
          </button>
          <input
            type="range"
            className="bw-scrub"
            min={0}
            max={replay.total}
            step={10}
            value={t}
            disabled={!!job}
            aria-label="Timeline"
            onChange={(e) => {
              setPlaying(false)
              setT(Number(e.target.value))
            }}
          />
          <span className="bw-time">{fmt(t / opts.speed)} / {fmt(duration)}</span>
        </div>

        <div className="bw-replay-options">
          <div className="bw-seg" role="radiogroup" aria-label="Speed">
            {SPEEDS.map((s) => (
              <button key={s} type="button" role="radio" aria-checked={opts.speed === s} className={opts.speed === s ? 'is-on' : ''} disabled={!!job} onClick={() => set({ speed: s })}>
                {s}×
              </button>
            ))}
          </div>
          <div className="bw-seg" role="radiogroup" aria-label="Theme">
            {['light', 'dark'].map((th) => (
              <button key={th} type="button" role="radio" aria-checked={opts.theme === th} className={opts.theme === th ? 'is-on' : ''} disabled={!!job} onClick={() => set({ theme: th })}>
                {th === 'light' ? 'Light' : 'Dark'}
              </button>
            ))}
          </div>
          <label className="bw-check">
            <input type="checkbox" checked={opts.hideDeadEnds} disabled={!!job} onChange={(e) => set({ hideDeadEnds: e.target.checked })} />
            Skip things deleted later
          </label>
          <label className="bw-check">
            <input type="checkbox" checked={opts.watermark} disabled={!!job} onChange={(e) => set({ watermark: e.target.checked })} />
            Credit
          </label>
        </div>

        <div className="bw-replay-export">
          {job ? (
            <div className="bw-progress" role="status" aria-live="polite">
              <LoaderCircle size={16} className="bw-spin" />
              <span>{job.kind === 'gif' ? 'Encoding GIF' : 'Recording video in real time — keep this tab visible'}… {Math.round(job.progress * 100)}%</span>
              <div className="bw-progress-bar"><div style={{ width: `${job.progress * 100}%` }} /></div>
              <button type="button" className="bw-btn" onClick={() => job.controller.abort()}>Cancel</button>
            </div>
          ) : (
            <>
              <label className="bw-field-inline">
                GIF width
                <select className="bw-select" value={opts.gifWidth} onChange={(e) => set({ gifWidth: Number(e.target.value) })}>
                  <option value={640}>640 px · smallest</option>
                  <option value={960}>960 px</option>
                  <option value={1280}>1280 px · sharpest</option>
                </select>
              </label>
              <button type="button" className="bw-btn bw-btn-accent" onClick={exportGif} disabled={!replay.steps.length}>
                <Film size={15} /> Download GIF
              </button>
              <button
                type="button"
                className="bw-btn"
                onClick={exportVideo}
                disabled={!video || !replay.steps.length}
                title={video ? `Records ${fmt(duration)} of ${video.ext.toUpperCase()} video (${camera && camera.w >= camera.h ? '1920×1080' : '1080×1350'})` : 'This browser cannot record video'}
              >
                <Film size={15} /> {video ? `Download ${video.ext.toUpperCase()}` : 'Video unavailable'}
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
