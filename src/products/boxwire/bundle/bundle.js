// The review bundle: a store-only ZIP a reviewer can hand to a teammate. It
// carries both sources, the optional accepted revision and patch, the rules,
// the change/rule results exactly as computed, rendered views and a static
// review.html, all listed with SHA-256 in manifest.json. Opening one checks
// structure, every hash, the baseline it was made against and, given a
// `recompute`, that the bundled results still reproduce.
//
// Hashes are integrity and comparison provenance only, never identity or approval.
// The host app must not render review.html or the SVG views as live DOM: show
// bundleSummary() text, or offer the files for download.

import { ZIP_LIMITS, readZip, writeZip } from './zip.js'
import { sha256Hex } from './digest.js'
import { INTEGRITY_NOTE, reviewView, summaryLines } from './view.js'
import { reviewHtml } from './html.js'

export const BUNDLE_FORMAT = 'boxwire-review-bundle'
export const BUNDLE_VERSION = 1
export const TOOL = { name: 'Boxwire', version: '0.2.0' }
export const BUNDLE_LIMITS = ZIP_LIMITS

export const PATHS = {
  manifest: 'manifest.json',
  baseline: 'baseline.boxwire.jsonc',
  proposal: 'proposal.boxwire.jsonc',
  accepted: 'accepted.boxwire.jsonc',
  acceptedPatch: 'accepted.patch.json',
  rules: 'rules.json',
  results: 'results.json',
  baselineView: 'views/baseline.svg',
  proposalView: 'views/proposal.svg',
  html: 'review.html',
}
const REQUIRED = [PATHS.manifest, PATHS.baseline, PATHS.proposal, PATHS.results, PATHS.html]
const MAX_MANIFEST = 1024 * 1024
const MAX_MISMATCHES = 200

const utf8 = new TextEncoder()
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const mb = (n) => `${Math.round((n / 1024 / 1024) * 10) / 10} MB`
const err = (code, message, file) => (file === undefined ? { code, message } : { code, message, file })
const stableJson = (v) => JSON.stringify(v, null, 2) + '\n'
const short = (h) => (typeof h === 'string' ? h.slice(0, 12) : String(h))

/**
 * Build a review bundle. Returns { ok, bytes, manifest, errors }: on any error
 * (bad input, a view that failed to render, contents over the size limit)
 * `bytes` and `manifest` are null and nothing partial is produced.
 *
 * - `results`: the diff, merge and rule results with witnesses, stored as given.
 * - `docs` + `renderSvg(doc) → string`: rendered views; both or neither.
 * - `createdAt`: ISO string; fixed values make the output byte-for-byte repeatable.
 */
