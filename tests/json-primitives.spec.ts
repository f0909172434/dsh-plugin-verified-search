import { describe, expect, it } from 'vitest'
import {
  decodeJsonInput,
  parseJsonPointer,
  parseStrictJson,
  requireIsoDate,
  requireSourceDate,
  type JsonPrimitiveFailureHandler,
  type JsonPrimitiveFailureKind,
} from '../src/json-primitives.js'

class PrimitiveFailure extends Error {
  constructor(
    readonly kind: JsonPrimitiveFailureKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'PrimitiveFailure'
  }
}

const fail: JsonPrimitiveFailureHandler = (kind, message, options) => {
  throw new PrimitiveFailure(kind, message, options)
}

function expectFailure(
  operation: () => unknown,
  kind: JsonPrimitiveFailureKind,
  message?: string,
): void {
  try {
    operation()
    throw new Error('expected operation to throw')
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(PrimitiveFailure)
    const failure = error as PrimitiveFailure
    expect(failure.kind).toBe(kind)
    if (message !== undefined) expect(failure.message).toBe(message)
  }
}

const pointerPolicy = { maxLength: 1_024, maxSegments: 32, fail }
const strictPolicy = { maxDepth: 64, fail }
const inputPolicy = { maxBytes: 64, maxBytesLabel: '64-byte', fail }

describe('shared strict JSON primitives', () => {
  it('parses bounded RFC 6901 pointers and rejects invalid escapes', () => {
    expect(parseJsonPointer('', 'pointer', pointerPolicy)).toEqual([])
    expect(parseJsonPointer('/catalog~1feed/~0rows/0', 'pointer', pointerPolicy)).toEqual([
      'catalog/feed',
      '~rows',
      '0',
    ])
    expectFailure(
      () => parseJsonPointer('/bad~2escape', 'pointer', pointerPolicy),
      'invalid_pointer',
      'pointer contains an invalid RFC 6901 escape',
    )
  })

  it('validates Gregorian dates and normalizes bounded UTC timestamps', () => {
    expect(requireIsoDate('2024-02-29', 'date', fail)).toBe('2024-02-29')
    expect(requireSourceDate('2026-08-14T23:59:59.123456789Z', 'date', fail)).toBe('2026-08-14')
    expectFailure(
      () => requireIsoDate('2026-02-29', 'date', fail),
      'invalid_iso_date',
      'date must be a valid ISO calendar date (YYYY-MM-DD)',
    )
    expectFailure(
      () => requireSourceDate('2026-08-14T24:00:00Z', 'date', fail),
      'invalid_iso_date',
      'date must be an ISO calendar date or UTC RFC 3339 timestamp',
    )
  })

  it('rejects duplicate keys, unpaired surrogates, and excess nesting before materialization', () => {
    expect(parseStrictJson('{"row":{"id":1}}', strictPolicy)).toEqual({ row: { id: 1 } })
    expectFailure(
      () => parseStrictJson('{"id":1,"id":2}', strictPolicy),
      'duplicate_key',
      'JSON object contains a duplicate key',
    )
    expectFailure(
      () => parseStrictJson('{"value":"\\ud800"}', strictPolicy),
      'invalid_unicode',
      'JSON strings must not contain unpaired UTF-16 surrogates',
    )
    expectFailure(
      () => parseStrictJson('[[[0]]]', { maxDepth: 2, fail }),
      'parse_limit_exceeded',
      'JSON nesting exceeds 2',
    )
  })

  it('decodes exact UTF-8 bytes and enforces the caller-provided byte boundary', () => {
    const bytes = new TextEncoder().encode('{"name":"測試"}')
    const decoded = decodeJsonInput(bytes, inputPolicy)
    expect(decoded.bytes).toBe(bytes)
    expect(decoded.text).toBe('{"name":"測試"}')

    expectFailure(
      () => decodeJsonInput(Uint8Array.of(0xc3, 0x28), inputPolicy),
      'invalid_utf8',
      'JSON input is not valid UTF-8',
    )
    expectFailure(
      () => decodeJsonInput('x'.repeat(65), inputPolicy),
      'input_too_large',
      'JSON input exceeds the 64-byte limit',
    )
  })
})
