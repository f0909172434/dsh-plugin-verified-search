import { describe, expect, it } from 'vitest'
import {
  filterAllowedSources,
  normalizeAllowedDomains,
  sourceMatchesDomain,
} from '../src/domains.js'
import {
  EvidenceFetchError,
  fetchEvidencePage,
  isPublicAddress,
  normalizeEvidenceUrl,
  type EvidenceTransport,
  type ResolvedAddress,
  type TransportResponse,
} from '../src/page-fetch.js'
import { selectJsonNumericTies } from '../src/json-numeric-selection.js'
import { projectJsonRows } from '../src/json-projection.js'
import { selectJsonMaxTies } from '../src/json-selection.js'
import {
  DeterministicRandom,
  escapeJsonPointerSegment,
  runAsyncProperty,
  runProperty,
} from './property-support.js'

const textEncoder = new TextEncoder()
const PUBLIC_ADDRESS: ResolvedAddress = { address: '93.184.216.34', family: 4 }

function label(random: DeterministicRandom, minimum = 2, maximum = 12): string {
  const length = random.integer(minimum, maximum)
  if (length === 1) return random.ascii(1, 'abcdefghijklmnopqrstuvwxyz')
  return random.ascii(1, 'abcdefghijklmnopqrstuvwxyz')
    + random.ascii(length - 2, 'abcdefghijklmnopqrstuvwxyz0123456789-')
    + random.ascii(1, 'abcdefghijklmnopqrstuvwxyz0123456789')
}

function randomCase(random: DeterministicRandom, value: string): string {
  return [...value].map(character => /[a-z]/u.test(character) && random.boolean()
    ? character.toUpperCase()
    : character).join('')
}

function response(
  statusCode = 200,
  body = 'ok',
  headers: Readonly<Record<string, string>> = { 'content-type': 'text/plain' },
): TransportResponse {
  return { statusCode, headers, bytes: textEncoder.encode(body) }
}

async function expectFetchCode(operation: Promise<unknown>, code: string): Promise<void> {
  let observed: unknown
  try {
    await operation
  } catch (error: unknown) {
    observed = error
  }
  expect(observed).toBeInstanceOf(EvidenceFetchError)
  expect((observed as EvidenceFetchError).code).toBe(code)
}

function dayFromOffset(offset: number): string {
  const milliseconds = Date.UTC(2024, 0, 1) + offset * 86_400_000
  return new Date(milliseconds).toISOString().slice(0, 10)
}

function sourceDate(random: DeterministicRandom, day: string): string {
  if (!random.boolean()) return day
  const hour = random.integer(0, 23).toString().padStart(2, '0')
  const minute = random.integer(0, 59).toString().padStart(2, '0')
  const second = random.integer(0, 59).toString().padStart(2, '0')
  return `${day}T${hour}:${minute}:${second}Z`
}

interface DecimalReference {
  readonly sign: -1 | 0 | 1
  readonly digits: string
  readonly power: number
}

function parseDecimalReference(lexeme: string): DecimalReference {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(lexeme)
  if (match === null) throw new Error(`invalid generated JSON number ${lexeme}`)
  const fraction = match[3] ?? ''
  let digits = `${match[2]}${fraction}`.replace(/^0+/u, '')
  if (digits.length === 0) return { sign: 0, digits: '0', power: 0 }
  let power = Number(match[4] ?? '0') - fraction.length
  while (digits.endsWith('0')) {
    digits = digits.slice(0, -1)
    power++
  }
  return {
    sign: match[1] === '-' ? -1 : 1,
    digits,
    power,
  }
}

function compareAbsolute(left: DecimalReference, right: DecimalReference): number {
  const leftMagnitude = left.digits.length + left.power
  const rightMagnitude = right.digits.length + right.power
  if (leftMagnitude !== rightMagnitude) return leftMagnitude < rightMagnitude ? -1 : 1
  const width = Math.max(left.digits.length, right.digits.length)
  const leftPadded = left.digits.padEnd(width, '0')
  const rightPadded = right.digits.padEnd(width, '0')
  return leftPadded === rightPadded ? 0 : leftPadded < rightPadded ? -1 : 1
}

function compareDecimal(left: DecimalReference, right: DecimalReference): number {
  if (left.sign !== right.sign) return left.sign < right.sign ? -1 : 1
  if (left.sign === 0) return 0
  const absolute = compareAbsolute(left, right)
  return left.sign === 1 ? absolute : -absolute
}

function nonzeroDigits(random: DeterministicRandom): string {
  const length = random.integer(1, 18)
  return random.ascii(1, '123456789') + random.ascii(length - 1, '0123456789')
}

