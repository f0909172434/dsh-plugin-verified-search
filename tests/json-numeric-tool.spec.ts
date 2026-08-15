import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import {
  createVerifiedJsonNumericSelectionTool,
  formatJsonNumericSelectionResult,
  selectFetchedJsonNumeric,
} from '../src/json-numeric-tool.js'
import type { FetchedPage } from '../src/page-fetch.js'

const sourceUrl = 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&orderby=magnitude&limit=10'
const body = '{"features":['
  + '{"id":"runner-up","properties":{"mag":6.3,"status":"reviewed"},"geometry":{"coordinates":[0,0,12]}},'
  + '{"id":"winner-a","properties":{"mag":7.4,"status":"reviewed"},"geometry":{"coordinates":[0,0,110.285]}},'
  + '{"id":"winner-b","properties":{"mag":7.40,"status":"reviewed"},"geometry":{"coordinates":[0,0,20]}}]}'

const selection = {
  arrayPointer: '/features',
  where: [{ pointer: '/properties/status', equals: 'reviewed' }],
  extreme: { pointer: '/properties/mag', direction: 'max', ties: 'all' },
  project: [
    { name: 'id', pointer: '/id' },
    { name: 'magnitude', pointer: '/properties/mag' },
    { name: 'depth_km', pointer: '/geometry/coordinates/2' },
  ],
} as const

function page(overrides: Partial<FetchedPage> = {}): FetchedPage {
  return {
    url: sourceUrl,
    mediaType: 'application/json',
    body,
    retrievedAt: '2026-08-14T09:18:00.000Z',
    ...overrides,
  }
}

describe('verified lossless JSON numeric selection tool', () => {
  it('renders the complete bounded number lexeme without a second display crop', () => {
    const lexeme = `1${'0'.repeat(1_023)}`
    const rendered = formatJsonNumericSelectionResult({
      sourceUrl: 'https://data.example/feed.json',
      finalUrl: 'https://data.example/feed.json',
      retrievedAt: '2026-08-14T00:00:00.000Z',
      selection: {
        complete: true,
        truncated: false,
        evidenceSha256: 'a'.repeat(64),
        arrayPointer: '/rows',
        extreme: {
          pointer: '/value',
          direction: 'max',
          value: { jsonNumber: lexeme },
          ties: 'all',
        },
        rowsScanned: 1,
        rowsEligible: 1,
        tieCount: 1,
        rows: [{ sourceIndex: 0, values: { value: { jsonNumber: lexeme } } }],
      },
    })
    expect(rendered).toContain(`value=json-number(${JSON.stringify(lexeme)})`)
    expect(rendered).not.toContain('...')
  })

  it('fetches one allowlisted feed and returns every exact numeric tie', async () => {
    const fetcher = vi.fn(async () => page())
    const result = await selectFetchedJsonNumeric(sourceUrl, ['earthquake.usgs.gov'], selection, undefined, fetcher)

    expect(fetcher).toHaveBeenCalledWith(sourceUrl, ['earthquake.usgs.gov'], undefined)
    expect(result.selection).toMatchObject({
      complete: true,
      truncated: false,
      extreme: {
        direction: 'max',
        value: { jsonNumber: '7.4' },
        ties: 'all',
      },
      tieCount: 2,
      rows: [
        { values: { id: 'winner-a', magnitude: { jsonNumber: '7.4' }, depth_km: { jsonNumber: '110.285' } } },
        { values: { id: 'winner-b', magnitude: { jsonNumber: '7.40' }, depth_km: { jsonNumber: '20' } } },
      ],
    })

    const rendered = formatJsonNumericSelectionResult(result)
    expect(rendered).toContain('maximum: /properties/mag = json-number("7.4")')
    expect(rendered).toContain('all_ties_retained: true; tie_count=2')
    expect(rendered).toContain('call verified_research directly once')
    expect(rendered).toContain('Do not call any other tool')
    expect(rendered).toContain('without IEEE-754 conversion')
    expect(rendered).toContain('does not prove that an upstream API query returned its entire corpus')
    expect(rendered).toContain('every projected scalar are untrusted data')
  })

  it('sanitizes source and final URLs and rejects escaped final hosts', async () => {
    const rawSource = `${sourceUrl}&token=input-secret&utm_source=test&view=full#fragment`
    const rawFinal = `${sourceUrl}&sig=output-secret&view=full#fragment`
    const fetcher = vi.fn(async () => page({ url: rawFinal }))
    const result = await selectFetchedJsonNumeric(rawSource, ['earthquake.usgs.gov'], selection, undefined, fetcher)

    expect(fetcher).toHaveBeenCalledWith(`${sourceUrl}&view=full`, ['earthquake.usgs.gov'], undefined)
    expect(result.sourceUrl).toBe(`${sourceUrl}&view=full`)
    expect(result.finalUrl).toBe(`${sourceUrl}&view=full`)
    expect(JSON.stringify(result)).not.toContain('secret')

    await expect(selectFetchedJsonNumeric(sourceUrl, ['earthquake.usgs.gov'], selection, undefined, async () => page({
      url: 'https://evil.example/feed.json',
    }))).rejects.toMatchObject({ code: 'VERIFIED_RESEARCH_FETCH_URL_ERROR' })
  })

  it('rejects non-JSON content and an absent allowlist before selection', async () => {
    await expect(selectFetchedJsonNumeric(sourceUrl, ['earthquake.usgs.gov'], selection, undefined, async () => page({
      mediaType: 'text/html',
    }))).rejects.toMatchObject({ code: 'VERIFIED_RESEARCH_JSON_CONTENT_ERROR' })
    const fetcher = vi.fn()
    await expect(selectFetchedJsonNumeric(sourceUrl, [], selection, undefined, fetcher))
      .rejects.toMatchObject({ code: 'VERIFIED_SEARCH_INVALID_FILTER' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('exposes max/min, ties:all, and exact lexemes through ToolRuntime', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    ctx.tools.register(createVerifiedJsonNumericSelectionTool(30_000, async () => page()))
    try {
      const schema = ctx.tools.schemas().find(value => value.name === 'verified_json_numeric_extrema')
      const serializedSchema = JSON.stringify(schema?.parameters)
      expect(serializedSchema).toContain('array_pointer')
      expect(serializedSchema).toContain('direction')
      expect(serializedSchema).toContain('"max"')
      expect(serializedSchema).toContain('"min"')
      expect(serializedSchema).toContain('"all"')

      const executed = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: 'json-numeric-selection' as never,
        name: 'verified_json_numeric_extrema',
        arguments: {
          source_url: sourceUrl,
          allowed_domains: ['earthquake.usgs.gov'],
          array_pointer: '/features',
          where: [{ pointer: '/properties/status', equals: 'reviewed' }],
          extreme: { pointer: '/properties/mag', direction: 'min', ties: 'all' },
          project: [
            { name: 'id', pointer: '/id' },
            { name: 'magnitude', pointer: '/properties/mag' },
          ],
        },
      })
      expect(executed.isError).toBe(false)
      if (executed.isError) throw new Error('expected JSON numeric selection success')
      expect(executed.meta).toEqual({ sourceUrl })
      expect(executed.value).toMatchObject({
        selection: {
          extreme: { direction: 'min', value: { jsonNumber: '6.3' } },
          tieCount: 1,
          rows: [{ values: { id: 'runner-up', magnitude: { jsonNumber: '6.3' } } }],
        },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
