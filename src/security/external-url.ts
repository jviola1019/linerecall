const APPROVED_EXTERNAL_HOSTS = new Set([
  'ada.gov',
  'creativecommons.org',
  'database.lichess.org',
  'github.com',
  'raw.githubusercontent.com',
  'sourceforge.net',
  'stockfishchess.org',
  'w3.org',
  'www.ada.gov',
  'www.w3.org',
])

/** Validates user-initiated reference links. It must never be used as a fetch allowlist. */
export function safeExternalReference(value: string): string {
  if (value.length > 2_048) throw new Error('External reference is too long')
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error('External reference contains a forbidden control character')
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('External reference contains malformed Unicode')
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error('External reference contains malformed Unicode')
    }
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('External reference is not a valid URL')
  }
  if (parsed.protocol !== 'https:') throw new Error('External references must use HTTPS')
  if (parsed.username || parsed.password) throw new Error('External references cannot contain credentials')
  if (parsed.port) throw new Error('External references cannot use a non-default port')
  if (!APPROVED_EXTERNAL_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error('External reference host is not approved')
  }
  return parsed.href
}
