import { createHash } from 'node:crypto'
import type { VerifiedPageEvidence } from './types.js'
import type { FetchedPage } from './page-fetch.js'

const MAX_NORMALIZED_TEXT = 100_000
const MAX_EXCERPT_LENGTH = 2_000
const MAX_INPUT_CHARS = 1024 * 1024
const RAW_SUPPRESSED_HTML_TAGS = new Set(['iframe', 'script', 'style'])
const TREE_SUPPRESSED_HTML_TAGS = new Set(['canvas', 'footer', 'form', 'nav', 'noscript', 'svg', 'template'])
const BLOCK_HTML_TAGS = new Set([
  'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main',
  'nav', 'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
])
const STOPWORDS = new Set([
  'a', 'an', 'and', 'api', 'as', 'at', 'by', 'com', 'current', 'for', 'from', 'in', 'is', 'latest',
  'of', 'official', 'on', 'or', 'site', 'the', 'to', 'www',
])
const ASCII_ANCHORS = new Set([
  'benchmark', 'flagship', 'id', 'identifier', 'model-id', 'price', 'release', 'version',
])
const CJK_ANCHORS = ['旗艦', '识别码', '識別碼', '版本', '發布', '发布', '價格', '价格', '跑分']

export interface NormalizedPage {
  readonly url: string
  readonly text: string
  readonly retrievedAt: string
  readonly contentSha256: string
}

interface ParsedTag {
  readonly end: number
  readonly name?: string
  readonly closing: boolean
  readonly selfClosing: boolean
  readonly malformed: boolean
}

function isAsciiLetter(value: string | undefined): boolean {
  return value !== undefined && /[a-z]/iu.test(value)
}

function parseTag(input: string, start: number): ParsedTag | undefined {
  let cursor = start + 1
  let closing = false
  if (input[cursor] === '/') {
    closing = true
    cursor++
  }
  if (input[cursor] === '!' || input[cursor] === '?') {
    // Declarations and processing instructions are markup, but have no tag name.
  } else if (!isAsciiLetter(input[cursor])) {
    return undefined
  }
  const nameStart = cursor
  while (/[a-z0-9-]/iu.test(input[cursor] ?? '')) cursor++
  const nameLength = cursor - nameStart
  const name = nameLength === 0 || nameLength > 32 ? undefined : input.slice(nameStart, cursor).toLowerCase()
  let quote: '"' | "'" | undefined
  let lastNonWhitespace = ''
  while (cursor < input.length) {
    const character = input[cursor]!
    if (quote === undefined && (character === '"' || character === "'")) quote = character
    else if (quote === character) quote = undefined
    else if (quote === undefined && character === '>') break
    if (!/\s/u.test(character)) lastNonWhitespace = character
    cursor++
  }
  const malformed = cursor >= input.length
  return {
    end: malformed ? input.length : cursor + 1,
    ...(name === undefined ? {} : { name }),
    closing,
    selfClosing: lastNonWhitespace === '/',
    malformed,
  }
}

function commentEnd(input: string, start: number): number {
  const close = input.indexOf('-->', start + 4)
  return close === -1 ? input.length : close + 3
}

function rawClosingEnd(input: string, start: number, name: string): number | undefined {
  if (input[start] !== '<' || input[start + 1] !== '/') return undefined
  let cursor = start + 2
  for (const expected of name) {
    if (input[cursor]?.toLowerCase() !== expected) return undefined
    cursor++
  }
  if (!/[\s>]/u.test(input[cursor] ?? '')) return undefined
  while (cursor < input.length && /\s/u.test(input[cursor]!)) cursor++
  if (input[cursor] === '>') return cursor + 1
  return input.length
}

function decodedEntityAt(input: string, start: number): { readonly value: string; readonly end: number } | undefined {
  for (const [raw, value] of [
    ['&amp;', '&'], ['&apos;', "'"], ['&gt;', '>'], ['&lt;', '<'], ['&nbsp;', ' '], ['&quot;', '"'],
  ] as const) {
    if (input.slice(start, start + raw.length).toLowerCase() === raw) return { value, end: start + raw.length }
  }
  if (input[start + 1] !== '#') return undefined
  let cursor = start + 2
  let base = 10
  if (input[cursor]?.toLowerCase() === 'x') {
    base = 16
    cursor++
  }
  const digitStart = cursor
  let value = 0
  while (cursor < input.length) {
    const code = input.charCodeAt(cursor)
    const digit = code >= 48 && code <= 57 ? code - 48
      : base === 16 && code >= 65 && code <= 70 ? code - 55
        : base === 16 && code >= 97 && code <= 102 ? code - 87
          : -1
    if (digit < 0 || digit >= base) break
    value = Math.min(0x110000, value * base + digit)
    cursor++
  }
  if (cursor === digitStart || input[cursor] !== ';') return undefined
  return {
    value: value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : ' ',
    end: cursor + 1,
  }
}

