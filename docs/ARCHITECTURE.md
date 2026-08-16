# Enforceable source architecture

The source tree is intentionally kept in one package, but it is no longer treated as one
undifferentiated module graph. [`architecture.json`](../architecture.json) is the
machine-readable source of truth for dependency direction, source-file ownership, and
temporary module-size debt.

The contract is designed for a single maintainer: a new file cannot silently enter the
package, a lower layer cannot start depending on Harness lifecycle code, and an already-large
module cannot keep growing under the justification that it will be split later.

## Layer model

```text
foundation
    │
    ▼
engine ─────────► cli
    │
    ▼
harness
    │
    ▼
composition
```

The arrows show the usual direction of dependency. The exact allowed edges are recorded per
layer in `architecture.json` and checked from TypeScript import declarations.

### Foundation

```text
src/domains.ts
src/types.ts
```

This layer contains value contracts and hostname policy. It may not depend on provider,
network, evidence, orchestration, CLI, or Harness modules.

### Engine

```text
src/provider.ts
src/page-fetch.ts
src/evidence.ts
src/json-primitives.ts
src/json-lossless-number.ts
src/json-selection.ts
src/json-numeric-selection.ts
src/json-projection.ts
src/offline-evaluation.ts
```

These modules implement bounded deterministic behavior and network/provider boundaries. They
may depend on foundation and other engine modules, but may not import DeepSeek Harness or
Cordis lifecycle packages.

`json-primitives.ts` owns the bounded strict-JSON scanner, UTF-8 and Unicode input checks,
RFC 6901 pointer parsing, and Gregorian/UTC date normalization. Callers provide the failure
adapter, so the shared implementation does not replace each public tool's stable error-code
vocabulary. `json-lossless-number.ts` builds on that boundary to preserve exact JSON number
lexemes, normalize arbitrary decimal exponents, and compare values without IEEE-754 collapse.
The date and numeric selectors are migrated consumers; strict projection remains the next
JSON-engine extraction.

`provider.ts` belongs here because it owns the provider wire contract and sanitization rather
than plugin registration. `page-fetch.ts` may call that sanitization, but neither module may
know about an agent, session, system prompt, or tool registry.

### Harness adapters

```text
src/tool.ts
src/research.ts
src/json-tool.ts
src/json-numeric-tool.ts
src/json-projection-tool.ts
```

This layer owns model-facing schemas, presentation, prompt policy, tool execution, research
orchestration, and lifecycle cleanup. It may use foundation and engine code. Harness-specific
imports are confined to this layer and the composition root.

### CLI

```text
src/evaluate-offline-cli.ts
```

The CLI may call bounded engines but may not import Harness adapters. This preserves an
offline path that does not require a live Harness composition.

### Composition root

```text
src/index.ts
```

The composition root exports public contracts and installs the plugin into a live Harness
scope. It is the only source file permitted to assemble all layers.

## Enforced invariants

`tests/architecture.spec.ts` enforces all of the following on every CI platform:

- every production TypeScript file under `src/` appears in exactly one layer;
- every relative import resolves to a classified production source file;
- import edges follow the layer allowlist;
- no relative-import cycle exists;
- `@deepseek-ai/cordis` and `@deepseek-ai/dsh-*` imports occur only in the Harness or
  composition layers;
- every production module remains within the default 20,000-byte budget unless it has a
  documented temporary exception;
- an exception becomes invalid once the module is small enough to use the default budget;
- every exception has a lower target, a next extraction, and a removal condition.

The test parses TypeScript syntax rather than relying on line-oriented regular expressions, so
type-only imports, re-exports, side-effect imports, and dynamic string-literal imports are
included in the graph.

## Current architecture debt

The size ceilings are **growth stops**, not claims that the present modules are well-sized.
The remaining baseline measurements were recorded at main commit
`e35c00cb530662175135eafdbbcc0adbf5b80bfb`.

| Module | Baseline bytes | Ceiling | Target | Next extraction |
| --- | ---: | ---: | ---: | --- |
| `research.ts` | 66,102 | 67,000 | 20,000 | request normalization, then lane execution |
| `evidence.ts` | 43,903 | 45,000 | 20,000 | HTML/text normalization |
| `json-projection.ts` | 31,362 | 32,000 | 20,000 | adopt shared parsing, then repair-aware resolution |
| `offline-evaluation.ts` | 24,859 | 26,000 | 20,000 | corpus parsing/integrity |
| `page-fetch.ts` | 24,821 | 26,000 | 20,000 | address policy and transport state |

The first extraction reduced `json-selection.ts` from its 24,306-byte baseline to 17,755
bytes and moved 9,468 bytes of reusable parsing policy into `json-primitives.ts`. The second
reduced `json-numeric-selection.ts` from its 29,228-byte baseline to 19,516 bytes and moved
5,201 bytes of exact-number parsing and comparison into `json-lossless-number.ts`. All four
modules now satisfy the default budget, so both selector exceptions have been removed. A
feature PR may not increase any remaining ceiling. If necessary work would cross a ceiling,
the required extraction is part of that PR or precedes it in a separate PR.

## Decomposition order

The staged order is chosen to reduce duplicated correctness logic before moving orchestration:

1. **Shared strict JSON primitives — in progress.** The bounded scanner, input decoding,
   RFC 6901 parsing, ISO-date normalization, exact number-token capture, and decimal comparison
   now live in bounded engine modules. Date and numeric selection use them without changing
   public errors. Migrate strict projection next while retaining pointer-repair semantics.
2. **Research request normalization.** Move input validation and normalized claim/lane types
   out of `research.ts` without changing tool schemas or network behavior.
3. **Research lane execution.** Separate bounded search/fetch work from aggregation and
   presentation; preserve concurrency, source limits, and finalization policy.
4. **Evidence normalization.** Split HTML/text normalization from claim attribution and
   excerpt construction; keep content hashes and retained excerpts byte-stable.
5. **Network policy and transport.** Isolate public-address classification from HTTPS state
   handling only after the existing transport and property tests can exercise both modules.
6. **Offline evaluator parsing.** Separate manifest/suite integrity from operation dispatch
   before the corpus gains another capability.

Only one consumer migration or extraction is performed at a time. A refactor is accepted when
public outputs, stable error codes, frozen corpus results, fixed-seed properties, and package
artifacts remain unchanged.

## Adding a module

A new production source file requires all of the following in the same pull request:

1. add it to exactly one layer in `architecture.json`;
2. keep it at or below the default size budget;
3. ensure its imports follow that layer's direction;
4. justify why an existing module is not the correct home;
5. add or update behavior tests rather than only architecture metadata.

A new size exception is allowed only for an emergency compatibility or security repair that
cannot be safely decomposed first. It must include a concrete extraction and removal
condition; “temporary” by itself is not sufficient.

## Interpretation boundary

Passing the architecture guard proves that the checked source graph follows the registered
rules and byte ceilings. It does not prove the architecture is optimal, eliminate all
coupling, measure runtime performance, or complete the listed extractions. The exception list
is visible technical debt, not an exemption from future simplification.
