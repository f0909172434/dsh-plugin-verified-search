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

export interface VerifiedResearchLane {
  /** Stable caller-chosen identifier used in coverage reporting. */
  readonly id: string
  readonly query: string
  readonly allowedDomains?: readonly string[]
  /** Optional canonical first-party pages to verify directly before relying on discovery rank. */
  readonly seedUrls?: readonly string[]
  /** Optional single retry query, executed only when the first pass has no excerpt. */
  readonly gapQuery?: string
}

export interface VerifiedResearchRequest {
  /** The complete question that all lanes collectively need to answer. */
  readonly query: string
  readonly lanes: readonly VerifiedResearchLane[]
}

export type VerifiedResearchLaneStatus = 'fetched' | 'discovered' | 'missing' | 'failed'

export interface VerifiedPageEvidence {
  readonly finalUrl: string
  readonly excerpt: string
  readonly excerptStart: number
  readonly excerptEnd: number
  readonly retrievedAt: string
  /** SHA-256 of the normalized fetched page text. */
  readonly contentSha256: string
}

export interface VerifiedResearchLaneResult {
  readonly id: string
  readonly query: string
  readonly gapQuery?: string
  readonly allowedDomains?: readonly string[]
  readonly seedUrls?: readonly string[]
  readonly status: VerifiedResearchLaneStatus
  readonly sourceCount: number
  readonly evidenceCount: number
  readonly fetchCount: number
  readonly fetchErrorCount: number
  readonly truncated: boolean
  readonly filteredOut: number
  readonly attempts: 1 | 2
  readonly errorCode?: string
}

export interface VerifiedResearchSource extends VerifiedSearchSource {
  readonly lane: string
  readonly origin: 'seed' | 'search'
  /** Search round that discovered or enriched this source. */
  readonly round: 0 | 1
  readonly evidence?: VerifiedPageEvidence
}

export interface VerifiedResearchResult {
  readonly sources: readonly VerifiedResearchSource[]
  readonly lanes: readonly VerifiedResearchLaneResult[]
  readonly unresolvedLanes: readonly string[]
  /** Mechanical coverage only: every lane retained at least one fetched-page excerpt. */
  readonly allLanesFetched: boolean
  readonly truncated: boolean
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
