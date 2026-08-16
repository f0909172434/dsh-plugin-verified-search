# HonestCI dogfood rollout

This project uses HonestCI as an internal consumer rather than presenting the integration
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
from 222 to 237 tests. The revised baseline was derived from the first completed `main` run
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

The baseline revision PR could not use its own 237-test file to weaken the comparison. On pull
requests, HonestCI read `.honest-ci/baseline.json` from the base commit, so the revision was
still evaluated against 222.

## Stage 5 — revised baseline activation confirmation

The first `main` run containing the 237-test baseline independently confirmed the revision:

| Field | Activated value |
| --- | --- |
| Activated commit | `a7dd8d3635eb3d86a7e125e1e319ed5948f90e27` |
| Workflow run | `31934852209` |
| Event/ref | `push` / `refs/heads/main` |
| Quality environment | Ubuntu / Node `22.19.0` |
| Compatibility environments | Ubuntu / Node 24; Windows / Node 22.19 and 24 |
| Result status | `passed` |
| Observed totals | 237 tests, 0 failures, 0 errors, 0 skipped |
| Trusted baseline | 237 tests |
| Observed drop | 0% |
| Findings | none |
| GitHub artifact ID | `9260340343` |
| HonestCI artifact digest | `sha256:2f7135f8da47020aefc612b7d43bca80c3723af788345524a168a9542464fa99` |
| JUnit SHA-256 | `16a8e9f79a4a82c88031462121c19e81280088c8280e0e65b6d5d10d7c6049cc` |
| Evidence JSON SHA-256 | `c5d6e61716e2ee3cace73511b5d219e0e83bf50bc3fd7b9b433836dc7398b5e9` |
| Baseline artifact SHA-256 | `8057178b42a56ac9ac51a9e95146df0a4730e63933966717deecc9b710b63faa` |
| Evidence creation time | `2026-08-16T07:49:29.582Z` |
| Offline report artifact ID | `9260341116` |
| Offline artifact digest | `sha256:fe93c2d77354e237dcb06e203e1b0973b53f644743d8ce46df918f03def667c5` |
| Offline report SHA-256 | `52b24daad9d5514f408637f142ef850cb1fbcc715a509222a51f51daed89604f` |
| Offline result digest | `sha256:3002001da02d0b8501bcc97ee867109f1bfbf0e1a227d87845db81da658ea5c0` |

This closed the first revision loop. Pull requests then compared against the committed
237-test baseline, while the offline corpus remained independently fixed at 42 passing cases
and its registered result digest.

## Stage 6 — architecture-guard baseline revision

The enforceable source-architecture contract added four graph and size-budget tests plus one
product-contract binding test. The baseline therefore advanced from 237 to 242 only after the
architecture PR was merged and its own default-branch workflow completed:

| Field | Revised value |
| --- | --- |
| Source commit | `318d8f0105b2c6a1c4d2bc7c0282560e930800bc` |
| Workflow run | `31936017824` |
| Event/ref | `push` / `refs/heads/main` |
| Quality environment | Ubuntu / Node `22.19.0` |
| Compatibility environments | Ubuntu / Node 24; Windows / Node 22.19 and 24 |
| HonestCI | `1.0.4` at `4ee4e30b283c219ff42e75606e692f34c91ba826` |
| Observed totals | 242 tests, 0 failures, 0 errors, 0 skipped |
| Previous trusted baseline | 237 tests |
| Observed drop | 0% |
| Findings | none |
| GitHub artifact ID | `9260666767` |
| GitHub artifact digest | `sha256:1178fc1076928e809be3ddf940cbe57a02bda6cdbe5781392aef8bc3145d4961` |
| JUnit SHA-256 | `604c5c84d65915153b45524129c06c5f20096f4818d084caf568706ae72ab8f2` |
| Evidence JSON SHA-256 | `fed00b1afc5a92c20ea7fccc1e73fdc85862f584df1f5d611ce2c20ab1e5c3a6` |
| Previous baseline artifact SHA-256 | `8057178b42a56ac9ac51a9e95146df0a4730e63933966717deecc9b710b63faa` |
| New baseline SHA-256 | `0e31e3803eae139932b9b5c16c53ba071f8f1084793af7c2b6a79f1cbbf63247` |
| Evidence creation time | `2026-08-16T08:16:23.481Z` |
| Offline report artifact ID | `9260667566` |
| Offline artifact digest | `sha256:13070a19b27d53b88e62af01621f647f1e80bc8e0d5e03bbee12b8e41637062c` |
| Offline result digest | `sha256:3002001da02d0b8501bcc97ee867109f1bfbf0e1a227d87845db81da658ea5c0` |

