from __future__ import annotations

import json
import os
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
            "User-Agent": "dsh-plugin-verified-search-projection-parser-finalizer",
        },
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        body = response.read()
    if not body and accept_empty:
        return {}
    return {} if not body else json.loads(body)


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], text=True).strip()


def verify_worktree() -> tuple[int, int, bool]:
    source_path = ROOT / "src" / "json-projection.ts"
    source = source_path.read_text(encoding="utf-8")
    size = source_path.stat().st_size
    if size > 25_000:
        raise RuntimeError(f"projection parser migration did not shrink the module enough: {size}")
    if "from './json-primitives.js'" not in source:
        raise RuntimeError("projection module does not import the shared JSON primitives")
    if "class StrictJsonScanner" in source:
        raise RuntimeError("projection module still contains its private strict JSON scanner")
    for required in (
        "decodeSharedJsonInput",
        "parseSharedStrictJson",
        "scanSharedStrictJson",
        "JSON_PROJECTION_PRIMITIVE_ERROR_CODES",
    ):
        if required not in source:
            raise RuntimeError(f"projection module is missing {required}")

    architecture = json.loads((ROOT / "architecture.json").read_text(encoding="utf-8"))
    exceptions = architecture["size_exceptions"]
    projection_exception = any(entry["path"] == "src/json-projection.ts" for entry in exceptions)
    if size <= int(architecture["default_module_max_bytes"]) and projection_exception:
        raise RuntimeError("projection exception remains even though the module fits the default budget")
    if size > int(architecture["default_module_max_bytes"]) and not projection_exception:
        raise RuntimeError("projection module exceeds the default budget without a growth stop")
    if len(exceptions) not in {4, 5}:
        raise RuntimeError(f"expected four or five remaining size exceptions, found {len(exceptions)}")

    capabilities = json.loads((ROOT / "capabilities.json").read_text(encoding="utf-8"))
    if capabilities["architecture_contract"]["size_exception_count"] != len(exceptions):
        raise RuntimeError("capabilities size-exception count is stale")
    docs = (ROOT / "docs" / "ARCHITECTURE.md").read_text(encoding="utf-8")
    if "selector and projection parser migrations complete" not in docs:
        raise RuntimeError("architecture documentation does not record the projection parser migration")
    changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    if "json-projection.ts` now delegates bounded decoding and strict JSON scanning" not in changelog:
        raise RuntimeError("changelog does not record the projection parser migration")
    return size, len(exceptions), projection_exception


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
                failures = {
                    name: jobs[name]
                    for name in EXPECTED_JOBS
                    if jobs[name] != "success"
                }
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


def merge(head_sha: str, size: int, projection_exception: bool) -> str:
    deadline = time.monotonic() + 240
    last_error: Exception | None = None
    exception_summary = (
        "The remaining repair-aware pointer boundary stays under its existing growth stop."
        if projection_exception
        else "The module now fits the default budget and its growth stop is removed."
    )
    while time.monotonic() < deadline:
        try:
            result = api(
                "PUT",
                f"/repos/{REPOSITORY}/pulls/{PULL_REQUEST}/merge",
                {
                    "sha": head_sha,
                    "merge_method": "squash",
                    "commit_title": (
                        f"refactor: migrate projection parsing to shared JSON primitives (#{PULL_REQUEST})"
                    ),
                    "commit_message": (
                        "Delegate bounded input decoding, Unicode validation, and strict JSON "
                        "scanning to the shared engine primitives while preserving repair-aware "
                        f"pointer audits, source order, and nested scalar projection. The module is {size} bytes. "
                        + exception_summary
                    ),
                },
            )
            if result.get("merged") is True:
                return str(result["sha"])
            last_error = RuntimeError(str(result))
        except urllib.error.HTTPError as error:
            last_error = error
        time.sleep(10)
    raise RuntimeError(f"could not merge validated projection parser migration: {last_error}")


def main() -> None:
    size, _, projection_exception = verify_worktree()
    subprocess.run(
        [
            "git",
            "rm",
            ".github/refactor-json-projection-primitives.mjs",
            ".github/finalize-json-projection-primitives.py",
            ".github/workflows/refactor-json-projection-primitives.yml",
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
        ["git", "commit", "-m", "refactor: migrate projection parsing to shared JSON primitives"],
        check=True,
    )
    subprocess.run(["git", "push", "origin", f"HEAD:{BRANCH}"], check=True)
    head_sha = git("rev-parse", "HEAD")
    wait_for_ci(head_sha, BRANCH, dispatch=True)
    merge_sha = merge(head_sha, size, projection_exception)
    wait_for_ci(merge_sha, "main", dispatch=True)


if __name__ == "__main__":
    main()
