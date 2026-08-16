# HonestCI dogfood rollout

This repository uses HonestCI as an internal consumer rather than presenting the integration
as external adoption. The purpose is to make the primary green test job depend on fresh,
parseable JUnit evidence and to preserve a machine-readable evidence bundle for later audit.

## Stage 1 — observable rollout

The primary Ubuntu / Node 22.19 job is wrapped by HonestCI `v1.0.4`, pinned to commit:

```text
4ee4e30b283c219ff42e75606e692f34c91ba826
```

It executes Vitest directly through pnpm so reporter flags cannot be swallowed by a script
argument delimiter:

```bash
pnpm exec vitest run \
  --reporter=default \
  --reporter=junit \
  --outputFile.junit=reports/junit.xml
```

The gate requires:

- the command to exit successfully;
- a fresh and parseable `reports/junit.xml`;
- at least one test;
- zero reported failures and errors;
- no skipped-ratio limit, because the current suite does not define one;
- no more than a 10% drop from the trusted baseline.

The rollout initially had no baseline. HonestCI reported `HCI101_BASELINE_MISSING` as a
warning while continuing to enforce freshness, nonzero test count, and failure/error checks.

## Stage 2 — initial baseline freeze

The initial `.honest-ci/baseline.json` was derived only from a completed post-merge `main`
run:

| Field | Bound value |
| --- | --- |
| Source commit | `d329bc2e3e046d7711aa08e3f8983b56fdd3c809` |
| Workflow run | `31931938350` |
| Event/ref | `push` / `refs/heads/main` |
| HonestCI | `1.0.4` at `4ee4e30b283c219ff42e75606e692f34c91ba826` |
| Report | `unit` / `reports/junit.xml` |
| Observed totals | 222 tests, 0 failures, 0 errors, 0 skipped |
| GitHub artifact ID | `9259548102` |
| GitHub artifact digest | `sha256:0a62cf06316fe67bb73f64840ed0e72bd2801539e27fead17f8d23973aab76de` |
| JUnit SHA-256 | `a3e8107caabf3b9b690b8595e74372931f91f09b12dd4cb833405aec946b3ecc` |
| Evidence JSON SHA-256 | `8e982e7b80fa3b2a9d0d9aad8810509f38eeb1d930c787944853dc170cc9e2b2` |
| Evidence creation time | `2026-08-16T06:39:50.594Z` |

The initial baseline recorded 222 tests. The `max_drop_percent: 10` tolerance is intentionally
coarse enough to permit small reviewed test reorganizations while blocking a loss of roughly
one tenth of the suite. Any intentional reduction must update the baseline in a separate PR
whose rationale identifies removed behavior and the source default-branch evidence.

## Stage 3 — initial activation confirmation

The first `main` run containing the initial baseline completed successfully on every supported
CI entry:

| Field | Activated value |
| --- | --- |
| Activated commit | `f21009100b8d0f1de94dc4e934cbf1d66009dc96` |
| Workflow run | `31932149983` |
| Quality environment | Ubuntu / Node `22.19.0` |
| Compatibility environments | Ubuntu / Node 24; Windows / Node 22.19 and 24 |
| Result status | `passed` |
| Observed totals | 222 tests, 0 failures, 0 errors, 0 skipped |
| Trusted baseline | 222 tests |
| Observed drop | 0% |
| Findings | none |
| GitHub artifact ID | `9259604206` |
| GitHub artifact digest | `sha256:faf1b3c5892cfa0b81d74122c61675c82953530472f3dcb648e8401322b23c49` |
| JUnit SHA-256 | `48ad12ea2618fbfa7ee910e0bf00d66f60a36082569449752df298f0ab9eeca6` |
| Evidence JSON SHA-256 | `e1087b088b63447313566a2291a8c2e8e8052b97436ae7b2e37a4388f39d726c` |
| Baseline artifact SHA-256 | `f5a30e46ad1ed3f27e61d620e2b532b205d1ca220888b13803fe3e1db8fb74d6` |
| Evidence creation time | `2026-08-16T06:45:07.196Z` |

## Stage 4 — baseline revision after corpus and property testing

The frozen offline corpus and fixed-seed property suites increased the durable test contract
from 222 to 237 tests. The revised baseline is derived from the first completed `main` run
containing both increments:

| Field | Revised value |
| --- | --- |
| Source commit | `c059362f45ccf21359be6d3e360a0fb6a0266323` |
| Workflow run | `31934602305` |
| Event/ref | `push` / `refs/heads/main` |
| Quality environment | Ubuntu / Node `22.19.0` |
| Compatibility environments | Ubuntu / Node 24; Windows / Node 22.19 and 24 |
| HonestCI | `1.0.4` at `4ee4e30b283c219ff42e75606e692f34c91ba826` |
| Observed totals | 237 tests, 0 failures, 0 errors, 0 skipped |
| Previous trusted baseline | 222 tests |
| Findings | none |
| GitHub artifact ID | `9260272616` |
| GitHub artifact digest | `sha256:18e8925e127ca190581a525168840bf3507908f913b5af0a270fed1df65b60ab` |
| JUnit SHA-256 | `c9d8105988c061dafdc7a40d7116ea77214111646b69f8ee64efe5290ebb4b67` |
| Evidence JSON SHA-256 | `92fdbeb9d8950de94ccae04df8c4863f400fa9b00b76667fcf48e284f279bd0a` |
| Revised baseline SHA-256 | `8057178b42a56ac9ac51a9e95146df0a4730e63933966717deecc9b710b63faa` |
| Evidence creation time | `2026-08-16T07:43:33.691Z` |

The baseline revision PR cannot use its own 237-test file to weaken the comparison. On pull
requests, HonestCI reads `.honest-ci/baseline.json` from the base commit, so this revision is
still evaluated against 222. A later default-branch run must activate and independently
confirm the 237-test baseline before the revision loop is considered closed.

## Why only the primary job is wrapped

The full test suite still runs directly on Ubuntu / Node 24 and both supported Windows lines.
Wrapping all matrix entries would duplicate the same test-count baseline and create several
evidence bundles without adding a distinct compatibility signal. Runtime-specific failures
remain blocking through the ordinary compatibility jobs.

## Evidence boundary

A passing HonestCI result establishes that the configured command produced fresh JUnit with
the observed counts and no configured threshold violation. It does not establish that every
assertion is meaningful, that the suite covers all security properties, or that an external
maintainer adopted either project.

## Incident log

### 2026-08-16 — `HCI001_MISSING_REPORT`

- **Run:** pull-request workflow `31931757500`, first HonestCI integration attempt.
- **Observed:** Vitest completed 222 tests successfully, but no `reports/junit.xml` existed;
  HonestCI blocked the primary job and retained a failed evidence bundle.
- **Root cause:** `pnpm test -- --reporter=...` expanded to
  `vitest run -- --reporter=...`. The literal `--` terminated Vitest option parsing, so the
  JUnit reporter flags were treated as positional arguments and ignored.
- **Resolution:** invoke `pnpm exec vitest run` with reporter flags directly.
- **Product impact:** no verified-search source defect was found. The integration command was
  defective, and HonestCI correctly prevented a false evidence claim.

Only real findings are recorded. Future entries must include the date, finding code, root
cause, resolution, and whether the product or this integration required a change. Do not
create synthetic success stories.