function randomDecimalReference(random: DeterministicRandom): DecimalReference {
  if (random.integer(0, 9) === 0) return { sign: 0, digits: '0', power: 0 }
  return {
    sign: random.boolean() ? 1 : -1,
    digits: nonzeroDigits(random),
    power: random.integer(-300, 300),
  }
}

function formatDecimalReference(random: DeterministicRandom, value: DecimalReference): string {
  if (value.sign === 0) {
    return random.pick(['0', '-0', '0.0', '-0.000e10', '0e-200'])
  }
  const prefix = value.sign === -1 ? '-' : ''
  const style = random.integer(0, 3)
  if (style === 0 || value.digits.length === 1) {
    return `${prefix}${value.digits}e${value.power}`
  }
  if (style === 1) {
    const fraction = value.digits.slice(1)
    return `${prefix}${value.digits[0]}.${fraction}e${value.power + fraction.length}`
  }
  if (style === 2) {
    const split = random.integer(1, value.digits.length - 1)
    const fraction = value.digits.slice(split)
    return `${prefix}${value.digits.slice(0, split)}.${fraction}e${value.power + fraction.length}`
  }
  const extraZeroes = random.integer(1, 5)
  return `${prefix}${value.digits}${'0'.repeat(extraZeroes)}e${value.power - extraZeroes}`
}

function selectedNumericIndexes(lexemes: readonly string[], direction: 'max' | 'min'): readonly number[] {
  const references = lexemes.map(parseDecimalReference)
  let best = 0
  let indexes = [0]
  for (let index = 1; index < references.length; index++) {
    const comparison = compareDecimal(references[index]!, references[best]!)
    const isBetter = direction === 'max' ? comparison > 0 : comparison < 0
    if (isBetter) {
      best = index
      indexes = [index]
    } else if (comparison === 0) {
      indexes.push(index)
    }
  }
  return indexes
}

