import { createHash } from 'node:crypto'
import {
  JSON_SELECTION_MAX_INPUT_BYTES,
  JSON_SELECTION_MAX_PROJECTED_SCALAR_BYTES,
  JSON_SELECTION_MAX_ROWS,
} from './json-selection.js'

const MAX_JSON_DEPTH = 64
const MAX_POINTER_LENGTH = 1_024
const MAX_POINTER_SEGMENTS = 32
const MAX_PROJECTIONS = 32
const MAX_EQUALITY_FILTERS = 4
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_PROJECTED_OUTPUT_BYTES = 4 * 1024 * 1024

/** One global bound prevents many parent rows from multiplying nested traversal. */
export const JSON_PROJECTION_MAX_TOTAL_NESTED_ROWS = JSON_SELECTION_MAX_ROWS

/** Numbers are excluded because ordinary JSON.parse cannot preserve their exact lexemes. */
export type JsonProjectionScalar = string | boolean | null

export interface JsonRowProjection {
  readonly name: string
  /** RFC 6901 JSON Pointer, resolved relative to the selected row. */
  readonly pointer: string
}

export interface JsonProjectionWhere {
  readonly pointer: string
  /** Numbers are deliberately excluded: JSON.parse cannot preserve their exact lexemes. */
  readonly equals: string | boolean | null
}

export interface JsonNestedProjectionRequest {
  /** RFC 6901 pointer relative to each matching parent row. */
  readonly arrayPointer: string
  readonly where?: readonly JsonProjectionWhere[]
  readonly project: readonly JsonRowProjection[]
}

export interface JsonProjectionRequest {
  /** RFC 6901 pointer from the JSON root to an array of objects. */
  readonly arrayPointer: string
  readonly where?: readonly JsonProjectionWhere[]
  readonly project: readonly JsonRowProjection[]
  /** At most one nested array selection, relative to every matching parent row. */
  readonly nested?: JsonNestedProjectionRequest
}

export interface JsonProjectionNestedRow {
  /** Zero-based position in its parent row's nested source array. */
  readonly sourceIndex: number
  readonly values: Readonly<Record<string, JsonProjectionScalar>>
}

export interface JsonNestedProjectionResult {
  readonly arrayPointer: string
  readonly where?: readonly JsonProjectionWhere[]
  /** Exact number of rows in this parent row's nested source array. */
  readonly rowCount: number
  readonly matchCount: number
  /** Every strict match in source order. */
  readonly rows: readonly JsonProjectionNestedRow[]
}

export interface JsonProjectionRow {
  /** Zero-based position in the top-level source array. */
  readonly sourceIndex: number
  readonly values: Readonly<Record<string, JsonProjectionScalar>>
  readonly nested?: JsonNestedProjectionResult
}

export type JsonProjectionPointerRepair =
  | {
      readonly kind: 'ascii_case'
      readonly segmentIndex: number
      readonly requestedSegment: string
      readonly effectiveSegment: string
    }
  | { readonly kind: 'root_array_fallback' }

export interface JsonProjectionPointerAudit {
  readonly requestedPointer: string
  readonly effectivePointer: string
  readonly repairs: readonly JsonProjectionPointerRepair[]
}

export interface JsonProjectionNamedPointerAudit extends JsonProjectionPointerAudit {
  readonly name: string
}

export interface JsonProjectionPointerAudits {
  readonly array: JsonProjectionPointerAudit
  readonly where: readonly JsonProjectionPointerAudit[]
  readonly project: readonly JsonProjectionNamedPointerAudit[]
  readonly nested?: {
    readonly array: JsonProjectionPointerAudit
    readonly where: readonly JsonProjectionPointerAudit[]
    readonly project: readonly JsonProjectionNamedPointerAudit[]
  }
}

