import { createHash } from 'node:crypto'
import {
  compareLosslessJsonNumbers,
  isLosslessJsonNumber,
  parseLosslessStrictJson,
  type LosslessJsonFailureKind,
  type LosslessJsonNumber,
} from './json-lossless-number.js'
import {
  decodeJsonInput,
  parseJsonPointer,
  requireIsoDate as requireValidIsoDate,
  requireSourceDate as requireValidSourceDate,
} from './json-primitives.js'
import {
  JSON_SELECTION_MAX_INPUT_BYTES,
  JSON_SELECTION_MAX_PROJECTED_SCALAR_BYTES,
  JSON_SELECTION_MAX_ROWS,
  JSON_SELECTION_MAX_TIES,
  type JsonProjection,
} from './json-selection.js'

export const JSON_NUMERIC_SELECTION_MAX_NUMBER_TOKENS = 100_000
export const JSON_NUMERIC_SELECTION_MAX_LEXEME_BYTES = 1_024

const MAX_JSON_DEPTH = 64
const MAX_POINTER_LENGTH = 1_024
const MAX_POINTER_SEGMENTS = 32
const MAX_PROJECTIONS = 32
const MAX_EQUALITY_FILTERS = 4
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_PROJECTED_OUTPUT_BYTES = 4 * 1024 * 1024

export interface JsonNumberLexeme {
  readonly [key: string]: string
  /** Exact JSON number token from the decoded UTF-8 source. */
  readonly jsonNumber: string
}

export type JsonNumericProjectedScalar = string | boolean | null | JsonNumberLexeme

export interface JsonNumericSelectionRequest {
  /** RFC 6901 JSON Pointer from the root object to an array of objects. */
  readonly arrayPointer: string
  /** Optional ISO-date cutoff applied before numeric selection. */
  readonly filter?: {
    readonly pointer: string
    readonly lte: string
  }
  /** Optional strict non-numeric scalar equality filters. */
  readonly where?: readonly {
    readonly pointer: string
    readonly equals: string | boolean | null
  }[]
  readonly extreme: {
    readonly pointer: string
    readonly direction: 'max' | 'min'
    readonly ties: 'all'
  }
  readonly project: readonly JsonProjection[]
}

export interface JsonNumericSelectionRow {
  readonly sourceIndex: number
  readonly values: Readonly<Record<string, JsonNumericProjectedScalar>>
}

export interface JsonNumericSelectionResult {
  readonly complete: true
  readonly truncated: false
  readonly evidenceSha256: string
  readonly arrayPointer: string
  readonly filter?: {
    readonly pointer: string
    readonly lte: string
  }
  readonly where?: readonly { readonly pointer: string; readonly equals: string | boolean | null }[]
  readonly extreme: {
    readonly pointer: string
    readonly direction: 'max' | 'min'
    /** Exact source lexeme of the first winning row. Equivalent ties may use another lexeme. */
    readonly value: JsonNumberLexeme
    readonly ties: 'all'
  }
  readonly rowsScanned: number
  readonly rowsEligible: number
  readonly tieCount: number
  readonly rows: readonly JsonNumericSelectionRow[]
}

export type JsonNumericSelectionErrorCode =
  | 'JSON_NUMERIC_SELECTION_INVALID_REQUEST'
  | 'JSON_NUMERIC_SELECTION_INPUT_TOO_LARGE'
  | 'JSON_NUMERIC_SELECTION_INVALID_UTF8'
  | 'JSON_NUMERIC_SELECTION_INVALID_UNICODE'
  | 'JSON_NUMERIC_SELECTION_INVALID_JSON'
  | 'JSON_NUMERIC_SELECTION_DUPLICATE_KEY'
  | 'JSON_NUMERIC_SELECTION_PARSE_LIMIT_EXCEEDED'
  | 'JSON_NUMERIC_SELECTION_NUMBER_TOKEN_LIMIT_EXCEEDED'
  | 'JSON_NUMERIC_SELECTION_NUMBER_LEXEME_LIMIT_EXCEEDED'
  | 'JSON_NUMERIC_SELECTION_LOSSLESS_PARSE_UNAVAILABLE'
  | 'JSON_NUMERIC_SELECTION_INVALID_POINTER'
  | 'JSON_NUMERIC_SELECTION_POINTER_NOT_FOUND'
  | 'JSON_NUMERIC_SELECTION_POINTER_TYPE_MISMATCH'
  | 'JSON_NUMERIC_SELECTION_ROOT_TYPE_MISMATCH'
  | 'JSON_NUMERIC_SELECTION_ARRAY_TYPE_MISMATCH'
  | 'JSON_NUMERIC_SELECTION_ROW_LIMIT_EXCEEDED'
  | 'JSON_NUMERIC_SELECTION_ROW_TYPE_MISMATCH'
  | 'JSON_NUMERIC_SELECTION_INVALID_ISO_DATE'
  | 'JSON_NUMERIC_SELECTION_EXTREME_TYPE_MISMATCH'
  | 'JSON_NUMERIC_SELECTION_NON_SCALAR_PROJECTION'
  | 'JSON_NUMERIC_SELECTION_NO_MATCH'
  | 'JSON_NUMERIC_SELECTION_TIE_LIMIT_EXCEEDED'
  | 'JSON_NUMERIC_SELECTION_OUTPUT_TOO_LARGE'

