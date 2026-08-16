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
- no more than a 10% drop after a trusted baseline exists.

The first merged default-branch run intentionally has no committed baseline. HonestCI must
report `HCI101_BASELINE_MISSING` as a warning rather than inventing a comparison. The run
uploads both the evidence bundle and JUnit report for 30 days.

## Stage 2 — baseline freeze

A baseline is committed only after a successful `main` run has produced observable evidence.
The baseline pull request must record:

- the source `main` commit;
- the workflow run ID;
- the exact HonestCI commit;
- the observed report name and test count;
- the JUnit and evidence-bundle artifact identity;
- why the configured drop threshold is appropriate.

A pull request may not derive a lower baseline from its own modified test suite. HonestCI reads
the baseline from the pull-request base commit through the GitHub API.

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