The baseline revision PR was evaluated against the 237-test baseline from its base commit; it
could not use the new file to weaken its own comparison.

## Stage 7 — architecture-guard baseline activation

The first default-branch run containing the committed 242-test baseline independently closed
the revision loop:

| Field | Activated value |
| --- | --- |
| Activated commit | `c0a1605edd95acab9258b6812bf9b102f9ad1821` |
| Workflow run | `31936229233` |
| Event/ref | `push` / `refs/heads/main` |
| Quality environment | Ubuntu / Node `22.19.0` |
| Compatibility environments | Ubuntu / Node 24; Windows / Node 22.19 and 24 |
| Result status | `passed` |
| Observed totals | 242 tests, 0 failures, 0 errors, 0 skipped |
| Trusted baseline | 242 tests |
| Observed drop | 0% |
| Findings | none |
| HonestCI artifact ID | `9260726043` |
| HonestCI artifact digest | `sha256:2c9663c2f8301e405f305c56c2bc8d9599cff2f7d0804be6411490d11810e671` |
| JUnit SHA-256 | `34641375d972653cf01692ec7325cfb283b84800f1ca195a19654fc597217358` |
| Evidence JSON SHA-256 | `3277a980c6959ccb4121fc9e0e2fc8eb930f990c98ef2baababb81feb255a796` |
| Baseline artifact SHA-256 | `0e31e3803eae139932b9b5c16c53ba071f8f1084793af7c2b6a79f1cbbf63247` |
| Evidence creation time | `2026-08-16T08:21:21.626Z` |
| Offline report artifact ID | `9260726718` |
| Offline artifact digest | `sha256:8e25af1e4658ad4cd942e4d06699c66966568dbc63fa8bf9fe6fca7fa3ff18c3` |
| Offline report SHA-256 | `52b24daad9d5514f408637f142ef850cb1fbcc715a509222a51f51daed89604f` |
| Offline result digest | `sha256:3002001da02d0b8501bcc97ee867109f1bfbf0e1a227d87845db81da658ea5c0` |

Future pull requests now compare against the active 242-test baseline. The architecture tests
remain ordinary tests rather than a separate green badge, so removing or bypassing them must
also reduce the observed count or change the source-architecture contract.

## Stage 8 — strict-JSON primitive baseline revision

The shared strict-JSON primitive extraction added four direct behavior tests while preserving
the frozen 42-case offline result. The 246-test baseline candidate is derived only from the
completed post-merge `main` run for the refactor:

| Field | Revised value |
| --- | --- |
| Source commit | `7ede47e60236cf105039204de316e324f719b24a` |
| Workflow run | `31938769457` |
| Event/ref | `push` / `refs/heads/main` |
| Quality environment | Ubuntu / Node `22.19.0` |
| Compatibility environments | Ubuntu / Node 24; Windows / Node 22.19 and 24 |
| HonestCI | `1.0.4` at `4ee4e30b283c219ff42e75606e692f34c91ba826` |
| Observed totals | 246 tests, 0 failures, 0 errors, 0 skipped |
| Previous trusted baseline | 242 tests |
| Observed drop | 0% |
| Findings | none |
| GitHub artifact ID | `9261421310` |
| GitHub artifact digest | `sha256:e79ae8d1f69509f21b0850d973a9c15b7b26dbbc70d98f5b90cb015b935684e8` |
| JUnit SHA-256 | `b95c55497f1aaa2159221b16f75d05824099451deac97cebab4c8b33b6af6038` |
| Evidence JSON SHA-256 | `56a5be35f097511488f5baa89bfd9ab72535f607612eaf537497a317460bd9e7` |
| Previous baseline artifact SHA-256 | `0e31e3803eae139932b9b5c16c53ba071f8f1084793af7c2b6a79f1cbbf63247` |
| New baseline SHA-256 | `3a14a6acb9df71166832475f3685bab07e94b6ceca8e91e5309bec1d63c9ae55` |
| Evidence creation time | `2026-08-16T09:20:36.930Z` |
| Offline report artifact ID | `9261422009` |
| Offline artifact digest | `sha256:04eba40df151ed32cafb35f2e0f8c04d2e7ba8b26cc133ec571059ea7dfe337f` |
| Offline report SHA-256 | `52b24daad9d5514f408637f142ef850cb1fbcc715a509222a51f51daed89604f` |
| Offline result digest | `sha256:3002001da02d0b8501bcc97ee867109f1bfbf0e1a227d87845db81da658ea5c0` |

The baseline revision PR was evaluated against the 242-test file from its base commit; it
could not use the new file to weaken its own comparison.

## Stage 9 — strict-JSON primitive baseline activation

