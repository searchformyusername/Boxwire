// Store-only ZIP: a deterministic writer and a strict reader. No compression,
// no ZIP64, no encryption. The reader never throws: every problem with an
// archive comes back as a precise error, because bundles arrive from other
// people's machines.

export const ZIP_LIMITS = { totalBytes: 50 * 1024 * 1024, entries: 500 }

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const FLAG_ENCRYPTED = 0x0001
const FLAG_DESCRIPTOR = 0x0008
const FLAG_UTF8 = 0x0800
// 1980-01-01 00:00:00, the DOS epoch: every entry gets the same stamp so equal input gives equal bytes.
const DOS_TIME = 0
const DOS_DATE = (1 << 5) | 1
const UNIX_FILE = (0o100644 << 16) >>> 0
const METHODS = { 8: 'deflate', 9: 'deflate64', 12: 'bzip2', 14: 'LZMA', 93: 'zstd', 95: 'xz', 99: 'AES encryption' }

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

/** CRC-32 (ISO-HDLC, as ZIP uses it) of `bytes`. */
export function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const hex = (n) => '0x' + n.toString(16).padStart(8, '0')
const utf8 = new TextEncoder()

/** Why `name` is unsafe as an archive path, or null. Directory entries end in '/'. */
export function unsafePath(name) {
  if (typeof name !== 'string' || !name) return 'is empty'
  if (name.includes('\\')) return 'contains a backslash'
  if (name.includes('\0')) return 'contains a NUL character'
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return 'is an absolute path'
  const parts = name.replace(/\/$/, '').split('/')
  if (parts.some((p) => p === '..')) return 'contains a ".." segment'
  if (parts.some((p) => p === '' || p === '.')) return 'contains an empty or "." segment'
  return null
}

/**
 * Store-only ZIP of `entries` ([{ name, bytes: Uint8Array }]) in the given
 * order, with UTF-8 names and a fixed timestamp. Throws on unsafe or duplicate
 * names and on sizes beyond plain ZIP (4 GB, 65535 entries).
 */
export function writeZip(entries) {
  if (entries.length > 0xffff) throw new RangeError(`${entries.length} entries; a ZIP without ZIP64 holds at most 65535.`)
  const seen = new Set()
  const items = entries.map(({ name, bytes }) => {
    const bad = unsafePath(name)
    if (bad) throw new TypeError(`Entry name ${JSON.stringify(name)} ${bad}.`)
    if (seen.has(name)) throw new TypeError(`Duplicate entry name ${JSON.stringify(name)}.`)
    seen.add(name)
    if (!(bytes instanceof Uint8Array)) throw new TypeError(`Entry ${JSON.stringify(name)} needs Uint8Array bytes.`)
    return { name: utf8.encode(name), bytes, crc: crc32(bytes) }
  })
  let size = 22
  for (const it of items) size += 30 + it.name.length + it.bytes.length + 46 + it.name.length
  if (size > 0xffffffff) throw new RangeError('The archive would exceed 4 GB; ZIP64 is not supported.')

  const out = new Uint8Array(size)
  const v = new DataView(out.buffer)
  let p = 0
  const u16 = (n) => { v.setUint16(p, n, true); p += 2 }
  const u32 = (n) => { v.setUint32(p, n, true); p += 4 }
  const put = (b) => { out.set(b, p); p += b.length }
  for (const it of items) {
    it.offset = p
    u32(SIG_LOCAL); u16(10); u16(FLAG_UTF8); u16(0); u16(DOS_TIME); u16(DOS_DATE)
    u32(it.crc); u32(it.bytes.length); u32(it.bytes.length); u16(it.name.length); u16(0)
    put(it.name); put(it.bytes)
  }
  const cdStart = p
  for (const it of items) {
    u32(SIG_CENTRAL); u16(0x031e); u16(10); u16(FLAG_UTF8); u16(0); u16(DOS_TIME); u16(DOS_DATE)
    u32(it.crc); u32(it.bytes.length); u32(it.bytes.length); u16(it.name.length); u16(0); u16(0)
    u16(0); u16(0); u32(UNIX_FILE); u32(it.offset)
    put(it.name)
  }
  const cdSize = p - cdStart
  u32(SIG_EOCD); u16(0); u16(0); u16(items.length); u16(items.length); u32(cdSize); u32(cdStart); u16(0)
  return out
}

