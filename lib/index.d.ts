import z from "@deepseek-ai/schemastery";
import { request } from "node:https";
import { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
//#region src/types.d.ts
interface VerifiedSearchRequest {
  readonly query: string;
  readonly allowedDomains?: readonly string[];
}
interface VerifiedSearchSource {
  readonly url: string;
  readonly title?: string;
  readonly snippet?: string;
  /** Opaque provider-supplied date or page-age label. */
  readonly publishedAt?: string;
}
interface VerifiedSearchResult {
  readonly sources: readonly VerifiedSearchSource[];
  readonly truncated: boolean;
  /** Provider-returned structured sources removed by the local allowlist. */
  readonly filteredOut: number;
}
interface VerifiedResearchClaim {
  /** Stable caller-chosen identifier used in claim-level coverage reporting. */
  readonly id: string;
  /** Exact fact or retrieval terms that require their own fetched-page excerpt. */
  readonly query: string;
}
interface VerifiedResearchLane {
  /** Stable caller-chosen identifier used in coverage reporting. */
  readonly id: string;
  readonly query: string;
  /** Optional for v0.2 callers; omitted lanes receive one implicit `primary` claim. */
  readonly requiredClaims?: readonly VerifiedResearchClaim[];
  readonly allowedDomains?: readonly string[];
  /** Optional canonical first-party pages to verify directly before relying on discovery rank. */
  readonly seedUrls?: readonly string[];
  /** Optional single retry query, executed only when the first pass has no excerpt. */
  readonly gapQuery?: string;
}
interface VerifiedResearchRequest {
  /** The complete question that all lanes collectively need to answer. */
  readonly query: string;
  readonly lanes: readonly VerifiedResearchLane[];
}
type VerifiedResearchLaneStatus = 'fetched' | 'partial' | 'discovered' | 'missing' | 'failed';
type VerifiedResearchClaimStatus = 'covered' | 'missing' | 'blocked';
type VerifiedResearchSeedStatus = 'covered' | 'no_match' | 'fetch_failed' | 'skipped';
type VerifiedResearchStopReason = 'all_claims_covered' | 'plan_exhausted' | 'provider_failed' | 'budget_exhausted';
interface VerifiedPageEvidence {
  readonly finalUrl: string;
  readonly excerpt: string;
  readonly excerptStart: number;
  readonly excerptEnd: number;
  readonly retrievedAt: string;
  /** SHA-256 of the normalized fetched page text. */
  readonly contentSha256: string;
}
interface VerifiedClaimEvidence extends VerifiedPageEvidence {
  readonly claimId: string;
}
interface VerifiedResearchClaimResult {
  readonly id: string;
  readonly query: string;
  readonly status: VerifiedResearchClaimStatus;
  readonly evidenceCount: 0 | 1;
}
interface VerifiedResearchSeedCheck {
  readonly url: string;
  readonly status: VerifiedResearchSeedStatus;
  readonly coveredClaimIds: readonly string[];
  readonly finalUrl?: string;
  readonly retrievedAt?: string;
  readonly contentSha256?: string;
  readonly errorCode?: string;
}
interface VerifiedResearchLaneResult {
  readonly id: string;
  readonly query: string;
  readonly gapQuery?: string;
  readonly allowedDomains?: readonly string[];
  readonly seedUrls?: readonly string[];
  readonly status: VerifiedResearchLaneStatus;
  readonly claims: readonly VerifiedResearchClaimResult[];
  readonly seedChecks: readonly VerifiedResearchSeedCheck[];
  readonly stopReason: VerifiedResearchStopReason;
  readonly sourceCount: number;
  readonly evidenceCount: number;
  readonly fetchCount: number;
  readonly fetchErrorCount: number;
  readonly truncated: boolean;
  readonly filteredOut: number;
  readonly attempts: 1 | 2;
  readonly errorCode?: string;
}
interface VerifiedResearchSource extends VerifiedSearchSource {
  readonly lane: string;
  readonly origin: 'seed' | 'search';
  /** Search round that discovered or enriched this source. */
  readonly round: 0 | 1;
  readonly evidence?: VerifiedPageEvidence;
  /** Claim-attributed exact excerpts; the singular evidence field remains for v0.2 consumers. */
  readonly claimEvidence?: readonly VerifiedClaimEvidence[];
}
interface VerifiedResearchResult {
  readonly sources: readonly VerifiedResearchSource[];
  readonly lanes: readonly VerifiedResearchLaneResult[];
  readonly unresolvedLanes: readonly string[];
  readonly unresolvedClaims: readonly {
    readonly lane: string;
    readonly claim: string;
  }[];
  /** Mechanical coverage only: every required claim retained an exact fetched-page excerpt. */
  readonly allClaimsCovered: boolean;
  /** @deprecated Compatibility alias for allClaimsCovered. */
  readonly allLanesFetched: boolean;
  readonly truncated: boolean;
  readonly filteredOut: number;
}
interface VerifiedSearchWireRequest {
  readonly endpoint: string;
  readonly apiVersion: string;
  readonly body: {
    readonly model: string;
    readonly max_tokens: number;
    readonly messages: readonly [{
      readonly role: 'user';
      readonly content: readonly [{
        readonly type: 'text';
        readonly text: string;
      }];
    }];
    readonly tools: readonly [{
      readonly type: 'web_search_20250305';
      readonly name: 'web_search';
      readonly max_uses: number;
      readonly allowed_domains?: readonly string[];
    }];
  };
}
interface SearchOptions {
  readonly apiKey?: string;
  readonly resolveApiKey?: () => Promise<string | undefined>;
  readonly apiKeyRef: string;
  readonly baseURL: string;
  readonly model: string;
  readonly apiVersion: string;
  readonly maxTokens: number;
  readonly maxUses: number;
  readonly maxResults: number;
  readonly recordRequest: (request: VerifiedSearchWireRequest) => void;
}
//#endregion
//#region src/domains.d.ts
declare class SearchFilterError extends Error {
  readonly code = "VERIFIED_SEARCH_INVALID_FILTER";
}
/** @deprecated Use filterAllowedSources for provider-compatible degradation. */
declare class SearchFilterViolationError extends Error {
  readonly code = "VERIFIED_SEARCH_FILTER_VIOLATION";
}
/** Normalize the portable hostname-only allowlist. */
declare function normalizeAllowedDomains(values: readonly string[] | undefined): readonly string[] | undefined;
/** Keep only structured sources that satisfy the portable allowlist. */
declare function filterAllowedSources<T extends {
  readonly url: string;
}>(sources: readonly T[], allowedDomains: readonly string[] | undefined): {
  readonly sources: readonly T[];
  readonly filteredOut: number;
};
/** @deprecated Retained for v0.1.x API compatibility; new code should post-filter. */
declare function enforceAllowedSources(urls: readonly string[], allowedDomains: readonly string[] | undefined): void;
//#endregion
//#region src/provider.d.ts
declare class VerifiedSearchError extends Error {
  readonly code: string;
  constructor(message: string, code: string, options?: ErrorOptions);
}
declare function searchInstruction(query: string, allowedDomains?: readonly string[]): string;
/** Map result blocks and citation excerpts without trusting provider prose. */
declare function mapResponse(response: unknown): VerifiedSearchSource[];
/** Execute one independently logged DeepSeek native-search turn. */
declare function search(request: VerifiedSearchRequest, options: SearchOptions, signal?: AbortSignal): Promise<VerifiedSearchResult>;
//#endregion
//#region src/tool.d.ts
declare function formatResult(result: VerifiedSearchResult): string;
declare function createVerifiedSearchTool(options: () => SearchOptions, timeoutMs?: number): import("@deepseek-ai/dsh-tools").ToolDefinition;
declare function installVerifiedSearchPolicy(ctx: Context): () => void;
//#endregion
//#region src/page-fetch.d.ts
declare class EvidenceFetchError extends Error {
  readonly code: string;
  constructor(message: string, code: string, options?: ErrorOptions);
}
interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}
interface TransportResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly bytes: Uint8Array;
}
interface EvidenceTransport {
  resolve(hostname: string, signal?: AbortSignal): Promise<readonly ResolvedAddress[]>;
  request(url: URL, address: ResolvedAddress, signal: AbortSignal | undefined, limits: {
    readonly maxBytes: number;
    readonly timeoutMs: number;
    readonly bodyIdleMs: number;
  }): Promise<TransportResponse>;
}
interface FetchEvidenceOptions {
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  readonly timeoutMs?: number;
  readonly bodyIdleMs?: number;
  readonly transport?: EvidenceTransport;
}
interface FetchedPage {
  readonly url: string;
  readonly mediaType: 'text/html' | 'application/xhtml+xml' | 'application/json' | 'text/plain' | 'text/markdown';
  readonly body: string;
  readonly retrievedAt: string;
  /** Original official URL when a narrowly scoped alternate representation was used. */
  readonly derivedFrom?: string;
}
declare function isPublicAddress(value: ResolvedAddress): boolean;
/** Fetch one public HTTPS page through a DNS-pinned transport, enforcing an allowlist when supplied. */
declare function fetchEvidencePage(sourceUrl: string, allowedDomains: readonly string[] | undefined, signal?: AbortSignal, input?: FetchEvidenceOptions): Promise<FetchedPage>;
//#endregion
//#region src/research.d.ts
type SearchRunner = (request: {
  readonly query: string;
  readonly allowedDomains?: readonly string[];
}, options: SearchOptions, signal?: AbortSignal) => Promise<VerifiedSearchResult>;
type PageFetcher = (url: string, allowedDomains: readonly string[] | undefined, signal?: AbortSignal) => Promise<FetchedPage>;
/** Execute a bounded, durable set of search lanes with at most one predeclared gap retry. */
declare function research(request: VerifiedResearchRequest, options: SearchOptions, signal?: AbortSignal, runner?: SearchRunner, maxSources?: number, fetcher?: PageFetcher): Promise<VerifiedResearchResult>;
declare function formatResearchResult(result: VerifiedResearchResult): string;
declare function createVerifiedResearchTool(options: () => SearchOptions, timeoutMs?: number, maxSources?: number, fetcher?: PageFetcher): import("@deepseek-ai/dsh-tools").ToolDefinition;
//#endregion
//#region src/json-selection.d.ts
type JsonScalar = string | number | boolean | null;
interface JsonProjection {
  readonly name: string;
  /** RFC 6901 JSON Pointer, resolved relative to each selected row. */
  readonly pointer: string;
}
interface JsonSelectionRequest {
  /** RFC 6901 JSON Pointer from the root object to an array of objects. */
  readonly arrayPointer: string;
  /** Keep rows whose ISO calendar date at `pointer` is at most `lte`. */
  readonly filter: {
    readonly pointer: string;
    readonly lte: string;
  };
  /** Optional strict scalar equality filters applied before the date cutoff. */
  readonly where?: readonly {
    readonly pointer: string;
    readonly equals: string | boolean | null;
  }[];
  /** Select every eligible row tied for the maximum ISO date at `pointer`. */
  readonly max: {
    readonly pointer: string;
  };
  /** Emit only the named scalar values. */
  readonly project: readonly JsonProjection[];
}
interface JsonSelectionRow {
  /** Zero-based position in the source array. */
  readonly sourceIndex: number;
  readonly values: Readonly<Record<string, JsonScalar>>;
}
interface JsonSelectionResult {
  readonly complete: true;
  readonly truncated: false;
  readonly evidenceSha256: string;
  readonly arrayPointer: string;
  readonly filter: {
    readonly pointer: string;
    readonly lte: string;
  };
  readonly where?: readonly {
    readonly pointer: string;
    readonly equals: string | boolean | null;
  }[];
  readonly max: {
    readonly pointer: string;
    readonly value: string;
    readonly ties: 'all';
  };
  readonly rowsScanned: number;
  readonly rowsEligible: number;
  readonly tieCount: number;
  readonly rows: readonly JsonSelectionRow[];
}
type JsonSelectionErrorCode = 'JSON_SELECTION_INVALID_REQUEST' | 'JSON_SELECTION_INPUT_TOO_LARGE' | 'JSON_SELECTION_INVALID_UTF8' | 'JSON_SELECTION_INVALID_UNICODE' | 'JSON_SELECTION_INVALID_JSON' | 'JSON_SELECTION_DUPLICATE_KEY' | 'JSON_SELECTION_PARSE_LIMIT_EXCEEDED' | 'JSON_SELECTION_INVALID_POINTER' | 'JSON_SELECTION_POINTER_NOT_FOUND' | 'JSON_SELECTION_POINTER_TYPE_MISMATCH' | 'JSON_SELECTION_ROOT_TYPE_MISMATCH' | 'JSON_SELECTION_ARRAY_TYPE_MISMATCH' | 'JSON_SELECTION_ROW_LIMIT_EXCEEDED' | 'JSON_SELECTION_ROW_TYPE_MISMATCH' | 'JSON_SELECTION_INVALID_ISO_DATE' | 'JSON_SELECTION_NON_SCALAR_PROJECTION' | 'JSON_SELECTION_NO_MATCH' | 'JSON_SELECTION_TIE_LIMIT_EXCEEDED' | 'JSON_SELECTION_OUTPUT_TOO_LARGE';
declare class JsonSelectionError extends Error {
  readonly code: JsonSelectionErrorCode;
  constructor(message: string, code: JsonSelectionErrorCode, options?: ErrorOptions);
}
/**
 * Deterministically select every maximum-date tie from a bounded JSON object-array.
 * This proves selection from the exact input hash; it does not independently verify
 * the factual truth of the input document.
 */