The first default-branch run containing the committed 246-test baseline independently closed
the revision loop:

| Field | Activated value |
| --- | --- |
| Activated commit | `6d0f360b6d01df6d72e4e2716450062cbd7659db` |
| Workflow run | `31939485242` |
| Event/ref | `push` / `refs/heads/main` |
| Quality environment | Ubuntu / Node `22.19.0` |
| Compatibility environments | Ubuntu / Node 24; Windows / Node 22.19 and 24 |
| Result status | `passed` |
| Observed totals | 246 tests, 0 failures, 0 errors, 0 skipped |
| Trusted baseline | 246 tests |
| Observed drop | 0% |
| Findings | none |
| HonestCI artifact ID | `9261614703` |
| HonestCI artifact digest | `sha256:713c9c98ebb9b144f531ef316ca11b0cd3341d52a22c5d70be500ebdf01a217b` |
| JUnit SHA-256 | `6a66a2b1c8d152bfdac17d56bb5c1824e1ce52ba8c4594a2df2b6a1fb3aeee8a` |
| Evidence JSON SHA-256 | `315284f0eb9dc10e4fd2ba5e17ccf80feb80587e32c37216c139310dd43d4371` |
| Baseline artifact SHA-256 | `3a14a6acb9df71166832475f3685bab07e94b6ceca8e91e5309bec1d63c9ae55` |
| Evidence creation time | `2026-08-16T09:36:47.085Z` |
| Offline report artifact ID | `9261615453` |
| Offline artifact digest | `sha256:870b752af51fd983611fd52bd677a8ee5c7273a558ea4b98201c3cdb397339ce` |
| Offline report SHA-256 | `52b24daad9d5514f408637f142ef850cb1fbcc715a509222a51f51daed89604f` |
| Offline result digest | `sha256:3002001da02d0b8501bcc97ee867109f1bfbf0e1a227d87845db81da658ea5c0` |

Future pull requests now compare against the active 246-test baseline. This activation records
only observed CI behavior and does not broaden the product's live-provider or external-adoption
claims.

## Stage 10 — lossless-number baseline revision

The lossless-number extraction added four direct behavior and failure-boundary tests while
preserving the frozen 42-case offline result. The 250-test baseline candidate is derived only
from the completed post-merge `main` run for the refactor:

| Field | Revised value |
| --- | --- |
| Source commit | `c7e4b8c2e8d7b71e2c535b9d256721b2ec398a98` |
| Workflow run | `31941012664` |
| Event/ref | `push` / `refs/heads/main` |
| Quality environment | Ubuntu / Node `22.19.0` |
| Compatibility environments | Ubuntu / Node 24; Windows / Node 22.19 and 24 |
| HonestCI | `1.0.4` at `4ee4e30b283c219ff42e75606e692f34c91ba826` |
| Observed totals | 250 tests, 0 failures, 0 errors, 0 skipped |
| Previous trusted baseline | 246 tests |
| Observed drop | 0% |
| Findings | none |
| GitHub artifact ID | `9262014683` |
| GitHub artifact digest | `sha256:b9b9d5a10c7c7d08cfe5365904d3ded5310031f210f9b96aaf1d9df8e483dbda` |
| JUnit SHA-256 | `873db5576adcc63029e26dcd7bb24fb5bc795fef2b4d70f2805b044ce5d87ac0` |
| Evidence JSON SHA-256 | `491dc5ab494eaf35e78738f5c0c64e26c6355947258cc45c809f929950a138c6` |
| Previous baseline artifact SHA-256 | `3a14a6acb9df71166832475f3685bab07e94b6ceca8e91e5309bec1d63c9ae55` |
| New baseline SHA-256 | `313c1bb408d80ab710526a6d7a5784db14417896b7cfe16fe14cd332c7b0e441` |
| Evidence creation time | `2026-08-16T10:11:40.517Z` |
| Offline report artifact ID | `9262015471` |
| Offline artifact digest | `sha256:511f9aeb139c548506bbe9b27e558b3fc46598c6a7866718f6386b594ddbf1eb` |
| Offline report SHA-256 | `52b24daad9d5514f408637f142ef850cb1fbcc715a509222a51f51daed89604f` |
| Offline result digest | `sha256:3002001da02d0b8501bcc97ee867109f1bfbf0e1a227d87845db81da658ea5c0` |

The baseline revision pull request is still evaluated against the 246-test file from its base
commit; it cannot use the new file to weaken its own comparison. The 250-test baseline becomes
active only after a later default-branch run reports `baselineTests: 250`, `dropPercent: 0`,
no findings, and a fully green runtime matrix.

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
