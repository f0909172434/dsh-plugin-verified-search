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
            "User-Agent": "dsh-plugin-verified-search-page-policy-finalizer",
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
    transport = ROOT / "src" / "page-fetch.ts"
    policy = ROOT / "src" / "page-fetch-policy.ts"
    if not policy.is_file():
        raise RuntimeError("page-fetch policy module is missing")
    transport_text = transport.read_text(encoding="utf-8")
    policy_text = policy.read_text(encoding="utf-8")
    transport_size = transport.stat().st_size
    policy_size = policy.stat().st_size
    if transport_size > 20_000 or policy_size > 20_000:
        raise RuntimeError(
            f"page-fetch modules exceed the default budget: transport={transport_size}, policy={policy_size}"
        )
    if "from './page-fetch-policy.js'" not in transport_text:
        raise RuntimeError("page-fetch transport does not import the address-policy boundary")
    if "from './page-fetch.js'" in policy_text:
        raise RuntimeError("page-fetch policy imports the transport and creates a cycle")
    if "Public-address and hostname resolution policy" not in policy_text:
        raise RuntimeError("page-fetch policy lacks its boundary documentation")
    for pattern in (
        r"https\.request",
        r"fetch\s*\(",
        r"TextDecoder",
        r"content-type",
        r"response\.body",
        r"location\s*:",
    ):
        if re.search(pattern, policy_text, flags=re.IGNORECASE):
            raise RuntimeError(f"address-policy boundary contains transport behavior: {pattern}")

    architecture = json.loads((ROOT / "architecture.json").read_text(encoding="utf-8"))
    engine = next(layer for layer in architecture["layers"] if layer["name"] == "engine")
    if "src/page-fetch-policy.ts" not in engine["files"]:
        raise RuntimeError("page-fetch policy is not classified in the engine layer")
    exceptions = architecture["size_exceptions"]
    if any(entry["path"] in {"src/page-fetch.ts", "src/page-fetch-policy.ts"} for entry in exceptions):
        raise RuntimeError("page-fetch transport or policy still has an architecture exception")

    capabilities = json.loads((ROOT / "capabilities.json").read_text(encoding="utf-8"))
    if capabilities["architecture_contract"]["size_exception_count"] != len(exceptions):
        raise RuntimeError("capabilities size-exception count is stale")
    docs = (ROOT / "docs" / "ARCHITECTURE.md").read_text(encoding="utf-8")
    if "Network policy and transport — complete" not in docs:
        raise RuntimeError("architecture documentation does not close network policy extraction")
    changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    if "Public-address and hostname-resolution policy now live" not in changelog:
        raise RuntimeError("changelog does not describe page-fetch policy extraction")
    return transport_size, policy_size, len(exceptions)


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


def merge(head_sha: str, transport_size: int, policy_size: int, exceptions: int) -> str:
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
                    "commit_title": f"refactor: isolate public-address page-fetch policy (#{PULL_REQUEST})",
                    "commit_message": (
                        "Move literal and DNS-resolved address classification into an independently "
                        "bounded module while preserving HTTPS requests, redirect state, response "
                        "limits, charset decoding, deadlines, and DNS-rebinding protection. "
                        f"page-fetch.ts is {transport_size} bytes, page-fetch-policy.ts is "
                        f"{policy_size} bytes, and {exceptions} architecture growth stops remain."
                    ),
                },
            )
            if result.get("merged") is True:
                return str(result["sha"])
            last_error = RuntimeError(str(result))
        except urllib.error.HTTPError as error:
            last_error = error
        time.sleep(10)
    raise RuntimeError(f"could not merge validated page-fetch policy extraction: {last_error}")


def main() -> None:
    transport_size, policy_size, exceptions = verify_worktree()
    subprocess.run(
        [
            "git",
            "rm",
            ".github/extract-page-fetch-policy.mjs",
            ".github/finalize-page-fetch-policy.py",
            ".github/workflows/extract-page-fetch-policy.yml",
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
    subprocess.run(["git", "commit", "-m", "refactor: isolate public-address page-fetch policy"], check=True)
    subprocess.run(["git", "push", "origin", f"HEAD:{BRANCH}"], check=True)
    head_sha = git("rev-parse", "HEAD")
    wait_for_ci(head_sha, BRANCH, dispatch=True)
    merge_sha = merge(head_sha, transport_size, policy_size, exceptions)
    wait_for_ci(merge_sha, "main", dispatch=True)


if __name__ == "__main__":
    main()
