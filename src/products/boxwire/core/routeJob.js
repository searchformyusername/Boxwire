// The routing worker's job loop, apart from the Worker global so it can be tested (and run in-process):
// submit({ gen, doc, ids }) queues a document; only the newest queued one is routed, in deadline-bounded
// slices with a macrotask between them, and answered with { gen, entries } for the requested edge ids.

export const ROUTE_SLICE_MS = 25

export function routeJob(router, routingObstacles, post, { tick = () => new Promise((r) => setTimeout(r, 0)), slice = ROUTE_SLICE_MS } = {}) {
  let latest = null, running = false
  const stats = { routed: 0, superseded: 0, get running() { return running } }

  async function loop() {
    running = true
    try {
      while (latest) {
        const current = latest
        const nodes = Object.values(current.doc).filter((e) => e.type === 'node')
        const obstacles = routingObstacles(nodes)
        let superseded = false
        for (;;) {
          const out = router(current.doc, obstacles, { deadline: performance.now() + slice })
          if (!out.pending.size) break
          await tick()
          if (latest !== current) {
            superseded = true
            break
          }
        }
        if (superseded) {
          stats.superseded++
          continue
        }
        latest = null
        stats.routed++
        post({ gen: current.gen, entries: router.entries(current.ids) })
      }
    } finally {
      running = false
    }
  }

  return {
    stats,
    submit(msg) {
      latest = msg
      if (!running) loop()
    },
  }
}
