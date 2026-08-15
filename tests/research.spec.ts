import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createVerifiedResearchTool, formatResearchResult, research } from '../src/research.js'
import type { PageFetcher } from '../src/research.js'
import { VerifiedSearchError } from '../src/provider.js'
import { EvidenceFetchError } from '../src/page-fetch.js'
import type { FetchedPage } from '../src/page-fetch.js'
import type { SearchOptions, VerifiedSearchResult } from '../src/types.js'

const options: SearchOptions = {
  apiKey: 'test-key',
  apiKeyRef: 'DEEPSEEK_API_KEY',
  baseURL: 'https://api.deepseek.test/v1',
  model: 'deepseek-v4-flash',
  apiVersion: '2023-06-01',
  maxTokens: 1,
  maxUses: 1,
  maxResults: 8,
  recordRequest: vi.fn(),
}

afterEach(() => vi.unstubAllGlobals())

function result(
  urls: readonly string[],
  excerpts: Readonly<Record<string, string>> = {},
  overrides: Partial<VerifiedSearchResult> = {},
): VerifiedSearchResult {
  return {
    sources: urls.map(url => ({ url, ...(excerpts[url] === undefined ? {} : { snippet: excerpts[url] }) })),
    truncated: false,
    filteredOut: 0,
    ...overrides,
  }
}

function page(url: string, body: string): FetchedPage {
  return {
    url,
    mediaType: 'text/plain',
    body,
    retrievedAt: '2026-08-14T00:00:00.000Z',
  }
}

const relevantFetcher: PageFetcher = async url => page(url, [
  'compare alpha beta gamma current version first fallback official model',
  'broken good comparison barrier reserve primary gap shared source retry enrichment',
  'system failure active queued evidence 2026 08 14',
  url,
].join(' '))

const irrelevantFetcher: PageFetcher = async url => page(url, 'unrelated material without requested terms')

function documentScope(...mustInclude: string[]) {
  return { kind: 'document' as const, mustInclude }
}

