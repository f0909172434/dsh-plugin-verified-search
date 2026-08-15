import { createHash } from 'node:crypto'
import type {
  VerifiedPageEvidence,
  VerifiedResearchClaimScope,
  VerifiedResearchClaimValueKind,
} from './types.js'
import type { FetchedPage } from './page-fetch.js'

const MAX_NORMALIZED_TEXT = 2 * 1024 * 1024
export const MAX_EXCERPT_LENGTH = 2_000
const MAX_INPUT_CHARS = 2 * 1024 * 1024
const RAW_SUPPRESSED_HTML_TAGS = new Set(['iframe', 'script', 'style'])
const TREE_SUPPRESSED_HTML_TAGS = new Set(['canvas', 'footer', 'form', 'nav', 'noscript', 'svg', 'template'])
const CONTENT_ROOT_HTML_TAGS = new Set(['article', 'main'])
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
  readonly mediaType: FetchedPage['mediaType']
  readonly text: string
  readonly retrievedAt: string
  readonly contentSha256: string
  readonly derivedFrom?: string
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
  let expectsAttributeValue = false
  let unquotedAttributeValue = false
  let lastNonWhitespace = ''
  while (cursor < input.length) {
    const character = input[cursor]!
    if (quote !== undefined) {
      if (quote === character) quote = undefined
    } else if (character === '>') {
      break
    } else if (/\s/u.test(character)) {
      unquotedAttributeValue = false
    } else if (expectsAttributeValue) {
      if (character === '"' || character === "'") quote = character
      else unquotedAttributeValue = true
      expectsAttributeValue = false
    } else if (!unquotedAttributeValue && character === '=') {
      expectsAttributeValue = true
    }
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
        // Real-world pages sometimes leave navigation tags implicitly closed.
        // A document content root cannot remain inside that suppressed chrome;
        // raw-text script/style suppression is handled by the branch above.
        if (!tag.closing && !tag.selfClosing && tag.name !== undefined
          && CONTENT_ROOT_HTML_TAGS.has(tag.name)
          && suppressed.every(name => TREE_SUPPRESSED_HTML_TAGS.has(name))) {
          suppressed.length = 0
          append('\n')
          append(BLOCK_HTML_TAGS.has(tag.name) ? '\n' : ' ')
          continue
        }
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
  const decoded = page.mediaType === 'text/html' || page.mediaType === 'application/xhtml+xml'
    ? htmlToInertText(page.body)
    : page.body.slice(0, MAX_INPUT_CHARS)
  const lines = decoded
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map(line => line.replace(/[\p{White_Space}]+/gu, ' ').trim())
    .filter(line => line.length > 0)
  const text = lines.join('\n').slice(0, MAX_NORMALIZED_TEXT)
  return {
    url: page.url,
    mediaType: page.mediaType,
    text,
    retrievedAt: page.retrievedAt,
    contentSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    ...(page.derivedFrom === undefined ? {} : { derivedFrom: page.derivedFrom }),
  }
}

