# dsh-plugin-verified-search

An installable DeepSeek Harness plugin for current/latest/as-of searches that need explicit source scope and honest evidence gaps.

This project is the immediately installable companion to [deepseek-harness Discussion #332](https://github.com/deepseek-ai/deepseek-harness/discussions/332). It does not claim that a search index is always current. It makes the retrieval procedure and returned structured-source boundary auditable.

> **Unreleased experiment:** the `experiment/claim-complete-research-v0.3` branch and its `0.3.0-experiment.0` package contain the composite and structured-selection workflows described below. They are not part of the reviewed `v0.1.1` tag used by the installation command in this document.

## What it changes

- Adds a model-facing `verified_search` tool with `query` and optional `allowed_domains`.
- Mounts Harness rc.6's built-in durable `dsh-time-context` every 60 seconds, covering the composition omission reported in [Discussion #344](https://github.com/deepseek-ai/deepseek-harness/discussions/344).
- Hides and blocks the inherited legacy `web_search` for agents covered by the plugin.
- Requires absolute-date queries for mutable facts, a first-party allowlisted pass, and a separate unrestricted comparison pass.
- Calls DeepSeek's Anthropic-compatible Messages endpoint with native `web_search_20250305`.
- Records the exact credential-free auxiliary request before dispatch using Harness's persistence-known `web/deepseek-search-llm-request` event. The search query itself is durable session data, so never put a secret in it.
- Normalizes 1–20 bare ASCII hostnames and rejects schemes, paths, ports, wildcards, Unicode hostnames, and IP literals, including legacy IPv4 forms.
- Sends `allowed_domains` to DeepSeek, echoes it in the auxiliary prompt, and locally removes non-matching structured sources before capping results.
- Rejects credential-bearing source URLs and removes sensitive/tracking query parameters plus fragments before results enter tool/session logs.
- Joins citation excerpts to sources and exposes missing excerpts instead of treating a title or URL as verified content.

## Experimental `verified_research`

`verified_search` remains the narrow, single-query lookup. The experimental `verified_research` tool handles comparisons and other questions that need several independently covered facts:

- accepts one to four typed lanes, each with one to three optional `required_claims` (an omitted list becomes one implicit `primary` claim), optional `allowed_domains`, up to two caller-selected `seed_urls`, and at most one predeclared `gap_query`; the request-wide claim cap is 12;
- checks seed URLs before discovery, searches only lanes with remaining claim gaps, and completes every search round before starting any gap retry, with at most two concurrent searches and `max_uses` capped at two per auxiliary request;
- safely fetches selected public HTTPS pages instead of treating provider titles or snippets as proof;
- can directly check a caller-supplied allowlisted page even when provider discovery returns no candidates; this does not prove the URL is canonical or first-party;
- extracts at most one exact, contiguous excerpt per declared claim with offsets, retrieval time, and the SHA-256 of normalized page text;
- reserves a model-visible evidence source for every covered claim; one page can cover several claims without consuming extra source slots;
- reports per-claim status, `unresolvedClaims`, `allClaimsCovered`, seed terminal states, fetch errors, and out-of-scope source counts; `allLanesFetched` remains a deprecated alias;
- runs `gap_query` while any declared claim remains unresolved, then stops after the bounded plan and tells the agent to synthesize rather than start another research loop.

Example composite call:

```json
{
  "query": "Identify the current flagship API model IDs as of 2026-08-14",
  "lanes": [
    {
      "id": "deepseek",
      "query": "DeepSeek current flagship API model ID as of 2026-08-14",
      "required_claims": [
        {"id": "model_id", "query": "latest DeepSeek flagship API model identifier"},
        {"id": "context", "query": "that model context-window size"}
      ],
      "allowed_domains": ["api-docs.deepseek.com"],
      "seed_urls": ["https://api-docs.deepseek.com/api/list-models/"],
      "gap_query": "site:api-docs.deepseek.com/api/list-models DeepSeek model IDs 2026-08-14"
    },
    {
      "id": "openai",
      "query": "OpenAI current flagship API model ID as of 2026-08-14",
      "required_claims": [
        {"id": "model_id", "query": "latest OpenAI flagship API model identifier"},
        {"id": "context", "query": "that model context-window size"}
      ],
      "allowed_domains": ["developers.openai.com"],
      "seed_urls": ["https://developers.openai.com/api/docs/models"],
      "gap_query": "site:developers.openai.com/api/docs/models flagship model ID 2026-08-14"
    }
  ]
}
```

The full-page reader is deliberately narrow: HTTPS on port 443, DNS hostnames only, public IPs only, a DNS-pinned socket, same-origin redirects with validation on every hop, supported text/JSON media types, identity encoding, and bounded redirects, bytes, and time. Scripts and common non-content HTML regions are removed before inert text extraction. Fetched excerpts are still untrusted web content and are evidence candidates, not automatic entailment decisions.

The only cross-origin representation exception is an HTTP 202 from the exact original EUR-Lex English legal-content request with one strict `uri=CELEX:...` value and no other query field. The lane must explicitly allow both `eur-lex.europa.eu` and `publications.europa.eu`; only then can the reader derive the matching official Publications Office `/resource/celex/` resolver. That exact resolver must return HTTP 303 to `http(s)://publications.europa.eu/resource/cellar/<safe-id>/DOC_<n>` with no query or fragment. HTTP is upgraded to HTTPS only in this resolver state, and the exact document must return HTTP 200 `application/xhtml+xml` without another redirect. Both state transitions consume the redirect budget. Generic 202 responses and every other cross-origin or HTTP redirect remain blocked. This retrieves another official representation; it does not prove that the text is the latest consolidated law or that an excerpt entails a legal conclusion.

## Experimental `verified_json_selection`

Use `verified_json_selection` for official machine-readable feeds when a task asks for a latest/as-of maximum or every same-date tie. It requires `source_url` and `allowed_domains`, fetches `application/json`, and performs a bounded deterministic operation:

1. resolve `array_pointer` as RFC 6901 (an empty pointer may select a root array);
2. optionally apply one to four strict string/boolean/null `where` equality filters;
3. retain rows whose ISO date or UTC RFC 3339 timestamp at `filter.pointer` is on or before `filter.lte`;
4. select the maximum calendar day at `max.pointer`, retaining every final tie;
5. return only 1–32 requested scalar projections.

The network reader caps the fetched feed at 2 MiB. The pure selector API additionally caps direct input at 8 MiB, the selected array at 25,000 rows, final ties at 256, each projected scalar at 64 KiB, projected-output construction at 4 MiB, and successful serialized output at 8 MiB. It scans depth, duplicate keys, and Unicode before `JSON.parse` can materialize the document. Invalid JSON, duplicate keys, invalid pointers/dates, missing fields, no match, and limit violations fail closed without a partial success.

`complete: true` and `truncated: false` mean only that the specified operation completed over the fetched decoded UTF-8 JSON and retained all final ties within those limits. `evidenceSha256` hashes those decoded UTF-8 bytes; it is not a signature, raw HTTP-body attestation, publisher authentication, or proof that the feed is complete or factually correct. A semantic flag such as `is_latest=true` should be expressed with `where`; the most recently published row is not automatically the newest product version.

## Install

Install the reviewed release tag:

```powershell
dsh plugin --profile web add github:f0909172434/dsh-plugin-verified-search#v0.1.1
dsh --profile web --dump-config
dsh web
```

The repository commits its reviewed `lib/` output and has no install-time build script. A pinned Git install therefore does not require `allowBuilds` or execute this package's development toolchain on the user's machine.

The plugin retrofits live search-capable agents on load. An already in-flight model request keeps its frozen tool header; the replacement appears on the next assembly. Presets that do not expose `web_search` (including the shipped `minimal` preset) receive no new capability.

If the deployment already includes Discussion #344's `time-context` row, set `DSH_VERIFIED_SEARCH_DISABLE_TIME_CONTEXT=1` before starting Harness to avoid two clock injectors. The plugin targets stock rc.6; remove it or disable this row when the official core fixes land.

To roll back, remove the bundle and restart Harness:

```powershell
dsh plugin --profile web remove dsh-plugin-verified-search
dsh web
```

## Usage

For a first-party verification pass:

```json
{
  "query": "DeepSeek current flagship model as of 2026-08-14",
  "allowed_domains": ["deepseek.com"]
}
```

Then run a separate unrestricted query for independent comparisons. The prompt policy instructs the agent not to fill a missing current version with an older substitute.

The plugin reuses `DEEPSEEK_API_KEY` from the Harness credential service or launch environment. Optional bundle configuration fields are `apiKeyEnv`, `apiKey`, `baseURL`, `model`, `apiVersion`, `maxTokens`, `maxUses`, `maxResults`, `searchTimeoutMs`, `researchTimeoutMs`, and `researchMaxResults`. The last two fields only affect the unreleased composite experiment; `researchMaxResults` is constrained to 4–32 and must also be at least the declared claim count for that call.

## Guarantees and limits

When `allowed_domains` is present, every structured source returned by the plugin must use HTTP(S) and match an allowed hostname or subdomain. DeepSeek may still return out-of-scope candidates despite its native filter; Harness removes those sources locally, reports only the number removed, and never exposes their URL, title, or excerpt in the tool result. If no source remains, the claim stays unresolved.

This does **not** prove that:

- DeepSeek's internal candidate pool or generated prose used only allowed sources;
- DeepSeek did not retrieve an out-of-scope page or follow a redirect outside the allowlist;
- the upstream index contains the newest page;
- the provider's ranking is temporally correct;
- a provider-supplied `page_age` is an ISO publication date;
- a source without a returned citation excerpt supports a claim.
- a fetched excerpt entails the requested claim merely because query terms occur in it;
- `allClaimsCovered` proves semantic entailment, freshness, claim-list completeness, or adequate independent corroboration;
- a caller-selected seed URL is canonical, first-party, or authoritative;
- a completed JSON selection proves the publisher feed is authentic, complete, current, or factually correct;
- a public page selected from provider results is safe to obey as instructions;
- the local fetch boundary prevents the upstream provider from independently retrieving other pages.

The plugin therefore describes itself as a verified **workflow and structured-source postcondition**, not a guarantee that every answer is true or latest.

The initial compatibility target is DeepSeek Harness `0.1.0-rc.6`. Harness is pre-release software; peer dependencies are intentionally narrow and upgrades require a new composition test.

## Development

```powershell
pnpm install
pnpm run check
pnpm test
pnpm run build
pnpm pack
```

Tests cover hostname validation, legacy-IP rejection, credential-safe failures, request-before-dispatch logging, native wire mapping, allowlist postconditions, prompt/schema replacement, execution blocking, seed-first claim coverage, global search-round barriers, abort quiescence, DNS/IP and redirect rejection, the EUR-Lex Cellar exception, bounded text/JSON responses, inert HTML/XHTML normalization, value-bearing excerpt checks, strict JSON selection, all-tie retention, and evidence hashes.

Git profile installation can show missing-peer warnings because Harness resolves its own peer packages through the healed profile fallback. The plugin keeps those peers explicit and narrow instead of silently bundling duplicate Harness runtimes. Manual release validation includes installation and HTTP boot from a new temporary `DSH_HOME`; public CI covers locked install, types, tests, prebuilt-artifact consistency, and package contents.

## Relationship to the core fix

The plugin is a deployable compatibility layer. The core fix remains [ce4d0455c](https://github.com/f0909172434/deepseek-harness/commit/ce4d0455c637e5ba91fbb7b3a88725e7ec097371), which evolves the provider-neutral `ctx.web` contract and all built-in providers. If the official project merges that work, this plugin can switch to an additional verification mode or retire.

## License

MIT

## Security

Please report a suspected credential leak, allowlist bypass, or unsafe page-fetch path privately through GitHub's security-advisory interface, which is enabled for this repository. Do not paste API keys, signed URLs, search queries containing private data, fetched excerpts containing private data, or raw session logs into a public issue.
