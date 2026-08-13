# dsh-plugin-verified-search

An installable DeepSeek Harness plugin for current/latest/as-of searches that need explicit source scope and honest evidence gaps.

This project is the immediately installable companion to [deepseek-harness Discussion #332](https://github.com/deepseek-ai/deepseek-harness/discussions/332). It does not claim that a search index is always current. It makes the retrieval procedure and returned structured-source boundary auditable.

## What it changes

- Adds a model-facing `verified_search` tool with `query` and optional `allowed_domains`.
- Mounts Harness rc.6's built-in durable `dsh-time-context` every 60 seconds, covering the composition omission reported in [Discussion #344](https://github.com/deepseek-ai/deepseek-harness/discussions/344).
- Hides and blocks the inherited legacy `web_search` for agents covered by the plugin.
- Requires absolute-date queries for mutable facts, a first-party allowlisted pass, and a separate unrestricted comparison pass.
- Calls DeepSeek's Anthropic-compatible Messages endpoint with native `web_search_20250305`.
- Records the exact credential-free auxiliary request before dispatch using Harness's persistence-known `web/deepseek-search-llm-request` event. The search query itself is durable session data, so never put a secret in it.
- Normalizes 1–20 bare ASCII hostnames and rejects schemes, paths, ports, wildcards, Unicode hostnames, and IP literals, including legacy IPv4 forms.
- Requires every returned structured source URL to match `allowed_domains` before capping results.
- Rejects credential-bearing source URLs and removes sensitive/tracking query parameters plus fragments before results enter tool/session logs.
- Joins citation excerpts to sources and exposes missing excerpts instead of treating a title or URL as verified content.

## Install

Install the reviewed release tag:

```powershell
dsh plugin --profile web add github:f0909172434/dsh-plugin-verified-search#v0.1.0
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

The plugin reuses `DEEPSEEK_API_KEY` from the Harness credential service or launch environment. Optional bundle configuration fields are `apiKeyEnv`, `apiKey`, `baseURL`, `model`, `apiVersion`, `maxTokens`, `maxUses`, `maxResults`, and `searchTimeoutMs`.

## Guarantees and limits

When `allowed_domains` is present, every returned structured source URL must use HTTP(S) and match an allowed hostname or subdomain. A violation fails the whole search and does not echo the offending URL into the error.

This does **not** prove that:

- DeepSeek's internal candidate pool or generated prose used only allowed sources;
- the upstream index contains the newest page;
- the provider's ranking is temporally correct;
- a provider-supplied `page_age` is an ISO publication date;
- a source without a returned citation excerpt supports a claim.

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

Tests cover hostname validation, legacy-IP rejection, secret-safe failures, request-before-dispatch logging, native wire mapping, allowlist postconditions, result capping, prompt/schema replacement, and execution blocking.

Git profile installation can show missing-peer warnings because Harness resolves its own peer packages through the healed profile fallback. The plugin keeps those peers explicit and narrow instead of silently bundling duplicate Harness runtimes. Manual release validation includes installation and HTTP boot from a new temporary `DSH_HOME`; public CI covers locked install, types, tests, prebuilt-artifact consistency, and package contents.

## Relationship to the core fix

The plugin is a deployable compatibility layer. The core fix remains [ce4d0455c](https://github.com/f0909172434/deepseek-harness/commit/ce4d0455c637e5ba91fbb7b3a88725e7ec097371), which evolves the provider-neutral `ctx.web` contract and all built-in providers. If the official project merges that work, this plugin can switch to an additional verification mode or retire.

## License

MIT

## Security

Please report a suspected credential leak or allowlist bypass privately through GitHub's security-advisory interface, which is enabled for this repository. Do not paste API keys, signed URLs, search queries containing private data, or raw session logs into a public issue.
