# Serial engineering roadmap

This roadmap is the recovery point for architecture work on the unreleased experiment line.
It records one active ownership boundary at a time. The machine-readable behavior, lifecycle,
and architecture contracts remain `capabilities.json` and `architecture.json`.

## Verified starting point

The queue-cleanup phase started from the following green `main` baseline:

- commit: `bac38e2c587058579bc7b39dee21c30e26caf817`;
- normal GitHub Actions CI: successful;
- HonestCI baseline: 250 tests, 0 failures, 0 errors, 0 skipped;
- frozen offline corpus: 42 cases;
- registered offline result digest:
  `sha256:3002001da02d0b8501bcc97ee867109f1bfbf0e1a227d87845db81da658ea5c0`;
- maintainer model: `single_maintainer`;
- external independent validation: absent.

The absence of an external reviewer does not block bounded engineering work. Internal tests,
CI, deterministic corpora, hashes, and reproducible artifacts must not be described as
external validation.

## Queue cleanup

The previous open queue was not a safe merge chain. PRs #23 through #30 were opened in
parallel from the same old `main` commit and contained branch-only extractors, finalizers, and
write-enabled self-merging workflows rather than final production changes.

| Pull requests | Disposition | Preserved result |
| --- | --- | --- |
| #20, #21, #31, #32 | Close as superseded by the 250-test baseline on `main` | milestone-based HonestCI policy in `MAINTENANCE.md` |
| #22 | Close as superseded by the merged shared lossless-number engine | numeric selector ownership already present on `main` |
| #23–#30 | Close without merging operational scaffolding | ownership boundaries and acceptance conditions below |

Closed branches are reset to the verified `main` baseline when deletion is not available
through the maintenance interface. No extractor, finalizer, staging payload, or self-merging
workflow is promoted to `main`.

## Work-in-progress rule

- At most one architecture refactor pull request is active.
- Every architecture branch starts from the latest squash-merged, CI-green `main`.
- The active pull request directly changes production source and the minimum supporting tests,
  metadata, documentation, and generated `lib/` artifacts.
- The next branch is not created until the previous merge is green on `main`.
- Public contracts, stable error codes, source ordering, budgets, frozen corpus results, and
  the registered digest remain unchanged unless a separate product change is explicitly
  approved.

## Serial queue

| Order | Ownership boundary | Status | Completion condition |
| ---: | --- | --- | --- |
| 0 | PR queue and maintenance contract | **active** | no stale/duplicate open PR; no write-enabled one-off refactor workflow; roadmap and maintenance rules merged; `main` CI green |
| 1 | strict parsing adapter for `json-projection.ts` | **next** | projection delegates bounded decoding, Unicode, duplicate-key, depth, and strict materialization to `json-primitives.ts`; projection errors and behavior remain compatible; `json-projection.ts` is about 25,000 bytes or less |
| 2 | repair-aware JSON projection core | queued | repair traversal, repair selection/audits, nested source-order projection, and construction budgeting have one coherent engine owner; all new/existing modules are at most 20,000 bytes; projection exception removed; exception count 5 → 4 |
| 3 | research request normalization | queued | `research-request.ts` owns schema-facing validation and claim/lane/domain/date normalization without provider, network, execution, aggregation, presentation, or Harness lifecycle work |
| 4 | research lane execution | queued | `research-lane.ts` owns bounded provider/search/fetch execution, lane-local limits, timeout, abort, materialization, and cleanup without cross-lane aggregation or final presentation |
| 5 | research aggregation and presentation | queued | coherent aggregation/presentation owners reduce every research module to at most 20,000 bytes and remove the `research.ts` exception without changing schemas, concurrency, limits, errors, or output format |
| 6 | evidence normalization | queued | `evidence-normalization.ts` owns HTML entity decoding, inert text scanning, whitespace normalization, and byte-stable normalized text; hashes and retained excerpt bytes remain unchanged |
| 7 | evidence attribution | queued | `evidence-attribution.ts` owns claim attribution, source ordering, and retained excerpt construction; every evidence module is at most 20,000 bytes and the exception is removed |
| 8 | public-address policy | queued | `page-fetch-policy.ts` owns literal/resolved address classification and public-address checks without creating a second transport or weakening DNS-rebinding protection |
| 9 | network transport state, only if still required | queued | extracted only when a coherent transport owner is necessary to bring `page-fetch.ts` below 20,000 bytes; otherwise the existing exception is removed directly |
| 10 | offline evaluation manifest and integrity | queued | manifest/suite parsing, immutable case loading, path safety, hashes, and corpus integrity are isolated; CLI/report schema, 42 cases, expected outputs, and registered digest remain unchanged |
| 11 | release hardening | queued | zero architecture exceptions unless an evidence-backed ADR remains; clean cross-platform install/build/package; reproducible `lib/`; fixed corpus and properties green; representative live conformance; beta artifact, checksums, rollback, and limitations documented |

## Active architecture task after queue cleanup

The only next production task is **strict parsing adapter for `json-projection.ts`**.

Move these responsibilities to the existing shared primitives through a caller-owned failure
adapter:

- bounded UTF-8 input decoding;
- unpaired Unicode surrogate detection;
- duplicate-key scanning;
- maximum JSON depth enforcement;
- strict JSON validation and materialization.

Retain in the projection engine for this first production PR:

- repair-aware pointer semantics and audit records;
- pointer-not-found versus type-mismatch errors;
- root-array fallback;
- source order and nested projection;
- scalar and aggregate construction budgets;
- request/result schemas, package exports, and every `JSON_PROJECTION_*` error code.

This first production PR does not remove the size exception by force. It prepares a separately
reviewable second extraction and must not introduce a wrapper with no ownership.

## Validation for every production PR

Run the repository's normal checks on the supported matrix and preserve generated artifacts:

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
pnpm test
pnpm run build
pnpm run evaluate:offline
npm pack --dry-run --ignore-scripts --json
git diff --check
```

Build twice; the second build must produce no new `lib/` diff. Run focused tests and fixed-seed
properties for the affected boundary. If the frozen offline digest changes, do not update the
expected digest: stop and locate the unintended semantic difference.

## Release target

The next candidate is `v0.3.0-beta.1`, not a stable release. It requires a reproducible package,
clean supported-runtime matrix, Harness lifecycle conformance, representative live provider
conformance, exact checksums, rollback instructions, and an honest limitations statement.

A later `v0.3.0` may be prepared only after unresolved P0/P1 work is zero and all stated release
conditions hold. External independent validation may remain absent and must be reported as
absent.

## Final definition of done

- zero stale or duplicate open pull requests;
- one active architecture pull request at a time;
- zero self-merging operational workflows;
- zero committed one-off refactor machinery;
- zero architecture size exceptions, unless a small ADR demonstrates that safe ownership
  boundaries cannot remove a specific exception;
- bounded, stable public input/output/error contracts;
- cross-platform CI, reproducible `lib/` and package artifacts;
- frozen deterministic evaluation and fixed-seed properties;
- real end-to-end conformance evidence;
- release artifact, checksums, rollback, quickstart, and explicit validation boundaries.
