import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "experiment-loop.py"
SPEC = importlib.util.spec_from_file_location("experiment_loop", SCRIPT_PATH)
experiment_loop = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = experiment_loop
SPEC.loader.exec_module(experiment_loop)


class ExperimentLoopTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.repo = Path(self.temp_dir.name)
        self.workspace = self.repo / "experiments"
        self.workspace.mkdir()
        self.git(["init"])
        self.git(["checkout", "-b", "main"])
        self.git(["config", "user.email", "experiment@example.invalid"])
        self.git(["config", "user.name", "Experiment Loop Test"])
        (self.repo / ".gitignore").write_text("experiments/\n.env.local\n", encoding="utf-8")
        (self.repo / "src").mkdir()
        (self.repo / "src" / "app.txt").write_text("base\n", encoding="utf-8")
        self.git(["add", ".gitignore", "src/app.txt"])
        self.git(["commit", "-m", "initial"])

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def git(self, args: list[str]) -> str:
        result = subprocess.run(
            ["git", *args],
            cwd=self.repo,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        return result.stdout

    def test_config_backups_restore_resettable_files(self) -> None:
        config_path = self.repo / ".env.local"
        config_path.write_text("TOKEN=base\n", encoding="utf-8")

        experiment_loop.ensure_reset_config_files_resettable(self.repo, [".env.local"])
        experiment_loop.ensure_config_backups(self.repo, self.workspace, [".env.local"])
        config_path.write_text("TOKEN=mutated\n", encoding="utf-8")
        experiment_loop.ensure_tracked_config_backups_match_targets(self.repo, self.workspace, [".env.local"])
        experiment_loop.restore_config_files(self.repo, self.workspace, [".env.local"])

        self.assertEqual(config_path.read_text(encoding="utf-8"), "TOKEN=base\n")
        backup = self.workspace / "_config-backups" / ".env.local"
        self.assertEqual(backup.read_text(encoding="utf-8"), "TOKEN=base\n")

        tracked_config = self.repo / "tracked.env"
        tracked_config.write_text("TOKEN=tracked\n", encoding="utf-8")
        self.git(["add", "tracked.env"])
        self.git(["commit", "-m", "track config"])

        experiment_loop.ensure_reset_config_files_resettable(self.repo, ["tracked.env"])

    def test_tracked_config_backup_must_match_before_restore(self) -> None:
        tracked_config = self.repo / "tracked.env"
        tracked_config.write_text("TOKEN=base\n", encoding="utf-8")
        self.git(["add", "tracked.env"])
        self.git(["commit", "-m", "track config"])
        experiment_loop.ensure_config_backups(self.repo, self.workspace, ["tracked.env"])
        backup = self.workspace / "_config-backups" / "tracked.env"
        backup.write_text("TOKEN=stale\n", encoding="utf-8")

        with self.assertRaises(SystemExit):
            experiment_loop.ensure_tracked_config_backups_match_targets(self.repo, self.workspace, ["tracked.env"])

        self.assertEqual(tracked_config.read_text(encoding="utf-8"), "TOKEN=base\n")
        self.assertEqual(self.git(["status", "--porcelain", "--untracked-files=all"]), "")

    def test_matching_tracked_config_backup_can_restore(self) -> None:
        tracked_config = self.repo / "tracked.env"
        tracked_config.write_text("TOKEN=base\n", encoding="utf-8")
        self.git(["add", "tracked.env"])
        self.git(["commit", "-m", "track config"])
        experiment_loop.ensure_config_backups(self.repo, self.workspace, ["tracked.env"])

        experiment_loop.ensure_tracked_config_backups_match_targets(self.repo, self.workspace, ["tracked.env"])
        experiment_loop.restore_config_files(self.repo, self.workspace, ["tracked.env"])

        self.assertEqual(self.git(["status", "--porcelain", "--untracked-files=all"]), "")

    def test_finalize_commits_non_ignored_leftovers_without_workspace_files(self) -> None:
        self.git(["checkout", "-b", "experiment/sample"])
        (self.repo / "src" / "app.txt").write_text("changed\n", encoding="utf-8")
        (self.repo / "generated.txt").write_text("new\n", encoding="utf-8")
        (self.workspace / "worker.log").write_text("ignored\n", encoding="utf-8")

        experiment_loop.finalize_experiment_branch(self.repo, self.workspace, "sample-exp")

        status = self.git(["status", "--porcelain", "--untracked-files=all"])
        self.assertEqual(status, "")
        self.assertIn("generated.txt", self.git(["ls-files", "generated.txt"]))
        self.assertEqual(self.git(["ls-files", "experiments"]), "")
        log = self.git(["log", "-1", "--pretty=%s"])
        self.assertEqual(log.strip(), "chore(experiment): finalize sample-exp")

    def test_finalize_rejects_tracked_workspace_files(self) -> None:
        self.git(["checkout", "-b", "experiment/bad"])
        tracked = self.workspace / "bad.txt"
        tracked.write_text("must not track\n", encoding="utf-8")
        self.git(["add", "-f", "experiments/bad.txt"])

        with self.assertRaises(SystemExit):
            experiment_loop.finalize_experiment_branch(self.repo, self.workspace, "bad-exp")

    def test_worker_prompt_delegates_experiment_details_to_backlog(self) -> None:
        config = experiment_loop.Config(
            base_branch="main",
            branch_prefix="experiment",
            project_name="Review Assistant",
            copilot_command="copilot",
            catalog_uri="https://catalog.example.invalid/api",
            catalog_project_name="Review Assistant",
            max_consecutive_failures=3,
            max_attempts_per_experiment=2,
            reset_config_files=[],
        )

        prompt = experiment_loop.build_worker_prompt(self.workspace, "review-exp", "experiment/review-exp", config)
        normalized_prompt = " ".join(prompt.split())

        self.assertIn("Follow", normalized_prompt)
        self.assertIn("GOAL.md", normalized_prompt)
        self.assertIn("BACKLOG.md as the only source", normalized_prompt)
        self.assertIn("hypothesis, parameters, set names, code/config changes, verification steps, and rollback plan", normalized_prompt)
        self.assertIn("Update", normalized_prompt)
        self.assertNotIn("single-variable hypothesis test", normalized_prompt)

    def test_inconclusive_experiment_retries_same_name_with_attempt_branch(self) -> None:
        config = experiment_loop.Config(
            base_branch="main",
            branch_prefix="experiment",
            project_name="review-assistant",
            copilot_command="copilot",
            catalog_uri="https://catalog.example.invalid/api",
            catalog_project_name="review-assistant",
            max_consecutive_failures=3,
            max_attempts_per_experiment=2,
            reset_config_files=[],
        )
        state = {"status": "inconclusive", "experiment": "review-assistant-exp-20260618-03", "attempt": 1}

        experiment, attempt = experiment_loop.next_experiment_attempt(self.repo, config, state)

        self.assertEqual(experiment, "review-assistant-exp-20260618-03")
        self.assertEqual(attempt, 2)
        self.assertEqual(
            experiment_loop.experiment_branch(config, experiment, attempt),
            "experiment/review-assistant-exp-20260618-03-attempt-2",
        )

    def test_inconclusive_experiment_advances_after_attempt_limit(self) -> None:
        config = experiment_loop.Config(
            base_branch="main",
            branch_prefix="experiment",
            project_name="review-assistant",
            copilot_command="copilot",
            catalog_uri="https://catalog.example.invalid/api",
            catalog_project_name="review-assistant",
            max_consecutive_failures=3,
            max_attempts_per_experiment=2,
            reset_config_files=[],
        )
        self.git(["checkout", "-b", "experiment/review-assistant-exp-20260618-03"])
        self.git(["checkout", "main"])
        state = {"status": "inconclusive", "experiment": "review-assistant-exp-20260618-03", "attempt": 2}

        experiment, attempt = experiment_loop.next_experiment_attempt(self.repo, config, state)

        self.assertNotEqual(experiment, "review-assistant-exp-20260618-03")
        self.assertRegex(experiment, r"review-assistant-exp-\d{8}-\d{2}")
        self.assertEqual(attempt, 1)

    def test_failure_limit_abandons_experiment_without_stopping_supervisor(self) -> None:
        config = experiment_loop.Config(
            base_branch="main",
            branch_prefix="experiment",
            project_name="review-assistant",
            copilot_command="copilot",
            catalog_uri="https://catalog.example.invalid/api",
            catalog_project_name="review-assistant",
            max_consecutive_failures=3,
            max_attempts_per_experiment=5,
            reset_config_files=[],
        )
        state = {
            "status": "inconclusive",
            "experiment": "review-assistant-exp-20260618-03",
            "attempt": 1,
            "consecutive_failures": 3,
        }

        self.assertTrue(experiment_loop.should_abandon_experiment(state, config))
        self.assertFalse(experiment_loop.should_retry_experiment(state, config))

        experiment, attempt = experiment_loop.next_experiment_attempt(self.repo, config, state)

        self.assertNotEqual(experiment, "review-assistant-exp-20260618-03")
        self.assertRegex(experiment, r"review-assistant-exp-\d{8}-\d{2}")
        self.assertEqual(attempt, 1)

    def test_max_attempts_defaults_to_consecutive_failure_limit(self) -> None:
        config_path = self.workspace / "loop.config.json"
        config_path.write_text(
            """{
  "base_branch": "main",
  "branch_prefix": "experiment",
  "project_name": "review-assistant",
  "copilot_command": "copilot",
  "experiment_catalog": {
    "uri": "https://catalog.example.invalid/api",
    "project_name": "review-assistant"
  },
  "reset_config_files": [],
  "max_consecutive_failures": 4
}
""",
            encoding="utf-8",
        )
        args = type("Args", (), {"base_branch": None, "project_name": None})()

        config = experiment_loop.load_config(config_path, args)

        self.assertEqual(config.max_consecutive_failures, 4)
        self.assertEqual(config.max_attempts_per_experiment, 4)


if __name__ == "__main__":
    unittest.main()