/** Single-pass, input-bounded HTML tokenizer with fail-closed suppression. */
function htmlToInertText(raw: string): string {
  const input = raw.slice(0, MAX_INPUT_CHARS)
  const chunks: string[] = []
  let buffer = ''
  const append = (value: string): void => {
    buffer += value
    if (buffer.length >= 4096) {
      chunks.push(buffer)
      buffer = ''
    }
  }
  let cursor = 0
  const suppressed: string[] = []
  let rawSuppressed: string | undefined
  while (cursor < input.length) {
    if (rawSuppressed !== undefined) {
      if (input[cursor] === '<') {
        const close = rawClosingEnd(input, cursor, rawSuppressed)
        if (close !== undefined) {
          cursor = close
          suppressed.pop()
          rawSuppressed = undefined
          if (suppressed.length === 0) append('\n')
          continue
        }
      }
      cursor++
      continue
    }

    if (input.startsWith('<!--', cursor)) {
      if (suppressed.length === 0) append(' ')
      cursor = commentEnd(input, cursor)
      continue
    }
    if (input[cursor] === '<') {
      const tag = parseTag(input, cursor)
      if (tag === undefined) {
        if (suppressed.length === 0) append('<')
        cursor++
        continue
      }
      cursor = tag.end
      if (tag.malformed) break
      if (suppressed.length > 0) {
        const top = suppressed.at(-1)!
        if (tag.closing && tag.name === top) {
          suppressed.pop()
          if (suppressed.length === 0) append('\n')
        } else if (!tag.closing && !tag.selfClosing && tag.name !== undefined
          && (RAW_SUPPRESSED_HTML_TAGS.has(tag.name) || TREE_SUPPRESSED_HTML_TAGS.has(tag.name))) {
          if (suppressed.length >= 32) break
          suppressed.push(tag.name)
          if (RAW_SUPPRESSED_HTML_TAGS.has(tag.name)) rawSuppressed = tag.name
        }
        continue
      }
      if (!tag.closing && !tag.selfClosing && tag.name !== undefined
        && (RAW_SUPPRESSED_HTML_TAGS.has(tag.name) || TREE_SUPPRESSED_HTML_TAGS.has(tag.name))) {
        suppressed.push(tag.name)
        if (RAW_SUPPRESSED_HTML_TAGS.has(tag.name)) rawSuppressed = tag.name
        append('\n')
        continue
      }
      append(tag.name !== undefined && BLOCK_HTML_TAGS.has(tag.name) ? '\n' : ' ')
      continue
    }
    if (suppressed.length > 0) {
      cursor++
      continue
    }
    if (input[cursor] === '&') {
      const entity = decodedEntityAt(input, cursor)
      if (entity !== undefined) {
        append(entity.value)
        cursor = entity.end
        continue
      }
    }
    append(input[cursor]!)
    cursor++
  }
  if (buffer.length > 0) chunks.push(buffer)
  return chunks.join('')
}

/** Convert a bounded fetched body into inert, normalized text. */
export function normalizeFetchedPage(page: FetchedPage): NormalizedPage {
  const decoded = page.mediaType === 'text/html'
    ? htmlToInertText(page.body)
    : page.body.slice(0, MAX_INPUT_CHARS)
  const lines = decoded
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map(line => line.replace(/[\t\f\v ]+/gu, ' ').trim())
    .filter(line => line.length > 0)
  const text = lines.join('\n').slice(0, MAX_NORMALIZED_TEXT)
  return {
    url: page.url,
    text,
    retrievedAt: page.retrievedAt,
    contentSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
  }
}

function canonicalAsciiToken(token: string): string {
  if (token === 'ids') return 'id'
  if (token.length > 3 && token.endsWith('s')) return token.slice(0, -1)
  return token
}

