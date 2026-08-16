# HonestCI 246-test baseline checkpoint

Status: **proposed; activation requires a later default-branch run**.

This checkpoint advances the observed unit-test baseline from 242 to 246 only after the shared strict-JSON refactor was merged and its default-branch workflow completed successfully.

## Source evidence

- source commit: `7ede47e60236cf105039204de316e324f719b24a`
- workflow run: `31938769457`
- HonestCI action: `v1.0.4` at `4ee4e30b283c219ff42e75606e692f34c91ba826`
- observed tests: `246`
- previous baseline tests: `242`
- failures / errors / skipped: `0 / 0 / 0`
- supported matrix: Ubuntu Node 22.19 primary job, Ubuntu Node 24, Windows Node 22.19, and Windows Node 24
- frozen offline corpus: `42 / 42` cases passed
- offline result digest: `sha256:3002001da02d0b8501bcc97ee867109f1bfbf0e1a227d87845db81da658ea5c0`
- workflow conclusion: `success`

The four additional tests directly exercise the extracted strict-JSON primitive boundary. The baseline therefore reflects committed behavior coverage rather than an unrelated runner or dependency change.

## Activation rule

This pull request is still evaluated against the 242-test baseline from its base commit. The 246-test value becomes active only when a later `main` workflow reads the committed baseline and reports all of the following:

```text
observed tests: 246
baseline tests: 246
dropPercent: 0
findings: []
failures / errors / skipped: 0 / 0 / 0
```

A separate documentation-only checkpoint records that first activation run. Until then, this file is a proposed baseline revision, not evidence that the new baseline has already been enforced on the default branch.

## Interpretation boundary

The count guards against accidental test disappearance. It does not establish assertion quality, complete behavioral coverage, live-provider compatibility, or external validation.
