// The review engine's entry point for the UI: lint (with the typed graph and
// capacity it computed) memoised on document identity, so the panel, the
// canvas overlay and the score all read one result per committed document.

import { lint } from './lint.js'

const cache = new WeakMap()

/** Lint result for a document map; the same object until the document changes. */
export function reviewDoc(doc) {
  let r = cache.get(doc)
  if (!r) {
    r = lint(doc)
    cache.set(doc, r)
  }
  return r
}

export { RULES, RULE_BY_ID, LINT_VERSION } from './lint.js'
