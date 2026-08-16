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
- An initial 222-test HonestCI baseline derived from completed default-branch run
  `31931938350`, with its source commit, artifact digest, and report hashes recorded in the
  dogfood contract.
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
- A revised 237-test HonestCI baseline derived from completed default-branch run
  `31934602305`, after the offline corpus and property suites were merged.
- Machine-readable five-layer source architecture, package-bound schema, and CI guard for
  complete source classification, resolved imports, dependency direction, Harness isolation,
  and relative-import cycles.
- A default 20,000-byte production-module budget plus explicit growth stops with lower
  targets, next extraction steps, and removal conditions for existing architecture debt.
- A revised 242-test HonestCI baseline derived from completed default-branch run
  `31936017824` after the architecture guard added five durable contract tests.
- Shared engine-layer strict-JSON primitives for UTF-8 and Unicode checks, duplicate-key and
  depth scanning, bounded RFC 6901 parsing, and Gregorian/UTC date normalization.
- Direct behavior tests for the shared primitive failure boundary, pointer decoding, date
  validation, strict parsing, UTF-8 decoding, and caller-provided limits.
- A revised 246-test HonestCI baseline derived from completed default-branch run
  `31938769457` after the strict-JSON primitive extraction added four durable behavior tests.
- A bounded `json-lossless-number.ts` engine for exact source-token retention, arbitrary
  decimal-exponent normalization, and comparison without IEEE-754 collapse.
- Direct tests for lossless lexeme retention, exact comparison, shared strict-JSON failures,
  caller-provided number limits, and pre-materialization depth bounds.
- A revised 250-test HonestCI baseline derived from completed default-branch run
  `31941012664` after the lossless-number extraction added four durable behavior tests.

### Changed

- Repository documentation now treats `main` as an unreleased experiment rather than an
  implied successor release.
- GitHub Actions are commit-pinned, checkout credentials are not persisted, stale runs are
  cancelled, and package-only checks run once instead of on every compatibility entry.
- Local JUnit, evaluation reports, and transient HonestCI evidence outputs are ignored while
  reviewed baselines and corpus files remain committed.
- The initial HonestCI baseline was activated by default-branch run `31932149983`, which
  observed 222 tests against 222 with zero drop and no findings.
- The 237-test baseline was activated by default-branch run `31934852209`, which observed 237
  tests against 237 with zero failures, errors, skipped tests, test-count drop, or findings
  across Ubuntu and Windows on Node 22.19 and 24.
- The 242-test baseline was activated by default-branch run `31936229233`, which observed 242
  tests against 242 with zero failures, errors, skipped tests, test-count drop, or findings
  across Ubuntu and Windows on Node 22.19 and 24.
- The 246-test baseline is active: default-branch run `31939485242` observed 246 tests against
  246 with zero failures, errors, skipped tests, test-count drop, or findings across Ubuntu
  and Windows on Node 22.19 and 24.
- The same activation run reproduced all 42 offline cases with result digest
  `sha256:3002001da02d0b8501bcc97ee867109f1bfbf0e1a227d87845db81da658ea5c0`.
- The 250-test baseline is active: default-branch run `31941559670` observed 250 tests
  against 250 with zero failures, errors, skipped tests, test-count drop, or findings across
  Ubuntu and Windows on Node 22.19 and 24.
- The same 250-test activation run reproduced all 42 offline cases with result digest
  `sha256:3002001da02d0b8501bcc97ee867109f1bfbf0e1a227d87845db81da658ea5c0`.
- `capabilities.json` now binds the offline corpus ID, manifest path, total case count,
  per-capability counts, offline execution boundary, and source architecture contract.
- Property failures now include a replayable hexadecimal seed and iteration number; generator
  seeds and bounds are documented rather than taken from wall-clock entropy.
- New production files must be assigned to one architecture layer, and existing oversized
  modules may shrink but may not cross their recorded ceilings before decomposition.
- `json-selection.ts` now delegates shared parsing and date rules through a caller-specific
  error adapter. Its public result shape and `JSON_SELECTION_*` vocabulary remain unchanged.
- `json-numeric-selection.ts` now delegates shared input, pointer, date, and strict-JSON rules,
  plus exact number parsing and comparison, through a caller-specific error adapter. Its
  public result shape and `JSON_NUMERIC_SELECTION_*` vocabulary remain unchanged.
- The date selector, numeric selector, and their two primitive modules all fit the 20,000-byte
  default budget. The numeric selector shrank from 29,228 to 19,516 bytes, its new lossless
  engine is 5,201 bytes, and five growth stops remain.
- `json-projection.ts` now delegates bounded input decoding, Unicode validation, duplicate-key
  scanning, depth enforcement, and strict materialization through a projection-owned error
  adapter. It shrank from 31,362 to 26,624 bytes while retaining repair audits, source order,
  nested projection, output budgets, and the complete `JSON_PROJECTION_*` vocabulary.
- Architecture work now follows a serial one-active-PR workflow from the latest CI-green
  `main`; self-merging refactor workflows and committed one-off extraction machinery are
  prohibited, and HonestCI baselines advance only at durable milestones.
- The maintenance contract now makes external reviewers, contributors, and adoption optional
  signals rather than development gates, while forbidding unsupported independent-validation
  claims.

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
- Passing repository tests, properties, the offline corpus, or the architecture guard does not
  constitute a live provider or clean Harness installation result.
- Five production modules remain above the default size budget and are tracked as temporary
  architecture debt rather than described as complete modularization.

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
