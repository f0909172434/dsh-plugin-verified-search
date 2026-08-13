import { filterAllowedSources, normalizeAllowedDomains } from './domains.js'
import type {
  SearchOptions,
  VerifiedSearchRequest,
  VerifiedSearchResult,
  VerifiedSearchSource,
  VerifiedSearchWireRequest,
} from './types.js'

interface Citation {
  readonly url?: unknown
  readonly cited_text?: unknown
}

interface TextBlock {
  readonly type: 'text'
  readonly citations?: unknown
}

interface ResultItem {
  readonly type: string
  readonly url?: unknown
  readonly title?: unknown
  readonly page_age?: unknown
}

interface ResultBlock {
  readonly type: 'web_search_tool_result'
  readonly content?: unknown
}

type ResponseBlock = TextBlock | ResultBlock | { readonly type?: unknown }

const TRACKING_QUERY_NAME = /^(?:fbclid|gclid|msclkid|utm_.+)$/iu
const SENSITIVE_QUERY_NAMES = new Set([
  'auth',
  'authorization',
  'code',
  'credential',
  'key',
  'policy',
  'secret',
  'session',
  'sig',
])
const SENSITIVE_QUERY_SUFFIXES = [
  'accesstoken',
  'apikey',
  'authtoken',
  'credential',
  'jwt',
  'keypairid',
  'securitytoken',
  'sessionid',
  'signature',
  'ticket',
  'token',
]
const MAX_QUERY_LENGTH = 4096
const MAX_SOURCE_URL_LENGTH = 8192
const MAX_TITLE_LENGTH = 1000
const MAX_SNIPPET_LENGTH = 8000
const MAX_PAGE_AGE_LENGTH = 200
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const WEB_SEARCH_ERROR_CODES = new Set([
  'invalid_tool_input',
  'unavailable',
  'max_uses_exceeded',
  'too_many_requests',
  'query_too_long',
  'request_too_large',
])

export class VerifiedSearchError extends Error {
  constructor(message: string, readonly code: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'VerifiedSearchError'
  }
}

function isSensitiveQueryName(name: string): boolean {
  const compact = name.toLowerCase().replace(/[^a-z0-9]/gu, '')
  return SENSITIVE_QUERY_NAMES.has(compact)
    || SENSITIVE_QUERY_SUFFIXES.some(suffix => compact === suffix || compact.endsWith(suffix))
}

export function searchInstruction(query: string, allowedDomains?: readonly string[]): string {
  return [
    `Search the live web and answer this exact query: ${query}`,
    ...(allowedDomains === undefined
      ? []
      : [`Use only sources on these domains or their subdomains: ${JSON.stringify(allowedDomains)}. Do not cite or summarize any other source; if none qualify, state the gap.`]),
    'When the query explicitly says "as of" a date, treat that date as the cutoff. Prefer current first-party or benchmark-owner evidence.',
    'For current, latest, or as-of version and benchmark comparisons, verify that every item is the current version for the requested date. Do not substitute an older version when the current one cannot be verified.',
    'After searching, answer the query and cite every factual claim so the response contains citation excerpts for the caller. State any unresolved gap explicitly.',
  ].join('\n')
}