function canonicalAsciiToken(token: string): string {
  if (token === 'ids') return 'id'
  if (['remediation', 'remediated', 'remediating'].includes(token)) return 'remediate'
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

function requiresVersionValue(query: string): boolean {
  return /(?:latest\s+(?:stable\s+)?(?:release\s+)?version|version\s+number|(?:fixed|patched|software)\s+releases?|affected\s+versions?|版本號|版本号)/iu.test(query)
}

type VersionListIntent = 'fixed' | 'affected'

const FIXED_VERSION_LABEL = /\b(?:fixed\s+software|hot\s+fix\s+name|patched\s+(?:versions?|releases?)|fixed\s+(?:versions?|releases?)|versions?\s+with\s+(?:the\s+)?fix)\b/iu
const AFFECTED_VERSION_LABEL = /\b(?:(?:affected|vulnerable)\s+(?:software\s+)?(?:versions?|releases?))\b/iu
const AFFECTED_VERSION_BOUNDARY = /\b(?:affected\s+products?|(?:affected|vulnerable)\s+(?:software\s+)?(?:versions?|releases?))\b/iu
const PRODUCT_VERSION_VALUE = /\b[vV]?\d+(?:\.\d+){1,4}(?:[-+][0-9A-Za-z.-]+)?\b/u
const VERSION_BLOCK_BOUNDARY = /^\s*(?:workarounds?|summary|references?|revision\s+history|cvss\b.*|vulnerability\s+(?:details?|information)|indicators?\s+of\s+compromise)\s*:?[\s\S]*$/iu
const MAX_VERSION_BLOCK_LINES = 8
const MAX_VERSION_BLOCK_CHARS = 600

function versionListIntents(query: string): readonly VersionListIntent[] {
  if (!/\b(?:versions?|releases?|hot\s+fix)\b/iu.test(query)) return []
  const intents: VersionListIntent[] = []
  if (/\b(?:fixed|patched|hot\s+fix)\b/iu.test(query)) intents.push('fixed')
  if (/\b(?:affected|vulnerable)\b/iu.test(query)) intents.push('affected')
  return intents
}

function containsIntentVersionBlock(value: string, intent: VersionListIntent): boolean {
  const lines = value.split('\n')
  const ownLabel = intent === 'fixed' ? FIXED_VERSION_LABEL : AFFECTED_VERSION_LABEL
  const oppositeLabel = intent === 'fixed' ? AFFECTED_VERSION_BOUNDARY : FIXED_VERSION_LABEL
  for (let labelIndex = 0; labelIndex < lines.length; labelIndex++) {
    const labelLine = lines[labelIndex]!
    if (!ownLabel.test(labelLine) || oppositeLabel.test(labelLine)) continue
    let characters = 0
    for (let index = labelIndex; index < lines.length && index < labelIndex + MAX_VERSION_BLOCK_LINES; index++) {
      const line = lines[index]!
      characters += line.length + (index === labelIndex ? 0 : 1)
      if (characters > MAX_VERSION_BLOCK_CHARS) break
      if (index > labelIndex && (oppositeLabel.test(line) || VERSION_BLOCK_BOUNDARY.test(line))) break
      if (PRODUCT_VERSION_VALUE.test(line)) return true
    }
  }
  return false
}

function containsVersionList(value: string, query: string): boolean {
  const intents = versionListIntents(query)
  return intents.length === 0 || intents.every(intent => containsIntentVersionBlock(value, intent))
}

function requiresCalendarDate(query: string): boolean {
  return /(?:release\s+date|meeting\s+(?:date|dates|date\s+range)|scheduled\s+meeting\s+(?:date|dates|range)|date\s+range|end[- ]of[- ](?:life|support)|security(?:-fix)?\s+(?:support\s+)?(?:until|date|end)|due\s+date|發布日期|发布日期|支援截止|支持截止|會議日期|会议日期)/iu.test(query)
}

function requiresActualMissionEvent(query: string): boolean {
  return /\bactual\b/iu.test(query) && /\b(?:launch|liftoff|splashdown|landing)\b/iu.test(query)
}

function containsActualMissionEvent(value: string, query: string): boolean {
  if (!requiresActualMissionEvent(query)) return true
  if (/\b(?:no|not|never)\b.{0,80}\b(?:launch|liftoff|splashdown|landing)\b/isu.test(value)
    || /\b(?:launch|liftoff|splashdown|landing)\b.{0,80}\b(?:planned|planning|scheduled|targeted|expected|pending)\b/isu.test(value)) return false
  if (/\b(?:launch|liftoff)\b/iu.test(query)) {
    return /\b(?:launched|lifted\s+off|liftoff\s+(?:occurred|was)|launch\s+(?:occurred|was))\b/iu.test(value)
  }
  return /\b(?:splashed\s+down|splashdown\s+(?:occurred|was)|landed|landing\s+(?:occurred|was))\b/iu.test(value)
}

function requiresActualMissionMetric(query: string): boolean {
  return /\bactual\b/iu.test(query)
    && /\b(?:total\s+)?(?:miles?|distance|duration|days?)\b/iu.test(query)
}

function containsActualMissionMetric(value: string, query: string): boolean {
  if (!requiresActualMissionMetric(query)) return true
  if (/\b(?:planned|planning|scheduled|targeted|expected|will|would)\b.{0,100}\b(?:miles?|days?|duration|distance)\b/isu.test(value)) return false
  if (!/\b(?:completed|concluded|ended|returned|splashed\s+down)\b/iu.test(value)) return false
  if (/\b(?:miles?|distance)\b/iu.test(query)) {
    return /\b(?:traveled|travelled|covered|flew)\b.{0,100}\b\d[\d,.]*\s+miles?\b/isu.test(value)
  }
  return /\b(?:lasted|duration\s+(?:was|of)|mission\s+time\s+(?:was|of))\b.{0,100}\b\d+(?:\.\d+)?\s+days?\b/isu.test(value)
}

function requiresDissentNames(query: string): boolean {
  return /(?:\bdissent(?:er)?s?\b|\bvoting\s+against\b|反對者|反对者)/iu.test(query)
}

function requiresDissentAction(query: string): boolean {
  return /(?:\bpreferred\s+(?:action|move|policy)?\b|\bpreference\b|偏好(?:動作|动作|政策)?)/iu.test(query)
}

function requiresExtremumAssertion(query: string): boolean {
  return /\b(?:maximum|max|highest|largest|minimum|min|lowest|smallest)\b/iu.test(query)
}

function requiresTieCompleteness(query: string): boolean {
  return /(?:\bties?\b|\bunique\b|\ball\s+(?:maximum|max|highest|largest|minimum|min|lowest|smallest)\b|並列|并列|唯一)/iu.test(query)
}

function requiresLatestAssertion(query: string): boolean {
  return /(?:\blatest\b|\bnewest\b|最新)/iu.test(query)
}

function containsVersionValue(value: string): boolean {
  return /\bv?\d+\.\d+(?:\.\d+)?(?:[-+][a-z0-9.-]+)?\b/iu.test(value)
}

function containsCalendarDate(value: string): boolean {
  return /\b(?:\d{4}-\d{2}(?:-\d{2})?|\d{1,2}(?:[-–]\d{1,2})?\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}|(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:[-–]\d{1,2})?,?\s+\d{4})\b/iu.test(value)
}

