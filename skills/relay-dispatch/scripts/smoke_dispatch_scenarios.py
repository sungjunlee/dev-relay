#!/usr/bin/env python3
"""Run repeatable smoke scenarios for relay-dispatch manifest behavior."""

from __future__ import annotations

import json
import pathlib
import re
import shutil
import subprocess
import tempfile


ROOT = pathlib.Path(__file__).resolve().parents[3]
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


def write_rubric(repo: pathlib.Path) -> pathlib.Path:
    rubric = repo.parent / "smoke-rubric.yaml"
    rubric.write_text(
        "rubric:\n"
        "  factors:\n"
        "    - name: smoke validation\n"
        "      target: command exits cleanly\n",
        encoding="utf-8",
    )
    return rubric


def read_dispatch_metadata(stdout: str) -> tuple[str | None, str | None, str | None, str | None]:
    status_match = re.search(r"--- Dispatch ([a-z-]+) \(", stdout)
    manifest_match = re.search(r"Manifest: (.+)", stdout)
    state_match = re.search(r"Run state: ([a-z_]+)", stdout)
    worktree_match = re.search(r"Worktree: (.+)", stdout)
    dispatch_status = status_match.group(1).strip() if status_match else None
    manifest_path = manifest_match.group(1).strip() if manifest_match else None
    run_state = state_match.group(1).strip() if state_match else None
    worktree_path = worktree_match.group(1).strip() if worktree_match else None
    return dispatch_status, manifest_path, run_state, worktree_path


def cleanup_worktree(repo: pathlib.Path, worktree_path: str | None) -> bool:
    if not worktree_path:
        return False
    worktree = pathlib.Path(worktree_path)
    if not worktree.exists():
        return False
    run(["git", "worktree", "remove", "--force", str(worktree)], repo)
    return not worktree.exists()


def scenario_success() -> dict:
    repo = init_repo("relay-smoke-success")
    rubric = write_rubric(repo)
    prompt = (
        "In this repository, create a file named smoke.txt with the single line ok. "
        "Commit the change. Do not open a pull request."
    )
    result = run(
        [
            "node",
            str(DISPATCH),
            str(repo),
            "-b",
            "issue-7",
            "--prompt",
            prompt,
            "--timeout",
            "300",
            "--rubric-file",
            str(rubric),
        ],
        ROOT,
    )
    dispatch_status, manifest_path, run_state, worktree_path = read_dispatch_metadata(result.stdout)
    manifest_text = pathlib.Path(manifest_path).read_text(encoding="utf-8") if manifest_path else ""
    smoke_exists = (repo / ".relay").exists()
    branch_tip = run(["git", "rev-parse", "--verify", "issue-7"], repo).stdout.strip()
    worktree_exists = pathlib.Path(worktree_path).exists() if worktree_path else False
    passed = (
        result.returncode == 0
        and dispatch_status == "completed"
        and run_state == "review_pending"
        and "state: 'review_pending'" in manifest_text
        and bool(branch_tip)
        and "cleanup: 'on_close'" in manifest_text
        and worktree_exists
    )
    output = {
        "name": "success_with_commit",
        "passed": passed,
        "returncode": result.returncode,
        "dispatch_status": dispatch_status,
        "run_state": run_state,
        "manifest_path": manifest_path,
        "worktree_path": worktree_path,
        "manifest_contains_review_pending": "state: 'review_pending'" in manifest_text,
        "manifest_contains_on_close_cleanup": "cleanup: 'on_close'" in manifest_text,
        "repo_has_manifest_dir": smoke_exists,
        "worktree_exists_after_dispatch": worktree_exists,
        "branch_tip": branch_tip,
        "stdout_tail": result.stdout[-1200:],
    }
    output["cleanup_succeeded"] = cleanup_worktree(repo, worktree_path)
    shutil.rmtree(repo.parent, ignore_errors=True)
    return output


def scenario_noop_review_pending() -> dict:
    repo = init_repo("relay-smoke-fail")
    rubric = write_rubric(repo)
    prompt = (
        "Inspect the repository but do not change any files, do not create any commits, "
        "and do not open a pull request."
    )
    result = run(
        [
            "node",
            str(DISPATCH),
            str(repo),
            "-b",
            "issue-8",
            "--prompt",
            prompt,
            "--timeout",
            "180",
            "--rubric-file",
            str(rubric),
        ],
        ROOT,
    )
    dispatch_status, manifest_path, run_state, worktree_path = read_dispatch_metadata(result.stdout)
    manifest_text = pathlib.Path(manifest_path).read_text(encoding="utf-8") if manifest_path else ""
    worktree_exists = pathlib.Path(worktree_path).exists() if worktree_path else False
    passed = (
        result.returncode == 0
        and dispatch_status == "completed-no-op"
        and run_state == "review_pending"
        and "state: 'review_pending'" in manifest_text
        and "cleanup: 'on_close'" in manifest_text
        and worktree_exists
    )
    output = {
        "name": "noop_review_pending",
        "passed": passed,
        "returncode": result.returncode,
        "dispatch_status": dispatch_status,
        "run_state": run_state,
        "manifest_path": manifest_path,
        "worktree_path": worktree_path,
        "manifest_contains_review_pending": "state: 'review_pending'" in manifest_text,
        "manifest_contains_on_close_cleanup": "cleanup: 'on_close'" in manifest_text,
        "worktree_exists_after_dispatch": worktree_exists,
        "stdout_tail": result.stdout[-1200:],
    }
    output["cleanup_succeeded"] = cleanup_worktree(repo, worktree_path)
    shutil.rmtree(repo.parent, ignore_errors=True)
    return output


def main() -> None:
    report = {
        "success_with_commit": scenario_success(),
        "noop_review_pending": scenario_noop_review_pending(),
    }
    report["all_passed"] = all(item["passed"] for item in report.values())
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
