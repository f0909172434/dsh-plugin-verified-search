import {
  scanStrictJson,
  type JsonPrimitiveFailureKind,
} from './json-primitives.js'

const JSON_NUMBER = /^(-)?(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?)(\d+))?$/u

export const losslessJsonNumberBrand: unique symbol = Symbol('lossless-json-number')

interface NormalizedNumber {
  readonly sign: -1 | 0 | 1
  /** Significant decimal digits without leading or trailing zeroes. */
  readonly digits: string
  /** The exact value is sign * digits * 10^scale. */
  readonly scale: bigint
}

export interface LosslessJsonNumber {
  readonly [losslessJsonNumberBrand]: true
  readonly lexeme: string
  readonly normalized: NormalizedNumber
}

export type LosslessJsonFailureKind =
  | JsonPrimitiveFailureKind
  | 'number_token_limit_exceeded'
  | 'number_lexeme_limit_exceeded'
  | 'lossless_parse_unavailable'

export type LosslessJsonFailureHandler = (
  kind: LosslessJsonFailureKind,
  message: string,
  options?: ErrorOptions,
) => never

export interface LosslessJsonPolicy {
  readonly maxDepth: number
  readonly maxNumberTokens: number
  readonly maxLexemeBytes: number
  readonly fail: LosslessJsonFailureHandler
  readonly isFailure: (error: unknown) => boolean
}

type JsonParseWithSource = (
  text: string,
  reviver: (this: unknown, key: string, value: unknown, context?: { readonly source?: unknown }) => unknown,
) => unknown

function parseExponent(sign: string | undefined, digits: string | undefined): bigint {
  if (digits === undefined) return 0n
  const value = BigInt(digits)
  return sign === '-' ? -value : value
}

function normalizeNumber(
  lexeme: string,
  fail: LosslessJsonFailureHandler,
): NormalizedNumber {
  const match = JSON_NUMBER.exec(lexeme)
  if (match === null) {
    fail('invalid_json', 'lossless parser returned an invalid JSON number token')
  }
  const fraction = match[3] ?? ''
  const combined = `${match[2]}${fraction}`
  const withoutLeading = combined.replace(/^0+/u, '')
  if (withoutLeading === '') return { sign: 0, digits: '0', scale: 0n }

  let trailingZeroes = 0
  for (let index = withoutLeading.length - 1; index >= 0 && withoutLeading[index] === '0'; index--) {
    trailingZeroes++
  }
  const digits = trailingZeroes === 0 ? withoutLeading : withoutLeading.slice(0, -trailingZeroes)
  const scale = parseExponent(match[4], match[5]) - BigInt(fraction.length) + BigInt(trailingZeroes)
  return { sign: match[1] === '-' ? -1 : 1, digits, scale }
}

function createLosslessNumber(
  lexeme: string,
  policy: LosslessJsonPolicy,
): LosslessJsonNumber {
  if (Buffer.byteLength(lexeme, 'utf8') > policy.maxLexemeBytes) {
    policy.fail(
      'number_lexeme_limit_exceeded',
      `JSON number token exceeds the ${policy.maxLexemeBytes}-byte limit`,
    )
  }
  return Object.freeze({
    [losslessJsonNumberBrand]: true as const,
    lexeme,
    normalized: normalizeNumber(lexeme, policy.fail),
  })
}

export function isLosslessJsonNumber(value: unknown): value is LosslessJsonNumber {
  return typeof value === 'object'
    && value !== null
    && (value as Partial<LosslessJsonNumber>)[losslessJsonNumberBrand] === true
}

export function parseLosslessStrictJson(
  text: string,
  policy: LosslessJsonPolicy,
): unknown {
  scanStrictJson(text, { maxDepth: policy.maxDepth, fail: policy.fail })
  let numberTokens = 0
  try {
    return (JSON.parse as JsonParseWithSource)(text, (_key, value, context) => {
      if (typeof value !== 'number') return value
      numberTokens++
      if (numberTokens > policy.maxNumberTokens) {
        policy.fail(
          'number_token_limit_exceeded',
          `JSON contains more than ${policy.maxNumberTokens} number tokens`,
        )
      }
      if (typeof context?.source !== 'string') {
        policy.fail(
          'lossless_parse_unavailable',
          'runtime did not expose the exact JSON number token',
        )
      }
      return createLosslessNumber(context.source, policy)
    })
  } catch (error: unknown) {
    if (policy.isFailure(error)) throw error
    policy.fail('invalid_json', 'JSON input is invalid', { cause: error })
  }
}

function compareMagnitude(left: NormalizedNumber, right: NormalizedNumber): -1 | 0 | 1 {
  const leftOrder = left.scale + BigInt(left.digits.length)
  const rightOrder = right.scale + BigInt(right.digits.length)
  if (leftOrder !== rightOrder) return leftOrder < rightOrder ? -1 : 1
  const length = Math.max(left.digits.length, right.digits.length)
  for (let index = 0; index < length; index++) {
    const leftDigit = index < left.digits.length ? left.digits.charCodeAt(index) : 48
    const rightDigit = index < right.digits.length ? right.digits.charCodeAt(index) : 48
    if (leftDigit !== rightDigit) return leftDigit < rightDigit ? -1 : 1
  }
  return 0
}

export function compareLosslessJsonNumbers(
  left: LosslessJsonNumber,
  right: LosslessJsonNumber,
): -1 | 0 | 1 {
  if (left.normalized.sign !== right.normalized.sign) {
    return left.normalized.sign < right.normalized.sign ? -1 : 1
  }
  if (left.normalized.sign === 0) return 0
  const magnitude = compareMagnitude(left.normalized, right.normalized)
  return left.normalized.sign === -1
    ? (magnitude === 0 ? 0 : magnitude === 1 ? -1 : 1)
    : magnitude
}
