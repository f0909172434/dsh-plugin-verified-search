import { afterEach, describe, expect, it, vi } from 'vitest'
import { mapResponse, messagesEndpoint, sanitizeSourceUrl, search, searchInstruction, VerifiedSearchError } from '../src/provider.js'
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

  it('removes sensitive/tracking URL material and rejects URL credentials', () => {
    expect(sanitizeSourceUrl(
      'https://deepseek.com/news?id=42&utm_source=x&token=secret&authToken=a&jwt=b&ticket=c&X-Amz-Signature=d&X-Goog-Credential=e&Key-Pair-Id=f#section',
    ))
      .toBe('https://deepseek.com/news?id=42')
    expect(() => sanitizeSourceUrl('https://user:secret@deepseek.com/news'))
      .toThrow(VerifiedSearchError)
  })

  it('bounds and normalizes provider-controlled source text', () => {
    const mapped = mapResponse({
      content: [
        { type: 'text', citations: [{ url: 'https://deepseek.com/x', cited_text: `line\n${'s'.repeat(9_000)}` }] },
        {
          type: 'web_search_tool_result',
          content: [{
            type: 'web_search_result',
            url: 'https://deepseek.com/x',
            title: `title\u0000${'t'.repeat(1_100)}`,
            page_age: `date\n${'d'.repeat(300)}`,
          }],
        },
      ],
    })[0]!
    expect(mapped.title).not.toContain('\u0000')
    expect(mapped.title!.length).toBe(1_000)
    expect(mapped.snippet).not.toContain('\n')
    expect(mapped.snippet!.length).toBe(8_000)
    expect(mapped.publishedAt!.length).toBe(200)
  })

  it('tolerates null and malformed optional metadata from the live provider', () => {
    expect(mapResponse({
      content: [
        { type: 'text', citations: [null, { url: null, cited_text: null }, { url: 42, cited_text: {} }] },
        {
          type: 'web_search_tool_result',
          content: [
            null,
            { type: 'web_search_result', url: 'https://deepseek.com/nulls', title: null, page_age: null },
          ],
        },
      ],
    })).toEqual([{ url: 'https://deepseek.com/nulls' }])
  })

  it('rejects null result content with a controlled provider error', () => {
    expect(() => mapResponse({ content: [{ type: 'web_search_tool_result', content: null }] }))
      .toThrow(VerifiedSearchError)
  })

  it('fails closed on malformed result URLs and structured tool errors', () => {
    for (const url of [null, 42, ['https://deepseek.com/coerced']]) {
      expect(() => mapResponse({
        content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', url }] }],
      })).toThrow(/URL string/u)
    }
    expect(() => mapResponse({
      content: [{
        type: 'web_search_tool_result',
        content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' },
      }],
    })).toThrow(/max_uses_exceeded/u)
    expect(() => mapResponse({
      content: [{
        type: 'web_search_tool_result',
        content: { type: 'web_search_tool_result_error', error_code: 'provider-secret-detail' },
      }],
    })).toThrow(/malformed_result/u)
  })

  it('rejects a non-object or malformed outer response', () => {
    expect(() => mapResponse(null)).toThrow(VerifiedSearchError)
    expect(() => mapResponse({ content: {} })).toThrow(/no web_search_tool_result/u)
  })
})

describe('wire request', () => {
  it('builds a credential-free HTTP(S) Messages endpoint and rejects unsafe base URLs', () => {
    expect(messagesEndpoint('https://api.deepseek.test/anthropic/v1/'))
      .toBe('https://api.deepseek.test/anthropic/v1/messages')
    expect(messagesEndpoint('http://127.0.0.1:8080/anthropic/v1'))
      .toBe('http://127.0.0.1:8080/anthropic/v1/messages')
    for (const value of [
      'ftp://api.deepseek.test/v1',
      'http://api.deepseek.test/v1',
      'https://user:secret@api.deepseek.test/v1',
      'https://api.deepseek.test/v1?token=secret',
      'https://api.deepseek.test/v1#secret',
      ' not-a-url',
    ]) {
      expect(() => messagesEndpoint(value)).toThrow(VerifiedSearchError)
    }
  })

  it('records the exact credential-free request before dispatch and maps results', async () => {
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

  it('accepts null page_age through the complete HTTP response path', async () => {
    const response = {
      content: [
        { type: 'text', citations: [{ url: 'https://deepseek.com/current', cited_text: 'current official excerpt' }] },
        {
          type: 'web_search_tool_result',
          content: [{
            type: 'web_search_result',
            url: 'https://deepseek.com/current',
            title: 'Current model',
            page_age: null,
          }],
        },
      ],
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })))
    await expect(search({ query: 'q' }, options())).resolves.toEqual({
      sources: [{
        url: 'https://deepseek.com/current',
        title: 'Current model',
        snippet: 'current official excerpt',
      }],
      truncated: false,
    })
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
      .resolves.toEqual({ sources: [{ url: 'https://a.example.com/' }], truncated: true })
  })

  it('resolves credentials per call and handles HTTP errors', async () => {
    const resolveApiKey = vi.fn(async () => 'resolved')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 })))
    const resolvedOptions = options({ resolveApiKey })
    delete (resolvedOptions as { apiKey?: string }).apiKey
    await expect(search({ query: 'q' }, resolvedOptions))
      .rejects.toMatchObject({ code: 'VERIFIED_SEARCH_PROVIDER_ERROR', message: 'DeepSeek API error (HTTP 429)' })
    expect(resolveApiKey).toHaveBeenCalledOnce()
  })

  it('cancels a hanging credential lookup without dispatching or logging', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn()
    const recordRequest = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const hangingOptions = options({
      resolveApiKey: () => new Promise<string>(() => {}),
      recordRequest,
    })
    delete (hangingOptions as { apiKey?: string }).apiKey
    const pending = search({ query: 'q' }, hangingOptions, controller.signal)
    controller.abort(new Error('test cancellation'))
    await expect(pending).rejects.toMatchObject({ code: 'VERIFIED_SEARCH_ABORTED' })
    expect(recordRequest).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not echo credential-provider errors into the tool error', async () => {
    const secret = 'live-secret-must-not-appear'
    const failingOptions = options({
      resolveApiKey: async () => { throw new Error(secret) },
    })
    delete (failingOptions as { apiKey?: string }).apiKey
    await expect(search({ query: 'q' }, failingOptions)).rejects.toMatchObject({
      code: 'VERIFIED_SEARCH_PROVIDER_ERROR',
      message: 'credential resolution failed for "DEEPSEEK_API_KEY"',
    })
    try {
      const secondFailure = options({
        resolveApiKey: async () => { throw new Error(secret) },
      })
      delete (secondFailure as { apiKey?: string }).apiKey
      await search({ query: 'q' }, secondFailure)
    } catch (error: unknown) {
      expect(String(error)).not.toContain(secret)
    }
  })

  it('rejects oversized successful response bodies before parsing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', {
      status: 200,
      headers: { 'content-length': String(4 * 1024 * 1024 + 1) },
    })))
    await expect(search({ query: 'q' }, options()))
      .rejects.toMatchObject({ code: 'VERIFIED_SEARCH_PROVIDER_ERROR', message: 'DeepSeek response exceeded the 4 MiB limit' })
  })
})
