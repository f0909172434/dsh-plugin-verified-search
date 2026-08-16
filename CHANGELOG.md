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

### Changed

- Repository documentation now treats `main` as an unreleased experiment rather than an
  implied successor release.
- GitHub Actions are commit-pinned, checkout credentials are not persisted, stale runs are
  cancelled, and package-only checks run once instead of on every compatibility entry.
- Local JUnit and transient HonestCI evidence outputs are ignored while the reviewed baseline
  remains committed.
- The HonestCI baseline is active: default-branch run `31932149983` observed 222 tests against
  a 222-test baseline with zero drop, no failures/errors/skips, and no findings across a fully
  successful Ubuntu/Windows compatibility run.

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
- The current evaluation contains two large official-source tasks, not a broad frozen corpus.
- Passing repository tests does not constitute a live provider or clean Harness installation
  result.

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
