#!/usr/bin/env python3
"""Local supervisor loop for one-experiment-at-a-time Copilot runs.

This script is intended to be copied into an experiment workspace, usually
`experiments/experiment-loop.py`. It infers the workspace from its own directory.
Project-specific experiment behavior belongs in GOAL.md and BACKLOG.md.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import shlex
import subprocess
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


RESULT_LABELS = ("goal-met", "success", "neutral", "regression", "inconclusive")


@dataclass
class Config:
    base_branch: str
    branch_prefix: str
    project_name: str
    copilot_command: str
    catalog_uri: str
    catalog_project_name: str
    max_consecutive_failures: int
    reset_config_files: list[str]


def main() -> int:
    parser = argparse.ArgumentParser(description="Run automated experiment iterations.")
    parser.add_argument("--base-branch", help="Override loop.config.json base_branch.")
    parser.add_argument("--project-name", help="Override loop.config.json project_name.")
    parser.add_argument("--max-iterations", type=int, help="Maximum iterations for this invocation.")
    parser.add_argument("--dry-run", action="store_true", help="Print the next worker command without running it.")
    args = parser.parse_args()

    workspace = Path(__file__).resolve().parent
    config = load_config(workspace / "loop.config.json", args)
    repo_root = git_output(["rev-parse", "--show-toplevel"], cwd=workspace).strip()
    repo = Path(repo_root)

    ensure_workspace_files(workspace)
    ensure_workspace_ignored(repo, workspace)
    ensure_reset_config_files_ignored(repo, config.reset_config_files)
    ensure_config_backups(repo, workspace, config.reset_config_files)

    if args.dry_run:
        experiment = next_experiment_name(repo, config.project_name)
        branch = f"{config.branch_prefix}/{experiment}"
        prompt = build_worker_prompt(workspace, experiment, branch, config)
        command = build_copilot_command(repo, config, experiment, prompt)
        print(" ".join(redact_command(command)))
        return 0

    state_path = workspace / "run-state.json"
    state = load_state(state_path)
    failures = int(state.get("consecutive_failures", 0))
    iteration = 0

    while args.max_iterations is None or iteration < args.max_iterations:
        if failures >= config.max_consecutive_failures:
            print(f"Stopping after {failures} consecutive failed/incomplete attempts.")
            return 2

        ensure_clean_versioned_worktree(repo)
        git(["checkout", config.base_branch], cwd=repo)
        restore_config_files(repo, workspace, config.reset_config_files)
        ensure_clean_versioned_worktree(repo)

        experiment = next_experiment_name(repo, config.project_name)
        branch = f"{config.branch_prefix}/{experiment}"
        experiment_dir = workspace / experiment
        artifacts_dir = experiment_dir / "artifacts"
        artifacts_dir.mkdir(parents=True, exist_ok=True)

        git(["checkout", "-b", branch], cwd=repo)

        prompt = build_worker_prompt(workspace, experiment, branch, config)
        prompt_path = artifacts_dir / "worker-prompt.txt"
        prompt_path.write_text(prompt, encoding="utf-8")

        command = build_copilot_command(repo, config, experiment, prompt)
        log_path = artifacts_dir / "copilot-run.log"
        update_state(
            state_path,
            {
                "status": "running",
                "experiment": experiment,
                "branch": branch,
                "started_at": utc_now(),
                "command": redact_command(command),
                "consecutive_failures": failures,
            },
        )

        exit_code = run_worker(command, log_path, cwd=repo)
        finalize_experiment_branch(repo, workspace, experiment)
        result = latest_result_label(workspace / "RESULTS.md", experiment)

        if exit_code == 0 and result == "goal-met":
            update_state(
                state_path,
                {
                    "status": "goal-met",
                    "experiment": experiment,
                    "branch": branch,
                    "completed_at": utc_now(),
                    "consecutive_failures": 0,
                },
            )
            print(f"Goal met by {experiment}. See {workspace / 'RESULTS.md'}.")
            return 0

        if exit_code == 0 and result in ("success", "neutral", "regression", "inconclusive"):
            failures = 0 if result != "inconclusive" else failures + 1
            update_state(
                state_path,
                {
                    "status": result,
                    "experiment": experiment,
                    "branch": branch,
                    "completed_at": utc_now(),
                    "consecutive_failures": failures,
                },
            )
        else:
            failures += 1
            mark_incomplete(workspace / "RESULTS.md", experiment, branch, exit_code)
            update_state(
                state_path,
                {
                    "status": "incomplete",
                    "experiment": experiment,
                    "branch": branch,
                    "completed_at": utc_now(),
                    "exit_code": exit_code,
                    "consecutive_failures": failures,
                },
            )

        ensure_clean_versioned_worktree(repo)
        git(["checkout", config.base_branch], cwd=repo, check=False)
        iteration += 1

    return 0


def load_config(path: Path, args: argparse.Namespace) -> Config:
    if not path.exists():
        raise SystemExit(f"Missing config: {path}")
    raw = json.loads(path.read_text(encoding="utf-8"))
    catalog = raw.get("experiment_catalog") or {}
    project_name = args.project_name or raw.get("project_name")
    catalog_project = catalog.get("project_name") or project_name
    required = {
        "base_branch": args.base_branch or raw.get("base_branch"),
        "branch_prefix": raw.get("branch_prefix", "experiment"),
        "project_name": project_name,
        "copilot_command": raw.get("copilot_command", "copilot"),
        "catalog_uri": catalog.get("uri"),
        "catalog_project_name": catalog_project,
    }
    missing = [key for key, value in required.items() if not value]
    if missing:
        raise SystemExit(f"Missing required loop.config.json values: {', '.join(missing)}")
    reset_config_files = normalize_reset_config_files(raw.get("reset_config_files", []))
    return Config(
        base_branch=required["base_branch"],
        branch_prefix=required["branch_prefix"],
        project_name=required["project_name"],
        copilot_command=required["copilot_command"],
        catalog_uri=required["catalog_uri"],
        catalog_project_name=required["catalog_project_name"],
        max_consecutive_failures=int(raw.get("max_consecutive_failures", 3)),
        reset_config_files=reset_config_files,
    )


def ensure_workspace_files(workspace: Path) -> None:
    required = ["GOAL.md", "BACKLOG.md", "RESULTS.md", "loop.config.json"]
    missing = [name for name in required if not (workspace / name).exists()]
    if missing:
        raise SystemExit(f"Missing workspace file(s): {', '.join(missing)}")
    (workspace / "logs").mkdir(exist_ok=True)


def ensure_workspace_ignored(repo: Path, workspace: Path) -> None:
    rel = os.path.relpath(workspace, repo)
    result = subprocess.run(["git", "check-ignore", "-q", rel], cwd=repo)
    if result.returncode != 0:
        raise SystemExit(f"Experiment workspace must be gitignored: {rel}")


def normalize_reset_config_files(raw: Any) -> list[str]:
    if raw is None:
        return []
    if not isinstance(raw, list) or not all(isinstance(item, str) for item in raw):
        raise SystemExit("loop.config.json reset_config_files must be a list of repo-relative file paths.")
    normalized: list[str] = []
    for item in raw:
        value = item.strip()
        path = Path(value)
        if not value or path.is_absolute() or ".." in path.parts or value in (".", "./"):
            raise SystemExit(f"Invalid reset_config_files entry: {item!r}")
        normalized.append(path.as_posix())
    return normalized


def ensure_reset_config_files_ignored(repo: Path, reset_config_files: list[str]) -> None:
    for rel_path in reset_config_files:
        result = subprocess.run(["git", "check-ignore", "-q", "--", rel_path], cwd=repo)
        if result.returncode != 0:
            raise SystemExit(f"reset_config_files entry must be gitignored and untracked: {rel_path}")


def ensure_config_backups(repo: Path, workspace: Path, reset_config_files: list[str]) -> None:
    backup_root = workspace / "_config-backups"
    for rel_path in reset_config_files:
        source = repo / rel_path
        backup = backup_root / rel_path
        if backup.exists():
            continue
        if not source.is_file():
            raise SystemExit(f"Cannot create config backup because file does not exist: {rel_path}")
        backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, backup)


def restore_config_files(repo: Path, workspace: Path, reset_config_files: list[str]) -> None:
    backup_root = workspace / "_config-backups"
    for rel_path in reset_config_files:
        backup = backup_root / rel_path
        target = repo / rel_path
        if not backup.is_file():
            raise SystemExit(f"Missing config backup for {rel_path}: {backup}")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(backup, target)


def ensure_clean_versioned_worktree(repo: Path) -> None:
    status = git_output(["status", "--porcelain", "--untracked-files=all"], cwd=repo)
    if status.strip():
        raise SystemExit("Versioned working tree changes exist. Commit, stash, or discard them before continuing.")


def finalize_experiment_branch(repo: Path, workspace: Path, experiment: str) -> None:
    tracked_workspace = tracked_workspace_files(repo, workspace)
    if tracked_workspace:
        preview = ", ".join(tracked_workspace[:5])
        suffix = "" if len(tracked_workspace) <= 5 else f", and {len(tracked_workspace) - 5} more"
        raise SystemExit(f"Experiment workspace files must not be tracked or committed: {preview}{suffix}")

    status = git_output(["status", "--porcelain", "--untracked-files=all"], cwd=repo)
    if not status.strip():
        return

    git(["add", "--all", "--", "."], cwd=repo)
    tracked_workspace = tracked_workspace_files(repo, workspace)
    if tracked_workspace:
        preview = ", ".join(tracked_workspace[:5])
        suffix = "" if len(tracked_workspace) <= 5 else f", and {len(tracked_workspace) - 5} more"
        raise SystemExit(f"Experiment workspace files must not be staged or committed: {preview}{suffix}")

    diff = subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=repo)
    if diff.returncode == 0:
        return
    git(
        [
            "commit",
            "-m",
            f"chore(experiment): finalize {experiment}",
            "-m",
            "Record all non-ignored experiment changes before returning to the base branch.",
        ],
        cwd=repo,
    )


def tracked_workspace_files(repo: Path, workspace: Path) -> list[str]:
    rel = os.path.relpath(workspace, repo)
    output = git_output(["ls-files", "--", rel], cwd=repo)
    return [line for line in output.splitlines() if line.strip()]


def next_experiment_name(repo: Path, project_name: str) -> str:
    slug = slugify(project_name)
    today = datetime.now().strftime("%Y%m%d")
    branches = git_output(["branch", "--list", f"*{slug}-exp-{today}-*"], cwd=repo)
    used = set(int(match.group(1)) for match in re.finditer(rf"{re.escape(slug)}-exp-{today}-(\d+)", branches))
    index = 1
    while index in used:
        index += 1
    return f"{slug}-exp-{today}-{index:02d}"


def build_worker_prompt(workspace: Path, experiment: str, branch: str, config: Config) -> str:
    return f"""Follow {workspace / 'GOAL.md'}. Complete exactly one experiment iteration.

