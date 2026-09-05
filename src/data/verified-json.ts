interface VerifiedJsonRecord {
  readonly value: unknown
  consumed: boolean
}

const verifiedJsonRecords = new WeakMap<object, VerifiedJsonRecord>()

/**
 * Opaque, one-use capability proving that a value came directly from the
 * built-in JSON.parse operation. The parsed graph is retained only in a
 * module-private WeakMap: callers cannot inspect or mutate it before the one
 * synchronous validation pass consumes the capability.
 */
export interface VerifiedJsonParseResult {
  readonly kind: 'verified-json-parse-result'
}

/** Parse once and retain an unforgeable module-local runtime capability. */
export function parseVerifiedJson(text: string): VerifiedJsonParseResult {
  const value = JSON.parse(text) as unknown
  const result: VerifiedJsonParseResult = Object.freeze({
    kind: 'verified-json-parse-result',
  })
  verifiedJsonRecords.set(result, { value, consumed: false })
  return result
}

/**
 * Consume an authentic parse capability exactly once. JSON.parse establishes
 * plain objects, dense plain arrays, own data properties, and the absence of
 * accessors or prototype mutation throughout the graph. One-use consumption
 * prevents an intervening callback from changing those guarantees before a
 * later validator runs.
 */
function readVerifiedJson(result: VerifiedJsonParseResult): unknown {
  if (
    typeof result !== 'object'
    || result === null
    || Object.getPrototypeOf(result) !== Object.prototype
    || !Object.isFrozen(result)
  ) throw new TypeError('Expected an authentic verified JSON.parse result')
  const keys = Reflect.ownKeys(result)
  if (keys.length !== 1 || keys[0] !== 'kind') {
    throw new TypeError('Verified JSON.parse capability has an invalid shape')
  }
  const kindDescriptor = Object.getOwnPropertyDescriptor(result, 'kind')
  if (
    !kindDescriptor
    || !Object.hasOwn(kindDescriptor, 'value')
    || kindDescriptor.get
    || kindDescriptor.set
    || kindDescriptor.value !== 'verified-json-parse-result'
  ) throw new TypeError('Expected an authentic verified JSON.parse result')
  const record = verifiedJsonRecords.get(result)
  if (!record) throw new TypeError('Expected an authentic verified JSON.parse result')
  if (record.consumed) throw new TypeError('Verified JSON.parse result was already consumed')
  record.consumed = true
  return record.value
}

/** Run one synchronous validator without exposing an unvalidated graph. */
export function validateVerifiedJson<T>(
  result: VerifiedJsonParseResult,
  validate: (value: unknown) => T,
): T {
  return validate(readVerifiedJson(result))
}

/** Non-exposing identity probe used to prove an in-place validator did not clone. */
export function isVerifiedJsonValue(result: VerifiedJsonParseResult, value: unknown): boolean {
  const record = verifiedJsonRecords.get(result)
  return record?.consumed === true && record.value === value
}
