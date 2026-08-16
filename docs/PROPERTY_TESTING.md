# Deterministic property and differential testing

The property suite expands the finite offline corpus with many generated but reproducible
inputs. It uses no model, provider, browser, DNS lookup, network request, wall-clock seed, or
third-party fuzzing service.

## Registered suites

| Property | Seed | Iterations | Independent expectation |
| --- | --- | ---: | --- |
| Domain normalization and suffix-safe matching | `0x8af133d1` | 1,000 | idempotence and exact/subdomain relation |
| Domain filter source order | `0xe121c950` | 750 | independently filtered source indexes |
| Evidence URL canonicalization | `0x5b2d7a44` | 750 | retained ordinary query plus removed sensitive/tracking fields |
| Public-address policy | `0x26379b0d` | 1,000 | generated private/reserved IPv4 families |
| Redirect state machine | `0xc89e11a7` | 100 | generated same-origin chains and cross-origin rejection |
| RFC 6901 projection round trip | `0xa6d428f3` | 750 | independently encoded pointer segments and scalar map |
| Projection source order | `0x07cf8d61` | 750 | independent stable filter over generated rows |
| Date selection differential | `0xf8134ac2` | 1,000 | independent cutoff, maximum-day, and tie computation |
| Exact numeric differential | `0x94b7d302` | 1,250 | independent decimal-significand/exponent comparator |

Total registered iterations: **7,350**.

The redirect suite performs both a successful same-origin fetch and a rejected cross-origin
fetch per iteration through an in-memory transport.

## Generator

`tests/property-support.ts` implements a small xorshift32 generator. A zero seed is replaced
with a fixed nonzero state. Every property failure includes:

```text
property name
seed in hexadecimal
iteration number
underlying assertion or exception
```

The generator algorithm, seeds, iteration counts, and test code are version-controlled. A
failure therefore replays locally by running the ordinary test suite at the failing commit.
No random seed is taken from time, process ID, operating-system entropy, or CI metadata.

## Differential references

### Dates

Generated source rows use valid UTC calendar days or RFC 3339 timestamps. The reference path:

1. applies the generated boolean filter;
2. compares the first ten calendar-day characters with the generated cutoff;
3. finds the lexicographic maximum ISO day;
4. retains all source-order ties.

The reference does not call the production date-selection function.

### Exact JSON numbers

The reference parser independently decomposes each generated JSON number into:

```text
sign
significand digits
base-10 power
```

It removes insignificant leading and trailing zeroes, treats every signed zero as equal, and
compares decimal magnitude by digit length, power, and right-padded significand text. It does
not use JavaScript `Number`, `parseFloat`, or the production exact-number comparator.

Generated forms include:

- signed zero;
- plain coefficient with exponent;
- scientific notation;
- decimal coefficient with exponent;
- equivalent forms with inserted trailing zeroes;
- positive and negative powers from -300 through 300;
- significands up to 18 digits.

The selected source indexes, source order, tie count, IDs, and first winning source lexeme must
agree with the independent reference.

## Boundedness

The suite is intentionally bounded:

- generated row arrays are at most 40 rows;
- numeric arrays are at most 18 rows;
- redirect chains are at most five URLs;
- all transports are in-memory;
- all generated strings use bounded ASCII alphabets;
- no property retries indefinitely or searches for a passing seed.

This keeps the ordinary cross-platform CI deterministic and prevents fuzzing from becoming a
separate unmaintainable system.

## Counterexample promotion

A generated failure is promoted into `verified-search-offline-v1` only when it represents:

- a security boundary that must never regress;
- a stable public behavior or error code;
- a previously missed equivalence class;
- a real bug whose exact minimal form is useful to future maintainers.

Promotion requires minimizing the input, adding a named finite case, updating suite hashes and
counts, and recording the root cause. Passing generated examples are not bulk-copied into the
corpus.

## Change discipline

Changing a seed, iteration count, generator, or independent reference is a test-contract
change. The pull request must state whether it:

- expands input coverage;
- corrects a reference defect;
- reduces runtime for a measured reason;
- changes a product invariant.

Iteration reductions are not hidden inside unrelated refactors. Generator output is not a
product benchmark score.

## What passing means

Passing provides stronger evidence that the deterministic primitives obey the registered
invariants across the generated space and supported runtimes. It does not prove:

- exhaustive correctness;
- live network or provider behavior;
- factual truth or source freshness;
- language-model consistency;
- absence of adversarial inputs outside the generators;
- stable status for experimental tools.
