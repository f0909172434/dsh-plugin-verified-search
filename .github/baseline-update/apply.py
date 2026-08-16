from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASELINE = ROOT / ".honest-ci" / "baseline.json"
CHANGELOG = ROOT / "CHANGELOG.md"
DOGFOOD = ROOT / "docs" / "HONEST_CI_DOGFOOD.md"

OLD_BASELINE_SHA256 = "3a14a6acb9df71166832475f3685bab07e94b6ceca8e91e5309bec1d63c9ae55"
NEW_BASELINE_SHA256 = "313c1bb408d80ab710526a6d7a5784db14417896b7cfe16fe14cd332c7b0e441"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one target, found {count}")
    return text.replace(old, new, 1)


if sha256(BASELINE) not in {OLD_BASELINE_SHA256, NEW_BASELINE_SHA256}:
    raise RuntimeError("unexpected HonestCI baseline input")

baseline = {
    "version": 1,
    "generatedAt": "2026-08-16T10:11:40.517Z",
    "reports": {
        "unit": {
            "tests": 250,
            "failures": 0,
            "errors": 0,
            "skipped": 0,
        }
    },
}
BASELINE.write_text(
    json.dumps(baseline, ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8",
    newline="\n",
)
if sha256(BASELINE) != NEW_BASELINE_SHA256:
    raise RuntimeError("generated HonestCI baseline hash mismatch")

changelog = CHANGELOG.read_text(encoding="utf-8")
if "31941012664" not in changelog:
    changelog = replace_once(
        changelog,
        """- Direct tests for lossless lexeme retention, exact comparison, shared strict-JSON failures,
  caller-provided number limits, and pre-materialization depth bounds.
""",
        """- Direct tests for lossless lexeme retention, exact comparison, shared strict-JSON failures,
  caller-provided number limits, and pre-materialization depth bounds.
- A revised 250-test HonestCI baseline candidate derived from completed default-branch run
  `31941012664` after the lossless-number extraction added four durable behavior tests.
""",
        "changelog baseline candidate",
    )
    changelog = replace_once(
        changelog,
        """- The same activation run reproduced all 42 offline cases with result digest
  `sha256:3002001da02d0b8501bcc97ee867109f1bfbf0e1a227d87845db81da658ea5c0`.
""",
        """- The same activation run reproduced all 42 offline cases with result digest
  `sha256:3002001da02d0b8501bcc97ee867109f1bfbf0e1a227d87845db81da658ea5c0`.
- The lossless-number post-merge run observed 250 tests against the prior 246-test baseline
  with zero failures, errors, skipped tests, drop, or findings. The 250-test baseline remains
  a candidate until a later default-branch run executes against the committed revision.
""",
        "changelog baseline status",
    )
CHANGELOG.write_text(changelog, encoding="utf-8", newline="\n")

dogfood = DOGFOOD.read_text(encoding="utf-8")
if "## Stage 10 — lossless-number baseline revision" not in dogfood:
    stage = """## Stage 10 — lossless-number baseline revision

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

"""
    dogfood = replace_once(
        dogfood,
        "## Why only the primary job is wrapped\n",
        stage + "## Why only the primary job is wrapped\n",
        "dogfood stage insertion",
    )
DOGFOOD.write_text(dogfood, encoding="utf-8", newline="\n")
