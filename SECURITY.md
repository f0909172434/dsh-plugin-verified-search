# Security Policy

## Supported version

Only the latest tagged release and the current `main` branch are supported.

## Reporting

Report credential exposure, allowlist bypasses, or unsafe durable logging privately through this repository's enabled GitHub security-advisory interface. Do not include live API keys, signed URLs, search queries containing private data, or unredacted Harness session logs in a public issue.

The plugin intentionally records a credential-free request envelope before every auxiliary model dispatch using Harness's persistence-known `web/deepseek-search-llm-request` event. The query is part of that durable envelope; users must not put secrets or private data in a search query. Authorization headers and resolved credential values must never enter that record, tool output, or error message.

The unreleased `verified_research` experiment also performs bounded full-page reads. It accepts only HTTPS on port 443 with a DNS hostname and no URL credentials, resolves every address, rejects the hostname if any address is non-public, and pins the selected validated address to the actual TLS connection. Redirects must stay on the original origin and repeat URL, DNS, IP, and allowlist validation. Responses are limited by media type, content encoding, declared text charset, byte count, redirect count, overall timeout, and body-idle timeout. Undeclared/UTF-8 text is decoded fatally; explicitly declared ISO-8859-1 and Windows-1252 use the WHATWG Windows-1252 mapping, while unknown, malformed, or duplicate charset declarations fail closed.

The sole cross-origin representation exception is an HTTP 202 on the exact original EUR-Lex English legal-content request carrying one strict uppercase-alphanumeric `uri=CELEX:...` and no other query field, with both `eur-lex.europa.eu` and `publications.europa.eu` explicitly allowlisted. The reader may derive the matching official Publications Office `/resource/celex/` resolver. Only that resolver's HTTP 303 may select an exact query-free `/resource/cellar/<safe-id>/DOC_<n>` document; HTTP is upgraded to HTTPS only at this state transition. The exact target must return HTTP 200 `application/xhtml+xml` without another redirect, and both transitions consume the redirect budget. Every request re-runs URL, DNS, public-IP, allowlist, and pinned-TLS validation. The reader does not execute challenge scripts, keep cookies, follow arbitrary 202 metadata, or accept another cross-origin redirect.

This is an outbound-retrieval safety boundary, not a trust judgment about page content. Search queries, claim queries, caller-declared normalized-substring evidence postconditions, exact fetched excerpts, projected JSON scalar values, exact JSON-number lexemes, source/final URLs, retrieval timestamps, projection/selection metadata, and content hashes can become durable tool/session data and are explicitly presented to the model as untrusted. Tool arguments and model-authored candidate values are not evidence. Do not search for private URLs or content, project private fields, or put secrets in query parameters; URL sanitization is defensive and cannot identify every application-specific credential name. JSON hashes authenticate only the accepted input bytes used by a projection or selector, not the publisher or the truth, completeness, pagination state, units, ordering semantics, or other semantics of the feed.