export interface JsonProjectionResult {
  readonly complete: true
  readonly truncated: false
  readonly evidenceSha256: string
  readonly arrayPointer: string
  readonly where?: readonly JsonProjectionWhere[]
  readonly pointerAudits: JsonProjectionPointerAudits
  /** Exact number of rows in the selected source array. */
  readonly rowCount: number
  readonly matchCount: number
  /** Every strict match in source order; no sort-derived semantics are applied. */
  readonly rows: readonly JsonProjectionRow[]
}

export type JsonProjectionErrorCode =
  | 'JSON_PROJECTION_INVALID_REQUEST'
  | 'JSON_PROJECTION_INPUT_TOO_LARGE'
  | 'JSON_PROJECTION_INVALID_UTF8'
  | 'JSON_PROJECTION_INVALID_UNICODE'
  | 'JSON_PROJECTION_INVALID_JSON'
  | 'JSON_PROJECTION_DUPLICATE_KEY'
  | 'JSON_PROJECTION_PARSE_LIMIT_EXCEEDED'
  | 'JSON_PROJECTION_INVALID_POINTER'
  | 'JSON_PROJECTION_AMBIGUOUS_POINTER_REPAIR'
  | 'JSON_PROJECTION_INCONSISTENT_POINTER_REPAIR'
  | 'JSON_PROJECTION_POINTER_NOT_FOUND'
  | 'JSON_PROJECTION_POINTER_TYPE_MISMATCH'
  | 'JSON_PROJECTION_ROOT_TYPE_MISMATCH'
  | 'JSON_PROJECTION_ARRAY_TYPE_MISMATCH'
  | 'JSON_PROJECTION_ROW_LIMIT_EXCEEDED'
  | 'JSON_PROJECTION_ROW_TYPE_MISMATCH'
  | 'JSON_PROJECTION_NUMERIC_PROJECTION_UNSUPPORTED'
  | 'JSON_PROJECTION_NON_SCALAR_PROJECTION'
  | 'JSON_PROJECTION_OUTPUT_TOO_LARGE'

export class JsonProjectionError extends Error {
  constructor(message: string, readonly code: JsonProjectionErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'JsonProjectionError'
  }
}

interface CompiledProjection extends JsonRowProjection {
  readonly segments: readonly string[]
  readonly tracker: PointerResolutionTracker
}

interface CompiledWhere extends JsonProjectionWhere {
  readonly segments: readonly string[]
  readonly tracker: PointerResolutionTracker
}

interface CompiledNested {
  readonly arrayPointer: string
  readonly arraySegments: readonly string[]
  readonly arrayTracker: PointerResolutionTracker
  readonly where: readonly CompiledWhere[]
  readonly projections: readonly CompiledProjection[]
}

interface CompiledRequest {
  readonly arrayPointer: string
  readonly arraySegments: readonly string[]
  readonly arrayTracker: PointerResolutionTracker
  readonly where: readonly CompiledWhere[]
  readonly projections: readonly CompiledProjection[]
  readonly nested?: CompiledNested
}

interface PointerResolutionTracker {
  readonly requestedPointer: string
  resolution?: {
    readonly effectivePointer: string
    readonly repairs: readonly JsonProjectionPointerRepair[]
  }
}

