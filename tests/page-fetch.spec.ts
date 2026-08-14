import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EvidenceFetchError,
  fetchEvidencePage,
  isPublicAddress,
} from '../src/page-fetch.js'
import type {
  EvidenceTransport,
  ResolvedAddress,
  TransportResponse,
} from '../src/page-fetch.js'

function response(
  statusCode = 200,
  body = 'official current model evidence',
  headers: Record<string, string> = { 'content-type': 'text/plain' },
): TransportResponse {
  return { statusCode, headers, bytes: new TextEncoder().encode(body) }
}

function transport(
  resolveValues: readonly ResolvedAddress[] = [{ address: '93.184.216.34', family: 4 }],
  route: (url: URL) => TransportResponse = () => response(),
) {
  const resolve = vi.fn(async () => resolveValues)
  const request = vi.fn(async (url: URL, _address: ResolvedAddress) => route(url))
  return { resolve, request } satisfies EvidenceTransport
}

afterEach(() => vi.useRealTimers())

describe('public address policy', () => {
  it.each([
    [{ address: '8.8.8.8', family: 4 }, true],
    [{ address: '2606:4700:4700::1111', family: 6 }, true],
    [{ address: '2001:4860:4860::8888', family: 6 }, true],
    [{ address: '127.0.0.1', family: 4 }, false],
    [{ address: '169.254.169.254', family: 4 }, false],
    [{ address: '10.0.0.1', family: 4 }, false],
    [{ address: '100.64.0.1', family: 4 }, false],
    [{ address: '192.0.2.1', family: 4 }, false],
    [{ address: '::1', family: 6 }, false],
    [{ address: '::ffff:127.0.0.1', family: 6 }, false],
    [{ address: 'fd00::1', family: 6 }, false],
    [{ address: 'fe80::1', family: 6 }, false],
    [{ address: '5f00::1', family: 6 }, false],
    [{ address: '4000::1', family: 6 }, false],
    [{ address: '::192.0.2.1', family: 6 }, false],
  ] as const)('classifies %o as public=%s', (value, expected) => {
    expect(isPublicAddress(value)).toBe(expected)
  })
})

describe('DNS-pinned evidence fetch policy', () => {
  it('pins the validated address and returns UTF-8 allowlisted text', async () => {
    const fake = transport()
    const result = await fetchEvidencePage(
      'https://docs.example.com/current?utm_source=test',
      ['example.com'],
      undefined,
      { transport: fake },
    )

    expect(fake.resolve).toHaveBeenCalledWith('docs.example.com', expect.any(AbortSignal))
    expect(fake.request.mock.calls[0]![1]).toEqual({ address: '93.184.216.34', family: 4 })
    expect(fake.request.mock.calls[0]![0].toString()).toBe('https://docs.example.com/current')
    expect(result).toMatchObject({
      url: 'https://docs.example.com/current',
      mediaType: 'text/plain',
      body: 'official current model evidence',
    })
  })

  it('fails closed when any DNS answer is non-public', async () => {
    const fake = transport([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ])
    await expect(fetchEvidencePage('https://example.com', ['example.com'], undefined, { transport: fake }))
      .rejects.toMatchObject({ code: 'VERIFIED_RESEARCH_FETCH_SSRF_BLOCKED' })
    expect(fake.request).not.toHaveBeenCalled()
  })

  it.each([
    'http://example.com',
    'https://user:secret@example.com',
    'https://127.0.0.1',
    'https://[::1]',
    'https://[5f00::1]',
    'https://example.com:8443',
    'ftp://example.com',
  ])('rejects unsafe evidence URL %s before DNS', async (url) => {
    const fake = transport()
    await expect(fetchEvidencePage(url, ['example.com'], undefined, { transport: fake }))
      .rejects.toBeInstanceOf(EvidenceFetchError)
    expect(fake.resolve).not.toHaveBeenCalled()
  })

  it('enforces exact/subdomain allowlists and blocks suffix traps', async () => {
    const fake = transport()
    await expect(fetchEvidencePage('https://notexample.com', ['example.com'], undefined, { transport: fake }))
      .rejects.toMatchObject({ code: 'VERIFIED_RESEARCH_FETCH_URL_ERROR' })
    expect(fake.resolve).not.toHaveBeenCalled()
  })

  it('follows same-origin redirects, re-resolves every hop, and blocks cross-origin redirects', async () => {
    const sameOrigin = transport(undefined, url => url.pathname === '/start'
      ? response(302, '', { location: '/final' })
      : response())
    await expect(fetchEvidencePage('https://example.com/start', ['example.com'], undefined, { transport: sameOrigin }))
      .resolves.toMatchObject({ url: 'https://example.com/final' })
    expect(sameOrigin.resolve).toHaveBeenCalledTimes(2)
    expect(sameOrigin.request).toHaveBeenCalledTimes(2)

    const crossOrigin = transport(undefined, () => response(302, '', { location: 'https://other.example/final' }))
    await expect(fetchEvidencePage('https://example.com/start', undefined, undefined, { transport: crossOrigin }))
      .rejects.toMatchObject({ code: 'VERIFIED_RESEARCH_FETCH_REDIRECT_ERROR' })
    expect(crossOrigin.resolve).toHaveBeenCalledOnce()
  })

  it('rejects unsupported content and obeys caller cancellation', async () => {
    const wrongType = transport(undefined, () => response(200, '{}', { 'content-type': 'application/json' }))
    await expect(fetchEvidencePage('https://example.com', undefined, undefined, { transport: wrongType }))
      .rejects.toMatchObject({ code: 'VERIFIED_RESEARCH_FETCH_CONTENT_ERROR' })

    const controller = new AbortController()
    controller.abort(new Error('cancel'))
    const fake = transport()
    await expect(fetchEvidencePage('https://example.com', undefined, controller.signal, { transport: fake }))
      .rejects.toMatchObject({ code: 'VERIFIED_RESEARCH_FETCH_ABORTED' })
    expect(fake.resolve).not.toHaveBeenCalled()
  })

  it('uses one overall deadline across DNS, requests, and redirects', async () => {
    vi.useFakeTimers()
    let requestCount = 0
    const requestBudgets: number[] = []
    const fake: EvidenceTransport = {
      resolve: vi.fn(async () => [{ address: '93.184.216.34', family: 4 as const }]),
      request: vi.fn(async (_url, _address, signal, limits) => await new Promise<TransportResponse>((resolve, reject) => {
        requestBudgets.push(limits.timeoutMs)
        const timer = setTimeout(() => {
          requestCount++
          resolve(requestCount === 1
            ? response(302, '', { location: '/second' })
            : response())
        }, 6)
        signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(signal.reason)
        }, { once: true })
      })),
    }
    const pending = fetchEvidencePage(
      'https://example.com/first',
      ['example.com'],
      undefined,
      { transport: fake, timeoutMs: 10 },
    )
    const rejection = expect(pending).rejects.toMatchObject({ code: 'VERIFIED_RESEARCH_FETCH_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(11)
    await rejection

    expect(fake.request).toHaveBeenCalledTimes(2)
    expect(requestBudgets[1]!).toBeLessThan(requestBudgets[0]!)
  })
})
