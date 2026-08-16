from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Any

REPOSITORY = os.environ["GITHUB_REPOSITORY"]
TOKEN = os.environ["GITHUB_TOKEN"]
RUN_ID = 31938769457
SOURCE_COMMIT = "7ede47e60236cf105039204de316e324f719b24a"
EXPECTED_PREVIOUS_BASELINE = 242
EXPECTED_OBSERVED_TESTS = 246
EXPECTED_OFFLINE_CASES = 42
EXPECTED_OFFLINE_RESULT = "sha256:3002001da02d0b8501bcc97ee867109f1bfbf0e1a227d87845db81da658ea5c0"
HONEST_CI_VERSION = "1.0.4"
HONEST_CI_ACTION_SHA = "4ee4e30b283c219ff42e75606e692f34c91ba826"
ROOT = Path.cwd()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def request(url: str) -> bytes:
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "dsh-plugin-verified-search-baseline-evidence",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as response:
        return response.read()


def api_json(path: str) -> dict[str, Any]:
    return json.loads(request(f"https://api.github.com{path}"))


def select_artifact(artifacts: list[dict[str, Any]], prefix: str) -> dict[str, Any]:
    matches = [
        artifact
        for artifact in artifacts
        if str(artifact.get("name", "")).startswith(prefix) and not artifact.get("expired", False)
    ]
    if not matches:
        raise RuntimeError(f"run {RUN_ID} has no active artifact beginning with {prefix!r}")
    matches.sort(key=lambda artifact: str(artifact.get("created_at", "")), reverse=True)
    return matches[0]


def extract_artifact(artifact: dict[str, Any], destination: Path) -> None:
    archive = destination.with_suffix(".zip")
    archive.write_bytes(
        request(
            f"https://api.github.com/repos/{REPOSITORY}/actions/artifacts/{artifact['id']}/zip"
        )
    )
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as bundle:
        bundle.extractall(destination)


def locate(root: Path, name: str) -> Path:
    matches = sorted(path for path in root.rglob(name) if path.is_file())
    if len(matches) != 1:
        raise RuntimeError(f"expected one {name!r} beneath {root}, found {len(matches)}")
    return matches[0]


def parse_junit(path: Path) -> dict[str, int]:
    root = ET.parse(path).getroot()

    def number(element: ET.Element, attribute: str) -> int:
        raw = element.attrib.get(attribute)
        return int(float(raw)) if raw is not None else 0

    attributes = ("tests", "failures", "errors", "skipped")
    if all(attribute in root.attrib for attribute in attributes):
        return {attribute: number(root, attribute) for attribute in attributes}

    suites = [element for element in root.iter() if element.tag.rsplit("}", 1)[-1] == "testsuite"]
    return {
        attribute: sum(number(element, attribute) for element in suites)
        for attribute in attributes
    }


def deep_values(value: Any, key: str) -> list[Any]:
    found: list[Any] = []
    if isinstance(value, dict):
        for current_key, current_value in value.items():
            if current_key == key:
                found.append(current_value)
            found.extend(deep_values(current_value, key))
    elif isinstance(value, list):
        for current_value in value:
            found.extend(deep_values(current_value, key))
    return found


def evidence_timestamp(evidence: dict[str, Any], artifact: dict[str, Any]) -> str:
    for key in ("createdAt", "generatedAt", "created_at", "timestamp"):
        for value in deep_values(evidence, key):
            if isinstance(value, str) and "T" in value:
                return value
    created_at = artifact.get("created_at")
    if not isinstance(created_at, str):
        raise RuntimeError("HonestCI artifact has no usable creation timestamp")
    return created_at


def load_offline_report(root: Path) -> tuple[Path, dict[str, Any]]:
    for path in sorted(root.rglob("*.json")):
        value = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(value, dict) and "resultSha256" in value and "cases" in value:
            return path, value
    raise RuntimeError("offline evaluation artifact contains no recognizable report")


def artifact_record(artifact: dict[str, Any]) -> dict[str, Any]:
    digest = artifact.get("digest")
    if not isinstance(digest, str) or not digest.startswith("sha256:"):
        raise RuntimeError(f"artifact {artifact.get('name')} has no SHA-256 digest")
    return {
        "id": int(artifact["id"]),
        "name": str(artifact["name"]),
        "digest": digest,
        "created_at": str(artifact["created_at"]),
        "expires_at": str(artifact["expires_at"]),
    }


