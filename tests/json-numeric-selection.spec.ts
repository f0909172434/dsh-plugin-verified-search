import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  JSON_NUMERIC_SELECTION_MAX_LEXEME_BYTES,
  JSON_NUMERIC_SELECTION_MAX_NUMBER_TOKENS,
  JsonNumericSelectionError,
  selectJsonNumericTies,
  type JsonNumericSelectionRequest,
} from '../src/json-numeric-selection.js'
import {
  JSON_SELECTION_MAX_INPUT_BYTES,
  JSON_SELECTION_MAX_PROJECTED_SCALAR_BYTES,
  JSON_SELECTION_MAX_ROWS,
  JSON_SELECTION_MAX_TIES,
} from '../src/json-selection.js'

const request: JsonNumericSelectionRequest = {
  arrayPointer: '/rows',
  extreme: { pointer: '/value', direction: 'max', ties: 'all' },
  project: [
    { name: 'id', pointer: '/id' },
    { name: 'value', pointer: '/value' },
  ],
}

function expectCode(operation: () => unknown, code: string): void {
  try {
    operation()
    throw new Error('expected operation to throw')
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(JsonNumericSelectionError)
    expect((error as JsonNumericSelectionError).code).toBe(code)
  }
}

describe('bounded lossless JSON numeric extrema selection', () => {
  it('selects the exact USGS maximum and tags every numeric projection with its source lexeme', () => {
    const input = '{"type":"FeatureCollection","features":['
      + '{"id":"runner-up","properties":{"mag":6.3,"time":1786232607317,"updated":1786319498507,"place":"south of the Kermadec Islands","status":"reviewed"},"geometry":{"coordinates":[-179.1,-31.2,226.084]}},'
      + '{"id":"us6000tjl2","properties":{"mag":7.4,"time":1786365268125,"updated":1786678361963,"place":"5 km S of San José del Palmar, Colombia","status":"reviewed"},"geometry":{"coordinates":[-76.2422,4.8436,110.285]}}]}'
    const result = selectJsonNumericTies(input, {
      arrayPointer: '/features',
      where: [{ pointer: '/properties/status', equals: 'reviewed' }],
      extreme: { pointer: '/properties/mag', direction: 'max', ties: 'all' },
      project: [
        { name: 'id', pointer: '/id' },
        { name: 'magnitude', pointer: '/properties/mag' },
        { name: 'origin_ms', pointer: '/properties/time' },
        { name: 'updated_ms', pointer: '/properties/updated' },
        { name: 'place', pointer: '/properties/place' },
        { name: 'depth_km', pointer: '/geometry/coordinates/2' },
        { name: 'status', pointer: '/properties/status' },
      ],
    })

    expect(result).toEqual({
      complete: true,
      truncated: false,
      evidenceSha256: createHash('sha256').update(input).digest('hex'),
      arrayPointer: '/features',
      where: [{ pointer: '/properties/status', equals: 'reviewed' }],
      extreme: {
        pointer: '/properties/mag',
        direction: 'max',
        value: { jsonNumber: '7.4' },
        ties: 'all',
      },
      rowsScanned: 2,
      rowsEligible: 2,
      tieCount: 1,
      rows: [{
        sourceIndex: 1,
        values: {
          id: 'us6000tjl2',
          magnitude: { jsonNumber: '7.4' },
          origin_ms: { jsonNumber: '1786365268125' },
          updated_ms: { jsonNumber: '1786678361963' },
          place: '5 km S of San José del Palmar, Colombia',
          depth_km: { jsonNumber: '110.285' },
          status: 'reviewed',
        },
      }],
    })
  })

  it('does not collapse integers above Number.MAX_SAFE_INTEGER and retains equivalent exponent ties', () => {
    const result = selectJsonNumericTies(
      '{"rows":[{"id":"low","value":9007199254740992},{"id":"plain","value":9007199254740993},{"id":"exponent","value":9.007199254740993e15}]}',
      request,
    )
    expect(result.extreme.value).toEqual({ jsonNumber: '9007199254740993' })
    expect(result.tieCount).toBe(2)
    expect(result.rows).toEqual([
      { sourceIndex: 1, values: { id: 'plain', value: { jsonNumber: '9007199254740993' } } },
      { sourceIndex: 2, values: { id: 'exponent', value: { jsonNumber: '9.007199254740993e15' } } },
    ])
  })

  it('selects exact negative minima beyond the safe integer range', () => {
    const result = selectJsonNumericTies(
      '{"rows":[{"id":"a","value":-9007199254740992},{"id":"b","value":-9007199254740993},{"id":"c","value":-9.007199254740993e15}]}',
      { ...request, extreme: { pointer: '/value', direction: 'min', ties: 'all' } },
    )
    expect(result.extreme.value).toEqual({ jsonNumber: '-9007199254740993' })
    expect(result.rows.map(row => row.values.id)).toEqual(['b', 'c'])
  })

  it('compares arbitrary decimal exponents without expanding them', () => {
    const maximum = selectJsonNumericTies(
      '{"rows":[{"id":"a","value":9.99e999},{"id":"b","value":1e1000},{"id":"c","value":1e-1000},{"id":"d","value":9e-1001}]}',
      request,
    )
    expect(maximum.rows[0]?.values.id).toBe('b')

    const minimum = selectJsonNumericTies(
      '{"rows":[{"id":"a","value":-9.99e999},{"id":"b","value":-1e1000}]}',
      { ...request, extreme: { pointer: '/value', direction: 'min', ties: 'all' } },
    )
    expect(minimum.rows[0]?.values.id).toBe('b')
  })

  it('treats numerically equivalent decimal forms and signed zero as ties', () => {
    const ones = selectJsonNumericTies(
      '{"rows":[{"id":"a","value":1},{"id":"b","value":1.0},{"id":"c","value":10e-1},{"id":"d","value":0.1e1}]}',
      request,
    )
    expect(ones.tieCount).toBe(4)
    expect(ones.rows.map(row => (row.values.value as { jsonNumber: string }).jsonNumber))
      .toEqual(['1', '1.0', '10e-1', '0.1e1'])

    const zeroes = selectJsonNumericTies(
      '{"rows":[{"id":"a","value":-0},{"id":"b","value":0.0e999}]}',
      request,
    )
    expect(zeroes.tieCount).toBe(2)
  })

  it('applies strict non-numeric equality and optional ISO-date filters before extrema selection', () => {
    const result = selectJsonNumericTies(JSON.stringify({ rows: [
      { id: 'old', value: 10, date: '2026-08-13T12:00:00Z', reviewed: true },
      { id: 'future', value: 99, date: '2026-08-15', reviewed: true },
      { id: 'unreviewed', value: 50, date: '2026-08-14', reviewed: false },
    ] }), {
      ...request,
      filter: { pointer: '/date', lte: '2026-08-14' },
      where: [{ pointer: '/reviewed', equals: true }],
    })
    expect(result.filter).toEqual({ pointer: '/date', lte: '2026-08-14' })
    expect(result.rowsEligible).toBe(1)
    expect(result.rows[0]?.values.id).toBe('old')
  })

  it('rejects strings, booleans, and null instead of coercing numeric extrema', () => {
    for (const value of ['"7.4"', 'true', 'null']) {
      expectCode(
        () => selectJsonNumericTies(`{"rows":[{"id":"x","value":${value}}]}`, request),
        'JSON_NUMERIC_SELECTION_EXTREME_TYPE_MISMATCH',
      )
    }
  })

  it('rejects more than 256 final ties but not a provisional group replaced by a better value', () => {
    const tied = JSON.stringify({
      rows: Array.from({ length: JSON_SELECTION_MAX_TIES + 1 }, (_, id) => ({ id, value: 1 })),
    })
    expectCode(() => selectJsonNumericTies(tied, request), 'JSON_NUMERIC_SELECTION_TIE_LIMIT_EXCEEDED')

    const maximum = JSON.stringify({
      rows: [
        ...Array.from({ length: JSON_SELECTION_MAX_TIES + 1 }, (_, id) => ({ id, value: 1 })),
        { id: 'winner', value: 2 },
      ],
    })
    expect(selectJsonNumericTies(maximum, request).rows[0]?.values.id).toBe('winner')

    const minimum = JSON.stringify({
      rows: [
        ...Array.from({ length: JSON_SELECTION_MAX_TIES + 1 }, (_, id) => ({ id, value: 1 })),
        { id: 'winner', value: 0 },
      ],
    })
    expect(selectJsonNumericTies(minimum, {
      ...request,
      extreme: { pointer: '/value', direction: 'min', ties: 'all' },
    }).rows[0]?.values.id).toBe('winner')
  })

  it('bounds number-token and individual number-lexeme resources', () => {
    const tooManyNumbers = `{"padding":[${'0,'.repeat(JSON_NUMERIC_SELECTION_MAX_NUMBER_TOKENS)}0],"rows":[{"id":"x","value":1}]}`
    expect(Buffer.byteLength(tooManyNumbers, 'utf8')).toBeLessThan(JSON_SELECTION_MAX_INPUT_BYTES)
    expectCode(
      () => selectJsonNumericTies(tooManyNumbers, request),
      'JSON_NUMERIC_SELECTION_NUMBER_TOKEN_LIMIT_EXCEEDED',
    )

    const longNumber = `1${'0'.repeat(JSON_NUMERIC_SELECTION_MAX_LEXEME_BYTES)}`
    expectCode(
      () => selectJsonNumericTies(`{"rows":[{"id":"x","value":${longNumber}}]}`, request),
      'JSON_NUMERIC_SELECTION_NUMBER_LEXEME_LIMIT_EXCEEDED',
    )
  })

  it('preserves existing input, scalar, duplicate-key, depth, UTF-8, and Unicode bounds', () => {
    const oversizedInput = `{"padding":"${'x'.repeat(JSON_SELECTION_MAX_INPUT_BYTES)}","rows":[]}`
    expectCode(() => selectJsonNumericTies(oversizedInput, request), 'JSON_NUMERIC_SELECTION_INPUT_TOO_LARGE')

    const oversizedScalar = 'x'.repeat(JSON_SELECTION_MAX_PROJECTED_SCALAR_BYTES + 1)
    expectCode(() => selectJsonNumericTies(JSON.stringify({ rows: [{ id: oversizedScalar, value: 1 }] }), request),
      'JSON_NUMERIC_SELECTION_OUTPUT_TOO_LARGE')

    expectCode(() => selectJsonNumericTies('{"rows":[],"rows":[]}', request), 'JSON_NUMERIC_SELECTION_DUPLICATE_KEY')
    expectCode(() => selectJsonNumericTies(`${'['.repeat(70)}0${']'.repeat(70)}`, {
      ...request,
      arrayPointer: '',
    }), 'JSON_NUMERIC_SELECTION_PARSE_LIMIT_EXCEEDED')
    expectCode(() => selectJsonNumericTies(new Uint8Array([0xff]), request), 'JSON_NUMERIC_SELECTION_INVALID_UTF8')
    expectCode(() => selectJsonNumericTies('{"rows":[{"id":"\\ud800","value":1}]}', request),
      'JSON_NUMERIC_SELECTION_INVALID_UNICODE')
  })

  it('applies the 64-container depth limit equally to empty and populated arrays', () => {
    const atLimit = `${'['.repeat(63)}0${']'.repeat(63)}`
    const accepted = selectJsonNumericTies(
      `{"padding":${atLimit},"rows":[{"id":"x","value":1}]}`,
      request,
    )
    expect(accepted.tieCount).toBe(1)

    const beyondLimit = `${'['.repeat(64)}${']'.repeat(64)}`
    expectCode(() => selectJsonNumericTies(
      `{"padding":${beyondLimit},"rows":[{"id":"x","value":1}]}`,
      request,
    ), 'JSON_NUMERIC_SELECTION_PARSE_LIMIT_EXCEEDED')
  })

  it('enforces row and aggregate projection-construction limits', () => {
    const tooManyRows = JSON.stringify({
      rows: Array.from({ length: JSON_SELECTION_MAX_ROWS + 1 }, (_, value) => ({ id: String(value), value })),
    })
    expectCode(() => selectJsonNumericTies(tooManyRows, request), 'JSON_NUMERIC_SELECTION_ROW_LIMIT_EXCEEDED')

    const payload = 'x'.repeat(3_000)
    const oversizedProjection = JSON.stringify({
      rows: Array.from({ length: JSON_SELECTION_MAX_TIES }, (_, id) => ({
        id: String(id),
        value: 1,
        p0: payload,
        p1: payload,
        p2: payload,
        p3: payload,
        p4: payload,
        p5: payload,
        p6: payload,
      })),
    })
    expect(Buffer.byteLength(oversizedProjection, 'utf8')).toBeLessThan(JSON_SELECTION_MAX_INPUT_BYTES)
    expectCode(() => selectJsonNumericTies(oversizedProjection, {
      arrayPointer: '/rows',
      extreme: { pointer: '/value', direction: 'max', ties: 'all' },
      project: Array.from({ length: 7 }, (_, index) => ({ name: `p${index}`, pointer: `/p${index}` })),
    }), 'JSON_NUMERIC_SELECTION_OUTPUT_TOO_LARGE')
  })

  it('supports a root row array and fails closed for empty or malformed requests', () => {
    const result = selectJsonNumericTies('[{"id":"a","value":1},{"id":"b","value":2}]', {
      ...request,
      arrayPointer: '',
    })
    expect(result.rows[0]?.values.id).toBe('b')

    expectCode(() => selectJsonNumericTies('[]', { ...request, arrayPointer: '' }),
      'JSON_NUMERIC_SELECTION_NO_MATCH')
    expectCode(() => selectJsonNumericTies('{"rows":[]}', {
      ...request,
      extreme: { pointer: '/value', direction: 'max', ties: 'first' },
    } as unknown as JsonNumericSelectionRequest), 'JSON_NUMERIC_SELECTION_INVALID_REQUEST')
    expectCode(() => selectJsonNumericTies('{"rows":[{"value":01}]}', request),
      'JSON_NUMERIC_SELECTION_INVALID_JSON')
  })
})
