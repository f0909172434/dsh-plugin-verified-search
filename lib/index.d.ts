import z from "@deepseek-ai/schemastery";
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
declare class SearchFilterViolationError extends Error {
  readonly code = "VERIFIED_SEARCH_FILTER_VIOLATION";
}
/** Normalize the portable hostname-only allowlist. */
declare function normalizeAllowedDomains(values: readonly string[] | undefined): readonly string[] | undefined;
/** Fail the whole result if a provider ignores an allowlist. */
declare function enforceAllowedSources(urls: readonly string[], allowedDomains: readonly string[] | undefined): void;
//#endregion
//#region src/provider.d.ts
interface Citation {
  readonly url?: string;
  readonly cited_text?: string;
}
interface TextBlock {
  readonly type: 'text';
  readonly citations?: readonly Citation[];
}
interface ResultItem {
  readonly type: string;
  readonly url?: string;
  readonly title?: string;
  readonly page_age?: string;
}
interface ResultBlock {
  readonly type: 'web_search_tool_result';
  readonly content?: readonly ResultItem[];
}
type ResponseBlock = TextBlock | ResultBlock | {
  readonly type: string;
};
interface AnthropicResponse {
  readonly content?: readonly ResponseBlock[];
}
declare class VerifiedSearchError extends Error {
  readonly code: string;
  constructor(message: string, code: string, options?: ErrorOptions);
}
declare function searchInstruction(query: string): string;
/** Map result blocks and citation excerpts without trusting provider prose. */
declare function mapResponse(response: AnthropicResponse): VerifiedSearchSource[];
/** Execute one independently logged DeepSeek native-search turn. */
declare function search(request: VerifiedSearchRequest, options: SearchOptions, signal?: AbortSignal): Promise<VerifiedSearchResult>;
//#endregion
//#region src/tool.d.ts
declare function formatResult(result: VerifiedSearchResult): string;
declare function createVerifiedSearchTool(options: () => SearchOptions, timeoutMs?: number): import("@deepseek-ai/dsh-tools").ToolDefinition;
declare function installVerifiedSearchPolicy(ctx: Context): () => void;
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
}
declare const Config: z<Config>;
/** Install the tool/policy into one live agent scope. Exported for tests. */
declare function installForAgent(agentCtx: Context, options: () => SearchOptions, timeoutMs?: number): () => void;
declare function apply(ctx: Context, input: Config): void;
//#endregion
export { Config, SearchFilterError, SearchFilterViolationError, type SearchOptions, VerifiedSearchError, type VerifiedSearchRequest, type VerifiedSearchResult, type VerifiedSearchSource, type VerifiedSearchWireRequest, apply, createVerifiedSearchTool, enforceAllowedSources, formatResult, inject, installForAgent, installVerifiedSearchPolicy, mapResponse, name, normalizeAllowedDomains, search, searchInstruction };
//# sourceMappingURL=index.d.ts.map