def main() -> None:
    run = api_json(f"/repos/{REPOSITORY}/actions/runs/{RUN_ID}")
    if run.get("head_sha") != SOURCE_COMMIT:
        raise RuntimeError("trusted workflow run does not belong to the expected source commit")
    if run.get("status") != "completed" or run.get("conclusion") != "success":
        raise RuntimeError("trusted workflow run is not a completed success")

    jobs_payload = api_json(f"/repos/{REPOSITORY}/actions/runs/{RUN_ID}/jobs?per_page=100")
    jobs = jobs_payload.get("jobs", [])
    if not isinstance(jobs, list) or not jobs:
        raise RuntimeError("trusted workflow run exposes no jobs")
    job_results = {
        str(job["name"]): str(job.get("conclusion"))
        for job in jobs
    }
    if any(conclusion != "success" for conclusion in job_results.values()):
        raise RuntimeError(f"trusted workflow matrix is not entirely successful: {job_results}")

    artifact_payload = api_json(
        f"/repos/{REPOSITORY}/actions/runs/{RUN_ID}/artifacts?per_page=100"
    )
    artifacts = artifact_payload.get("artifacts", [])
    if not isinstance(artifacts, list):
        raise RuntimeError("artifact listing is malformed")
    honest_artifact = select_artifact(artifacts, "honest-ci-evidence-")
    offline_artifact = select_artifact(artifacts, "offline-evaluation-")

    with tempfile.TemporaryDirectory() as temporary:
        temporary_root = Path(temporary)
        honest_root = temporary_root / "honest"
        offline_root = temporary_root / "offline"
        extract_artifact(honest_artifact, honest_root)
        extract_artifact(offline_artifact, offline_root)

        evidence_path = locate(honest_root, "evidence.json")
        junit_path = locate(honest_root, "junit.xml")
        evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
        if not isinstance(evidence, dict):
            raise RuntimeError("HonestCI evidence is not an object")
        junit = parse_junit(junit_path)
        expected_junit = {
            "tests": EXPECTED_OBSERVED_TESTS,
            "failures": 0,
            "errors": 0,
            "skipped": 0,
        }
        if junit != expected_junit:
            raise RuntimeError(f"unexpected trusted JUnit totals: {junit}")

        statuses = [str(value).lower() for value in deep_values(evidence, "status")]
        if statuses and not any(value in {"pass", "passed", "success"} for value in statuses):
            raise RuntimeError(f"HonestCI evidence has no passing status: {statuses}")
        findings = deep_values(evidence, "findings")
        if any(isinstance(value, list) and value for value in findings):
            raise RuntimeError("HonestCI evidence contains findings")
        drops = deep_values(evidence, "dropPercent")
        if any(isinstance(value, (int, float)) and value != 0 for value in drops):
            raise RuntimeError("HonestCI evidence reports a nonzero test-count drop")

        offline_path, offline = load_offline_report(offline_root)
        if offline.get("status") != "PASS":
            raise RuntimeError("offline evaluation did not pass")
        if int(offline.get("cases", -1)) != EXPECTED_OFFLINE_CASES:
            raise RuntimeError("offline evaluation case count changed")
        if int(offline.get("passed", -1)) != EXPECTED_OFFLINE_CASES:
            raise RuntimeError("offline evaluation did not pass every case")
        if int(offline.get("failed", -1)) != 0:
            raise RuntimeError("offline evaluation contains failures")
        if offline.get("resultSha256") != EXPECTED_OFFLINE_RESULT:
            raise RuntimeError("offline evaluation digest changed")

        baseline_path = ROOT / ".honest-ci" / "baseline.json"
        old_baseline_bytes = baseline_path.read_bytes()
        old_baseline = json.loads(old_baseline_bytes)
        old_tests = int(old_baseline["reports"]["unit"]["tests"])
        if old_tests != EXPECTED_PREVIOUS_BASELINE:
            raise RuntimeError(f"expected the active baseline to contain 242 tests, found {old_tests}")

        created_at = evidence_timestamp(evidence, honest_artifact)
        new_baseline = {
            "version": 1,
            "generatedAt": created_at,
            "reports": {
                "unit": {
                    "tests": EXPECTED_OBSERVED_TESTS,
                    "failures": 0,
                    "errors": 0,
                    "skipped": 0,
                }
            },
        }
        new_baseline_bytes = (
            json.dumps(new_baseline, ensure_ascii=False, indent=2) + "\n"
        ).encode("utf-8")
        baseline_path.write_bytes(new_baseline_bytes)

        record = {
            "schema_version": 1,
            "kind": "honest_ci_baseline_proposal",
            "source": {
                "commit": SOURCE_COMMIT,
                "workflow_run_id": RUN_ID,
                "workflow_name": str(run.get("name")),
                "workflow_run_number": int(run.get("run_number", 0)),
                "event": str(run.get("event")),
                "completed_at": str(run.get("updated_at")),
                "jobs": job_results,
            },
            "honest_ci": {
                "version": HONEST_CI_VERSION,
                "action_sha": HONEST_CI_ACTION_SHA,
                "artifact": artifact_record(honest_artifact),
                "evidence_created_at": created_at,
                "evidence_json_sha256": sha256_file(evidence_path),
                "junit_sha256": sha256_file(junit_path),
                "observed": junit,
                "previous_baseline_tests": EXPECTED_PREVIOUS_BASELINE,
                "drop_percent": 0,
                "findings": [],
            },
            "baseline": {
                "old_sha256": sha256_bytes(old_baseline_bytes),
                "new_sha256": sha256_bytes(new_baseline_bytes),
                "proposed_tests": EXPECTED_OBSERVED_TESTS,
                "activation_status": "PENDING_DEFAULT_BRANCH_RUN",
            },
            "offline_evaluation": {
                "artifact": artifact_record(offline_artifact),
                "report_sha256": sha256_file(offline_path),
                "status": str(offline["status"]),
                "cases": int(offline["cases"]),
                "passed": int(offline["passed"]),
                "failed": int(offline["failed"]),
                "result_sha256": str(offline["resultSha256"]),
            },
            "boundary": (
                "This record advances an internal test-count dogfood baseline. It does not "
                "prove assertion quality, external adoption, or independent validation."
            ),
        }
        evidence_record_path = (
            ROOT / ".honest-ci" / "evidence" / "baseline-246-strict-json-primitives.json"
        )
        evidence_record_path.parent.mkdir(parents=True, exist_ok=True)
        evidence_record_path.write_text(
            json.dumps(record, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
            newline="\n",
        )

        document = f"""# HonestCI 246-test baseline proposal

**Status: proposed; activation pending.**

The proposal is derived only from completed default-branch workflow run `{RUN_ID}` for main
commit `{SOURCE_COMMIT}`. The run observed {junit['tests']} tests with zero failures, errors,
or skipped tests. Every recorded Ubuntu/Windows and Node 22.19/24 job completed successfully.

## Bound evidence

```text
source commit: {SOURCE_COMMIT}
workflow run: {RUN_ID}
HonestCI: {HONEST_CI_VERSION} / {HONEST_CI_ACTION_SHA}
observed tests: {junit['tests']}
previous baseline: {EXPECTED_PREVIOUS_BASELINE}
failures/errors/skipped: {junit['failures']} / {junit['errors']} / {junit['skipped']}
dropPercent: 0
findings: []
HonestCI artifact ID: {honest_artifact['id']}
HonestCI artifact digest: {honest_artifact['digest']}
JUnit SHA-256: {sha256_file(junit_path)}
evidence JSON SHA-256: {sha256_file(evidence_path)}
old baseline SHA-256: {sha256_bytes(old_baseline_bytes)}
new baseline SHA-256: {sha256_bytes(new_baseline_bytes)}
evidence created: {created_at}
offline artifact ID: {offline_artifact['id']}
offline artifact digest: {offline_artifact['digest']}
offline report SHA-256: {sha256_file(offline_path)}
offline result digest: {offline['resultSha256']}
```

The frozen offline suite reproduced all {offline['cases']} cases. The proposed baseline does
not become active merely because this branch contains it: pull-request evaluation continues
to read the baseline from the default branch. Activation requires the first later `main` run
to report 246 observed tests against a 246-test baseline, zero drop, and no findings.

This is internal dogfood evidence. It measures observed test count and reproducibility; it does
not establish assertion quality, architectural optimality, external adoption, or independent
validation.
"""
        docs_path = ROOT / "docs" / "HONEST_CI_BASELINE_246.md"
        docs_path.write_text(document, encoding="utf-8", newline="\n")

        changelog_path = ROOT / "CHANGELOG.md"
        changelog = changelog_path.read_text(encoding="utf-8")
        marker = "- The 246-test HonestCI baseline proposal"
        if marker not in changelog:
            insertion = (
                f"{marker} is bound to completed default-branch run `{RUN_ID}`, "
                "its JUnit and evidence hashes, both artifact digests, the prior and proposed "
                "baseline hashes, and the unchanged 42-case offline result; activation remains "
                "pending a later `main` run.\n"
            )
            heading = "### Changed\n\n"
            if heading in changelog:
                changelog = changelog.replace(heading, heading + insertion, 1)
            else:
                unreleased = "## Unreleased\n"
                if unreleased not in changelog:
                    raise RuntimeError("CHANGELOG.md has no Unreleased section")
                changelog = changelog.replace(
                    unreleased,
                    unreleased + "\n### Changed\n\n" + insertion,
                    1,
                )
            changelog_path.write_text(changelog, encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
