export type JsonPrimitiveFailureKind =
  | 'invalid_request'
  | 'input_too_large'
  | 'invalid_utf8'
  | 'invalid_unicode'
  | 'invalid_json'
  | 'duplicate_key'
  | 'parse_limit_exceeded'
  | 'invalid_pointer'
  | 'invalid_iso_date'

export type JsonPrimitiveFailureHandler = (
  kind: JsonPrimitiveFailureKind,
  message: string,
  options?: ErrorOptions,
) => never

export interface JsonPointerPolicy {
  readonly maxLength: number
  readonly maxSegments: number
  readonly fail: JsonPrimitiveFailureHandler
}

export interface JsonInputPolicy {
  readonly maxBytes: number
  readonly maxBytesLabel: string
  readonly fail: JsonPrimitiveFailureHandler
}

export interface StrictJsonPolicy {
  readonly maxDepth: number
  readonly fail: JsonPrimitiveFailureHandler
}

export interface DecodedJsonInput {
  readonly text: string
  readonly bytes: Uint8Array
}

export function parseJsonPointer(
  pointer: unknown,
  label: string,
  policy: JsonPointerPolicy,
): readonly string[] {
  if (typeof pointer !== 'string') policy.fail('invalid_pointer', `${label} must be a string`)
  if (pointer.length > policy.maxLength) {
    policy.fail('invalid_pointer', `${label} exceeds ${policy.maxLength} characters`)
  }
  if (pointer === '') return []
  if (!pointer.startsWith('/')) {
    policy.fail('invalid_pointer', `${label} must be an RFC 6901 JSON Pointer`)
  }
  const rawSegments = pointer.slice(1).split('/')
  if (rawSegments.length > policy.maxSegments) {
    policy.fail('invalid_pointer', `${label} exceeds ${policy.maxSegments} segments`)
  }
  return rawSegments.map((segment) => {
    if (/~(?:[^01]|$)/u.test(segment)) {
      policy.fail('invalid_pointer', `${label} contains an invalid RFC 6901 escape`)
    }
    return segment.replace(/~1/gu, '/').replace(/~0/gu, '~')
  })
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const day = Number(value.slice(8, 10))
  if (year < 1 || month < 1 || month > 12 || day < 1) return false
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day <= days[month - 1]!
}

export function requireIsoDate(
  value: unknown,
  label: string,
  fail: JsonPrimitiveFailureHandler,
): string {
  if (!isIsoDate(value)) {
    fail('invalid_iso_date', `${label} must be a valid ISO calendar date (YYYY-MM-DD)`)
  }
  return value
}

export function requireSourceDate(
  value: unknown,
  label: string,
  fail: JsonPrimitiveFailureHandler,
): string {
  if (isIsoDate(value)) return value
  const timestamp = typeof value === 'string'
    ? /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/u.exec(value)
    : null
  if (timestamp === null
    || !isIsoDate(timestamp[1])
    || Number(timestamp[2]) > 23
    || Number(timestamp[3]) > 59
    || Number(timestamp[4]) > 59) {
    fail('invalid_iso_date', `${label} must be an ISO calendar date or UTC RFC 3339 timestamp`)
  }
  return timestamp[1]
}

