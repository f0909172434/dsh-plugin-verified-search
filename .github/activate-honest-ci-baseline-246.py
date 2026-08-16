from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Any

REPOSITORY = os.environ["GITHUB_REPOSITORY"]
TOKEN = os.environ["GITHUB_TOKEN"]
ROOT = Path.cwd()
EXPECTED_TESTS = 246
EXPECTED_OFFLINE_CASES = 42
EXPECTED_OFFLINE_RESULT = "sha256:3002001da02d0b8501bcc97ee867109f1bfbf0e1a227d87845db81da658ea5c0"
HONEST_CI_VERSION = "1.0.4"
HONEST_CI_ACTION_SHA = "4ee4e30b283c219ff42e75606e692f34c91ba826"
EXPECTED_JOBS = {
    "quality and package contract (Node 22.19)",
    "compatibility (ubuntu-latest, Node 24)",
    "compatibility (windows-latest, Node 22.19.0)",
    "compatibility (windows-latest, Node 24)",
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def api(
    method: str,
    path: str,
    payload: dict[str, Any] | None = None,
    *,
    accept_empty: bool = False,
) -> dict[str, Any]:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"https://api.github.com{path}",
        method=method,
        data=data,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "dsh-plugin-verified-search-baseline-activation",
        },
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        body = response.read()
    if not body:
        if accept_empty:
            return {}
        return {}
    return json.loads(body)


def download(path: str) -> bytes:
    request = urllib.request.Request(
        f"https://api.github.com{path}",
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "dsh-plugin-verified-search-baseline-activation",
        },
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], text=True).strip()


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


def locate(root: Path, name: str) -> Path:
    paths = sorted(path for path in root.rglob(name) if path.is_file())
    if len(paths) != 1:
        raise RuntimeError(f"expected one {name!r} beneath {root}, found {len(paths)}")
    return paths[0]


def load_offline_report(root: Path) -> tuple[Path, dict[str, Any]]:
    for path in sorted(root.rglob("*.json")):
        value = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(value, dict) and "resultSha256" in value and "cases" in value:
            return path, value
    raise RuntimeError("offline artifact contains no recognizable report")


def select_artifact(artifacts: list[dict[str, Any]], prefix: str) -> dict[str, Any]:
    matches = [
        artifact
        for artifact in artifacts
        if str(artifact.get("name", "")).startswith(prefix) and not artifact.get("expired", False)
    ]
    if not matches:
        raise RuntimeError(f"activation run has no active artifact beginning with {prefix!r}")
    matches.sort(key=lambda artifact: str(artifact.get("created_at", "")), reverse=True)
    return matches[0]


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


def branch_base_commit() -> str:
    subprocess.run(["git", "fetch", "origin", "main", "--depth=100"], check=True)
    return git("merge-base", "origin/main", "HEAD")


def baseline_sha_and_tests() -> tuple[str, int]:
    path = ROOT / ".honest-ci" / "baseline.json"
    baseline = json.loads(path.read_text(encoding="utf-8"))
    tests = int(baseline["reports"]["unit"]["tests"])
    return sha256_file(path), tests


def find_or_dispatch_main_run(base_commit: str) -> dict[str, Any]:
    deadline = time.monotonic() + 900
    dispatched = False
    while time.monotonic() < deadline:
        payload = api(
            "GET",
            f"/repos/{REPOSITORY}/actions/runs?branch=main&per_page=100",
        )
        runs = [
            run
            for run in payload.get("workflow_runs", [])
            if run.get("head_sha") == base_commit and run.get("name") == "CI"
        ]
        runs.sort(key=lambda run: str(run.get("created_at", "")), reverse=True)
        for run in runs:
            if run.get("status") == "completed":
                if run.get("conclusion") != "success":
                    raise RuntimeError(
                        f"the first 246-baseline main run failed: {run.get('id')} / {run.get('conclusion')}"
                    )
                return run
        if not runs and not dispatched:
            api(
                "POST",
                f"/repos/{REPOSITORY}/actions/workflows/ci.yml/dispatches",
                {"ref": "main"},
                accept_empty=True,
            )
            dispatched = True
        time.sleep(15)
    raise RuntimeError(f"timed out waiting for a successful main run at {base_commit}")


