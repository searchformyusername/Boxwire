import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, readZip, unsafePath, writeZip } from './zip.js'

const enc = new TextEncoder()
const dec = new TextDecoder()
const fixture = (f) => new Uint8Array(readFileSync(new URL(`./fixtures/${f}`, import.meta.url)))
const sample = () => writeZip([
  { name: 'a.txt', bytes: enc.encode('alpha\n') },
  { name: 'views/ünï.svg', bytes: enc.encode('<svg/>') },
  { name: 'empty', bytes: new Uint8Array(0) },
])
const codes = (r) => r.errors.map((e) => e.code)

/** Replace every occurrence of `from` with the same-length `to` (names appear in both headers). */
function replaceBytes(bytes, from, to) {
  const a = enc.encode(from), b = enc.encode(to)
  expect(b.length).toBe(a.length)
  const out = bytes.slice()
  let n = 0
  for (let i = 0; i + a.length <= out.length; i++) {
    if (a.every((x, k) => out[i + k] === x)) { out.set(b, i); n++ }
  }
  expect(n).toBeGreaterThan(0)
  return out
}

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926)
    expect(crc32(new Uint8Array(0))).toBe(0)
  })
})

describe('writeZip / readZip', () => {
  it('round-trips names (UTF-8, flag bit 11) and bytes', () => {
    const bytes = sample()
    const { files, errors } = readZip(bytes)
    expect(errors).toEqual([])
    expect([...files.keys()]).toEqual(['a.txt', 'views/ünï.svg', 'empty'])
    expect(dec.decode(files.get('views/ünï.svg'))).toBe('<svg/>')
    expect(files.get('empty').length).toBe(0)
    const v = new DataView(bytes.buffer)
    expect(v.getUint16(6, true) & 0x0800).toBe(0x0800)
    expect(v.getUint16(8, true)).toBe(0) // stored
  })

  it('is deterministic', () => {
    expect(sample()).toEqual(sample())
  })

  it('refuses unsafe and duplicate names when writing', () => {
    for (const name of ['../x', '/abs', 'a\\b', 'a//b', './a', 'C:/x', '']) expect(() => writeZip([{ name, bytes: new Uint8Array(1) }])).toThrow()
    expect(() => writeZip([{ name: 'a', bytes: new Uint8Array(0) }, { name: 'a', bytes: new Uint8Array(0) }])).toThrow(/Duplicate/)
  })

  it('reads stored archives made by Info-ZIP, with directory entries and extra fields', () => {
    const { files, errors } = readZip(fixture('stored.zip'))
    expect(errors).toEqual([])
    expect([...files.keys()]).toEqual(['hello.txt', 'dir/nested.txt'])
    expect(dec.decode(files.get('hello.txt'))).toBe('hello from zip\n')
    expect(dec.decode(files.get('dir/nested.txt'))).toContain('ünïcode')
  })

  it('reads stored entries written with a data descriptor (Python zipfile, streamed)', () => {
    const { files, errors } = readZip(fixture('descriptor.zip'))
    expect(errors).toEqual([])
    expect(dec.decode(files.get('stream/ünï.txt'))).toBe('streamed with a data descriptor\n')
  })

  it('refuses deflated entries with a clear message', () => {
    const r = readZip(fixture('deflated.zip'))
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toMatchObject({ code: 'compressed', file: 'dir/nested.txt' })
    expect(r.errors[0].message).toMatch(/compressed with deflate; only stored \(uncompressed\) entries are supported/)
    expect(r.files.has('dir/nested.txt')).toBe(false)
  })

  it('names the file whose CRC-32 no longer matches', () => {
    const bytes = sample()
    const at = bytes.indexOf('a'.charCodeAt(0), 30 + 'a.txt'.length) // first data byte of a.txt
    bytes[at] ^= 0xff
    const r = readZip(bytes)
    expect(r.errors).toEqual([expect.objectContaining({ code: 'crc', file: 'a.txt' })])
    expect(r.errors[0].message).toMatch(/CRC-32 mismatch/)
  })

  it('refuses truncated archives', () => {
    const bytes = sample()
    for (const cut of [bytes.length - 1, bytes.length - 30, Math.floor(bytes.length / 2), 10, 0]) {
      const r = readZip(bytes.slice(0, cut))
      expect(r.errors.length, `cut at ${cut}`).toBeGreaterThan(0)
      expect(r.files.size).toBe(0)
    }
    expect(codes(readZip(bytes.slice(0, bytes.length - 1)))).toEqual(['no-eocd'])
  })

  it('refuses path traversal, absolute paths and backslashes', () => {
    const make = () => writeZip([{ name: 'aa/evil.txt', bytes: enc.encode('x') }])
    for (const bad of ['../evil.txt', '/a/evil.txt', 'aa\\evil.txt']) {
      const r = readZip(replaceBytes(make(), 'aa/evil.txt', bad))
      expect(codes(r), bad).toEqual(['unsafe-path'])
      expect(r.errors[0].message).toContain(JSON.stringify(bad))
      expect(r.files.size).toBe(0)
    }
  })

  it('refuses duplicate and case-colliding names', () => {
    const two = writeZip([{ name: 'a.txt', bytes: enc.encode('1') }, { name: 'b.txt', bytes: enc.encode('2') }])
    expect(codes(readZip(replaceBytes(two, 'b.txt', 'a.txt')))).toEqual(['duplicate'])
    expect(readZip(replaceBytes(two, 'b.txt', 'A.txt')).errors[0].message).toMatch(/differ only in letter case/)
  })

  it('enforces entry-count and size limits', () => {
    expect(codes(readZip(sample(), { limits: { totalBytes: 1e6, entries: 2 } }))).toEqual(['too-many'])
    expect(codes(readZip(sample(), { limits: { totalBytes: 8, entries: 500 } }))).toEqual(['too-large'])
  })

  it('detects a local header that disagrees with the central directory', () => {
    const bytes = sample()
    new DataView(bytes.buffer).setUint32(14, 0x12345678, true) // local CRC of the first entry
    expect(readZip(bytes).errors[0]).toMatchObject({ code: 'inconsistent', file: 'a.txt' })
  })

  it('never throws on garbage or damaged input', () => {
    expect(codes(readZip('not bytes'))).toEqual(['malformed'])
    expect(codes(readZip(new Uint8Array(100)))).toEqual(['no-eocd'])
    const base = sample()
    let seed = 7
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
    for (let k = 0; k < 500; k++) {
      const b = base.slice()
      for (let j = 0; j < 3; j++) b[Math.floor(rand() * b.length)] = Math.floor(rand() * 256)
      expect(() => readZip(b)).not.toThrow()
    }
  })

  it.skipIf(!existsSync('/usr/bin/unzip'))('produces archives Info-ZIP verifies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bw-zip-'))
    try {
      writeFileSync(join(dir, 't.zip'), sample())
      expect(execFileSync('/usr/bin/unzip', ['-t', join(dir, 't.zip')]).toString()).toMatch(/No errors detected/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('unsafePath', () => {
  it('accepts plain relative paths and directory entries', () => {
    expect(unsafePath('views/baseline.svg')).toBeNull()
    expect(unsafePath('views/')).toBeNull()
    expect(unsafePath('a/../b')).toMatch(/\.\./)
  })
})
