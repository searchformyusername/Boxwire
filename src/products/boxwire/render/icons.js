// Component icons: lucide's icon node data (already a dependency) flattened to
// one SVG path string per icon, so the canvas can stroke it as a Path2D (the
// string rides along as `.d` for the SVG export context).

import { __iconData as activity } from 'lucide-react/dist/esm/icons/activity.mjs'
import { __iconData as archive } from 'lucide-react/dist/esm/icons/archive.mjs'
import { __iconData as bell } from 'lucide-react/dist/esm/icons/bell.mjs'
import { __iconData as bot } from 'lucide-react/dist/esm/icons/bot.mjs'
import { __iconData as box } from 'lucide-react/dist/esm/icons/box.mjs'
import { __iconData as brain } from 'lucide-react/dist/esm/icons/brain-circuit.mjs'
import { __iconData as chart } from 'lucide-react/dist/esm/icons/chart-line.mjs'
import { __iconData as clock } from 'lucide-react/dist/esm/icons/clock.mjs'
import { __iconData as cloud } from 'lucide-react/dist/esm/icons/cloud.mjs'
import { __iconData as cog } from 'lucide-react/dist/esm/icons/cog.mjs'
import { __iconData as container } from 'lucide-react/dist/esm/icons/container.mjs'
import { __iconData as cpu } from 'lucide-react/dist/esm/icons/cpu.mjs'
import { __iconData as card } from 'lucide-react/dist/esm/icons/credit-card.mjs'
import { __iconData as database } from 'lucide-react/dist/esm/icons/database.mjs'
import { __iconData as databaseZap } from 'lucide-react/dist/esm/icons/database-zap.mjs'
import { __iconData as door } from 'lucide-react/dist/esm/icons/door-open.mjs'
import { __iconData as earth } from 'lucide-react/dist/esm/icons/earth.mjs'
import { __iconData as file } from 'lucide-react/dist/esm/icons/file-text.mjs'
import { __iconData as gauge } from 'lucide-react/dist/esm/icons/gauge.mjs'
import { __iconData as globe } from 'lucide-react/dist/esm/icons/globe.mjs'
import { __iconData as drive } from 'lucide-react/dist/esm/icons/hard-drive.mjs'
import { __iconData as image } from 'lucide-react/dist/esm/icons/image.mjs'
import { __iconData as key } from 'lucide-react/dist/esm/icons/key-round.mjs'
import { __iconData as layers } from 'lucide-react/dist/esm/icons/layers.mjs'
import { __iconData as lock } from 'lucide-react/dist/esm/icons/lock.mjs'
import { __iconData as mail } from 'lucide-react/dist/esm/icons/mail.mjs'
import { __iconData as message } from 'lucide-react/dist/esm/icons/message-square.mjs'
import { __iconData as monitor } from 'lucide-react/dist/esm/icons/monitor.mjs'
import { __iconData as network } from 'lucide-react/dist/esm/icons/network.mjs'
import { __iconData as radio } from 'lucide-react/dist/esm/icons/radio.mjs'
import { __iconData as router } from 'lucide-react/dist/esm/icons/router.mjs'
import { __iconData as search } from 'lucide-react/dist/esm/icons/search.mjs'
import { __iconData as server } from 'lucide-react/dist/esm/icons/server.mjs'
import { __iconData as shield } from 'lucide-react/dist/esm/icons/shield-check.mjs'
import { __iconData as phone } from 'lucide-react/dist/esm/icons/smartphone.mjs'
import { __iconData as sparkles } from 'lucide-react/dist/esm/icons/sparkles.mjs'
import { __iconData as split } from 'lucide-react/dist/esm/icons/split.mjs'
import { __iconData as timer } from 'lucide-react/dist/esm/icons/timer.mjs'
import { __iconData as user } from 'lucide-react/dist/esm/icons/user.mjs'
import { __iconData as users } from 'lucide-react/dist/esm/icons/users.mjs'
import { __iconData as webhook } from 'lucide-react/dist/esm/icons/webhook.mjs'
import { __iconData as workflow } from 'lucide-react/dist/esm/icons/workflow.mjs'
import { __iconData as zap } from 'lucide-react/dist/esm/icons/zap.mjs'

const DATA = {
  activity, archive, bell, bot, box, brain, chart, clock, cloud, cog, container, cpu, card, database, databaseZap,
  door, earth, file, gauge, globe, drive, image, key, layers, lock, mail, message, monitor, network, radio, router,
  search, server, shield, phone, sparkles, split, timer, user, users, webhook, workflow, zap,
}
export const ICON_NAMES = Object.keys(DATA)

const n = (v) => Number(v ?? 0)
const ellipseD = (cx, cy, rx, ry) => `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0`

function toPathD([tag, a]) {
  switch (tag) {
    case 'path': return a.d
    case 'circle': return ellipseD(n(a.cx), n(a.cy), n(a.r), n(a.r))
    case 'ellipse': return ellipseD(n(a.cx), n(a.cy), n(a.rx), n(a.ry))
    case 'line': return `M${a.x1} ${a.y1}L${a.x2} ${a.y2}`
    case 'polyline':
    case 'polygon': return 'M' + a.points.trim().split(/[\s,]+/).reduce((s, v, i) => s + (i % 2 ? ' ' : i ? 'L' : '') + v, '') + (tag === 'polygon' ? 'Z' : '')
    case 'rect': {
      const x = n(a.x), y = n(a.y), w = n(a.width), h = n(a.height), r = Math.min(n(a.rx), w / 2, h / 2)
      return r
        ? `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}Z`
        : `M${x} ${y}h${w}v${h}h${-w}Z`
    }
    default: return ''
  }
}

const pathCache = new Map()

/** Path2D for an icon on lucide's 24×24 grid, or null for unknown names. */
export function iconPath(name) {
  if (typeof name !== 'string' || !Object.hasOwn(DATA, name)) return null
  let p = pathCache.get(name)
  if (!p) {
    const d = DATA[name].node.map(toPathD).join('')
    p = new Path2D(d)
    p.d = d
    pathCache.set(name, p)
  }
  return p
}
