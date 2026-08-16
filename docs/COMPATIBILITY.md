# Compatibility contract

Compatibility is reported at three different evidence levels. They must not be collapsed into
one green badge.

## Evidence levels

### Level 1 — source contract

The repository type-checks, unit tests pass, generated `lib/` files reproduce, and the package
dry-run contains only declared files. This is the minimum evidence produced by ordinary CI.

### Level 2 — Harness integration contract

The plugin is installed into the exact supported DeepSeek Harness composition and verifies:

- plugin activation;
- replacement of inherited `web_search` only for search-capable agents;
- model-facing tool registration;
- prompt assembly and tool guards;
- durable request logging;
- preset switching and hot reload;
- `turn/end`, idle cancellation, agent disposal, and plugin disposal cleanup.

Mocked lifecycle tests contribute to this level, but a release claim also needs a clean-profile
installation against the exact peer versions.

### Level 3 — live provider conformance

A credentialed run reaches the real provider endpoint and records the credential-free request
envelope, returned structured sources, local post-filter result, unresolved evidence gaps, and
runtime versions. Provider behavior is observational evidence for that date; it is not a
permanent provider guarantee.

## Current matrix

| Component | Reviewed release `v0.1.1` | `main` experiment |
| --- | --- | --- |
| Package version | `0.1.1` | `0.3.0-experiment.0` |
| Model-facing tools | `verified_search` | five tools listed in `capabilities.json` |
| DeepSeek Harness packages | `0.1.0-rc.6` | exact peer contract `0.1.0-rc.6` |
| Cordis | `4.0.1` | `4.0.1` |
| Node | `22.19.x`, `24.x` | `22.19.x`, `24.x` |
| CI operating systems | Ubuntu, Windows | Ubuntu, Windows |
| Source contract | passed at release | required on every PR and `main` push |
| Clean Harness install | recorded in release notes | not a release claim |
| Live provider conformance | recorded on 2026-08-14 | experimental observations only |

A version not listed here is unsupported until a dedicated compatibility change updates:

1. exact peer dependencies;
2. `capabilities.json`;
3. lifecycle tests;
4. CI matrix;
5. clean installation evidence;
6. release or experiment notes.

## Runtime rules

- The lower Node boundary is exactly `22.19.0`, not an arbitrary Node 22 build.
- Node 24 represents the current higher runtime line tested by CI.
- The lockfile and `packageManager` field pin pnpm `10.28.2`.
- GitHub-hosted runner labels identify CI environments, not every Linux or Windows
  distribution.
- macOS is not currently part of the support contract.

## Upstream release handling

DeepSeek Harness remains pre-release software. A new rc or stable release is evaluated in an
isolated compatibility branch before peer ranges change. The minimum smoke contract is:

```text
install locked dependencies
activate plugin
create a search-capable agent
verify legacy web_search is unavailable
verify expected tools are registered
switch presets
end and cancel turns
reload and dispose the plugin
confirm no stale guards, sections, or tools remain
```

A canary against a newer upstream version may fail without invalidating the reviewed release.
It becomes blocking only after the support contract is intentionally advanced.

## Provider and network boundary

Provider success does not imply page-fetch success, source freshness, source completeness, or
claim entailment. The full-page reader has a separate bounded HTTPS and redirect contract.
Changes to DNS validation, redirect states, media types, charset handling, byte/time limits,
or cross-origin exceptions are compatibility and security changes even when the TypeScript API
is unchanged.

## Deprecation and migration

A reviewed capability receives a documented migration path before removal. Experimental
capabilities may be removed without a shim, but the changelog must identify:

- the last commit or version containing the capability;
- why the removal condition was met;
- retained data or output compatibility, if any;
- the replacement or the reason no replacement is offered.