export class JsonNumericSelectionError extends Error {
  constructor(message: string, readonly code: JsonNumericSelectionErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'JsonNumericSelectionError'
  }
}

interface CompiledProjection extends JsonProjection {
  readonly segments: readonly string[]
}

interface CompiledRequest {
  readonly arrayPointer: string
  readonly arraySegments: readonly string[]
  readonly filter?: {
    readonly pointer: string
    readonly segments: readonly string[]
    readonly lte: string
  }
  readonly where: readonly {
    readonly pointer: string
    readonly segments: readonly string[]
    readonly equals: string | boolean | null
  }[]
  readonly extremePointer: string
  readonly extremeSegments: readonly string[]
  readonly direction: 'max' | 'min'
  readonly projections: readonly CompiledProjection[]
}

interface ProjectionBudget {
  usedBytes: number
}

function fail(message: string, code: JsonNumericSelectionErrorCode, options?: ErrorOptions): never {
  throw new JsonNumericSelectionError(message, code, options)
}

const JSON_FAILURE_ERROR_CODES = {
  invalid_request: 'JSON_NUMERIC_SELECTION_INVALID_REQUEST',
  input_too_large: 'JSON_NUMERIC_SELECTION_INPUT_TOO_LARGE',
  invalid_utf8: 'JSON_NUMERIC_SELECTION_INVALID_UTF8',
  invalid_unicode: 'JSON_NUMERIC_SELECTION_INVALID_UNICODE',
  invalid_json: 'JSON_NUMERIC_SELECTION_INVALID_JSON',
  duplicate_key: 'JSON_NUMERIC_SELECTION_DUPLICATE_KEY',
  parse_limit_exceeded: 'JSON_NUMERIC_SELECTION_PARSE_LIMIT_EXCEEDED',
  invalid_pointer: 'JSON_NUMERIC_SELECTION_INVALID_POINTER',
  invalid_iso_date: 'JSON_NUMERIC_SELECTION_INVALID_ISO_DATE',
  number_token_limit_exceeded: 'JSON_NUMERIC_SELECTION_NUMBER_TOKEN_LIMIT_EXCEEDED',
  number_lexeme_limit_exceeded: 'JSON_NUMERIC_SELECTION_NUMBER_LEXEME_LIMIT_EXCEEDED',
  lossless_parse_unavailable: 'JSON_NUMERIC_SELECTION_LOSSLESS_PARSE_UNAVAILABLE',
} as const satisfies Record<LosslessJsonFailureKind, JsonNumericSelectionErrorCode>

function failJsonFailure(
  kind: LosslessJsonFailureKind,
  message: string,
  options?: ErrorOptions,
): never {
  fail(message, JSON_FAILURE_ERROR_CODES[kind], options)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && !isLosslessJsonNumber(value)
}

