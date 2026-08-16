from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CHANGELOG = ROOT / "CHANGELOG.md"
DOGFOOD = ROOT / "docs" / "HONEST_CI_DOGFOOD.md"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one target, found {count}")
    return text.replace(old, new, 1)


changelog = CHANGELOG.read_text(encoding="utf-8")
if "31941559670" not in changelog:
    anchor = """- The same activation run reproduced all 42 offline cases with result digest
  `sha256:3002001da02d0b8501bcc97ee867109f1bfbf0e1a227d87845db81da658ea5c0`.
"""
    addition = anchor + """- The 250-test baseline is active: default-branch run `31941559670` observed 250 tests
  against 250 with zero failures, errors, skipped tests, test-count drop, or findings across
  Ubuntu and Windows on Node 22.19 and 24.
- The same 250-test activation run reproduced all 42 offline cases with result digest
  `sha256:3002001da02d0b8501bcc97ee867109f1bfbf0e1a227d87845db81da658ea5c0`.
"""
    changelog = replace_once(changelog, anchor, addition, "changelog activation")
CHANGELOG.write_text(changelog, encoding="utf-8", newline="\n")

dogfood = DOGFOOD.read_text(encoding="utf-8")
if "## Stage 11 — lossless-number baseline activation" not in dogfood:
    stage = """## Stage 11 — lossless-number baseline activation

The first default-branch run containing the committed 250-test baseline independently closed
the revision loop:

| Field | Activated value |
| --- | --- |
| Activated commit | `9c556cf638aab0e5a1873a6f57c6062aff3ea321` |
| Workflow run | `31941559670` |
| Event/ref | `push` / `refs/heads/main` |
| Quality environment | Ubuntu / Node `22.19.0` |
| Compatibility environments | Ubuntu / Node 24; Windows / Node 22.19 and 24 |
| Result status | `passed` |
| Observed totals | 250 tests, 0 failures, 0 errors, 0 skipped |
| Trusted baseline | 250 tests |
| Observed drop | 0% |
| Findings | none |
| HonestCI artifact ID | `9262160741` |
| HonestCI artifact digest | `sha256:f2b48880ba6144b13198534e87c181aa042247dd01e258e4ebd84c7681834b56` |
| JUnit SHA-256 | `0e4f832f3b5eaeaa01e978cacb45adaabd47ba23ea4fc3bf5d172ae545e16b6f` |
| Evidence JSON SHA-256 | `9cd310d0be3f5046199cbc3b701aeea489a0b2f6385d231c8613405ccbf22b64` |
| Baseline artifact SHA-256 | `313c1bb408d80ab710526a6d7a5784db14417896b7cfe16fe14cd332c7b0e441` |
| Evidence creation time | `2026-08-16T10:24:26.307Z` |
| Offline report artifact ID | `9262161439` |
| Offline artifact digest | `sha256:a8dcf78d6db84d8e76e6756d8dd05a0174fa5d5fafb10b7840eba7add7f90974` |
| Offline report SHA-256 | `52b24daad9d5514f408637f142ef850cb1fbcc715a509222a51f51daed89604f` |
| Offline result digest | `sha256:3002001da02d0b8501bcc97ee867109f1bfbf0e1a227d87845db81da658ea5c0` |

Future pull requests now compare against the active 250-test baseline. This activation records
only observed CI behavior and does not broaden the product's live-provider, external-adoption,
or independent-validation claims.

"""
    dogfood = replace_once(
        dogfood,
        "## Why only the primary job is wrapped\n",
        stage + "## Why only the primary job is wrapped\n",
        "dogfood activation insertion",
    )
DOGFOOD.write_text(dogfood, encoding="utf-8", newline="\n")
