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
            "User-Agent": "dsh-plugin-verified-search-research-lane-finalizer",
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
    lane = ROOT / "src" / "research-lane.ts"
    if not lane.is_file():
        raise RuntimeError("research lane module is missing")
    research_text = research.read_text(encoding="utf-8")
    lane_text = lane.read_text(encoding="utf-8")
    research_size = research.stat().st_size
    lane_size = lane.stat().st_size
    if lane_size > 20_000:
        raise RuntimeError(f"research lane module exceeds the default budget: {lane_size}")
    if "from './research-lane.js'" not in research_text:
        raise RuntimeError("research.ts does not import the lane execution boundary")
    if "from './research.js'" in lane_text:
        raise RuntimeError("research lane module imports research.ts and creates a cycle")
    if "Bounded research lane execution" not in lane_text:
        raise RuntimeError("research lane module lacks its boundary documentation")
    for pattern in (r"ctx\.effect", r"ctx\.plugin", r"new\s+Tool", r"\.tool\s*\("):
        if re.search(pattern, lane_text):
            raise RuntimeError(f"research lane boundary contains Harness lifecycle behavior: {pattern}")
    for forbidden in ("formatResearch", "presentResearch", "renderMarkdown"):
        if forbidden in lane_text:
            raise RuntimeError(f"research lane boundary contains final presentation behavior: {forbidden}")

    architecture = json.loads((ROOT / "architecture.json").read_text(encoding="utf-8"))
    harness = next(layer for layer in architecture["layers"] if layer["name"] == "harness")
    if "src/research-lane.ts" not in harness["files"]:
        raise RuntimeError("research lane module is not classified in the harness layer")
    exceptions = architecture["size_exceptions"]
    if not any(entry["path"] == "src/research.ts" for entry in exceptions):
        raise RuntimeError("research.ts growth stop disappeared before aggregation was extracted")
    if any(entry["path"] == "src/research-lane.ts" for entry in exceptions):
        raise RuntimeError("research lane module unexpectedly has a size exception")
    if len(exceptions) != 4:
        raise RuntimeError(f"expected four remaining size exceptions, found {len(exceptions)}")

    capabilities = json.loads((ROOT / "capabilities.json").read_text(encoding="utf-8"))
    if capabilities["architecture_contract"]["size_exception_count"] != 4:
        raise RuntimeError("capabilities size-exception count is stale")
    docs = (ROOT / "docs" / "ARCHITECTURE.md").read_text(encoding="utf-8")
    if "Research lane execution — complete" not in docs:
        raise RuntimeError("architecture documentation does not close lane execution")
    changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    if "Provider/search/fetch work and lane-local timeout" not in changelog:
        raise RuntimeError("changelog does not describe the lane extraction")
    return research_size, lane_size


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


def merge(head_sha: str, research_size: int, lane_size: int) -> str:
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
                    "commit_title": f"refactor: extract bounded research lane execution (#{PULL_REQUEST})",
                    "commit_message": (
                        "Move provider/search/fetch work, lane-local source limits, timeout and "
                        "abort handling, and source materialization into an independently bounded "
                        f"module. research.ts is {research_size} bytes and research-lane.ts is "
                        f"{lane_size} bytes; aggregation, presentation, and Harness lifecycle remain unchanged."
                    ),
                },
            )
            if result.get("merged") is True:
                return str(result["sha"])
            last_error = RuntimeError(str(result))
        except urllib.error.HTTPError as error:
            last_error = error
        time.sleep(10)
    raise RuntimeError(f"could not merge validated lane extraction: {last_error}")


def main() -> None:
    research_size, lane_size = verify_worktree()
    subprocess.run(
        [
            "git",
            "rm",
            ".github/extract-research-lane.mjs",
            ".github/finalize-research-lane.py",
            ".github/workflows/extract-research-lane.yml",
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
    subprocess.run(["git", "commit", "-m", "refactor: extract bounded research lane execution"], check=True)
    subprocess.run(["git", "push", "origin", f"HEAD:{BRANCH}"], check=True)
    head_sha = git("rev-parse", "HEAD")
    wait_for_ci(head_sha, BRANCH, dispatch=True)
    merge_sha = merge(head_sha, research_size, lane_size)
    wait_for_ci(merge_sha, "main", dispatch=True)


if __name__ == "__main__":
    main()
