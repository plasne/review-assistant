---
name: automated-experimentation
description: Create and operate a local automated experimentation loop using GitHub Copilot CLI workers and Experiment Catalog. Use when setting up repeatable agent/evaluation experiments, generating GOAL/BACKLOG/RESULTS files, installing a reusable experiment-loop.py supervisor, running one-experiment-per-branch loops, or analyzing when a goal has been met.
---

# Automated Experimentation

Use this skill to create a repeatable local experimentation loop. The loop runs
on the user's machine, creates one local branch per experiment, launches a fresh
GitHub Copilot CLI worker for exactly one experiment, records results in
Experiment Catalog and `RESULTS.md`, commits the experiment branch locally, then
continues until the user-defined goal is met or the failure policy stops it.

## Core Decisions

- Experiment Catalog is required. Do not create a CSV, JSONL, SQLite, or
  local-only fallback result store.
- `RESULTS.md` is the only local results board. Do not create `results.jsonl`.
- The skill ships with a reusable `scripts/experiment-loop.py` template. Copy it
  into the experiment workspace; do not generate a bespoke loop script from
  scratch unless the user asks for a custom implementation.
- The copied script infers its workspace from its own directory, so
  `loop.config.json` does not need a `workspace` field.
- Interview the user once. Use the same answers to write `GOAL.md` and the
  small machine-readable `loop.config.json`; do not make the user maintain two
  separate sources of experiment truth.
- The script supervises process mechanics; the Copilot worker agent owns
  experiment-specific planning, implementation, evaluation, analysis, and
  documentation.
- Keep everything local by default: do not push, open PRs, merge, delete
  branches, or productize winning changes.
- If an experiment is interrupted before completion, record it as incomplete and
  start over with a new experiment name and branch.
- Each experiment must be a clean run. Do not carry non-ignored uncommitted
  changes between branches, and never commit gitignored experiment-control
  artifacts.

## Simple Operating Model

1. Interview the user and inspect the repository.
2. Create or update a gitignored experiment workspace, usually `experiments/`.
3. Create `GOAL.md`, `BACKLOG.md`, `RESULTS.md`, `loop.config.json`,
   `run-state.json`, and copy `scripts/experiment-loop.py`.
4. The user starts `python3 experiments/experiment-loop.py` in a terminal window.
5. The script creates a new experiment branch and launches `copilot -p`.
6. The worker completes one experiment, updates the catalog and local notes,
   commits tracked code changes locally, and exits.
7. The script checks `RESULTS.md` and/or Experiment Catalog. If the goal is met,
   it stops with a summary; otherwise it starts the next experiment.

## Required User Inputs

Collect these before setup. If the user does not know a value, inspect the repo
and propose a default.

| Field | Purpose |
| --- | --- |
| Project/system name | Used for branch and catalog naming. |
| Experiment workspace | Local folder for ignored experiment-control files; default `experiments/`. |
| Base branch | Branch each experiment starts from; default `main` unless repo suggests otherwise. |
| Experiment Catalog URI | API base URI, usually ending in `/api`. |
| Experiment Catalog project name | Existing or to-be-created catalog project. |
| Baseline | Catalog baseline experiment/set or project baseline rule. |
| Goal and stop condition | The final condition that ends the loop. |
| Interim success rule | How to label useful non-final wins. |
| Primary metric | Main optimization target. |
| Guardrail metrics | Metrics that must not regress beyond user-defined thresholds. |
| Inference/evaluation route | Local commands, AML Evaluation Runner modules, or another deterministic route. |
| Validation commands | Deterministic checks to run before expensive evaluation. |
| Resource constraints | Concurrency limits, flaky services, rate limits, credentials, or known hazards. |
| Resettable ignored config files | Repo-relative paths for gitignored config files, such as `.env.local`, that must be restored from backup before each experiment. Ask explicitly; use `[]` if none. |

## Where Interview Answers Go

Use one interview to populate both files:

