# Changelog

This project separates reviewed releases from unreleased experiments. Dates use UTC.

## Unreleased

### Added

- Machine-readable capability and lifecycle contract.
- Single-maintainer maintenance, pause, removal, and retirement rules.
- Explicit compatibility evidence levels for source, Harness integration, and live provider
  conformance.
- HonestCI `v1.0.4` dogfood gate on the primary test job, with retained JUnit and evidence
  artifacts.
- A 222-test HonestCI baseline derived from completed default-branch run `31931938350`, with
  its source commit, artifact digest, and report hashes recorded in the dogfood contract.
- Frozen `verified-search-offline-v1` evaluation corpus with 42 hash-bound positive and
  negative cases for domain filtering, date selection, exact-number selection, and strict
  projection.
- Deterministic offline evaluation CLI and machine-readable report with no model, provider,
  browser, DNS, or network dependency.
- Nine fixed-seed property and differential suites covering 7,350 generated iterations for
  domains, evidence URLs, private-address blocking, redirects, JSON pointers, source order,
  date selection, and exact decimal extrema.
- Independent date and decimal reference implementations that do not call the corresponding
  production selectors.

### Changed

- Repository documentation now treats `main` as an unreleased experiment rather than an
  implied successor release.
- GitHub Actions are commit-pinned, checkout credentials are not persisted, stale runs are
  cancelled, and package-only checks run once instead of on every compatibility entry.
- Local JUnit, evaluation reports, and transient HonestCI evidence outputs are ignored while
  reviewed baselines and corpus files remain committed.
- The HonestCI baseline is active: default-branch run `31932149983` observed 222 tests against
  a 222-test baseline with zero drop, no failures/errors/skips, and no findings across a fully
  successful Ubuntu/Windows compatibility run.
- `capabilities.json` now binds the offline corpus ID, manifest path, total case count,
  per-capability counts, and offline execution boundary.
- Property failures now include a replayable hexadecimal seed and iteration number; generator
  seeds and bounds are documented rather than taken from wall-clock entropy.

## 0.3.0-experiment.0 — unreleased experiment

This version identifier describes the current `main` experiment. It is not an immutable
release and must be installed by an exact commit when evaluated.

### Added

- `verified_research` bounded multi-lane, claim-attributed full-page evidence workflow.
- `verified_json_selection` deterministic latest/as-of date selection.
- `verified_json_numeric_extrema` exact JSON-number maximum/minimum selection.
- `verified_json_projection` strict source-order row projection.
- Same-turn convergence policy after structured selection and bounded research.
- DNS-pinned, public-address-only HTTPS page reader with bounded redirect, media type,
  charset, byte, and time behavior.

### Known limits

- No stable compatibility promise exists for the experimental tools.
- The offline corpus and generated properties cover deterministic bounded primitives; only
  two larger live official-source tasks have been recorded, so broad retrieval-quality claims
  remain unsupported.
- Passing repository tests, properties, or the offline corpus does not constitute a live
  provider or clean Harness installation result.

## 0.1.1 — 2026-08-14

Reviewed release tag: `v0.1.1`.

### Added

- `verified_search(query, allowed_domains?)` for bounded current-source lookup.
- Durable time context and credential-free provider-request recording.
- Local exact-host/subdomain post-filter over returned structured sources.
- Credential and sensitive/tracking query removal before source URLs enter results or logs.
- Explicit unresolved result when no usable excerpt remains.

### Fixed

- Nullable provider metadata and server-tool error handling.
- Provider behavior that ignored the native domain allowlist.

### Verification

- Ubuntu and Windows on Node `22.19` and `24`.
- Reproducible committed build artifacts and package dry-run.
- Clean DeepSeek Harness `0.1.0-rc.6` installation.
- Live provider conformance observation recorded in the GitHub release.

## 0.1.0 — 2026-08-14

Superseded prerelease. Do not use; migrate to `v0.1.1`.
