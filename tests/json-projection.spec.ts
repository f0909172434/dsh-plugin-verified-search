import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  JSON_PROJECTION_MAX_TOTAL_NESTED_ROWS,
  JsonProjectionError,
  projectJsonRows,
  type JsonProjectionRequest,
} from '../src/json-projection.js'
import {
  JSON_SELECTION_MAX_INPUT_BYTES,
  JSON_SELECTION_MAX_PROJECTED_SCALAR_BYTES,
  JSON_SELECTION_MAX_ROWS,
} from '../src/json-selection.js'

const goRequest: JsonProjectionRequest = {
  arrayPointer: '',
  where: [{ pointer: '/stable', equals: true }],
  project: [{ name: 'version', pointer: '/version' }],
  nested: {
    arrayPointer: '/files',
    where: [
      { pointer: '/kind', equals: 'archive' },
      { pointer: '/os', equals: 'windows' },
      { pointer: '/arch', equals: 'amd64' },
    ],
    project: [
      { name: 'filename', pointer: '/filename' },
      { name: 'sha256', pointer: '/sha256' },
    ],
  },
}

function expectCode(operation: () => unknown, code: string): void {
  try {
    operation()
    throw new Error('expected operation to throw')
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(JsonProjectionError)
    expect((error as JsonProjectionError).code).toBe(code)
  }
}

