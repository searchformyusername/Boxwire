// Presentation-only ink. Kept outside the editor store so pointer movement
// schedules one canvas frame without notifying React or recording board edits.
const LIFETIME = 900
const MAX_POINTS = 128
const SAMPLE_MS = 8

export function createLaser({ invalidate = () => {}, now = () => performance.now() } = {}) {
  const points = []
  let pointer = null
  let reducedMotion = false
  let sampledAt = -Infinity

  function prune(time) {
    let expired = 0
    while (expired < points.length && time - points[expired].t >= LIFETIME) expired++
    if (expired) points.splice(0, expired)
  }

  return {
    move(position, pressed = false) {
      const time = now()
      const starts = !pointer
      pointer = { ...position, pressed }
      prune(time)
      if (!reducedMotion) {
        const last = points[points.length - 1]
        // Keep the endpoint current even for high-rate coalesced pen events.
        // The cap bounds both retained memory and work per animation frame.
        const point = { ...position, pressed, t: time, starts }
        if (!starts && last && time - sampledAt < SAMPLE_MS && last.pressed === pressed) {
          point.starts = last.starts
          points[points.length - 1] = point
        } else if (starts || !last || last.x !== position.x || last.y !== position.y || last.pressed !== pressed) {
          points.push(point)
          sampledAt = time
          if (points.length > MAX_POINTS) points.shift()
        }
      }
      invalidate()
    },
    show(position) {
      pointer = { ...position, pressed: false }
      invalidate()
    },
    leave() {
      pointer = null
      invalidate()
    },
    clear() {
      pointer = null
      points.length = 0
      invalidate()
    },
    setReducedMotion(value) {
      reducedMotion = value
      if (value) points.length = 0
      invalidate()
    },
    // Screen coordinates: the dot and line widths stay constant at every zoom.
    draw(ctx) {
      const time = now()
      prune(time)
      let fading = false
      ctx.save()
      ctx.lineCap = 'round'
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i]
        if (b.starts) continue
        const life = Math.max(0, 1 - (time - a.t) / LIFETIME)
        ctx.strokeStyle = `rgba(239, 68, 68, ${(b.pressed ? 0.55 : 0.2) * life * life})`
        ctx.lineWidth = b.pressed ? 3 : 2
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
        fading = true
      }
      if (pointer) {
        const { x, y, pressed } = pointer
        ctx.fillStyle = pressed ? 'rgba(255, 59, 48, 0.22)' : 'rgba(239, 68, 68, 0.12)'
        ctx.beginPath()
        ctx.arc(x, y, pressed ? 9 : 7, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = pressed ? '#ff3b30' : '#ef4444'
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.arc(x, y, pressed ? 4 : 3, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
        if (pressed) {
          ctx.fillStyle = '#fff1ed'
          ctx.beginPath()
          ctx.arc(x, y, 1.2, 0, Math.PI * 2)
          ctx.fill()
        }
      }
      ctx.restore()
      // A stationary dot needs no animation once its trail has faded.
      return fading
    },
  }
}