function containsDissentNames(value: string): boolean {
  return /(?:\bvoting\s+against\b|\bdissent(?:er)?s?\b|反對者|反对者)/iu.test(value)
    && /\b[A-Z][a-z]+(?:\s+[A-Z]\.)?\s+[A-Z][a-z]+\b/u.test(value)
}

function containsDissentAction(value: string): boolean {
  return /(?:\bpreferred\b|\braise\b|\bincrease\b|\bhike\b|\blower\b|\bdecrease\b|\bcut\b|\breduce\b|\bmaintain\b|\bhold\b|偏好|升息|降息|維持|维持)/iu.test(value)
    && /(?:\btarget\s+range\b|\bpercentage\s+point\b|\bbasis\s+points?\b|目標區間|目标区间|百分點|百分点)/iu.test(value)
}

function containsExtremumAssertion(value: string, query: string): boolean {
  if (!requiresExtremumAssertion(query)) return true
  const asksMinimum = /\b(?:minimum|min|lowest|smallest)\b/iu.test(query)
  return (asksMinimum
    ? /\b(?:minimum|min|lowest|smallest)\b/iu
    : /\b(?:maximum|max|highest|largest)\b/iu).test(value)
}

function containsTieCompleteness(value: string, query: string): boolean {
  if (!requiresTieCompleteness(query)) return true
  return /(?:\bties?\b|\bunique\b|\bonly\b|\bsole\b|\bno\s+other\b|並列|并列|唯一)/iu.test(value)
}

function containsLatestValueWindow(paragraph: string, query: string, calendarDateValidated = false): boolean {
  if (!requiresLatestAssertion(query)) return true
  const lines = paragraph.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const window = `${lines[index] ?? ''}\n${lines[index + 1] ?? ''}`
    if (!/(?:\blatest\b|\bnewest\b|最新)/iu.test(window)) continue
    if (requiresVersionValue(query) && !containsVersionValue(window)) continue
    if (requiresCalendarDate(query) && !calendarDateValidated && !containsCalendarDate(window)) continue
    return true
  }
  return false
}

const CVSS_V34_VECTOR = /\bCVSS:(3\.[01]|4\.0)\/([A-Z]{1,4}:[A-Z0-9.-]+(?:\/[A-Z]{1,4}:[A-Z0-9.-]+){5,})\b/gu
const CVSS_V2_VECTOR = /\bAV:[NAL]\/AC:[LMH]\/Au:[MSN]\/C:[NPC]\/I:[NPC]\/A:[NPC]\b/gu

function completeCvssV34Vectors(value: string): readonly {
  readonly version: string
  readonly vector: string
  readonly index: number
}[] {
  const accepted: Array<{ readonly version: string; readonly vector: string; readonly index: number }> = []
  for (const match of value.matchAll(CVSS_V34_VECTOR)) {
    const version = match[1]!
    const segments = match[2]!.split('/')
    const keys = new Set(segments.map(segment => segment.slice(0, segment.indexOf(':'))))
    const required = version === '4.0'
      ? ['AV', 'AC', 'AT', 'PR', 'UI', 'VC', 'VI', 'VA', 'SC', 'SI', 'SA']
      : ['AV', 'AC', 'PR', 'UI', 'S', 'C', 'I', 'A']
    if (required.every(key => keys.has(key))) accepted.push({ version, vector: match[0], index: match.index })
  }
  return accepted
}

function concreteCvssVersions(value: string): ReadonlySet<string> {
  const versions = new Set<string>()
  for (const match of value.matchAll(/\bCVSS(?:\s+Version)?\s*(4\.0|3\.[01]|2\.0)\b/giu)) versions.add(match[1]!)
  for (const vector of completeCvssV34Vectors(value)) versions.add(vector.version)
  return versions
}

const CVSS_BASE_SCORE = /\bBase[\p{White_Space}]+Score\s*:?\s*(10(?:\.0)?|[0-9](?:\.[0-9])?)\b/giu
const CVSS_BASE_SCORE_LABEL = /\bBase[\p{White_Space}]+Score\b/giu
const CVSS_METRIC_SECTION = /(?:^|\n)CVSS\s+(4\.0|3\.[01]|3\.x|2\.0)\s+Severity and Vector Strings\s*:[^\n]*(?:\n|$)/giu

