// The editor's side of the routing worker: one worker per editor, created on the first request and
// terminated by dispose() (a request after that starts a fresh one). request() posts the slimmest document routing needs and returns its
// generation; results for older generations are the caller's to ignore. liveRouteWorkers() counts the
// workers this module has created and not yet terminated (for leak tests).

import { createRouter, routingObstacles } from './edges.js'

let live = 0
export const liveRouteWorkers = () => live

/** Only what routing reads: node geometry and shape, edge ends and route style. */
export function slimDoc(doc) {
  const out = {}
  for (const el of Object.values(doc)) {
    if (el.type === 'node') out[el.id] = { id: el.id, type: 'node', shape: el.shape, x: el.x, y: el.y, w: el.w, h: el.h }
    else if (el.type === 'edge') out[el.id] = { id: el.id, type: 'edge', from: el.from, to: el.to, route: el.route }
  }
  return out
}

/** Failures after which a client stops starting workers (its owner then routes on the main thread, in slices). */
export const MAX_WORKER_FAILURES = 2

export function createRouteClient({ spawn = () => new Worker(new URL('./route.worker.js', import.meta.url), { type: 'module' }) } = {}) {
  let worker = null, gen = 0, failures = 0
  const listeners = new Set(), errorListeners = new Set()
  const drop = () => {
    if (!worker) return
    worker.onmessage = worker.onerror = worker.onmessageerror = null
    worker.terminate()
    worker = null
    live--
  }
  // a worker that errors (or sends a message that can't be read) is terminated and forgotten, and every
  // pending request is told: the caller settles it with a fallback, never waits forever
  const fail = (reason) => {
    drop()
    failures++
    for (const l of errorListeners) l({ gen, reason })
  }
  const ensure = () => {
    if (worker) return worker
    if (failures >= MAX_WORKER_FAILURES) return null
    try {
      worker = spawn()
    } catch (err) {
      worker = null
      failures = MAX_WORKER_FAILURES
      for (const l of errorListeners) l({ gen, reason: `the routing worker could not start (${err?.message ?? err})` })
      return null
    }
    live++
    worker.onmessage = (e) => {
      for (const l of listeners) l(e.data)
    }
    worker.onerror = (e) => {
      e?.preventDefault?.()
      fail(`the routing worker failed (${e?.message ?? 'error'})`)
    }
    worker.onmessageerror = () => fail("the routing worker's answer could not be read")
    return worker
  }
  return {
    /** Post a document; returns its generation, or -1 when no worker can be used (route on the main thread). */
    request(doc, ids) {
      const w = ensure()
      if (!w) return -1
      gen++
      try {
        w.postMessage({ gen, doc: slimDoc(doc), ids })
      } catch (err) {
        fail(`the document could not be sent to the routing worker (${err?.message ?? err})`)
        return -1
      }
      return gen
    },
    onResult(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    /** fn({ gen, reason }) when the worker fails; requests up to `gen` will get no answer. */
    onError(fn) {
      errorListeners.add(fn)
      return () => errorListeners.delete(fn)
    },
    /** True once workers have failed MAX_WORKER_FAILURES times; requests then return -1. */
    get broken() { return failures >= MAX_WORKER_FAILURES },
    /**
     * Terminate the worker. A later request starts a new one (React's development double-mount disposes and
     * then reuses the same editor); an editor that is really gone makes no more requests, so none is left.
     */
    dispose: drop,
    get generation() { return gen },
  }
}

/** How long routeAsync waits for the worker before it gives up on it. */
export const ROUTE_TIMEOUT_MS = 15000
/** Main-thread routing allowed for routeAsync's fallback, after which the rest is drawn as plain elbows. */
export const FALLBACK_ROUTE_MS = 200

/**
 * Every connector of `doc` routed in a worker (exactly what createRouter() computes), as a Promise of
 * Map<edgeId, pts>. It always settles: on a worker error, an unreadable answer, a timeout or `signal`
 * aborting, the worker is terminated and the map comes from a bounded main-thread fallback (exact routes for
 * FALLBACK_ROUTE_MS, plain elbows after), marked with `fallback: { reason, provisional }`. Without Worker
 * support it routes here.
 */
export function routeAsync(doc, { spawn, timeout = ROUTE_TIMEOUT_MS, signal } = {}) {
  const router = createRouter()
  const obstacles = routingObstacles(Object.values(doc).filter((e) => e.type === 'node'))
  if (!spawn && typeof Worker !== 'function') return Promise.resolve(router(doc, obstacles))
  // a zero deadline routes one connector here; it records the document so the worker's routes can be adopted for it
  const first = router(doc, obstacles, { deadline: -Infinity })
  if (!first.pending.size) return Promise.resolve(first)
  const client = createRouteClient(spawn ? { spawn } : undefined)
  return new Promise((resolve) => {
    let settled = false, timer = null
    const finish = (routes) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      client.dispose()
      resolve(routes)
    }
    const fallback = (reason) => {
      if (settled) return
      const routes = router(doc, obstacles, { deadline: performance.now() + FALLBACK_ROUTE_MS })
      routes.fallback = { reason, provisional: routes.pending.size }
      finish(routes)
    }
    const onAbort = () => fallback('cancelled')
    if (signal?.aborted) return fallback('cancelled')
    signal?.addEventListener?.('abort', onAbort)
    client.onResult(({ entries }) => {
      router.adopt(entries)
      finish(router(doc, obstacles))
    })
    client.onError(({ reason }) => fallback(reason))
    timer = setTimeout(() => fallback(`the routing worker did not answer within ${Math.round(timeout / 1000)} s`), timeout)
    if (client.request(doc, [...first.pending]) < 0) fallback('no routing worker could be started')
  })
}
