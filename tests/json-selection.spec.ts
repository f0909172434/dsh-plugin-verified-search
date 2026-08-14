import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  JSON_SELECTION_MAX_INPUT_BYTES,
  JSON_SELECTION_MAX_PROJECTED_SCALAR_BYTES,
  JSON_SELECTION_MAX_ROWS,
  JSON_SELECTION_MAX_TIES,
  JsonSelectionError,
  selectJsonMaxTies,
  type JsonSelectionRequest,
} from '../src/json-selection.js'

const request: JsonSelectionRequest = {
  arrayPointer: '/vulnerabilities',
  filter: { pointer: '/dateAdded', lte: '2026-08-14' },
  max: { pointer: '/dateAdded' },
  project: [
    { name: 'cve_id', pointer: '/cveID' },
    { name: 'date_added', pointer: '/dateAdded' },
    { name: 'vendor', pointer: '/vendorProject' },
  ],
}

function expectCode(operation: () => unknown, code: string): void {
  try {
    operation()
    throw new Error('expected operation to throw')
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(JsonSelectionError)
    expect((error as JsonSelectionError).code).toBe(code)
  }
}

describe('bounded strict JSON max-tie selection', () => {
  it('filters at an ISO-date cutoff, retains every maximum tie, projects scalars, and hashes exact evidence', () => {
    const input = JSON.stringify({
      title: 'CISA Known Exploited Vulnerabilities Catalog',
      vulnerabilities: [
        { cveID: 'CVE-OLD', dateAdded: '2026-08-12', vendorProject: 'Old vendor', ignored: { nested: true } },
        { cveID: 'CVE-B', dateAdded: '2026-08-13', vendorProject: 'Vendor B', ignored: ['not projected'] },
        { cveID: 'CVE-FUTURE', dateAdded: '2026-08-15', vendorProject: 'Future vendor' },
        { cveID: 'CVE-A', dateAdded: '2026-08-13', vendorProject: 'Vendor A' },
      ],
    })

    expect(selectJsonMaxTies(input, request)).toEqual({
      complete: true,
      truncated: false,
      evidenceSha256: createHash('sha256').update(input).digest('hex'),
      arrayPointer: '/vulnerabilities',
      filter: { pointer: '/dateAdded', lte: '2026-08-14' },
      max: { pointer: '/dateAdded', value: '2026-08-13', ties: 'all' },
      rowsScanned: 4,
      rowsEligible: 3,
      tieCount: 2,
      rows: [
        { sourceIndex: 1, values: { cve_id: 'CVE-B', date_added: '2026-08-13', vendor: 'Vendor B' } },
        { sourceIndex: 3, values: { cve_id: 'CVE-A', date_added: '2026-08-13', vendor: 'Vendor A' } },
      ],
    })
  })

  it('implements RFC 6901 escapes and array indexes without wildcard semantics', () => {
    const input = JSON.stringify({
      'catalog/feed': {
        '~rows': [{ date: '2026-08-14', nested: { 'a/b': 'slash', '~key': true }, values: [null, 7] }],
      },
    })
    const result = selectJsonMaxTies(input, {
      arrayPointer: '/catalog~1feed/~0rows',
      filter: { pointer: '/date', lte: '2026-08-14' },
      max: { pointer: '/date' },
      project: [
        { name: 'slash', pointer: '/nested/a~1b' },
        { name: 'tilde', pointer: '/nested/~0key' },
        { name: 'number', pointer: '/values/1' },
        { name: 'nothing', pointer: '/values/0' },
      ],
    })

    expect(result.rows).toEqual([{
      sourceIndex: 0,
      values: { slash: 'slash', tilde: true, number: 7, nothing: null },
    }])
    expectCode(() => selectJsonMaxTies(input, { ...request, arrayPointer: '/catalog~2feed' }), 'JSON_SELECTION_INVALID_POINTER')
  })

  it('supports a bounded root array when arrayPointer is empty', () => {
    const input = JSON.stringify([
      { version: 'v26.6.0', date: '2026-07-22' },
      { version: 'v26.7.0', date: '2026-08-05' },
      { version: 'v27.0.0', date: '2026-10-01' },
    ])
    const result = selectJsonMaxTies(input, {
      arrayPointer: '',
      filter: { pointer: '/date', lte: '2026-08-14' },
      max: { pointer: '/date' },
      project: [
        { name: 'version', pointer: '/version' },
        { name: 'date', pointer: '/date' },
      ],
    })
    expect(result.max.value).toBe('2026-08-05')
    expect(result.rows).toEqual([{ sourceIndex: 1, values: { version: 'v26.7.0', date: '2026-08-05' } }])
  })

  it('normalizes UTC RFC 3339 source timestamps to calendar days', () => {
    const result = selectJsonMaxTies(JSON.stringify([
      { name: 'Python 3.14.6', release_date: '2026-07-01T12:00:00Z' },
      { name: 'Python 3.14.7', release_date: '2026-08-05T09:30:00.123Z' },
      { name: 'future', release_date: '2026-08-15T00:00:00Z' },
    ]), {
      arrayPointer: '',
      filter: { pointer: '/release_date', lte: '2026-08-14' },
      max: { pointer: '/release_date' },
      project: [
        { name: 'name', pointer: '/name' },
        { name: 'release_date', pointer: '/release_date' },
      ],
    })
    expect(result.max.value).toBe('2026-08-05')
    expect(result.rows[0]?.values).toEqual({
      name: 'Python 3.14.7',
      release_date: '2026-08-05T09:30:00.123Z',
    })
  })

  it('applies strict scalar equality filters before date selection', () => {
    const result = selectJsonMaxTies(JSON.stringify([
      { name: 'Python 3.12.14', release_date: '2026-08-12T15:23:33Z', is_latest: false },
      { name: 'Python 3.14.7', release_date: '2026-08-05T12:40:32Z', is_latest: true },
      { name: 'Python 3.15.0rc1', release_date: '2026-08-10T00:00:00Z', is_latest: false },
    ]), {
      arrayPointer: '',
      where: [{ pointer: '/is_latest', equals: true }],
      filter: { pointer: '/release_date', lte: '2026-08-14' },
      max: { pointer: '/release_date' },
      project: [{ name: 'name', pointer: '/name' }],
    })
    expect(result.where).toEqual([{ pointer: '/is_latest', equals: true }])
    expect(result.rows).toEqual([{ sourceIndex: 1, values: { name: 'Python 3.14.7' } }])
  })

  it('rejects ambiguous or non-object JSON instead of silently coercing it', () => {
    expectCode(() => selectJsonMaxTies('{"vulnerabilities":[],"vulnerabilities":[]}', request), 'JSON_SELECTION_DUPLICATE_KEY')
    expectCode(() => selectJsonMaxTies('[]', { ...request, arrayPointer: '' }), 'JSON_SELECTION_NO_MATCH')
    expectCode(() => selectJsonMaxTies('{"vulnerabilities":[null]}', request), 'JSON_SELECTION_ROW_TYPE_MISMATCH')
    expectCode(() => selectJsonMaxTies('{"vulnerabilities":{}}', request), 'JSON_SELECTION_ARRAY_TYPE_MISMATCH')
    expectCode(() => selectJsonMaxTies('{"vulnerabilities":[]}', { ...request, arrayPointer: '/missing' }), 'JSON_SELECTION_POINTER_NOT_FOUND')
    expectCode(() => selectJsonMaxTies('{"vulnerabilities":[{"dateAdded":"2026-08-14","nested":{}}]}', {
      ...request,
      project: [{ name: 'nested', pointer: '/nested' }],
    }), 'JSON_SELECTION_NON_SCALAR_PROJECTION')
  })

  it('bounds duplicate-key errors without echoing attacker-controlled keys', () => {
    const key = 'x'.repeat(1_000_000)
    try {
      selectJsonMaxTies(`{"${key}":1,"${key}":2}`, request)
      throw new Error('expected operation to throw')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(JsonSelectionError)
      const selectionError = error as JsonSelectionError
      expect(selectionError.code).toBe('JSON_SELECTION_DUPLICATE_KEY')
      expect(selectionError.message).toBe('JSON object contains a duplicate key')
      expect(selectionError.message.length).toBeLessThan(128)
      expect(selectionError.message).not.toContain(key.slice(0, 100))
    }
  })

  it('rejects projection aliases and oversized scalars before output amplification', () => {
    const largeScalar = 'x'.repeat(JSON_SELECTION_MAX_PROJECTED_SCALAR_BYTES + 1)
    const input = JSON.stringify({
      vulnerabilities: [{ dateAdded: '2026-08-14', payload: largeScalar }],
    })
    expectCode(() => selectJsonMaxTies(input, {
      ...request,
      project: Array.from({ length: 32 }, (_, index) => ({
        name: `alias_${index}`,
        pointer: '/payload',
      })),
    }), 'JSON_SELECTION_INVALID_REQUEST')
    expectCode(() => selectJsonMaxTies(input, {
      ...request,
      project: [{ name: 'payload', pointer: '/payload' }],
    }), 'JSON_SELECTION_OUTPUT_TOO_LARGE')
  })

  it('validates real Gregorian dates for the cutoff, filter, and maximum key', () => {
    expectCode(() => selectJsonMaxTies('{"vulnerabilities":[]}', {
      ...request,
      filter: { ...request.filter, lte: '2026-02-29' },
    }), 'JSON_SELECTION_INVALID_ISO_DATE')
    expectCode(() => selectJsonMaxTies('{"vulnerabilities":[{"dateAdded":"2026-02-29"}]}', {
      ...request,
      filter: { pointer: '/dateAdded', lte: '2026-12-31' },
      project: [{ name: 'date', pointer: '/dateAdded' }],
    }), 'JSON_SELECTION_INVALID_ISO_DATE')

    const leap = selectJsonMaxTies('{"vulnerabilities":[{"dateAdded":"2024-02-29","id":"leap"}]}', {
      ...request,
      filter: { pointer: '/dateAdded', lte: '2024-12-31' },
      project: [{ name: 'id', pointer: '/id' }],
    })
    expect(leap.max.value).toBe('2024-02-29')
  })

  it('validates RFC 3339 UTC time fields without Date.parse rollover', () => {
    for (const releaseDate of [
      '2026-08-14T24:00:00Z',
      '2026-08-14T23:60:00Z',
      '2026-08-14T23:59:60Z',
    ]) {
      expectCode(() => selectJsonMaxTies(JSON.stringify([{ releaseDate }]), {
        arrayPointer: '',
        filter: { pointer: '/releaseDate', lte: '2026-08-14' },
        max: { pointer: '/releaseDate' },
        project: [{ name: 'release_date', pointer: '/releaseDate' }],
      }), 'JSON_SELECTION_INVALID_ISO_DATE')
    }

    const boundary = selectJsonMaxTies('[{"releaseDate":"2026-08-14T23:59:59.999999999Z"}]', {
      arrayPointer: '',
      filter: { pointer: '/releaseDate', lte: '2026-08-14' },
      max: { pointer: '/releaseDate' },
      project: [{ name: 'release_date', pointer: '/releaseDate' }],
    })
    expect(boundary.max.value).toBe('2026-08-14')
  })

  it('fails closed for an empty eligible set, missing fields, and malformed requests', () => {
    expectCode(() => selectJsonMaxTies('{"vulnerabilities":[]}', request), 'JSON_SELECTION_NO_MATCH')
    expectCode(() => selectJsonMaxTies('{"vulnerabilities":[{"cveID":"missing date"}]}', request), 'JSON_SELECTION_POINTER_NOT_FOUND')
    expectCode(() => selectJsonMaxTies('{"vulnerabilities":[]}', {
      ...request,
      project: [{ name: '__proto__', pointer: '/cveID' }],
    }), 'JSON_SELECTION_INVALID_REQUEST')
    expectCode(() => selectJsonMaxTies('{"vulnerabilities":[]}', {
      ...request,
      unexpected: true,
    } as JsonSelectionRequest), 'JSON_SELECTION_INVALID_REQUEST')
  })

  it('enforces the 8 MiB input and 25,000-row bounds before selection', () => {
    const oversized = `{"padding":"${'x'.repeat(JSON_SELECTION_MAX_INPUT_BYTES)}","vulnerabilities":[]}`
    expectCode(() => selectJsonMaxTies(oversized, request), 'JSON_SELECTION_INPUT_TOO_LARGE')

    const tooManyRows = JSON.stringify({
      vulnerabilities: Array.from({ length: JSON_SELECTION_MAX_ROWS + 1 }, () => ({ dateAdded: '2026-08-14' })),
    })
    expectCode(() => selectJsonMaxTies(tooManyRows, {
      ...request,
      project: [{ name: 'date', pointer: '/dateAdded' }],
    }), 'JSON_SELECTION_ROW_LIMIT_EXCEEDED')
  })

  it('rejects deeply nested JSON before JSON.parse materializes it', () => {
    const depth = 500_000
    const deeplyNested = `${'['.repeat(depth)}0${']'.repeat(depth)}`
    expect(Buffer.byteLength(deeplyNested, 'utf8')).toBeLessThan(2 * 1024 * 1024)
    const parse = vi.spyOn(JSON, 'parse')
    try {
      expectCode(() => selectJsonMaxTies(deeplyNested, { ...request, arrayPointer: '' }), 'JSON_SELECTION_PARSE_LIMIT_EXCEEDED')
      expect(parse).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
  })

  it('rejects more than 256 final maximum ties without returning a partial result', () => {
    const input = JSON.stringify({
      vulnerabilities: Array.from({ length: JSON_SELECTION_MAX_TIES + 1 }, (_, index) => ({
        dateAdded: '2026-08-14',
        id: index,
      })),
    })
    expectCode(() => selectJsonMaxTies(input, {
      ...request,
      project: [{ name: 'id', pointer: '/id' }],
    }), 'JSON_SELECTION_TIE_LIMIT_EXCEEDED')
  })

  it('does not fail on an oversized provisional tie group that a later greater date replaces', () => {
    const input = JSON.stringify({
      vulnerabilities: [
        ...Array.from({ length: JSON_SELECTION_MAX_TIES + 1 }, (_, index) => ({ dateAdded: '2026-08-13', id: index })),
        { dateAdded: '2026-08-14', id: 'winner' },
      ],
    })
    const result = selectJsonMaxTies(input, {
      ...request,
      project: [{ name: 'id', pointer: '/id' }],
    })
    expect(result.tieCount).toBe(1)
    expect(result.rows).toEqual([{ sourceIndex: JSON_SELECTION_MAX_TIES + 1, values: { id: 'winner' } }])
  })

  it('rejects invalid UTF-8 bytes and escaped unpaired surrogates', () => {
    expectCode(() => selectJsonMaxTies(new Uint8Array([0xff]), request), 'JSON_SELECTION_INVALID_UTF8')
    expectCode(() => selectJsonMaxTies('{"vulnerabilities":[{"dateAdded":"2026-08-14","id":"\\ud800"}]}', {
      ...request,
      project: [{ name: 'id', pointer: '/id' }],
    }), 'JSON_SELECTION_INVALID_UNICODE')
  })
})