function fail(message: string, code: JsonProjectionErrorCode, options?: ErrorOptions): never {
  throw new JsonProjectionError(message, code, options)
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
  if (!isRecord(value)) fail(`${label} must be an object`, 'JSON_PROJECTION_INVALID_REQUEST')
  const allowed = new Set(allowedKeys)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} contains unsupported property "${key}"`, 'JSON_PROJECTION_INVALID_REQUEST')
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail(`${label} is missing required property "${key}"`, 'JSON_PROJECTION_INVALID_REQUEST')
    }
  }
  return value
}

function parsePointer(pointer: unknown, label: string): readonly string[] {
  if (typeof pointer !== 'string') fail(`${label} must be a string`, 'JSON_PROJECTION_INVALID_POINTER')
  if (pointer.length > MAX_POINTER_LENGTH) {
    fail(`${label} exceeds ${MAX_POINTER_LENGTH} characters`, 'JSON_PROJECTION_INVALID_POINTER')
  }
  if (pointer === '') return []
  if (!pointer.startsWith('/')) fail(`${label} must be an RFC 6901 JSON Pointer`, 'JSON_PROJECTION_INVALID_POINTER')
  const rawSegments = pointer.slice(1).split('/')
  if (rawSegments.length > MAX_POINTER_SEGMENTS) {
    fail(`${label} exceeds ${MAX_POINTER_SEGMENTS} segments`, 'JSON_PROJECTION_INVALID_POINTER')
  }
  return rawSegments.map((segment) => {
    if (/~(?:[^01]|$)/u.test(segment)) {
      fail(`${label} contains an invalid RFC 6901 escape`, 'JSON_PROJECTION_INVALID_POINTER')
    }
    return segment.replace(/~1/gu, '/').replace(/~0/gu, '~')
  })
}

function pointerTracker(requestedPointer: string): PointerResolutionTracker {
  return { requestedPointer }
}

function compileWhere(value: unknown, label: string): readonly CompiledWhere[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EQUALITY_FILTERS) {
    fail(`${label} must contain 1-${MAX_EQUALITY_FILTERS} entries`, 'JSON_PROJECTION_INVALID_REQUEST')
  }
  return value.map((raw, index) => {
    const entry = assertExactObject(raw, ['pointer', 'equals'], ['pointer', 'equals'], `${label}[${index}]`)
    if (typeof entry.pointer !== 'string') {
      fail(`${label}[${index}].pointer must be a string`, 'JSON_PROJECTION_INVALID_REQUEST')
    }
    if (entry.equals !== null && typeof entry.equals !== 'string' && typeof entry.equals !== 'boolean') {
      fail(
        `${label}[${index}].equals must be a string, boolean, or null; numeric equality is unsupported`,
        'JSON_PROJECTION_INVALID_REQUEST',
      )
    }
    return {
      pointer: entry.pointer,
      segments: parsePointer(entry.pointer, `${label}[${index}].pointer`),
      tracker: pointerTracker(entry.pointer),
      equals: entry.equals,
    }
  })
}

function compileProjections(value: unknown, label: string): readonly CompiledProjection[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PROJECTIONS) {
    fail(`${label} must contain 1-${MAX_PROJECTIONS} entries`, 'JSON_PROJECTION_INVALID_REQUEST')
  }
  const names = new Set<string>()
  const pointers = new Set<string>()
  return value.map((raw, index) => {
    const projection = assertExactObject(raw, ['name', 'pointer'], ['name', 'pointer'], `${label}[${index}]`)
    if (typeof projection.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(projection.name)) {
      fail(`${label}[${index}].name must be a 1-64 character identifier`, 'JSON_PROJECTION_INVALID_REQUEST')
    }
    if (names.has(projection.name)) {
      fail(`${label} contains duplicate name "${projection.name}"`, 'JSON_PROJECTION_INVALID_REQUEST')
    }
    names.add(projection.name)
    if (typeof projection.pointer !== 'string') {
      fail(`${label}[${index}].pointer must be a string`, 'JSON_PROJECTION_INVALID_REQUEST')
    }
    const segments = parsePointer(projection.pointer, `${label}[${index}].pointer`)
    const canonicalPointer = JSON.stringify(segments)
    if (pointers.has(canonicalPointer)) {
      fail(`${label} contains a duplicate pointer`, 'JSON_PROJECTION_INVALID_REQUEST')
    }
    pointers.add(canonicalPointer)
    return {
      name: projection.name,
      pointer: projection.pointer,
      segments,
      tracker: pointerTracker(projection.pointer),
    }
  })
}

function compileRequest(input: JsonProjectionRequest): CompiledRequest {
  const request = assertExactObject(input, ['arrayPointer', 'where', 'project', 'nested'], ['arrayPointer', 'project'], 'request')
  if (typeof request.arrayPointer !== 'string') {
    fail('request.arrayPointer must be a string', 'JSON_PROJECTION_INVALID_REQUEST')
  }
  let nested: CompiledNested | undefined
  if (request.nested !== undefined) {
    const value = assertExactObject(
      request.nested,
      ['arrayPointer', 'where', 'project'],
      ['arrayPointer', 'project'],
      'request.nested',
    )
    if (typeof value.arrayPointer !== 'string') {
      fail('request.nested.arrayPointer must be a string', 'JSON_PROJECTION_INVALID_REQUEST')
    }
    nested = {
      arrayPointer: value.arrayPointer,
      arraySegments: parsePointer(value.arrayPointer, 'request.nested.arrayPointer'),
      arrayTracker: pointerTracker(value.arrayPointer),
      where: compileWhere(value.where, 'request.nested.where'),
      projections: compileProjections(value.project, 'request.nested.project'),
    }
  }
  const arraySegments = parsePointer(request.arrayPointer, 'request.arrayPointer')
  return {
    arrayPointer: request.arrayPointer,
    arraySegments,
    arrayTracker: pointerTracker(request.arrayPointer),
    where: compileWhere(request.where, 'request.where'),
    projections: compileProjections(request.project, 'request.project'),
    ...(nested === undefined ? {} : { nested }),
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
    if (this.cursor !== this.input.length) fail('JSON has trailing content', 'JSON_PROJECTION_INVALID_JSON')
  }

  private scanValue(depth: number): void {
    if (depth > MAX_JSON_DEPTH) {
      fail(`JSON nesting exceeds ${MAX_JSON_DEPTH}`, 'JSON_PROJECTION_PARSE_LIMIT_EXCEEDED')
    }
    const character = this.input[this.cursor]
    if (depth === MAX_JSON_DEPTH && (character === '{' || character === '[')) {
      fail(`JSON nesting exceeds ${MAX_JSON_DEPTH}`, 'JSON_PROJECTION_PARSE_LIMIT_EXCEEDED')
    }
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
      if (this.input[this.cursor] !== '"') fail('invalid JSON object key', 'JSON_PROJECTION_INVALID_JSON')
      const key = this.scanString()
      if (keys.has(key)) fail('JSON object contains a duplicate key', 'JSON_PROJECTION_DUPLICATE_KEY')
      keys.add(key)
      this.skipWhitespace()
      if (this.input[this.cursor] !== ':') fail('invalid JSON object separator', 'JSON_PROJECTION_INVALID_JSON')
      this.cursor++
      this.skipWhitespace()
      this.scanValue(depth)
      this.skipWhitespace()
      const separator = this.input[this.cursor]
      if (separator === '}') {
        this.cursor++
        return
      }
      if (separator !== ',') fail('invalid JSON object separator', 'JSON_PROJECTION_INVALID_JSON')
      this.cursor++
      this.skipWhitespace()
    }
    fail('unterminated JSON object', 'JSON_PROJECTION_INVALID_JSON')
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
      if (separator !== ',') fail('invalid JSON array separator', 'JSON_PROJECTION_INVALID_JSON')
      this.cursor++
      this.skipWhitespace()
    }
    fail('unterminated JSON array', 'JSON_PROJECTION_INVALID_JSON')
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
          fail('invalid JSON string', 'JSON_PROJECTION_INVALID_JSON', { cause: error })
        }
        if (typeof decoded !== 'string') fail('invalid JSON string', 'JSON_PROJECTION_INVALID_JSON')
        if (hasUnpairedSurrogate(decoded)) {
          fail('JSON strings must not contain unpaired UTF-16 surrogates', 'JSON_PROJECTION_INVALID_UNICODE')
        }
        return decoded
      }
      if (character === '\\') {
        this.cursor += this.input[this.cursor + 1] === 'u' ? 6 : 2
      } else {
        this.cursor++
      }
    }
    fail('unterminated JSON string', 'JSON_PROJECTION_INVALID_JSON')
  }

  private scanPrimitive(): void {
    const start = this.cursor
    while (this.cursor < this.input.length) {
      const character = this.input[this.cursor]!
      if (character === ',' || character === ']' || character === '}' || /\s/u.test(character)) break
      this.cursor++
    }
    if (this.cursor === start) fail('invalid JSON value', 'JSON_PROJECTION_INVALID_JSON')
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
      fail('JSON input must not contain unpaired UTF-16 surrogates', 'JSON_PROJECTION_INVALID_UNICODE')
    }
    const bytes = Buffer.from(input, 'utf8')
    if (bytes.byteLength > JSON_SELECTION_MAX_INPUT_BYTES) {
      fail('JSON input exceeds the 8 MiB limit', 'JSON_PROJECTION_INPUT_TOO_LARGE')
    }
    return { text: input, bytes }
  }
  if (!(input instanceof Uint8Array)) fail('JSON input must be a string or Uint8Array', 'JSON_PROJECTION_INVALID_REQUEST')
  if (input.byteLength > JSON_SELECTION_MAX_INPUT_BYTES) {
    fail('JSON input exceeds the 8 MiB limit', 'JSON_PROJECTION_INPUT_TOO_LARGE')
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(input), bytes: input }
  } catch (error: unknown) {
    fail('JSON input is not valid UTF-8', 'JSON_PROJECTION_INVALID_UTF8', { cause: error })
  }
}

function parseStrictJson(text: string): unknown {
  new StrictJsonScanner(text).scan()
  try {
    return JSON.parse(text) as unknown
  } catch (error: unknown) {
    fail('JSON input is invalid', 'JSON_PROJECTION_INVALID_JSON', { cause: error })
  }
}

function asciiCaseFold(value: string): string | undefined {
  let folded = ''
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code > 0x7f) return undefined
    folded += String.fromCharCode(code >= 0x41 && code <= 0x5a ? code + 0x20 : code)
  }
  return folded
}

const asciiKeyIndexes = new WeakMap<Record<string, unknown>, ReadonlyMap<string, string | null>>()

function asciiKeyIndex(value: Record<string, unknown>): ReadonlyMap<string, string | null> {
  const cached = asciiKeyIndexes.get(value)
  if (cached !== undefined) return cached
  const index = new Map<string, string | null>()
  for (const key of Object.keys(value)) {
    const folded = asciiCaseFold(key)
    if (folded === undefined) continue
    if (index.has(folded)) index.set(folded, null)
    else index.set(folded, key)
  }
  asciiKeyIndexes.set(value, index)
  return index
}

function encodedPointer(segments: readonly string[]): string {
  return segments.length === 0
    ? ''
    : `/${segments.map(segment => segment.replace(/~/gu, '~0').replace(/\//gu, '~1')).join('/')}`
}

function sameRepairs(
  left: readonly JsonProjectionPointerRepair[],
  right: readonly JsonProjectionPointerRepair[],
): boolean {
  if (left.length !== right.length) return false
  return left.every((repair, index) => {
    const other = right[index]
    if (other === undefined || repair.kind !== other.kind) return false
    return repair.kind === 'root_array_fallback'
      || (other.kind === 'ascii_case'
        && repair.segmentIndex === other.segmentIndex
        && repair.requestedSegment === other.requestedSegment
        && repair.effectiveSegment === other.effectiveSegment)
  })
}

function recordPointerResolution(
  tracker: PointerResolutionTracker,
  effectiveSegments: readonly string[],
  repairs: readonly JsonProjectionPointerRepair[],
  label: string,
): void {
  const effectivePointer = encodedPointer(effectiveSegments)
  const previous = tracker.resolution
  if (previous === undefined) {
    tracker.resolution = { effectivePointer, repairs: repairs.map(repair => ({ ...repair })) }
    return
  }
  if (previous.effectivePointer !== effectivePointer || !sameRepairs(previous.repairs, repairs)) {
    fail(
      `${label} resolved inconsistently across inspected rows`,
      'JSON_PROJECTION_INCONSISTENT_POINTER_REPAIR',
    )
  }
}

function pointerAudit(tracker: PointerResolutionTracker): JsonProjectionPointerAudit {
  return {
    requestedPointer: tracker.requestedPointer,
    effectivePointer: tracker.resolution?.effectivePointer ?? tracker.requestedPointer,
    repairs: (tracker.resolution?.repairs ?? []).map(repair => ({ ...repair })),
  }
}

function resolvePointer(
  root: unknown,
  segments: readonly string[],
  pointer: string,
  tracker: PointerResolutionTracker,
  label: string,
): unknown {
  let value = root
  const effectiveSegments: string[] = []
  const repairs: JsonProjectionPointerRepair[] = []
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    const segment = segments[segmentIndex]!
    if (Array.isArray(value)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(segment)) {
        fail(`${label} "${pointer}" contains a non-canonical array index`, 'JSON_PROJECTION_INVALID_POINTER')
      }
      const index = Number(segment)
      if (!Number.isSafeInteger(index) || index >= value.length) {
        fail(`${label} "${pointer}" was not found`, 'JSON_PROJECTION_POINTER_NOT_FOUND')
      }
      effectiveSegments.push(segment)
      value = value[index]
      continue
    }
    if (!isRecord(value)) {
      fail(`${label} "${pointer}" traverses a non-container value`, 'JSON_PROJECTION_POINTER_TYPE_MISMATCH')
    }
    let effectiveSegment = segment
    if (!Object.prototype.hasOwnProperty.call(value, segment)) {
      const folded = asciiCaseFold(segment)
      if (folded === undefined) {
        fail(`${label} "${pointer}" was not found`, 'JSON_PROJECTION_POINTER_NOT_FOUND')
      }
      const index = asciiKeyIndex(value)
      if (!index.has(folded)) {
        fail(`${label} "${pointer}" was not found`, 'JSON_PROJECTION_POINTER_NOT_FOUND')
      }
      const candidate = index.get(folded)
      if (candidate === null || candidate === undefined) {
        fail(
          `${label} "${pointer}" has an ambiguous ASCII case-insensitive key at segment ${segmentIndex}`,
          'JSON_PROJECTION_AMBIGUOUS_POINTER_REPAIR',
        )
      }
      effectiveSegment = candidate
      repairs.push({
        kind: 'ascii_case',
        segmentIndex,
        requestedSegment: segment,
        effectiveSegment,
      })
    }
    effectiveSegments.push(effectiveSegment)
    value = value[effectiveSegment]
  }
  recordPointerResolution(tracker, effectiveSegments, repairs, label)
  return value
}

