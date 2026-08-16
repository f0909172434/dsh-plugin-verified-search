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
            "User-Agent": "dsh-plugin-verified-search-evidence-attribution-finalizer",
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
    evidence = ROOT / "src" / "evidence.ts"
    attribution = ROOT / "src" / "evidence-attribution.ts"
    if not attribution.is_file():
        raise RuntimeError("evidence attribution module is missing")
    evidence_text = evidence.read_text(encoding="utf-8")
    attribution_text = attribution.read_text(encoding="utf-8")
    evidence_size = evidence.stat().st_size
    attribution_size = attribution.stat().st_size
    if evidence_size > 20_000 or attribution_size > 20_000:
        raise RuntimeError(
            f"evidence modules exceed the default budget: wrapper={evidence_size}, attribution={attribution_size}"
        )
    if "from './evidence-attribution.js'" not in evidence_text:
        raise RuntimeError("evidence.ts does not import the attribution boundary")
    if "from './evidence.js'" in attribution_text:
        raise RuntimeError("evidence attribution imports the wrapper and creates a cycle")
    if "Deterministic claim attribution and retained excerpt construction" not in attribution_text:
        raise RuntimeError("evidence attribution lacks its boundary documentation")
    for pattern in (
        r"createHash\s*\(",
        r"sha256",
        r"contentHash",
        r"buildEvidence",
        r"createEvidence",
    ):
        if re.search(pattern, attribution_text, flags=re.IGNORECASE):
            raise RuntimeError(f"attribution boundary contains hashing or assembly: {pattern}")

    architecture = json.loads((ROOT / "architecture.json").read_text(encoding="utf-8"))
    engine = next(layer for layer in architecture["layers"] if layer["name"] == "engine")
    if "src/evidence-attribution.ts" not in engine["files"]:
        raise RuntimeError("evidence attribution is not classified in the engine layer")
    exceptions = architecture["size_exceptions"]
    if any(entry["path"] in {"src/evidence.ts", "src/evidence-attribution.ts"} for entry in exceptions):
        raise RuntimeError("evidence wrapper or attribution retains an architecture exception")

    capabilities = json.loads((ROOT / "capabilities.json").read_text(encoding="utf-8"))
    if capabilities["architecture_contract"]["size_exception_count"] != len(exceptions):
        raise RuntimeError("capabilities size-exception count is stale")
    docs = (ROOT / "docs" / "ARCHITECTURE.md").read_text(encoding="utf-8")
    if "Claim attribution and retained excerpt construction now live" not in docs:
        raise RuntimeError("architecture documentation does not record evidence attribution")
    changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    if "Source-ordered claim attribution and byte-stable retained excerpt construction now live" not in changelog:
        raise RuntimeError("changelog does not describe evidence attribution")
    return evidence_size, attribution_size, len(exceptions)


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


def merge(head_sha: str, evidence_size: int, attribution_size: int, exceptions: int) -> str:
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
                    "commit_title": f"refactor: isolate evidence attribution and excerpts (#{PULL_REQUEST})",
                    "commit_message": (
                        "Move source-ordered claim attribution and byte-stable retained excerpt "
                        "construction into an independently bounded module while preserving HTML/text "
                        "normalization, content hashes, and top-level evidence assembly. "
                        f"evidence.ts is {evidence_size} bytes, evidence-attribution.ts is "
                        f"{attribution_size} bytes, and {exceptions} architecture growth stops remain."
                    ),
                },
            )
            if result.get("merged") is True:
                return str(result["sha"])
            last_error = RuntimeError(str(result))
        except urllib.error.HTTPError as error:
            last_error = error
        time.sleep(10)
    raise RuntimeError(f"could not merge validated evidence attribution: {last_error}")


def main() -> None:
    evidence_size, attribution_size, exceptions = verify_worktree()
    subprocess.run(
        [
            "git",
            "rm",
            ".github/extract-evidence-attribution.mjs",
            ".github/finalize-evidence-attribution.py",
            ".github/workflows/extract-evidence-attribution.yml",
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
    subprocess.run(["git", "commit", "-m", "refactor: isolate evidence attribution and excerpts"], check=True)
    subprocess.run(["git", "push", "origin", f"HEAD:{BRANCH}"], check=True)
    head_sha = git("rev-parse", "HEAD")
    wait_for_ci(head_sha, BRANCH, dispatch=True)
    merge_sha = merge(head_sha, evidence_size, attribution_size, exceptions)
    wait_for_ci(merge_sha, "main", dispatch=True)


if __name__ == "__main__":
    main()