function labeledCvssBaseScore(value: string): { readonly score: number; readonly block: string } | undefined {
  const match = [...value.matchAll(CVSS_BASE_SCORE)][0]
  if (match === undefined) return undefined
  const score = Number(match[1])
  if (!Number.isFinite(score) || score < 0 || score > 10) return undefined
  const start = Math.max(0, match.index - 500)
  const end = Math.min(value.length, match.index + match[0].length + 500)
  return { score, block: value.slice(start, end) }
}

function concreteCvssV34Metrics(value: string): readonly {
  readonly version: string
  readonly vector: string
  readonly score: number
}[] {
  const sections = [...value.matchAll(CVSS_METRIC_SECTION)].map((match, index, matches) => ({
    start: match.index,
    end: matches[index + 1]?.index ?? value.length,
    declaredVersion: match[1]!,
  }))
  const scores = [...value.matchAll(CVSS_BASE_SCORE)].map(match => ({
    index: match.index,
    end: match.index + match[0].length,
    score: Number(match[1]),
  })).filter(match => Number.isFinite(match.score) && match.score >= 0 && match.score <= 10)
  const accepted: Array<{ readonly version: string; readonly vector: string; readonly score: number }> = []
  for (const vector of completeCvssV34Vectors(value)) {
    const section = sections.find(candidate => candidate.start <= vector.index && vector.index < candidate.end)
    if (section !== undefined
      && section.declaredVersion !== vector.version
      && !(section.declaredVersion === '3.x' && /^3\.[01]$/u.test(vector.version))) continue
    const rangeStart = section?.start ?? Math.max(0, vector.index - 500)
    const rangeEnd = section?.end ?? Math.min(value.length, vector.index + vector.vector.length + 500)
    if (section === undefined) {
      const context = value.slice(rangeStart, rangeEnd)
      const versionLabel = new RegExp(`\\bCVSS(?:\\s+Version)?\\s*${vector.version.replace('.', '\\.')}\\b`, 'iu')
      if (!versionLabel.test(context)) continue
    }
    const score = scores
      .filter(candidate => candidate.index >= rangeStart && candidate.end <= rangeEnd
        && candidate.end <= vector.index && vector.index - candidate.end <= 500)
      .toSorted((left, right) => vector.index - left.end - (vector.index - right.end))[0]
    if (score === undefined) continue
    const pairStart = Math.min(score.index, vector.index)
    const pairEnd = Math.max(score.end, vector.index + vector.vector.length)
    const pair = value.slice(pairStart, pairEnd)
    if (completeCvssV34Vectors(pair).length !== 1
      || [...pair.matchAll(CVSS_BASE_SCORE_LABEL)].length !== 1) continue
    accepted.push({ version: vector.version, vector: vector.vector, score: score.score })
  }
  return accepted
}

function meetsDeclaredValueKind(value: string, valueKind: VerifiedResearchClaimValueKind): boolean {
  if (valueKind === 'generic_text') return true
  const v34 = concreteCvssV34Metrics(value)
  const v2 = [...value.matchAll(CVSS_V2_VECTOR)]
    .some(match => concreteCvssVersions(value.slice(Math.max(0, match.index! - 500), match.index! + match[0].length + 500)).has('2.0'))
  if (valueKind === 'cvss_vector') return v34.length > 0 || v2
  const baseScore = labeledCvssBaseScore(value)
  if (valueKind === 'cvss_base_score') {
    if (baseScore === undefined) return false
    const versions = concreteCvssVersions(baseScore.block)
    const v2InScoreBlock = [...baseScore.block.matchAll(CVSS_V2_VECTOR)].length > 0
      && versions.size === 1 && versions.has('2.0')
    return concreteCvssV34Metrics(baseScore.block).length > 0 || v2InScoreBlock
  }
  return v34.length > 0 || v2
}

function meetsValueRequirements(
  paragraph: string,
  query: string,
  calendarDateValidated = false,
  valueKind: VerifiedResearchClaimValueKind = 'generic_text',
): boolean {
  return (!requiresVersionValue(query) || containsVersionValue(paragraph))
    && (!requiresCalendarDate(query) || calendarDateValidated || containsCalendarDate(paragraph))
    && (!requiresActualMissionEvent(query) || containsCalendarDate(paragraph))
    && containsActualMissionEvent(paragraph, query)
    && containsActualMissionMetric(paragraph, query)
    && (!requiresDissentNames(query) || containsDissentNames(paragraph))
    && (!requiresDissentAction(query) || containsDissentAction(paragraph))
    && containsExtremumAssertion(paragraph, query)
    && containsTieCompleteness(paragraph, query)
    && containsVersionList(paragraph, query)
    && containsLatestValueWindow(paragraph, query, calendarDateValidated)
    && meetsDeclaredValueKind(paragraph, valueKind)
}

interface ComparableText {
  readonly text: string
  readonly starts: readonly number[]
  readonly ends: readonly number[]
}

