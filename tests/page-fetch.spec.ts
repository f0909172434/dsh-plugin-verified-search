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
  body: string | Uint8Array = 'official current model evidence',
  headers: Record<string, string> = { 'content-type': 'text/plain' },
): TransportResponse {
  return { statusCode, headers, bytes: typeof body === 'string' ? new TextEncoder().encode(body) : body }
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
      { transport: fake, maxRedirects: 2 },
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

  it.each(['ISO-8859-1', 'windows-1252'])('decodes Cisco-like %s advisory text as Windows-1252', async (charset) => {
    const prefix = new TextEncoder().encode('<h1>Cisco Security Advisory</h1><p>Affected Products ')
    const suffix = new TextEncoder().encode(' ASA and FTD</p>')
    const bytes = Uint8Array.from([...prefix, 0x96, ...suffix])
    const fake = transport(undefined, () => response(200, bytes, {
      'content-type': `text/html;charset=${charset}`,
    }))

    await expect(fetchEvidencePage('https://example.com/advisory', ['example.com'], undefined, { transport: fake }))
      .resolves.toMatchObject({
        mediaType: 'text/html',
        body: '<h1>Cisco Security Advisory</h1><p>Affected Products – ASA and FTD</p>',
      })
  })

  it('uses the same complete Windows-1252 C1 mapping on every supported Node runtime', async () => {
    const fake = transport(undefined, () => response(200, Uint8Array.from([
      0x80, 0x20, 0x81, 0x20, 0x8d, 0x20, 0x96, 0x20, 0x9f,
    ]), {
      'content-type': 'text/plain;charset=windows-1252',
    }))

    await expect(fetchEvidencePage('https://example.com/mapping', ['example.com'], undefined, { transport: fake }))
      .resolves.toMatchObject({ body: '€ \u0081 \u008d – Ÿ' })
  })

  it('keeps declared UTF-8 decoding fatal and rejects unknown charsets', async () => {
    const utf8Body = '<p>安全更新 — café</p>'
    const utf8 = transport(undefined, () => response(200, utf8Body, {
      'content-type': 'text/html; charset="UTF-8"',
    }))
    await expect(fetchEvidencePage('https://example.com/utf8', ['example.com'], undefined, { transport: utf8 }))
      .resolves.toMatchObject({ body: utf8Body })

    const invalidUtf8 = transport(undefined, () => response(200, Uint8Array.from([0xc3, 0x28]), {
      'content-type': 'text/plain;charset=utf-8',
    }))
    await expect(fetchEvidencePage('https://example.com/invalid', ['example.com'], undefined, { transport: invalidUtf8 }))
      .rejects.toMatchObject({ code: 'VERIFIED_RESEARCH_FETCH_CONTENT_ERROR' })

    const unknown = transport(undefined, () => response(200, 'ASCII is not permission to guess', {
      'content-type': 'text/html;charset=shift_jis',
    }))
    await expect(fetchEvidencePage('https://example.com/unknown', ['example.com'], undefined, { transport: unknown }))
      .rejects.toMatchObject({ code: 'VERIFIED_RESEARCH_FETCH_CONTENT_ERROR' })
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

  it('uses the official Cellar representation for a strict EUR-Lex CELEX 202 response', async () => {
    const calls: string[] = []
    const fake = transport(undefined, url => {
      calls.push(url.toString())
      if (url.hostname === 'eur-lex.europa.eu') {
        return response(202, '<script>challenge()</script>', {
          'content-type': 'text/html',
          'set-cookie': 'challenge=secret',
        })
      }
      if (url.pathname === '/resource/celex/32024R1689') {
        return response(303, '', {
          location: 'http://publications.europa.eu/resource/cellar/official-item/DOC_1',
        })
      }
      return response(200, '<html><body>Article 113 applies from 2 August 2026.</body></html>', {
        'content-type': 'application/xhtml+xml;charset=UTF-8',
      })
    })
    const source = 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32024R1689'

    await expect(fetchEvidencePage(
      source,
      ['eur-lex.europa.eu', 'publications.europa.eu'],
      undefined,
      { transport: fake },
    )).resolves.toMatchObject({
      url: 'https://publications.europa.eu/resource/cellar/official-item/DOC_1',
      mediaType: 'application/xhtml+xml',
      derivedFrom: source,
    })
    expect(calls).toEqual([
      source,
      'https://publications.europa.eu/resource/celex/32024R1689',
      'https://publications.europa.eu/resource/cellar/official-item/DOC_1',
    ])
  })

  it('binds Cellar fallback to the exact original CELEX request', async () => {
    const sourceA = 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:AAAA'
    const sourceB = 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:BBBB'
    const calls: string[] = []
    const remap = transport(undefined, url => {
      calls.push(url.toString())
      return url.searchParams.get('uri') === 'CELEX:AAAA'
        ? response(302, '', { location: sourceB })
        : response(202, 'pending')
    })
    await expect(fetchEvidencePage(
      sourceA,
      ['eur-lex.europa.eu', 'publications.europa.eu'],
      undefined,
      { transport: remap },
    )).rejects.toMatchObject({ code: 'VERIFIED_RESEARCH_FETCH_REDIRECT_ERROR' })
    expect(calls).toEqual([sourceA, sourceB])
    expect(calls.some(url => url.includes('publications.europa.eu'))).toBe(false)

    const duplicateUri = `${sourceA}&uri=CELEX:BBBB`
    const duplicate = transport(undefined, () => response(202, 'pending'))
    await expect(fetchEvidencePage(
      duplicateUri,
      ['eur-lex.europa.eu', 'publications.europa.eu'],
      undefined,
      { transport: duplicate },
    )).rejects.toMatchObject({ code: 'VERIFIED_RESEARCH_FETCH_PENDING' })
    expect(duplicate.request).toHaveBeenCalledOnce()
  })

  it('limits the HTTP Cellar upgrade to an exact resolver 303 and exact document path', async () => {
    const source = 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32024R1689'
    const allowlist = ['eur-lex.europa.eu', 'publications.europa.eu']
    const wrongStatus = transport(undefined, url => url.hostname === 'eur-lex.europa.eu'
      ? response(202, 'pending')
      : response(302, '', { location: 'http://publications.europa.eu/resource/cellar/item/DOC_1' }))
    await expect(fetchEvidencePage(source, allowlist, undefined, { transport: wrongStatus }))
      .rejects.toMatchObject({ code: 'VERIFIED_RESEARCH_FETCH_REDIRECT_ERROR' })
    expect(wrongStatus.request).toHaveBeenCalledTimes(2)

    const badPath = transport(undefined, url => url.hostname === 'eur-lex.europa.eu'
      ? response(202, 'pending')
      : response(303, '', { location: 'http://publications.europa.eu/resource/cellar/item?document=1' }))
    await expect(fetchEvidencePage(source, allowlist, undefined, { transport: badPath }))
      .rejects.toMatchObject({ code: 'VERIFIED_RESEARCH_FETCH_REDIRECT_ERROR' })
    expect(badPath.request).toHaveBeenCalledTimes(2)

    const direct = transport(undefined, () => response(303, '', {
      location: 'http://publications.europa.eu/resource/cellar/item/DOC_1',
    }))
    await expect(fetchEvidencePage(
      'https://publications.europa.eu/resource/celex/32024R1689',
      ['publications.europa.eu'],
      undefined,
      { transport: direct },
    )).rejects.toMatchObject({ code: 'VERIFIED_RESEARCH_FETCH_URL_ERROR' })
    expect(direct.request).toHaveBeenCalledOnce()
  })

  it('accepts only the exact Cellar XHTML document and forbids later redirects', async () => {
    const source = 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32024R1689'
    const allowlist = ['eur-lex.europa.eu', 'publications.europa.eu']
    const wrongMime = transport(undefined, url => {
      if (url.hostname === 'eur-lex.europa.eu') return response(202, 'pending')
      if (url.pathname.startsWith('/resource/celex/')) {
        return response(303, '', { location: 'http://publications.europa.eu/resource/cellar/item/DOC_1' })
      }
      return response(200, 'not XHTML', { 'content-type': 'text/plain' })
    })
    await expect(fetchEvidencePage(source, allowlist, undefined, { transport: wrongMime }))
      .rejects.toMatchObject({ code: 'VERIFIED_RESEARCH_FETCH_CONTENT_ERROR' })

    const redirectedDocument = transport(undefined, url => {
      if (url.hostname === 'eur-lex.europa.eu') return response(202, 'pending')
      if (url.pathname.startsWith('/resource/celex/')) {
        return response(303, '', { location: 'http://publications.europa.eu/resource/cellar/item/DOC_1' })
      }
      return response(302, '', { location: '/resource/cellar/other/DOC_2' })
    })
    await expect(fetchEvidencePage(source, allowlist, undefined, { transport: redirectedDocument }))
      .rejects.toMatchObject({ code: 'VERIFIED_RESEARCH_FETCH_REDIRECT_ERROR' })
    expect(redirectedDocument.request).toHaveBeenCalledTimes(3)
  })

  it('charges both Cellar URL transitions to the redirect budget', async () => {
    const source = 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32024R1689'
    const allowlist = ['eur-lex.europa.eu', 'publications.europa.eu']
    const route = (url: URL): TransportResponse => {
      if (url.hostname === 'eur-lex.europa.eu') return response(202, 'pending')
      if (url.pathname.startsWith('/resource/celex/')) {
        return response(303, '', { location: 'http://publications.europa.eu/resource/cellar/item/DOC_1' })
      }
      return response(200, '<html/>', { 'content-type': 'application/xhtml+xml' })
    }
    for (const [maxRedirects, requestCount] of [[0, 1], [1, 2]] as const) {
      const fake = transport(undefined, route)
      await expect(fetchEvidencePage(source, allowlist, undefined, { transport: fake, maxRedirects }))
        .rejects.toMatchObject({ code: 'VERIFIED_RESEARCH_FETCH_REDIRECT_ERROR' })
      expect(fake.request).toHaveBeenCalledTimes(requestCount)
    }
  })

  it('never treats a generic 202 body as evidence or uses Cellar without an explicit allowlist', async () => {
    const generic = transport(undefined, () => response(202, 'looks like evidence', {
      'content-type': 'text/plain',
      location: 'https://example.com/not-followed',
    }))
    await expect(fetchEvidencePage('https://example.com/current', ['example.com'], undefined, { transport: generic }))
      .rejects.toMatchObject({ code: 'VERIFIED_RESEARCH_FETCH_PENDING' })
    expect(generic.request).toHaveBeenCalledOnce()

    const eurLex = transport(undefined, () => response(202, 'challenge'))
    await expect(fetchEvidencePage(
      'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32024R1689',
      ['eur-lex.europa.eu'],
      undefined,
      { transport: eurLex },
    )).rejects.toMatchObject({ code: 'VERIFIED_RESEARCH_FETCH_PENDING' })
    expect(eurLex.request).toHaveBeenCalledOnce()

    const broadParent = transport(undefined, () => response(202, 'challenge'))
    await expect(fetchEvidencePage(
      'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32024R1689',
      ['europa.eu'],
      undefined,
      { transport: broadParent },
    )).rejects.toMatchObject({ code: 'VERIFIED_RESEARCH_FETCH_PENDING' })
    expect(broadParent.request).toHaveBeenCalledOnce()
  })

  it('rejects unsupported content and obeys caller cancellation', async () => {
    const wrongType = transport(undefined, () => response(200, '%PDF', { 'content-type': 'application/pdf' }))
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
