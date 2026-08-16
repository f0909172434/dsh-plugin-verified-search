# Frozen offline evaluation corpus

The offline corpus is a deterministic regression and capability contract for bounded logic
that does not require a model, provider credential, browser, DNS lookup, or network request.
It exists so a single maintainer can compare behavior over time without depending on mutable
web pages or live provider output.

## Scope

Corpus `verified-search-offline-v1` contains 42 cases:

| Capability | Cases | Covered behavior |
| --- | ---: | --- |
| Domain filtering | 11 | normalization, deduplication, exact/subdomain matching, lookalikes, credentials, invalid host filters |
| Date selection | 10 | ISO cutoffs, RFC 3339 dates, ties, strict filters, escaped pointers, duplicate keys, invalid dates |
| Exact numeric selection | 10 | values beyond IEEE-754 precision, equivalent lexeme ties, signed zero, negative minima, large exponents, filters and type errors |
| Projection | 11 | source order, strict filters, nested rows, ASCII-case repair, root-array fallback, pointer escaping and repair failures |

All cases are hand-reviewed, finite, bounded, and committed as ordinary JSON. They exercise
public pure functions rather than model-facing prompt behavior.

## Run

Build the repository and execute:

```bash
pnpm run build
pnpm run evaluate:offline
```

The command writes:

```text
work/offline-evaluation.json
```

and exits nonzero when:

- a suite file is missing or its SHA-256 differs from the manifest;
- a suite or case violates the registered contract;
- an expected error code changes;
- a JSON-pointer assertion changes;
- a capability unexpectedly throws or unexpectedly succeeds;
- a duplicate case ID or capability suite appears.

No network API is called by this command.

## Integrity model

`evaluation/manifest.json` binds each suite by:

```text
capability
suite ID
relative file name
SHA-256 of exact file bytes
case count
```

The product-level `capabilities.json` separately binds the corpus ID, manifest path, total
case count, per-capability case counts, and the fact that network access is not required.
Tests compare those declarations so the product contract cannot drift independently from the
corpus.

Expected outputs use focused RFC 6901 assertions rather than whole-result snapshots. This
keeps incidental formatting out of the contract while freezing load-bearing fields such as:

- evidence SHA-256;
- selected source indexes and source order;
- tie count and exact winning date or number lexeme;
- pointer repair audit;
- rows scanned and eligible;
- stable error code.

Every observed result also receives a deterministic digest in the generated report.

## Change discipline

A corpus change is a product-contract change. A pull request that changes a suite must:

1. explain the real behavior or defect represented by the new case;
2. update the exact suite hash in the manifest;
3. update counts in the manifest and `capabilities.json` when cases are added or removed;
4. preserve old negative cases unless their contract was intentionally retired;
5. identify whether the change fixes code, corrects a wrong expectation, or expands coverage;
6. include a rollback or migration note when an established expected result changes.

Do not regenerate expectations from current implementation output without reviewing the
semantic reason for every changed assertion.

## What passing means

Passing means the current implementation agrees with the 42 registered offline cases and
that the exact corpus bytes match their manifest. It does not establish:

- live provider availability or behavior;
- web-page freshness or factual truth;
- general browser compatibility;
- language-model answer quality;
- `verified_research` evidence-coverage improvement;
- absence of unregistered edge cases;
- stable status for any experimental capability.

The corpus is an engineering regression boundary, not a benchmark score or external
validation result.

## Planned extension

Property-based and differential tests complement this corpus by generating many bounded
inputs from fixed seeds. Counterexamples found there are promoted into this corpus only when
they represent a durable product contract or a regression that should never recur.
