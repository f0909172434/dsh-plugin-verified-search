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
interface VerifiedResearchDocumentTemporalAnchor {
  readonly kind: 'year_month';
  readonly role: 'document';
  /** Strict calendar month in YYYY-MM form. */
  readonly value: string;
}
interface VerifiedResearchEventYearMonthAnchor {
  readonly kind: 'year_month';
  readonly role: 'event';
  /** Strict calendar month in YYYY-MM form. */
  readonly value: string;
}
interface VerifiedResearchEventAfterAnchor {
  readonly kind: 'after';
  readonly role: 'event';
  /** Strict exclusive cutoff in YYYY-MM-DD form. */
  readonly value: string;
  readonly select: 'first';
}
type VerifiedResearchClaimScope = {
  readonly kind: 'document';
  /** Candidate-neutral identity markers required somewhere in the fetched document. */
  readonly mustInclude: readonly string[];
  readonly temporalAnchor?: VerifiedResearchDocumentTemporalAnchor;
} | {
  readonly kind: 'event_row';
  /** Candidate-neutral row/section markers required in the retained excerpt. */
  readonly mustInclude: readonly string[];
  readonly temporalAnchor: VerifiedResearchEventYearMonthAnchor | VerifiedResearchEventAfterAnchor;
};
type VerifiedResearchClaimValueKind = 'generic_text' | 'cvss_assigned_version' | 'cvss_vector' | 'cvss_base_score';
interface VerifiedResearchClaim {
  /** Stable caller-chosen identifier used in claim-level coverage reporting. */
  readonly id: string;
  /** Exact fact or retrieval terms that require their own fetched-page excerpt. */
  readonly query: string;
  /** Case-insensitive, whitespace-normalized substrings required in the retained excerpt. */
  readonly evidenceMustInclude: readonly string[];
  /** Typed value postcondition; omitted direct-API values retain generic-text compatibility. */
  readonly valueKind?: VerifiedResearchClaimValueKind;
  /** Typed evidence boundary; mandatory for every explicit claim. */
  readonly scope: VerifiedResearchClaimScope;
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
  readonly valueKind: VerifiedResearchClaimValueKind;
  /** Caller-declared normalized substrings mechanically matched in this exact excerpt. */
  readonly matchedRequiredPhrases: readonly string[];
}
interface VerifiedResearchClaimResult {
  readonly id: string;
  readonly query: string;
  readonly evidenceMustInclude: readonly string[];
  readonly valueKind: VerifiedResearchClaimValueKind;
  /** Absent only for the deprecated implicit legacy claim. */
  readonly scope?: VerifiedResearchClaimScope;
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
/** Block every further tool while terminal synthesis is pending in this turn. */
declare function installVerifiedResearchFinalizationPolicy(ctx: Context): () => void;
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
declare function researchFinalizationInstruction(result: VerifiedResearchResult): string;
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
//#region src/json-numeric-selection.d.ts
interface JsonNumberLexeme {
  readonly [key: string]: string;
  /** Exact JSON number token from the decoded UTF-8 source. */
  readonly jsonNumber: string;
}
type JsonNumericProjectedScalar = string | boolean | null | JsonNumberLexeme;
interface JsonNumericSelectionRequest {
  /** RFC 6901 JSON Pointer from the root object to an array of objects. */
  readonly arrayPointer: string;
  /** Optional ISO-date cutoff applied before numeric selection. */
  readonly filter?: {
    readonly pointer: string;
    readonly lte: string;
  };
  /** Optional strict non-numeric scalar equality filters. */
  readonly where?: readonly {
    readonly pointer: string;
    readonly equals: string | boolean | null;
  }[];
  readonly extreme: {
    readonly pointer: string;
    readonly direction: 'max' | 'min';
    readonly ties: 'all';
  };
  readonly project: readonly JsonProjection[];
}
interface JsonNumericSelectionRow {
  readonly sourceIndex: number;
  readonly values: Readonly<Record<string, JsonNumericProjectedScalar>>;
}
interface JsonNumericSelectionResult {
  readonly complete: true;
  readonly truncated: false;
  readonly evidenceSha256: string;
  readonly arrayPointer: string;
  readonly filter?: {
    readonly pointer: string;
    readonly lte: string;
  };
  readonly where?: readonly {
    readonly pointer: string;
    readonly equals: string | boolean | null;
  }[];
  readonly extreme: {
    readonly pointer: string;
    readonly direction: 'max' | 'min';
    /** Exact source lexeme of the first winning row. Equivalent ties may use another lexeme. */
    readonly value: JsonNumberLexeme;
    readonly ties: 'all';
  };
  readonly rowsScanned: number;
  readonly rowsEligible: number;
  readonly tieCount: number;
  readonly rows: readonly JsonNumericSelectionRow[];
}
type JsonNumericSelectionErrorCode = 'JSON_NUMERIC_SELECTION_INVALID_REQUEST' | 'JSON_NUMERIC_SELECTION_INPUT_TOO_LARGE' | 'JSON_NUMERIC_SELECTION_INVALID_UTF8' | 'JSON_NUMERIC_SELECTION_INVALID_UNICODE' | 'JSON_NUMERIC_SELECTION_INVALID_JSON' | 'JSON_NUMERIC_SELECTION_DUPLICATE_KEY' | 'JSON_NUMERIC_SELECTION_PARSE_LIMIT_EXCEEDED' | 'JSON_NUMERIC_SELECTION_NUMBER_TOKEN_LIMIT_EXCEEDED' | 'JSON_NUMERIC_SELECTION_NUMBER_LEXEME_LIMIT_EXCEEDED' | 'JSON_NUMERIC_SELECTION_LOSSLESS_PARSE_UNAVAILABLE' | 'JSON_NUMERIC_SELECTION_INVALID_POINTER' | 'JSON_NUMERIC_SELECTION_POINTER_NOT_FOUND' | 'JSON_NUMERIC_SELECTION_POINTER_TYPE_MISMATCH' | 'JSON_NUMERIC_SELECTION_ROOT_TYPE_MISMATCH' | 'JSON_NUMERIC_SELECTION_ARRAY_TYPE_MISMATCH' | 'JSON_NUMERIC_SELECTION_ROW_LIMIT_EXCEEDED' | 'JSON_NUMERIC_SELECTION_ROW_TYPE_MISMATCH' | 'JSON_NUMERIC_SELECTION_INVALID_ISO_DATE' | 'JSON_NUMERIC_SELECTION_EXTREME_TYPE_MISMATCH' | 'JSON_NUMERIC_SELECTION_NON_SCALAR_PROJECTION' | 'JSON_NUMERIC_SELECTION_NO_MATCH' | 'JSON_NUMERIC_SELECTION_TIE_LIMIT_EXCEEDED' | 'JSON_NUMERIC_SELECTION_OUTPUT_TOO_LARGE';
declare class JsonNumericSelectionError extends Error {
  readonly code: JsonNumericSelectionErrorCode;
  constructor(message: string, code: JsonNumericSelectionErrorCode, options?: ErrorOptions);
}
/**
 * Select every exact numeric maximum/minimum tie from one bounded JSON object-array.
 * JSON number comparison and projection use the source lexeme rather than IEEE-754.
 */
declare function selectJsonNumericTies(input: string | Uint8Array, rawRequest: JsonNumericSelectionRequest): JsonNumericSelectionResult;
//#endregion
//#region src/json-numeric-tool.d.ts
type JsonNumericPageFetcher = (url: string, allowedDomains: readonly string[], signal?: AbortSignal) => Promise<FetchedPage>;
interface VerifiedJsonNumericSelectionResult {
  readonly sourceUrl: string;
  readonly finalUrl: string;
  readonly retrievedAt: string;
  readonly selection: JsonNumericSelectionResult;
}
declare function formatJsonNumericSelectionResult(result: VerifiedJsonNumericSelectionResult): string;
declare function selectFetchedJsonNumeric(sourceUrl: string, allowedDomainsInput: readonly string[], selection: JsonNumericSelectionRequest, signal?: AbortSignal, fetcher?: JsonNumericPageFetcher): Promise<VerifiedJsonNumericSelectionResult>;
declare function createVerifiedJsonNumericSelectionTool(timeoutMs?: number, fetcher?: JsonNumericPageFetcher): import("@deepseek-ai/dsh-tools").ToolDefinition;
//#endregion
//#region src/json-projection.d.ts
/** Numbers are excluded because ordinary JSON.parse cannot preserve their exact lexemes. */
type JsonProjectionScalar = string | boolean | null;
interface JsonRowProjection {
  readonly name: string;
  /** RFC 6901 JSON Pointer, resolved relative to the selected row. */
  readonly pointer: string;
}
interface JsonProjectionWhere {
  readonly pointer: string;
  /** Numbers are deliberately excluded: JSON.parse cannot preserve their exact lexemes. */
  readonly equals: string | boolean | null;
}
interface JsonNestedProjectionRequest {
  /** RFC 6901 pointer relative to each matching parent row. */
  readonly arrayPointer: string;
  readonly where?: readonly JsonProjectionWhere[];
  readonly project: readonly JsonRowProjection[];
}
interface JsonProjectionRequest {
  /** RFC 6901 pointer from the JSON root to an array of objects. */
  readonly arrayPointer: string;
  readonly where?: readonly JsonProjectionWhere[];
  readonly project: readonly JsonRowProjection[];
  /** At most one nested array selection, relative to every matching parent row. */
  readonly nested?: JsonNestedProjectionRequest;
}
interface JsonProjectionNestedRow {
  /** Zero-based position in its parent row's nested source array. */
  readonly sourceIndex: number;
  readonly values: Readonly<Record<string, JsonProjectionScalar>>;
}
interface JsonNestedProjectionResult {
  readonly arrayPointer: string;
  readonly where?: readonly JsonProjectionWhere[];
  /** Exact number of rows in this parent row's nested source array. */
  readonly rowCount: number;
  readonly matchCount: number;
  /** Every strict match in source order. */
  readonly rows: readonly JsonProjectionNestedRow[];
}
interface JsonProjectionRow {
  /** Zero-based position in the top-level source array. */
  readonly sourceIndex: number;
  readonly values: Readonly<Record<string, JsonProjectionScalar>>;
  readonly nested?: JsonNestedProjectionResult;
}
type JsonProjectionPointerRepair = {
  readonly kind: 'ascii_case';
  readonly segmentIndex: number;
  readonly requestedSegment: string;
  readonly effectiveSegment: string;
} | {
  readonly kind: 'root_array_fallback';
};
interface JsonProjectionPointerAudit {
  readonly requestedPointer: string;
  readonly effectivePointer: string;
  readonly repairs: readonly JsonProjectionPointerRepair[];
}
interface JsonProjectionNamedPointerAudit extends JsonProjectionPointerAudit {
  readonly name: string;
}
interface JsonProjectionPointerAudits {
  readonly array: JsonProjectionPointerAudit;
  readonly where: readonly JsonProjectionPointerAudit[];
  readonly project: readonly JsonProjectionNamedPointerAudit[];
  readonly nested?: {
    readonly array: JsonProjectionPointerAudit;
    readonly where: readonly JsonProjectionPointerAudit[];
    readonly project: readonly JsonProjectionNamedPointerAudit[];
  };
}
interface JsonProjectionResult {
  readonly complete: true;
  readonly truncated: false;
  readonly evidenceSha256: string;
  readonly arrayPointer: string;
  readonly where?: readonly JsonProjectionWhere[];
  readonly pointerAudits: JsonProjectionPointerAudits;
  /** Exact number of rows in the selected source array. */
  readonly rowCount: number;
  readonly matchCount: number;
  /** Every strict match in source order; no sort-derived semantics are applied. */
  readonly rows: readonly JsonProjectionRow[];
}
type JsonProjectionErrorCode = 'JSON_PROJECTION_INVALID_REQUEST' | 'JSON_PROJECTION_INPUT_TOO_LARGE' | 'JSON_PROJECTION_INVALID_UTF8' | 'JSON_PROJECTION_INVALID_UNICODE' | 'JSON_PROJECTION_INVALID_JSON' | 'JSON_PROJECTION_DUPLICATE_KEY' | 'JSON_PROJECTION_PARSE_LIMIT_EXCEEDED' | 'JSON_PROJECTION_INVALID_POINTER' | 'JSON_PROJECTION_AMBIGUOUS_POINTER_REPAIR' | 'JSON_PROJECTION_INCONSISTENT_POINTER_REPAIR' | 'JSON_PROJECTION_POINTER_NOT_FOUND' | 'JSON_PROJECTION_POINTER_TYPE_MISMATCH' | 'JSON_PROJECTION_ROOT_TYPE_MISMATCH' | 'JSON_PROJECTION_ARRAY_TYPE_MISMATCH' | 'JSON_PROJECTION_ROW_LIMIT_EXCEEDED' | 'JSON_PROJECTION_ROW_TYPE_MISMATCH' | 'JSON_PROJECTION_NUMERIC_PROJECTION_UNSUPPORTED' | 'JSON_PROJECTION_NON_SCALAR_PROJECTION' | 'JSON_PROJECTION_OUTPUT_TOO_LARGE';
declare class JsonProjectionError extends Error {
  readonly code: JsonProjectionErrorCode;
  constructor(message: string, code: JsonProjectionErrorCode, options?: ErrorOptions);
}
/**
 * Project every strict match from a bounded JSON object-array in source order.
 * No ranking, maximum, or inferred ordering semantics are applied.
 */
declare function projectJsonRows(input: string | Uint8Array, rawRequest: JsonProjectionRequest): JsonProjectionResult;
//#endregion
//#region src/json-projection-tool.d.ts
type JsonProjectionPageFetcher = (url: string, allowedDomains: readonly string[], signal?: AbortSignal) => Promise<FetchedPage>;
interface VerifiedJsonProjectionResult {
  readonly sourceUrl: string;
  readonly finalUrl: string;
  readonly retrievedAt: string;
  readonly projection: JsonProjectionResult;
}
declare function formatJsonProjectionResult(result: VerifiedJsonProjectionResult): string;
declare function projectFetchedJson(sourceUrl: string, allowedDomainsInput: readonly string[], projection: JsonProjectionRequest, signal?: AbortSignal, fetcher?: JsonProjectionPageFetcher): Promise<VerifiedJsonProjectionResult>;
declare function createVerifiedJsonProjectionTool(timeoutMs?: number, fetcher?: JsonProjectionPageFetcher): import("@deepseek-ai/dsh-tools").ToolDefinition;
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
declare function extractPageEvidence(page: NormalizedPage, query: string, requiredPhrases?: readonly string[], scope?: VerifiedResearchClaimScope, valueKind?: VerifiedResearchClaimValueKind): VerifiedPageEvidence | undefined;
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
export { Config, EvidenceFetchError, type FetchEvidenceOptions, type FetchedPage, type JsonNestedProjectionRequest, type JsonNumberLexeme, type JsonNumericProjectedScalar, JsonNumericSelectionError, type JsonNumericSelectionRequest, type JsonNumericSelectionResult, JsonProjectionError, type JsonProjectionRequest, type JsonProjectionResult, type JsonProjectionScalar, type JsonProjectionWhere, type JsonRowProjection, JsonSelectionError, type JsonSelectionRequest, type JsonSelectionResult, type NormalizedPage, type PageFetcher, type ResolvedAddress, SearchFilterError, SearchFilterViolationError, type SearchOptions, type SearchRunner, type VerifiedPageEvidence, type VerifiedResearchClaimValueKind, type VerifiedResearchLane, type VerifiedResearchLaneResult, type VerifiedResearchLaneStatus, type VerifiedResearchRequest, type VerifiedResearchResult, type VerifiedResearchSource, VerifiedSearchError, type VerifiedSearchRequest, type VerifiedSearchResult, type VerifiedSearchSource, type VerifiedSearchWireRequest, apply, createVerifiedJsonNumericSelectionTool, createVerifiedJsonProjectionTool, createVerifiedJsonSelectionTool, createVerifiedResearchTool, createVerifiedSearchTool, enforceAllowedSources, extractPageEvidence, fetchEvidencePage, filterAllowedSources, formatJsonNumericSelectionResult, formatJsonProjectionResult, formatJsonSelectionResult, formatResearchResult, formatResult, inject, installForAgent, installVerifiedResearchFinalizationPolicy, installVerifiedSearchPolicy, isPublicAddress, mapResponse, name, normalizeAllowedDomains, normalizeFetchedPage, projectFetchedJson, projectJsonRows, research, researchFinalizationInstruction, search, searchInstruction, selectFetchedJson, selectFetchedJsonNumeric, selectJsonMaxTies, selectJsonNumericTies };
//# sourceMappingURL=index.d.ts.map