describe('bounded research coordinator', () => {
  it('runs at most two lanes concurrently and round-robins before the global cap', async () => {
    let active = 0
    let maxActive = 0
    const calls: Array<{ query: string; domains?: readonly string[]; signal?: AbortSignal }> = []
    const controller = new AbortController()
    const runner = vi.fn(async (request, _options: SearchOptions, signal?: AbortSignal) => {
      active++
      maxActive = Math.max(maxActive, active)
      calls.push({
        query: request.query,
        ...(request.allowedDomains === undefined ? {} : { domains: request.allowedDomains }),
        ...(signal === undefined ? {} : { signal }),
      })
      await new Promise(resolve => setTimeout(resolve, 5))
      active--
      return result([
        `https://${request.query}.example/1`,
        `https://${request.query}.example/2`,
      ], { [`https://${request.query}.example/1`]: `${request.query} evidence` })
    })

    const output = await research({
      query: 'compare alpha beta gamma as of 2026-08-14',
      lanes: [
        { id: 'a', query: 'alpha', allowedDomains: ['alpha.example'] },
        { id: 'b', query: 'beta', allowedDomains: ['beta.example'] },
        { id: 'c', query: 'gamma', allowedDomains: ['gamma.example'] },
      ],
    }, { ...options, maxUses: 5 }, controller.signal, runner, 4, relevantFetcher)

    expect(maxActive).toBe(2)
    expect(calls.map(call => call.domains)).toEqual([['alpha.example'], ['beta.example'], ['gamma.example']])
    expect(calls.every(call => call.signal === controller.signal)).toBe(true)
    expect(output.sources.map(source => `${source.lane}:${source.url}`)).toEqual([
      'a:https://alpha.example/1',
      'b:https://beta.example/1',
      'c:https://gamma.example/1',
    ])
    expect(output.truncated).toBe(false)
    expect(output.allLanesFetched).toBe(true)
    expect(runner.mock.calls.every(call => (call[1] as SearchOptions).maxUses === 2)).toBe(true)
  })

  it('uses one predeclared gap query only when the first pass has no fetched evidence', async () => {
    const runner = vi.fn(async (request) => request.query === 'first'
      ? result(['https://official.example/discovery'])
      : result(['https://official.example/evidence'], {
          'https://official.example/evidence': 'full cited excerpt',
        }))
    const output = await research({
      query: 'current version as of 2026-08-14',
      lanes: [{
        id: 'official',
        query: 'first',
        gapQuery: 'fallback',
        allowedDomains: ['official.example'],
      }],
    }, options, undefined, runner, 16, async url => page(
      url,
      url.endsWith('/evidence') ? 'fallback current version official evidence' : 'unrelated material',
    ))

    expect(runner).toHaveBeenCalledTimes(2)
    expect(output.lanes[0]).toMatchObject({ status: 'fetched', attempts: 2, sourceCount: 2, evidenceCount: 1 })
    expect(output.sources.find(source => source.evidence)?.round).toBe(1)
    expect(output.allLanesFetched).toBe(true)
  })

  it('fetches a validated canonical seed when provider discovery returns no sources', async () => {
    const runner = vi.fn(async () => result([]))
    const fetcher = vi.fn(async (url: string) => page(url, 'current flagship model ID model-v5-pro'))
    const output = await research({
      query: 'current flagship model ID',
      lanes: [{
        id: 'official',
        query: 'current flagship model ID',
        allowedDomains: ['docs.example.com'],
        seedUrls: ['https://docs.example.com/models'],
      }],
    }, options, undefined, runner, 16, fetcher)

    expect(runner).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledWith(
      'https://docs.example.com/models',
      ['docs.example.com'],
      undefined,
    )
    expect(output.sources).toMatchObject([{
      lane: 'official',
      origin: 'seed',
      url: 'https://docs.example.com/models',
      evidence: { excerpt: 'current flagship model ID model-v5-pro' },
    }])
    expect(output.allLanesFetched).toBe(true)
  })

  it('extracts one exact excerpt per required claim from the same fetched seed page', async () => {
    const runner = vi.fn(async () => result([]))
    const fetcher = vi.fn(async (url: string) => page(url, [
      'Model identifier model-v5-pro.',
      'Context window supports one million tokens.',
      'Input price is two dollars per million tokens.',
    ].join('\n')))
    const output = await research({
      query: 'three required facts',
      lanes: [{
        id: 'official',
        query: 'official product facts',
        requiredClaims: [
          { id: 'model_id', query: 'model identifier model-v5-pro', evidenceMustInclude: ['Model identifier'], scope: documentScope('Model identifier') },
          { id: 'context', query: 'context window million tokens', evidenceMustInclude: ['Context window'], scope: documentScope('Context window') },
          { id: 'price', query: 'input price dollars million', evidenceMustInclude: ['Input price'], scope: documentScope('Input price') },
        ],
        allowedDomains: ['docs.example.com'],
        seedUrls: ['https://docs.example.com/models'],
      }],
    }, options, undefined, runner, 3, fetcher)

    expect(fetcher).toHaveBeenCalledOnce()
    expect(runner).not.toHaveBeenCalled()
    expect(output.allClaimsCovered).toBe(true)
    expect(output.unresolvedClaims).toEqual([])
    expect(output.lanes[0]).toMatchObject({
      status: 'fetched',
      evidenceCount: 3,
      stopReason: 'all_claims_covered',
      seedChecks: [{ status: 'covered', coveredClaimIds: ['model_id', 'context', 'price'] }],
    })
    expect(output.sources).toHaveLength(1)
    expect(output.sources[0]!.claimEvidence?.map(value => value.claimId)).toEqual(['model_id', 'context', 'price'])
    for (const evidence of output.sources[0]!.claimEvidence ?? []) {
      expect(evidence.excerpt.length).toBe(evidence.excerptEnd - evidence.excerptStart)
      expect(evidence.contentSha256).toBe(output.sources[0]!.evidence?.contentSha256)
    }
  })

  it('runs the predeclared gap query while any explicit claim remains unresolved', async () => {
    const runner = vi.fn(async request => request.query === 'first search'
      ? result(['https://official.example/first'])
      : result(['https://official.example/second']))
    const fetcher = vi.fn(async (url: string) => page(
      url,
      url.endsWith('/first') ? 'alpha identifier model-a1' : 'beta capacity 100000 tokens',
    ))
    const output = await research({
      query: 'two independently required facts',
      lanes: [{
        id: 'official',
        query: 'first search',
        gapQuery: 'fallback beta search',
        allowedDomains: ['official.example'],
        requiredClaims: [
          { id: 'alpha', query: 'alpha identifier model-a1', evidenceMustInclude: ['alpha identifier'], scope: documentScope('alpha') },
          { id: 'beta', query: 'beta capacity tokens', evidenceMustInclude: ['beta capacity'], scope: documentScope('beta') },
        ],
      }],
    }, options, undefined, runner, 2, fetcher)

    expect(runner).toHaveBeenCalledTimes(2)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(output.lanes[0]).toMatchObject({ status: 'fetched', attempts: 2, evidenceCount: 2 })
    expect(output.sources.flatMap(source => source.claimEvidence ?? []).map(value => value.claimId).toSorted())
      .toEqual(['alpha', 'beta'])
  })

  it('does not stop on a generic calendar header that misses a normalized-substring evidence postcondition', async () => {
    const runner = vi.fn(async request => request.query === 'first calendar query'
      ? result(['https://official.example/generic'])
      : result(['https://official.example/july']))
    const fetcher = vi.fn(async (url: string) => page(url, url.endsWith('/generic')
      ? 'The committee holds eight scheduled meetings. 2026 FOMC Meetings.'
      : '2026 FOMC Meetings\nJuly 28-29, 2026'))
    const output = await research({
      query: 'latest completed scheduled meeting',
      lanes: [{
        id: 'calendar',
        query: 'first calendar query',
        gapQuery: 'July 2026 scheduled FOMC meeting date range',
        allowedDomains: ['official.example'],
        requiredClaims: [{
          id: 'meeting_dates',
          query: 'scheduled FOMC meeting date range July 2026',
          evidenceMustInclude: ['July', '2026'],
          scope: {
            kind: 'event_row',
            mustInclude: ['July', '2026'],
            temporalAnchor: { kind: 'year_month', role: 'event', value: '2026-07' },
          },
        }],
      }],
    }, options, undefined, runner, 2, fetcher)

    expect(runner).toHaveBeenCalledTimes(2)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(output.allClaimsCovered).toBe(true)
    expect(output.sources[0]?.claimEvidence?.[0]).toMatchObject({
      claimId: 'meeting_dates',
      matchedRequiredPhrases: ['July', '2026'],
    })
  })

  it('reports every seed URL terminal state and skips later seeds after complete coverage', async () => {
    const runner = vi.fn(async () => result([]))
    const fetcher = vi.fn(async (url: string) => page(
      url,
      url.endsWith('/first') ? 'alpha identifier model-a1 beta capacity tokens' : 'must not fetch',
    ))
    const output = await research({
      query: 'seed status',
      lanes: [{
        id: 'official',
        query: 'seed status',
        allowedDomains: ['docs.example.com'],
        seedUrls: ['https://docs.example.com/first', 'https://docs.example.com/second'],
        requiredClaims: [
          { id: 'alpha', query: 'alpha identifier model-a1', evidenceMustInclude: ['alpha identifier'], scope: documentScope('alpha') },
          { id: 'beta', query: 'beta capacity tokens', evidenceMustInclude: ['beta capacity'], scope: documentScope('beta') },
        ],
      }],
    }, options, undefined, runner, 2, fetcher)

    expect(fetcher).toHaveBeenCalledOnce()
    expect(runner).not.toHaveBeenCalled()
    expect(output.lanes[0]!.seedChecks).toMatchObject([
      { url: 'https://docs.example.com/first', status: 'covered', coveredClaimIds: ['alpha', 'beta'] },
      { url: 'https://docs.example.com/second', status: 'skipped', coveredClaimIds: [] },
    ])
  })

  it('rejects invalid required claims and insufficient retained-source capacity before effects', async () => {
    const runner = vi.fn()
    const fetcher = vi.fn()
    await expect(research({
      query: 'q',
      lanes: [{
        id: 'claims',
        query: 'q',
        requiredClaims: Array.from({ length: 7 }, (_, index) => ({
          id: `c${index}`,
          query: `claim ${index}`,
          evidenceMustInclude: [`claim ${index}`],
          scope: documentScope(`claim ${index}`),
        })),
      }],
    }, options, undefined, runner, 16, fetcher)).rejects.toThrow(/required_claims must contain 1-6/u)
    await expect(research({
      query: 'q',
      lanes: [{
        id: 'claims',
        query: 'q',
        requiredClaims: [
          { id: 'a', query: 'claim alpha', evidenceMustInclude: ['claim alpha'], scope: documentScope('claim alpha') },
          { id: 'b', query: 'claim beta', evidenceMustInclude: ['claim beta'], scope: documentScope('claim beta') },
        ],
      }],
    }, options, undefined, runner, 1, fetcher)).rejects.toThrow(/from 2 to 32/u)
    expect(runner).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('accepts the complete four-lane, twenty-four-claim model-facing shape', async () => {
    const runner = vi.fn()
    const fetcher = vi.fn(async (url: string) => {
      const lane = new URL(url).hostname.split('.')[0]!
      return page(url, [
        `${lane} official document`,
        ...Array.from({ length: 6 }, (_, index) => `${lane} claim ${index} answer`),
      ].join('\n'))
    })
    const lanes = Array.from({ length: 4 }, (_, laneIndex) => {
      const lane = `lane${laneIndex}`
      return {
        id: lane,
        query: `${lane} official facts`,
        gapQuery: `${lane} official fallback`,
        allowedDomains: [`${lane}.example`],
        seedUrls: [`https://${lane}.example/source`],
        requiredClaims: Array.from({ length: 6 }, (_, claimIndex) => ({
          id: `claim${claimIndex}`,
          query: `${lane} claim ${claimIndex} answer`,
          evidenceMustInclude: [`${lane} claim ${claimIndex} answer`],
          scope: documentScope(`${lane} official document`),
        })),
      }
    })

    const output = await research({
      query: 'complete twenty-four-claim official comparison',
      lanes,
    }, options, undefined, runner, 24, fetcher)

    expect(runner).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(output.lanes.flatMap(lane => lane.claims)).toHaveLength(24)
    expect(output.sources).toHaveLength(4)
    expect(output.allClaimsCovered).toBe(true)
    expect(output.unresolvedClaims).toEqual([])
    expect(output.sources.flatMap(source => source.claimEvidence ?? [])).toHaveLength(24)
  })

  it('rejects explicit claims without bounded normalized-substring evidence postconditions', async () => {
    const runner = vi.fn()
    await expect(research({
      query: 'q',
      lanes: [{
        id: 'claims',
        query: 'q',
        requiredClaims: [{ id: 'a', query: 'claim alpha' } as never],
      }],
    }, options, undefined, runner)).rejects.toThrow(/evidence_must_include must contain 1-8/u)
    expect(runner).not.toHaveBeenCalled()
  })

  it('retries a transiently rejected cached page during the gap round', async () => {
    const runner = vi.fn(async () => result(['https://official.example/current']))
    const fetcher = vi.fn(async (url: string) => {
      if (fetcher.mock.calls.length === 1) {
        throw new EvidenceFetchError('temporary failure', 'VERIFIED_RESEARCH_FETCH_NETWORK_ERROR')
      }
      return page(url, 'fallback official current evidence')
    })
    const output = await research({
      query: 'current evidence',
      lanes: [{
        id: 'official',
        query: 'primary official query',
        gapQuery: 'fallback official current evidence',
        allowedDomains: ['official.example'],
      }],
    }, options, undefined, runner, 16, fetcher)

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(output.lanes[0]).toMatchObject({ status: 'fetched', attempts: 2, fetchCount: 2, fetchErrorCount: 1 })
  })

  it('skips known binary discovery URLs before selecting a fetchable HTML candidate', async () => {
    const runner = vi.fn(async () => result([
      'https://official.example/current/printable/pdf',
      'https://official.example/current-page',
    ]))
    const fetcher = vi.fn(async (url: string) => page(url, 'official current answer evidence'))
    const output = await research({
      query: 'official current answer evidence',
      lanes: [{
        id: 'official',
        query: 'official current answer evidence',
        gapQuery: 'official fallback answer evidence',
        allowedDomains: ['official.example'],
        requiredClaims: [{
          id: 'answer',
          query: 'official current answer evidence',
          evidenceMustInclude: ['current answer'],
          scope: documentScope('official'),
        }],
      }],
    }, options, undefined, runner, 24, fetcher)

    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledWith(
      'https://official.example/current-page',
      ['official.example'],
      undefined,
    )
    expect(output.allClaimsCovered).toBe(true)
    expect(output.sources.map(source => source.url)).toEqual(['https://official.example/current-page'])
  })

  it('does not run a gap query after a fetched first pass', async () => {
    const runner = vi.fn(async () => result(['https://official.example/current'], {
      'https://official.example/current': 'current evidence',
    }))
    const output = await research({
      query: 'current version as of 2026-08-14',
      lanes: [{ id: 'official', query: 'first', gapQuery: 'unused' }],
    }, options, undefined, runner, 16, relevantFetcher)

    expect(runner).toHaveBeenCalledOnce()
    expect(output.lanes[0]).toMatchObject({ status: 'fetched', attempts: 1 })
  })

  it('reports partial lane failures without leaking provider details', async () => {
    const runner = vi.fn(async (request) => {
      if (request.query === 'broken') {
        throw new VerifiedSearchError('provider detail must not enter output', 'VERIFIED_SEARCH_PROVIDER_ERROR')
      }
      return result(['https://good.example/current'], {
        'https://good.example/current': 'good evidence',
      }, { filteredOut: 2 })
    })
    const output = await research({
      query: 'comparison',
      lanes: [
        { id: 'broken', query: 'broken' },
        { id: 'good', query: 'good' },
      ],
    }, options, undefined, runner, 16, relevantFetcher)
    const rendered = formatResearchResult(output)

    expect(output.allLanesFetched).toBe(false)
    expect(output.unresolvedLanes).toEqual(['broken'])
    expect(output.lanes[0]).toMatchObject({ status: 'failed', errorCode: 'VERIFIED_SEARCH_PROVIDER_ERROR' })
    expect(output.filteredOut).toBe(2)
    expect(rendered).not.toContain('provider detail')
    expect(rendered).toContain('Evidence remains unresolved for lane(s): broken')
  })

  it('waits for active workers and never starts queued lanes after cancellation', async () => {
    const controller = new AbortController()
    let started = 0
    let finished = 0
    const runner = vi.fn((_request, _options: SearchOptions, signal?: AbortSignal) => new Promise<VerifiedSearchResult>((_resolve, reject) => {
      started++
      signal?.addEventListener('abort', () => {
        setTimeout(() => {
          finished++
          reject(new VerifiedSearchError('aborted', 'VERIFIED_SEARCH_ABORTED'))
        }, 5)
      }, { once: true })
    }))
    const pending = research({
      query: 'cancel',
      lanes: [
        { id: 'a', query: 'a' },
        { id: 'b', query: 'b' },
        { id: 'queued', query: 'queued' },
      ],
    }, options, controller.signal, runner, 16, relevantFetcher)
    await vi.waitFor(() => expect(started).toBe(2))
    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: 'VERIFIED_SEARCH_ABORTED' })
    expect(finished).toBe(2)
    expect(started).toBe(2)
  })

  it('validates every lane before dispatching world effects', async () => {
    const runner = vi.fn()
    await expect(research({
      query: 'q',
      lanes: [
        { id: 'valid', query: 'q' },
        { id: 'invalid id', query: 'q' },
      ],
    }, options, undefined, runner, 16, irrelevantFetcher)).rejects.toMatchObject({ code: 'VERIFIED_RESEARCH_INVALID_REQUEST' })
    await expect(research({
      query: 'q',
      lanes: [{ id: 'same', query: 'same query', gapQuery: ' same query ' }],
    }, options, undefined, runner, 16, irrelevantFetcher)).rejects.toThrow(/gap_query must differ/u)
    await expect(research({
      query: 'q',
      lanes: Array.from({ length: 5 }, (_, index) => ({ id: `lane-${index}`, query: 'q' })),
    }, options, undefined, runner, 16, irrelevantFetcher)).rejects.toThrow(/1-4 lanes/u)
    await expect(research({
      query: 'q',
      lanes: [{ id: 'seed', query: 'q', seedUrls: ['https://docs.example.com/models'] }],
    }, options, undefined, runner, 16, irrelevantFetcher)).rejects.toThrow(/seed_urls requires allowed_domains/u)
    await expect(research({
      query: 'q',
      lanes: [{
        id: 'seed',
        query: 'q',
        allowedDomains: ['docs.example.com'],
        seedUrls: ['http://docs.example.com/models'],
      }],
    }, options, undefined, runner, 16, irrelevantFetcher)).rejects.toThrow(/seed_urls must be HTTPS/u)
    await expect(research({
      query: 'q',
      lanes: [{
        id: 'seed',
        query: 'q',
        allowedDomains: ['docs.example.com'],
        seedUrls: ['https://evil.example/models'],
      }],
    }, options, undefined, runner, 16, irrelevantFetcher)).rejects.toThrow(/seed_urls must be HTTPS/u)
    expect(runner).not.toHaveBeenCalled()
  })

  it('finishes every first pass before any gap query', async () => {
    const order: string[] = []
    const runner = vi.fn(async (request) => {
      order.push(request.query)
      return result([`https://${request.query}.example`])
    })
    await research({
      query: 'barrier',
      lanes: [
        { id: 'a', query: 'a-first', gapQuery: 'a-gap' },
        { id: 'b', query: 'b-first', gapQuery: 'b-gap' },
        { id: 'c', query: 'c-first', gapQuery: 'c-gap' },
      ],
    }, options, undefined, runner, 16, irrelevantFetcher)

    expect(order.slice(0, 3).toSorted()).toEqual(['a-first', 'b-first', 'c-first'])
    expect(order.slice(3).toSorted()).toEqual(['a-gap', 'b-gap', 'c-gap'])
  })

  it('reserves one fetched excerpt per lane before discovery-only sources', async () => {
    const runner = vi.fn(async (request) => result([
      `https://${request.query}.example/discovery`,
      `https://${request.query}.example/evidence`,
    ], { [`https://${request.query}.example/evidence`]: `${request.query} excerpt` }))
    const output = await research({
      query: 'reserve',
      lanes: [
        { id: 'a', query: 'alpha' },
        { id: 'b', query: 'beta' },
      ],
    }, options, undefined, runner, 2, relevantFetcher)

    expect(output.sources).toHaveLength(2)
    expect(output.sources.every(source => source.evidence !== undefined)).toBe(true)
    expect(output.sources.map(source => source.lane)).toEqual(['a', 'b'])
    expect(output.allLanesFetched).toBe(true)
  })

  it('enriches the same retry URL and preserves its gap round', async () => {
    const runner = vi.fn(async (request) => request.query === 'primary'
      ? result(['https://same.example/page'])
      : result(['https://same.example/page'], { 'https://same.example/page': 'gap excerpt' }))
    const output = await research({
      query: 'retry enrichment',
      lanes: [{ id: 'same', query: 'primary', gapQuery: 'gap' }],
    }, options, undefined, runner, 16, async url => page(url, 'gap evidence only'))

    expect(output.sources).toMatchObject([{
      lane: 'same',
      round: 1,
      url: 'https://same.example/page',
      snippet: 'gap excerpt',
      evidence: { excerpt: 'gap evidence only' },
    }])
    expect(output.lanes[0]).toMatchObject({ status: 'fetched', sourceCount: 1, evidenceCount: 1 })
  })

  it('retains the same URL separately for each lane attribution', async () => {
    const runner = vi.fn(async (request) => result(['https://shared.example/page'], {
      'https://shared.example/page': `${request.query} excerpt`,
    }))
    const output = await research({
      query: 'shared source',
      lanes: [
        { id: 'a', query: 'alpha' },
        { id: 'b', query: 'beta' },
      ],
    }, options, undefined, runner, 2, relevantFetcher)

    expect(output.sources.map(source => [source.lane, source.evidence?.excerpt.includes(source.lane === 'a' ? 'alpha' : 'beta')])).toEqual([
      ['a', true],
      ['b', true],
    ])
  })

  it('ranks an explicit URL-path candidate ahead of provider order before fetching', async () => {
    const runner = vi.fn(async () => result([
      'https://api-docs.example.com/quick_start/pricing/',
      'https://api-docs.example.com/api/list-models/',
    ]))
    const fetcher = vi.fn(async (url: string) => page(
      url,
      url.includes('/api/list-models/')
        ? 'Model ID deepseek-v4-pro and deepseek-v4-flash'
        : 'Pricing overview without identifiers',
    ))
    const output = await research({
      query: 'DeepSeek API model IDs',
      lanes: [{
        id: 'deepseek',
        query: 'site:api-docs.example.com/api/list-models DeepSeek model IDs 2026-08-14',
        allowedDomains: ['api-docs.example.com'],
      }],
    }, options, undefined, runner, 16, fetcher)

    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]![0]).toContain('/api/list-models/')
    expect(output.sources[0]).toMatchObject({
      url: 'https://api-docs.example.com/api/list-models/',
      evidence: { excerpt: 'Model ID deepseek-v4-pro and deepseek-v4-flash' },
    })
    expect(output.allLanesFetched).toBe(true)
  })

  it('ranks a Chinese title match ahead of an unrelated first candidate', async () => {
    const runner = vi.fn(async () => ({
      ...result([
        'https://docs.example.com/unrelated',
        'https://docs.example.com/current',
      ]),
      sources: [
        { url: 'https://docs.example.com/unrelated', title: 'Unrelated pricing' },
        { url: 'https://docs.example.com/current', title: '\u76ee\u524d\u65d7\u8266\u6a21\u578b\u8b58\u5225\u78bc' },
      ],
    }))
    const fetcher = vi.fn(async (url: string) => page(url, '\u76ee\u524d\u65d7\u8266\u6a21\u578b\u8b58\u5225\u78bc model-v4-pro'))
    const output = await research({
      query: '\u76ee\u524d\u65d7\u8266\u6a21\u578b\u8b58\u5225\u78bc',
      lanes: [{
        id: 'zh',
        query: '\u76ee\u524d\u65d7\u8266\u6a21\u578b\u8b58\u5225\u78bc',
        allowedDomains: ['docs.example.com'],
      }],
    }, options, undefined, runner, 16, fetcher)

    expect(fetcher.mock.calls[0]![0]).toContain('/current')
    expect(output.allLanesFetched).toBe(true)
  })

  it('post-filters injected runner sources and rejects an injected fetch redirect escape', async () => {
    const runner = vi.fn(async () => result([
      'https://evil.example/current',
      'https://official.example/current',
    ]))
    const output = await research({
      query: 'official current',
      lanes: [{ id: 'official', query: 'official current', allowedDomains: ['official.example'] }],
    }, options, undefined, runner, 16, relevantFetcher)
    expect(output.filteredOut).toBe(1)
    expect(output.sources.every(source => source.url.includes('official.example'))).toBe(true)

    await expect(research({
      query: 'official current',
      lanes: [{ id: 'official', query: 'official current', allowedDomains: ['official.example'] }],
    }, options, undefined, async () => result(['https://official.example/current']), 16, async () => page(
      'https://evil.example/redirected',
      'official current evidence',
    ))).rejects.toMatchObject({ code: 'VERIFIED_RESEARCH_INVARIANT' })
  })

  it('accepts only the explicit EUR-Lex to official Cellar alternate provenance', async () => {
    const source = 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32024R1689'
    const final = 'https://publications.europa.eu/resource/cellar/official-item/DOC_1'
    const request = {
      query: 'Article 113 application date',
      lanes: [{
        id: 'law',
        query: 'Article 113 application date',
        allowedDomains: ['eur-lex.europa.eu', 'publications.europa.eu'],
        seedUrls: [source],
      }],
    } as const
    const output = await research(request, options, undefined, async () => result([]), 16, async () => ({
      ...page(final, 'Article 113 application date 2 August 2026'),
      mediaType: 'application/xhtml+xml',
      derivedFrom: source,
    }))
    expect(output.allClaimsCovered).toBe(true)
    expect(output.sources[0]?.evidence?.finalUrl).toBe(final)

    await expect(research(request, options, undefined, async () => result([]), 16, async () => ({
      ...page('https://evil.example/resource/cellar/forged', 'Article 113 application date 2 August 2026'),
      derivedFrom: source,
    }))).rejects.toMatchObject({ code: 'VERIFIED_RESEARCH_INVARIANT' })

    await expect(research(request, options, undefined, async () => result([]), 16, async () => ({
      ...page(final, 'Article 113 application date 2 August 2026'),
      mediaType: 'text/plain',
      derivedFrom: source,
    }))).rejects.toMatchObject({ code: 'VERIFIED_RESEARCH_INVARIANT' })
  })

  it('rethrows credential and unknown invariant failures after workers settle', async () => {
    for (const failure of [
      new VerifiedSearchError('missing', 'VERIFIED_SEARCH_CREDENTIAL_MISSING'),
      new Error('log unavailable'),
    ]) {
      let finished = 0
      const runner = vi.fn(async (request) => {
        if (request.query === 'fail') throw failure
        await new Promise(resolve => setTimeout(resolve, 5))
        finished++
        return result([])
      })
      await expect(research({
        query: 'system failure',
        lanes: [
          { id: 'fail', query: 'fail' },
          { id: 'active', query: 'active' },
          { id: 'queued', query: 'queued' },
        ],
      }, options, undefined, runner, 16, relevantFetcher)).rejects.toBe(failure)
      expect(finished).toBe(1)
      expect(runner).toHaveBeenCalledTimes(2)
    }
  })
})