export async function buildReviewBundle({ name, baseline, proposal, accepted, rules, results, docs, renderSvg, createdAt = new Date().toISOString(), limits = BUNDLE_LIMITS } = {}) {
  const errors = []
  const failed = () => ({ ok: false, bytes: null, manifest: null, errors })
  if (typeof name !== 'string' || !name.trim()) errors.push(err('input', 'name must be a non-empty string.'))
  if (typeof baseline?.source !== 'string') errors.push(err('input', 'baseline.source must be a string.'))
  if (typeof proposal?.source !== 'string') errors.push(err('input', 'proposal.source must be a string.'))
  if (accepted !== undefined && typeof accepted?.source !== 'string') errors.push(err('input', 'accepted.source must be a string when accepted is given.'))
  if (rules !== undefined && typeof rules !== 'string') errors.push(err('input', 'rules must be a string (the rules file text).'))
  if (!isObj(results)) errors.push(err('input', 'results must be an object.'))
  if (errors.length) return failed()

  let resultsText, patchText
  try {
    resultsText = stableJson(results)
    if (accepted?.patch !== undefined) patchText = typeof accepted.patch === 'string' ? accepted.patch : stableJson(accepted.patch)
  } catch (e) {
    return errors.push(err('input', `results and accepted.patch must be JSON-serialisable (${e.message}).`)), failed()
  }

  const entries = [[PATHS.baseline, baseline.source], [PATHS.proposal, proposal.source]]
  if (accepted) entries.push([PATHS.accepted, accepted.source])
  if (patchText !== undefined) entries.push([PATHS.acceptedPatch, patchText])
  if (rules !== undefined) entries.push([PATHS.rules, rules])
  entries.push([PATHS.results, resultsText])
  const files = entries.map(([path, text]) => ({ path, bytes: utf8.encode(text) }))
  // Fail on size before rendering or hashing anything large.
  const tooBig = () => {
    const total = files.reduce((n, f) => n + f.bytes.length, 0)
    if (total <= limits.totalBytes) return false
    errors.push(err('too-large', `The bundle would hold ${mb(total)}; the limit is ${mb(limits.totalBytes)}. Nothing was written. Remove large comments or embedded data from the sources, or export the files separately.`))
    return true
  }
  if (tooBig()) return failed()

  const svgs = {}
  if (renderSvg && docs) {
    for (const key of ['baseline', 'proposal']) {
      if (!docs[key]) continue
      try {
        svgs[key] = renderSvg(docs[key])
        if (typeof svgs[key] !== 'string') throw new Error('renderSvg did not return a string')
      } catch (e) {
        errors.push(err('render', `Rendering the ${key} view failed: ${e?.message ?? e}.`))
      }
    }
    if (errors.length) return failed()
    if (svgs.baseline) files.push({ path: PATHS.baselineView, bytes: utf8.encode(svgs.baseline) })
    if (svgs.proposal) files.push({ path: PATHS.proposalView, bytes: utf8.encode(svgs.proposal) })
  }
  if (tooBig()) return failed()

  for (const f of files) f.sha256 = await sha256Hex(f.bytes)
  const hashOf = (path) => files.find((f) => f.path === path)?.sha256
  const manifest = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    name: name.trim(),
    createdAt: String(createdAt),
    tool: { ...TOOL },
    note: INTEGRITY_NOTE,
    baselineHash: hashOf(PATHS.baseline),
    proposalHash: hashOf(PATHS.proposal),
    ...(accepted && { acceptedHash: hashOf(PATHS.accepted) }),
    files: files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes: bytes.length })),
  }
  const sources = { baseline: baseline.source, proposal: proposal.source, ...(accepted && { accepted: accepted.source }) }
  const html = utf8.encode(await reviewHtml(reviewView({ manifest, results, sources }), svgs))
  const htmlFile = { path: PATHS.html, bytes: html, sha256: await sha256Hex(html) }
  files.push(htmlFile)
  manifest.files.push({ path: htmlFile.path, sha256: htmlFile.sha256, bytes: html.length })
  if (tooBig()) return failed()

  const zipEntries = [{ name: PATHS.manifest, bytes: utf8.encode(stableJson(manifest)) }, ...files.map((f) => ({ name: f.path, bytes: f.bytes }))]
  return { ok: true, bytes: writeZip(zipEntries), manifest, errors }
}

const decode = (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes)

/**
 * Open and verify a bundle. Never throws. Returns
 * { ok, manifest, files: Map<path, Uint8Array>, sources, results, errors, warnings, mismatches }.
 *
 * - `expectBaselineHash`: the sourceHash() of the baseline the user has open; a
 *   bundle made against a different baseline is refused as stale.
 * - `recompute({ baseline, proposal, accepted, acceptedPatch, rules })`: re-runs
 *   the checks on the bundled text; every JSON path where its output differs
 *   from results.json is listed in `mismatches` and the bundle is not ok.
 */
export async function openReviewBundle(bytes, { recompute, expectBaselineHash, limits = BUNDLE_LIMITS } = {}) {
  const out = { ok: false, manifest: null, files: new Map(), sources: null, results: null, errors: [], warnings: [], mismatches: [] }
  try {
    await open(bytes, { recompute, expectBaselineHash, limits }, out)
  } catch (e) {
    out.errors.push(err('internal', `The bundle could not be checked (${e?.message ?? e}).`))
  }
  out.ok = !out.errors.length && !out.mismatches.length
  return out
}

