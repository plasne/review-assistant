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
from datetime import datetime, timezone
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
    max_attempts_per_experiment: int
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
    supervisor_log_path = workspace / "logs" / "experiment-loop.log"

    log(supervisor_log_path, "Starting experiment loop supervisor.")
    log(supervisor_log_path, f"Workspace: {workspace}")
    log(supervisor_log_path, f"Repository: {repo}")
    ensure_workspace_files(workspace)
    log(supervisor_log_path, "Verified required workspace files.")
    ensure_workspace_ignored(repo, workspace)
    log(supervisor_log_path, "Verified workspace is gitignored.")
    ensure_reset_config_files_resettable(repo, config.reset_config_files)
    log(supervisor_log_path, "Verified resettable config files.")
    ensure_config_backups(repo, workspace, config.reset_config_files)
    log(supervisor_log_path, "Verified config backups.")

    if args.dry_run:
        experiment, attempt = next_experiment_attempt(repo, config, {})
        branch = experiment_branch(config, experiment, attempt)
        prompt = build_worker_prompt(workspace, experiment, branch, config, attempt=attempt)
        command = build_copilot_command(repo, config, experiment, prompt)
        print(" ".join(redact_command(command)))
        return 0

    state_path = workspace / "run-state.json"
    state = load_state(state_path)
    failures = int(state.get("consecutive_failures", 0))
    iteration = 0

    while args.max_iterations is None or iteration < args.max_iterations:
        if failures >= config.max_consecutive_failures:
            log(supervisor_log_path, f"Stopping after {failures} consecutive failed/incomplete attempts.")
            return 2

        log(supervisor_log_path, "Checking for a clean worktree before starting next iteration.")
        ensure_clean_versioned_worktree(repo)
        log(supervisor_log_path, f"Checking out base branch {config.base_branch}.")
        git(["checkout", config.base_branch], cwd=repo)
        log(supervisor_log_path, "Checking for a clean worktree before config restore.")
        ensure_clean_versioned_worktree(repo)
        log(supervisor_log_path, "Verifying tracked resettable config backups.")
        ensure_tracked_config_backups_match_targets(repo, workspace, config.reset_config_files)
        log(supervisor_log_path, "Restoring resettable config files.")
        restore_config_files(repo, workspace, config.reset_config_files)
        log(supervisor_log_path, "Checking for a clean worktree after config restore.")
        ensure_clean_versioned_worktree(repo)

        experiment, attempt = next_experiment_attempt(repo, config, state)
        branch = experiment_branch(config, experiment, attempt)
        experiment_dir = workspace / experiment
        if attempt > 1:
            experiment_dir = experiment_dir / f"attempt-{attempt}"
        artifacts_dir = experiment_dir / "artifacts"
        artifacts_dir.mkdir(parents=True, exist_ok=True)
        log(supervisor_log_path, f"Prepared artifact directory: {artifacts_dir}")

        log(supervisor_log_path, f"Creating experiment branch {branch}.")
        git(["checkout", "-b", branch], cwd=repo)

        prompt = build_worker_prompt(workspace, experiment, branch, config, attempt=attempt)
        prompt_path = artifacts_dir / "worker-prompt.txt"
        prompt_path.write_text(prompt, encoding="utf-8")
        log(supervisor_log_path, f"Wrote worker prompt: {prompt_path}")

        command = build_copilot_command(repo, config, experiment, prompt)
        log_path = artifacts_dir / "copilot-run.log"
        log(supervisor_log_path, f"Worker log: {log_path}")
        log(supervisor_log_path, f"Launching worker: {' '.join(redact_command(command))}")
        update_state(
            state_path,
            {
                "status": "running",
                "experiment": experiment,
                "branch": branch,
                "attempt": attempt,
                "max_attempts_per_experiment": config.max_attempts_per_experiment,
                "started_at": utc_now(),
                "command": redact_command(command),
                "consecutive_failures": failures,
            },
        )

        exit_code = run_worker(command, log_path, cwd=repo, supervisor_log_path=supervisor_log_path)
        log(supervisor_log_path, f"Worker exited with code {exit_code}.")
        log(supervisor_log_path, "Finalizing experiment branch.")
        finalize_experiment_branch(repo, workspace, experiment)
        result = latest_result_label(workspace / "RESULTS.md", experiment)
        log(supervisor_log_path, f"Latest result label for {experiment}: {result or '(missing)'}")

        if exit_code == 0 and result == "goal-met":
            update_state(
                state_path,
                {
                    "status": "goal-met",
                    "experiment": experiment,
                    "branch": branch,
                    "attempt": attempt,
                    "completed_at": utc_now(),
                    "consecutive_failures": 0,
                },
            )
            log(supervisor_log_path, f"Goal met by {experiment}. See {workspace / 'RESULTS.md'}.")
            return 0

        if exit_code == 0 and result in ("success", "neutral", "regression", "inconclusive"):
            failures = 0 if result != "inconclusive" else failures + 1
            update_state(
                state_path,
                {
                    "status": result,
                    "experiment": experiment,
                    "branch": branch,
                    "attempt": attempt,
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
                    "attempt": attempt,
                    "completed_at": utc_now(),
                    "exit_code": exit_code,
                    "consecutive_failures": failures,
                },
            )

        ensure_clean_versioned_worktree(repo)
        log(supervisor_log_path, f"Returning to base branch {config.base_branch}.")
        git(["checkout", config.base_branch], cwd=repo, check=False)
        log(supervisor_log_path, f"Completed iteration {iteration + 1}.")
        iteration += 1

    log(supervisor_log_path, "Reached max iterations for this invocation.")
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
    max_attempts_per_experiment = int(raw.get("max_attempts_per_experiment", 2))
    if max_attempts_per_experiment < 1:
        raise SystemExit("loop.config.json max_attempts_per_experiment must be at least 1.")
    return Config(
        base_branch=required["base_branch"],
        branch_prefix=required["branch_prefix"],
        project_name=required["project_name"],
        copilot_command=required["copilot_command"],
        catalog_uri=required["catalog_uri"],
        catalog_project_name=required["catalog_project_name"],
        max_consecutive_failures=int(raw.get("max_consecutive_failures", 3)),
        max_attempts_per_experiment=max_attempts_per_experiment,
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


def ensure_reset_config_files_resettable(repo: Path, reset_config_files: list[str]) -> None:
    for rel_path in reset_config_files:
        tracked = subprocess.run(["git", "ls-files", "--error-unmatch", "--", rel_path], cwd=repo, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        ignored = subprocess.run(["git", "check-ignore", "-q", "--", rel_path], cwd=repo)
        if tracked.returncode != 0 and ignored.returncode != 0:
            raise SystemExit(f"reset_config_files entry must be tracked or gitignored: {rel_path}")


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


def ensure_tracked_config_backups_match_targets(repo: Path, workspace: Path, reset_config_files: list[str]) -> None:
    backup_root = workspace / "_config-backups"
    for rel_path in reset_config_files:
        if not is_tracked_file(repo, rel_path):
            continue
        backup = backup_root / rel_path
        target = repo / rel_path
        if not backup.is_file():
            raise SystemExit(f"Missing config backup for {rel_path}: {backup}")
        if not target.is_file():
            raise SystemExit(f"Tracked resettable config file does not exist on the checked-out base branch: {rel_path}")
        if backup.read_bytes() != target.read_bytes():
            raise SystemExit(
                "Tracked resettable config backup differs from the checked-out base branch file. "
                f"Update or remove the backup before continuing: {rel_path}"
            )


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


def is_tracked_file(repo: Path, rel_path: str) -> bool:
    result = subprocess.run(["git", "ls-files", "--error-unmatch", "--", rel_path], cwd=repo, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return result.returncode == 0


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


def next_experiment_attempt(repo: Path, config: Config, state: dict[str, Any]) -> tuple[str, int]:
    if should_retry_experiment(state, config):
        return str(state["experiment"]), int(state.get("attempt", 1)) + 1
    return next_experiment_name(repo, config.project_name), 1


def should_retry_experiment(state: dict[str, Any], config: Config) -> bool:
    status = state.get("status")
    experiment = state.get("experiment")
    attempt = int(state.get("attempt", 1))
    return (
        status in {"incomplete", "inconclusive"}
        and isinstance(experiment, str)
        and bool(experiment.strip())
        and attempt < config.max_attempts_per_experiment
    )


def experiment_branch(config: Config, experiment: str, attempt: int) -> str:
    suffix = "" if attempt == 1 else f"-attempt-{attempt}"
    return f"{config.branch_prefix}/{experiment}{suffix}"


def build_worker_prompt(workspace: Path, experiment: str, branch: str, config: Config, *, attempt: int = 1) -> str:
    return f"""Follow {workspace / 'GOAL.md'}. Complete exactly one experiment iteration.

Experiment name: {experiment}
Current branch: {branch}
Attempt: {attempt} of {config.max_attempts_per_experiment}
Experiment Catalog URI: {config.catalog_uri}
Experiment Catalog project: {config.catalog_project_name}

Start by selecting the highest-ranked pending idea from {workspace / 'BACKLOG.md'}.
Use {workspace / 'BACKLOG.md'} as the only source for the selected experiment's
hypothesis, parameters, set names, code/config changes, verification steps, and
rollback plan. Select the highest-ranked pending candidate and execute exactly
one experiment or permutation group as instructed there.

Update {workspace / 'RESULTS.md'} and {workspace / 'BACKLOG.md'} with the result
and learning before exiting.
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


def run_worker(command: list[str], log_path: Path, cwd: Path, supervisor_log_path: Path) -> int:
    with log_path.open("w", encoding="utf-8") as worker_log:
        worker_log.write(f"{timestamp()} Worker command: {' '.join(redact_command(command))}\n")
        worker_log.flush()
        process = subprocess.Popen(command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        assert process.stdout is not None
        for line in process.stdout:
            print(line, end="", flush=True)
            worker_log.write(line)
            worker_log.flush()
        exit_code = process.wait()
        worker_log.write(f"{timestamp()} Worker exited with code {exit_code}.\n")
        worker_log.flush()
    log(supervisor_log_path, f"Finished streaming worker output to {log_path}.")
    return exit_code


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


def log(path: Path, message: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    line = f"{timestamp()} {message}"
    print(line, flush=True)
    with path.open("a", encoding="utf-8") as file:
        file.write(line + "\n")


def timestamp() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def git(args: list[str], cwd: Path, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", *args], cwd=cwd, text=True, check=check)


def git_output(args: list[str], cwd: Path) -> str:
    return subprocess.check_output(["git", *args], cwd=cwd, text=True)


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "experiment"


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


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