/** Remove provider-returned URL material that must not enter tool/session logs. */
export function sanitizeSourceUrl(sourceUrl: string): string {
  if (sourceUrl.length === 0 || sourceUrl.length > MAX_SOURCE_URL_LENGTH) {
    throw new VerifiedSearchError('DeepSeek returned an invalid source URL length', 'VERIFIED_SEARCH_PROVIDER_ERROR')
  }
  let url: URL
  try {
    url = new URL(sourceUrl)
  } catch (error: unknown) {
    throw new VerifiedSearchError('DeepSeek returned a malformed source URL', 'VERIFIED_SEARCH_PROVIDER_ERROR', { cause: error })
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username.length > 0 || url.password.length > 0) {
    throw new VerifiedSearchError('DeepSeek returned an unsafe source URL', 'VERIFIED_SEARCH_PROVIDER_ERROR')
  }
  for (const name of [...url.searchParams.keys()]) {
    if (isSensitiveQueryName(name) || TRACKING_QUERY_NAME.test(name)) url.searchParams.delete(name)
  }
  url.hash = ''
  const result = url.toString()
  if (result.length > MAX_SOURCE_URL_LENGTH) {
    throw new VerifiedSearchError('DeepSeek returned an invalid source URL length', 'VERIFIED_SEARCH_PROVIDER_ERROR')
  }
  return result
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  if (normalized.length === 0) return undefined
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`
}

/** Map result blocks and citation excerpts without trusting provider prose. */
export function mapResponse(response: unknown): VerifiedSearchSource[] {
  if (typeof response !== 'object' || response === null) {
    throw new VerifiedSearchError('DeepSeek returned a non-object response', 'VERIFIED_SEARCH_PROVIDER_ERROR')
  }
  const rawContent = (response as { readonly content?: unknown }).content
  const blocks = Array.isArray(rawContent)
    ? rawContent.filter((block): block is ResponseBlock => typeof block === 'object' && block !== null)
    : []
  const resultBlocks = blocks.filter((block): block is ResultBlock => block.type === 'web_search_tool_result')
  if (resultBlocks.length === 0) {
    throw new VerifiedSearchError(
      'DeepSeek returned no web_search_tool_result blocks; native search may not have run',
      'VERIFIED_SEARCH_PROVIDER_ERROR',
    )
  }
  const snippets = new Map<string, string>()
  for (const block of blocks) {
    if (block.type !== 'text') continue
    const rawCitations = (block as TextBlock).citations
    const citations = Array.isArray(rawCitations)
      ? rawCitations.filter((citation: unknown): citation is Citation => typeof citation === 'object' && citation !== null)
      : []
    for (const citation of citations) {
      if (typeof citation.url === 'string' && typeof citation.cited_text === 'string'
        && citation.url.length > 0 && citation.cited_text.length > 0 && !snippets.has(citation.url)) {
        snippets.set(citation.url, citation.cited_text)
      }
    }
  }
  const seen = new Set<string>()
  const sources: VerifiedSearchSource[] = []
  for (const block of resultBlocks) {
    if (!Array.isArray(block.content)) {
      const rawErrorCode = typeof block.content === 'object' && block.content !== null
        && (block.content as { readonly type?: unknown }).type === 'web_search_tool_result_error'
        && typeof (block.content as { readonly error_code?: unknown }).error_code === 'string'
        ? (block.content as { readonly error_code: string }).error_code
        : 'malformed_result'
      const errorCode = WEB_SEARCH_ERROR_CODES.has(rawErrorCode) ? rawErrorCode : 'malformed_result'
      throw new VerifiedSearchError(`DeepSeek web search failed (${errorCode})`, 'VERIFIED_SEARCH_PROVIDER_ERROR')
    }
    const items = block.content.filter((item): item is ResultItem => typeof item === 'object' && item !== null)
    for (const item of items) {
      if (item.type !== 'web_search_result') continue
      if (typeof item.url !== 'string' || item.url.length === 0) {
        throw new VerifiedSearchError('DeepSeek returned a search result without a valid URL string', 'VERIFIED_SEARCH_PROVIDER_ERROR')
      }
      const sourceUrl = sanitizeSourceUrl(item.url)
      if (seen.has(sourceUrl)) continue
      seen.add(sourceUrl)
      const title = boundedText(item.title, MAX_TITLE_LENGTH)
      const snippet = boundedText(snippets.get(item.url), MAX_SNIPPET_LENGTH)
      const publishedAt = boundedText(item.page_age, MAX_PAGE_AGE_LENGTH)
      sources.push({
        url: sourceUrl,
        ...(title === undefined ? {} : { title }),
        ...(snippet === undefined ? {} : { snippet }),
        ...(publishedAt === undefined ? {} : { publishedAt }),
      })
    }
  }
  return sources
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new VerifiedSearchError('verified search aborted', 'VERIFIED_SEARCH_ABORTED', { cause: signal.reason })
  }
}

async function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation
  throwIfAborted(signal)
  return await new Promise<T>((resolve, reject) => {
    const aborted = (): void => reject(new VerifiedSearchError(
      'verified search aborted',
      'VERIFIED_SEARCH_ABORTED',
      { cause: signal.reason },
    ))
    signal.addEventListener('abort', aborted, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', aborted)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', aborted)
        reject(error)
      },
    )
    if (signal.aborted) aborted()
  })
}

/** Resolve and validate the credential-free Messages endpoint before logging it. */
export function messagesEndpoint(baseURL: string): string {
  if (baseURL.length === 0 || baseURL !== baseURL.trim()) {
    throw new VerifiedSearchError('DeepSeek baseURL must be a non-empty URL without surrounding whitespace', 'VERIFIED_SEARCH_INVALID_CONFIG')
  }
  let url: URL
  try {
    url = new URL(baseURL)
  } catch (error: unknown) {
    throw new VerifiedSearchError('DeepSeek baseURL must be a valid HTTP(S) URL', 'VERIFIED_SEARCH_INVALID_CONFIG', { cause: error })
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:')
    || url.username.length > 0 || url.password.length > 0
    || url.search.length > 0 || url.hash.length > 0) {
    throw new VerifiedSearchError(
      'DeepSeek baseURL must use HTTP(S) and must not contain credentials, query parameters, or a fragment',
      'VERIFIED_SEARCH_INVALID_CONFIG',
    )
  }
  if (url.protocol === 'http:' && url.hostname !== 'localhost'
    && url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') {
    throw new VerifiedSearchError(
      'DeepSeek baseURL must use HTTPS unless it targets loopback',
      'VERIFIED_SEARCH_INVALID_CONFIG',
    )
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/messages`
  return url.toString()
}

