import { afterEach, describe, expect, it, vi } from 'vitest'
import { mapResponse, search, searchInstruction, VerifiedSearchError } from '../src/provider.js'
import type { SearchOptions } from '../src/types.js'

const options = (overrides: Partial<SearchOptions> = {}): SearchOptions => ({
  apiKey: 'test-key',
  apiKeyRef: 'DEEPSEEK_API_KEY',
  baseURL: 'https://api.deepseek.test/anthropic/v1',
  model: 'deepseek-v4-flash',
  apiVersion: '2023-06-01',
  maxTokens: 4096,
  maxUses: 5,
  maxResults: 8,
  recordRequest: vi.fn(),
  ...overrides,
})

function payload(url = 'https://deepseek.com/current') {
  return {
    content: [
      { type: 'text', citations: [{ url, cited_text: 'current official excerpt' }] },
      {
        type: 'web_search_tool_result',
        content: [{ type: 'web_search_result', url, title: 'Current model', page_age: 'August 14, 2026' }],
      },
    ],
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('response mapping', () => {
  it('joins citation excerpts, deduplicates and preserves page-age labels', () => {
    expect(mapResponse(payload())).toEqual([{
      url: 'https://deepseek.com/current',
      title: 'Current model',
      snippet: 'current official excerpt',
      publishedAt: 'August 14, 2026',
    }])
  })

  it('fails when native search did not return a result block', () => {
    expect(() => mapResponse({ content: [{ type: 'text' }] })).toThrow(VerifiedSearchError)
  })
})

describe('wire request', () => {
  it('records the exact secret-free request before dispatch and maps results', async () => {
    const recordRequest = vi.fn()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload()), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await search({
      query: 'DeepSeek current flagship as of 2026-08-14',
      allowedDomains: ['DeepSeek.COM'],
    }, options({ recordRequest }))
    const [endpoint, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(endpoint).toBe('https://api.deepseek.test/anthropic/v1/messages')
    expect(body.tools[0].allowed_domains).toEqual(['deepseek.com'])
    expect(body.messages[0].content[0].text).toBe(searchInstruction('DeepSeek current flagship as of 2026-08-14'))
    expect(recordRequest).toHaveBeenCalledWith({ endpoint, apiVersion: '2023-06-01', body })
    expect(recordRequest.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0] ?? 0)
    expect(result.sources).toHaveLength(1)
  })

  it('does not dispatch when durable request logging fails', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(search({ query: 'q' }, options({
      recordRequest: () => { throw new Error('log unavailable') },
    }))).rejects.toThrow('log unavailable')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails when a provider ignores allowed_domains', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload('https://evil.example')), { status: 200 })))
    await expect(search({ query: 'q', allowedDomains: ['deepseek.com'] }, options()))
      .rejects.toMatchObject({ code: 'VERIFIED_SEARCH_FILTER_VIOLATION' })
  })

  it('caps results after the source postcondition', async () => {
    const response = {
      content: [{
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result', url: 'https://a.example.com' },
          { type: 'web_search_result', url: 'https://b.example.com' },
        ],
      }],
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })))
    await expect(search({ query: 'q', allowedDomains: ['example.com'] }, options({ maxResults: 1 })))
      .resolves.toEqual({ sources: [{ url: 'https://a.example.com' }], truncated: true })
  })

  it('resolves credentials per call and handles HTTP errors', async () => {
    const resolveApiKey = vi.fn(async () => 'resolved')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 })))
    const resolvedOptions = options({ resolveApiKey })
    delete (resolvedOptions as { apiKey?: string }).apiKey
    await expect(search({ query: 'q' }, resolvedOptions))
      .rejects.toMatchObject({ code: 'VERIFIED_SEARCH_PROVIDER_ERROR', message: 'rate limited' })
    expect(resolveApiKey).toHaveBeenCalledOnce()
  })
})
