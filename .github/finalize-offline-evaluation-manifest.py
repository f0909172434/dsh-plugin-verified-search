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
            "User-Agent": "dsh-plugin-verified-search-offline-manifest-finalizer",
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
    dispatcher = ROOT / "src" / "offline-evaluation.ts"
    manifest = ROOT / "src" / "offline-evaluation-manifest.ts"
    if not manifest.is_file():
        raise RuntimeError("offline evaluation manifest module is missing")
    dispatcher_text = dispatcher.read_text(encoding="utf-8")
    manifest_text = manifest.read_text(encoding="utf-8")
    dispatcher_size = dispatcher.stat().st_size
    manifest_size = manifest.stat().st_size
    if dispatcher_size > 20_000 or manifest_size > 20_000:
        raise RuntimeError(
            f"offline evaluation modules exceed the default budget: dispatcher={dispatcher_size}, manifest={manifest_size}"
        )
    if "from './offline-evaluation-manifest.js'" not in dispatcher_text:
        raise RuntimeError("offline evaluator does not import the manifest boundary")
    if "from './offline-evaluation.js'" in manifest_text:
        raise RuntimeError("manifest module imports the dispatcher and creates a cycle")
    if "Frozen offline corpus manifest" not in manifest_text:
        raise RuntimeError("manifest module lacks its boundary documentation")
    for module_name in (
        "./domains.js",
        "./json-selection.js",
        "./json-numeric-selection.js",
        "./json-projection.js",
    ):
        if f"from '{module_name}'" in manifest_text:
            raise RuntimeError(f"manifest module imports capability execution module {module_name}")
    for pattern in (
        r"selectJson",
        r"projectJson",
        r"filterByAllowedDomains",
        r"selectNumeric",
        r"switch\s*\([^)]*operation",
    ):
        if re.search(pattern, manifest_text, flags=re.IGNORECASE):
            raise RuntimeError(f"manifest boundary contains operation dispatch: {pattern}")

    architecture = json.loads((ROOT / "architecture.json").read_text(encoding="utf-8"))
    engine = next(layer for layer in architecture["layers"] if layer["name"] == "engine")
    if "src/offline-evaluation-manifest.ts" not in engine["files"]:
        raise RuntimeError("offline manifest module is not classified in the engine layer")
    exceptions = architecture["size_exceptions"]
    if any(
        entry["path"] in {"src/offline-evaluation.ts", "src/offline-evaluation-manifest.ts"}
        for entry in exceptions
    ):
        raise RuntimeError("offline evaluator dispatcher or manifest retains an architecture exception")

    capabilities = json.loads((ROOT / "capabilities.json").read_text(encoding="utf-8"))
    if capabilities["architecture_contract"]["size_exception_count"] != len(exceptions):
        raise RuntimeError("capabilities size-exception count is stale")
    docs = (ROOT / "docs" / "ARCHITECTURE.md").read_text(encoding="utf-8")
    if "Offline evaluator parsing — complete" not in docs:
        raise RuntimeError("architecture documentation does not close offline evaluator parsing")
    changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    if "Frozen offline manifest/suite parsing and path/hash integrity now live" not in changelog:
        raise RuntimeError("changelog does not describe offline manifest extraction")
    return dispatcher_size, manifest_size, len(exceptions)


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


def merge(head_sha: str, dispatcher_size: int, manifest_size: int, exceptions: int) -> str:
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
                    "commit_title": f"refactor: isolate frozen offline corpus integrity (#{PULL_REQUEST})",
                    "commit_message": (
                        "Move manifest/suite parsing, immutable case loading, and path/hash integrity "
                        "into an independently bounded module while preserving capability dispatch, "
                        "exact expected-result comparison, report assembly, and the frozen result digest. "
                        f"offline-evaluation.ts is {dispatcher_size} bytes, offline-evaluation-manifest.ts "
                        f"is {manifest_size} bytes, and {exceptions} architecture growth stops remain."
                    ),
                },
            )
            if result.get("merged") is True:
                return str(result["sha"])
            last_error = RuntimeError(str(result))
        except urllib.error.HTTPError as error:
            last_error = error
        time.sleep(10)
    raise RuntimeError(f"could not merge validated offline manifest extraction: {last_error}")


def main() -> None:
    dispatcher_size, manifest_size, exceptions = verify_worktree()
    subprocess.run(
        [
            "git",
            "rm",
            ".github/extract-offline-evaluation-manifest.mjs",
            ".github/finalize-offline-evaluation-manifest.py",
            ".github/workflows/extract-offline-evaluation-manifest.yml",
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
    subprocess.run(["git", "commit", "-m", "refactor: isolate frozen offline corpus integrity"], check=True)
    subprocess.run(["git", "push", "origin", f"HEAD:{BRANCH}"], check=True)
    head_sha = git("rev-parse", "HEAD")
    wait_for_ci(head_sha, BRANCH, dispatch=True)
    merge_sha = merge(head_sha, dispatcher_size, manifest_size, exceptions)
    wait_for_ci(merge_sha, "main", dispatch=True)


if __name__ == "__main__":
    main()
