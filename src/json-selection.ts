import { createHash } from 'node:crypto'

export const JSON_SELECTION_MAX_INPUT_BYTES = 8 * 1024 * 1024
export const JSON_SELECTION_MAX_ROWS = 25_000
export const JSON_SELECTION_MAX_TIES = 256
export const JSON_SELECTION_MAX_PROJECTED_SCALAR_BYTES = 64 * 1024

const MAX_JSON_DEPTH = 64
const MAX_POINTER_LENGTH = 1_024
const MAX_POINTER_SEGMENTS = 32
const MAX_PROJECTIONS = 32
const MAX_EQUALITY_FILTERS = 4
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_PROJECTED_OUTPUT_BYTES = 4 * 1024 * 1024

export type JsonScalar = string | number | boolean | null

export interface JsonProjection {
  readonly name: string
  /** RFC 6901 JSON Pointer, resolved relative to each selected row. */
  readonly pointer: string
}

export interface JsonSelectionRequest {
  /** RFC 6901 JSON Pointer from the root object to an array of objects. */
  readonly arrayPointer: string
  /** Keep rows whose ISO calendar date at `pointer` is at most `lte`. */
  readonly filter: {
    readonly pointer: string
    readonly lte: string
  }
  /** Optional strict scalar equality filters applied before the date cutoff. */
  readonly where?: readonly {
    readonly pointer: string
    readonly equals: string | boolean | null
  }[]
  /** Select every eligible row tied for the maximum ISO date at `pointer`. */
  readonly max: {
    readonly pointer: string
  }
  /** Emit only the named scalar values. */
  readonly project: readonly JsonProjection[]
}

export interface JsonSelectionRow {
  /** Zero-based position in the source array. */
  readonly sourceIndex: number
  readonly values: Readonly<Record<string, JsonScalar>>
}

export interface JsonSelectionResult {
  readonly complete: true
  readonly truncated: false
  readonly evidenceSha256: string
  readonly arrayPointer: string
  readonly filter: {
    readonly pointer: string
    readonly lte: string
  }
  readonly where?: readonly { readonly pointer: string; readonly equals: string | boolean | null }[]
  readonly max: {
    readonly pointer: string
    readonly value: string
    readonly ties: 'all'
  }
  readonly rowsScanned: number
  readonly rowsEligible: number
  readonly tieCount: number
  readonly rows: readonly JsonSelectionRow[]
}

export type JsonSelectionErrorCode =
  | 'JSON_SELECTION_INVALID_REQUEST'
  | 'JSON_SELECTION_INPUT_TOO_LARGE'
  | 'JSON_SELECTION_INVALID_UTF8'
  | 'JSON_SELECTION_INVALID_UNICODE'
  | 'JSON_SELECTION_INVALID_JSON'
  | 'JSON_SELECTION_DUPLICATE_KEY'
  | 'JSON_SELECTION_PARSE_LIMIT_EXCEEDED'
  | 'JSON_SELECTION_INVALID_POINTER'
  | 'JSON_SELECTION_POINTER_NOT_FOUND'
  | 'JSON_SELECTION_POINTER_TYPE_MISMATCH'
  | 'JSON_SELECTION_ROOT_TYPE_MISMATCH'
  | 'JSON_SELECTION_ARRAY_TYPE_MISMATCH'
  | 'JSON_SELECTION_ROW_LIMIT_EXCEEDED'
  | 'JSON_SELECTION_ROW_TYPE_MISMATCH'
  | 'JSON_SELECTION_INVALID_ISO_DATE'
  | 'JSON_SELECTION_NON_SCALAR_PROJECTION'
  | 'JSON_SELECTION_NO_MATCH'
  | 'JSON_SELECTION_TIE_LIMIT_EXCEEDED'
  | 'JSON_SELECTION_OUTPUT_TOO_LARGE'

export class JsonSelectionError extends Error {
  constructor(message: string, readonly code: JsonSelectionErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'JsonSelectionError'
  }
}

interface CompiledProjection extends JsonProjection {
  readonly segments: readonly string[]
}

