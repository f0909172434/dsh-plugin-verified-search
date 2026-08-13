import { enforceAllowedSources, normalizeAllowedDomains } from './domains.js'
import type {
  SearchOptions,
  VerifiedSearchRequest,
  VerifiedSearchResult,
  VerifiedSearchSource,
  VerifiedSearchWireRequest,
} from './types.js'

interface Citation {
  readonly url?: string
  readonly cited_text?: string
}

interface TextBlock {
  readonly type: 'text'
  readonly citations?: readonly Citation[]
}

interface ResultItem {
  readonly type: string
  readonly url?: string
  readonly title?: string
  readonly page_age?: string
}

interface ResultBlock {
  readonly type: 'web_search_tool_result'
  readonly content?: readonly ResultItem[]
}

type ResponseBlock = TextBlock | ResultBlock | { readonly type: string }

interface AnthropicResponse {
  readonly content?: readonly ResponseBlock[]
}

export class VerifiedSearchError extends Error {
  constructor(message: string, readonly code: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'VerifiedSearchError'
  }
}

export function searchInstruction(query: string): string {
  return [
    `Search the live web and answer this exact query: ${query}`,
    'When the query explicitly says "as of" a date, treat that date as the cutoff. Prefer current first-party or benchmark-owner evidence.',
    'For current, latest, or as-of version and benchmark comparisons, verify that every item is the current version for the requested date. Do not substitute an older version when the current one cannot be verified.',
    'After searching, answer the query and cite every factual claim so the response contains citation excerpts for the caller. State any unresolved gap explicitly.',
  ].join('\n')
}

/** Map result blocks and citation excerpts without trusting provider prose. */
export function mapResponse(response: AnthropicResponse): VerifiedSearchSource[] {
  const blocks = response.content ?? []
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
    for (const citation of (block as TextBlock).citations ?? []) {
      if (citation.url && citation.cited_text && !snippets.has(citation.url)) {
        snippets.set(citation.url, citation.cited_text)
      }
    }
  }
  const seen = new Set<string>()
  const sources: VerifiedSearchSource[] = []
  for (const block of resultBlocks) {
    for (const item of block.content ?? []) {
      if (item.type !== 'web_search_result' || !item.url || seen.has(item.url)) continue
      seen.add(item.url)
      const snippet = snippets.get(item.url)
      sources.push({
        url: item.url,
        ...(item.title ? { title: item.title } : {}),
        ...(snippet ? { snippet } : {}),
        ...(item.page_age ? { publishedAt: item.page_age } : {}),
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

async function resolveApiKey(options: SearchOptions, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal)
  if (options.apiKey) return options.apiKey
  let value: string | undefined
  try {
    value = await options.resolveApiKey?.()
  } catch (error: unknown) {
    throw new VerifiedSearchError(
      `credential resolution failed: ${String(error)}`,
      'VERIFIED_SEARCH_PROVIDER_ERROR',
      { cause: error },
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
  if (request.query.trim().length === 0) {
    throw new VerifiedSearchError('query must be a non-empty string', 'VERIFIED_SEARCH_INVALID_QUERY')
  }
  const allowedDomains = normalizeAllowedDomains(request.allowedDomains)
  const apiKey = await resolveApiKey(options, signal)
  const endpoint = `${options.baseURL.replace(/\/$/u, '')}/messages`
  const body: VerifiedSearchWireRequest['body'] = {
    model: options.model,
    max_tokens: options.maxTokens,
    messages: [{ role: 'user', content: [{ type: 'text', text: searchInstruction(request.query) }] }],
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
        'user-agent': 'dsh-plugin-verified-search/0.1.0',
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
    let detail = `DeepSeek API error (HTTP ${response.status})`
    try {
      const payload = await response.json() as { error?: string | { message?: string }; message?: string }
      detail = typeof payload.error === 'string' ? payload.error : payload.error?.message ?? payload.message ?? detail
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbort(error)) {
        throw new VerifiedSearchError('verified search aborted', 'VERIFIED_SEARCH_ABORTED', { cause: signal?.reason ?? error })
      }
    }
    throw new VerifiedSearchError(detail, 'VERIFIED_SEARCH_PROVIDER_ERROR')
  }
  let sources: VerifiedSearchSource[]
  try {
    sources = mapResponse(await response.json() as AnthropicResponse)
  } catch (error: unknown) {
    if (error instanceof VerifiedSearchError) throw error
    if (signal?.aborted === true || isAbort(error)) {
      throw new VerifiedSearchError('verified search aborted', 'VERIFIED_SEARCH_ABORTED', { cause: signal?.reason ?? error })
    }
    throw new VerifiedSearchError(`DeepSeek returned an unprocessable response: ${String(error)}`, 'VERIFIED_SEARCH_PROVIDER_ERROR', { cause: error })
  }
  enforceAllowedSources(sources.map(source => source.url), allowedDomains)
  const truncated = sources.length > options.maxResults
  return { sources: truncated ? sources.slice(0, options.maxResults) : sources, truncated }
}