describe('bounded strict JSON row projection', () => {
  it('projects all Go download matches and nested matches in source order without ranking', () => {
    const input = JSON.stringify([
      {
        version: 'go1.25.2',
        stable: true,
        files: [
          { filename: 'go1.25.2.windows-amd64.zip', os: 'windows', arch: 'amd64', kind: 'archive', sha256: 'a', size: 73 },
          { filename: 'go1.25.2.linux-amd64.tar.gz', os: 'linux', arch: 'amd64', kind: 'archive', sha256: 'b', size: 64 },
          { filename: 'go1.25.2.windows-amd64-alt.zip', os: 'windows', arch: 'amd64', kind: 'archive', sha256: 'c', size: 74 },
        ],
      },
      {
        version: 'go1.26rc1',
        stable: false,
        files: [{ filename: 'rc.zip', os: 'windows', arch: 'amd64', kind: 'archive', sha256: 'rc', size: 70 }],
      },
      {
        version: 'go1.24.8',
        stable: true,
        files: [
          { filename: 'source.tar.gz', os: '', arch: '', kind: 'source', sha256: 'src', size: 30 },
          { filename: 'go1.24.8.windows-amd64.zip', os: 'windows', arch: 'amd64', kind: 'archive', sha256: 'd', size: 72 },
        ],
      },
    ])

    const result = projectJsonRows(input, goRequest)
    expect(result).toMatchObject({
      complete: true,
      truncated: false,
      evidenceSha256: createHash('sha256').update(input).digest('hex'),
      arrayPointer: '',
      where: [{ pointer: '/stable', equals: true }],
      rowCount: 3,
      matchCount: 2,
      rows: [
        {
          sourceIndex: 0,
          values: { version: 'go1.25.2' },
          nested: {
            arrayPointer: '/files',
            where: [
              { pointer: '/kind', equals: 'archive' },
              { pointer: '/os', equals: 'windows' },
              { pointer: '/arch', equals: 'amd64' },
            ],
            rowCount: 3,
            matchCount: 2,
            rows: [
              { sourceIndex: 0, values: { filename: 'go1.25.2.windows-amd64.zip', sha256: 'a' } },
              { sourceIndex: 2, values: { filename: 'go1.25.2.windows-amd64-alt.zip', sha256: 'c' } },
            ],
          },
        },
        {
          sourceIndex: 2,
          values: { version: 'go1.24.8' },
          nested: {
            arrayPointer: '/files',
            where: [
              { pointer: '/kind', equals: 'archive' },
              { pointer: '/os', equals: 'windows' },
              { pointer: '/arch', equals: 'amd64' },
            ],
            rowCount: 2,
            matchCount: 1,
            rows: [
              { sourceIndex: 1, values: { filename: 'go1.24.8.windows-amd64.zip', sha256: 'd' } },
            ],
          },
        },
      ],
    })
    expect(result.pointerAudits).toEqual({
      array: { requestedPointer: '', effectivePointer: '', repairs: [] },
      where: [{ requestedPointer: '/stable', effectivePointer: '/stable', repairs: [] }],
      project: [{ name: 'version', requestedPointer: '/version', effectivePointer: '/version', repairs: [] }],
      nested: {
        array: { requestedPointer: '/files', effectivePointer: '/files', repairs: [] },
        where: [
          { requestedPointer: '/kind', effectivePointer: '/kind', repairs: [] },
          { requestedPointer: '/os', effectivePointer: '/os', repairs: [] },
          { requestedPointer: '/arch', effectivePointer: '/arch', repairs: [] },
        ],
        project: [
          { name: 'filename', requestedPointer: '/filename', effectivePointer: '/filename', repairs: [] },
          { name: 'sha256', requestedPointer: '/sha256', effectivePointer: '/sha256', repairs: [] },
        ],
      },
    })
  })

  it('returns a complete empty match set instead of inventing or selecting a nearest row', () => {
    const result = projectJsonRows('[{"name":"alpha","stable":false}]', {
      arrayPointer: '',
      where: [{ pointer: '/stable', equals: true }],
      project: [{ name: 'name', pointer: '/name' }],
    })
    expect(result).toMatchObject({ complete: true, truncated: false, rowCount: 1, matchCount: 0, rows: [] })
  })

  it('repairs the observed root-array and unique ASCII key-case mistakes with an audit trail', () => {
    const result = projectJsonRows(JSON.stringify([{
      version: 'go1.26.6',
      stable: true,
      files: [{ filename: 'go1.26.6.linux-amd64.tar.gz', os: 'linux', arch: 'amd64', kind: 'archive', sha256: 'abc' }],
    }]), {
      arrayPointer: '/Version',
      where: [{ pointer: '/Stable', equals: true }],
      project: [{ name: 'version', pointer: '/Version' }],
      nested: {
        arrayPointer: '/Files',
        where: [
          { pointer: '/OS', equals: 'linux' },
          { pointer: '/Arch', equals: 'amd64' },
          { pointer: '/Kind', equals: 'archive' },
        ],
        project: [
          { name: 'filename', pointer: '/Filename' },
          { name: 'sha256', pointer: '/SHA256' },
        ],
      },
    })

    expect(result.rows).toEqual([{
      sourceIndex: 0,
      values: { version: 'go1.26.6' },
      nested: {
        arrayPointer: '/Files',
        where: [
          { pointer: '/OS', equals: 'linux' },
          { pointer: '/Arch', equals: 'amd64' },
          { pointer: '/Kind', equals: 'archive' },
        ],
        rowCount: 1,
        matchCount: 1,
        rows: [{ sourceIndex: 0, values: { filename: 'go1.26.6.linux-amd64.tar.gz', sha256: 'abc' } }],
      },
    }])
    expect(result.pointerAudits.array).toEqual({
      requestedPointer: '/Version',
      effectivePointer: '',
      repairs: [{ kind: 'root_array_fallback' }],
    })
    expect(result.pointerAudits.where[0]).toMatchObject({
      requestedPointer: '/Stable',
      effectivePointer: '/stable',
      repairs: [{ kind: 'ascii_case', segmentIndex: 0, requestedSegment: 'Stable', effectiveSegment: 'stable' }],
    })
    expect(result.pointerAudits.nested?.array).toMatchObject({
      requestedPointer: '/Files',
      effectivePointer: '/files',
    })
  })

  it('fails closed on ambiguous or cross-row inconsistent case repairs', () => {
    expect(() => projectJsonRows('[{"Name":"a","name":"b"}]', {
      arrayPointer: '',
      project: [{ name: 'value', pointer: '/NAME' }],
    })).toThrow(/ambiguous ASCII case-insensitive key/u)

    expect(() => projectJsonRows('[{"Name":"a"},{"name":"b"}]', {
      arrayPointer: '',
      project: [{ name: 'value', pointer: '/NAME' }],
    })).toThrow(/resolved inconsistently across inspected rows/u)
  })

  it('retains more than the max-tie selector limit because these are all matches, not ranked ties', () => {
    const input = JSON.stringify(Array.from({ length: 300 }, (_, sourceIndex) => ({ id: `row-${sourceIndex}` })))
    const result = projectJsonRows(input, {
      arrayPointer: '',
      project: [{ name: 'id', pointer: '/id' }],
    })
    expect(result.rowCount).toBe(300)
    expect(result.matchCount).toBe(300)
    expect(result.rows).toHaveLength(300)
    expect(result.rows[0]).toEqual({ sourceIndex: 0, values: { id: 'row-0' } })
    expect(result.rows[299]).toEqual({ sourceIndex: 299, values: { id: 'row-299' } })
  })

  it('supports object roots, RFC 6901 escapes, and canonical array indexes', () => {
    const result = projectJsonRows(JSON.stringify({
      'feed/rows': [{ enabled: null, nested: { '~value': 'ok' }, values: [false, 'one'] }],
    }), {
      arrayPointer: '/feed~1rows',
      where: [{ pointer: '/enabled', equals: null }],
      project: [
        { name: 'escaped', pointer: '/nested/~0value' },
        { name: 'indexed', pointer: '/values/1' },
      ],
    })
    expect(result.rows).toEqual([{ sourceIndex: 0, values: { escaped: 'ok', indexed: 'one' } }])
    expectCode(() => projectJsonRows('[{"x":[1]}]', {
      arrayPointer: '',
      project: [{ name: 'x', pointer: '/x/01' }],
    }), 'JSON_PROJECTION_INVALID_POINTER')
  })

  it('rejects numeric where equality explicitly rather than comparing rounded IEEE-754 values', () => {
    expectCode(() => projectJsonRows('[{"id":9007199254740993}]', {
      arrayPointer: '',
      where: [{ pointer: '/id', equals: 9007199254740992 }],
      project: [{ name: 'id', pointer: '/id' }],
    } as unknown as JsonProjectionRequest), 'JSON_PROJECTION_INVALID_REQUEST')
  })

  it('rejects duplicate aliases and duplicate canonical pointers independently at both levels', () => {
    expectCode(() => projectJsonRows('[]', {
      arrayPointer: '',
      project: [
        { name: 'one', pointer: '/a~1b' },
        { name: 'two', pointer: '/a~1b' },
      ],
    }), 'JSON_PROJECTION_INVALID_REQUEST')
    expectCode(() => projectJsonRows('[]', {
      arrayPointer: '',
      project: [{ name: 'one', pointer: '/id' }],
      nested: {
        arrayPointer: '/children',
        project: [
          { name: 'value', pointer: '/value' },
          { name: 'value', pointer: '/other' },
        ],
      },
    }), 'JSON_PROJECTION_INVALID_REQUEST')
  })

  it('fails closed on malformed containers, rows, pointers, and non-scalar projections', () => {
    expectCode(() => projectJsonRows('{}', { ...goRequest, arrayPointer: '/missing' }), 'JSON_PROJECTION_POINTER_NOT_FOUND')
    expectCode(() => projectJsonRows('{"rows":{}}', { ...goRequest, arrayPointer: '/rows' }), 'JSON_PROJECTION_ARRAY_TYPE_MISMATCH')
    expectCode(() => projectJsonRows('[null]', goRequest), 'JSON_PROJECTION_ROW_TYPE_MISMATCH')
    expectCode(() => projectJsonRows('[{"stable":true,"version":{},"files":[]}]', goRequest), 'JSON_PROJECTION_NON_SCALAR_PROJECTION')
    expectCode(() => projectJsonRows('[{"stable":true,"version":"x","files":{}}]', goRequest), 'JSON_PROJECTION_ARRAY_TYPE_MISMATCH')
    expectCode(() => projectJsonRows('[{"stable":true,"version":"x","files":[null]}]', goRequest), 'JSON_PROJECTION_ROW_TYPE_MISMATCH')
    expectCode(() => projectJsonRows('[{"x":9007199254740993}]', {
      arrayPointer: '',
      project: [{ name: 'x', pointer: '/x' }],
    }), 'JSON_PROJECTION_NUMERIC_PROJECTION_UNSUPPORTED')
  })

  it('rejects duplicate keys, invalid UTF-8 and Unicode, and excessive depth before JSON.parse', () => {
    expectCode(() => projectJsonRows('{"rows":[],"rows":[]}', {
      arrayPointer: '/rows',
      project: [{ name: 'id', pointer: '/id' }],
    }), 'JSON_PROJECTION_DUPLICATE_KEY')
    expectCode(() => projectJsonRows(new Uint8Array([0xff]), goRequest), 'JSON_PROJECTION_INVALID_UTF8')
    expectCode(() => projectJsonRows('[{"id":"\\ud800"}]', {
      arrayPointer: '',
      project: [{ name: 'id', pointer: '/id' }],
    }), 'JSON_PROJECTION_INVALID_UNICODE')

    const deeplyNested = `${'['.repeat(500_000)}0${']'.repeat(500_000)}`
    const parse = vi.spyOn(JSON, 'parse')
    try {
      expectCode(() => projectJsonRows(deeplyNested, {
        arrayPointer: '',
        project: [{ name: 'id', pointer: '/id' }],
      }), 'JSON_PROJECTION_PARSE_LIMIT_EXCEEDED')
      expect(parse).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
  })

  it('applies the same 64-container depth boundary as the existing selectors', () => {
    const atLimit = `${'['.repeat(63)}0${']'.repeat(63)}`
    const accepted = projectJsonRows(`{"padding":${atLimit},"rows":[{"id":"ok"}]}`, {
      arrayPointer: '/rows',
      project: [{ name: 'id', pointer: '/id' }],
    })
    expect(accepted.matchCount).toBe(1)
    const beyondLimit = `${'['.repeat(64)}${']'.repeat(64)}`
    expectCode(() => projectJsonRows(`{"padding":${beyondLimit},"rows":[]}`, {
      arrayPointer: '/rows',
      project: [{ name: 'id', pointer: '/id' }],
    }), 'JSON_PROJECTION_PARSE_LIMIT_EXCEEDED')
  })

  it('enforces input, top-row, aggregate nested-row, scalar, and projected-output bounds', () => {
    const oversizedInput = `{"padding":"${'x'.repeat(JSON_SELECTION_MAX_INPUT_BYTES)}","rows":[]}`
    expectCode(() => projectJsonRows(oversizedInput, {
      arrayPointer: '/rows',
      project: [{ name: 'id', pointer: '/id' }],
    }), 'JSON_PROJECTION_INPUT_TOO_LARGE')

    const tooManyRows = JSON.stringify(Array.from({ length: JSON_SELECTION_MAX_ROWS + 1 }, () => ({})))
    expectCode(() => projectJsonRows(tooManyRows, {
      arrayPointer: '',
      project: [{ name: 'id', pointer: '/id' }],
    }), 'JSON_PROJECTION_ROW_LIMIT_EXCEEDED')

    const perParent = Math.floor(JSON_PROJECTION_MAX_TOTAL_NESTED_ROWS / 2) + 1
    const tooManyNestedRows = JSON.stringify([
      { id: 'a', children: Array.from({ length: perParent }, () => ({ value: true })) },
      { id: 'b', children: Array.from({ length: perParent }, () => ({ value: true })) },
    ])
    expectCode(() => projectJsonRows(tooManyNestedRows, {
      arrayPointer: '',
      project: [{ name: 'id', pointer: '/id' }],
      nested: { arrayPointer: '/children', project: [{ name: 'value', pointer: '/value' }] },
    }), 'JSON_PROJECTION_ROW_LIMIT_EXCEEDED')

    const oversizedScalar = 'x'.repeat(JSON_SELECTION_MAX_PROJECTED_SCALAR_BYTES + 1)
    expectCode(() => projectJsonRows(JSON.stringify([{ value: oversizedScalar }]), {
      arrayPointer: '',
      project: [{ name: 'value', pointer: '/value' }],
    }), 'JSON_PROJECTION_OUTPUT_TOO_LARGE')

    const largeButScalarBounded = 'x'.repeat(60 * 1024)
    const amplified = JSON.stringify(Array.from({ length: 80 }, () => ({ value: largeButScalarBounded })))
    expect(Buffer.byteLength(amplified, 'utf8')).toBeLessThan(JSON_SELECTION_MAX_INPUT_BYTES)
    expectCode(() => projectJsonRows(amplified, {
      arrayPointer: '',
      project: [{ name: 'value', pointer: '/value' }],
    }), 'JSON_PROJECTION_OUTPUT_TOO_LARGE')
  })
})
