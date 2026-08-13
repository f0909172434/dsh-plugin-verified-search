# Security Policy

## Supported version

Only the latest tagged release and the current `main` branch are supported.

## Reporting

Report credential exposure, allowlist bypasses, or unsafe durable logging privately through this repository's GitHub security-advisory interface. Do not include live API keys, signed URLs, or unredacted Harness session logs in a public issue.

The plugin intentionally records a secret-free request envelope before every auxiliary model dispatch. Authorization headers and resolved credential values must never enter that record, tool output, or error message.