interface CompiledRequest {
  readonly arrayPointer: string
  readonly arraySegments: readonly string[]
  readonly filterPointer: string
  readonly filterSegments: readonly string[]
  readonly cutoff: string
  readonly where: readonly {
    readonly pointer: string
    readonly segments: readonly string[]
    readonly equals: string | boolean | null
  }[]
  readonly maxPointer: string
  readonly maxSegments: readonly string[]
  readonly projections: readonly CompiledProjection[]
}

function fail(message: string, code: JsonSelectionErrorCode, options?: ErrorOptions): never {
  throw new JsonSelectionError(message, code, options)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertExactObject(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) fail(`${label} must be an object`, 'JSON_SELECTION_INVALID_REQUEST')
  const allowed = new Set(allowedKeys)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} contains unsupported property "${key}"`, 'JSON_SELECTION_INVALID_REQUEST')
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail(`${label} is missing required property "${key}"`, 'JSON_SELECTION_INVALID_REQUEST')
    }
  }
  return value
}

function parsePointer(pointer: unknown, label: string): readonly string[] {
  if (typeof pointer !== 'string') fail(`${label} must be a string`, 'JSON_SELECTION_INVALID_POINTER')
  if (pointer.length > MAX_POINTER_LENGTH) {
    fail(`${label} exceeds ${MAX_POINTER_LENGTH} characters`, 'JSON_SELECTION_INVALID_POINTER')
  }
  if (pointer === '') return []
  if (!pointer.startsWith('/')) fail(`${label} must be an RFC 6901 JSON Pointer`, 'JSON_SELECTION_INVALID_POINTER')
  const rawSegments = pointer.slice(1).split('/')
  if (rawSegments.length > MAX_POINTER_SEGMENTS) {
    fail(`${label} exceeds ${MAX_POINTER_SEGMENTS} segments`, 'JSON_SELECTION_INVALID_POINTER')
  }
  return rawSegments.map((segment) => {
    if (/~(?:[^01]|$)/u.test(segment)) {
      fail(`${label} contains an invalid RFC 6901 escape`, 'JSON_SELECTION_INVALID_POINTER')
    }
    return segment.replace(/~1/gu, '/').replace(/~0/gu, '~')
  })
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const day = Number(value.slice(8, 10))
  if (year < 1 || month < 1 || month > 12 || day < 1) return false
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day <= days[month - 1]!
}

function requireIsoDate(value: unknown, label: string): string {
  if (!isIsoDate(value)) {
    fail(`${label} must be a valid ISO calendar date (YYYY-MM-DD)`, 'JSON_SELECTION_INVALID_ISO_DATE')
  }
  return value
}

function requireSourceDate(value: unknown, label: string): string {
  if (isIsoDate(value)) return value
  const timestamp = typeof value === 'string'
    ? /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/u.exec(value)
    : null
  if (timestamp === null
    || !isIsoDate(timestamp[1])
    || Number(timestamp[2]) > 23
    || Number(timestamp[3]) > 59
    || Number(timestamp[4]) > 59) {
    fail(`${label} must be an ISO calendar date or UTC RFC 3339 timestamp`, 'JSON_SELECTION_INVALID_ISO_DATE')
  }
  return timestamp[1]
}

function compileRequest(input: JsonSelectionRequest): CompiledRequest {
  const request = assertExactObject(input, ['arrayPointer', 'filter', 'where', 'max', 'project'], ['arrayPointer', 'filter', 'max', 'project'], 'request')
  const arrayPointer = request.arrayPointer
  if (typeof arrayPointer !== 'string') fail('request.arrayPointer must be a string', 'JSON_SELECTION_INVALID_REQUEST')

  const filter = assertExactObject(request.filter, ['pointer', 'lte'], ['pointer', 'lte'], 'request.filter')
  if (typeof filter.pointer !== 'string') fail('request.filter.pointer must be a string', 'JSON_SELECTION_INVALID_REQUEST')
  const cutoff = requireIsoDate(filter.lte, 'request.filter.lte')

  const where = request.where === undefined
    ? []
    : (() => {
        if (!Array.isArray(request.where) || request.where.length === 0 || request.where.length > MAX_EQUALITY_FILTERS) {
          fail(`request.where must contain 1-${MAX_EQUALITY_FILTERS} entries`, 'JSON_SELECTION_INVALID_REQUEST')
        }
        return request.where.map((raw, index) => {
          const entry = assertExactObject(raw, ['pointer', 'equals'], ['pointer', 'equals'], `request.where[${index}]`)
          if (typeof entry.pointer !== 'string') {
            fail(`request.where[${index}].pointer must be a string`, 'JSON_SELECTION_INVALID_REQUEST')
          }
          if (entry.equals !== null && typeof entry.equals !== 'string' && typeof entry.equals !== 'boolean') {
            fail(`request.where[${index}].equals must be a string, boolean, or null`, 'JSON_SELECTION_INVALID_REQUEST')
          }
          return {
            pointer: entry.pointer,
            segments: parsePointer(entry.pointer, `request.where[${index}].pointer`),
            equals: entry.equals,
          }
        })
      })()

  const maximum = assertExactObject(request.max, ['pointer'], ['pointer'], 'request.max')
  if (typeof maximum.pointer !== 'string') fail('request.max.pointer must be a string', 'JSON_SELECTION_INVALID_REQUEST')

  if (!Array.isArray(request.project) || request.project.length === 0 || request.project.length > MAX_PROJECTIONS) {
    fail(`request.project must contain 1-${MAX_PROJECTIONS} entries`, 'JSON_SELECTION_INVALID_REQUEST')
  }
  const names = new Set<string>()
  const pointers = new Set<string>()
  const projections = request.project.map((raw, index): CompiledProjection => {
    const projection = assertExactObject(raw, ['name', 'pointer'], ['name', 'pointer'], `request.project[${index}]`)
    if (typeof projection.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(projection.name)) {
      fail(`request.project[${index}].name must be a 1-64 character identifier`, 'JSON_SELECTION_INVALID_REQUEST')
    }
    if (names.has(projection.name)) {
      fail(`request.project contains duplicate name "${projection.name}"`, 'JSON_SELECTION_INVALID_REQUEST')
    }
    names.add(projection.name)
    if (typeof projection.pointer !== 'string') {
      fail(`request.project[${index}].pointer must be a string`, 'JSON_SELECTION_INVALID_REQUEST')
    }
    const segments = parsePointer(projection.pointer, `request.project[${index}].pointer`)
    const canonicalPointer = JSON.stringify(segments)
    if (pointers.has(canonicalPointer)) {
      fail('request.project contains a duplicate pointer', 'JSON_SELECTION_INVALID_REQUEST')
    }
    pointers.add(canonicalPointer)
    return {
      name: projection.name,
      pointer: projection.pointer,
      segments,
    }
  })

  return {
    arrayPointer,
    arraySegments: parsePointer(arrayPointer, 'request.arrayPointer'),
    filterPointer: filter.pointer,
    filterSegments: parsePointer(filter.pointer, 'request.filter.pointer'),
    cutoff,
    where,
    maxPointer: maximum.pointer,
    maxSegments: parsePointer(maximum.pointer, 'request.max.pointer'),
    projections,
  }
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

/** Valid-JSON scanner that adds duplicate-key, Unicode, and depth checks. */
class StrictJsonScanner {
  private cursor = 0

  constructor(private readonly input: string) {}

  scan(): void {
    this.skipWhitespace()
    this.scanValue(0)
    this.skipWhitespace()
    if (this.cursor !== this.input.length) fail('JSON has trailing content', 'JSON_SELECTION_INVALID_JSON')
  }

  private scanValue(depth: number): void {
    if (depth > MAX_JSON_DEPTH) {
      fail(`JSON nesting exceeds ${MAX_JSON_DEPTH}`, 'JSON_SELECTION_PARSE_LIMIT_EXCEEDED')
    }
    const character = this.input[this.cursor]
    if (character === '{') {
      this.scanObject(depth + 1)
    } else if (character === '[') {
      this.scanArray(depth + 1)
    } else if (character === '"') {
      this.scanString()
    } else {
      this.scanPrimitive()
    }
  }

  private scanObject(depth: number): void {
    this.cursor++
    this.skipWhitespace()
    if (this.input[this.cursor] === '}') {
      this.cursor++
      return
    }
    const keys = new Set<string>()
    while (this.cursor < this.input.length) {
      if (this.input[this.cursor] !== '"') fail('invalid JSON object key', 'JSON_SELECTION_INVALID_JSON')
      const key = this.scanString()
      if (keys.has(key)) fail('JSON object contains a duplicate key', 'JSON_SELECTION_DUPLICATE_KEY')
      keys.add(key)
      this.skipWhitespace()
      if (this.input[this.cursor] !== ':') fail('invalid JSON object separator', 'JSON_SELECTION_INVALID_JSON')
      this.cursor++
      this.skipWhitespace()
      this.scanValue(depth)
      this.skipWhitespace()
      const separator = this.input[this.cursor]
      if (separator === '}') {
        this.cursor++
        return
      }
      if (separator !== ',') fail('invalid JSON object separator', 'JSON_SELECTION_INVALID_JSON')
      this.cursor++
      this.skipWhitespace()
    }
    fail('unterminated JSON object', 'JSON_SELECTION_INVALID_JSON')
  }

  private scanArray(depth: number): void {
    this.cursor++
    this.skipWhitespace()
    if (this.input[this.cursor] === ']') {
      this.cursor++
      return
    }
    while (this.cursor < this.input.length) {
      this.scanValue(depth)
      this.skipWhitespace()
      const separator = this.input[this.cursor]
      if (separator === ']') {
        this.cursor++
        return
      }
      if (separator !== ',') fail('invalid JSON array separator', 'JSON_SELECTION_INVALID_JSON')
      this.cursor++
      this.skipWhitespace()
    }
    fail('unterminated JSON array', 'JSON_SELECTION_INVALID_JSON')
  }

  private scanString(): string {
    const start = this.cursor
    this.cursor++
    while (this.cursor < this.input.length) {
      const character = this.input[this.cursor]
      if (character === '"') {
        this.cursor++
        let decoded: unknown
        try {
          decoded = JSON.parse(this.input.slice(start, this.cursor))
        } catch (error: unknown) {
          fail('invalid JSON string', 'JSON_SELECTION_INVALID_JSON', { cause: error })
        }
        if (typeof decoded !== 'string') fail('invalid JSON string', 'JSON_SELECTION_INVALID_JSON')
        if (hasUnpairedSurrogate(decoded)) {
          fail('JSON strings must not contain unpaired UTF-16 surrogates', 'JSON_SELECTION_INVALID_UNICODE')
        }
        return decoded
      }
      if (character === '\\') {
        this.cursor += this.input[this.cursor + 1] === 'u' ? 6 : 2
      } else {
        this.cursor++
      }
    }
    fail('unterminated JSON string', 'JSON_SELECTION_INVALID_JSON')
  }

  private scanPrimitive(): void {
    const start = this.cursor
    while (this.cursor < this.input.length) {
      const character = this.input[this.cursor]!
      if (character === ',' || character === ']' || character === '}' || /\s/u.test(character)) break
      this.cursor++
    }
    if (this.cursor === start) fail('invalid JSON value', 'JSON_SELECTION_INVALID_JSON')
  }

  private skipWhitespace(): void {
    while (this.cursor < this.input.length) {
      const character = this.input[this.cursor]
      if (character !== ' ' && character !== '\t' && character !== '\r' && character !== '\n') break
      this.cursor++
    }
  }
}

function decodeInput(input: string | Uint8Array): { readonly text: string; readonly bytes: Uint8Array } {
  if (typeof input === 'string') {
    if (hasUnpairedSurrogate(input)) {
      fail('JSON input must not contain unpaired UTF-16 surrogates', 'JSON_SELECTION_INVALID_UNICODE')
    }
    const bytes = Buffer.from(input, 'utf8')
    if (bytes.byteLength > JSON_SELECTION_MAX_INPUT_BYTES) {
      fail('JSON input exceeds the 8 MiB limit', 'JSON_SELECTION_INPUT_TOO_LARGE')
    }
    return { text: input, bytes }
  }
  if (!(input instanceof Uint8Array)) fail('JSON input must be a string or Uint8Array', 'JSON_SELECTION_INVALID_REQUEST')
  if (input.byteLength > JSON_SELECTION_MAX_INPUT_BYTES) {
    fail('JSON input exceeds the 8 MiB limit', 'JSON_SELECTION_INPUT_TOO_LARGE')
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(input), bytes: input }
  } catch (error: unknown) {
    fail('JSON input is not valid UTF-8', 'JSON_SELECTION_INVALID_UTF8', { cause: error })
  }
}

function parseStrictJson(text: string): unknown {
  // Reject depth, duplicate-key, and Unicode hazards before JSON.parse can
  // materialize an attacker-amplified object graph.
  new StrictJsonScanner(text).scan()
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error: unknown) {
    fail('JSON input is invalid', 'JSON_SELECTION_INVALID_JSON', { cause: error })
  }
  return value
}

function resolvePointer(root: unknown, segments: readonly string[], pointer: string, label: string): unknown {
  let value = root
  for (const segment of segments) {
    if (Array.isArray(value)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(segment)) {
        fail(`${label} "${pointer}" contains a non-canonical array index`, 'JSON_SELECTION_INVALID_POINTER')
      }
      const index = Number(segment)
      if (!Number.isSafeInteger(index) || index >= value.length) {
        fail(`${label} "${pointer}" was not found`, 'JSON_SELECTION_POINTER_NOT_FOUND')
      }
      value = value[index]
      continue
    }
    if (!isRecord(value)) {
      fail(`${label} "${pointer}" traverses a non-container value`, 'JSON_SELECTION_POINTER_TYPE_MISMATCH')
    }
    if (!Object.prototype.hasOwnProperty.call(value, segment)) {
      fail(`${label} "${pointer}" was not found`, 'JSON_SELECTION_POINTER_NOT_FOUND')
    }
    value = value[segment]
  }
  return value
}

function jsonScalarSerializedBytes(value: JsonScalar): number {
  if (value === null) return 4
  if (typeof value === 'boolean') return value ? 4 : 5
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail('projected JSON number was outside the finite JavaScript range', 'JSON_SELECTION_NON_SCALAR_PROJECTION')
    }
    return Buffer.byteLength(String(value), 'utf8')
  }

  let bytes = 2 // surrounding JSON quotes
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09
      || code === 0x0a || code === 0x0c || code === 0x0d) {
      bytes += 2
    } else if (code < 0x20) {
      bytes += 6
    } else if (code <= 0x7f) {
      bytes++
    } else if (code <= 0x7ff) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4
      index++
    } else {
      bytes += 3
    }
    if (bytes > JSON_SELECTION_MAX_PROJECTED_SCALAR_BYTES) return bytes
  }
  return bytes
}

interface ProjectionBudget {
  usedBytes: number
}

function consumeProjectionBudget(budget: ProjectionBudget, bytes: number): void {
  if (budget.usedBytes + bytes > MAX_PROJECTED_OUTPUT_BYTES) {
    fail('JSON selection projected output exceeds the 4 MiB construction limit', 'JSON_SELECTION_OUTPUT_TOO_LARGE')
  }
  budget.usedBytes += bytes
}

function projectRow(
  row: Record<string, unknown>,
  sourceIndex: number,
  request: CompiledRequest,
  budget: ProjectionBudget,
): JsonSelectionRow {
  const values: Record<string, JsonScalar> = {}
  consumeProjectionBudget(budget, 48 + String(sourceIndex).length)
  for (const projection of request.projections) {
    const value = resolvePointer(row, projection.segments, projection.pointer, `row ${sourceIndex} projection`)
    if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      fail(
        `row ${sourceIndex} projection "${projection.pointer}" is not a JSON scalar`,
        'JSON_SELECTION_NON_SCALAR_PROJECTION',
      )
    }
    const scalarBytes = jsonScalarSerializedBytes(value)
    if (scalarBytes > JSON_SELECTION_MAX_PROJECTED_SCALAR_BYTES) {
      fail(
        `row ${sourceIndex} projected scalar exceeds the 64 KiB limit`,
        'JSON_SELECTION_OUTPUT_TOO_LARGE',
      )
    }
    consumeProjectionBudget(budget, projection.name.length + scalarBytes + 4)
    values[projection.name] = value
  }
  return { sourceIndex, values }
}

/**
 * Deterministically select every maximum-date tie from a bounded JSON object-array.
 * This proves selection from the exact input hash; it does not independently verify
 * the factual truth of the input document.
 */
export function selectJsonMaxTies(
  input: string | Uint8Array,
  rawRequest: JsonSelectionRequest,
): JsonSelectionResult {
  const request = compileRequest(rawRequest)
  const decoded = decodeInput(input)
  const evidenceSha256 = createHash('sha256').update(decoded.bytes).digest('hex')
  const root = parseStrictJson(decoded.text)
  if (!isRecord(root) && !(Array.isArray(root) && request.arraySegments.length === 0)) {
    fail('JSON root must be an object, or an array when arrayPointer is empty', 'JSON_SELECTION_ROOT_TYPE_MISMATCH')
  }

  const selectedArray = resolvePointer(root, request.arraySegments, request.arrayPointer, 'array pointer')
  if (!Array.isArray(selectedArray)) {
    fail(`array pointer "${request.arrayPointer}" must resolve to an array`, 'JSON_SELECTION_ARRAY_TYPE_MISMATCH')
  }
  if (selectedArray.length > JSON_SELECTION_MAX_ROWS) {
    fail(`selected array exceeds the ${JSON_SELECTION_MAX_ROWS} row limit`, 'JSON_SELECTION_ROW_LIMIT_EXCEEDED')
  }

  let rowsEligible = 0
  let bestDate: string | undefined
  let tieCount = 0
  let tieOverflow = false
  let tieIndexes: number[] = []

  for (let sourceIndex = 0; sourceIndex < selectedArray.length; sourceIndex++) {
    const row = selectedArray[sourceIndex]
    if (!isRecord(row)) {
      fail(`selected array row ${sourceIndex} must be an object`, 'JSON_SELECTION_ROW_TYPE_MISMATCH')
    }
    if (!request.where.every(entry => Object.is(
      resolvePointer(row, entry.segments, entry.pointer, `row ${sourceIndex} equality filter`),
      entry.equals,
    ))) continue
    const filterDate = requireSourceDate(
      resolvePointer(row, request.filterSegments, request.filterPointer, `row ${sourceIndex} filter`),
      `row ${sourceIndex} filter "${request.filterPointer}"`,
    )
    if (filterDate > request.cutoff) continue
    rowsEligible++
    const candidateDate = requireSourceDate(
      resolvePointer(row, request.maxSegments, request.maxPointer, `row ${sourceIndex} max`),
      `row ${sourceIndex} max "${request.maxPointer}"`,
    )

    if (bestDate === undefined || candidateDate > bestDate) {
      bestDate = candidateDate
      tieCount = 1
      tieOverflow = false
      tieIndexes = [sourceIndex]
    } else if (candidateDate === bestDate) {
      tieCount++
      if (tieIndexes.length < JSON_SELECTION_MAX_TIES) tieIndexes.push(sourceIndex)
      else tieOverflow = true
    }
  }

  if (bestDate === undefined) fail('no row satisfied the ISO-date cutoff', 'JSON_SELECTION_NO_MATCH')
  if (tieOverflow) {
    fail(`maximum-date ties exceed the ${JSON_SELECTION_MAX_TIES} row limit`, 'JSON_SELECTION_TIE_LIMIT_EXCEEDED')
  }

  const projectionBudget: ProjectionBudget = { usedBytes: 0 }
  const rows = tieIndexes.map((sourceIndex) => projectRow(
    selectedArray[sourceIndex]!,
    sourceIndex,
    request,
    projectionBudget,
  ))
  const result: JsonSelectionResult = {
    complete: true,
    truncated: false,
    evidenceSha256,
    arrayPointer: request.arrayPointer,
    filter: { pointer: request.filterPointer, lte: request.cutoff },
    ...(request.where.length === 0 ? {} : {
      where: request.where.map(entry => ({ pointer: entry.pointer, equals: entry.equals })),
    }),
    max: { pointer: request.maxPointer, value: bestDate, ties: 'all' },
    rowsScanned: selectedArray.length,
    rowsEligible,
    tieCount,
    rows,
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_OUTPUT_BYTES) {
    fail('JSON selection output exceeds the 8 MiB limit', 'JSON_SELECTION_OUTPUT_TOO_LARGE')
  }
  return result
}
