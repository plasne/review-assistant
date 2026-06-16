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

    def test_config_backups_restore_ignored_files(self) -> None:
        config_path = self.repo / ".env.local"
        config_path.write_text("TOKEN=base\n", encoding="utf-8")

        experiment_loop.ensure_reset_config_files_ignored(self.repo, [".env.local"])
        experiment_loop.ensure_config_backups(self.repo, self.workspace, [".env.local"])
        config_path.write_text("TOKEN=mutated\n", encoding="utf-8")
        experiment_loop.restore_config_files(self.repo, self.workspace, [".env.local"])

        self.assertEqual(config_path.read_text(encoding="utf-8"), "TOKEN=base\n")
        backup = self.workspace / "_config-backups" / ".env.local"
        self.assertEqual(backup.read_text(encoding="utf-8"), "TOKEN=base\n")

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


if __name__ == "__main__":
    unittest.main()