function comparablePhraseTextWithOffsets(value: string): ComparableText {
  let text = ''
  const starts: number[] = []
  const ends: number[] = []
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index)!
    const raw = String.fromCodePoint(codePoint)
    const next = index + raw.length
    if (/[\p{White_Space}\u0000-\u001f\u007f]/u.test(raw)) {
      if (text.length > 0 && !text.endsWith(' ')) {
        text += ' '
        starts.push(index)
        ends.push(next)
      }
      index = next
      continue
    }
    const canonical = /[\u2018\u2019\u201b\u2032]/u.test(raw) ? "'"
      : /[\u2010-\u2015\u2212]/u.test(raw) ? '-'
        : raw.toLowerCase()
    for (const character of canonical) {
      text += character
      starts.push(index)
      ends.push(next)
    }
    index = next
  }
  if (text.endsWith(' ')) {
    text = text.slice(0, -1)
    starts.pop()
    ends.pop()
  }
  return { text, starts, ends }
}

function comparablePhraseText(value: string): string {
  return comparablePhraseTextWithOffsets(value).text
}

function containsRequiredPhrases(value: string, requiredPhrases: readonly string[]): boolean {
  if (requiredPhrases.length === 0) return true
  const comparable = comparablePhraseText(value)
  return requiredPhrases.every(phrase => comparable.includes(comparablePhraseText(phrase)))
}

function requiredPhraseSpan(
  value: string,
  requiredPhrases: readonly string[],
): { readonly start: number; readonly end: number } | undefined {
  if (requiredPhrases.length === 0) return undefined
  const comparable = comparablePhraseTextWithOffsets(value)
  const occurrences = requiredPhrases.map((phrase) => {
    const needle = comparablePhraseText(phrase)
    const matches: Array<{ readonly start: number; readonly end: number }> = []
    let cursor = 0
    while (matches.length < 64) {
      const start = comparable.text.indexOf(needle, cursor)
      if (start < 0) break
      matches.push({ start, end: start + needle.length })
      cursor = start + Math.max(1, needle.length)
    }
    return matches
  })
  if (occurrences.some(matches => matches.length === 0)) return undefined
  let best: { readonly start: number; readonly end: number } | undefined
  for (const candidates of occurrences) {
    for (const anchor of candidates) {
      let start = anchor.start
      let end = anchor.end
      let valid = true
      for (const matches of occurrences) {
        const nearest = matches.toSorted((left, right) => {
          const leftDistance = left.end < start ? start - left.end : left.start > end ? left.start - end : 0
          const rightDistance = right.end < start ? start - right.end : right.start > end ? right.start - end : 0
          return leftDistance - rightDistance
        })[0]
        if (nearest === undefined) {
          valid = false
          break
        }
        start = Math.min(start, nearest.start)
        end = Math.max(end, nearest.end)
      }
      if (valid && (best === undefined || end - start < best.end - best.start)) best = { start, end }
    }
  }
  if (best === undefined || best.end <= best.start) return undefined
  return {
    start: comparable.starts[best.start]!,
    end: comparable.ends[best.end - 1]!,
  }
}

interface PositionedLine {
  readonly start: number
  readonly end: number
  readonly text: string
}

interface ParsedEventRow {
  readonly start: number
  readonly end: number
  readonly contextStart: number
  readonly year: number
  readonly month: number
  readonly day: number
  readonly endDay: number
  readonly ordinal: number
}

const MONTH_NUMBER = new Map<string, number>([
  ['january', 1], ['february', 2], ['march', 3], ['april', 4], ['may', 5], ['june', 6],
  ['july', 7], ['august', 8], ['september', 9], ['october', 10], ['november', 11], ['december', 12],
])
const MONTH_NAME = '(january|february|march|april|may|june|july|august|september|october|november|december)'
const METADATA_DATE_LINE = /(?:\blast\s+update\b|\bupdated\b|\breleased\b|\bfor\s+release\b|\bpublished\b)/iu
const METADATA_DATE_LABEL = /^\s*(?:last\s+update|updated|released|for\s+release|published)\s*:?\s*$/iu

function positionedLines(text: string): readonly PositionedLine[] {
  return [...text.matchAll(/[^\n]+/gu)].map(match => ({
    start: match.index,
    end: match.index + match[0].length,
    text: match[0],
  }))
}

function parseYearMonth(value: string): { readonly year: number; readonly month: number } | undefined {
  const match = /^(\d{4})-(\d{2})$/u.exec(value)
  if (match === null) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  return year >= 1900 && year <= 2999 && month >= 1 && month <= 12 ? { year, month } : undefined
}

function parseIsoDate(value: string): { readonly year: number; readonly month: number; readonly day: number } | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
  if (match === null) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1900 || year > 2999 || month < 1 || month > 12 || day < 1 || day > 31) return undefined
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? { year, month, day }
    : undefined
}