/**
 * Read a store-only ZIP. Returns { files: Map<name, Uint8Array>, errors }
 * where errors are { code, message, file? }. Directory entries are skipped.
 * Any error means the archive should be refused; `files` then holds only the
 * entries that passed every check.
 */
export function readZip(bytes, { limits = ZIP_LIMITS } = {}) {
  const files = new Map()
  const errors = []
  const fail = (code, message, file) => {
    if (errors.length < 100) errors.push(file === undefined ? { code, message } : { code, message, file })
  }
  try {
    read(bytes, limits, files, fail)
  } catch (err) {
    fail('malformed', `The archive could not be read (${err?.message ?? err}).`)
  }
  if (errors.length) for (const e of errors) if (e.file) files.delete(e.file)
  return { files, errors }
}

function read(bytes, limits, files, fail) {
  if (!(bytes instanceof Uint8Array)) return fail('malformed', 'Expected the archive as a Uint8Array.')
  if (bytes.length > limits.totalBytes + 64 * 1024 * 1024) return fail('too-large', `The archive is ${mb(bytes.length)}; the limit is ${mb(limits.totalBytes)} of content.`)
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 22) return fail('truncated', `The archive is ${bytes.length} bytes, too short to be a ZIP (an empty ZIP is 22 bytes).`)

  // The EOCD record sits at the end, followed by an optional comment of at most 65535 bytes.
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === SIG_EOCD && i + 22 + v.getUint16(i + 20, true) === bytes.length) { eocd = i; break }
  }
  if (eocd < 0) return fail('no-eocd', 'Not a complete ZIP archive: the end-of-central-directory record is missing (the file may be truncated or not a ZIP).')
  const disk = v.getUint16(eocd + 4, true), cdDisk = v.getUint16(eocd + 6, true)
  const onDisk = v.getUint16(eocd + 8, true), count = v.getUint16(eocd + 10, true)
  const cdSize = v.getUint32(eocd + 12, true), cdStart = v.getUint32(eocd + 16, true)
  if (disk !== 0 || cdDisk !== 0 || onDisk !== count) return fail('multi-disk', 'Split (multi-disk) archives are not supported.')
  if (count === 0xffff || cdSize === 0xffffffff || cdStart === 0xffffffff) return fail('zip64', 'ZIP64 archives are not supported.')
  if (count > limits.entries) return fail('too-many', `The archive has ${count} entries; the limit is ${limits.entries}.`)
  if (cdStart + cdSize !== eocd) return fail('bad-directory', `The central directory (offset ${cdStart}, ${cdSize} bytes) does not end where the end record begins (offset ${eocd}); the archive is truncated or has data prepended.`)

  const entries = []
  let p = cdStart
  for (let k = 0; k < count; k++) {
    if (p + 46 > eocd || v.getUint32(p, true) !== SIG_CENTRAL) return fail('bad-directory', `Central directory entry ${k + 1} of ${count} is missing or damaged.`)
    const flags = v.getUint16(p + 8, true), method = v.getUint16(p + 10, true)
    const crc = v.getUint32(p + 16, true), csize = v.getUint32(p + 20, true), usize = v.getUint32(p + 24, true)
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true)
    const offset = v.getUint32(p + 42, true)
    const end = p + 46 + nameLen + extraLen + commentLen
    if (end > eocd) return fail('bad-directory', `Central directory entry ${k + 1} of ${count} runs past the directory.`)
    const rawName = bytes.subarray(p + 46, p + 46 + nameLen)
    let name
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(rawName)
    } catch {
      fail('bad-name', `Entry ${k + 1} has a name that is not valid UTF-8.`)
      p = end
      continue
    }
    entries.push({ name, flags, method, crc, csize, usize, offset, nameBytes: rawName })
    p = end
  }

  const names = new Map()
  let total = 0
  const spans = []
  for (const e of entries) {
    const label = JSON.stringify(e.name)
    const bad = unsafePath(e.name)
    if (bad) { fail('unsafe-path', `Entry ${label} ${bad}; refusing it.`, e.name); continue }
    const folded = e.name.toLowerCase()
    if (names.has(folded)) {
      fail('duplicate', names.get(folded) === e.name ? `Entry ${label} appears more than once.` : `Entries ${JSON.stringify(names.get(folded))} and ${label} differ only in letter case.`, e.name)
      continue
    }
    names.set(folded, e.name)
    if (e.flags & FLAG_ENCRYPTED) { fail('encrypted', `Entry ${label} is encrypted; encrypted archives are not supported.`, e.name); continue }
    if (e.method !== 0) { fail('compressed', `Entry ${label} is compressed with ${METHODS[e.method] ?? `method ${e.method}`}; only stored (uncompressed) entries are supported. Re-create the archive without compression (for example \`zip -0\`).`, e.name); continue }
    if (e.csize === 0xffffffff || e.usize === 0xffffffff) { fail('zip64', `Entry ${label} needs ZIP64; not supported.`, e.name); continue }
    if (e.csize !== e.usize) { fail('bad-size', `Entry ${label} is stored but its sizes disagree (${e.csize} vs ${e.usize}).`, e.name); continue }
    total += e.usize
    if (total > limits.totalBytes) return fail('too-large', `The archive's contents exceed ${mb(limits.totalBytes)}.`)

    const o = e.offset
    if (o + 30 > cdStart || v.getUint32(o, true) !== SIG_LOCAL) { fail('bad-local', `Entry ${label}: no local header at offset ${o}.`, e.name); continue }
    const lFlags = v.getUint16(o + 6, true), lMethod = v.getUint16(o + 8, true)
    const lNameLen = v.getUint16(o + 26, true), lExtraLen = v.getUint16(o + 28, true)
    const lName = bytes.subarray(o + 30, o + 30 + lNameLen)
    if (lMethod !== e.method || (lFlags & FLAG_ENCRYPTED) !== (e.flags & FLAG_ENCRYPTED) || !sameBytes(lName, e.nameBytes)) {
      fail('inconsistent', `Entry ${label}: its local header disagrees with the central directory (name, method or flags).`, e.name)
      continue
    }
    if (!(lFlags & FLAG_DESCRIPTOR)) {
      const lCrc = v.getUint32(o + 14, true), lC = v.getUint32(o + 18, true), lU = v.getUint32(o + 22, true)
      if (lCrc !== e.crc || lC !== e.csize || lU !== e.usize) { fail('inconsistent', `Entry ${label}: its local header records a different CRC or size than the central directory.`, e.name); continue }
    }
    const start = o + 30 + lNameLen + lExtraLen
    if (start + e.usize > cdStart) { fail('truncated', `Entry ${label}: its data runs past the end of the file data (truncated archive).`, e.name); continue }
    spans.push([o, start + e.usize, e.name])
    if (e.name.endsWith('/')) {
      if (e.usize) fail('bad-size', `Directory entry ${label} has content.`, e.name)
      continue
    }
    const data = bytes.slice(start, start + e.usize)
    const got = crc32(data)
    if (got !== e.crc) { fail('crc', `Entry ${label}: CRC-32 mismatch (recorded ${hex(e.crc)}, computed ${hex(got)}); the file is damaged or was altered.`, e.name); continue }
    files.set(e.name, data)
  }
  spans.sort((a, b) => a[0] - b[0])
  for (let i = 1; i < spans.length; i++) {
    if (spans[i][0] < spans[i - 1][1]) fail('overlap', `Entries ${JSON.stringify(spans[i - 1][2])} and ${JSON.stringify(spans[i][2])} overlap in the archive.`, spans[i][2])
  }
}

const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
const mb = (n) => `${Math.round((n / 1024 / 1024) * 10) / 10} MB`