async function open(bytes, { recompute, expectBaselineHash, limits }, out) {
  const zip = readZip(bytes, { limits })
  if (zip.errors.length) return out.errors.push(...zip.errors)
  const files = zip.files
  const raw = files.get(PATHS.manifest)
  if (!raw) return out.errors.push(err('missing', `Missing required file ${PATHS.manifest}; this is not a Boxwire review bundle.`, PATHS.manifest))
  if (raw.length > MAX_MANIFEST) return out.errors.push(err('too-large', `${PATHS.manifest} is ${mb(raw.length)}; the limit is ${mb(MAX_MANIFEST)}.`, PATHS.manifest))
  let manifest
  try {
    manifest = JSON.parse(decode(raw))
  } catch (e) {
    return out.errors.push(err('bad-manifest', `${PATHS.manifest} is not valid UTF-8 JSON (${e.message}).`, PATHS.manifest))
  }
  if (!isObj(manifest)) return out.errors.push(err('bad-manifest', `${PATHS.manifest} must be a JSON object.`, PATHS.manifest))
  if (manifest.format !== BUNDLE_FORMAT) return out.errors.push(err('format', `Not a Boxwire review bundle (format ${JSON.stringify(manifest.format) ?? 'missing'}); expected "${BUNDLE_FORMAT}".`, PATHS.manifest))
  if (manifest.version !== BUNDLE_VERSION) return out.errors.push(err('version', `Unsupported review bundle version ${JSON.stringify(manifest.version) ?? 'missing'}; this Boxwire reads version ${BUNDLE_VERSION}.`, PATHS.manifest))
  if (!Array.isArray(manifest.files)) return out.errors.push(err('bad-manifest', `${PATHS.manifest} has no "files" list.`, PATHS.manifest))
  out.manifest = manifest

  const listed = new Map()
  for (const [i, f] of manifest.files.entries()) {
    if (!isObj(f) || typeof f.path !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256) || !Number.isInteger(f.bytes)) {
      out.errors.push(err('bad-manifest', `${PATHS.manifest} files[${i}] needs a path, a 64-digit hex sha256 and an integer byte count.`, PATHS.manifest))
      continue
    }
    if (listed.has(f.path) || f.path === PATHS.manifest) out.errors.push(err('bad-manifest', `${PATHS.manifest} lists ${JSON.stringify(f.path)} more than once or lists itself.`, PATHS.manifest))
    listed.set(f.path, f)
  }
  for (const path of REQUIRED) {
    if (path !== PATHS.manifest && !files.has(path)) out.errors.push(err('missing', `Missing required file ${path}.`, path))
    else if (path !== PATHS.manifest && !listed.has(path)) out.errors.push(err('unlisted', `${path} is not listed in ${PATHS.manifest}, so it can't be verified.`, path))
  }
  for (const [path, f] of listed) {
    const data = files.get(path)
    if (!data) {
      if (!REQUIRED.includes(path)) out.errors.push(err('missing', `${path} is listed in ${PATHS.manifest} but missing from the archive.`, path))
      continue
    }
    if (data.length !== f.bytes) out.errors.push(err('size', `${path} is ${data.length} bytes; the manifest records ${f.bytes}.`, path))
    const got = await sha256Hex(data)
    if (got !== f.sha256) out.errors.push(err('hash', `${path}: SHA-256 mismatch (manifest ${short(f.sha256)}…, file ${short(got)}…); the file was altered after the bundle was made.`, path))
  }
  for (const path of files.keys()) {
    if (path !== PATHS.manifest && !listed.has(path)) out.warnings.push(err('unlisted', `${path} is not in the manifest and was ignored.`, path))
  }
  for (const [key, path] of [['baselineHash', PATHS.baseline], ['proposalHash', PATHS.proposal], ['acceptedHash', PATHS.accepted]]) {
    if ((manifest[key] !== undefined || key !== 'acceptedHash') && listed.has(path) && manifest[key] !== listed.get(path).sha256) {
      out.errors.push(err('hash', `${PATHS.manifest} ${key} does not match the hash recorded for ${path}.`, PATHS.manifest))
    }
  }
  for (const path of listed.keys()) if (files.has(path)) out.files.set(path, files.get(path))
  if (out.errors.length) return

  if (expectBaselineHash !== undefined && expectBaselineHash !== manifest.baselineHash) {
    return out.errors.push(err('stale-baseline', `Stale baseline: this review was made against baseline ${short(manifest.baselineHash)}…, but your current baseline is ${short(expectBaselineHash)}…. Re-run the review on your current baseline before applying it.`, PATHS.baseline))
  }

  const text = {}
  for (const [key, path] of Object.entries(PATHS)) {
    if (key === 'manifest' || !out.files.has(path)) continue
    try {
      text[key] = decode(out.files.get(path))
    } catch {
      out.errors.push(err('encoding', `${path} is not valid UTF-8.`, path))
    }
  }
  if (out.errors.length) return
  try {
    out.results = JSON.parse(text.results)
  } catch (e) {
    return out.errors.push(err('bad-results', `${PATHS.results} is not valid JSON (${e.message}).`, PATHS.results))
  }
  out.sources = { baseline: text.baseline, proposal: text.proposal, accepted: text.accepted, acceptedPatch: text.acceptedPatch, rules: text.rules }

  if (recompute) {
    let fresh
    try {
      fresh = JSON.parse(JSON.stringify(await recompute({ ...out.sources })))
    } catch (e) {
      return out.errors.push(err('recompute', `Re-running the checks failed: ${e?.message ?? e}.`))
    }
    jsonMismatches(out.results, fresh, '$', out.mismatches)
  }
}

