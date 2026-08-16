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

## Stage 2 — baseline freeze

The committed `.honest-ci/baseline.json` is derived only from a completed post-merge `main`
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

The baseline records 222 tests. The initial `max_drop_percent: 10` tolerance is intentionally
coarse enough to permit small reviewed test reorganizations while blocking a loss of roughly
one tenth of the suite. Any intentional reduction must update the baseline in a separate PR
whose rationale identifies removed behavior and the source default-branch evidence.

The baseline PR itself could not lower its own trusted comparison: on pull requests, HonestCI
read the baseline from the base commit through the GitHub API.

## Stage 3 — activation confirmation

The first `main` run containing the committed baseline completed successfully on every
supported CI entry and produced the following independent activation evidence:

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

This closes the rollout loop: the baseline was derived from an earlier completed default-
branch run, committed separately, and then exercised by a later default-branch run. Future
pull requests now compare against the committed 222-test baseline instead of merely checking
for a nonempty report.

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
