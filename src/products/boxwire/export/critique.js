// The critique bundle: one JSON file an agent can read without the app. It
// holds the typed graph (stable ids, kinds, declared capacity), every review
// result with its witness, the derived capacity formulas, the rubric and its
// score, and the board hash a returned `boxwire-patch` must carry.

import { CRITIQUE_FORMAT, PATCH_FORMAT, docHash } from '../author/patch.js'
import { RULES, reviewDoc } from '../review/index.js'
import { rubricDefinition, scoreBoard } from '../review/rubric.js'
import { formatInterval } from '../review/capacity.js'
import { rate } from '../review/units.js'

export const GUIDE = 'https://gitreset.dev/products/boxwire/llm.md'

export async function buildCritique({ name, doc, history, practice = null, problem = null, now = Date.now() }) {
  const review = reviewDoc(doc)
  const g = review.graph
  const score = scoreBoard({ doc, base: history.base, done: history.done, practice, problem, now })
  return {
    format: CRITIQUE_FORMAT,
    version: 1,
    name,
    baseline: await docHash(doc),
    guide: GUIDE,
    instructions: [
      'You are reviewing a system design drawn in Boxwire. The review results below are deterministic checks of the declared model, not of a deployed system.',
      '"unknown" results mean a fact is undeclared, not that the design is wrong.',
      'Cite result ids (like "single-point-of-failure:api") and element ids when you critique.',
      `To propose changes, answer with one JSON object: { "format": "${PATCH_FORMAT}", "version": 1, "baseline": "<the baseline below>", "ops": [...] }. Operations are listed in the guide under "Agent patches". The user previews it and applies it as one undoable step.`,
    ],
    problem: problem && { id: problem.id, name: problem.name, prompt: problem.prompt, functional: problem.functional, nonFunctional: problem.nonFunctional },
    graph: {
      nodes: [...g.nodes.values()].map((n) => ({ id: n.id, kind: n.kind, role: n.role, label: String(n.el.text || ''), ...(n.inferred && { kindInferred: true }), ...(Object.keys(n.cap).length && { capacity: n.cap }) })),
      edges: g.edges.map((e) => ({ id: e.id, from: e.from, to: e.to, mode: e.async ? 'async' : 'sync', ...(e.carries && { carries: e.carries }), ...(e.el.share !== undefined && { share: e.el.share }), ...(e.el.text && { label: e.el.text }) })),
      excluded: Object.values(doc).filter((el) => el.type === 'node' && el.crossed).map((el) => ({ id: el.id, label: String(el.text || ''), reason: 'crossed out (rejected option)' })),
    },
    review: {
      version: review.version,
      rules: RULES.map(({ id, severity, title, checks, violation, unknown, pass, fix }) => ({ id, severity, title, checks, violation, unknown, pass, fix })),
      results: review.results.map(({ id, rule, status, severity, elementIds, message, witness, declare }) => ({ id, rule, status, severity, elementIds, message, ...(witness && { witness }), ...(declare && { declare }) })),
    },
    capacity: review.capacity && [...review.capacity.nodes].filter(([, n]) => n.steps.length).map(([id, n]) => ({
      id, reads: formatInterval(n.in.r, rate), writes: formatInterval(n.in.w, rate), steps: n.steps,
    })),
    rubric: rubricDefinition(),
    score: { percent: score.percent, earned: score.earned, max: score.max, items: score.items.map(({ id, status, earned, points, detail, evidence }) => ({ id, status, earned, points, detail, elements: evidence.map((e) => e.id) })) },
  }
}
