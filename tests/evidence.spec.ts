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
      .toBe(`${'a'.repeat(99_999)} `)
    expect(normalizedHtml(`${'a'.repeat(99_999)}${' '.repeat(150_000)}`))
      .toBe('a'.repeat(99_999))
    expect(normalizedHtml(`&#${'0'.repeat(200_000)}65;tail`)).toBe('Atail')
    const splitAstral = normalizedHtml(`${'a'.repeat(99_999)}&#x1f600;`)
    expect(splitAstral.length).toBe(100_000)
    expect(splitAstral.charCodeAt(99_999)).toBe(0xd83d)
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