const preview = (v) => {
  const s = v === undefined ? 'absent' : JSON.stringify(v)
  return s.length > 80 ? s.slice(0, 79) + '…' : s
}

/** Every JSON path where `a` (bundled) and `b` (recomputed) differ, pushed onto `out` as { path, bundled, recomputed }. */
export function jsonMismatches(a, b, path = '$', out = []) {
  if (out.length >= MAX_MISMATCHES) return out
  const push = () => out.push({ path, bundled: preview(a), recomputed: preview(b) })
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) jsonMismatches(a[i], b[i], `${path}[${i}]`, out)
  } else if (isObj(a) && isObj(b)) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      jsonMismatches(a[k], b[k], /^[A-Za-z_$][\w$]*$/.test(k) ? `${path}.${k}` : `${path}[${JSON.stringify(k)}]`, out)
    }
  } else if (a !== b) push()
  return out
}

/**
 * Plain-text summary of an openReviewBundle() result, safe to show in the host
 * app (no markup; untrusted strings are stripped of control and bidi characters).
 */
export function bundleSummary(opened) {
  const lines = [opened.ok ? 'Bundle verified: structure and every SHA-256 match the manifest.' : 'Bundle NOT verified.']
  for (const e of opened.errors) lines.push(`Error: ${clip(e.message)}`)
  for (const w of opened.warnings) lines.push(`Warning: ${clip(w.message)}`)
  if (opened.mismatches.length) {
    lines.push(`Recomputed checks differ from results.json at ${opened.mismatches.length}${opened.mismatches.length >= MAX_MISMATCHES ? '+' : ''} path(s):`)
    for (const m of opened.mismatches.slice(0, 20)) lines.push(`  ${clip(m.path)}: bundled ${clip(m.bundled)}, recomputed ${clip(m.recomputed)}`)
  }
  if (opened.manifest && opened.results) {
    lines.push('', ...summaryLines(reviewView({ manifest: opened.manifest, results: opened.results, sources: opened.sources ?? {} })))
  }
  return lines.join('\n')
}

// eslint-disable-next-line no-control-regex
const clip = (s) => String(s).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 300)