async function responseTextWithin(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new VerifiedSearchError('DeepSeek response exceeded the 4 MiB limit', 'VERIFIED_SEARCH_PROVIDER_ERROR')
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw new VerifiedSearchError('DeepSeek response exceeded the 4 MiB limit', 'VERIFIED_SEARCH_PROVIDER_ERROR')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const joined = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(joined)
}

async function resolveApiKey(options: SearchOptions, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal)
  if (options.apiKey) return options.apiKey
  let value: string | undefined
  try {
    value = await abortable(Promise.resolve(options.resolveApiKey?.()), signal)
  } catch (error: unknown) {
    if (error instanceof VerifiedSearchError) throw error
    throw new VerifiedSearchError(
      `credential resolution failed for "${options.apiKeyRef}"`,
      'VERIFIED_SEARCH_PROVIDER_ERROR',
    )
  }
  throwIfAborted(signal)
  if (value) return value
  throw new VerifiedSearchError(
    `no DeepSeek API key for "${options.apiKeyRef}"; configure it on the Harness Models page or launch environment`,
    'VERIFIED_SEARCH_CREDENTIAL_MISSING',
  )
}

/** Execute one independently logged DeepSeek native-search turn. */
export async function search(
  request: VerifiedSearchRequest,
  options: SearchOptions,
  signal?: AbortSignal,
): Promise<VerifiedSearchResult> {
  const query = request.query.trim()
  if (query.length === 0 || query.length > MAX_QUERY_LENGTH) {
    throw new VerifiedSearchError(
      `query must contain 1-${MAX_QUERY_LENGTH} characters after trimming`,
      'VERIFIED_SEARCH_INVALID_QUERY',
    )
  }
  const allowedDomains = normalizeAllowedDomains(request.allowedDomains)
  const endpoint = messagesEndpoint(options.baseURL)
  const apiKey = await resolveApiKey(options, signal)
  const body: VerifiedSearchWireRequest['body'] = {
    model: options.model,
    max_tokens: options.maxTokens,
    messages: [{ role: 'user', content: [{ type: 'text', text: searchInstruction(query, allowedDomains) }] }],
    tools: [{
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: options.maxUses,
      ...(allowedDomains === undefined ? {} : { allowed_domains: allowedDomains }),
    }],
  }
  // Fail closed: model-visible input must enter the session before dispatch.
  options.recordRequest({ endpoint, apiVersion: options.apiVersion, body })
  throwIfAborted(signal)
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'x-api-key': apiKey,
        'authorization': `Bearer ${apiKey}`,
        'anthropic-version': options.apiVersion,
        'content-type': 'application/json',
        'accept': 'application/json',
        'user-agent': 'dsh-plugin-verified-search/0.1.1',
      },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error: unknown) {
    if (signal?.aborted === true || isAbort(error)) {
      throw new VerifiedSearchError('verified search aborted', 'VERIFIED_SEARCH_ABORTED', { cause: signal?.reason ?? error })
    }
    throw new VerifiedSearchError(`DeepSeek search request failed: ${String(error)}`, 'VERIFIED_SEARCH_PROVIDER_ERROR', { cause: error })
  }
  if (!response.ok) {
    throw new VerifiedSearchError(`DeepSeek API error (HTTP ${response.status})`, 'VERIFIED_SEARCH_PROVIDER_ERROR')
  }
  let sources: VerifiedSearchSource[]
  try {
    const raw = await responseTextWithin(response, MAX_RESPONSE_BYTES)
    sources = mapResponse(JSON.parse(raw))
  } catch (error: unknown) {
    if (error instanceof VerifiedSearchError) throw error
    if (signal?.aborted === true || isAbort(error)) {
      throw new VerifiedSearchError('verified search aborted', 'VERIFIED_SEARCH_ABORTED', { cause: signal?.reason ?? error })
    }
    throw new VerifiedSearchError(`DeepSeek returned an unprocessable response: ${String(error)}`, 'VERIFIED_SEARCH_PROVIDER_ERROR', { cause: error })
  }
  const filtered = filterAllowedSources(sources, allowedDomains)
  const truncated = filtered.sources.length > options.maxResults
  return {
    sources: truncated ? filtered.sources.slice(0, options.maxResults) : filtered.sources,
    truncated,
    filteredOut: filtered.filteredOut,
  }
}
