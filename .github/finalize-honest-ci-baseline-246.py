from __future__ import annotations

import json
import os
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

REPOSITORY = os.environ["GITHUB_REPOSITORY"]
TOKEN = os.environ["GITHUB_TOKEN"]
PULL_REQUEST = int(os.environ["PULL_REQUEST_NUMBER"])
BRANCH = os.environ["HEAD_REF"]
ROOT = Path.cwd()
EXPECTED_JOBS = {
    "quality and package contract (Node 22.19)",
    "compatibility (ubuntu-latest, Node 24)",
    "compatibility (windows-latest, Node 22.19.0)",
    "compatibility (windows-latest, Node 24)",
}


def api(method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
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
            "User-Agent": "dsh-plugin-verified-search-baseline-finalizer",
        },
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        body = response.read()
    return {} if not body else json.loads(body)


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], text=True).strip()


def wait_for_parent_checks(parent_sha: str) -> None:
    deadline = time.monotonic() + 600
    last: dict[str, tuple[str, str | None]] = {}
    while time.monotonic() < deadline:
        payload = api(
            "GET",
            f"/repos/{REPOSITORY}/commits/{parent_sha}/check-runs?per_page=100",
        )
        runs = payload.get("check_runs", [])
        last = {
            str(run["name"]): (str(run["status"]), run.get("conclusion"))
            for run in runs
        }
        if EXPECTED_JOBS <= set(last):
            selected = {name: last[name] for name in EXPECTED_JOBS}
            if all(status == "completed" for status, _ in selected.values()):
                failures = {
                    name: conclusion
                    for name, (_, conclusion) in selected.items()
                    if conclusion != "success"
                }
                if failures:
                    raise RuntimeError(f"trusted parent CI did not pass: {failures}")
                return
        time.sleep(10)
    raise RuntimeError(f"timed out waiting for trusted parent CI checks: {last}")


def verify_proposal() -> None:
    baseline = json.loads((ROOT / ".honest-ci" / "baseline.json").read_text(encoding="utf-8"))
    if baseline["reports"]["unit"] != {
        "tests": 246,
        "failures": 0,
        "errors": 0,
        "skipped": 0,
    }:
        raise RuntimeError("the proposed baseline is not the expected 246-test zero-failure record")
    evidence_path = ROOT / ".honest-ci" / "evidence" / "baseline-246-strict-json-primitives.json"
    evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
    if evidence["source"]["workflow_run_id"] != 31938769457:
        raise RuntimeError("baseline evidence is not bound to the trusted post-merge run")
    if evidence["source"]["commit"] != "7ede47e60236cf105039204de316e324f719b24a":
        raise RuntimeError("baseline evidence is not bound to the strict-JSON merge commit")
    if evidence["baseline"]["activation_status"] != "PENDING_DEFAULT_BRANCH_RUN":
        raise RuntimeError("baseline proposal incorrectly claims activation")
    if not (ROOT / "docs" / "HONEST_CI_BASELINE_246.md").is_file():
        raise RuntimeError("human-readable baseline evidence is missing")


def commit_without_finalizer() -> str:
    workflow = ".github/workflows/finalize-honest-ci-baseline-246.yml"
    script = ".github/finalize-honest-ci-baseline-246.py"
    subprocess.run(["git", "rm", workflow, script], check=True)
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
        ["git", "commit", "-m", "ci: finalize 246-test baseline proposal"],
        check=True,
    )
    subprocess.run(["git", "push", "origin", f"HEAD:{BRANCH}"], check=True)
    return git("rev-parse", "HEAD")


def merge(sha: str) -> None:
    deadline = time.monotonic() + 180
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        pull = api("GET", f"/repos/{REPOSITORY}/pulls/{PULL_REQUEST}")
        if pull.get("state") != "open":
            if pull.get("merged"):
                return
            raise RuntimeError("baseline pull request closed without merging")
        try:
            result = api(
                "PUT",
                f"/repos/{REPOSITORY}/pulls/{PULL_REQUEST}/merge",
                {
                    "sha": sha,
                    "merge_method": "squash",
                    "commit_title": "ci: advance HonestCI baseline after strict JSON refactor (#14)",
                    "commit_message": (
                        "Advance the internal HonestCI baseline from 242 to 246 tests using "
                        "hash-bound evidence from completed main run 31938769457. Activation "
                        "remains pending the first later main run that observes 246 against 246."
                    ),
                },
            )
            if result.get("merged") is True:
                return
            last_error = RuntimeError(str(result))
        except urllib.error.HTTPError as error:
            last_error = error
        time.sleep(10)
    raise RuntimeError(f"could not merge the validated baseline pull request: {last_error}")


def main() -> None:
    verify_proposal()
    parent_sha = git("rev-parse", "HEAD^")
    wait_for_parent_checks(parent_sha)
    final_sha = commit_without_finalizer()
    merge(final_sha)


if __name__ == "__main__":
    main()