function yearMonthsIn(value: string): ReadonlySet<string> {
  const result = new Set<string>()
  const add = (yearText: string, monthText: string): void => {
    const year = Number(yearText)
    const month = Number(monthText)
    if (year >= 1900 && year <= 2999 && month >= 1 && month <= 12) {
      result.add(`${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}`)
    }
  }
  for (const match of value.matchAll(/(?:^|\D)(\d{4})[-/](\d{2})(?:[-/]\d{2})?(?=\D|$)/gu)) add(match[1]!, match[2]!)
  for (const match of value.matchAll(/(?:^|\D)(\d{4})(\d{2})\d{2}(?=\D|$)/gu)) add(match[1]!, match[2]!)
  for (const match of value.matchAll(/(?:^|\D)\d{1,2}\.(\d{1,2})\.(\d{4})(?=\D|$)/gu)) add(match[2]!, match[1]!)
  const monthFirst = new RegExp(`\\b${MONTH_NAME}\\s+\\d{1,2}(?:[-–]\\d{1,2})?,?\\s+(\\d{4})\\b`, 'giu')
  for (const match of value.matchAll(monthFirst)) add(match[2]!, String(MONTH_NUMBER.get(match[1]!.toLowerCase())))
  const dayFirst = new RegExp(`\\b\\d{1,2}(?:[-–]\\d{1,2})?\\s+${MONTH_NAME}\\s+(\\d{4})\\b`, 'giu')
  for (const match of value.matchAll(dayFirst)) add(match[2]!, String(MONTH_NUMBER.get(match[1]!.toLowerCase())))
  return result
}

function matchesDocumentTemporalAnchor(page: NormalizedPage, value: string): boolean {
  const expected = parseYearMonth(value)
  if (expected === undefined) return false
  const key = `${expected.year.toString().padStart(4, '0')}-${expected.month.toString().padStart(2, '0')}`
  const urlValues = yearMonthsIn(page.url)
  if (urlValues.size > 0) return urlValues.has(key)
  const header = page.text.split('\n').slice(0, 24).join('\n')
  return yearMonthsIn(header).has(key)
}

function sectionYear(line: string): number | undefined {
  const labelled = /^\s*(19\d{2}|20\d{2}|21\d{2})\b.*\b(?:meetings?|calendar|schedule|events?|sessions?)\b\s*$/iu.exec(line)
  if (labelled !== null) return Number(labelled[1])
  const bare = /^\s*(19\d{2}|20\d{2}|21\d{2})\s*$/u.exec(line)
  return bare === null ? undefined : Number(bare[1])
}

function hasMetadataDateLabel(line: string): boolean {
  return METADATA_DATE_LINE.test(line)
}

function validEventDate(year: number, month: number, day: number, endDay: number): boolean {
  if (endDay < day) return false
  const first = new Date(Date.UTC(year, month - 1, day))
  const last = new Date(Date.UTC(year, month - 1, endDay))
  return first.getUTCFullYear() === year && first.getUTCMonth() === month - 1 && first.getUTCDate() === day
    && last.getUTCFullYear() === year && last.getUTCMonth() === month - 1 && last.getUTCDate() === endDay
}

function parsedEventRows(lines: readonly PositionedLine[]): readonly ParsedEventRow[] {
  const rows: ParsedEventRow[] = []
  let currentYear: number | undefined
  let headingStart: number | undefined
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const headingYear = sectionYear(line.text)
    if (headingYear !== undefined) {
      currentYear = headingYear
      headingStart = line.start
      continue
    }
    const previousIsMetadataLabel = index > 0 && METADATA_DATE_LABEL.test(lines[index - 1]!.text)
    if (hasMetadataDateLabel(line.text) || previousIsMetadataLabel) continue

    let year = currentYear
    let month: number | undefined
    let day: number | undefined
    let endDay: number | undefined
    let end = line.end

    const iso = /\b(\d{4})-(\d{2})-(\d{2})(?:\s*(?:\/|[-–])\s*(?:(\d{4})-(\d{2})-)?(\d{2}))?\b/u.exec(line.text)
    if (iso !== null) {
      year = Number(iso[1])
      month = Number(iso[2])
      day = Number(iso[3])
      if (iso[4] !== undefined && Number(iso[4]) !== year) continue
      if (iso[5] !== undefined && Number(iso[5]) !== month) continue
      endDay = iso[6] === undefined ? day : Number(iso[6])
    } else {
      const monthFirst = new RegExp(`\\b${MONTH_NAME}\\s+(\\d{1,2})(?:\\s*[-–]\\s*(\\d{1,2}))?\\*?,?(?:\\s+(\\d{4}))?\\b`, 'iu').exec(line.text)
      const dayFirst = new RegExp(`\\b(\\d{1,2})(?:\\s*[-–]\\s*(\\d{1,2}))?\\*?\\s+${MONTH_NAME}(?:\\s+(\\d{4}))?\\b`, 'iu').exec(line.text)
      if (monthFirst !== null) {
        month = MONTH_NUMBER.get(monthFirst[1]!.toLowerCase())
        day = Number(monthFirst[2])
        endDay = monthFirst[3] === undefined ? day : Number(monthFirst[3])
        if (monthFirst[4] !== undefined) year = Number(monthFirst[4])
      } else if (dayFirst !== null) {
        day = Number(dayFirst[1])
        endDay = dayFirst[2] === undefined ? day : Number(dayFirst[2])
        month = MONTH_NUMBER.get(dayFirst[3]!.toLowerCase())
        if (dayFirst[4] !== undefined) year = Number(dayFirst[4])
      } else {
        const monthOnly = new RegExp(`^\\s*${MONTH_NAME}\\s*$`, 'iu').exec(line.text)
        const next = lines[index + 1]
        const days = next === undefined ? null : /^\s*(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\*?\s*$/u.exec(next.text)
        if (monthOnly === null || days === null || hasMetadataDateLabel(next!.text)) continue
        month = MONTH_NUMBER.get(monthOnly[1]!.toLowerCase())
        day = Number(days[1])
        endDay = days[2] === undefined ? day : Number(days[2])
        end = next!.end
      }
    }
    if (year === undefined || month === undefined || day === undefined || endDay === undefined
      || !validEventDate(year, month, day, endDay)) continue
    rows.push({
      start: line.start,
      end,
      contextStart: headingStart ?? line.start,
      year,
      month,
      day,
      endDay,
      ordinal: Date.UTC(year, month - 1, day),
    })
  }
  return rows
}