function generatedKey(random: DeterministicRandom): string {
  const length = random.integer(1, 10)
  return random.ascii(length, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789~/_-')
}

function privateIpv4(random: DeterministicRandom): string {
  const tail = (): number => random.integer(0, 255)
  switch (random.integer(0, 9)) {
    case 0: return `10.${tail()}.${tail()}.${tail()}`
    case 1: return `127.${tail()}.${tail()}.${tail()}`
    case 2: return `169.254.${tail()}.${tail()}`
    case 3: return `172.${random.integer(16, 31)}.${tail()}.${tail()}`
    case 4: return `192.168.${tail()}.${tail()}`
    case 5: return `100.${random.integer(64, 127)}.${tail()}.${tail()}`
    case 6: return `198.${random.integer(18, 19)}.${tail()}.${tail()}`
    case 7: return `192.0.2.${tail()}`
    case 8: return `198.51.100.${tail()}`
    default: return `203.0.113.${tail()}`
  }
}

describe('deterministic property and differential invariants', () => {
  it('keeps domain normalization idempotent and matching suffix-safe', () => {
    runProperty('domain normalization and matching', 0x8af1_33d1, 1_000, (random) => {
      const domain = `${label(random)}.${label(random, 2, 6)}`
      const subdomain = `${label(random)}.${domain}`
      const normalized = normalizeAllowedDomains([
        randomCase(random, domain),
        domain,
        randomCase(random, subdomain),
      ])
      expect(normalized).toEqual([domain, subdomain])
      expect(normalizeAllowedDomains(normalized)).toEqual(normalized)
      expect(sourceMatchesDomain(`https://${domain}/current`, domain)).toBe(true)
      expect(sourceMatchesDomain(`https://${label(random)}.${domain}/current`, domain)).toBe(true)
      expect(sourceMatchesDomain(`https://${domain}.evil.test/current`, domain)).toBe(false)
      expect(sourceMatchesDomain(`https://user:secret@${domain}/current`, domain)).toBe(false)
    })
  })

  it('filters generated sources without changing accepted source order', () => {
    runProperty('domain filter source order', 0xe121_c950, 750, (random) => {
      const domain = `${label(random)}.${label(random, 2, 6)}`
      const count = random.integer(1, 30)
      const sources = Array.from({ length: count }, (_, index) => {
        const allowed = random.boolean()
        const host = allowed
          ? random.boolean() ? domain : `${label(random)}.${domain}`
          : random.boolean() ? `${domain}.evil.test` : `${label(random)}.invalid`
        return { id: `source-${index}`, allowed, url: `https://${host}/item/${index}` }
      })
      const observed = filterAllowedSources(sources, [domain])
      const expected = sources.filter(source => source.allowed)
      expect(observed.sources.map(source => source.id)).toEqual(expected.map(source => source.id))
      expect(observed.filteredOut).toBe(sources.length - expected.length)
    })
  })

  it('canonicalizes generated evidence URLs idempotently and removes sensitive material', () => {
    runProperty('evidence URL canonicalization', 0x5b2d_7a44, 750, (random, iteration) => {
      const domain = `${label(random)}.${label(random, 2, 6)}`
      const host = `${label(random)}.${domain}`
      const original = `https://${host}/release/${iteration}?keep=${random.ascii(8)}&utm_source=test&gclid=tracker&api_key=secret&session_token=secret#fragment`
      const normalized = normalizeEvidenceUrl(original, [domain])
      const parsed = new URL(normalized)
      expect(parsed.protocol).toBe('https:')
      expect(parsed.hostname).toBe(host)
      expect(parsed.hash).toBe('')
      expect(parsed.searchParams.get('keep')).not.toBeNull()
      expect(parsed.searchParams.has('utm_source')).toBe(false)
      expect(parsed.searchParams.has('gclid')).toBe(false)
      expect(parsed.searchParams.has('api_key')).toBe(false)
      expect(parsed.searchParams.has('session_token')).toBe(false)
      expect(normalizeEvidenceUrl(normalized, [domain])).toBe(normalized)
    })
  })

  it('blocks every generated private IPv4 address and address-family mismatch', () => {
    runProperty('public address policy', 0x2637_9b0d, 1_000, (random) => {
      const address = privateIpv4(random)
      expect(isPublicAddress({ address, family: 4 })).toBe(false)
      expect(isPublicAddress({ address, family: 6 })).toBe(false)
    })
  })

  it('follows bounded same-origin redirect chains and blocks generated cross-origin hops', async () => {
    await runAsyncProperty('redirect state machine', 0xc89e_11a7, 100, async (random, iteration) => {
      const domain = `${label(random)}.${label(random, 2, 6)}`
      const chainLength = random.integer(1, 5)
      const paths = Array.from({ length: chainLength }, (_, index) => `/p-${iteration}-${index}-${random.ascii(5)}`)
      const calls: string[] = []
      const sameOrigin: EvidenceTransport = {
        async resolve(hostname) {
          expect(hostname).toBe(domain)
          return [PUBLIC_ADDRESS]
        },
        async request(url) {
          calls.push(url.toString())
          const index = paths.indexOf(url.pathname)
          if (index < 0) throw new Error(`unexpected generated path ${url.pathname}`)
          if (index + 1 < paths.length) return response(302, '', { location: paths[index + 1]! })
          return response(200, `body-${iteration}`)
        },
      }
      const start = `https://${domain}${paths[0]}`
      const observed = await fetchEvidencePage(start, [domain], undefined, {
        transport: sameOrigin,
        maxRedirects: paths.length - 1,
        timeoutMs: 2_000,
        bodyIdleMs: 250,
      })
      expect(observed.url).toBe(`https://${domain}${paths.at(-1)}`)
      expect(observed.body).toBe(`body-${iteration}`)
      expect(calls).toEqual(paths.map(path => `https://${domain}${path}`))

      const otherDomain = `${label(random)}.${label(random, 2, 6)}`
      const crossOrigin: EvidenceTransport = {
        async resolve() {
          return [PUBLIC_ADDRESS]
        },
        async request() {
          return response(302, '', { location: `https://${otherDomain}/final` })
        },
      }
      await expectFetchCode(
        fetchEvidencePage(start, undefined, undefined, {
          transport: crossOrigin,
          maxRedirects: 1,
          timeoutMs: 2_000,
          bodyIdleMs: 250,
        }),
        'VERIFIED_RESEARCH_FETCH_REDIRECT_ERROR',
      )
    })
  }, 20_000)

  it('round-trips generated RFC 6901 projection keys and scalar values', () => {
    runProperty('projection pointer round trip', 0xa6d4_28f3, 750, (random) => {
      const fieldCount = random.integer(1, 8)
      const row: Record<string, string | boolean | null> = {}
      const project: Array<{ name: string; pointer: string }> = []
      const expected: Record<string, string | boolean | null> = {}
      while (project.length < fieldCount) {
        const key = generatedKey(random)
        if (Object.prototype.hasOwnProperty.call(row, key)) continue
        const value = random.pick<string | boolean | null>([
          `v-${random.ascii(8)}`,
          random.boolean(),
          null,
        ])
        const name = `field_${project.length}`
        row[key] = value
        project.push({ name, pointer: `/${escapeJsonPointerSegment(key)}` })
        expected[name] = value
      }
      const result = projectJsonRows(JSON.stringify([row]), {
        arrayPointer: '',
        project,
      })
      expect(result.rows).toEqual([{ sourceIndex: 0, values: expected }])
      expect(result.pointerAudits.project.every(audit => audit.repairs.length === 0)).toBe(true)
    })
  })

  it('matches an independent source-order projection filter', () => {
    runProperty('projection source order', 0x07cf_8d61, 750, (random) => {
      const count = random.integer(2, 40)
      const rows = Array.from({ length: count }, (_, index) => ({
        id: `row-${index}`,
        enabled: index === 0 ? true : index === 1 ? false : random.boolean(),
        label: `label-${random.ascii(6)}`,
      }))
      const expected = rows
        .map((row, sourceIndex) => ({ row, sourceIndex }))
        .filter(entry => entry.row.enabled)
      const result = projectJsonRows(JSON.stringify({ rows }), {
        arrayPointer: '/rows',
        where: [{ pointer: '/enabled', equals: true }],
        project: [
          { name: 'id', pointer: '/id' },
          { name: 'label', pointer: '/label' },
        ],
      })
      expect(result.rowCount).toBe(rows.length)
      expect(result.matchCount).toBe(expected.length)
      expect(result.rows.map(row => row.sourceIndex)).toEqual(expected.map(entry => entry.sourceIndex))
      expect(result.rows.map(row => row.values.id)).toEqual(expected.map(entry => entry.row.id))
    })
  })

  it('matches an independent date cutoff and maximum-tie reference', () => {
    runProperty('date selection differential', 0xf813_4ac2, 1_000, (random) => {
      const cutoffOffset = random.integer(10, 990)
      const cutoff = dayFromOffset(cutoffOffset)
      const count = random.integer(2, 24)
      const rows = Array.from({ length: count }, (_, index) => {
        const offset = index === 0 ? random.integer(0, cutoffOffset) : random.integer(0, 1_000)
        const day = dayFromOffset(offset)
        return {
          id: `row-${index}`,
          active: index === 0 ? true : random.boolean(),
          day,
          sourceDate: sourceDate(random, day),
        }
      })
      if (random.integer(0, 3) === 0) {
        rows[1] = { ...rows[0]!, id: 'row-1', sourceDate: sourceDate(random, rows[0]!.day) }
      }
      const eligible = rows
        .map((row, sourceIndex) => ({ row, sourceIndex }))
        .filter(entry => entry.row.active && entry.row.day <= cutoff)
      const maximum = eligible.reduce(
        (current, entry) => entry.row.day > current ? entry.row.day : current,
        eligible[0]!.row.day,
      )
      const expected = eligible.filter(entry => entry.row.day === maximum)
      const input = JSON.stringify({
        rows: rows.map(row => ({ id: row.id, active: row.active, date: row.sourceDate })),
      })
      const result = selectJsonMaxTies(input, {
        arrayPointer: '/rows',
        where: [{ pointer: '/active', equals: true }],
        filter: { pointer: '/date', lte: cutoff },
        max: { pointer: '/date' },
        project: [
          { name: 'id', pointer: '/id' },
          { name: 'date', pointer: '/date' },
        ],
      })
      expect(result.max.value).toBe(maximum)
      expect(result.rowsEligible).toBe(eligible.length)
      expect(result.rows.map(row => row.sourceIndex)).toEqual(expected.map(entry => entry.sourceIndex))
      expect(result.rows.map(row => row.values.id)).toEqual(expected.map(entry => entry.row.id))
      expect(result.rows.map(row => row.values.date)).toEqual(expected.map(entry => entry.row.sourceDate))
    })
  })

  it('matches an independent exact-decimal extrema comparator', () => {
    runProperty('exact numeric differential', 0x94b7_d302, 1_250, (random) => {
      const count = random.integer(2, 18)
      const references = Array.from({ length: count }, () => randomDecimalReference(random))
      if (random.integer(0, 2) === 0) references[1] = references[0]!
      const lexemes = references.map(reference => formatDecimalReference(random, reference))
      const direction = random.boolean() ? 'max' : 'min'
      const expectedIndexes = selectedNumericIndexes(lexemes, direction)
      const input = `{"rows":[${lexemes.map((lexeme, index) =>
        `{"id":"row-${index}","value":${lexeme}}`).join(',')}]}`
      const result = selectJsonNumericTies(input, {
        arrayPointer: '/rows',
        extreme: { pointer: '/value', direction, ties: 'all' },
        project: [
          { name: 'id', pointer: '/id' },
          { name: 'value', pointer: '/value' },
        ],
      })
      expect(result.rows.map(row => row.sourceIndex)).toEqual(expectedIndexes)
      expect(result.rows.map(row => row.values.id)).toEqual(expectedIndexes.map(index => `row-${index}`))
      expect(result.extreme.value.jsonNumber).toBe(lexemes[expectedIndexes[0]!])
      expect(result.tieCount).toBe(expectedIndexes.length)
    })
  })
})
