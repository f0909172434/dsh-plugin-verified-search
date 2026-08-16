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
            "User-Agent": "dsh-plugin-verified-search-numeric-refactor-finalizer",
        },
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        body = response.read()
    if not body and accept_empty:
        return {}
    return {} if not body else json.loads(body)


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], text=True).strip()


def verify_worktree() -> None:
    source_path = ROOT / "src" / "json-numeric-selection.ts"
    source = source_path.read_text(encoding="utf-8")
    size = source_path.stat().st_size
    if size > 20_000:
        raise RuntimeError(f"numeric selector exceeds the default module budget: {size}")
    if "from './json-primitives.js'" not in source:
        raise RuntimeError("numeric selector does not import the shared strict-JSON primitives")
    if "class StrictJsonScanner" in source:
        raise RuntimeError("numeric selector still contains its private strict JSON scanner")
    for required in (
        "decodeSharedJsonInput",
        "parseSharedJsonPointer",
        "parseSharedStrictJson",
        "scanSharedStrictJson",
        "JSON_NUMERIC_PRIMITIVE_ERROR_CODES",
    ):
        if required not in source:
            raise RuntimeError(f"numeric selector is missing {required}")

    architecture = json.loads((ROOT / "architecture.json").read_text(encoding="utf-8"))
    exceptions = architecture["size_exceptions"]
    if any(entry["path"] == "src/json-numeric-selection.ts" for entry in exceptions):
        raise RuntimeError("numeric selector size exception was not removed")
    if len(exceptions) != 5:
        raise RuntimeError(f"expected five remaining architecture exceptions, found {len(exceptions)}")

    capabilities = json.loads((ROOT / "capabilities.json").read_text(encoding="utf-8"))
    if capabilities["architecture_contract"]["size_exception_count"] != 5:
        raise RuntimeError("capabilities metadata does not report five size exceptions")

    docs = (ROOT / "docs" / "ARCHITECTURE.md").read_text(encoding="utf-8")
    if "date and exact-number migrations complete" not in docs:
        raise RuntimeError("architecture documentation does not close the numeric migration")
    changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    if "json-numeric-selection.ts` now delegates shared strict-JSON validation" not in changelog:
        raise RuntimeError("changelog does not describe the numeric migration")


def wait_for_ci(commit_sha: str, ref: str, *, dispatch: bool) -> int:
    deadline = time.monotonic() + 1200
    dispatched = False
    last: dict[str, tuple[str, str | None]] = {}
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
                    raise RuntimeError(
                        f"CI run {run_id} failed with {run.get('conclusion')}"
                    )
                jobs_payload = api(
                    "GET",
                    f"/repos/{REPOSITORY}/actions/runs/{run_id}/jobs?per_page=100",
                )
                last = {
                    str(job["name"]): (str(job["status"]), job.get("conclusion"))
                    for job in jobs_payload.get("jobs", [])
                }
                missing = EXPECTED_JOBS - set(last)
                if missing:
                    raise RuntimeError(
                        f"successful CI run {run_id} is missing jobs: {sorted(missing)}"
                    )
                failures = {
                    name: last[name][1]
                    for name in EXPECTED_JOBS
                    if last[name][1] != "success"
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
    raise RuntimeError(f"timed out waiting for CI at {commit_sha}; last jobs={last}")


def merge(head_sha: str) -> str:
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
                        f"refactor: migrate exact-number selection to shared JSON primitives (#{PULL_REQUEST})"
                    ),
                    "commit_message": (
                        "Delegate bounded UTF-8, Unicode, duplicate-key/depth scanning, and "
                        "RFC 6901 parsing to the shared engine primitives while preserving "
                        "lossless number tokens, exact decimal comparison, public errors, and "
                        "the frozen 42-case evaluation result."
                    ),
                },
            )
            if result.get("merged") is True:
                return str(result["sha"])
            last_error = RuntimeError(str(result))
        except urllib.error.HTTPError as error:
            last_error = error
        time.sleep(10)
    raise RuntimeError(f"could not merge validated numeric refactor: {last_error}")


def main() -> None:
    verify_worktree()
    subprocess.run(
        [
            "git",
            "rm",
            ".github/refactor-json-numeric-selection.mjs",
            ".github/finalize-json-numeric-refactor.py",
            ".github/workflows/refactor-json-numeric-selection.yml",
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
        [
            "git",
            "commit",
            "-m",
            "refactor: migrate exact-number selection to shared JSON primitives",
        ],
        check=True,
    )
    subprocess.run(["git", "push", "origin", f"HEAD:{BRANCH}"], check=True)
    head_sha = git("rev-parse", "HEAD")
    wait_for_ci(head_sha, BRANCH, dispatch=True)
    merge_sha = merge(head_sha)
    wait_for_ci(merge_sha, "main", dispatch=True)


if __name__ == "__main__":
    import urllib.parse

    main()