function eventRowEvidence(
  page: NormalizedPage,
  query: string,
  requiredPhrases: readonly string[],
  scope: Extract<VerifiedResearchClaimScope, { readonly kind: 'event_row' }>,
  valueKind: VerifiedResearchClaimValueKind,
): VerifiedPageEvidence | undefined {
  const lines = positionedLines(page.text)
  const rows = parsedEventRows(lines)
  const anchor = scope.temporalAnchor
  let candidates: readonly ParsedEventRow[]
  if (anchor.kind === 'year_month') {
    const expected = parseYearMonth(anchor.value)
    if (expected === undefined) return undefined
    candidates = rows.filter(row => row.year === expected.year && row.month === expected.month)
  } else {
    const cutoff = parseIsoDate(anchor.value)
    if (cutoff === undefined || anchor.select !== 'first') return undefined
    const cutoffOrdinal = Date.UTC(cutoff.year, cutoff.month - 1, cutoff.day)
    const after = rows.filter(row => row.ordinal > cutoffOrdinal).toSorted((left, right) => left.ordinal - right.ordinal)
    if (after.length === 0) return undefined
    const firstOrdinal = after[0]!.ordinal
    candidates = after.filter(row => row.ordinal === firstOrdinal)
  }
  const { terms, anchors } = queryTerms(query)
  if (terms.length === 0) return undefined
  const requiredHits = Math.min(2, terms.length)
  const allPhrases = [...requiredPhrases, ...scope.mustInclude]
  let best: { readonly start: number; readonly end: number; readonly score: number } | undefined
  for (const row of candidates) {
    let start = row.contextStart
    let end = row.end
    while (start < end && /\s/u.test(page.text[start]!)) start++
    while (end > start && /\s/u.test(page.text[end - 1]!)) end--
    if (end - start > MAX_EXCERPT_LENGTH) continue
    const excerpt = page.text.slice(start, end)
    if (!meetsQueryThreshold(excerpt, terms, anchors, requiredHits)
      || !containsRequiredPhrases(excerpt, allPhrases)
      || !meetsValueRequirements(excerpt, query, true, valueKind)) continue
    const { matched } = matchingTerms(excerpt, terms)
    const score = matched.length * 10_000 + Math.min(excerpt.length, MAX_EXCERPT_LENGTH)
    if (best === undefined || score > best.score) best = { start, end, score }
  }
  if (best === undefined) return undefined
  return {
    finalUrl: page.url,
    excerpt: page.text.slice(best.start, best.end),
    excerptStart: best.start,
    excerptEnd: best.end,
    retrievedAt: page.retrievedAt,
    contentSha256: page.contentSha256,
  }
}

