#!/usr/bin/env python3
"""Run repeatable smoke scenarios for relay-dispatch manifest behavior."""

from __future__ import annotations

import json
import pathlib
import re
import shutil
import subprocess
import tempfile


ROOT = pathlib.Path("/Users/sjlee/workspace/active/harness-stack/dev-relay")
DISPATCH = ROOT / "skills/relay-dispatch/scripts/dispatch.js"


def run(cmd: list[str], cwd: pathlib.Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=cwd, text=True, capture_output=True, check=False)


def init_repo(name: str) -> pathlib.Path:
    base = pathlib.Path(tempfile.mkdtemp(prefix=f"{name}-"))
    repo = base / "repo"
    repo.mkdir()
    run(["git", "init", "-b", "main"], repo)
    run(["git", "config", "user.name", "Relay Smoke"], repo)
    run(["git", "config", "user.email", "relay-smoke@example.com"], repo)
    (repo / "README.md").write_text("# Smoke\n", encoding="utf-8")
    run(["git", "add", "README.md"], repo)
    run(["git", "commit", "-m", "init"], repo)
    return repo


def read_manifest_from_stdout(stdout: str) -> tuple[str | None, str | None]:
    manifest_match = re.search(r"Manifest: (.+)", stdout)
    state_match = re.search(r"Run state: ([a-z_]+)", stdout)
    manifest_path = manifest_match.group(1).strip() if manifest_match else None
    run_state = state_match.group(1).strip() if state_match else None
    return manifest_path, run_state


def scenario_success() -> dict:
    repo = init_repo("relay-smoke-success")
    prompt = (
        "In this repository, create a file named smoke.txt with the single line ok. "
        "Commit the change. Do not open a pull request."
    )
    result = run(
        ["node", str(DISPATCH), str(repo), "-b", "issue-7", "--prompt", prompt, "--timeout", "300"],
        ROOT,
    )
    manifest_path, run_state = read_manifest_from_stdout(result.stdout)
    manifest_text = pathlib.Path(manifest_path).read_text(encoding="utf-8") if manifest_path else ""
    smoke_exists = (repo / ".relay").exists()
    branch_tip = run(["git", "rev-parse", "--verify", "issue-7"], repo).stdout.strip()
    passed = (
        result.returncode == 0
        and run_state == "review_pending"
        and "state: 'review_pending'" in manifest_text
        and bool(branch_tip)
    )
    output = {
        "name": "success_with_commit",
        "passed": passed,
        "returncode": result.returncode,
        "run_state": run_state,
        "manifest_path": manifest_path,
        "manifest_contains_review_pending": "state: 'review_pending'" in manifest_text,
        "repo_has_manifest_dir": smoke_exists,
        "branch_tip": branch_tip,
        "stdout_tail": result.stdout[-1200:],
    }
    shutil.rmtree(repo.parent, ignore_errors=True)
    return output


def scenario_noop_failure() -> dict:
    repo = init_repo("relay-smoke-fail")
    prompt = (
        "Inspect the repository but do not change any files, do not create any commits, "
        "and do not open a pull request."
    )
    result = run(
        ["node", str(DISPATCH), str(repo), "-b", "issue-8", "--prompt", prompt, "--timeout", "180"],
        ROOT,
    )
    manifest_path, run_state = read_manifest_from_stdout(result.stdout)
    manifest_text = pathlib.Path(manifest_path).read_text(encoding="utf-8") if manifest_path else ""
    passed = (
        result.returncode != 0
        and run_state == "escalated"
        and "state: 'escalated'" in manifest_text
    )
    output = {
        "name": "noop_escalates",
        "passed": passed,
        "returncode": result.returncode,
        "run_state": run_state,
        "manifest_path": manifest_path,
        "manifest_contains_escalated": "state: 'escalated'" in manifest_text,
        "stdout_tail": result.stdout[-1200:],
    }
    shutil.rmtree(repo.parent, ignore_errors=True)
    return output


def main() -> None:
    report = {
        "success_with_commit": scenario_success(),
        "noop_escalates": scenario_noop_failure(),
    }
    report["all_passed"] = all(item["passed"] for item in report.values())
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