| Answer | Write to |
| --- | --- |
| Project/system name | `GOAL.md`, `loop.config.json.project_name`, and catalog project naming if applicable. |
| Experiment workspace | Filesystem path only; do not put it in `loop.config.json` because the script infers it. |
| Base branch | `GOAL.md` and `loop.config.json.base_branch`. |
| Branch naming preference | `GOAL.md` and `loop.config.json.branch_prefix`; default `experiment`. |
| Copilot command/path | `loop.config.json.copilot_command`; mention only in `GOAL.md` if workers need to know it. |
| Experiment Catalog URI/project | `GOAL.md` and `loop.config.json.experiment_catalog`. |
| Resettable ignored config files | `GOAL.md` with purpose/context and `loop.config.json.reset_config_files` with exact repo-relative paths. |
| Baseline, metrics, stop rules, validation, evaluation, upload, comparison, constraints, and hazards | `GOAL.md` only. |

## Setup Procedure

1. Confirm Experiment Catalog is reachable and the target project exists or can
   be created. If not, use `experiment-catalog-operator` or
   `experiment-catalog-install` as appropriate before continuing.
2. Confirm the evaluation route can publish or upload results to Experiment
   Catalog. If using AML Evaluation Runner, invoke `aml-eval-runner-operator` for
   runner-specific configuration.
3. Create the workspace directory if needed.
4. Add or confirm a `.gitignore` entry for the workspace. The workspace must
   persist across branch switches and must not be committed by default.
5. Ask for repo-relative paths of any gitignored config files that must reset
   before every experiment. Record them in `loop.config.json` as
   `reset_config_files`; use an empty array when there are none.
6. Copy those config files into `<workspace>/_config-backups/`, preserving their
   repo-relative paths. Do not commit the backup folder.
7. Copy this skill's `scripts/experiment-loop.py` into the workspace.
8. Create `loop.config.json` beside the copied script.
9. Create `run-state.json` as `{}` if it does not exist.
10. Create or update `GOAL.md`, `BACKLOG.md`, and `RESULTS.md`.
11. Report the exact command to start the loop.

## Minimal `loop.config.json`

Keep this config small. It exists only for values the Python supervisor must read
deterministically before a worker starts. `GOAL.md` is the authoritative
experiment brief and should include the same human-readable details plus all
evaluation commands, metric definitions, stop criteria, and catalog procedures.
Do not duplicate full experiment design in JSON, and do not parse `GOAL.md` from
the supervisor.

```json
{
  "base_branch": "main",
  "branch_prefix": "experiment",
  "project_name": "review-assistant",
  "copilot_command": "copilot",
  "experiment_catalog": {
    "uri": "https://example.invalid/api",
    "project_name": "review-assistant"
  },
  "reset_config_files": [],
  "max_consecutive_failures": 3
}
```

`copilot_command` defaults to `copilot`. Keep it configurable so users can point
to a full path or wrapper command if needed. `reset_config_files` belongs here
because the supervisor must restore those files before it creates the experiment
branch and before the worker can read `GOAL.md`; also describe the files and why
they are reset in `GOAL.md` for the worker's context. Paths must be
repo-relative, gitignored, and untracked.

## Workspace Files

### `GOAL.md`

Write a project-specific instruction file that a fresh worker can follow without
prior conversation context. Include:

- goal and motivation;
- commit/workspace policy;
- Experiment Catalog URI, project, baseline, and naming rules;
- primary metric, guardrail metrics, interim success, and final stop condition;
- exact validation, inference, evaluation, upload, annotation, and comparison
  commands or AML Evaluation Runner modules;
- resource constraints and known hazards;
- resettable ignored config files and what each one controls, matching
  `loop.config.json`;
- one-experiment procedure;
- continuous learning requirements.

Critical rules to include:

```md
Files under `experiments/` are gitignored local experiment-control artifacts.
Do not commit them, do not force-add them, and do not commit any other
gitignored file. Commit every non-ignored code/configuration change locally on
each experiment branch so the exact implementation that was run is auditable.
Before returning to the base branch, `git status --porcelain
--untracked-files=all` must show no non-ignored tracked or untracked changes.
Do not push, merge, open a PR, delete branches, or productize results unless
the user explicitly asks later.
```

```md
Every experiment must use the same ground truth, baseline, metric definitions,
and guardrail thresholds unless this file explicitly says the baseline changed.
Do not compare runs that used materially different evaluation inputs as if they
were equivalent.
```

### `BACKLOG.md`

Create a ranked backlog with:

- a short ranked candidate list;
- completed experiment list;
- code surface inventory;
- detailed candidate entries.