/** Select one exact, contiguous query-relevant excerpt from normalized page text. */
export function extractPageEvidence(
  page: NormalizedPage,
  query: string,
  requiredPhrases: readonly string[] = [],
  scope?: VerifiedResearchClaimScope,
  valueKind: VerifiedResearchClaimValueKind = 'generic_text',
): VerifiedPageEvidence | undefined {
  if (page.text.length === 0) return undefined
  if (scope?.kind === 'event_row') return eventRowEvidence(page, query, requiredPhrases, scope, valueKind)
  if (scope?.temporalAnchor !== undefined
    && !matchesDocumentTemporalAnchor(page, scope.temporalAnchor.value)) return undefined
  if (scope !== undefined && !containsRequiredPhrases(page.text, scope.mustInclude)) return undefined
  const scopedPhrases = requiredPhrases
  const { terms, anchors } = queryTerms(query)
  if (terms.length === 0) return undefined
  const requiredHits = Math.min(2, terms.length)
  const identifierIntent = terms.some(term => ['flagship', 'id', 'identifier', 'version'].includes(term))
  const normalizedQuery = query.toLowerCase().replace(/[\p{White_Space}]+/gu, ' ')
  const sectionLabels = normalizedQuery.match(/\b(?:article|chapter|section)\s+[a-z0-9-]+\b/gu) ?? []
  const paragraphPattern = /[^\n]+/gu
  const lines = [...page.text.matchAll(paragraphPattern)].map(match => ({
    start: match.index,
    end: match.index + match[0].length,
  }))
  let best: {
    start: number
    end: number
    score: number
    firstHit: number
    requiredStart: number
    requiredEnd: number
  } | undefined
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const start = lines[lineIndex]!.start
    const contextLineOffset = valueKind === 'generic_text' ? 11 : 23
    const end = lines[Math.min(lines.length - 1, lineIndex + contextLineOffset)]!.end
    const paragraph = page.text.slice(start, end)
    const { lower, matched: matchedTerms } = matchingTerms(paragraph, terms)
    const latestUrlAssertion = requiresLatestAssertion(query) && /(?:^|[\/_-])latest(?:[\/_-]|$)/iu.test(page.url)
    if (matchedTerms.length < requiredHits
      || !containsRequiredPhrases(paragraph, scopedPhrases)
      || (!latestUrlAssertion && !meetsValueRequirements(paragraph, query, false, valueKind))
      || (latestUrlAssertion
        && ((!requiresVersionValue(query) || !containsVersionValue(paragraph))
          || (!requiresCalendarDate(query) || !containsCalendarDate(paragraph))))) continue
    const phraseSpan = requiredPhraseSpan(paragraph, scopedPhrases)
    if (scopedPhrases.length > 0 && phraseSpan === undefined) continue
    const anchorHits = matchedTerms.filter(term => anchors.has(term)).length
    if (anchors.size > 0 && anchorHits === 0) continue
    const localFirstHit = Math.min(...matchedTerms.map(term => lower.indexOf(term)).filter(index => index >= 0))
    const modelLikeIds = identifierIntent
      ? lower.match(/\b(?=[a-z0-9.-]*\d)[a-z][a-z0-9]*(?:[-.][a-z0-9]+)+\b/gu)?.length ?? 0
      : 0
    const headingHit = sectionLabels.some(label => lower.startsWith(label))
    const score = (headingHit ? 5_000_000 : 0) + modelLikeIds * 2_000_000 + anchorHits * 1_000_000
      + matchedTerms.length * 10_000 + Math.min(paragraph.length, 2_000)
    if (best === undefined || score > best.score) {
      best = {
        start,
        end: start + paragraph.length,
        score,
        firstHit: start + localFirstHit,
        requiredStart: start + (phraseSpan?.start ?? localFirstHit),
        requiredEnd: start + (phraseSpan?.end ?? localFirstHit + 1),
      }
    }
  }
  if (best === undefined) return undefined
  let start = best.start
  let end = best.end
  if (end - start > MAX_EXCERPT_LENGTH) {
    if (best.requiredEnd - best.requiredStart > MAX_EXCERPT_LENGTH) return undefined
    const earliestStart = Math.max(best.start, best.requiredEnd - MAX_EXCERPT_LENGTH)
    const latestStart = Math.min(best.requiredStart, best.end - 1)
    const preferredStart = best.firstHit - Math.floor(MAX_EXCERPT_LENGTH / 3)
    start = Math.min(latestStart, Math.max(earliestStart, preferredStart))
    end = Math.min(best.end, start + MAX_EXCERPT_LENGTH)
    start = Math.max(best.start, end - MAX_EXCERPT_LENGTH)
  }
  while (start < end && /\s/u.test(page.text[start]!)) start++
  while (end > start && /\s/u.test(page.text[end - 1]!)) end--
  const excerpt = page.text.slice(start, end)
  if (excerpt.length === 0
    || !meetsQueryThreshold(excerpt, terms, anchors, requiredHits)
    || !containsRequiredPhrases(excerpt, scopedPhrases)
    || (!/(?:^|[\/_-])latest(?:[\/_-]|$)/iu.test(page.url)
      && !meetsValueRequirements(excerpt, query, false, valueKind))
    || (/(?:^|[\/_-])latest(?:[\/_-]|$)/iu.test(page.url)
      && ((!requiresVersionValue(query) || !containsVersionValue(excerpt))
        || (!requiresCalendarDate(query) || !containsCalendarDate(excerpt))))) return undefined
  return {
    finalUrl: page.url,
    excerpt,
    excerptStart: start,
    excerptEnd: end,
    retrievedAt: page.retrievedAt,
    contentSha256: page.contentSha256,
  }
}
