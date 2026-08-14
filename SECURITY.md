# Security Policy

## Supported version

Only the latest tagged release and the current `main` branch are supported.

## Reporting

Report credential exposure, allowlist bypasses, or unsafe durable logging privately through this repository's enabled GitHub security-advisory interface. Do not include live API keys, signed URLs, search queries containing private data, or unredacted Harness session logs in a public issue.

The plugin intentionally records a credential-free request envelope before every auxiliary model dispatch using Harness's persistence-known `web/deepseek-search-llm-request` event. The query is part of that durable envelope; users must not put secrets or private data in a search query. Authorization headers and resolved credential values must never enter that record, tool output, or error message.

The unreleased `verified_research` experiment also performs bounded full-page reads. It accepts only HTTPS on port 443 with a DNS hostname and no URL credentials, resolves every address, rejects the hostname if any address is non-public, and pins the selected validated address to the actual TLS connection. Redirects must stay on the original origin and repeat URL, DNS, IP, and allowlist validation. Responses are limited by media type, content encoding, byte count, redirect count, overall timeout, and body-idle timeout.

This is an outbound-retrieval safety boundary, not a trust judgment about page content. Exact fetched excerpts, their source URLs, retrieval timestamps, and content hashes can become durable tool/session data and are explicitly presented to the model as untrusted. Do not search for private URLs or content, and do not put secrets in query parameters; URL sanitization is defensive and cannot identify every application-specific credential name.
