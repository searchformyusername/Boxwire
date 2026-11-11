// Connector routing off the main thread. The worker runs the same router (core/edges.js) on the documents the
// editor sends, in slices of ROUTE_SLICE_MS so that a newer document can supersede the one in progress: a
// superseded job is dropped (its finished routes stay in the worker's cache, still valid for that geometry)
// and only the newest is answered. Replies carry the generation they were computed for; the editor ignores
// any that isn't its current one.

import { createRouter, routingObstacles } from './edges.js'
import { routeJob } from './routeJob.js'

const router = createRouter()
const job = routeJob(router, routingObstacles, (msg) => self.postMessage(msg))
self.onmessage = (e) => job.submit(e.data)