describe('model-facing research tool', () => {
  it('renders per-lane attempt, fetch, and filter accounting', () => {
    const text = formatResearchResult({
      sources: [],
      lanes: [{
        id: 'official',
        query: 'official current model',
        status: 'missing',
        claims: [{
          id: 'primary',
          query: 'official current model',
          evidenceMustInclude: [],
          valueKind: 'generic_text',
          status: 'missing',
          evidenceCount: 0,
        }],
        seedChecks: [],
        stopReason: 'plan_exhausted',
        sourceCount: 0,
        evidenceCount: 0,
        fetchCount: 1,
        fetchErrorCount: 1,
        truncated: false,
        filteredOut: 3,
        attempts: 2,
      }],
      unresolvedLanes: ['official'],
      unresolvedClaims: [{ lane: 'official', claim: 'primary' }],
      allClaimsCovered: false,
      allLanesFetched: false,
      truncated: false,
      filteredOut: 3,
    })

    expect(text).toContain('attempts=2')
    expect(text).toContain('fetches=1')
    expect(text).toContain('fetch_errors=1')
    expect(text).toContain('filtered_out=3')
  })

  it('keeps every bounded covered excerpt visible and does not echo unresolved candidate values', () => {
    const decisive = 'FOMC statement. Voting against were Beth M. Hammack, Neel Kashkari, and Lorie K. Logan, who preferred to raise the target range.'
    const excerpt = `${'background '.repeat(95)}\n${decisive}`
    const statementScope = { kind: 'document', mustInclude: ['FOMC statement'] } as const
    const text = formatResearchResult({
      sources: [{
        lane: 'statement',
        origin: 'seed',
        round: 0,
        url: 'https://official.example/statement',
        claimEvidence: [{
          claimId: 'dissenters',
          valueKind: 'generic_text',
          matchedRequiredPhrases: ['Voting against'],
          finalUrl: 'https://official.example/statement',
          excerpt,
          excerptStart: 0,
          excerptEnd: excerpt.length,
          retrievedAt: '2026-08-14T00:00:00.000Z',
          contentSha256: 'a'.repeat(64),
        }, {
          claimId: 'policy_action',
          valueKind: 'generic_text',
          matchedRequiredPhrases: ['preferred'],
          finalUrl: 'https://official.example/statement',
          excerpt,
          excerptStart: 0,
          excerptEnd: excerpt.length,
          retrievedAt: '2026-08-14T00:00:00.000Z',
          contentSha256: 'a'.repeat(64),
        }],
      }],
      lanes: [{
        id: 'statement',
        query: 'official statement',
        status: 'partial',
        claims: [
          {
            id: 'dissenters',
            query: 'dissenters names',
            evidenceMustInclude: ['Voting against'],
            valueKind: 'generic_text',
            scope: statementScope,
            status: 'covered',
            evidenceCount: 1,
          },
          {
            id: 'policy_action',
            query: 'dissenters preferred action',
            evidenceMustInclude: ['preferred'],
            valueKind: 'generic_text',
            scope: statementScope,
            status: 'covered',
            evidenceCount: 1,
          },
          {
            id: 'crew',
            query: 'candidate names Alice Example and Bob Example',
            evidenceMustInclude: ['Crew members'],
            valueKind: 'generic_text',
            scope: { kind: 'document', mustInclude: ['Artemis II'] },
            status: 'missing',
            evidenceCount: 0,
          },
        ],
        seedChecks: [],
        stopReason: 'plan_exhausted',
        sourceCount: 1,
        evidenceCount: 2,
        fetchCount: 1,
        fetchErrorCount: 0,
        truncated: false,
        filteredOut: 0,
        attempts: 1,
      }],
      unresolvedLanes: ['statement'],
      unresolvedClaims: [{ lane: 'statement', claim: 'crew' }],
      allClaimsCovered: false,
      allLanesFetched: false,
      truncated: false,
      filteredOut: 0,
    })

    expect(text).toContain(decisive)
    const renderedLine = text.split('\n').find(line => line.trimStart().startsWith('fetched_excerpt_untrusted_json:'))
    expect(renderedLine).toBeDefined()
    expect(JSON.parse(renderedLine!.slice(renderedLine!.indexOf(':') + 1).trim())).toBe(excerpt)
    expect(text).toContain('claim_ids: dissenters,policy_action')
    expect(text).toContain('"matchedRequiredPhrases":["Voting against"]')
    expect(text).toContain('"matchedRequiredPhrases":["preferred"]')
    expect(text).toContain('"mustInclude":["FOMC statement"]')
    expect(text).not.toContain('Alice Example')
    expect(text).toContain('claim crew: missing; evidence=0; requested_fact_unverified=true')
    expect(text).toContain('Tool arguments and claim queries are not evidence')
    expect(text).toContain('Do not use pwsh, bash, Python, curl, Invoke-WebRequest, or any other network fallback')
  })

  it('requires typed snake_case claims, records the request, and is exclusive', async () => {
    const recorded: unknown[] = []
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: Array<{ text: string }> }> }
      const isGap = body.messages[0]!.content[0]!.text.includes('fallback query')
      return new Response(JSON.stringify({
        content: [
          ...(isGap
            ? [{ type: 'text', citations: [{ url: 'https://official.example/current', cited_text: 'current excerpt' }] }]
            : []),
          {
            type: 'web_search_tool_result',
            content: [{ type: 'web_search_result', url: 'https://official.example/current', title: 'Current' }],
          },
        ],
      }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    ctx.tools.register(createVerifiedResearchTool(() => ({
      ...options,
      maxUses: 5,
      recordRequest: request => recorded.push(request),
    }), 150_000, 16, async url => page(url, 'fallback query current official model evidence')))
    const args = {
      query: 'official current model as of 2026-08-14',
      lanes: [{
        id: 'official',
        query: 'first query',
        allowed_domains: ['official.example'],
        gap_query: 'fallback query',
        required_claims: [{
          id: 'primary',
          query: 'fallback query current official model evidence',
          evidence_must_include: ['official model'],
          value_kind: 'generic_text',
          scope: { kind: 'document', must_include: ['current'] },
        }],
      }],
    }
    try {
      const schema = ctx.tools.schemas().find(value => value.name === 'verified_research')
      expect(JSON.stringify(schema?.parameters)).toContain('allowed_domains')
      expect(JSON.stringify(schema?.parameters)).toContain('gap_query')
      expect(JSON.stringify(schema?.parameters)).toContain('seed_urls')
      expect(JSON.stringify(schema?.parameters)).toContain('required_claims')
      expect(JSON.stringify(schema?.parameters)).toContain('temporal_anchor')
      expect(JSON.stringify(schema?.parameters)).toContain('cvss_assigned_version')
      expect(ctx.tools.executionMode({
        signal: new AbortController().signal,
        callId: 'research-mode' as never,
        name: 'verified_research',
        arguments: args,
      })).toEqual({ kind: 'exclusive' })

      const missingClaims = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: 'research-missing-claims' as never,
        name: 'verified_research',
        arguments: {
          query: args.query,
          lanes: [{
            id: 'official',
            query: 'first query',
            allowed_domains: ['official.example'],
            gap_query: 'fallback query',
          }],
        },
      })
      expect(missingClaims.isError).toBe(true)

      const missingValueKind = structuredClone(args)
      delete (missingValueKind.lanes[0]!.required_claims[0] as { value_kind?: string }).value_kind
      const invalidValueKind = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: 'research-missing-value-kind' as never,
        name: 'verified_research',
        arguments: missingValueKind,
      })
      expect(invalidValueKind.isError).toBe(true)

      const executed = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: 'research-call' as never,
        name: 'verified_research',
        arguments: args,
      })
      expect(executed.isError).toBe(false)
      expect(recorded).toHaveLength(1)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(recorded.every((value) => (value as {
        body: { tools: Array<{ max_uses: number; allowed_domains: string[] }> }
      }).body.tools[0]!.max_uses === 2)).toBe(true)
      expect((recorded[0] as {
        body: { tools: Array<{ allowed_domains: string[] }> }
      }).body.tools[0]!.allowed_domains).toEqual(['official.example'])
      expect(executed.meta).toMatchObject({
        allLanesFetched: true,
        unresolvedLanes: [],
        lanes: [{
          id: 'official',
          status: 'fetched',
          attempts: 1,
          evidenceCount: 1,
          claims: [{ id: 'primary', valueKind: 'generic_text' }],
        }],
        sources: [{
          lane: 'official',
          round: 0,
          evidence: { excerpt: 'fallback query current official model evidence' },
          claimEvidence: [{ claimId: 'primary', valueKind: 'generic_text' }],
        }],
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