Each candidate should include hypothesis, change, expected impact, quality risk,
metrics to watch, suggested set names, evidence, rollback plan, and status.

When an experiment completes, update the candidate with the result, evaluated set
name, speed/quality summary, observed failure modes, and whether the idea should
be retried, combined, narrowed, or abandoned.

### `RESULTS.md`

Create an at-a-glance board. Do not create `results.jsonl`.

Recommended header:

```md
# Experiment Results

At-a-glance progress board for <project/system> experiments.

Baseline:

- Source: <catalog project/experiment/set or project baseline>
- Ground truth: <name/path/version>
- Primary metric: `<metric>` = <value>
- Guardrail metrics:
  - `<metric>` = <value>
  - `<metric>` = <value>
- Interim success: <definition>
- Goal met: <definition>
```

Recommended table:

```md
| Experiment | Date | Hypothesis | Result | Best/decisive set | Primary metric delta | Worst guardrail delta | Key learning |
| --- | --- | --- | --- | --- | --- | --- | --- |
```

Allowed result labels:

- `goal-met`
- `success`
- `neutral`
- `regression`
- `inconclusive`

Treat fast-but-low-quality runs as regressions. A speed win is not a success if
quality guardrails fail.

## Loop Script Behavior

The copied script should:

- infer workspace from its own directory;
- read `loop.config.json`;
- verify the workspace is gitignored;
- verify non-ignored working tree state is clean before creating the next branch;
- check out the base branch;
- restore every `reset_config_files` path from `<workspace>/_config-backups/`
  before creating the experiment branch;
- create a fresh experiment branch named
  `<branch_prefix>/<project-slug>-exp-YYYYMMDD-NN`;
- create `experiments/<experiment-name>/artifacts/worker-prompt.txt`;
- launch `copilot -p` in non-interactive mode;
- log stdout/stderr to `experiments/<experiment-name>/artifacts/copilot-run.log`;
- make a final safety commit for any remaining non-ignored changes on the
  experiment branch before returning to the base branch;
- fail rather than continue if any file under the gitignored experiment
  workspace becomes tracked or staged;
- parse `RESULTS.md` or consult Experiment Catalog to detect `goal-met`;
- mark interrupted attempts incomplete and continue from a new branch/name;
- stop after `max_consecutive_failures`.

Start it from a terminal:

```bash
python3 experiments/experiment-loop.py
```

Optional one-iteration smoke:

```bash
python3 experiments/experiment-loop.py --max-iterations 1 --dry-run
```

## Worker Prompt Requirements

The worker prompt generated by the script should say:

```text
Follow experiments/GOAL.md. Complete exactly one experiment iteration.

Start by selecting the highest-ranked pending idea from experiments/BACKLOG.md.
Create/update the Experiment Catalog experiment, implement and evaluate the
permutation(s), update the experiment README, append experiments/RESULTS.md,
update experiments/BACKLOG.md with learning, commit tracked code changes on the
current branch, then return to the configured base branch if possible.

Commit every non-ignored code/configuration change needed to reproduce the
experiment. Do not commit experiments/, any files under it, or any gitignored
file. Do not use git add -f. Before exiting, run git status --porcelain
--untracked-files=all and leave no non-ignored tracked or untracked changes
behind.

Stop after one completed, failed, or inconclusive experiment. Do not push, merge,
open a PR, delete branches, or productize the result.
```

## Validation Before Handoff

After creating the skill workspace in a repository:

1. Confirm `experiments/` is gitignored.
2. Confirm `loop.config.json` has catalog URI and project name.
3. Confirm `reset_config_files` is present in `loop.config.json`; if non-empty,
   confirm each path is gitignored and has a backup under
   `experiments/_config-backups/`.
4. Confirm `GOAL.md` contains concrete evaluation commands or AML runner module
   references.
5. Run:

```bash
python3 experiments/experiment-loop.py --max-iterations 1 --dry-run
```

6. Confirm the dry run prints a `copilot -p` command and does not start a real
   experiment.

## Handoff

Summarize:

- workspace path;
- files created or updated;
- catalog URI/project;
- baseline and stop condition;
- first recommended backlog candidate;
- command to start the loop.

Do not start a multi-day loop unless the user explicitly asks.
