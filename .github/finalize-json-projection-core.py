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
            "User-Agent": "dsh-plugin-verified-search-projection-core-finalizer",
        },
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        body = response.read()
    if not body and accept_empty:
        return {}
    return {} if not body else json.loads(body)


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], text=True).strip()


def verify_worktree() -> tuple[int, int, int]:
    wrapper = ROOT / "src" / "json-projection.ts"
    core = ROOT / "src" / "json-projection-core.ts"
    if not core.is_file():
        raise RuntimeError("projection core module is missing")
    wrapper_text = wrapper.read_text(encoding="utf-8")
    core_text = core.read_text(encoding="utf-8")
    wrapper_size = wrapper.stat().st_size
    core_size = core.stat().st_size
    if wrapper_size > 20_000 or core_size > 20_000:
        raise RuntimeError(
            f"projection modules exceed the default budget: wrapper={wrapper_size}, core={core_size}"
        )
    if "from './json-projection-core.js'" not in wrapper_text:
        raise RuntimeError("projection wrapper does not import its extracted core")
    if "from './json-projection.js'" in core_text:
        raise RuntimeError("projection core imports the wrapper and would create a cycle")
    if "Repair-aware pointer resolution and nested projection core" not in core_text:
        raise RuntimeError("projection core lacks its boundary documentation")

    architecture = json.loads((ROOT / "architecture.json").read_text(encoding="utf-8"))
    engine = next(layer for layer in architecture["layers"] if layer["name"] == "engine")
    if "src/json-projection-core.ts" not in engine["files"]:
        raise RuntimeError("projection core is not classified in the engine layer")
    exceptions = architecture["size_exceptions"]
    if any(entry["path"] == "src/json-projection.ts" for entry in exceptions):
        raise RuntimeError("projection wrapper still has a size exception")
    if any(entry["path"] == "src/json-projection-core.ts" for entry in exceptions):
        raise RuntimeError("projection core unexpectedly has a size exception")
    if len(exceptions) != 4:
        raise RuntimeError(f"expected four remaining size exceptions, found {len(exceptions)}")

    capabilities = json.loads((ROOT / "capabilities.json").read_text(encoding="utf-8"))
    if capabilities["architecture_contract"]["size_exception_count"] != 4:
        raise RuntimeError("capabilities metadata does not report four remaining exceptions")
    docs = (ROOT / "docs" / "ARCHITECTURE.md").read_text(encoding="utf-8")
    if "JSON selector and projection decomposition — complete" not in docs:
        raise RuntimeError("architecture documentation does not close projection decomposition")
    changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    if "Repair-aware pointer resolution and nested source-order projection now live" not in changelog:
        raise RuntimeError("changelog does not describe the projection core extraction")
    return wrapper_size, core_size, len(exceptions)


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


def merge(head_sha: str, wrapper_size: int, core_size: int) -> str:
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
                        f"refactor: extract repair-aware projection core (#{PULL_REQUEST})"
                    ),
                    "commit_message": (
                        "Move repair-aware pointer resolution and nested source-order projection "
                        "into an independently bounded engine module while preserving public "
                        f"exports and errors. The wrapper is {wrapper_size} bytes and the core is "
                        f"{core_size} bytes; both fit the default budget and remove the projection growth stop."
                    ),
                },
            )
            if result.get("merged") is True:
                return str(result["sha"])
            last_error = RuntimeError(str(result))
        except urllib.error.HTTPError as error:
            last_error = error
        time.sleep(10)
    raise RuntimeError(f"could not merge validated projection core extraction: {last_error}")


def main() -> None:
    wrapper_size, core_size, _ = verify_worktree()
    subprocess.run(
        [
            "git",
            "rm",
            ".github/extract-json-projection-core.mjs",
            ".github/finalize-json-projection-core.py",
            ".github/workflows/extract-json-projection-core.yml",
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
        ["git", "commit", "-m", "refactor: extract repair-aware projection core"],
        check=True,
    )
    subprocess.run(["git", "push", "origin", f"HEAD:{BRANCH}"], check=True)
    head_sha = git("rev-parse", "HEAD")
    wait_for_ci(head_sha, BRANCH, dispatch=True)
    merge_sha = merge(head_sha, wrapper_size, core_size)
    wait_for_ci(merge_sha, "main", dispatch=True)


if __name__ == "__main__":
    main()
