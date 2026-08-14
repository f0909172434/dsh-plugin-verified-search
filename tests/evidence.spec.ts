import { describe, expect, it } from 'vitest'
import { extractPageEvidence, normalizeFetchedPage } from '../src/evidence.js'

function normalizedHtml(body: string): string {
  return normalizeFetchedPage({
    url: 'https://example.com/html',
    mediaType: 'text/html',
    body,
    retrievedAt: '2026-08-14T00:00:00.000Z',
  }).text
}

describe('inert page normalization and exact excerpts', () => {
  it('normalizes XHTML through the inert HTML tokenizer', () => {
    const normalized = normalizeFetchedPage({
      url: 'https://publications.europa.eu/resource/cellar/item',
      mediaType: 'application/xhtml+xml',
      body: '<html><body><script>ignore()</script><p>Article 113 applies from 2 August 2026.</p></body></html>',
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    expect(normalized.text).toBe('Article 113 applies from 2 August 2026.')
  })

  it('retains query-relevant provisions beyond the old 100,000-character prefix', () => {
    const normalized = normalizeFetchedPage({
      url: 'https://publications.europa.eu/resource/cellar/item',
      mediaType: 'application/xhtml+xml',
      body: `<html><body><p>${'background material '.repeat(8_000)}</p><h2>Article 113</h2><p>This Regulation shall apply from 2 August 2026.</p></body></html>`,
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    expect(normalized.text.length).toBeGreaterThan(100_000)
    expect(extractPageEvidence(normalized, 'Article 113 Regulation apply 2 August 2026')?.excerpt)
      .toContain('Article 113')
  })

  it('prefers an exact legal section heading over earlier cross-references and regulation identifiers', () => {
    const normalized = normalizeFetchedPage({
      url: 'https://publications.europa.eu/resource/cellar/item',
      mediaType: 'application/xhtml+xml',
      body: [
        '<p>Article 111 cross-refers to Article 113 and Regulation EU-2024-1689 but does not state entry into force.</p>',
        '<h2>Article&nbsp;113</h2>',
        '<h3>Entry into force and application</h3>',
        '<p>This Regulation shall apply from 2 August 2026.</p>',
      ].join(''),
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    const evidence = extractPageEvidence(normalized, 'Article 113 entry into force application 2 August 2026')
    expect(evidence?.excerpt.startsWith('Article 113')).toBe(true)
    expect(evidence?.excerpt).toContain('2 August 2026')
  })

  it('does not mark a version-and-date claim covered without both values', () => {
    const generic = normalizedHtml('Latest stable release information is available on the downloads page. Production applications should use Active LTS releases.')
    const genericPage = normalizeFetchedPage({
      url: 'https://example.com/generic',
      mediaType: 'text/plain',
      body: generic,
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    const query = 'latest stable Node.js version number and release date'
    expect(extractPageEvidence(genericPage, query)).toBeUndefined()

    const exactPage = normalizeFetchedPage({
      url: 'https://example.com/exact',
      mediaType: 'text/plain',
      body: 'Latest stable Node.js version v26.7.0 was released on 5 August 2026.',
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    expect(extractPageEvidence(exactPage, query)?.excerpt).toContain('v26.7.0')
  })

  it('requires a local latest assertion instead of combining a generic link with a later table row', () => {
    const page = normalizeFetchedPage({
      url: 'https://example.com/versions',
      mediaType: 'text/plain',
      body: [
        'The latest release for each version is on the downloads page.',
        'Unrelated navigation.',
        'Version 3.14.0 was released on 7 October 2025.',
      ].join('\n'),
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    expect(extractPageEvidence(page, 'latest stable Python version number and release date')).toBeUndefined()
  })
  it('removes executable/hidden HTML and decodes text entities', () => {
    const page = normalizeFetchedPage({
      url: 'https://example.com/current',
      mediaType: 'text/html',
      body: `<!doctype html><html><head><style>secret-style</style><script>ignore me</script></head>
        <body><nav>ignore navigation</nav><main><h1>Current &amp; official model</h1>
        <p>The model identifier is model-v4-pro.</p></main><footer>ignore footer</footer></body></html>`,
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })

    expect(page.text).toContain('Current & official model')
    expect(page.text).toContain('model-v4-pro')
    expect(page.text).not.toContain('secret-style')
    expect(page.text).not.toContain('ignore me')
    expect(page.text).not.toContain('ignore navigation')
    expect(page.contentSha256).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('drops an unclosed suppressed block and bounds malformed HTML work', () => {
    const started = performance.now()
    const page = normalizeFetchedPage({
      url: 'https://example.com/malformed',
      mediaType: 'text/html',
      body: `<main>Retained evidence</main>${'<script>'.repeat(80_000)}never executable`,
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })

    expect(page.text).toBe('Retained evidence')
    expect(page.text).not.toContain('never executable')
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  it('handles raw-text, tree suppression, comments, and quoted tag delimiters', () => {
    expect(normalizedHtml('a<!-- hidden -->b')).toBe('a b')
    expect(normalizedHtml('a<!-- unclosed')).toBe('a')
    expect(normalizedHtml(`before<script>if (a < b) {
      const x = "<script>";
      const y = "<!--";
    }</script>after`)).toBe('before\nafter')
    expect(normalizedHtml('A<nav><script>const x = "</nav>"</script>hidden</nav>B')).toBe('A\nB')
    expect(normalizedHtml('<p title="1 > 0">kept</p>')).toBe('kept')
  })

  it('normalizes whitespace after scanning and bounds long numeric entities', () => {
    expect(normalizedHtml(`${' '.repeat(150_000)}<p>tail</p>`)).toBe('tail')
    expect(normalizedHtml(`${'a'.repeat(99_999)}${' '.repeat(150_000)}b`))
      .toBe(`${'a'.repeat(99_999)} b`)
    expect(normalizedHtml(`${'a'.repeat(99_999)}${' '.repeat(150_000)}`))
      .toBe('a'.repeat(99_999))
    expect(normalizedHtml(`&#${'0'.repeat(200_000)}65;tail`)).toBe('Atail')
    const splitAstral = normalizedHtml(`${'a'.repeat(99_999)}&#x1f600;`)
    expect(splitAstral.length).toBe(100_001)
    expect(splitAstral.charCodeAt(99_999)).toBe(0xd83d)
    expect(splitAstral.charCodeAt(100_000)).toBe(0xde00)
    expect(normalizedHtml('a'.repeat(2 * 1024 * 1024 + 100))).toHaveLength(2 * 1024 * 1024)
  })

  it('returns a contiguous excerpt with reproducible offsets and hash', () => {
    const page = normalizeFetchedPage({
      url: 'https://example.com/current',
      mediaType: 'text/plain',
      body: 'Unrelated introduction.\nThe current official flagship model\nModel ID\nmodel-v4-pro\nAlias\nmodel-v4\nOther text.',
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    const evidence = extractPageEvidence(page, 'official flagship model ID')

    expect(evidence).toBeDefined()
    expect(page.text.slice(evidence!.excerptStart, evidence!.excerptEnd)).toBe(evidence!.excerpt)
    expect(evidence!.excerpt).toContain('model-v4-pro')
    expect(evidence!.contentSha256).toBe(page.contentSha256)
    expect(extractPageEvidence(page, 'totally absent zebras')).toBeUndefined()
  })

  it('does not mark a cropped excerpt as evidence after required terms fall outside it', () => {
    const page = normalizeFetchedPage({
      url: 'https://example.com/cropped',
      mediaType: 'text/plain',
      body: `alpha ${'filler '.repeat(500)} flagship`,
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })

    expect(extractPageEvidence(page, 'alpha flagship')).toBeUndefined()
  })

  it('supports Chinese query terms without inventing text', () => {
    const page = normalizeFetchedPage({
      url: 'https://example.com/zh',
      mediaType: 'text/plain',
      body: '官方模型清單\n目前旗艦模型識別碼為 deepseek-v4-pro。',
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    const evidence = extractPageEvidence(page, '目前官方旗艦模型識別碼')
    expect(evidence?.excerpt).toContain('deepseek-v4-pro')
  })
})
