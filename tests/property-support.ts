export class DeterministicRandom {
  private state: number

  constructor(readonly seed: number) {
    this.state = (seed >>> 0) || 0x6d2b79f5
  }

  nextUint32(): number {
    let value = this.state
    value ^= value << 13
    value ^= value >>> 17
    value ^= value << 5
    this.state = value >>> 0
    return this.state
  }

  integer(minimum: number, maximum: number): number {
    if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || maximum < minimum) {
      throw new Error(`invalid deterministic integer range ${minimum}..${maximum}`)
    }
    const width = maximum - minimum + 1
    if (width <= 0 || width > 0x1_0000_0000) throw new Error('deterministic integer range is too wide')
    return minimum + (this.nextUint32() % width)
  }

  boolean(): boolean {
    return (this.nextUint32() & 1) === 1
  }

  pick<T>(values: readonly T[]): T {
    if (values.length === 0) throw new Error('cannot pick from an empty array')
    return values[this.integer(0, values.length - 1)]!
  }

  ascii(length: number, alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'): string {
    if (!Number.isSafeInteger(length) || length < 0) throw new Error('invalid deterministic string length')
    let result = ''
    for (let index = 0; index < length; index++) {
      result += alphabet[this.integer(0, alphabet.length - 1)]
    }
    return result
  }
}

function seedLabel(seed: number): string {
  return `0x${(seed >>> 0).toString(16).padStart(8, '0')}`
}

export function runProperty(
  name: string,
  seed: number,
  iterations: number,
  property: (random: DeterministicRandom, iteration: number) => void,
): void {
  const random = new DeterministicRandom(seed)
  for (let iteration = 0; iteration < iterations; iteration++) {
    try {
      property(random, iteration)
    } catch (error: unknown) {
      throw new Error(
        `${name} failed with seed=${seedLabel(seed)} iteration=${iteration}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }
}

export async function runAsyncProperty(
  name: string,
  seed: number,
  iterations: number,
  property: (random: DeterministicRandom, iteration: number) => Promise<void>,
): Promise<void> {
  const random = new DeterministicRandom(seed)
  for (let iteration = 0; iteration < iterations; iteration++) {
    try {
      await property(random, iteration)
    } catch (error: unknown) {
      throw new Error(
        `${name} failed with seed=${seedLabel(seed)} iteration=${iteration}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }
}

export function escapeJsonPointerSegment(value: string): string {
  return value.replace(/~/gu, '~0').replace(/\//gu, '~1')
}