function permitsRootArrayFallback(error: unknown): boolean {
  return error instanceof JsonProjectionError && [
    'JSON_PROJECTION_INVALID_POINTER',
    'JSON_PROJECTION_POINTER_NOT_FOUND',
    'JSON_PROJECTION_POINTER_TYPE_MISMATCH',
  ].includes(error.code)
}

function scalarSerializedBytes(value: JsonProjectionScalar): number {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) fail('projected value is not a JSON scalar', 'JSON_PROJECTION_NON_SCALAR_PROJECTION')
  return Buffer.byteLength(serialized, 'utf8')
}

interface ProjectionBudget {
  usedBytes: number
}

function consumeProjectionBudget(budget: ProjectionBudget, bytes: number): void {
  if (budget.usedBytes + bytes > MAX_PROJECTED_OUTPUT_BYTES) {
    fail('JSON projection output exceeds the 4 MiB construction limit', 'JSON_PROJECTION_OUTPUT_TOO_LARGE')
  }
  budget.usedBytes += bytes
}

function matchesWhere(row: Record<string, unknown>, sourceIndex: number, where: readonly CompiledWhere[], label: string): boolean {
  return where.every(entry => Object.is(
    resolvePointer(row, entry.segments, entry.pointer, entry.tracker, `${label} ${sourceIndex} equality filter`),
    entry.equals,
  ))
}

