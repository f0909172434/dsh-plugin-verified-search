from __future__ import annotations

import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.parse
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
            "User-Agent": "dsh-plugin-verified-search-research-request-finalizer",
        },
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        body = response.read()
    if not body and accept_empty:
        return {}
    return {} if not body else json.loads(body)


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], text=True).strip()


def verify_worktree() -> tuple[int, int]:
    research = ROOT / "src" / "research.ts"
    request = ROOT / "src" / "research-request.ts"
    if not request.is_file():
        raise RuntimeError("research request module is missing")
    research_text = research.read_text(encoding="utf-8")
    request_text = request.read_text(encoding="utf-8")
    research_size = research.stat().st_size
    request_size = request.stat().st_size
    if request_size > 20_000:
        raise RuntimeError(f"research request module exceeds the default budget: {request_size}")
    if research_size >= 60_500:
        raise RuntimeError(f"research.ts did not shrink enough: {research_size}")
    if "from './research-request.js'" not in research_text:
        raise RuntimeError("research.ts does not import the request boundary")
    if "from './research.js'" in request_text:
        raise RuntimeError("research request module imports research.ts and creates a cycle")
    forbidden = (
        r"\bfetch\s*\(",
        r"pageFetch",
        r"\.search\s*\(",
        r"\.request\s*\(",
        r"ctx\.effect",
        r"new\s+Tool",
    )
    for pattern in forbidden:
        if re.search(pattern, request_text):
            raise RuntimeError(f"research request boundary contains forbidden runtime behavior: {pattern}")

    architecture = json.loads((ROOT / "architecture.json").read_text(encoding="utf-8"))
    harness = next(layer for layer in architecture["layers"] if layer["name"] == "harness")
    if "src/research-request.ts" not in harness["files"]:
        raise RuntimeError("research request module is not classified in the harness layer")
    exceptions = architecture["size_exceptions"]
    if not any(entry["path"] == "src/research.ts" for entry in exceptions):
        raise RuntimeError("research.ts growth stop disappeared before lane execution was extracted")
    if any(entry["path"] == "src/research-request.ts" for entry in exceptions):
        raise RuntimeError("research request module unexpectedly has a size exception")
    if len(exceptions) != 4:
        raise RuntimeError(f"expected four remaining size exceptions, found {len(exceptions)}")

    capabilities = json.loads((ROOT / "capabilities.json").read_text(encoding="utf-8"))
    if capabilities["architecture_contract"]["size_exception_count"] != 4:
        raise RuntimeError("capabilities size-exception count is stale")
    docs = (ROOT / "docs" / "ARCHITECTURE.md").read_text(encoding="utf-8")
    if "Research request normalization — complete" not in docs:
        raise RuntimeError("architecture documentation does not close request normalization")
    changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    if "Research request schemas, validation, and normalized claim/lane inputs now live" not in changelog:
        raise RuntimeError("changelog does not describe the request extraction")
    return research_size, request_size


def wait_for_ci(commit_sha: str, ref: str, *, dispatch: bool) -> int:
    deadline = time.monotonic() + 1200
    dispatched = False
    while time.monotonic() < deadline:
        payload = api(
            "GET",
            f"/repos/{REPOSITORY}/actions/runs?branch={urllib.parse.quote(ref, safe='')}&per_page=100",
        )
        runs = [
            run
            for run in payload.get("workflow_runs", [])
            if run.get("head_sha") == commit_sha and run.get("name") == "CI"
        ]
        runs.sort(key=lambda run: str(run.get("created_at", "")), reverse=True)
        if runs:
            run = runs[0]
            run_id = int(run["id"])
            if run.get("status") == "completed":
                if run.get("conclusion") != "success":
                    raise RuntimeError(f"CI run {run_id} failed with {run.get('conclusion')}")
                jobs_payload = api(
                    "GET",
                    f"/repos/{REPOSITORY}/actions/runs/{run_id}/jobs?per_page=100",
                )
                jobs = {
                    str(job["name"]): str(job.get("conclusion"))
                    for job in jobs_payload.get("jobs", [])
                }
                missing = EXPECTED_JOBS - set(jobs)
                if missing:
                    raise RuntimeError(f"CI run {run_id} is missing jobs: {sorted(missing)}")
                failures = {name: jobs[name] for name in EXPECTED_JOBS if jobs[name] != "success"}
                if failures:
                    raise RuntimeError(f"CI matrix contains failures: {failures}")
                return run_id
        elif dispatch and not dispatched:
            api(
                "POST",
                f"/repos/{REPOSITORY}/actions/workflows/ci.yml/dispatches",
                {"ref": ref},
                accept_empty=True,
            )
            dispatched = True
        time.sleep(15)
    raise RuntimeError(f"timed out waiting for CI at {commit_sha}")


def merge(head_sha: str, research_size: int, request_size: int) -> str:
    deadline = time.monotonic() + 240
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            result = api(
                "PUT",
                f"/repos/{REPOSITORY}/pulls/{PULL_REQUEST}/merge",
                {
                    "sha": head_sha,
                    "merge_method": "squash",
                    "commit_title": (
                        f"refactor: extract research request normalization (#{PULL_REQUEST})"
                    ),
                    "commit_message": (
                        "Move model-facing request schemas, fail-closed validation, and normalized "
                        "claim/lane inputs into an independently bounded module without moving "
                        f"provider, network, aggregation, presentation, or Harness lifecycle work. "
                        f"research.ts is {research_size} bytes and research-request.ts is {request_size} bytes."
                    ),
                },
            )
            if result.get("merged") is True:
                return str(result["sha"])
            last_error = RuntimeError(str(result))
        except urllib.error.HTTPError as error:
            last_error = error
        time.sleep(10)
    raise RuntimeError(f"could not merge validated request extraction: {last_error}")


def main() -> None:
    research_size, request_size = verify_worktree()
    subprocess.run(
        [
            "git",
            "rm",
            ".github/extract-research-request.mjs",
            ".github/finalize-research-request.py",
            ".github/workflows/extract-research-request.yml",
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
    subprocess.run(["git", "add", "-A"], check=True)
    subprocess.run(
        ["git", "commit", "-m", "refactor: extract research request normalization"],
        check=True,
    )
    subprocess.run(["git", "push", "origin", f"HEAD:{BRANCH}"], check=True)
    head_sha = git("rev-parse", "HEAD")
    wait_for_ci(head_sha, BRANCH, dispatch=True)
    merge_sha = merge(head_sha, research_size, request_size)
    wait_for_ci(merge_sha, "main", dispatch=True)


if __name__ == "__main__":
    main()
