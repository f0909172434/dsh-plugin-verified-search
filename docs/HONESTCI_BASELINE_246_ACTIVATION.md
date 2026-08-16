# HonestCI 246-test baseline activation

Status: **active on `main`**.

The first default-branch workflow after merging PR #14 read the committed 246-test baseline and completed successfully. This closes the activation loop opened by `HONESTCI_BASELINE_246.md`.

## Activation result

```text
observed tests: 246
baseline tests: 246
dropPercent: 0
findings: []
failures / errors / skipped: 0 / 0 / 0
```

The same default-branch workflow also completed the supported Ubuntu and Windows runtime matrix, reproduced the committed distributable artifacts, passed the package dry-run, and reproduced all 42 frozen offline cases with result digest:

```text
sha256:3002001da02d0b8501bcc97ee867109f1bfbf0e1a227d87845db81da658ea5c0
```

## Chain of evidence

1. PR #13 added four direct strict-JSON primitive tests and merged as `7ede47e60236cf105039204de316e324f719b24a`.
2. Its successful default-branch workflow observed 246 tests while the active baseline remained 242.
3. PR #14 advanced the committed baseline to 246 without weakening the 10% maximum-drop policy.
4. The first subsequent `main` workflow observed 246 tests against the 246-test baseline with no findings.

## Interpretation boundary

This activation proves that the default branch now enforces the 246-test disappearance guard. It does not establish assertion quality, complete behavioral coverage, live-provider compatibility, independent adoption, or external review.