function projectValues(
  row: Record<string, unknown>,
  sourceIndex: number,
  projections: readonly CompiledProjection[],
  budget: ProjectionBudget,
  label: string,
): Readonly<Record<string, JsonProjectionScalar>> {
  const values: Record<string, JsonProjectionScalar> = {}
  for (const projection of projections) {
    const value = resolvePointer(
      row,
      projection.segments,
      projection.pointer,
      projection.tracker,
      `${label} ${sourceIndex} projection`,
    )
    if (typeof value === 'number') {
      fail(
        `${label} ${sourceIndex} projection "${projection.pointer}" is numeric; use an exact-number tool`,
        'JSON_PROJECTION_NUMERIC_PROJECTION_UNSUPPORTED',
      )
    }
    if (value !== null && typeof value !== 'string' && typeof value !== 'boolean') {
      fail(
        `${label} ${sourceIndex} projection "${projection.pointer}" is not a JSON scalar`,
        'JSON_PROJECTION_NON_SCALAR_PROJECTION',
      )
    }
    const bytes = scalarSerializedBytes(value)
    if (bytes > JSON_SELECTION_MAX_PROJECTED_SCALAR_BYTES) {
      fail(`${label} ${sourceIndex} projected scalar exceeds the 64 KiB limit`, 'JSON_PROJECTION_OUTPUT_TOO_LARGE')
    }
    consumeProjectionBudget(budget, projection.name.length + bytes + 4)
    values[projection.name] = value
  }
  return values
}

