import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/domains.ts
const MAX_ALLOWED_DOMAINS = 20;
var SearchFilterError = class extends Error {
	code = "VERIFIED_SEARCH_INVALID_FILTER";
};
var SearchFilterViolationError = class extends Error {
	code = "VERIFIED_SEARCH_FILTER_VIOLATION";
};
/** Normalize the portable hostname-only allowlist. */
function normalizeAllowedDomains(values) {
	if (values === void 0) return void 0;
	if (values.length === 0) throw new SearchFilterError("allowed_domains must contain at least one domain");
	if (values.length > MAX_ALLOWED_DOMAINS) throw new SearchFilterError(`allowed_domains supports at most ${MAX_ALLOWED_DOMAINS} domains`);
	const normalized = values.map((value) => {
		if (value.length === 0 || value !== value.trim()) throw new SearchFilterError("allowed_domains entries must be non-empty and have no surrounding whitespace");
		if (!/^[\x21-\x7e]+$/u.test(value)) throw new SearchFilterError("allowed_domains entries must contain only printable ASCII");
		if (value.length > 253 || value.includes("://") || /[\\/?#@:*]/u.test(value)) throw new SearchFilterError("allowed_domains entries must be bare hostnames without scheme, path, port, wildcard, query, or credentials");
		const hostname = value.toLowerCase();
		let parsedHostname;
		try {
			parsedHostname = new URL(`http://${hostname}`).hostname.toLowerCase();
		} catch {
			throw new SearchFilterError("allowed_domains entries must be valid ASCII hostnames, not IP literals");
		}
		const labels = hostname.split(".");
		if (/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(hostname) || parsedHostname !== hostname || labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) throw new SearchFilterError("allowed_domains entries must be valid ASCII hostnames, not IP literals");
		return hostname;
	});
	return [...new Set(normalized)];
}
function sourceMatchesDomain(sourceUrl, domain) {
	let url;
	try {
		url = new URL(sourceUrl);
	} catch {
		return false;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return false;
	const sourceHost = url.hostname.toLowerCase();
	return sourceHost === domain || sourceHost.endsWith(`.${domain}`);
}
/** Fail the whole result if a provider ignores an allowlist. */
function enforceAllowedSources(urls, allowedDomains) {
	if (allowedDomains === void 0) return;
	const index = urls.findIndex((url) => !allowedDomains.some((domain) => sourceMatchesDomain(url, domain)));
	if (index === -1) return;
	throw new SearchFilterViolationError(`search provider returned source ${index + 1} outside allowed_domains`);
}
//#endregion
//#region src/provider.ts
var VerifiedSearchError = class extends Error {
	code;
	constructor(message, code, options) {
		super(message, options);
		this.code = code;
		this.name = "VerifiedSearchError";
	}
};
function searchInstruction(query) {
	return [
		`Search the live web and answer this exact query: ${query}`,
		"When the query explicitly says \"as of\" a date, treat that date as the cutoff. Prefer current first-party or benchmark-owner evidence.",
		"For current, latest, or as-of version and benchmark comparisons, verify that every item is the current version for the requested date. Do not substitute an older version when the current one cannot be verified.",
		"After searching, answer the query and cite every factual claim so the response contains citation excerpts for the caller. State any unresolved gap explicitly."
	].join("\n");
}
/** Map result blocks and citation excerpts without trusting provider prose. */
function mapResponse(response) {
	const blocks = response.content ?? [];
	const resultBlocks = blocks.filter((block) => block.type === "web_search_tool_result");
	if (resultBlocks.length === 0) throw new VerifiedSearchError("DeepSeek returned no web_search_tool_result blocks; native search may not have run", "VERIFIED_SEARCH_PROVIDER_ERROR");
	const snippets = /* @__PURE__ */ new Map();
	for (const block of blocks) {
		if (block.type !== "text") continue;
		for (const citation of block.citations ?? []) if (citation.url && citation.cited_text && !snippets.has(citation.url)) snippets.set(citation.url, citation.cited_text);
	}
	const seen = /* @__PURE__ */ new Set();
	const sources = [];
	for (const block of resultBlocks) for (const item of block.content ?? []) {
		if (item.type !== "web_search_result" || !item.url || seen.has(item.url)) continue;
		seen.add(item.url);
		const snippet = snippets.get(item.url);
		sources.push({
			url: item.url,
			...item.title ? { title: item.title } : {},
			...snippet ? { snippet } : {},
			...item.page_age ? { publishedAt: item.page_age } : {}
		});
	}
	return sources;
}
function isAbort(error) {
	return error instanceof DOMException && error.name === "AbortError";
}
function throwIfAborted(signal) {
	if (signal?.aborted === true) throw new VerifiedSearchError("verified search aborted", "VERIFIED_SEARCH_ABORTED", { cause: signal.reason });
}
async function resolveApiKey(options, signal) {
	throwIfAborted(signal);
	if (options.apiKey) return options.apiKey;
	let value;
	try {
		value = await options.resolveApiKey?.();
	} catch (error) {
		throw new VerifiedSearchError(`credential resolution failed: ${String(error)}`, "VERIFIED_SEARCH_PROVIDER_ERROR", { cause: error });
	}
	throwIfAborted(signal);
	if (value) return value;
	throw new VerifiedSearchError(`no DeepSeek API key for "${options.apiKeyRef}"; configure it on the Harness Models page or launch environment`, "VERIFIED_SEARCH_CREDENTIAL_MISSING");
}
/** Execute one independently logged DeepSeek native-search turn. */
async function search(request, options, signal) {
	if (request.query.trim().length === 0) throw new VerifiedSearchError("query must be a non-empty string", "VERIFIED_SEARCH_INVALID_QUERY");
	const allowedDomains = normalizeAllowedDomains(request.allowedDomains);
	const apiKey = await resolveApiKey(options, signal);
	const endpoint = `${options.baseURL.replace(/\/$/u, "")}/messages`;
	const body = {
		model: options.model,
		max_tokens: options.maxTokens,
		messages: [{
			role: "user",
			content: [{
				type: "text",
				text: searchInstruction(request.query)
			}]
		}],
		tools: [{
			type: "web_search_20250305",
			name: "web_search",
			max_uses: options.maxUses,
			...allowedDomains === void 0 ? {} : { allowed_domains: allowedDomains }
		}]
	};
	options.recordRequest({
		endpoint,
		apiVersion: options.apiVersion,
		body
	});
	throwIfAborted(signal);
	let response;
	try {
		response = await fetch(endpoint, {
			method: "POST",
			redirect: "error",
			headers: {
				"x-api-key": apiKey,
				"authorization": `Bearer ${apiKey}`,
				"anthropic-version": options.apiVersion,
				"content-type": "application/json",
				"accept": "application/json",
				"user-agent": "dsh-plugin-verified-search/0.1.0"
			},
			body: JSON.stringify(body),
			...signal === void 0 ? {} : { signal }
		});
	} catch (error) {
		if (signal?.aborted === true || isAbort(error)) throw new VerifiedSearchError("verified search aborted", "VERIFIED_SEARCH_ABORTED", { cause: signal?.reason ?? error });
		throw new VerifiedSearchError(`DeepSeek search request failed: ${String(error)}`, "VERIFIED_SEARCH_PROVIDER_ERROR", { cause: error });
	}
	if (!response.ok) {
		let detail = `DeepSeek API error (HTTP ${response.status})`;
		try {
			const payload = await response.json();
			detail = typeof payload.error === "string" ? payload.error : payload.error?.message ?? payload.message ?? detail;
		} catch (error) {
			if (signal?.aborted === true || isAbort(error)) throw new VerifiedSearchError("verified search aborted", "VERIFIED_SEARCH_ABORTED", { cause: signal?.reason ?? error });
		}
		throw new VerifiedSearchError(detail, "VERIFIED_SEARCH_PROVIDER_ERROR");
	}
	let sources;
	try {
		sources = mapResponse(await response.json());
	} catch (error) {
		if (error instanceof VerifiedSearchError) throw error;
		if (signal?.aborted === true || isAbort(error)) throw new VerifiedSearchError("verified search aborted", "VERIFIED_SEARCH_ABORTED", { cause: signal?.reason ?? error });
		throw new VerifiedSearchError(`DeepSeek returned an unprocessable response: ${String(error)}`, "VERIFIED_SEARCH_PROVIDER_ERROR", { cause: error });
	}
	enforceAllowedSources(sources.map((source) => source.url), allowedDomains);
	const truncated = sources.length > options.maxResults;
	return {
		sources: truncated ? sources.slice(0, options.maxResults) : sources,
		truncated
	};
}
//#endregion
//#region src/tool.ts
const outputSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		sources: {
			type: "array",
			required: true,
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					url: {
						type: "string",
						required: true
					},
					title: { type: "string" },
					snippet: { type: "string" },
					publishedAt: { type: "string" }
				}
			}
		},
		truncated: {
			type: "boolean",
			required: true
		}
	}
};
function sourceLabel(source) {
	if (source.title) return source.title;
	try {
		return new URL(source.url).hostname;
	} catch {
		return source.url;
	}
}
function formatResult(result) {
	if (result.sources.length === 0) return "No structured sources were returned. State that the current claim remains unresolved.";
	const notes = [
		"Sources:",
		...result.sources.map((source) => {
			const evidence = [source.snippet, source.publishedAt ? `(${source.publishedAt})` : void 0].filter((value) => value !== void 0 && value.length > 0).join(" ");
			return `- [${sourceLabel(source)}](${source.url})${evidence ? ` — ${evidence}` : ""}`;
		}),
		"",
		"Only the returned structured source URLs were mechanically verified. A date/page-age label is provider metadata, not proof of freshness.",
		"If a source has no excerpt, lower confidence and disclose that the page content was not independently verified."
	];
	if (result.truncated) notes.push("The source list was capped. Refine the query if the evidence is incomplete.");
	return notes.join("\n");
}
function meta(result) {
	return {
		sources: result.sources.map((source) => ({
			url: source.url,
			...source.title === void 0 ? {} : { title: source.title },
			...source.snippet === void 0 ? {} : { snippet: source.snippet },
			...source.publishedAt === void 0 ? {} : { publishedAt: source.publishedAt }
		})),
		truncated: result.truncated
	};
}
function presentationMeta(result) {
	if (result.isError || typeof result.meta !== "object" || result.meta === null || Array.isArray(result.meta)) return void 0;
	const { sources, truncated } = result.meta;
	if (!Array.isArray(sources) || typeof truncated !== "boolean") return void 0;
	const accepted = [];
	for (const value of sources) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
		const source = value;
		if (typeof source.url !== "string" || source.title !== void 0 && typeof source.title !== "string" || source.snippet !== void 0 && typeof source.snippet !== "string" || source.publishedAt !== void 0 && typeof source.publishedAt !== "string") return void 0;
		accepted.push(source);
	}
	return {
		sources: accepted,
		truncated
	};
}
function createVerifiedSearchTool(options, timeoutMs = 6e4) {
	return defineTool({
		name: "verified_search",
		description: "Search the live web with current-version guidance and an optional mechanically enforced source-domain allowlist.",
		parameters: {
			query: {
				type: "string",
				required: true,
				description: "Search query. Include an absolute date for current/latest/as-of claims."
			},
			allowed_domains: {
				type: "array",
				items: { type: "string" },
				description: "Optional list of 1–20 bare ASCII hostnames. Exact hosts and subdomains are allowed."
			}
		},
		output: {
			schema: outputSchema,
			render: (_args, result) => [{
				type: "text",
				text: formatResult(result)
			}],
			presentationMeta: (_args, result) => meta(result)
		},
		timeoutMs,
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const result = await search({
				query: args.query,
				...args.allowed_domains === void 0 ? {} : { allowedDomains: args.allowed_domains }
			}, options(), exec.signal);
			return {
				sources: result.sources.map((source) => ({ ...source })),
				truncated: result.truncated
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: args.query,
			kind: "search",
			rawInput: args.query
		}),
		presentResult: (args, result) => {
			const projected = presentationMeta(result);
			if (projected === void 0) return void 0;
			return {
				card: "web",
				kind: "search",
				title: args.query,
				...projected
			};
		}
	});
}
function installVerifiedSearchPolicy(ctx) {
	const disposers = [];
	disposers.push(ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
		const result = await next();
		return {
			...result,
			tools: result.tools.filter((tool) => tool.name !== "web_search")
		};
	}));
	disposers.push(ctx.tools.guard((exec) => exec.name === "web_search" ? "web_search is disabled by dsh-plugin-verified-search; use verified_search" : void 0));
	disposers.push(ctx.systemPrompt.section({
		name: "tool:web_search",
		order: 110,
		text: ""
	}));
	disposers.push(ctx.systemPrompt.section({
		name: "tool:verified_search",
		order: 109,
		text: "Use verified_search for mutable current, latest, today, version, price, benchmark, or as-of claims. Include an absolute date in the query. First run an allowed_domains pass over first-party or benchmark-owner domains, then run a separate unrestricted pass for independent comparisons. Verify that every compared item is the current version for the requested date. Never substitute an older version when the current one cannot be verified; state the unresolved gap. Missing excerpts lower confidence and must be disclosed. Cite the returned URLs as markdown links."
	}));
	return () => {
		for (const dispose of disposers.toReversed()) dispose();
	};
}
//#endregion
//#region src/index.ts
const name = "verified-search";
const inject = [
	"agents",
	"tools",
	"systemPrompt"
];
const Config = z.object({
	apiKeyEnv: z.string().default("DEEPSEEK_API_KEY"),
	apiKey: z.string().role("secret"),
	baseURL: z.string().default("https://api.deepseek.com/anthropic/v1"),
	model: z.string().default("deepseek-v4-flash"),
	apiVersion: z.string().default("2023-06-01"),
	maxTokens: z.number().step(1).min(1).default(4096),
	maxUses: z.number().step(1).min(1).default(5),
	maxResults: z.number().step(1).min(1).default(8),
	searchTimeoutMs: z.number().step(1).min(1).default(6e4)
});
/** Install the tool/policy into one live agent scope. Exported for tests. */
function installForAgent(agentCtx, options, timeoutMs = 6e4) {
	const disposers = [];
	try {
		disposers.push(installVerifiedSearchPolicy(agentCtx));
		disposers.push(agentCtx.tools.register(createVerifiedSearchTool(options, timeoutMs)));
	} catch (error) {
		for (const dispose of disposers.toReversed()) dispose();
		throw error;
	}
	return () => {
		for (const dispose of disposers.toReversed()) dispose();
	};
}
function apply(ctx, input) {
	const config = {
		apiKeyEnv: input.apiKeyEnv ?? "DEEPSEEK_API_KEY",
		baseURL: input.baseURL ?? "https://api.deepseek.com/anthropic/v1",
		model: input.model ?? "deepseek-v4-flash",
		apiVersion: input.apiVersion ?? "2023-06-01",
		maxTokens: input.maxTokens ?? 4096,
		maxUses: input.maxUses ?? 5,
		maxResults: input.maxResults ?? 8,
		searchTimeoutMs: input.searchTimeoutMs ?? 6e4,
		...input.apiKey === void 0 ? {} : { apiKey: input.apiKey }
	};
	const optionsFor = (agentCtx) => ({
		...config.apiKey ? { apiKey: config.apiKey } : {},
		resolveApiKey: async () => {
			const ref = credentialRef(config.apiKeyEnv);
			const credentials = agentCtx.get("credentials");
			if (credentials !== void 0) return (await credentials.resolve(ref))?.value;
			return launchEnvironmentOf(agentCtx).get(config.apiKeyEnv)?.value;
		},
		apiKeyRef: config.apiKeyEnv,
		baseURL: config.baseURL,
		model: config.model,
		apiVersion: config.apiVersion,
		maxTokens: config.maxTokens,
		maxUses: config.maxUses,
		maxResults: config.maxResults,
		recordRequest: (request) => {
			const agent = agentCtx.agent;
			if (agent === void 0) throw new Error("verified-search: no agent session available for request logging");
			agent.session.append("verified-search/request", request);
		}
	});
	const installed = /* @__PURE__ */ new Map();
	const install = (agent) => {
		if (installed.has(agent)) return;
		const disposers = [];
		try {
			if (agent.ctx.tools.get("web_search", agent) !== void 0) disposers.push(agent.ctx.tools.restrict({ deny: ["web_search"] }));
			disposers.push(installForAgent(agent.ctx, () => optionsFor(agent.ctx), config.searchTimeoutMs));
		} catch (error) {
			for (const dispose of disposers.toReversed()) dispose();
			throw error;
		}
		installed.set(agent, () => {
			for (const dispose of disposers.toReversed()) dispose();
		});
	};
	ctx.on("agent/created", ({ agent }) => {
		install(agent);
	});
	ctx.on("agent/disposed", ({ agent }) => {
		installed.delete(agent);
	});
	for (const agent of ctx.agents.list()) install(agent);
	ctx.effect(() => () => {
		for (const dispose of [...installed.values()].toReversed()) dispose();
		installed.clear();
	}, "verified-search.agents()");
}
//#endregion
export { Config, SearchFilterError, SearchFilterViolationError, VerifiedSearchError, apply, createVerifiedSearchTool, enforceAllowedSources, formatResult, inject, installForAgent, installVerifiedSearchPolicy, mapResponse, name, normalizeAllowedDomains, search, searchInstruction };

//# sourceMappingURL=index.js.map