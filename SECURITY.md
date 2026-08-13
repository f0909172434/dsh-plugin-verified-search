# Security Policy

## Supported version

Only the latest tagged release and the current `main` branch are supported.

## Reporting

Report credential exposure, allowlist bypasses, or unsafe durable logging privately through this repository's enabled GitHub security-advisory interface. Do not include live API keys, signed URLs, search queries containing private data, or unredacted Harness session logs in a public issue.

The plugin intentionally records a credential-free request envelope before every auxiliary model dispatch using Harness's persistence-known `web/deepseek-search-llm-request` event. The query is part of that durable envelope; users must not put secrets or private data in a search query. Authorization headers and resolved credential values must never enter that record, tool output, or error message.
