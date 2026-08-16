# dsh-plugin-verified-search

[![CI](https://github.com/f0909172434/dsh-plugin-verified-search/actions/workflows/ci.yml/badge.svg)](https://github.com/f0909172434/dsh-plugin-verified-search/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/f0909172434/dsh-plugin-verified-search?display_name=tag)](https://github.com/f0909172434/dsh-plugin-verified-search/releases)
[![License](https://img.shields.io/github/license/f0909172434/dsh-plugin-verified-search)](LICENSE)

[English](README.md) · [繁體中文](README.zh.md) · [简体中文](README.zh-CN.md)

**Auditable current-source retrieval for DeepSeek Harness.**

The plugin replaces an agent's inherited `web_search` with bounded workflows that make source scope, retained evidence, deterministic JSON selection, and unresolved gaps visible. It is the installable companion to [deepseek-harness Discussion #332](https://github.com/deepseek-ai/deepseek-harness/discussions/332) and also mounts the time context discussed in [Discussion #344](https://github.com/deepseek-ai/deepseek-harness/discussions/344).

It verifies workflow and structured-source postconditions. It does **not** certify publisher truth or guarantee that an upstream search index is current.

![Architecture of the bounded evidence workflow](docs/assets/architecture.svg)

## Release status

| Track | Install ref | Model-facing tools | Validation boundary |
| --- | --- | --- | --- |
| Stable | `v0.1.1` | `verified_search` | Maintainer-validated release tag with packaged artifacts, checksums, cross-platform CI, clean-profile installation, and recorded live provider conformance |
| Experimental snapshot | `c29b531a6c2e52200d454aa9ded42214ba8c0014` | All five tools listed below | Last green `main` snapshot on 2026-08-16; 250 tests and the 42-case frozen offline corpus passed |
| Moving `main` | `main` | Unreleased development | Do not install unpinned; behavior and generated artifacts may change between commits |

> **External independent validation: absent.** The repository provides internal deterministic tests, CI, package-reproducibility checks, and maintainer-run conformance evidence. Those signals are not described as third-party review.

## Prerequisites

- DeepSeek Harness `0.1.0-rc.6` and Cordis `4.0.1`.
- Node.js `22.19.x` or `24.x`.
- A `DEEPSEEK_API_KEY` available through the Harness credential service or launch environment.
- A search-capable preset. The plugin does not grant search capability to the shipped `minimal` preset.
- Ubuntu and Windows are covered by CI. macOS is not currently part of the support contract.

See [the compatibility contract](docs/COMPATIBILITY.md) before changing Harness, Cordis, Node, or package-manager versions.

## Install in one minute

### Stable `verified_search`

```powershell
dsh plugin --profile web add github:f0909172434/dsh-plugin-verified-search#v0.1.1
dsh --profile web --dump-config
dsh web
```

Equivalent one-line PowerShell command:

```powershell
dsh plugin --profile web add github:f0909172434/dsh-plugin-verified-search#v0.1.1; dsh --profile web --dump-config; dsh web
```

The release commits prebuilt `lib/` output and has no install-time build script, so a pinned Git install does not execute this repository's development toolchain on the user's machine.

### Experimental five-tool snapshot

```powershell
dsh plugin --profile web add github:f0909172434/dsh-plugin-verified-search#c29b531a6c2e52200d454aa9ded42214ba8c0014
dsh --profile web --dump-config
dsh web
```

Use this only for development and evaluation. Do not replace the commit with the moving `main` branch in a reproducible test.

If the deployment already mounts Discussion #344's `time-context` row, set `DSH_VERIFIED_SEARCH_DISABLE_TIME_CONTEXT=1` before starting Harness to avoid duplicate clock injectors.

### Roll back

```powershell
dsh plugin --profile web remove dsh-plugin-verified-search
dsh web
```

## Minimal quickstart

Ask a search-capable agent a bounded, absolute-date question, for example:

> Find DeepSeek's current flagship API model as of 2026-08-14. Use only `api-docs.deepseek.com`. If the retained sources do not contain an answer-bearing excerpt, report the claim as unresolved instead of filling it from memory.

The corresponding model-facing `verified_search` arguments are:

```json
{
  "query": "DeepSeek current flagship API model as of 2026-08-14",
  "allowed_domains": ["api-docs.deepseek.com"]
}
```

Expected behavior:

- the native provider allowlist is sent upstream;
- returned structured sources are post-filtered locally by exact hostname or subdomain;
- credential-bearing URLs and sensitive or tracking URL components are rejected or removed before session-visible results are assembled;
- a title or URL without a retained citation excerpt is not promoted to verified evidence;
- an evidence gap remains visible rather than being replaced with an older or memorized answer.

Run a separate unrestricted query when independent comparison sources are also required. The allowlist is a postcondition over returned structured-source hostnames, not a network-egress or privacy boundary.

## Choose the right tool

| Tool | Use it for | Bounded result |
| --- | --- | --- |
| `verified_search` | One narrow mutable-fact lookup | Structured-source hostname postfilter and visible citation-excerpt gaps |
| `verified_research` | Multi-entity or multi-claim research | Per-claim retained excerpt, retrieval metadata, content hash, and explicit unresolved claims |
| `verified_json_selection` | Latest/as-of selection from an official JSON feed | Strict RFC 6901 traversal, date cutoff, maximum date, and all final ties |
| `verified_json_numeric_extrema` | Exact numeric maximum or minimum from JSON | Source-lexeme comparison without IEEE-754 loss and all final ties |
| `verified_json_projection` | Every strict matching JSON row in source order | Bounded parent/nested projection with auditable pointer repairs and no inferred ordering |

Only `verified_search` belongs to the stable `v0.1.1` release. The other four tools are experimental in the pinned `0.3.0-experiment.0` snapshot.

### Composite research example

```json
{
  "query": "Identify current flagship API model IDs as of 2026-08-14",
  "lanes": [
    {
      "id": "deepseek",
      "query": "DeepSeek current flagship API model ID as of 2026-08-14",
      "required_claims": [
        {
          "id": "model_id",
          "query": "latest DeepSeek flagship API model identifier",
          "evidence_must_include": ["Model ID"],
          "value_kind": "generic_text",
          "scope": {"kind": "document", "must_include": ["DeepSeek"]}
        }
      ],
      "allowed_domains": ["api-docs.deepseek.com"],
      "seed_urls": ["https://api-docs.deepseek.com/api/list-models/"],
      "gap_query": "site:api-docs.deepseek.com/api/list-models model IDs 2026-08-14"
    }
  ]
}
```

`evidence_must_include` is a normalized substring postcondition, not a semantic entailment judge. Do not put the unknown answer itself into a required phrase merely to confirm the model's guess.

## Failure behavior

The plugin is designed to fail closed or stay explicitly unresolved.

- Invalid hostname allowlists, credential-bearing URLs, unsafe redirects, non-public resolved addresses, unsupported media, malformed charset declarations, invalid UTF-8, and resource-limit violations fail visibly.
- Structured JSON operations reject invalid JSON, duplicate keys, excessive nesting, invalid pointers, missing fields, unsupported numeric projection, row/tie/output limits, and unavailable exact number lexemes.
- Discovery may skip known binary paths. An explicitly supplied unsupported binary seed fails visibly instead of being silently reinterpreted.
- Provider or fetch timeouts abort bounded work and preserve the evidence gap.
- `allClaimsCovered`, `complete: true`, or `truncated: false` describe the declared bounded operation only; they do not prove source freshness, semantic entailment, publisher authenticity, feed completeness, or exhausted pagination.

## Trust and security boundary

The plugin can enforce that returned structured sources match an explicit hostname allowlist after local filtering. The experimental full-page reader additionally restricts retrieval to bounded public HTTPS targets with DNS/IP validation, pinned transport, redirect checks, supported text/JSON media types, charset validation, and byte/time limits.

It does **not** prove that:

- the provider's private candidate pool or generated prose used only allowed domains;
- the provider did not retrieve another page or follow a redirect outside the allowlist;
- the upstream index contains the newest page or ranks time correctly;
- a retained phrase entails the requested claim or handles negation correctly;
- a caller-selected seed URL is canonical, first-party, or authoritative;
- an API response is authentic, complete, unpaginated, correctly ordered, or factually correct;
- text from a public page is safe to follow as instructions.

Search queries are durable Harness session data. Never put secrets, signed URLs, or private data in a query. See [SECURITY.md](SECURITY.md) for private reporting and the detailed threat boundary.

## Verification snapshot

The pinned experimental snapshot records:

- source commit: `c29b531a6c2e52200d454aa9ded42214ba8c0014`;
- push CI: passed on Ubuntu and Windows across Node `22.19.x` and `24.x`;
- HonestCI baseline: **250 tests**, 0 failures, 0 errors, 0 skipped;
- frozen offline corpus: **42/42 cases**;
- registered offline result digest: `sha256:3002001da02d0b8501bcc97ee867109f1bfbf0e1a227d87845db81da658ea5c0`;
- committed `lib/` and package-content reproducibility checks;
- external independent validation: **absent**.

Machine-readable lifecycle, runtime, capability, and architecture facts live in [`capabilities.json`](capabilities.json) and [`architecture.json`](architecture.json). The evaluation method is documented in [docs/OFFLINE_EVALUATION.md](docs/OFFLINE_EVALUATION.md), [docs/PROPERTY_TESTING.md](docs/PROPERTY_TESTING.md), and [docs/HONEST_CI_DOGFOOD.md](docs/HONEST_CI_DOGFOOD.md).

## Observed evaluation

![Observed completion improvement on two difficult official-source tasks](docs/assets/benchmark.svg)

Two frozen-ledger live tasks were observed under a 600-second outer cap:

| Task | Before the fixes | Experimental workflow | Terminal time |
| --- | ---: | ---: | ---: |
| Go supported releases, security scope, and Linux artifact provenance | 0/8 | **8/8** | 317 s |
| EU AI Act amended timeline and GPAI transition dates | 0/8 | **6/8** | 307 s |
| **Combined** | **0/16** | **14/16 (87.5%)** | — |

All 14 answered requested fields had retained official-source evidence; the other two stayed unresolved. These are single observed runs, not a standardized benchmark, statistical estimate, latency target, or release guarantee. Both successful terminal runs exceeded 240 seconds, so timeout and latency work remains important.

## Configuration

The bundle can read `DEEPSEEK_API_KEY` from the Harness credential service or launch environment. Optional configuration fields include:

| Area | Fields |
| --- | --- |
| Provider | `apiKeyEnv`, `apiKey`, `baseURL`, `model`, `apiVersion` |
| Search limits | `maxTokens`, `maxUses`, `maxResults`, `searchTimeoutMs` |
| Experimental research | `researchTimeoutMs`, `researchMaxResults` |

`researchMaxResults` defaults to 24, is constrained to 4–32, and must be at least the declared claim count for the call. Treat configuration changes as compatibility and resource-boundary changes, not merely tuning.

## Development and full verification

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
pnpm test
pnpm run build
pnpm run evaluate:offline
npm pack --dry-run --ignore-scripts --json
git diff --check
git diff --exit-code -- lib
```

The second build must not create a new `lib/` diff. A changed frozen offline digest is a behavior-change signal; do not update the expected digest merely to make CI green.

## Documentation

- [Architecture and ownership boundaries](docs/ARCHITECTURE.md)
- [Compatibility contract](docs/COMPATIBILITY.md)
- [Frozen offline evaluation](docs/OFFLINE_EVALUATION.md)
- [Property-testing contract](docs/PROPERTY_TESTING.md)
- [HonestCI dogfooding evidence](docs/HONEST_CI_DOGFOOD.md)
- [Serial single-maintainer roadmap](docs/ROADMAP.md)
- [Maintenance rules](MAINTENANCE.md)
- [Security policy](SECURITY.md)
- [Change history](CHANGELOG.md)

## Relationship to the upstream core fix

This repository is a deployable compatibility layer. The provider-neutral Harness core change remains [`ce4d0455c`](https://github.com/f0909172434/deepseek-harness/commit/ce4d0455c637e5ba91fbb7b3a88725e7ec097371). If the official project ships equivalent bounded capabilities, this plugin can move to an additional verification mode or retire with a documented migration path.

## Security reporting

Use this repository's private GitHub security-advisory interface for a suspected credential leak, allowlist bypass, or unsafe page-fetch path. Do not paste API keys, signed URLs, private queries, private excerpts, or raw session logs into a public issue.

## License

MIT