function queryTerms(query: string): { readonly terms: readonly string[]; readonly anchors: ReadonlySet<string> } {
  const raw = query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []
  const terms = new Set<string>()
  for (const token of raw) {
    const canonical = /\p{Script=Han}/u.test(token) ? token : canonicalAsciiToken(token)
    if (!STOPWORDS.has(canonical)) terms.add(canonical)
    if (/\p{Script=Han}/u.test(token) && [...token].length > 2) {
      const characters = [...token]
      for (let index = 0; index < characters.length - 1; index++) {
        terms.add(`${characters[index]}${characters[index + 1]}`)
      }
    }
  }
  const anchors = new Set(
    [...terms].filter(term => ASCII_ANCHORS.has(term) || CJK_ANCHORS.some(anchor => term.includes(anchor))),
  )
  return { terms: [...terms], anchors }
}

function paragraphTerms(paragraph: string): ReadonlySet<string> {
  const raw = paragraph.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []
  return new Set(raw.map(token => /\p{Script=Han}/u.test(token) ? token : canonicalAsciiToken(token)))
}

function termAppears(term: string, lowerParagraph: string, tokens: ReadonlySet<string>): boolean {
  return /\p{Script=Han}/u.test(term) ? lowerParagraph.includes(term) : tokens.has(term)
}

function matchingTerms(
  paragraph: string,
  terms: readonly string[],
): { readonly lower: string; readonly matched: readonly string[] } {
  const lower = paragraph.toLowerCase()
  const tokens = paragraphTerms(paragraph)
  return { lower, matched: terms.filter(term => termAppears(term, lower, tokens)) }
}

function meetsQueryThreshold(
  paragraph: string,
  terms: readonly string[],
  anchors: ReadonlySet<string>,
  requiredHits: number,
): boolean {
  const { matched } = matchingTerms(paragraph, terms)
  return matched.length >= requiredHits && (anchors.size === 0 || matched.some(term => anchors.has(term)))
}

/** Select one exact, contiguous query-relevant excerpt from normalized page text. */
export function extractPageEvidence(page: NormalizedPage, query: string): VerifiedPageEvidence | undefined {
  if (page.text.length === 0) return undefined
  const { terms, anchors } = queryTerms(query)
  if (terms.length === 0) return undefined
  const requiredHits = Math.min(2, terms.length)
  const paragraphPattern = /[^\n]+/gu
  const lines = [...page.text.matchAll(paragraphPattern)].map(match => ({
    start: match.index,
    end: match.index + match[0].length,
  }))
  let best: { start: number; end: number; score: number; firstHit: number } | undefined
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const start = lines[lineIndex]!.start
    const end = lines[Math.min(lines.length - 1, lineIndex + 11)]!.end
    const paragraph = page.text.slice(start, end)
    const { lower, matched: matchedTerms } = matchingTerms(paragraph, terms)
    if (matchedTerms.length < requiredHits) continue
    const anchorHits = matchedTerms.filter(term => anchors.has(term)).length
    if (anchors.size > 0 && anchorHits === 0) continue
    const localFirstHit = Math.min(...matchedTerms.map(term => lower.indexOf(term)).filter(index => index >= 0))
    const modelLikeIds = lower.match(/\b(?=[a-z0-9.-]*\d)[a-z][a-z0-9]*(?:[-.][a-z0-9]+)+\b/gu)?.length ?? 0
    const score = modelLikeIds * 2_000_000 + anchorHits * 1_000_000
      + matchedTerms.length * 10_000 + Math.min(paragraph.length, 2_000)
    if (best === undefined || score > best.score) {
      best = { start, end: start + paragraph.length, score, firstHit: start + localFirstHit }
    }
  }
  if (best === undefined) return undefined
  let start = best.start
  let end = best.end
  if (end - start > MAX_EXCERPT_LENGTH) {
    start = Math.max(best.start, best.firstHit - Math.floor(MAX_EXCERPT_LENGTH / 3))
    end = Math.min(best.end, start + MAX_EXCERPT_LENGTH)
    start = Math.max(best.start, end - MAX_EXCERPT_LENGTH)
  }
  while (start < end && /\s/u.test(page.text[start]!)) start++
  while (end > start && /\s/u.test(page.text[end - 1]!)) end--
  const excerpt = page.text.slice(start, end)
  if (excerpt.length === 0 || !meetsQueryThreshold(excerpt, terms, anchors, requiredHits)) return undefined
  return {
    finalUrl: page.url,
    excerpt,
    excerptStart: start,
    excerptEnd: end,
    retrievedAt: page.retrievedAt,
    contentSha256: page.contentSha256,
  }
}