function assertExactObject(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) fail(`${label} must be an object`, 'JSON_NUMERIC_SELECTION_INVALID_REQUEST')
  const allowed = new Set(allowedKeys)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} contains an unsupported property`, 'JSON_NUMERIC_SELECTION_INVALID_REQUEST')
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail(`${label} is missing a required property`, 'JSON_NUMERIC_SELECTION_INVALID_REQUEST')
    }
  }
  return value
}

function parsePointer(pointer: unknown, label: string): readonly string[] {
  return parseJsonPointer(pointer, label, {
    maxLength: MAX_POINTER_LENGTH,
    maxSegments: MAX_POINTER_SEGMENTS,
    fail: failJsonFailure,
  })
}

function requireIsoDate(value: unknown, label: string): string {
  return requireValidIsoDate(value, label, failJsonFailure)
}

function requireSourceDate(value: unknown, label: string): string {
  return requireValidSourceDate(value, label, failJsonFailure)
}

function compileRequest(input: JsonNumericSelectionRequest): CompiledRequest {
  const request = assertExactObject(input, ['arrayPointer', 'filter', 'where', 'extreme', 'project'], ['arrayPointer', 'extreme', 'project'], 'request')
  if (typeof request.arrayPointer !== 'string') {
    fail('request.arrayPointer must be a string', 'JSON_NUMERIC_SELECTION_INVALID_REQUEST')
  }
  const arrayPointer = request.arrayPointer

  const filter = request.filter === undefined
    ? undefined
    : (() => {
        const value = assertExactObject(request.filter, ['pointer', 'lte'], ['pointer', 'lte'], 'request.filter')
        if (typeof value.pointer !== 'string') {
          fail('request.filter.pointer must be a string', 'JSON_NUMERIC_SELECTION_INVALID_REQUEST')
        }
        return {
          pointer: value.pointer,
          segments: parsePointer(value.pointer, 'request.filter.pointer'),
          lte: requireIsoDate(value.lte, 'request.filter.lte'),
        }
      })()

  const where = request.where === undefined
    ? []
    : (() => {
        if (!Array.isArray(request.where) || request.where.length === 0 || request.where.length > MAX_EQUALITY_FILTERS) {
          fail(`request.where must contain 1-${MAX_EQUALITY_FILTERS} entries`, 'JSON_NUMERIC_SELECTION_INVALID_REQUEST')
        }
        return request.where.map((raw, index) => {
          const entry = assertExactObject(raw, ['pointer', 'equals'], ['pointer', 'equals'], `request.where[${index}]`)
          if (typeof entry.pointer !== 'string') {
            fail(`request.where[${index}].pointer must be a string`, 'JSON_NUMERIC_SELECTION_INVALID_REQUEST')
          }
          if (entry.equals !== null && typeof entry.equals !== 'string' && typeof entry.equals !== 'boolean') {
            fail(`request.where[${index}].equals must be a string, boolean, or null`, 'JSON_NUMERIC_SELECTION_INVALID_REQUEST')
          }
          return {
            pointer: entry.pointer,
            segments: parsePointer(entry.pointer, `request.where[${index}].pointer`),
            equals: entry.equals,
          }
        })
      })()

  const extreme = assertExactObject(request.extreme, ['pointer', 'direction', 'ties'], ['pointer', 'direction', 'ties'], 'request.extreme')
  if (typeof extreme.pointer !== 'string') {
    fail('request.extreme.pointer must be a string', 'JSON_NUMERIC_SELECTION_INVALID_REQUEST')
  }
  if (extreme.direction !== 'max' && extreme.direction !== 'min') {
    fail('request.extreme.direction must be max or min', 'JSON_NUMERIC_SELECTION_INVALID_REQUEST')
  }
  if (extreme.ties !== 'all') {
    fail('request.extreme.ties must be all', 'JSON_NUMERIC_SELECTION_INVALID_REQUEST')
  }

  if (!Array.isArray(request.project) || request.project.length === 0 || request.project.length > MAX_PROJECTIONS) {
    fail(`request.project must contain 1-${MAX_PROJECTIONS} entries`, 'JSON_NUMERIC_SELECTION_INVALID_REQUEST')
  }
  const names = new Set<string>()
  const pointers = new Set<string>()
  const projections = request.project.map((raw, index): CompiledProjection => {
    const projection = assertExactObject(raw, ['name', 'pointer'], ['name', 'pointer'], `request.project[${index}]`)
    if (typeof projection.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(projection.name)) {
      fail(`request.project[${index}].name must be a 1-64 character identifier`, 'JSON_NUMERIC_SELECTION_INVALID_REQUEST')
    }
    if (names.has(projection.name)) {
      fail('request.project contains a duplicate name', 'JSON_NUMERIC_SELECTION_INVALID_REQUEST')
    }
    names.add(projection.name)
    if (typeof projection.pointer !== 'string') {
      fail(`request.project[${index}].pointer must be a string`, 'JSON_NUMERIC_SELECTION_INVALID_REQUEST')
    }
    const segments = parsePointer(projection.pointer, `request.project[${index}].pointer`)
    const canonicalPointer = JSON.stringify(segments)
    if (pointers.has(canonicalPointer)) {
      fail('request.project contains a duplicate pointer', 'JSON_NUMERIC_SELECTION_INVALID_REQUEST')
    }
    pointers.add(canonicalPointer)
    return { name: projection.name, pointer: projection.pointer, segments }
  })

  return {
    arrayPointer,
    arraySegments: parsePointer(arrayPointer, 'request.arrayPointer'),
    ...(filter === undefined ? {} : { filter }),
    where,
    extremePointer: extreme.pointer,
    extremeSegments: parsePointer(extreme.pointer, 'request.extreme.pointer'),
    direction: extreme.direction,
    projections,
  }
}

function parseStrictJson(text: string): unknown {
  return parseLosslessStrictJson(text, {
    maxDepth: MAX_JSON_DEPTH,
    maxNumberTokens: JSON_NUMERIC_SELECTION_MAX_NUMBER_TOKENS,
    maxLexemeBytes: JSON_NUMERIC_SELECTION_MAX_LEXEME_BYTES,
    fail: failJsonFailure,
    isFailure: error => error instanceof JsonNumericSelectionError,
  })
}

function decodeInput(input: string | Uint8Array): { readonly text: string; readonly bytes: Uint8Array } {
  return decodeJsonInput(input, {
    maxBytes: JSON_SELECTION_MAX_INPUT_BYTES,
    maxBytesLabel: '8 MiB',
    fail: failJsonFailure,
  })
}

function resolvePointer(
  root: unknown,
  segments: readonly string[],
  pointer: string,
  label: string,
): unknown {
  let value = root
  for (const segment of segments) {
    if (Array.isArray(value)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(segment)) {
        fail(`${label} contains a non-canonical array index`, 'JSON_NUMERIC_SELECTION_INVALID_POINTER')
      }
      const index = Number(segment)
      if (!Number.isSafeInteger(index) || index >= value.length) {
        fail(`${label} was not found`, 'JSON_NUMERIC_SELECTION_POINTER_NOT_FOUND')
      }
      value = value[index]
      continue
    }
    if (!isRecord(value)) {
      fail(`${label} traverses a non-container value`, 'JSON_NUMERIC_SELECTION_POINTER_TYPE_MISMATCH')
    }
    if (!Object.prototype.hasOwnProperty.call(value, segment)) {
      fail(`${label} was not found`, 'JSON_NUMERIC_SELECTION_POINTER_NOT_FOUND')
    }
    value = value[segment]
  }
  return value
}

function consumeProjectionBudget(budget: ProjectionBudget, bytes: number): void {
  if (budget.usedBytes + bytes > MAX_PROJECTED_OUTPUT_BYTES) {
    fail(
      'JSON numeric selection projected output exceeds the 4 MiB construction limit',
      'JSON_NUMERIC_SELECTION_OUTPUT_TOO_LARGE',
    )
  }
  budget.usedBytes += bytes
}

function projectRow(
  row: Record<string, unknown>,
  sourceIndex: number,
  request: CompiledRequest,
  budget: ProjectionBudget,
): JsonNumericSelectionRow {
  const values: Record<string, JsonNumericProjectedScalar> = {}
  consumeProjectionBudget(budget, 48 + String(sourceIndex).length)
  for (const projection of request.projections) {
    const source = resolvePointer(
      row,
      projection.segments,
      projection.pointer,
      `row ${sourceIndex} projection`,
    )
    let value: JsonNumericProjectedScalar
    if (isLosslessJsonNumber(source)) value = { jsonNumber: source.lexeme }
    else if (source === null || typeof source === 'string' || typeof source === 'boolean') value = source
    else {
      fail(`row ${sourceIndex} projection is not a JSON scalar`, 'JSON_NUMERIC_SELECTION_NON_SCALAR_PROJECTION')
    }
    const serializedBytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
    if (serializedBytes > JSON_SELECTION_MAX_PROJECTED_SCALAR_BYTES) {
      fail(
        `row ${sourceIndex} projected scalar exceeds the 64 KiB limit`,
        'JSON_NUMERIC_SELECTION_OUTPUT_TOO_LARGE',
      )
    }
    consumeProjectionBudget(budget, projection.name.length + serializedBytes + 4)
    values[projection.name] = value
  }
  return { sourceIndex, values }
}

/**
 * Select every exact numeric maximum/minimum tie from one bounded JSON object-array.
 * JSON number comparison and projection use the source lexeme rather than IEEE-754.
 */
export function selectJsonNumericTies(
  input: string | Uint8Array,
  rawRequest: JsonNumericSelectionRequest,
): JsonNumericSelectionResult {
  const request = compileRequest(rawRequest)
  const decoded = decodeInput(input)
  const evidenceSha256 = createHash('sha256').update(decoded.bytes).digest('hex')
  const root = parseStrictJson(decoded.text)
  if (!isRecord(root) && !(Array.isArray(root) && request.arraySegments.length === 0)) {
    fail(
      'JSON root must be an object, or an array when arrayPointer is empty',
      'JSON_NUMERIC_SELECTION_ROOT_TYPE_MISMATCH',
    )
  }

  const selectedArray = resolvePointer(root, request.arraySegments, request.arrayPointer, 'array pointer')
  if (!Array.isArray(selectedArray)) {
    fail('array pointer must resolve to an array', 'JSON_NUMERIC_SELECTION_ARRAY_TYPE_MISMATCH')
  }
  if (selectedArray.length > JSON_SELECTION_MAX_ROWS) {
    fail(
      `selected array exceeds the ${JSON_SELECTION_MAX_ROWS} row limit`,
      'JSON_NUMERIC_SELECTION_ROW_LIMIT_EXCEEDED',
    )
  }

  let rowsEligible = 0
  let best: LosslessJsonNumber | undefined
  let tieCount = 0
  let tieOverflow = false
  let tieIndexes: number[] = []

  for (let sourceIndex = 0; sourceIndex < selectedArray.length; sourceIndex++) {
    const row = selectedArray[sourceIndex]
    if (!isRecord(row)) {
      fail(`selected array row ${sourceIndex} must be an object`, 'JSON_NUMERIC_SELECTION_ROW_TYPE_MISMATCH')
    }
    if (!request.where.every(entry => Object.is(
      resolvePointer(row, entry.segments, entry.pointer, `row ${sourceIndex} equality filter`),
      entry.equals,
    ))) continue
    if (request.filter !== undefined) {
      const filterDate = requireSourceDate(
        resolvePointer(row, request.filter.segments, request.filter.pointer, `row ${sourceIndex} filter`),
        `row ${sourceIndex} filter`,
      )
      if (filterDate > request.filter.lte) continue
    }
    rowsEligible++
    const candidate = resolvePointer(
      row,
      request.extremeSegments,
      request.extremePointer,
      `row ${sourceIndex} numeric extreme`,
    )
    if (!isLosslessJsonNumber(candidate)) {
      fail(
        `row ${sourceIndex} numeric extreme must be a JSON number`,
        'JSON_NUMERIC_SELECTION_EXTREME_TYPE_MISMATCH',
      )
    }

    const comparison = best === undefined ? 1 : compareLosslessJsonNumbers(candidate, best)
    const replaces = best === undefined
      || (request.direction === 'max' ? comparison > 0 : comparison < 0)
    if (replaces) {
      best = candidate
      tieCount = 1
      tieOverflow = false
      tieIndexes = [sourceIndex]
    } else if (comparison === 0) {
      tieCount++
      if (tieIndexes.length < JSON_SELECTION_MAX_TIES) tieIndexes.push(sourceIndex)
      else tieOverflow = true
    }
  }

  if (best === undefined) fail('no row satisfied the selection filters', 'JSON_NUMERIC_SELECTION_NO_MATCH')
  if (tieOverflow) {
    fail(
      `final numeric ties exceed the ${JSON_SELECTION_MAX_TIES} row limit`,
      'JSON_NUMERIC_SELECTION_TIE_LIMIT_EXCEEDED',
    )
  }

  const projectionBudget: ProjectionBudget = { usedBytes: 0 }
  const rows = tieIndexes.map(sourceIndex => projectRow(
    selectedArray[sourceIndex]!,
    sourceIndex,
    request,
    projectionBudget,
  ))
  const result: JsonNumericSelectionResult = {
    complete: true,
    truncated: false,
    evidenceSha256,
    arrayPointer: request.arrayPointer,
    ...(request.filter === undefined ? {} : {
      filter: { pointer: request.filter.pointer, lte: request.filter.lte },
    }),
    ...(request.where.length === 0 ? {} : {
      where: request.where.map(entry => ({ pointer: entry.pointer, equals: entry.equals })),
    }),
    extreme: {
      pointer: request.extremePointer,
      direction: request.direction,
      value: { jsonNumber: best.lexeme },
      ties: 'all',
    },
    rowsScanned: selectedArray.length,
    rowsEligible,
    tieCount,
    rows,
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_OUTPUT_BYTES) {
    fail('JSON numeric selection output exceeds the 8 MiB limit', 'JSON_NUMERIC_SELECTION_OUTPUT_TOO_LARGE')
  }
  return result
}
