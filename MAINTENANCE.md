# Maintenance contract

This repository is maintained under a single-maintainer operating model. The contract below
keeps support promises smaller than the implementation surface and makes pause, removal, and
migration decisions explicit.

## Product lines

Two product lines coexist in the repository and must not be described as equivalent:

1. **Reviewed release line** — tag `v0.1.1`, package version `0.1.1`, containing the reviewed
   `verified_search` workflow.
2. **Unreleased experiment line** — `main`, package version `0.3.0-experiment.0`, containing
   `verified_search` plus the composite research and structured JSON tools.

A passing `main` CI run is evidence that the current source satisfies repository tests. It is
not a retroactive release or a compatibility promise for every feature on `main`.

The machine-readable source of truth is [`capabilities.json`](capabilities.json). Changes to a
tool lifecycle, supported runtime, upstream contract, or removal condition must update that
file and its contract test in the same pull request.

## Support boundary

The currently tested development contract is:

- Node.js `22.19.x` and `24.x`;
- pnpm `10.28.2` with the committed lockfile;
- Ubuntu and Windows GitHub-hosted runners;
- DeepSeek Harness packages at `0.1.0-rc.6`;
- `@deepseek-ai/cordis` at `4.0.1`.

Exact peer versions are deliberate. A newer Harness release is unsupported until lifecycle,
tool registration, session persistence, prompt assembly, turn cleanup, and disposal behavior
have been exercised against it.

## Stability meanings

### Reviewed release

A reviewed release has an immutable tag, reproducible package contents, checksums, install and
rollback instructions, cross-platform CI, and recorded live conformance evidence. Security
and compatibility fixes may be backported when practical.

### Beta

A beta capability has a frozen public contract and repeatable evaluation corpus, but may still
change in a minor release when the migration is documented. No capability is currently beta.

### Experimental

An experimental capability may change or be removed without a compatibility shim. It must
remain bounded, tested, documented, and honest about unresolved evidence. Experiment status
is not permission to bypass security or data-integrity requirements.

### Deprecated

A deprecated capability remains available for a stated window with a documented replacement
or removal reason. Deprecation must identify the final supported version.

## Maintenance priorities

Work is ordered by severity rather than novelty:

- **P0** — credential exposure, network-boundary bypass, arbitrary execution, corrupted or
  misleading evidence output, or a materially false security/research claim;
- **P1** — reviewed-release regression, reproducibility failure, unsupported source silently
  accepted, stale tool restriction, or deterministic selector divergence;
- **P2** — supported-runtime incompatibility, bounded performance regression, misleading
  diagnostics, or documentation that changes operational behavior;
- **P3** — new provider, new composite workflow, UI work, convenience feature, or broader
  source support.

P3 work does not pre-empt unresolved P0/P1 work.

## Change requirements

Every feature pull request must state:

- the concrete failure or user task it addresses;
- why the change belongs in this repository;
- the automated acceptance condition;
- the compatibility and security impact;
- the rollback path;
- the condition under which the feature should be removed or redesigned.

A new model-facing tool, network exception, source-specific parser, provider, or lifecycle
hook requires a separate architectural decision rather than an incidental addition.

## Single-maintainer evidence rule

External reviewers, contributors, users, stars, and adoption are optional signals rather than
development prerequisites. Their absence must not block bounded refactors, deterministic
evaluation, security work, or maintenance.

When independent review is unavailable, confidence is built from frozen corpora, independent
reference implementations, differential and metamorphic checks, fixed-seed properties,
cross-platform CI, reproducible package artifacts, and exact evidence hashes. These controls
do not become “independent review”: documentation must state that external validation is
absent instead of inventing a reviewer or leaving engineering work blocked on one.

## Release discipline

- Releases are cut from an explicitly reviewed commit, never from a moving branch name.
- `package.json`, `capabilities.json`, release notes, package dry-run contents, and checksums
  must agree.
- Generated `lib/` artifacts are committed and CI must reproduce them byte-for-byte.
- Experimental features do not enter a stable release merely because they are present on
  `main`.
- A support promise is made only for versions listed in the compatibility contract.

## Pause and retirement rules

The repository enters **maintenance mode** when there has been no planned active development
for 60 days. Maintenance mode still accepts P0/P1 fixes and dependency updates required to
preserve the documented support boundary.

A capability is removed or archived when one of the following holds:

- its removal condition in `capabilities.json` is met;
- the required upstream Harness interface no longer exists and no small adapter preserves the
  contract;
- another maintained component provides the same bounded behavior with a documented migration
  path;
- keeping it supported requires source-specific heuristics or unbounded execution that violate
  this repository's security model;
- two consecutive planned releases have no real internal use, evaluation task, or maintained
  consumer for it.

Retirement does not rewrite history. Prior tags, checksums, known limitations, and negative
results remain visible.

## Explicit non-goals

This project does not aim to become a hosted search service, general browser, arbitrary code
runner, unbounded autonomous research agent, publisher truth authority, or compatibility
layer for every model provider and every Harness release.
