// SHA-256 through WebCrypto (browsers and Node 22) and base64 without Buffer.

const utf8 = new TextEncoder()
const asBytes = (data) => (typeof data === 'string' ? utf8.encode(data) : data)

const digest = async (data) => new Uint8Array(await crypto.subtle.digest('SHA-256', asBytes(data)))

/** Lower-case hex SHA-256 of a string (as UTF-8) or bytes. */
export async function sha256Hex(data) {
  return Array.from(await digest(data), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Base64 SHA-256, the form a Content-Security-Policy hash source takes. */
export const sha256Base64 = async (data) => base64(await digest(data))

/** Base64 of bytes or of a string's UTF-8. */
export function base64(data) {
  const bytes = asBytes(data)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/**
 * Hash of a source file as bundles record it: SHA-256 of its exact UTF-8
 * text. Use it to compute the `expectBaselineHash` of the board you have open.
 */
export const sourceHash = (source) => sha256Hex(source)