Experiment name: {experiment}
Current branch: {branch}
Experiment Catalog URI: {config.catalog_uri}
Experiment Catalog project: {config.catalog_project_name}

Start by selecting the highest-ranked pending idea from {workspace / 'BACKLOG.md'}.
Create/update the Experiment Catalog experiment, implement and evaluate the
permutation(s), update the experiment README, append {workspace / 'RESULTS.md'},
update {workspace / 'BACKLOG.md'} with learning, commit tracked code changes on
the current branch, then return to the configured base branch if possible.

Commit every non-ignored code/configuration change needed to reproduce the
experiment. Do not commit {workspace}, any files under it, or any gitignored
file. Do not use git add -f. Before exiting, run git status --porcelain
--untracked-files=all and leave no non-ignored tracked or untracked changes
behind; the supervisor will make a final safety commit for any non-ignored
leftovers and will fail the run if the experiment workspace was tracked.

Stop after one completed, failed, or inconclusive experiment. If the experiment
is incomplete, make that explicit in RESULTS.md. Do not push, merge, open a PR,
delete branches, or productize the result.
"""


def build_copilot_command(repo: Path, config: Config, experiment: str, prompt: str) -> list[str]:
    command = [
        *shlex.split(config.copilot_command),
        "-C",
        str(repo),
        "--name",
        experiment,
        "-p",
        prompt,
        "--allow-all-tools",
        "--add-dir",
        str(repo),
    ]
    host = urlparse(config.catalog_uri).netloc or config.catalog_uri
    if host:
        command.extend(["--allow-url", host])
    return command


def run_worker(command: list[str], log_path: Path, cwd: Path) -> int:
    with log_path.open("w", encoding="utf-8") as log:
        process = subprocess.Popen(command, cwd=cwd, stdout=log, stderr=subprocess.STDOUT, text=True)
        return process.wait()


def latest_result_label(results_path: Path, experiment: str) -> str | None:
    if not results_path.exists():
        return None
    lines = results_path.read_text(encoding="utf-8").splitlines()
    for line in reversed(lines):
        if experiment in line:
            for label in RESULT_LABELS:
                if label in line:
                    return label
    return None


def mark_incomplete(results_path: Path, experiment: str, branch: str, exit_code: int) -> None:
    if not results_path.exists():
        results_path.write_text("# Experiment Results\n\n", encoding="utf-8")
    with results_path.open("a", encoding="utf-8") as file:
        file.write(
            f"\n| `{experiment}` | {datetime.now().date()} | Worker exited before comparable result. "
            f"| inconclusive | `{branch}` | n/a | n/a | exit_code={exit_code}; restarted from scratch next run |\n"
        )


def load_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def update_state(path: Path, data: dict[str, Any]) -> None:
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def git(args: list[str], cwd: Path, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", *args], cwd=cwd, text=True, check=check)


def git_output(args: list[str], cwd: Path) -> str:
    return subprocess.check_output(["git", *args], cwd=cwd, text=True)


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "experiment"


def utc_now() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def redact_command(command: list[str]) -> list[str]:
    redacted: list[str] = []
    skip_next = False
    for part in command:
        if skip_next:
            redacted.append("<prompt-redacted>")
            skip_next = False
            continue
        redacted.append(part)
        if part in ("-p", "--prompt"):
            skip_next = True
    return redacted


if __name__ == "__main__":
    raise SystemExit(main())