export function hasUnpairedSurrogate(value: string): boolean {
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

class StrictJsonScanner {
  private cursor = 0

  constructor(
    private readonly input: string,
    private readonly policy: StrictJsonPolicy,
  ) {}

  scan(): void {
    this.skipWhitespace()
    this.scanValue(0)
    this.skipWhitespace()
    if (this.cursor !== this.input.length) {
      this.policy.fail('invalid_json', 'JSON has trailing content')
    }
  }

  private scanValue(depth: number): void {
    if (depth > this.policy.maxDepth) {
      this.policy.fail('parse_limit_exceeded', `JSON nesting exceeds ${this.policy.maxDepth}`)
    }
    const character = this.input[this.cursor]
    if (depth === this.policy.maxDepth && (character === '{' || character === '[')) {
      this.policy.fail('parse_limit_exceeded', `JSON nesting exceeds ${this.policy.maxDepth}`)
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
      if (this.input[this.cursor] !== '"') {
        this.policy.fail('invalid_json', 'invalid JSON object key')
      }
      const key = this.scanString()
      if (keys.has(key)) {
        this.policy.fail('duplicate_key', 'JSON object contains a duplicate key')
      }
      keys.add(key)
      this.skipWhitespace()
      if (this.input[this.cursor] !== ':') {
        this.policy.fail('invalid_json', 'invalid JSON object separator')
      }
      this.cursor++
      this.skipWhitespace()
      this.scanValue(depth)
      this.skipWhitespace()
      const separator = this.input[this.cursor]
      if (separator === '}') {
        this.cursor++
        return
      }
      if (separator !== ',') {
        this.policy.fail('invalid_json', 'invalid JSON object separator')
      }
      this.cursor++
      this.skipWhitespace()
    }
    this.policy.fail('invalid_json', 'unterminated JSON object')
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
      if (separator !== ',') {
        this.policy.fail('invalid_json', 'invalid JSON array separator')
      }
      this.cursor++
      this.skipWhitespace()
    }
    this.policy.fail('invalid_json', 'unterminated JSON array')
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
          this.policy.fail('invalid_json', 'invalid JSON string', { cause: error })
        }
        if (typeof decoded !== 'string') {
          this.policy.fail('invalid_json', 'invalid JSON string')
        }
        if (hasUnpairedSurrogate(decoded)) {
          this.policy.fail('invalid_unicode', 'JSON strings must not contain unpaired UTF-16 surrogates')
        }
        return decoded
      }
      if (character === '\\') {
        this.cursor += this.input[this.cursor + 1] === 'u' ? 6 : 2
      } else {
        this.cursor++
      }
    }
    this.policy.fail('invalid_json', 'unterminated JSON string')
  }

  private scanPrimitive(): void {
    const start = this.cursor
    while (this.cursor < this.input.length) {
      const character = this.input[this.cursor]!
      if (character === ',' || character === ']' || character === '}' || /\s/u.test(character)) break
      this.cursor++
    }
    if (this.cursor === start) this.policy.fail('invalid_json', 'invalid JSON value')
  }

  private skipWhitespace(): void {
    while (this.cursor < this.input.length) {
      const character = this.input[this.cursor]
      if (character !== ' ' && character !== '\t' && character !== '\r' && character !== '\n') break
      this.cursor++
    }
  }
}

export function decodeJsonInput(
  input: string | Uint8Array,
  policy: JsonInputPolicy,
): DecodedJsonInput {
  if (typeof input === 'string') {
    if (hasUnpairedSurrogate(input)) {
      policy.fail('invalid_unicode', 'JSON input must not contain unpaired UTF-16 surrogates')
    }
    const bytes = Buffer.from(input, 'utf8')
    if (bytes.byteLength > policy.maxBytes) {
      policy.fail('input_too_large', `JSON input exceeds the ${policy.maxBytesLabel} limit`)
    }
    return { text: input, bytes }
  }
  if (!(input instanceof Uint8Array)) {
    policy.fail('invalid_request', 'JSON input must be a string or Uint8Array')
  }
  if (input.byteLength > policy.maxBytes) {
    policy.fail('input_too_large', `JSON input exceeds the ${policy.maxBytesLabel} limit`)
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(input), bytes: input }
  } catch (error: unknown) {
    policy.fail('invalid_utf8', 'JSON input is not valid UTF-8', { cause: error })
  }
}

export function scanStrictJson(text: string, policy: StrictJsonPolicy): void {
  new StrictJsonScanner(text, policy).scan()
}

export function parseStrictJson(text: string, policy: StrictJsonPolicy): unknown {
  scanStrictJson(text, policy)
  try {
    return JSON.parse(text)
  } catch (error: unknown) {
    policy.fail('invalid_json', 'JSON input is invalid', { cause: error })
  }
}
