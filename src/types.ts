export interface VerifiedSearchRequest {
  readonly query: string
  readonly allowedDomains?: readonly string[]
}

export interface VerifiedSearchSource {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
  /** Opaque provider-supplied date or page-age label. */
  readonly publishedAt?: string
}

export interface VerifiedSearchResult {
  readonly sources: readonly VerifiedSearchSource[]
  readonly truncated: boolean
  /** Provider-returned structured sources removed by the local allowlist. */
  readonly filteredOut: number
}

export interface VerifiedSearchWireRequest {
  readonly endpoint: string
  readonly apiVersion: string
  readonly body: {
    readonly model: string
    readonly max_tokens: number
    readonly messages: readonly [{
      readonly role: 'user'
      readonly content: readonly [{ readonly type: 'text'; readonly text: string }]
    }]
    readonly tools: readonly [{
      readonly type: 'web_search_20250305'
      readonly name: 'web_search'
      readonly max_uses: number
      readonly allowed_domains?: readonly string[]
    }]
  }
}

export interface SearchOptions {
  readonly apiKey?: string
  readonly resolveApiKey?: () => Promise<string | undefined>
  readonly apiKeyRef: string
  readonly baseURL: string
  readonly model: string
  readonly apiVersion: string
  readonly maxTokens: number
  readonly maxUses: number
  readonly maxResults: number
  readonly recordRequest: (request: VerifiedSearchWireRequest) => void
}