def validate_run(run: dict[str, Any]) -> tuple[dict[str, str], dict[str, Any], dict[str, Any]]:
    run_id = int(run["id"])
    jobs_payload = api("GET", f"/repos/{REPOSITORY}/actions/runs/{run_id}/jobs?per_page=100")
    jobs = {
        str(job["name"]): str(job.get("conclusion"))
        for job in jobs_payload.get("jobs", [])
    }
    missing = EXPECTED_JOBS - set(jobs)
    if missing:
        raise RuntimeError(f"activation run is missing expected jobs: {sorted(missing)}")
    failures = {name: jobs[name] for name in EXPECTED_JOBS if jobs[name] != "success"}
    if failures:
        raise RuntimeError(f"activation runtime matrix did not pass: {failures}")

    artifact_payload = api(
        "GET",
        f"/repos/{REPOSITORY}/actions/runs/{run_id}/artifacts?per_page=100",
    )
    artifacts = artifact_payload.get("artifacts", [])
    if not isinstance(artifacts, list):
        raise RuntimeError("activation artifact listing is malformed")
    return jobs, select_artifact(artifacts, "honest-ci-evidence-"), select_artifact(
        artifacts, "offline-evaluation-"
    )


def prepare() -> None:
    baseline_sha, baseline_tests = baseline_sha_and_tests()
    if baseline_tests != EXPECTED_TESTS:
        raise RuntimeError(
            f"activation branch is not based on the proposed 246-test baseline: {baseline_tests}"
        )
    base_commit = branch_base_commit()
    run = find_or_dispatch_main_run(base_commit)
    jobs, honest_artifact, offline_artifact = validate_run(run)

    with tempfile.TemporaryDirectory() as temporary:
        temporary_root = Path(temporary)
        honest_zip = temporary_root / "honest.zip"
        offline_zip = temporary_root / "offline.zip"
        honest_zip.write_bytes(
            download(
                f"/repos/{REPOSITORY}/actions/artifacts/{honest_artifact['id']}/zip"
            )
        )
        offline_zip.write_bytes(
            download(
                f"/repos/{REPOSITORY}/actions/artifacts/{offline_artifact['id']}/zip"
            )
        )
        honest_root = temporary_root / "honest"
        offline_root = temporary_root / "offline"
        honest_root.mkdir()
        offline_root.mkdir()
        with zipfile.ZipFile(honest_zip) as archive:
            archive.extractall(honest_root)
        with zipfile.ZipFile(offline_zip) as archive:
            archive.extractall(offline_root)

        evidence_path = locate(honest_root, "evidence.json")
        junit_path = locate(honest_root, "junit.xml")
        evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
        if not isinstance(evidence, dict):
            raise RuntimeError("activation HonestCI evidence is not an object")
        junit = parse_junit(junit_path)
        if junit != {"tests": EXPECTED_TESTS, "failures": 0, "errors": 0, "skipped": 0}:
            raise RuntimeError(f"activation JUnit totals are unexpected: {junit}")

        statuses = [str(value).lower() for value in deep_values(evidence, "status")]
        if statuses and not any(value in {"pass", "passed", "success"} for value in statuses):
            raise RuntimeError(f"activation HonestCI evidence has no passing status: {statuses}")
        baseline_values: list[int] = []
        for key in ("baselineTests", "baseline_tests"):
            for value in deep_values(evidence, key):
                if isinstance(value, (int, float)):
                    baseline_values.append(int(value))
        if EXPECTED_TESTS not in baseline_values:
            raise RuntimeError(
                f"activation evidence does not report a 246-test baseline: {baseline_values}"
            )
        findings = deep_values(evidence, "findings")
        if any(isinstance(value, list) and value for value in findings):
            raise RuntimeError("activation HonestCI evidence contains findings")
        drops = deep_values(evidence, "dropPercent")
        if any(isinstance(value, (int, float)) and value != 0 for value in drops):
            raise RuntimeError("activation HonestCI evidence reports nonzero test-count drop")

        offline_path, offline = load_offline_report(offline_root)
        if offline.get("status") != "PASS":
            raise RuntimeError("activation offline evaluation did not pass")
        if int(offline.get("cases", -1)) != EXPECTED_OFFLINE_CASES:
            raise RuntimeError("activation offline case count changed")
        if int(offline.get("passed", -1)) != EXPECTED_OFFLINE_CASES:
            raise RuntimeError("activation offline evaluation did not pass every case")
        if int(offline.get("failed", -1)) != 0:
            raise RuntimeError("activation offline evaluation contains failures")
        if offline.get("resultSha256") != EXPECTED_OFFLINE_RESULT:
            raise RuntimeError("activation offline result digest changed")

        record = {
            "schema_version": 1,
            "kind": "honest_ci_baseline_activation",
            "baseline": {
                "tests": EXPECTED_TESTS,
                "sha256": baseline_sha,
                "status": "ACTIVE",
            },
            "source": {
                "commit": base_commit,
                "workflow_run_id": int(run["id"]),
                "workflow_name": str(run.get("name")),
                "workflow_run_number": int(run.get("run_number", 0)),
                "event": str(run.get("event")),
                "completed_at": str(run.get("updated_at")),
                "jobs": jobs,
            },
            "honest_ci": {
                "version": HONEST_CI_VERSION,
                "action_sha": HONEST_CI_ACTION_SHA,
                "status": "passed",
                "observed_tests": EXPECTED_TESTS,
                "baseline_tests": EXPECTED_TESTS,
                "failures": 0,
                "errors": 0,
                "skipped": 0,
                "drop_percent": 0,
                "findings": [],
                "artifact": artifact_record(honest_artifact),
                "junit_sha256": sha256_file(junit_path),
                "evidence_json_sha256": sha256_file(evidence_path),
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
                "Activation closes the internal test-count baseline loop. It does not prove "
                "assertion quality, external adoption, or independent validation."
            ),
        }
        record_path = ROOT / ".honest-ci" / "evidence" / "baseline-246-activation.json"
        record_path.parent.mkdir(parents=True, exist_ok=True)
        record_path.write_text(
            json.dumps(record, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
            newline="\n",
        )

        proposal_path = ROOT / "docs" / "HONEST_CI_BASELINE_246.md"
        proposal = proposal_path.read_text(encoding="utf-8")
        proposal = proposal.replace(
            "**Status: proposed; activation pending.**",
            "**Status: active on the default branch.**",
            1,
        )
        activation_marker = "## Activation evidence"
        if activation_marker not in proposal:
            proposal += f"""

## Activation evidence

```text
commit: {base_commit}
workflow run: {run['id']}
workflow event: {run.get('event')}
HonestCI status: passed
observed tests: {EXPECTED_TESTS}
baseline tests: {EXPECTED_TESTS}
dropPercent: 0
findings: []
HonestCI artifact ID: {honest_artifact['id']}
HonestCI artifact digest: {honest_artifact['digest']}
JUnit SHA-256: {sha256_file(junit_path)}
evidence JSON SHA-256: {sha256_file(evidence_path)}
baseline SHA-256: {baseline_sha}
offline artifact ID: {offline_artifact['id']}
offline artifact digest: {offline_artifact['digest']}
offline report SHA-256: {sha256_file(offline_path)}
offline result digest: {offline['resultSha256']}
```

The same run passed the complete Ubuntu/Windows and Node 22.19/24 matrix. This closes
the 246-test activation loop without changing thresholds, product behavior, or the frozen
offline corpus.
"""
        proposal_path.write_text(proposal, encoding="utf-8", newline="\n")

        changelog_path = ROOT / "CHANGELOG.md"
        changelog = changelog_path.read_text(encoding="utf-8")
        marker = "- The 246-test HonestCI baseline is active"
        if marker not in changelog:
            insertion = (
                f"{marker}: default-branch run `{run['id']}` observed 246 tests against 246 "
                "with zero drop or findings, passed the complete runtime matrix, and reproduced "
                "the unchanged 42-case offline digest.\n"
            )
            heading = "### Changed\n\n"
            if heading not in changelog:
                raise RuntimeError("CHANGELOG.md has no Changed section")
            changelog = changelog.replace(heading, heading + insertion, 1)
            changelog_path.write_text(changelog, encoding="utf-8", newline="\n")


def dispatch_and_wait_for_post_merge(merge_sha: str) -> None:
    api(
        "POST",
        f"/repos/{REPOSITORY}/actions/workflows/ci.yml/dispatches",
        {"ref": "main"},
        accept_empty=True,
    )
    deadline = time.monotonic() + 900
    while time.monotonic() < deadline:
        payload = api(
            "GET",
            f"/repos/{REPOSITORY}/actions/runs?branch=main&per_page=100",
        )
        runs = [
            run
            for run in payload.get("workflow_runs", [])
            if run.get("head_sha") == merge_sha and run.get("name") == "CI"
        ]
        for run in runs:
            if run.get("status") == "completed":
                if run.get("conclusion") != "success":
                    raise RuntimeError(
                        f"post-merge activation CI failed: {run.get('id')} / {run.get('conclusion')}"
                    )
                return
        time.sleep(15)
    raise RuntimeError("timed out waiting for post-merge activation CI")


def finalize() -> None:
    pull_request = int(os.environ["PULL_REQUEST_NUMBER"])
    branch = os.environ["HEAD_REF"]
    record = json.loads(
        (ROOT / ".honest-ci" / "evidence" / "baseline-246-activation.json").read_text(
            encoding="utf-8"
        )
    )
    if record["baseline"]["status"] != "ACTIVE":
        raise RuntimeError("activation record is not active")

    subprocess.run(
        [
            "git",
            "rm",
            ".github/activate-honest-ci-baseline-246.py",
            ".github/workflows/activate-honest-ci-baseline-246.yml",
        ],
        check=True,
    )
    subprocess.run(["git", "config", "user.name", "github-actions[bot]"], check=True)
    subprocess.run(
        [
            "git",
            "config",
            "user.email",
            "41898282+github-actions[bot]@users.noreply.github.com",
        ],
        check=True,
    )
    subprocess.run(
        ["git", "commit", "-m", "docs: activate the 246-test HonestCI baseline"],
        check=True,
    )
    subprocess.run(["git", "push", "origin", f"HEAD:{branch}"], check=True)
    head_sha = git("rev-parse", "HEAD")

    deadline = time.monotonic() + 180
    merge_sha: str | None = None
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            result = api(
                "PUT",
                f"/repos/{REPOSITORY}/pulls/{pull_request}/merge",
                {
                    "sha": head_sha,
                    "merge_method": "squash",
                    "commit_title": (
                        f"docs: activate the 246-test HonestCI baseline (#{pull_request})"
                    ),
                    "commit_message": (
                        "Record the first successful default-branch execution of the 246-test "
                        "baseline, bind its HonestCI and offline artifacts, and close the "
                        "activation loop without changing product behavior or thresholds."
                    ),
                },
            )
            if result.get("merged") is True:
                merge_sha = str(result["sha"])
                break
            last_error = RuntimeError(str(result))
        except urllib.error.HTTPError as error:
            last_error = error
        time.sleep(10)
    if merge_sha is None:
        raise RuntimeError(f"could not merge activation pull request: {last_error}")
    dispatch_and_wait_for_post_merge(merge_sha)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("prepare", "finalize"))
    args = parser.parse_args()
    if args.mode == "prepare":
        prepare()
    else:
        finalize()


if __name__ == "__main__":
    main()
