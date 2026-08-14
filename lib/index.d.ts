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
interface VerifiedResearchLane {
  /** Stable caller-chosen identifier used in coverage reporting. */
  readonly id: string;
  readonly query: string;
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
type VerifiedResearchLaneStatus = 'fetched' | 'discovered' | 'missing' | 'failed';
interface VerifiedPageEvidence {
  readonly finalUrl: string;
  readonly excerpt: string;
  readonly excerptStart: number;
  readonly excerptEnd: number;
  readonly retrievedAt: string;
  /** SHA-256 of the normalized fetched page text. */
  readonly contentSha256: string;
}
interface VerifiedResearchLaneResult {
  readonly id: string;
  readonly query: string;
  readonly gapQuery?: string;
  readonly allowedDomains?: readonly string[];
  readonly seedUrls?: readonly string[];
  readonly status: VerifiedResearchLaneStatus;
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
}
interface VerifiedResearchResult {
  readonly sources: readonly VerifiedResearchSource[];
  readonly lanes: readonly VerifiedResearchLaneResult[];
  readonly unresolvedLanes: readonly string[];
  /** Mechanical coverage only: every lane retained at least one fetched-page excerpt. */
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
  readonly mediaType: 'text/html' | 'text/plain' | 'text/markdown';
  readonly body: string;
  readonly retrievedAt: string;
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
//#region src/evidence.d.ts
interface NormalizedPage {
  readonly url: string;
  readonly text: string;
  readonly retrievedAt: string;
  readonly contentSha256: string;
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
export { Config, EvidenceFetchError, type FetchEvidenceOptions, type FetchedPage, type NormalizedPage, type PageFetcher, type ResolvedAddress, SearchFilterError, SearchFilterViolationError, type SearchOptions, type SearchRunner, type VerifiedPageEvidence, type VerifiedResearchLane, type VerifiedResearchLaneResult, type VerifiedResearchLaneStatus, type VerifiedResearchRequest, type VerifiedResearchResult, type VerifiedResearchSource, VerifiedSearchError, type VerifiedSearchRequest, type VerifiedSearchResult, type VerifiedSearchSource, type VerifiedSearchWireRequest, apply, createVerifiedResearchTool, createVerifiedSearchTool, enforceAllowedSources, extractPageEvidence, fetchEvidencePage, filterAllowedSources, formatResearchResult, formatResult, inject, installForAgent, installVerifiedSearchPolicy, isPublicAddress, mapResponse, name, normalizeAllowedDomains, normalizeFetchedPage, research, search, searchInstruction };
//# sourceMappingURL=index.d.ts.map