function requireObjectRows(value: readonly unknown[], label: string): readonly Record<string, unknown>[] {
  return value.map((row, sourceIndex) => {
    if (!isRecord(row)) {
      fail(`${label} row ${sourceIndex} must be an object`, 'JSON_PROJECTION_ROW_TYPE_MISMATCH')
    }
    return row
  })
}

function pointerAudits(request: CompiledRequest): JsonProjectionPointerAudits {
  return {
    array: pointerAudit(request.arrayTracker),
    where: request.where.map(entry => pointerAudit(entry.tracker)),
    project: request.projections.map(entry => ({ name: entry.name, ...pointerAudit(entry.tracker) })),
    ...(request.nested === undefined ? {} : {
      nested: {
        array: pointerAudit(request.nested.arrayTracker),
        where: request.nested.where.map(entry => pointerAudit(entry.tracker)),
        project: request.nested.projections.map(entry => ({ name: entry.name, ...pointerAudit(entry.tracker) })),
      },
    }),
  }
}

/**
 * Project every strict match from a bounded JSON object-array in source order.
 * No ranking, maximum, or inferred ordering semantics are applied.
 */
export function projectJsonRows(
  input: string | Uint8Array,
  rawRequest: JsonProjectionRequest,
): JsonProjectionResult {
  const request = compileRequest(rawRequest)
  const decoded = decodeInput(input)
  const evidenceSha256 = createHash('sha256').update(decoded.bytes).digest('hex')
  const root = parseStrictJson(decoded.text)
  if (!isRecord(root) && !Array.isArray(root)) {
    fail('JSON root must be an object or array', 'JSON_PROJECTION_ROOT_TYPE_MISMATCH')
  }

  let selected: unknown
  try {
    selected = resolvePointer(
      root,
      request.arraySegments,
      request.arrayPointer,
      request.arrayTracker,
      'array pointer',
    )
  } catch (error: unknown) {
    if (!Array.isArray(root) || request.arraySegments.length === 0 || !permitsRootArrayFallback(error)) throw error
    recordPointerResolution(
      request.arrayTracker,
      [],
      [{ kind: 'root_array_fallback' }],
      'array pointer',
    )
    selected = root
  }
  if (!Array.isArray(selected)) {
    fail(`array pointer "${request.arrayPointer}" must resolve to an array`, 'JSON_PROJECTION_ARRAY_TYPE_MISMATCH')
  }
  if (selected.length > JSON_SELECTION_MAX_ROWS) {
    fail(`selected array exceeds the ${JSON_SELECTION_MAX_ROWS} row limit`, 'JSON_PROJECTION_ROW_LIMIT_EXCEEDED')
  }
  const sourceRows = requireObjectRows(selected, 'selected array')
  const budget: ProjectionBudget = { usedBytes: 0 }
  const rows: JsonProjectionRow[] = []
  let totalNestedRows = 0

  for (let sourceIndex = 0; sourceIndex < sourceRows.length; sourceIndex++) {
    const row = sourceRows[sourceIndex]!
    if (!matchesWhere(row, sourceIndex, request.where, 'row')) continue
    consumeProjectionBudget(budget, 48 + String(sourceIndex).length)
    const values = projectValues(row, sourceIndex, request.projections, budget, 'row')
    let nestedResult: JsonNestedProjectionResult | undefined
    if (request.nested !== undefined) {
      const nestedArray = resolvePointer(
        row,
        request.nested.arraySegments,
        request.nested.arrayPointer,
        request.nested.arrayTracker,
        `row ${sourceIndex} nested array pointer`,
      )
      if (!Array.isArray(nestedArray)) {
        fail(
          `row ${sourceIndex} nested array pointer "${request.nested.arrayPointer}" must resolve to an array`,
          'JSON_PROJECTION_ARRAY_TYPE_MISMATCH',
        )
      }
      totalNestedRows += nestedArray.length
      if (nestedArray.length > JSON_SELECTION_MAX_ROWS || totalNestedRows > JSON_PROJECTION_MAX_TOTAL_NESTED_ROWS) {
        fail(
          `nested arrays exceed the ${JSON_PROJECTION_MAX_TOTAL_NESTED_ROWS} total row limit`,
          'JSON_PROJECTION_ROW_LIMIT_EXCEEDED',
        )
      }
      const nestedSourceRows = requireObjectRows(nestedArray, `row ${sourceIndex} nested array`)
      const nestedRows: JsonProjectionNestedRow[] = []
      for (let nestedSourceIndex = 0; nestedSourceIndex < nestedSourceRows.length; nestedSourceIndex++) {
        const nestedRow = nestedSourceRows[nestedSourceIndex]!
        if (!matchesWhere(nestedRow, nestedSourceIndex, request.nested.where, `row ${sourceIndex} nested row`)) continue
        consumeProjectionBudget(budget, 48 + String(nestedSourceIndex).length)
        nestedRows.push({
          sourceIndex: nestedSourceIndex,
          values: projectValues(
            nestedRow,
            nestedSourceIndex,
            request.nested.projections,
            budget,
            `row ${sourceIndex} nested row`,
          ),
        })
      }
      nestedResult = {
        arrayPointer: request.nested.arrayPointer,
        ...(request.nested.where.length === 0 ? {} : {
          where: request.nested.where.map(entry => ({ pointer: entry.pointer, equals: entry.equals })),
        }),
        rowCount: nestedSourceRows.length,
        matchCount: nestedRows.length,
        rows: nestedRows,
      }
    }
    rows.push({
      sourceIndex,
      values,
      ...(nestedResult === undefined ? {} : { nested: nestedResult }),
    })
  }

  const result: JsonProjectionResult = {
    complete: true,
    truncated: false,
    evidenceSha256,
    arrayPointer: request.arrayPointer,
    ...(request.where.length === 0 ? {} : {
      where: request.where.map(entry => ({ pointer: entry.pointer, equals: entry.equals })),
    }),
    pointerAudits: pointerAudits(request),
    rowCount: sourceRows.length,
    matchCount: rows.length,
    rows,
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_OUTPUT_BYTES) {
    fail('JSON projection output exceeds the 8 MiB limit', 'JSON_PROJECTION_OUTPUT_TOO_LARGE')
  }
  return result
}