declare function selectJsonMaxTies(input: string | Uint8Array, rawRequest: JsonSelectionRequest): JsonSelectionResult;
//#endregion
//#region src/json-tool.d.ts
type JsonPageFetcher = (url: string, allowedDomains: readonly string[], signal?: AbortSignal) => Promise<FetchedPage>;
interface VerifiedJsonSelectionResult {
  readonly sourceUrl: string;
  readonly finalUrl: string;
  readonly retrievedAt: string;
  readonly selection: JsonSelectionResult;
}
declare function formatJsonSelectionResult(result: VerifiedJsonSelectionResult): string;
declare function selectFetchedJson(sourceUrl: string, allowedDomainsInput: readonly string[], selection: JsonSelectionRequest, signal?: AbortSignal, fetcher?: JsonPageFetcher): Promise<VerifiedJsonSelectionResult>;
declare function createVerifiedJsonSelectionTool(timeoutMs?: number, fetcher?: JsonPageFetcher): import("@deepseek-ai/dsh-tools").ToolDefinition;
//#endregion
//#region src/evidence.d.ts
interface NormalizedPage {
  readonly url: string;
  readonly mediaType: FetchedPage['mediaType'];
  readonly text: string;
  readonly retrievedAt: string;
  readonly contentSha256: string;
  readonly derivedFrom?: string;
}
/** Convert a bounded fetched body into inert, normalized text. */
declare function normalizeFetchedPage(page: FetchedPage): NormalizedPage;
/** Select one exact, contiguous query-relevant excerpt from normalized page text. */
declare function extractPageEvidence(page: NormalizedPage, query: string): VerifiedPageEvidence | undefined;
//#endregion
//#region src/index.d.ts
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** A blank live agent switched to a different standing preset. */
    'agent-preset/selected'(sessionId: SessionId, agentPreset: string): void;
  }
}
declare const name = "verified-search";
declare const inject: string[];
interface Config {
  /** Credential reference resolved per search. */
  apiKeyEnv?: string;
  /** Optional literal key. Prefer the Harness Models page or launch environment. */
  apiKey?: string;
  baseURL?: string;
  model?: string;
  apiVersion?: string;
  maxTokens?: number;
  maxUses?: number;
  maxResults?: number;
  searchTimeoutMs?: number;
  researchTimeoutMs?: number;
  researchMaxResults?: number;
}
declare const Config: z<Config>;
/** Install the tool/policy into one live agent scope. Exported for tests. */
declare function installForAgent(agentCtx: Context, options: () => SearchOptions, timeoutMs?: number, researchTimeoutMs?: number, researchMaxResults?: number): () => void;
declare function apply(ctx: Context, input: Config): void;
//#endregion
export { Config, EvidenceFetchError, type FetchEvidenceOptions, type FetchedPage, JsonSelectionError, type JsonSelectionRequest, type JsonSelectionResult, type NormalizedPage, type PageFetcher, type ResolvedAddress, SearchFilterError, SearchFilterViolationError, type SearchOptions, type SearchRunner, type VerifiedPageEvidence, type VerifiedResearchLane, type VerifiedResearchLaneResult, type VerifiedResearchLaneStatus, type VerifiedResearchRequest, type VerifiedResearchResult, type VerifiedResearchSource, VerifiedSearchError, type VerifiedSearchRequest, type VerifiedSearchResult, type VerifiedSearchSource, type VerifiedSearchWireRequest, apply, createVerifiedJsonSelectionTool, createVerifiedResearchTool, createVerifiedSearchTool, enforceAllowedSources, extractPageEvidence, fetchEvidencePage, filterAllowedSources, formatJsonSelectionResult, formatResearchResult, formatResult, inject, installForAgent, installVerifiedSearchPolicy, isPublicAddress, mapResponse, name, normalizeAllowedDomains, normalizeFetchedPage, research, search, searchInstruction, selectFetchedJson, selectJsonMaxTies };
//# sourceMappingURL=index.d.ts.map