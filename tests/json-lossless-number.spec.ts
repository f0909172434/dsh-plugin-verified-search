import { describe, expect, it } from 'vitest'
import {
  compareLosslessJsonNumbers,
  isLosslessJsonNumber,
  parseLosslessStrictJson,
  type LosslessJsonFailureHandler,
  type LosslessJsonFailureKind,
  type LosslessJsonNumber,
  type LosslessJsonPolicy,
} from '../src/json-lossless-number.js'

class LosslessJsonFailure extends Error {
  constructor(readonly kind: LosslessJsonFailureKind, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LosslessJsonFailure'
  }
}

const fail: LosslessJsonFailureHandler = (kind, message, options) => {
  throw new LosslessJsonFailure(kind, message, options)
}

function policy(overrides: Partial<LosslessJsonPolicy> = {}): LosslessJsonPolicy {
  return {
    maxDepth: 64,
    maxNumberTokens: 100,
    maxLexemeBytes: 1_024,
    fail,
    isFailure: error => error instanceof LosslessJsonFailure,
    ...overrides,
  }
}

function parse(text: string, overrides: Partial<LosslessJsonPolicy> = {}): unknown {
  return parseLosslessStrictJson(text, policy(overrides))
}

function number(value: unknown): LosslessJsonNumber {
  expect(isLosslessJsonNumber(value)).toBe(true)
  return value as LosslessJsonNumber
}

function expectFailure(operation: () => unknown, kind: LosslessJsonFailureKind): void {
  try {
    operation()
    throw new Error('expected operation to throw')
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(LosslessJsonFailure)
    expect((error as LosslessJsonFailure).kind).toBe(kind)
  }
}

describe('shared lossless JSON number engine', () => {
  it('retains source lexemes and compares arbitrary exact decimals without IEEE-754 collapse', () => {
    const root = parse(
      '{"integer":9007199254740993,"equivalent":9.007199254740993e15,'
      + '"larger":1e1000,"smaller":9.99e999,"negativeZero":-0,"positiveZero":0.0e999}',
    ) as Record<string, unknown>

    const integer = number(root.integer)
    const equivalent = number(root.equivalent)
    const larger = number(root.larger)
    const smaller = number(root.smaller)
    const negativeZero = number(root.negativeZero)
    const positiveZero = number(root.positiveZero)

    expect(integer.lexeme).toBe('9007199254740993')
    expect(equivalent.lexeme).toBe('9.007199254740993e15')
    expect(compareLosslessJsonNumbers(integer, equivalent)).toBe(0)
    expect(compareLosslessJsonNumbers(larger, smaller)).toBe(1)
    expect(compareLosslessJsonNumbers(negativeZero, positiveZero)).toBe(0)
  })

  it('preserves the shared strict-JSON duplicate, Unicode, and syntax failure boundary', () => {
    expectFailure(() => parse('{"value":1,"value":2}'), 'duplicate_key')
    expectFailure(() => parse('{"value":"\\ud800"}'), 'invalid_unicode')
    expectFailure(() => parse('{"value":01}'), 'invalid_json')
  })

  it('enforces caller-provided number-token and lexeme limits', () => {
    expectFailure(() => parse('[1,2,3]', { maxNumberTokens: 2 }), 'number_token_limit_exceeded')
    expectFailure(() => parse('[12345]', { maxLexemeBytes: 4 }), 'number_lexeme_limit_exceeded')
  })

  it('uses the caller-provided container-depth limit before materializing values', () => {
    expect(parse('[[0]]', { maxDepth: 2 })).toBeDefined()
    expectFailure(() => parse('[[[]]]', { maxDepth: 2 }), 'parse_limit_exceeded')
  })
})
